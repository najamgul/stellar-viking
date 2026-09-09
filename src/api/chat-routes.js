/**
 * Chat routes:
 *   - WhatsApp webhook (Meta Cloud API): GET verify handshake + POST events
 *   - Public lead capture for landing pages → wa.me handoff
 *   - BD dashboard API: conversations, transcripts, takeover, callbacks, leads
 */

import config from '../config.js';
import logger from '../utils/logger.js';
import * as db from '../storage/database.js';
import * as chatStore from '../storage/chat-store.js';
import * as whatsapp from '../channels/whatsapp.js';
import { processInboundMessage, processStatusEvent } from '../engine/chat-session.js';
import { broadcast } from './admin-events.js';

export function registerChatRoutes(app) {

  // ─── WhatsApp webhook ────────────────────────────────────────────
  // Scoped plugin so we can capture the raw body for signature validation
  // without affecting JSON parsing anywhere else.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      req.rawBody = body;
      try {
        done(null, body ? JSON.parse(body) : {});
      } catch (err) {
        err.statusCode = 400;
        done(err);
      }
    });

    // Meta's one-time subscription handshake
    scope.get('/webhook/whatsapp', async (request, reply) => {
      const result = whatsapp.handleVerification(request.query);
      if (result.ok) {
        logger.info('✅ WhatsApp webhook verified by Meta');
        return reply.send(result.challenge);
      }
      return reply.code(403).send('Forbidden');
    });

    // Message + status events
    scope.post('/webhook/whatsapp', async (request, reply) => {
      if (!whatsapp.verifySignature(request.rawBody, request.headers['x-hub-signature-256'])) {
        logger.warn('WhatsApp webhook signature mismatch — rejected');
        return reply.code(401).send('Invalid signature');
      }

      const events = whatsapp.parseWebhook(request.body);

      // Ack immediately; process async (Meta retries slow responses)
      reply.send({ received: true });

      setImmediate(async () => {
        for (const event of events) {
          if (event.kind === 'message') await processInboundMessage(event);
          else if (event.kind === 'status') await processStatusEvent(event);
        }
      });
    });
  });

  // ─── Webhook relay (API-key auth) ────────────────────────────────
  // For a business whose own backend already owns the Meta webhook (it runs
  // the team inbox, push alerts, etc. — Tohund Guide's worker does). That
  // backend stores the inbound first, then relays the UNMODIFIED Meta
  // webhook body here; we run the same pipeline as /webhook/whatsapp, and
  // the AI reply goes straight back out via Graph. Events flow back to the
  // relaying backend through the CRM connector (agent.crmSyncUrl).
  //
  //   POST /api/relay/whatsapp   { payload: <Meta webhook body>, aiPaused?: boolean }
  //
  // `aiPaused` mirrors the CRM's own per-conversation bot switch (see
  // processInboundMessage). Auth is the normal /api guard (sv_live_ key).
  app.post('/api/relay/whatsapp', async (request, reply) => {
    const { payload, aiPaused } = request.body || {};
    if (!payload || payload.object !== 'whatsapp_business_account') {
      return reply.code(400).send({ error: 'payload must be a Meta WhatsApp webhook body' });
    }
    const events = whatsapp.parseWebhook(payload);
    const messages = events.filter(e => e.kind === 'message');
    const statuses = events.filter(e => e.kind === 'status');
    const numbers = [...new Set(messages.map(e => e.phoneNumberId).filter(Boolean))];
    const mapped = [];
    for (const id of numbers) if (await db.getAgentByWhatsappId(id)) mapped.push(id);

    // Ack fast, process async — the AI turn can take 10–30s and the relaying
    // backend has already answered Meta.
    reply.send({ received: true, messages: messages.length, statuses: statuses.length, mappedNumbers: mapped });
    setImmediate(async () => {
      const opts = typeof aiPaused === 'boolean' ? { aiPaused } : {};
      for (const event of events) {
        if (event.kind === 'message') await processInboundMessage(event, opts);
        else if (event.kind === 'status') await processStatusEvent(event);
      }
    });
  });

  // ─── Public lead capture (landing pages / campaign forms) ────────
  // Returns a wa.me deep link so the lead opens the chat themselves —
  // their first message opens the 24h window (opt-in compliant, no
  // business-initiated template needed).
  app.post('/api/leads/capture', async (request, reply) => {
    const { agentId, name, phone, email, message, metadata } = request.body || {};

    const agent = agentId ? await db.getAgent(agentId) : (await db.listAgents()).find(a => a.status === 'active');
    if (!agent) return reply.code(404).send({ error: 'No active agent found' });
    if (!name || !phone) return reply.code(400).send({ error: 'name and phone are required' });

    const lead = await chatStore.findOrCreateLead(agent.id, phone, {
      name,
      email: email || null,
      source: 'landing_form',
      metadata: metadata || {},
    });
    // Refresh details if the lead already existed
    await chatStore.updateLead(lead.id, {
      name: lead.name || name,
      email: lead.email || email || null,
      metadata: { ...(lead.metadata || {}), ...(metadata || {}), lastFormMessage: message || null },
    });

    broadcast('chat.lead_captured', {
      leadId: lead.id, agentId: agent.id, leadName: name, leadPhone: lead.phone, source: 'landing_form',
    });

    let whatsappLink = null;
    if (agent.whatsappNumber) {
      const digits = agent.whatsappNumber.replace(/[^\d]/g, '');
      const prefill = encodeURIComponent(
        message ? `Hi! I'm ${name}. ${message}` : `Hi! I'm ${name}, I just sent an inquiry through your website.`
      );
      whatsappLink = `https://wa.me/${digits}?text=${prefill}`;
    }

    return { ok: true, leadId: lead.id, whatsappLink };
  });

  // ─── Dashboard: stats / leads / conversations ─────────────────────

  app.get('/api/agents/:id/chat/stats', async (request) => {
    return chatStore.getChatStats(request.params.id);
  });

  app.get('/api/agents/:id/leads', async (request) => {
    const { status } = request.query;
    return chatStore.listLeads(request.params.id, { status });
  });

  app.put('/api/leads/:id', async (request, reply) => {
    const { status, sentiment, name, note } = request.body || {};
    const updates = {};
    if (status) updates.status = status;
    if (sentiment) updates.sentiment = sentiment;
    if (name) updates.name = name;
    const lead = await chatStore.updateLead(request.params.id, updates);
    if (!lead) return reply.code(404).send({ error: 'Lead not found' });
    if (note) await chatStore.addLeadNote(request.params.id, note, 'bd');
    return lead;
  });

  app.get('/api/agents/:id/conversations', async (request) => {
    const { mode, status } = request.query;
    const convos = await chatStore.listConversations(request.params.id, { mode, status });
    // Attach lead info for list rendering
    return Promise.all(convos.map(async c => ({
      ...c,
      lead: await chatStore.getLead(c.leadId),
    })));
  });

  app.get('/api/conversations/:id', async (request, reply) => {
    const convo = await chatStore.getConversation(request.params.id);
    if (!convo) return reply.code(404).send({ error: 'Conversation not found' });
    const [lead, msgs] = await Promise.all([
      chatStore.getLead(convo.leadId),
      chatStore.listMessages(convo.id, 200),
    ]);
    return { ...convo, lead, messages: msgs, windowOpen: whatsapp.isWindowOpen(convo.lastInboundAt) };
  });

  // ─── Takeover / release / close ───────────────────────────────────

  app.post('/api/conversations/:id/takeover', async (request, reply) => {
    const convo = await chatStore.updateConversation(request.params.id, { mode: 'human' });
    if (!convo) return reply.code(404).send({ error: 'Conversation not found' });
    broadcast('chat.mode_changed', { conversationId: convo.id, agentId: convo.agentId, mode: 'human' });
    return convo;
  });

  app.post('/api/conversations/:id/release', async (request, reply) => {
    const convo = await chatStore.updateConversation(request.params.id, { mode: 'ai' });
    if (!convo) return reply.code(404).send({ error: 'Conversation not found' });
    broadcast('chat.mode_changed', { conversationId: convo.id, agentId: convo.agentId, mode: 'ai' });
    return convo;
  });

  app.post('/api/conversations/:id/close', async (request, reply) => {
    const convo = await chatStore.updateConversation(request.params.id, { status: 'closed' });
    if (!convo) return reply.code(404).send({ error: 'Conversation not found' });
    await chatStore.cancelPendingJobs(convo.id);
    return convo;
  });

  // BD sends a message into the conversation (as themselves)
  app.post('/api/conversations/:id/send', async (request, reply) => {
    const { text } = request.body || {};
    if (!text?.trim()) return reply.code(400).send({ error: 'text is required' });

    const convo = await chatStore.getConversation(request.params.id);
    if (!convo) return reply.code(404).send({ error: 'Conversation not found' });
    const [lead, agent] = await Promise.all([
      chatStore.getLead(convo.leadId),
      db.getAgent(convo.agentId),
    ]);
    if (!agent?.whatsappPhoneNumberId) return reply.code(400).send({ error: 'Agent has no WhatsApp number configured' });
    if (lead.optedOut) return reply.code(400).send({ error: 'Lead has opted out' });

    try {
      const { providerMessageId, usedTemplate } = await whatsapp.sendSmart(
        agent.whatsappPhoneNumberId, lead.phone, text.trim(), convo.lastInboundAt,
        [lead.name || 'there', text.trim()]);
      const msg = await chatStore.addMessage({
        conversationId: convo.id,
        direction: 'out',
        sender: 'bd',
        type: usedTemplate ? 'template' : 'text',
        body: text.trim(),
        providerMessageId,
      });
      broadcast('chat.message', {
        conversationId: convo.id, agentId: agent.id, agentName: agent.name,
        leadId: lead.id, leadName: lead.name, leadPhone: lead.phone,
        message: msg, mode: convo.mode,
      });
      return { ok: true, message: msg, usedTemplate };
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // ─── Callback queue ───────────────────────────────────────────────

  app.get('/api/agents/:id/callbacks', async (request) => {
    const jobs = await chatStore.listJobs(request.params.id, { status: 'pending' });
    const callbacks = jobs.filter(j => j.type === 'callback_alert');
    return Promise.all(callbacks.map(async j => ({
      ...j,
      lead: await chatStore.getLead(j.leadId),
    })));
  });

  app.get('/api/agents/:id/followups', async (request) => {
    const jobs = await chatStore.listJobs(request.params.id, { status: 'pending' });
    const followups = jobs.filter(j => j.type === 'followup');
    return Promise.all(followups.map(async j => ({
      ...j,
      lead: await chatStore.getLead(j.leadId),
    })));
  });

  app.post('/api/jobs/:id/complete', async (request, reply) => {
    const job = await chatStore.updateJob(request.params.id, { status: 'done' });
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    return job;
  });

  app.post('/api/jobs/:id/cancel', async (request, reply) => {
    const job = await chatStore.updateJob(request.params.id, { status: 'cancelled' });
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    return job;
  });

  logger.info('💬 Chat routes registered (WhatsApp webhook + dashboard API)');
}
