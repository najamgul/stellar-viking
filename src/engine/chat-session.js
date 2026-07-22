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
import { buildChatSystemPrompt, buildChatTools } from './chat-prompt.js';
import { getChatProvider } from './llm/index.js';
import { deferToWakingHours, getLocalHour } from './phone-locale.js';
import { query as queryKnowledge } from '../knowledge/retriever.js';
import { executeTool } from './tool-dispatcher.js';
import { broadcast } from '../api/admin-events.js';
import { syncToCrm, messagePayload } from '../integrations/crm-sync.js';

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

// ─── Outbound text sanitizer ───────────────────────────────────────
// Models occasionally write tool calls as TEXT instead of invoking them
// (e.g. "outcall:default_api:update_lead_status{...}"). The lead sees our
// text verbatim, so anything resembling tool syntax must never be sent.

const TOOL_NAMES_RE = 'query_knowledge_base|update_lead_status|schedule_followup|request_callback|remember_lead_fact|handoff_to_human';
const TOOL_LEAK_RE = new RegExp(
  `default_api|tool_code|function_call|^\\s*(outcall|toolcall|tool_call|api_call)\\s*:|^[\\w.]+:[\\w.]+\\{|(${TOOL_NAMES_RE})\\s*[({]`,
  'i'
);

function sanitizeReply(text) {
  if (!text) return '';
  // Fenced code blocks are never legitimate in a WhatsApp sales chat
  let out = text.replace(/```[\s\S]*?```/g, ' ');
  // Drop any line that looks like leaked tool-call syntax
  out = out.split('\n').filter(line => !TOOL_LEAK_RE.test(line)).join('\n');
  // Markdown slips (the prompt forbids it, models still emit it)
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

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

    // Click-to-WhatsApp ad attribution — persist once, on the first ad message
    if (event.referral && !lead.metadata?.campaign) {
      const updated = await chatStore.updateLead(lead.id, {
        metadata: { ...(lead.metadata || {}), campaign: event.referral },
      });
      if (updated) lead.metadata = updated.metadata;
    }

    const convo = await chatStore.findOrCreateConversation(agent.id, lead.id, 'whatsapp');

    // Dedupe: Meta retries webhooks on slow/failed responses
    if (await chatStore.hasProviderMessage(convo.id, event.messageId)) {
      logger.debug({ messageId: event.messageId }, 'Duplicate webhook delivery — skipping');
      return;
    }

    // The lead replied — reset the paid re-engagement drip budget
    if (convo.dripCount || convo.dripClosedAt) {
      await chatStore.updateConversation(convo.id, { dripCount: 0, lastDripAt: null, dripClosedAt: null });
      convo.dripCount = 0;
      convo.dripClosedAt = null;
    }

    let bodyText = event.type === 'unsupported'
      ? '[sent a media attachment]'
      : (event.text || '');
    let msgType = event.type === 'unsupported' ? 'unsupported' : 'text';
    let leadSentVoiceNote = false;

    // Voice notes: download + transcribe so the AI "hears" them
    if (event.type === 'audio' && event.mediaId) {
      msgType = 'audio';
      leadSentVoiceNote = event.isVoiceNote;
      try {
        const media = await whatsapp.downloadMedia(event.mediaId);
        const transcript = await transcribeAudio(media.base64, media.mimeType);
        bodyText = transcript ? `🎤 ${transcript}` : '[voice note — could not transcribe]';
      } catch (err) {
        logger.warn({ error: err.message }, 'Voice note transcription failed');
        bodyText = '[voice note — could not transcribe]';
      }
    }

    const inboundMsg = await chatStore.addMessage({
      conversationId: convo.id,
      direction: 'in',
      sender: 'lead',
      type: msgType,
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
    syncToCrm(agent, 'message.logged', { lead, message: messagePayload(inboundMsg) });

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

    // Occasionally react like a human would to warm/affirming messages
    if (/\b(thank|thanks|shukriya|dhanyavaad|great|perfect|awesome|nice|love|good)\b/i.test(bodyText)
        && Math.random() < 0.35) {
      const emoji = /\b(thank|thanks|shukriya|dhanyavaad)\b/i.test(bodyText) ? '🙏' : '👍';
      whatsapp.sendReaction(event.phoneNumberId, lead.phone, event.messageId, emoji);
    }

    await withConvoLock(convo.id, () =>
      runAiTurn(agent, convo.id, lead.id, null, { replyWithVoice: leadSentVoiceNote }));

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
export async function runAiTurn(agent, conversationId, leadId, injectedInstruction = null, opts = {}) {
  const convo = await chatStore.getConversation(conversationId);
  const lead = await chatStore.getLead(leadId);
  if (!convo || !lead) return;

  const agentTools = await db.listTools(agent.id);
  const systemInstruction = buildChatSystemPrompt(agent, lead, agentTools);
  const tools = buildChatTools(agent, agentTools);

  const history = await chatStore.listMessages(conversationId, MAX_HISTORY);
  const messages = history
    .filter(m => m.body)
    .map(m => ({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: m.sender === 'bd' ? `[team member]: ${m.body}` : m.body,
    }));

  if (injectedInstruction) {
    messages.push({ role: 'user', content: `[SYSTEM NOTE — not from the lead]: ${injectedInstruction}` });
  }
  if (messages.length === 0) return;

  const toolContext = { agent, conversation: convo, lead, handedOff: false };
  const provider = getChatProvider(agent);

  let rawReply = '';
  try {
    const result = await provider.runConversation({
      system: systemInstruction,
      messages,
      tools,
      temperature: 0.8,
      maxToolRounds: MAX_TOOL_ROUNDS,
      executeTool: (name, args) => executeChatTool(name, args, toolContext),
    });
    rawReply = (result?.text || '').trim();
  } catch (err) {
    logger.error({ conversationId, provider: provider.name, error: err.message }, 'LLM turn failed');
    return;
  }
  const replyText = sanitizeReply(rawReply);
  if (rawReply && !replyText) {
    logger.warn({ conversationId }, '🧹 Reply was entirely leaked tool syntax — suppressed');
  } else if (rawReply.length - replyText.length > 10) {
    logger.warn({ conversationId }, '🧹 Sanitized leaked tool syntax / markdown from reply');
  }
  if (replyText) {
    // Mirror the lead: if they sent a voice note, try replying with one
    if (opts.replyWithVoice && config.inworldTtsApiKey) {
      const spoken = replyText.replace(/\n\s*\n/g, ' ... ');
      const sent = await sendVoiceReply(agent, convo, lead, spoken);
      if (!sent) {
        for (const bubble of splitBubbles(replyText)) {
          await sleep(whatsapp.typingDelayMs(bubble));
          await sendAndRecord(agent, convo, lead, 'ai', bubble);
        }
      }
    } else {
      for (const bubble of splitBubbles(replyText)) {
        await sleep(whatsapp.typingDelayMs(bubble));
        await sendAndRecord(agent, convo, lead, 'ai', bubble);
      }
    }
  }

  if (toolContext.handedOff) {
    await chatStore.updateConversation(conversationId, { mode: 'human' });
  }
}

function splitBubbles(replyText) {
  return replyText.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).slice(0, MAX_BUBBLES);
}

/** Transcribe a voice note with Gemini's native audio understanding. */
async function transcribeAudio(base64, mimeType) {
  const client = getClient();
  const response = await client.models.generateContent({
    model: config.chatModel,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: 'Transcribe this voice message exactly as spoken (keep the original language; use Latin script if the speaker mixes languages casually). Return ONLY the transcription, nothing else.' },
      ],
    }],
  });
  return (response.text || '').trim();
}

/** Synthesize the reply with Inworld TTS and send it as a WhatsApp audio message. */
async function sendVoiceReply(agent, convo, lead, text) {
  try {
    const { InworldTTS } = await import('./inworld-tts.js');
    const tts = new InworldTTS({ voiceId: agent.chatVoice || 'Riya' });
    const base64Mp3 = await tts.speakHTTP(text);
    if (!base64Mp3) throw new Error('TTS returned no audio');
    const mediaId = await whatsapp.uploadAudio(agent.whatsappPhoneNumberId, base64Mp3, 'audio/mpeg');
    const providerMessageId = await whatsapp.sendAudio(agent.whatsappPhoneNumberId, lead.phone, mediaId);
    const msg = await chatStore.addMessage({
      conversationId: convo.id,
      direction: 'out',
      sender: 'ai',
      type: 'audio',
      body: `🎤 ${text}`,
      providerMessageId,
    });
    broadcast('chat.message', {
      conversationId: convo.id, agentId: agent.id, agentName: agent.name,
      leadId: lead.id, leadName: lead.name, leadPhone: lead.phone,
      message: msg, mode: convo.mode,
    });
    syncToCrm(agent, 'message.logged', { lead, message: messagePayload(msg) });
    return true;
  } catch (err) {
    logger.warn({ error: err.message }, 'Voice reply failed — falling back to text');
    return false;
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
  syncToCrm(agent, 'message.logged', { lead, message: messagePayload(msg) });
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
        const freshLead = { ...lead, ...updates };
        syncToCrm(agent, 'lead.upserted', { lead: freshLead });
        // A lead turning qualified = they stated a real requirement → alert BD
        if (updates.status === 'qualified') {
          const recent = await chatStore.listMessages(conversation.id, 10);
          syncToCrm(agent, 'alert.qualified', {
            lead: freshLead,
            alert: { kind: 'qualified', detail: args.note || 'Lead qualified by the bot' },
            transcript: recent,
          });
        }
        return `Lead updated: ${JSON.stringify(updates)}`;
      }

      case 'schedule_followup': {
        let runAt = new Date(args.datetime);
        if (isNaN(runAt.getTime()) || runAt <= new Date()) {
          return 'Error: datetime must be a valid ISO 8601 time in the future. Ask the lead to clarify the time if needed.';
        }
        // Never fire scheduled messages in the lead's night
        runAt = deferToWakingHours(lead.phone, runAt);
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
        // Surface the bot's plan in the CRM's follow-up system
        syncToCrm(agent, 'lead.upserted', {
          lead: { ...lead, status: 'follow_up_scheduled' },
          followupAt: runAt.toISOString(),
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
        {
          const recent = await chatStore.listMessages(conversation.id, 10);
          syncToCrm(agent, 'alert.callback', {
            lead: { ...lead, status: 'callback_requested' },
            alert: { kind: 'callback', detail: args.reason, preferredTime: args.preferred_time || null },
            transcript: recent,
          });
        }
        return 'The team has been alerted and will call them. Tell the lead someone will reach out' +
               (args.preferred_time ? ` around ${args.preferred_time}.` : ' soon.');
      }

      case 'remember_lead_fact': {
        const key = String(args.key || '').trim().slice(0, 60);
        const value = String(args.value || '').trim().slice(0, 300);
        if (!key || !value) return 'Error: key and value are required.';
        const facts = { ...(lead.metadata?.facts || {}), [key]: value };
        const updated = await chatStore.updateLead(lead.id, {
          metadata: { ...(lead.metadata || {}), facts },
        });
        if (updated) lead.metadata = updated.metadata;
        syncToCrm(agent, 'lead.upserted', { lead });
        return `Remembered: ${key} = ${value}`;
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
        {
          const recent = await chatStore.listMessages(conversation.id, 10);
          syncToCrm(agent, 'alert.handoff', {
            lead,
            alert: { kind: 'handoff', detail: args.reason },
            transcript: recent,
          });
        }
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

// ─── Silence nudge (called by the job runner's scan) ───────────────

const NUDGE_AFTER_MS = 4 * 60 * 60 * 1000;           // stage 1: quiet for 4h+
const NUDGE_WINDOW_MARGIN_MS = 20 * 60 * 60 * 1000;  // stage 1: stay well inside 24h window
const SAVER_MIN_MS = 20 * 60 * 60 * 1000;            // stage 2: window-close saver fires 20-23h
const SAVER_MAX_MS = 23 * 60 * 60 * 1000;            //          after the lead's last message

/**
 * Two-stage silence re-engagement while the free 24h window is still open.
 *
 * Stage 1 — gentle nudge: lead quiet 4h+ mid-conversation, once per inbound.
 * Stage 2 — window-close saver: the 24h free-reply window is about to shut
 * (20-23h since their last message). One reply from the lead restarts the
 * window for free; after it closes every message needs a PAID template. So
 * this last message is crafted to elicit any reply at all.
 */
export async function maybeNudge(convo, now = new Date()) {
  if (!convo.lastInboundAt || !convo.lastMessageAt) return false;
  const sinceInbound = now - new Date(convo.lastInboundAt);
  const sinceLastMsg = now - new Date(convo.lastMessageAt);
  const weSpokeLast = new Date(convo.lastMessageAt) > new Date(convo.lastInboundAt);
  if (!weSpokeLast) return false;

  const lastInbound = new Date(convo.lastInboundAt);
  const nudgedSinceInbound = convo.nudgedAt && new Date(convo.nudgedAt) > lastInbound;
  const saverSentSinceInbound = convo.saverNudgedAt && new Date(convo.saverNudgedAt) > lastInbound;

  let stage = null;
  if (!nudgedSinceInbound && sinceLastMsg >= NUDGE_AFTER_MS && sinceInbound <= NUDGE_WINDOW_MARGIN_MS) {
    stage = 1;
  } else if (!saverSentSinceInbound && sinceInbound >= SAVER_MIN_MS && sinceInbound <= SAVER_MAX_MS) {
    stage = 2;
  }
  if (!stage) return false;

  const lead = await chatStore.getLead(convo.leadId);
  if (!lead || lead.optedOut) return false;
  if (['closed', 'not_interested', 'callback_requested'].includes(lead.status)) return false;

  const hour = getLocalHour(lead.phone, now);
  if (hour !== null && (hour < config.outreach.startHour || hour >= config.outreach.endHour)) return false;

  const agent = await db.getAgent(convo.agentId);
  if (!agent?.whatsappPhoneNumberId) return false;

  if (stage === 1) {
    const quietHours = Math.round(sinceLastMsg / 3600000);
    await chatStore.updateConversation(convo.id, { nudgedAt: now.toISOString() });
    await withConvoLock(convo.id, () => runAiTurn(agent, convo.id, lead.id,
      `The lead went quiet ${quietHours} hours ago, mid-conversation, without replying to your last message. ` +
      `Send ONE short, casual, low-pressure nudge that moves the conversation forward (reference what you were discussing). ` +
      `No guilt-tripping, no "just checking in" clichés. One bubble only.`));
    logger.info({ conversationId: convo.id }, '👋 Silence nudge sent');
  } else {
    const hoursLeft = Math.max(1, Math.round((24 * 3600000 - sinceInbound) / 3600000));
    await chatStore.updateConversation(convo.id, { saverNudgedAt: now.toISOString() });
    await withConvoLock(convo.id, () => runAiTurn(agent, convo.id, lead.id,
      `[SYSTEM] The free messaging window with this lead closes in about ${hoursLeft} hour(s) — after that, ` +
      `re-engaging costs money. Send ONE very short message (single line, one bubble) that ends with an easy, ` +
      `low-effort question the lead can answer in one word — referencing the live topic (e.g. holding a price, ` +
      `confirming a preference). The only goal is to get ANY reply. Never mention windows, deadlines or anything technical.`));
    logger.info({ conversationId: convo.id, hoursLeft }, '⏳ Window-close saver sent');
  }
  return true;
}

// ─── Paid re-engagement drip (called by the job runner's scan) ─────

const DRIP_GRACE_MS = 48 * 60 * 60 * 1000; // after final attempt, wait 48h before closing out

/**
 * Once the free 24h window has closed, re-engage a silent lead with a
 * bounded sequence of PAID template messages (default: 26h, 72h, 168h after
 * their last message). Any reply resets the budget (see processInboundMessage).
 * When all attempts are spent and the lead stays silent 48h more, the lead is
 * closed locally and marked unresponsive in the CRM — never spend again.
 */
export async function maybeReengage(convo, now = new Date()) {
  if (!config.reengage.enabled || !config.whatsappFollowupTemplate) return false;
  if (!convo.lastInboundAt) return false;
  if (whatsapp.isWindowOpen(convo.lastInboundAt)) return false; // free window — nudges handle it

  const lead = await chatStore.getLead(convo.leadId);
  if (!lead || lead.optedOut) return false;
  if (['closed', 'not_interested', 'callback_requested'].includes(lead.status)) return false;

  const delays = config.reengage.delaysHours;
  const attempt = convo.dripCount || 0;

  // Budget exhausted → close out after the grace period
  if (attempt >= delays.length) {
    if (!convo.dripClosedAt && convo.lastDripAt
        && now - new Date(convo.lastDripAt) > DRIP_GRACE_MS) {
      await chatStore.updateConversation(convo.id, { dripClosedAt: now.toISOString() });
      await chatStore.updateLead(lead.id, { status: 'not_interested' });
      await chatStore.addLeadNote(lead.id,
        `Auto-closed: no reply after ${delays.length} re-engagement attempts`, 'system');
      broadcast('chat.lead_updated', { leadId: lead.id, agentId: convo.agentId, status: 'not_interested' });
      const agent = await db.getAgent(convo.agentId);
      if (agent) {
        syncToCrm(agent, 'lead.unresponsive', { lead: { ...lead, status: 'not_interested' } });
      }
      logger.info({ conversationId: convo.id }, '💤 Lead marked unresponsive — drip budget exhausted');
    }
    return false;
  }

  const sinceInbound = now - new Date(convo.lastInboundAt);
  if (sinceInbound < delays[attempt] * 60 * 60 * 1000) return false;

  // Business hours only — a paid template at 3am is wasted money
  const hour = getLocalHour(lead.phone, now);
  if (hour !== null && (hour < config.outreach.startHour || hour >= config.outreach.endHour)) return false;

  const agent = await db.getAgent(convo.agentId);
  if (!agent?.whatsappPhoneNumberId) return false;

  const context = convo.summary || 'your inquiry with us';
  const vars = [lead.name || 'there', context];
  const { providerMessageId } = await whatsapp.sendSmart(
    agent.whatsappPhoneNumberId, lead.phone, null, convo.lastInboundAt, vars);

  const msg = await chatStore.addMessage({
    conversationId: convo.id,
    direction: 'out',
    sender: 'ai',
    type: 'template',
    body: `[re-engage ${attempt + 1}/${delays.length}: ${config.whatsappFollowupTemplate}] ${vars.join(' · ')}`,
    providerMessageId,
  });
  await chatStore.updateConversation(convo.id, {
    dripCount: attempt + 1,
    lastDripAt: now.toISOString(),
  });
  broadcast('chat.message', {
    conversationId: convo.id, agentId: agent.id, agentName: agent.name,
    leadId: lead.id, leadName: lead.name, leadPhone: lead.phone,
    message: msg, mode: convo.mode,
  });
  syncToCrm(agent, 'message.logged', { lead, message: messagePayload(msg) });
  logger.info({ conversationId: convo.id, attempt: attempt + 1, of: delays.length }, '💸 Paid re-engagement sent');
  return true;
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
  syncToCrm(agent, 'message.logged', { lead, message: messagePayload(msg) });
  return { usedTemplate: true };
}
