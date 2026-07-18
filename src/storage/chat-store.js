/**
 * Chat store — leads, conversations, messages, scheduled jobs.
 *
 * Same file-backed pattern as database.js: in-memory Maps hydrated
 * from ./data on startup, persisted on mutation.
 *
 * Lead status state machine:
 *   new → engaged → qualified → follow_up_scheduled → callback_requested
 *       → closed | not_interested
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

export const LEAD_STATUSES = [
  'new', 'engaged', 'qualified', 'follow_up_scheduled',
  'callback_requested', 'closed', 'not_interested',
];

const leads = new Map();          // leadId → lead
const conversations = new Map();  // conversationId → conversation
const messages = new Map();       // conversationId → Map<messageId, message>
const jobs = new Map();           // jobId → scheduled job

// Indexes (rebuilt on hydrate, never persisted)
const leadByAgentPhone = new Map();   // `${agentId}:${phone}` → leadId
const openConvoByLead = new Map();    // leadId → conversationId

// ─── Persistence ───────────────────────────────────────────────────

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function saveStore(name, map) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(filePath(name), JSON.stringify(Array.from(map.entries()), null, 2), 'utf-8');
  } catch (err) {
    logger.error({ error: err.message, store: name }, 'Failed to persist chat store');
  }
}

function loadStore(name) {
  try {
    const fp = filePath(name);
    if (!fs.existsSync(fp)) return new Map();
    return new Map(JSON.parse(fs.readFileSync(fp, 'utf-8')));
  } catch (err) {
    logger.error({ error: err.message, store: name }, 'Failed to load chat store');
    return new Map();
  }
}

function saveMessages() {
  const outer = [];
  for (const [convoId, inner] of messages) {
    outer.push([convoId, Array.from(inner.entries())]);
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(filePath('chat-messages'), JSON.stringify(outer, null, 2), 'utf-8');
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to persist chat messages');
  }
}

function hydrate() {
  for (const [k, v] of loadStore('leads')) leads.set(k, v);
  for (const [k, v] of loadStore('conversations')) conversations.set(k, v);
  for (const [k, v] of loadStore('scheduled-jobs')) jobs.set(k, v);

  try {
    const fp = filePath('chat-messages');
    if (fs.existsSync(fp)) {
      for (const [convoId, entries] of JSON.parse(fs.readFileSync(fp, 'utf-8'))) {
        messages.set(convoId, new Map(entries));
      }
    }
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to load chat messages');
  }

  for (const [id, lead] of leads) {
    leadByAgentPhone.set(`${lead.agentId}:${lead.phone}`, id);
  }
  for (const [id, convo] of conversations) {
    if (convo.status === 'open') openConvoByLead.set(convo.leadId, id);
  }

  logger.info({
    leads: leads.size,
    conversations: conversations.size,
    jobs: jobs.size,
  }, '💬 Chat store hydrated');
}

hydrate();

// ─── Helpers ───────────────────────────────────────────────────────

/** Normalize to bare E.164 digits with leading + (WhatsApp wa_id has no +). */
export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, '');
  return digits ? `+${digits}` : null;
}

// ─── Leads ─────────────────────────────────────────────────────────

export async function createLead(data) {
  const id = uuidv4();
  const phone = normalizePhone(data.phone);
  const lead = {
    id,
    agentId: data.agentId,
    phone,
    name: data.name || null,
    email: data.email || null,
    source: data.source || 'whatsapp',        // 'whatsapp' | 'landing_form' | 'manual'
    status: data.status || 'new',
    sentiment: data.sentiment || null,         // 'positive' | 'neutral' | 'negative'
    notes: data.notes || [],                   // [{ text, by, at }]
    optedOut: false,
    metadata: data.metadata || {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  leads.set(id, lead);
  if (phone) leadByAgentPhone.set(`${lead.agentId}:${phone}`, id);
  saveStore('leads', leads);
  logger.info({ leadId: id, agentId: lead.agentId, source: lead.source }, 'Lead created');
  return lead;
}

export async function getLead(id) {
  return leads.get(id) || null;
}

export async function getLeadByPhone(agentId, phone) {
  const id = leadByAgentPhone.get(`${agentId}:${normalizePhone(phone)}`);
  return id ? leads.get(id) || null : null;
}

export async function findOrCreateLead(agentId, phone, defaults = {}) {
  const existing = await getLeadByPhone(agentId, phone);
  if (existing) return existing;
  return createLead({ ...defaults, agentId, phone });
}

export async function updateLead(id, updates) {
  const lead = leads.get(id);
  if (!lead) return null;
  if (updates.status && !LEAD_STATUSES.includes(updates.status)) {
    delete updates.status;
  }
  const updated = { ...lead, ...updates, updatedAt: new Date().toISOString() };
  leads.set(id, updated);
  saveStore('leads', leads);
  return updated;
}

export async function addLeadNote(id, text, by = 'system') {
  const lead = leads.get(id);
  if (!lead) return null;
  lead.notes = [...(lead.notes || []), { text, by, at: new Date().toISOString() }];
  lead.updatedAt = new Date().toISOString();
  saveStore('leads', leads);
  return lead;
}

export async function listLeads(agentId, { status, limit = 200 } = {}) {
  return Array.from(leads.values())
    .filter(l => l.agentId === agentId && (!status || l.status === status))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, limit);
}

// ─── Conversations ─────────────────────────────────────────────────

export async function createConversation(data) {
  const id = uuidv4();
  const convo = {
    id,
    agentId: data.agentId,
    leadId: data.leadId,
    channel: data.channel || 'whatsapp',
    mode: 'ai',                     // 'ai' | 'human' | 'paused'
    status: 'open',                 // 'open' | 'closed'
    lastInboundAt: null,            // drives the 24h WhatsApp window
    lastMessageAt: null,
    messageCount: 0,
    summary: null,                  // rolling summary of older messages
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  conversations.set(id, convo);
  openConvoByLead.set(convo.leadId, id);
  saveStore('conversations', conversations);
  return convo;
}

export async function getConversation(id) {
  return conversations.get(id) || null;
}

export async function getOpenConversationForLead(leadId) {
  const id = openConvoByLead.get(leadId);
  const convo = id ? conversations.get(id) : null;
  return convo && convo.status === 'open' ? convo : null;
}

export async function findOrCreateConversation(agentId, leadId, channel = 'whatsapp') {
  const existing = await getOpenConversationForLead(leadId);
  if (existing) return existing;
  return createConversation({ agentId, leadId, channel });
}

export async function updateConversation(id, updates) {
  const convo = conversations.get(id);
  if (!convo) return null;
  const updated = { ...convo, ...updates, updatedAt: new Date().toISOString() };
  conversations.set(id, updated);
  if (updates.status === 'closed') openConvoByLead.delete(convo.leadId);
  saveStore('conversations', conversations);
  return updated;
}

export async function listConversations(agentId, { mode, status, limit = 100 } = {}) {
  return Array.from(conversations.values())
    .filter(c => c.agentId === agentId
      && (!mode || c.mode === mode)
      && (!status || c.status === status))
    .sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt))
    .slice(0, limit);
}

// ─── Messages ──────────────────────────────────────────────────────

export async function addMessage(data) {
  const id = uuidv4();
  const msg = {
    id,
    conversationId: data.conversationId,
    direction: data.direction,                 // 'in' | 'out'
    sender: data.sender,                       // 'lead' | 'ai' | 'bd' | 'system'
    type: data.type || 'text',                 // 'text' | 'template' | 'unsupported'
    body: data.body || '',
    providerMessageId: data.providerMessageId || null,
    deliveryStatus: data.deliveryStatus || (data.direction === 'out' ? 'queued' : 'received'),
    createdAt: new Date().toISOString(),
  };

  if (!messages.has(msg.conversationId)) messages.set(msg.conversationId, new Map());
  messages.get(msg.conversationId).set(id, msg);
  saveMessages();

  const convo = conversations.get(msg.conversationId);
  if (convo) {
    convo.messageCount = (convo.messageCount || 0) + 1;
    convo.lastMessageAt = msg.createdAt;
    if (msg.direction === 'in') convo.lastInboundAt = msg.createdAt;
    convo.updatedAt = msg.createdAt;
    saveStore('conversations', conversations);
  }
  return msg;
}

export async function listMessages(conversationId, limit = 100) {
  const inner = messages.get(conversationId);
  if (!inner) return [];
  const all = Array.from(inner.values())
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return limit ? all.slice(-limit) : all;
}

/** Deduplicate inbound webhooks: has this provider message been stored already? */
export async function hasProviderMessage(conversationId, providerMessageId) {
  const inner = messages.get(conversationId);
  if (!inner || !providerMessageId) return false;
  for (const m of inner.values()) {
    if (m.providerMessageId === providerMessageId) return true;
  }
  return false;
}

/** Update delivery status by WhatsApp message id (from status webhooks). */
export async function updateMessageStatus(providerMessageId, deliveryStatus) {
  for (const inner of messages.values()) {
    for (const m of inner.values()) {
      if (m.providerMessageId === providerMessageId) {
        m.deliveryStatus = deliveryStatus;
        saveMessages();
        return m;
      }
    }
  }
  return null;
}

// ─── Scheduled jobs ────────────────────────────────────────────────

export async function createJob(data) {
  const id = uuidv4();
  const job = {
    id,
    agentId: data.agentId,
    conversationId: data.conversationId,
    leadId: data.leadId,
    type: data.type,                   // 'followup' | 'callback_alert'
    runAt: data.runAt,                 // ISO datetime
    payload: data.payload || {},       // { context, preferredTime, reason … }
    status: 'pending',                 // 'pending' | 'done' | 'failed' | 'cancelled'
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  jobs.set(id, job);
  saveStore('scheduled-jobs', jobs);
  logger.info({ jobId: id, type: job.type, runAt: job.runAt }, 'Job scheduled');
  return job;
}

export async function listDueJobs(now = new Date()) {
  return Array.from(jobs.values())
    .filter(j => j.status === 'pending' && new Date(j.runAt) <= now)
    .sort((a, b) => new Date(a.runAt) - new Date(b.runAt));
}

export async function listJobs(agentId, { status, limit = 100 } = {}) {
  return Array.from(jobs.values())
    .filter(j => j.agentId === agentId && (!status || j.status === status))
    .sort((a, b) => new Date(a.runAt) - new Date(b.runAt))
    .slice(0, limit);
}

export async function updateJob(id, updates) {
  const job = jobs.get(id);
  if (!job) return null;
  const updated = { ...job, ...updates };
  if (['done', 'failed', 'cancelled'].includes(updates.status)) {
    updated.completedAt = new Date().toISOString();
  }
  jobs.set(id, updated);
  saveStore('scheduled-jobs', jobs);
  return updated;
}

export async function cancelPendingJobs(conversationId, type = null) {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.conversationId === conversationId && job.status === 'pending'
        && (!type || job.type === type)) {
      job.status = 'cancelled';
      job.completedAt = new Date().toISOString();
      n++;
    }
  }
  if (n > 0) saveStore('scheduled-jobs', jobs);
  return n;
}

// ─── Analytics ─────────────────────────────────────────────────────

export function getChatStats(agentId) {
  const agentLeads = Array.from(leads.values()).filter(l => l.agentId === agentId);
  const agentConvos = Array.from(conversations.values()).filter(c => c.agentId === agentId);
  const byStatus = {};
  for (const s of LEAD_STATUSES) byStatus[s] = 0;
  for (const l of agentLeads) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
  return {
    totalLeads: agentLeads.length,
    leadsByStatus: byStatus,
    openConversations: agentConvos.filter(c => c.status === 'open').length,
    humanMode: agentConvos.filter(c => c.mode === 'human').length,
    pendingCallbacks: Array.from(jobs.values())
      .filter(j => j.agentId === agentId && j.type === 'callback_alert' && j.status === 'pending').length,
  };
}
