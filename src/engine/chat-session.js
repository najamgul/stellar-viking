/**
 * Chat session engine — the async counterpart of session-manager.js.
 *
 * Voice sessions are live streams that die with the call; a chat
 * conversation is durable and wakes up on every inbound message.
 * This module processes one inbound WhatsApp event end-to-end:
 *
 *   gates (dedupe, opt-out, mode) → hydrate history → Gemini with tools
 *   → send reply bubbles (typing delay) → persist → broadcast to dashboard
 *
 * It also composes scheduled follow-up messages for the job runner.
 */

import { GoogleGenAI } from '@google/genai';
import config from '../config.js';
import logger from '../utils/logger.js';
import * as db from '../storage/database.js';
import * as chatStore from '../storage/chat-store.js';
import * as whatsapp from '../channels/whatsapp.js';
import { buildChatSystemPrompt, buildChatToolDeclarations } from './chat-prompt.js';
import { query as queryKnowledge } from '../knowledge/retriever.js';
import { executeTool } from './tool-dispatcher.js';
import { broadcast } from '../api/admin-events.js';

const MAX_HISTORY = 40;         // messages fed to the model
const MAX_TOOL_ROUNDS = 6;
const MAX_BUBBLES = 3;

const OPT_OUT_RE = /^\s*(stop|unsubscribe|opt\s*out)\s*$/i;

let _client = null;
function getClient() {
  if (!_client) _client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return _client;
}

// Serialize processing per conversation so two rapid inbound messages
// can't produce interleaved AI replies.
const convoLocks = new Map(); // conversationId → Promise

function withConvoLock(conversationId, fn) {
  const prev = convoLocks.get(conversationId) || Promise.resolve();
  const next = prev.then(fn);
  // The stored chain link must never reject, or a failed turn becomes an
  // unhandled rejection (the caller awaits `next`, nobody awaits the map entry).
  const link = next.then(() => {}, () => {});
  convoLocks.set(conversationId, link);
  link.then(() => {
    if (convoLocks.get(conversationId) === link) convoLocks.delete(conversationId);
  });
  return next;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Inbound entry point ───────────────────────────────────────────

/**
 * Handle one normalized inbound message event from the WhatsApp webhook.
 * Never throws — webhook must always 200.
 */
export async function processInboundMessage(event) {
  try {
    const agent = await db.getAgentByWhatsappId(event.phoneNumberId);
    if (!agent) {
      logger.warn({ phoneNumberId: event.phoneNumberId }, 'Inbound WhatsApp for unmapped number — ignoring');
      return;
    }

    const lead = await chatStore.findOrCreateLead(agent.id, `+${event.from}`, {
      name: event.profileName,
      source: 'whatsapp',
    });
    // Capture the WhatsApp profile name if the lead was created earlier without one
    if (!lead.name && event.profileName) {
      await chatStore.updateLead(lead.id, { name: event.profileName });
      lead.name = event.profileName;
    }

    const convo = await chatStore.findOrCreateConversation(agent.id, lead.id, 'whatsapp');

    // Dedupe: Meta retries webhooks on slow/failed responses
    if (await chatStore.hasProviderMessage(convo.id, event.messageId)) {
      logger.debug({ messageId: event.messageId }, 'Duplicate webhook delivery — skipping');
      return;
    }

    const bodyText = event.type === 'unsupported'
      ? '[sent a media attachment]'
      : (event.text || '');

    const inboundMsg = await chatStore.addMessage({
      conversationId: convo.id,
      direction: 'in',
      sender: 'lead',
      type: event.type === 'unsupported' ? 'unsupported' : 'text',
      body: bodyText,
      providerMessageId: event.messageId,
    });

    broadcast('chat.message', {
      conversationId: convo.id,
      agentId: agent.id,
      agentName: agent.name,
      leadId: lead.id,
      leadName: lead.name,
      leadPhone: lead.phone,
      message: inboundMsg,
      mode: convo.mode,
    });

    // ─── Gates ─────────────────────────────────────────────
    if (lead.optedOut) return;

    if (OPT_OUT_RE.test(bodyText)) {
      await chatStore.updateLead(lead.id, { optedOut: true, status: 'closed' });
      await chatStore.cancelPendingJobs(convo.id);
      await sendAndRecord(agent, convo, lead, 'ai',
        `You won't hear from us again. If you ever change your mind, just message us here. Take care!`);
      broadcast('chat.optout', { conversationId: convo.id, agentId: agent.id, leadId: lead.id, leadName: lead.name });
      return;
    }

    if (convo.mode !== 'ai') return; // human has the wheel — dashboard already got the broadcast

    if (lead.status === 'new') {
      await chatStore.updateLead(lead.id, { status: 'engaged' });
      lead.status = 'engaged';
    }

    await whatsapp.markReadWithTyping(event.phoneNumberId, event.messageId);

    await withConvoLock(convo.id, () => runAiTurn(agent, convo.id, lead.id));

  } catch (err) {
    logger.error({ error: err.message, stack: err.stack }, 'processInboundMessage failed');
  }
}

/** Delivery-status webhook events → update stored messages. */
export async function processStatusEvent(event) {
  try {
    await chatStore.updateMessageStatus(event.messageId, event.status);
    if (event.status === 'failed') {
      logger.warn({ messageId: event.messageId, errors: event.errors }, 'WhatsApp message failed to deliver');
    }
  } catch (err) {
    logger.error({ error: err.message }, 'processStatusEvent failed');
  }
}

// ─── The AI turn ───────────────────────────────────────────────────

/**
 * Run one AI turn on a conversation: history → Gemini (tool loop) → send.
 * @param {string} [injectedInstruction] - extra system-side nudge, used by
 *   the scheduler ("it's time for the follow-up about X").
 */
export async function runAiTurn(agent, conversationId, leadId, injectedInstruction = null) {
  const convo = await chatStore.getConversation(conversationId);
  const lead = await chatStore.getLead(leadId);
  if (!convo || !lead) return;

  const agentTools = await db.listTools(agent.id);
  const systemInstruction = buildChatSystemPrompt(agent, lead, agentTools);
  const tools = buildChatToolDeclarations(agent, agentTools);

  const history = await chatStore.listMessages(conversationId, MAX_HISTORY);
  const contents = history
    .filter(m => m.body)
    .map(m => ({
      role: m.direction === 'in' ? 'user' : 'model',
      parts: [{ text: m.sender === 'bd' ? `[team member]: ${m.body}` : m.body }],
    }));

  if (injectedInstruction) {
    contents.push({ role: 'user', parts: [{ text: `[SYSTEM NOTE — not from the lead]: ${injectedInstruction}` }] });
  }
  if (contents.length === 0) return;

  const client = getClient();
  const toolContext = { agent, conversation: convo, lead, handedOff: false };
  let response;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    response = await client.models.generateContent({
      model: config.chatModel,
      contents,
      config: { systemInstruction, tools, temperature: 0.8 },
    });

    const calls = response.functionCalls;
    if (!calls || calls.length === 0) break;

    // Echo the model's turn back VERBATIM — newer Gemini models attach a
    // thoughtSignature to functionCall parts and reject requests that drop it.
    contents.push(response.candidates[0].content);

    const responseParts = [];
    for (const call of calls) {
      const result = await executeChatTool(call.name, call.args || {}, toolContext);
      responseParts.push({ functionResponse: { name: call.name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  const replyText = (response?.text || '').trim();
  if (replyText) {
    const bubbles = replyText.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).slice(0, MAX_BUBBLES);
    for (const bubble of bubbles) {
      await sleep(whatsapp.typingDelayMs(bubble));
      await sendAndRecord(agent, convo, lead, 'ai', bubble);
    }
  }

  if (toolContext.handedOff) {
    await chatStore.updateConversation(conversationId, { mode: 'human' });
  }
}

/** Send free-form text (window is open — we're replying to an inbound), persist, broadcast. */
async function sendAndRecord(agent, convo, lead, sender, text) {
  const to = lead.phone;
  let providerMessageId = null;
  let deliveryStatus = 'queued';
  try {
    providerMessageId = await whatsapp.sendText(agent.whatsappPhoneNumberId, to, text);
  } catch (err) {
    deliveryStatus = 'failed';
    logger.error({ error: err.message, conversationId: convo.id }, 'Outbound send failed');
  }
  const msg = await chatStore.addMessage({
    conversationId: convo.id,
    direction: 'out',
    sender,
    body: text,
    providerMessageId,
    deliveryStatus,
  });
  broadcast('chat.message', {
    conversationId: convo.id,
    agentId: agent.id,
    agentName: agent.name,
    leadId: lead.id,
    leadName: lead.name,
    leadPhone: lead.phone,
    message: msg,
    mode: convo.mode,
  });
  return msg;
}

// ─── Chat tools ────────────────────────────────────────────────────

async function executeChatTool(toolName, args, ctx) {
  const { agent, conversation, lead } = ctx;
  logger.info({ tool: toolName, args, conversationId: conversation.id }, '💬 Chat tool call');

  try {
    switch (toolName) {
      case 'query_knowledge_base': {
        const results = await queryKnowledge(agent.id, args.query, config.defaults.kbTopK);
        if (results.length === 0) return 'No information found in the knowledge base for that.';
        return results.map(r => r.text).join('\n---\n');
      }

      case 'update_lead_status': {
        const updates = {};
        if (chatStore.LEAD_STATUSES.includes(args.status)) updates.status = args.status;
        if (['positive', 'neutral', 'negative'].includes(args.sentiment)) updates.sentiment = args.sentiment;
        await chatStore.updateLead(lead.id, updates);
        if (args.note) await chatStore.addLeadNote(lead.id, args.note, 'ai');
        broadcast('chat.lead_updated', { leadId: lead.id, agentId: agent.id, ...updates });
        return `Lead updated: ${JSON.stringify(updates)}`;
      }

      case 'schedule_followup': {
        const runAt = new Date(args.datetime);
        if (isNaN(runAt.getTime()) || runAt <= new Date()) {
          return 'Error: datetime must be a valid ISO 8601 time in the future. Ask the lead to clarify the time if needed.';
        }
        // One pending follow-up per conversation — newest wins
        await chatStore.cancelPendingJobs(conversation.id, 'followup');
        await chatStore.createJob({
          agentId: agent.id,
          conversationId: conversation.id,
          leadId: lead.id,
          type: 'followup',
          runAt: runAt.toISOString(),
          payload: { context: args.context },
        });
        await chatStore.updateLead(lead.id, { status: 'follow_up_scheduled' });
        broadcast('chat.followup_scheduled', {
          leadId: lead.id, agentId: agent.id, leadName: lead.name,
          runAt: runAt.toISOString(), context: args.context,
        });
        return `Follow-up scheduled for ${runAt.toISOString()}. Confirm this casually to the lead.`;
      }

      case 'request_callback': {
        await chatStore.updateLead(lead.id, { status: 'callback_requested' });
        await chatStore.addLeadNote(lead.id, `Callback requested: ${args.reason}${args.preferred_time ? ` (preferred: ${args.preferred_time})` : ''}`, 'ai');
        const job = await chatStore.createJob({
          agentId: agent.id,
          conversationId: conversation.id,
          leadId: lead.id,
          type: 'callback_alert',
          runAt: new Date().toISOString(),
          payload: { reason: args.reason, preferredTime: args.preferred_time || null, phone: lead.phone },
        });
        broadcast('chat.callback', {
          jobId: job.id, leadId: lead.id, agentId: agent.id,
          leadName: lead.name, leadPhone: lead.phone,
          reason: args.reason, preferredTime: args.preferred_time || null,
        });
        notifyAgentWebhook(agent, 'lead.callback_requested', {
          lead: { id: lead.id, name: lead.name, phone: lead.phone },
          reason: args.reason,
          preferredTime: args.preferred_time || null,
        });
        return 'The team has been alerted and will call them. Tell the lead someone will reach out' +
               (args.preferred_time ? ` around ${args.preferred_time}.` : ' soon.');
      }

      case 'handoff_to_human': {
        ctx.handedOff = true;
        await chatStore.addLeadNote(lead.id, `AI handed off: ${args.reason}`, 'ai');
        broadcast('chat.handoff', {
          conversationId: conversation.id, agentId: agent.id,
          leadId: lead.id, leadName: lead.name, reason: args.reason,
        });
        notifyAgentWebhook(agent, 'chat.handoff', {
          lead: { id: lead.id, name: lead.name, phone: lead.phone },
          reason: args.reason,
        });
        return 'Conversation will be handed to a human after your reply. Let the lead know a team member is taking over shortly.';
      }

      default:
        // User-defined external HTTP tools — same dispatcher as voice
        return await executeTool(toolName, args, {
          callId: conversation.id,
          agentId: agent.id,
          agent,
          log: logger,
        });
    }
  } catch (err) {
    logger.error({ tool: toolName, error: err.message }, 'Chat tool failed');
    return `Tool error: ${err.message}`;
  }
}

/** Fire-and-forget POST to the agent's configured webhook (BD alerting). */
function notifyAgentWebhook(agent, eventType, data) {
  if (!agent.webhookUrl) return;
  fetch(agent.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), data }),
  }).catch(err => logger.warn({ error: err.message }, 'Agent webhook notify failed'));
}

// ─── Scheduled follow-up execution (called by the job runner) ──────

export async function executeFollowupJob(job) {
  const agent = await db.getAgent(job.agentId);
  const convo = await chatStore.getConversation(job.conversationId);
  const lead = await chatStore.getLead(job.leadId);
  if (!agent || !convo || !lead) throw new Error('Follow-up job references missing records');
  if (lead.optedOut || convo.status === 'closed') return { skipped: true };

  const context = job.payload?.context || 'their earlier inquiry';

  if (whatsapp.isWindowOpen(convo.lastInboundAt)) {
    // Window still open — let the AI compose a natural free-form follow-up
    await withConvoLock(convo.id, () => runAiTurn(agent, convo.id, lead.id,
      `It is now time for the scheduled follow-up about: "${context}". ` +
      `Write a short, natural follow-up message to re-open the conversation. Do not mention that this was scheduled.`));
    return { usedTemplate: false };
  }

  // Window closed — must use the approved re-engagement template
  const vars = [lead.name || 'there', context];
  const { providerMessageId } = await whatsapp.sendSmart(
    agent.whatsappPhoneNumberId, lead.phone, null, convo.lastInboundAt, vars);

  const msg = await chatStore.addMessage({
    conversationId: convo.id,
    direction: 'out',
    sender: 'ai',
    type: 'template',
    body: `[template: ${config.whatsappFollowupTemplate}] ${vars.join(' · ')}`,
    providerMessageId,
  });
  broadcast('chat.message', {
    conversationId: convo.id, agentId: agent.id, agentName: agent.name,
    leadId: lead.id, leadName: lead.name, leadPhone: lead.phone,
    message: msg, mode: convo.mode,
  });
  return { usedTemplate: true };
}
