/**
 * WhatsApp channel adapter — Meta Cloud API (direct, no BSP).
 *
 * Responsibilities:
 *   - Webhook verification handshake (GET hub.challenge)
 *   - X-Hub-Signature-256 validation on inbound POSTs
 *   - Parsing inbound webhook payloads → normalized events
 *   - Sending free-form text, templates, read receipts + typing indicator
 *   - The 24-hour window gate: sendSmart() picks free-form vs template
 *
 * The chat engine never talks to Graph API directly — everything goes
 * through here, so the 24h rule cannot be violated by accident.
 */

import crypto from 'crypto';
import config from '../config.js';
import logger from '../utils/logger.js';

const GRAPH_BASE = 'https://graph.facebook.com';

export function isConfigured() {
  return Boolean(config.whatsappAccessToken);
}

// ─── Webhook security ──────────────────────────────────────────────

/** GET /webhook/whatsapp — Meta's one-time subscription handshake. */
export function handleVerification(query) {
  if (query['hub.mode'] === 'subscribe'
      && query['hub.verify_token'] === config.whatsappVerifyToken
      && config.whatsappVerifyToken) {
    return { ok: true, challenge: query['hub.challenge'] };
  }
  return { ok: false };
}

/** Validate X-Hub-Signature-256 against the raw request body. */
export function verifySignature(rawBody, signatureHeader) {
  if (!config.whatsappAppSecret) {
    // No secret configured — allow (dev mode) but warn once per boot.
    if (!verifySignature._warned) {
      logger.warn('WHATSAPP_APP_SECRET not set — webhook signature validation is OFF');
      verifySignature._warned = true;
    }
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto
    .createHmac('sha256', config.whatsappAppSecret)
    .update(rawBody, 'utf-8')
    .digest('hex');
  const received = signatureHeader.slice('sha256='.length);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
  } catch {
    return false;
  }
}

// ─── Inbound parsing ───────────────────────────────────────────────

/**
 * Flatten a Meta webhook POST body into normalized events.
 * Returns array of:
 *   { kind: 'message', phoneNumberId, from, profileName, messageId, timestamp, text, type }
 *   { kind: 'status',  phoneNumberId, messageId, status, timestamp }
 */
export function parseWebhook(body) {
  const events = [];
  if (body?.object !== 'whatsapp_business_account') return events;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value || change.field !== 'messages') continue;
      const phoneNumberId = value.metadata?.phone_number_id;

      for (const msg of value.messages || []) {
        const contact = (value.contacts || [])[0];
        let text = null;
        let type = msg.type;
        let mediaId = null;
        let isVoiceNote = false;
        if (msg.type === 'text') {
          text = msg.text?.body || '';
        } else if (msg.type === 'button') {
          text = msg.button?.text || '';
        } else if (msg.type === 'interactive') {
          text = msg.interactive?.button_reply?.title
              || msg.interactive?.list_reply?.title || '';
        } else if (msg.type === 'audio') {
          mediaId = msg.audio?.id || null;
          isVoiceNote = Boolean(msg.audio?.voice);
        } else {
          type = 'unsupported'; // image/document/etc — acknowledged, not processed
        }
        events.push({
          kind: 'message',
          phoneNumberId,
          from: msg.from,                          // wa_id, digits without '+'
          profileName: contact?.profile?.name || null,
          messageId: msg.id,
          timestamp: msg.timestamp,
          text,
          type,
          mediaId,
          isVoiceNote,
        });
      }

      for (const st of value.statuses || []) {
        events.push({
          kind: 'status',
          phoneNumberId,
          messageId: st.id,
          status: st.status,                       // sent | delivered | read | failed
          timestamp: st.timestamp,
          errors: st.errors || null,
        });
      }
    }
  }
  return events;
}

// ─── Outbound ──────────────────────────────────────────────────────

async function graphPost(phoneNumberId, payload) {
  const url = `${GRAPH_BASE}/${config.whatsappApiVersion}/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.whatsappAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data?.error?.message || `HTTP ${res.status}`;
    logger.error({ status: res.status, error: data?.error }, 'WhatsApp send failed');
    throw new Error(`WhatsApp API error: ${errMsg}`);
  }
  return data; // { messages: [{ id }], ... }
}

/** Free-form text — only valid inside the 24h customer-service window. */
export async function sendText(phoneNumberId, to, body) {
  const data = await graphPost(phoneNumberId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/^\+/, ''),
    type: 'text',
    text: { preview_url: false, body },
  });
  return data.messages?.[0]?.id || null;
}

/** Pre-approved template — required outside the 24h window. */
export async function sendTemplate(phoneNumberId, to, templateName, variables = [], language) {
  const components = variables.length > 0 ? [{
    type: 'body',
    parameters: variables.map(v => ({ type: 'text', text: String(v) })),
  }] : [];
  const data = await graphPost(phoneNumberId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: templateName,
      language: { code: language || config.whatsappTemplateLanguage },
      components,
    },
  });
  return data.messages?.[0]?.id || null;
}

/** React to a lead's message with an emoji (👍 ❤️ etc). Non-fatal on error. */
export async function sendReaction(phoneNumberId, to, messageId, emoji) {
  try {
    await graphPost(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/^\+/, ''),
      type: 'reaction',
      reaction: { message_id: messageId, emoji },
    });
  } catch (err) {
    logger.debug({ error: err.message }, 'sendReaction failed (ignored)');
  }
}

/**
 * Download inbound media (voice notes etc). Two-step: media id → CDN URL
 * (requires auth) → bytes.
 * @returns {{ base64: string, mimeType: string }}
 */
export async function downloadMedia(mediaId) {
  const metaRes = await fetch(`${GRAPH_BASE}/${config.whatsappApiVersion}/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${config.whatsappAccessToken}` },
  });
  const meta = await metaRes.json();
  if (!metaRes.ok || !meta.url) {
    throw new Error(`Media lookup failed: ${meta?.error?.message || metaRes.status}`);
  }
  const fileRes = await fetch(meta.url, {
    headers: { 'Authorization': `Bearer ${config.whatsappAccessToken}` },
  });
  if (!fileRes.ok) throw new Error(`Media download failed: HTTP ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { base64: buffer.toString('base64'), mimeType: meta.mime_type || 'audio/ogg' };
}

/** Upload audio bytes, returns a media id usable in sendAudio. */
export async function uploadAudio(phoneNumberId, base64Audio, mimeType = 'audio/mpeg') {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([Buffer.from(base64Audio, 'base64')], { type: mimeType }),
    mimeType.includes('mpeg') ? 'voice.mp3' : 'voice.ogg');
  const res = await fetch(`${GRAPH_BASE}/${config.whatsappApiVersion}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.whatsappAccessToken}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok || !data.id) {
    throw new Error(`Media upload failed: ${data?.error?.message || res.status}`);
  }
  return data.id;
}

/** Send an uploaded audio message (renders as a playable audio/voice message). */
export async function sendAudio(phoneNumberId, to, mediaId) {
  const data = await graphPost(phoneNumberId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/^\+/, ''),
    type: 'audio',
    audio: { id: mediaId },
  });
  return data.messages?.[0]?.id || null;
}

/** Mark an inbound message read + show typing indicator (human feel). */
export async function markReadWithTyping(phoneNumberId, messageId) {
  try {
    await graphPost(phoneNumberId, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    });
  } catch (err) {
    // Non-fatal — read receipts are cosmetic
    logger.debug({ error: err.message }, 'markRead failed (ignored)');
  }
}

// ─── The 24-hour gate ──────────────────────────────────────────────

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWindowOpen(lastInboundAt) {
  if (!lastInboundAt) return false;
  return Date.now() - new Date(lastInboundAt).getTime() < WINDOW_MS;
}

/**
 * Window-aware send. Free-form if the 24h window is open; otherwise the
 * approved re-engagement template (or a clear error if none configured).
 *
 * @returns {{ providerMessageId, usedTemplate: boolean }}
 */
export async function sendSmart(phoneNumberId, to, body, lastInboundAt, templateVars = []) {
  if (isWindowOpen(lastInboundAt)) {
    const id = await sendText(phoneNumberId, to, body);
    return { providerMessageId: id, usedTemplate: false };
  }
  if (!config.whatsappFollowupTemplate) {
    throw new Error('24h window closed and no WHATSAPP_FOLLOWUP_TEMPLATE configured — cannot send');
  }
  const id = await sendTemplate(phoneNumberId, to, config.whatsappFollowupTemplate, templateVars);
  return { providerMessageId: id, usedTemplate: true };
}

/** Human-feel typing delay: ~1s per 15 chars, 1.5–8s, before sending a reply. */
export function typingDelayMs(text) {
  const ms = Math.round((text.length / 15) * 1000);
  return Math.min(Math.max(ms, 1500), 8000);
}
