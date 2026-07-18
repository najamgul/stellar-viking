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
 * Delivery is fire-and-forget with in-process retries (5s, 30s). If those
 * fail, the event is persisted as a durable `crm_sync` job (survives
 * restarts) and retried by the job runner for up to ~2 days — so a CRM
 * outage or misconfiguration delays sync instead of losing data. The CRM
 * endpoint is idempotent (upsert by phone, dedupe by providerMessageId),
 * so retries and out-of-order delivery are always safe.
 */
import config from '../config.js';
import logger from '../utils/logger.js';
import * as chatStore from '../storage/chat-store.js';

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
export function syncToCrm(agent, event, { lead, message = null, alert = null, transcript = null, followupAt = null }) {
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
  if (followupAt) payload.followupAt = followupAt;
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
const MAX_QUEUED_ATTEMPTS = 60;                 // durable retries: ~2 days of coverage

/** Minutes to wait before queued attempt N (5, 10, … capped at 60). */
function queueDelayMs(attempts) {
  return Math.min(5 * (attempts + 1), 60) * 60 * 1000;
}

async function postToCrm(url, key, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'x-crm-key': key } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`CRM responded ${res.status}`);
}

async function deliver(target, payload, attempt) {
  try {
    await postToCrm(target.url, target.key, payload);
    logger.debug({ event: payload.event }, 'CRM sync delivered');
  } catch (err) {
    if (attempt < RETRY_DELAYS_MS.length) {
      setTimeout(() => deliver(target, payload, attempt + 1), RETRY_DELAYS_MS[attempt]);
      return;
    }
    // Quick retries exhausted → persist for durable retry by the job runner.
    // conversationId stays null so opt-out job cancellation never touches these.
    logger.warn({ error: err.message, event: payload.event }, 'CRM sync failed — queued for durable retry');
    try {
      await chatStore.createJob({
        agentId: payload.agentId || null,
        conversationId: null,
        leadId: null,
        type: 'crm_sync',
        runAt: new Date(Date.now() + queueDelayMs(0)).toISOString(),
        payload: { url: target.url, key: target.key, body: payload, attempts: 0 },
      });
    } catch (queueErr) {
      logger.error({ error: queueErr.message, event: payload.event }, 'CRM sync: could not queue durable retry');
    }
  }
}

/** Called by the job runner for due `crm_sync` jobs. */
export async function retryCrmSyncJob(job) {
  const { url, key, body, attempts = 0 } = job.payload || {};
  if (!url || !body) {
    await chatStore.updateJob(job.id, { status: 'failed', payload: { ...job.payload, lastError: 'malformed job' } });
    return;
  }
  try {
    await postToCrm(url, key, body);
    await chatStore.updateJob(job.id, { status: 'done' });
    logger.info({ event: body.event }, '✅ CRM sync delivered from retry queue');
  } catch (err) {
    const next = attempts + 1;
    if (next >= MAX_QUEUED_ATTEMPTS) {
      await chatStore.updateJob(job.id, {
        status: 'failed',
        payload: { ...job.payload, attempts: next, lastError: err.message },
      });
      logger.error({ error: err.message, event: body.event }, 'CRM sync permanently failed after durable retries');
    } else {
      await chatStore.updateJob(job.id, {
        status: 'pending',
        runAt: new Date(Date.now() + queueDelayMs(next)).toISOString(),
        payload: { ...job.payload, attempts: next, lastError: err.message },
      });
    }
  }
}
