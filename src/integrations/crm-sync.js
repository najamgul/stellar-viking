/**
 * CRM Sync — reusable outbound connector.
 *
 * Pushes chatbot events to any external CRM that implements the connector
 * contract: a single POST endpoint accepting
 *   { event, timestamp, source, agentId, lead, message?, alert?, transcript? }
 * authenticated with an `x-crm-key` header.
 *
 * Events: lead.upserted | message.logged | alert.callback | alert.handoff | alert.qualified
 *
 * Target resolution (so one deployment can serve many clients):
 *   1. per-agent:  agent.crmSyncUrl / agent.crmSyncKey
 *   2. global env: CRM_SYNC_URL / CRM_SYNC_KEY
 * No target configured → silently off (mirrors whatsapp.isConfigured()).
 *
 * Delivery is fire-and-forget with in-process retries (5s, 30s) — the CRM
 * endpoint is idempotent (upsert by phone, dedupe by providerMessageId), so
 * retries are always safe.
 */
import config from '../config.js';
import logger from '../utils/logger.js';

function resolveTarget(agent) {
  const url = agent?.crmSyncUrl || config.crmSync.url;
  if (!url) return null;
  return {
    url: url.replace(/\/+$/, ''),
    key: agent?.crmSyncKey || config.crmSync.key || '',
  };
}

/** Normalize a stored lead into the contract's lead payload. */
function leadPayload(lead) {
  const campaign = lead.metadata?.campaign || null;
  return {
    phone: lead.phone,
    name: lead.name || null,
    email: lead.email || null,
    status: lead.status || null,
    sentiment: lead.sentiment || null,
    source: lead.source || 'whatsapp',
    facts: lead.metadata?.facts || {},
    campaign: campaign
      ? {
          ad_id: campaign.sourceId || null,
          source_type: campaign.sourceType || null,
          headline: campaign.headline || null,
          source_url: campaign.sourceUrl || null,
          ctwa_clid: campaign.ctwaClid || null,
        }
      : null,
  };
}

/** Normalize a stored message into the contract's message payload. */
export function messagePayload(msg) {
  return {
    direction: msg.direction,
    sender: msg.sender || null,
    type: msg.type || 'text',
    body: msg.body || '',
    providerMessageId: msg.providerMessageId || null,
    sentAt: msg.createdAt || new Date().toISOString(),
  };
}

/**
 * Fire a connector event. Never throws, never blocks the caller.
 * @param {object} agent - the agent handling this conversation
 * @param {string} event - contract event name
 * @param {object} data  - { lead, message?, alert?, transcript? }
 */
export function syncToCrm(agent, event, { lead, message = null, alert = null, transcript = null }) {
  const target = resolveTarget(agent);
  if (!target || !lead?.phone) return;

  const payload = {
    event,
    timestamp: new Date().toISOString(),
    source: 'stellar-viking',
    agentId: agent?.id || null,
    lead: leadPayload(lead),
  };
  if (message) payload.message = message;
  if (alert) payload.alert = alert;
  if (transcript) {
    payload.transcript = transcript.map(m => ({
      direction: m.direction,
      sender: m.sender || null,
      body: m.body || '',
      sentAt: m.createdAt || null,
    }));
  }

  void deliver(target, payload, 0);
}

const RETRY_DELAYS_MS = [5_000, 30_000];

async function deliver(target, payload, attempt) {
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(target.key ? { 'x-crm-key': target.key } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`CRM responded ${res.status}`);
    logger.debug({ event: payload.event }, 'CRM sync delivered');
  } catch (err) {
    if (attempt < RETRY_DELAYS_MS.length) {
      setTimeout(() => deliver(target, payload, attempt + 1), RETRY_DELAYS_MS[attempt]);
    } else {
      logger.warn({ error: err.message, event: payload.event }, 'CRM sync delivery failed (gave up)');
    }
  }
}
