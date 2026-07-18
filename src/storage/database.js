/**
 * File-based persistent database.
 * 
 * Stores agents, knowledge docs, tools, and call logs as JSON files
 * in the ./data directory. Loads on startup, auto-saves on mutations.
 * 
 * The interface is identical to the in-memory version — all methods async.
 * Drop-in replacement with zero API changes.
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

// ─── In-memory stores (hydrated from disk on init) ─────────────────

const agents = new Map();
const documents = new Map();       // agentId → Map<docId, doc>
const tools = new Map();            // agentId → Map<toolId, tool>
const calls = new Map();            // callId → call log
const phoneToAgent = new Map();     // phoneNumber → agentId
const waToAgent = new Map();        // WhatsApp phone_number_id → agentId

// ─── Persistence Helpers ───────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    logger.info({ path: DATA_DIR }, '📁 Created data directory');
  }
}

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function saveStore(name, map) {
  try {
    const data = JSON.stringify(Array.from(map.entries()), null, 2);
    fs.writeFileSync(filePath(name), data, 'utf-8');
  } catch (err) {
    logger.error({ error: err.message, store: name }, 'Failed to persist store');
  }
}

function loadStore(name) {
  try {
    const fp = filePath(name);
    if (!fs.existsSync(fp)) return new Map();
    const raw = fs.readFileSync(fp, 'utf-8');
    return new Map(JSON.parse(raw));
  } catch (err) {
    logger.error({ error: err.message, store: name }, 'Failed to load store');
    return new Map();
  }
}

// Nested map: agentId → Map<itemId, item>
function saveNestedStore(name, map) {
  try {
    const outer = [];
    for (const [agentId, innerMap] of map) {
      outer.push([agentId, Array.from(innerMap.entries())]);
    }
    fs.writeFileSync(filePath(name), JSON.stringify(outer, null, 2), 'utf-8');
  } catch (err) {
    logger.error({ error: err.message, store: name }, 'Failed to persist nested store');
  }
}

function loadNestedStore(name) {
  try {
    const fp = filePath(name);
    if (!fs.existsSync(fp)) return new Map();
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const outer = new Map();
    for (const [agentId, innerEntries] of raw) {
      outer.set(agentId, new Map(innerEntries));
    }
    return outer;
  } catch (err) {
    logger.error({ error: err.message, store: name }, 'Failed to load nested store');
    return new Map();
  }
}

// ─── Init: Load from disk ──────────────────────────────────────────

function hydrate() {
  ensureDataDir();

  const loadedAgents = loadStore('agents');
  const loadedDocs = loadNestedStore('documents');
  const loadedTools = loadNestedStore('tools');
  const loadedCalls = loadStore('calls');

  for (const [k, v] of loadedAgents) agents.set(k, v);
  for (const [k, v] of loadedDocs) documents.set(k, v);
  for (const [k, v] of loadedTools) tools.set(k, v);
  for (const [k, v] of loadedCalls) calls.set(k, v);

  // Rebuild phone → agent indexes
  for (const [id, agent] of agents) {
    if (agent.phoneNumber) {
      phoneToAgent.set(agent.phoneNumber, id);
    }
    if (agent.whatsappPhoneNumberId) {
      waToAgent.set(agent.whatsappPhoneNumberId, id);
    }
  }

  logger.info({
    agents: agents.size,
    documents: Array.from(documents.values()).reduce((s, m) => s + m.size, 0),
    tools: Array.from(tools.values()).reduce((s, m) => s + m.size, 0),
    calls: calls.size,
  }, '💾 Database hydrated from disk');
}

// Run on import
hydrate();

// ─── Agent CRUD ────────────────────────────────────────────────────

export async function createAgent(data) {
  const id = uuidv4();
  const agent = {
    id,
    name: data.name || 'Agent',
    companyName: data.companyName || '',
    role: data.role || 'AI Assistant',
    personality: data.personality || 'Professional, helpful, and concise.',
    systemPrompt: data.systemPrompt || '',
    voice: data.voice || 'Kore',
    language: data.language || 'en',
    conversationStyle: data.conversationStyle || 'natural',
    exampleDialogue: data.exampleDialogue || null,   // few-shot style sample for both channels
    greeting: data.greeting || `Hi, thanks for calling! How can I help you today?`,
    guardrails: data.guardrails || [],
    transferNumber: data.transferNumber || null,
    consentMessage: data.consentMessage || 'This call may be recorded for quality purposes.',
    phoneNumber: data.phoneNumber || null,
    whatsappPhoneNumberId: data.whatsappPhoneNumberId || null,  // Meta Cloud API phone_number_id
    whatsappNumber: data.whatsappNumber || null,                // display number for wa.me links
    webhookUrl: data.webhookUrl || null,
    crmSyncUrl: data.crmSyncUrl || null,    // per-agent CRM connector target (overrides CRM_SYNC_URL)
    crmSyncKey: data.crmSyncKey || null,    // per-agent CRM connector key (overrides CRM_SYNC_KEY)
    status: data.status || 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  agents.set(id, agent);
  if (agent.phoneNumber) {
    phoneToAgent.set(agent.phoneNumber, id);
  }
  if (agent.whatsappPhoneNumberId) {
    waToAgent.set(agent.whatsappPhoneNumberId, id);
  }

  saveStore('agents', agents);
  logger.info({ agentId: id, name: agent.name }, 'Agent created');
  return agent;
}

export async function getAgent(id) {
  return agents.get(id) || null;
}

export async function getAgentByPhone(phoneNumber) {
  const normalized = phoneNumber.replace(/\s/g, '');
  const agentId = phoneToAgent.get(normalized);
  if (!agentId) return null;
  return agents.get(agentId) || null;
}

export async function getAgentByWhatsappId(phoneNumberId) {
  const agentId = waToAgent.get(phoneNumberId);
  if (!agentId) return null;
  return agents.get(agentId) || null;
}

export async function updateAgent(id, updates) {
  const agent = agents.get(id);
  if (!agent) return null;

  if ('phoneNumber' in updates && updates.phoneNumber !== agent.phoneNumber) {
    if (agent.phoneNumber) phoneToAgent.delete(agent.phoneNumber);
    if (updates.phoneNumber) phoneToAgent.set(updates.phoneNumber, id);
  }
  if ('whatsappPhoneNumberId' in updates && updates.whatsappPhoneNumberId !== agent.whatsappPhoneNumberId) {
    if (agent.whatsappPhoneNumberId) waToAgent.delete(agent.whatsappPhoneNumberId);
    if (updates.whatsappPhoneNumberId) waToAgent.set(updates.whatsappPhoneNumberId, id);
  }

  const updated = { ...agent, ...updates, updatedAt: new Date().toISOString() };
  agents.set(id, updated);
  saveStore('agents', agents);
  return updated;
}

export async function deleteAgent(id) {
  const agent = agents.get(id);
  if (agent?.phoneNumber) phoneToAgent.delete(agent.phoneNumber);
  if (agent?.whatsappPhoneNumberId) waToAgent.delete(agent.whatsappPhoneNumberId);
  agents.delete(id);
  documents.delete(id);
  tools.delete(id);
  saveStore('agents', agents);
  saveNestedStore('documents', documents);
  saveNestedStore('tools', tools);
  return true;
}

export async function listAgents() {
  return Array.from(agents.values());
}

// ─── Knowledge Documents ──────────────────────────────────────────

export async function addDocument(agentId, data) {
  const id = uuidv4();
  const doc = {
    id,
    agentId,
    fileName: data.fileName,
    fileType: data.fileType || 'txt',
    chunkCount: data.chunkCount || 0,
    status: data.status || 'indexing',
    createdAt: new Date().toISOString(),
  };

  if (!documents.has(agentId)) documents.set(agentId, new Map());
  documents.get(agentId).set(id, doc);
  saveNestedStore('documents', documents);
  return doc;
}

export async function listDocuments(agentId) {
  const agentDocs = documents.get(agentId);
  return agentDocs ? Array.from(agentDocs.values()) : [];
}

export async function updateDocument(agentId, docId, updates) {
  const agentDocs = documents.get(agentId);
  if (!agentDocs) return null;
  const doc = agentDocs.get(docId);
  if (!doc) return null;
  const updated = { ...doc, ...updates };
  agentDocs.set(docId, updated);
  saveNestedStore('documents', documents);
  return updated;
}

export async function deleteDocument(agentId, docId) {
  const agentDocs = documents.get(agentId);
  if (agentDocs) agentDocs.delete(docId);
  saveNestedStore('documents', documents);
  return true;
}

// ─── Tools ─────────────────────────────────────────────────────────

export async function addTool(agentId, data) {
  const id = uuidv4();
  const tool = {
    id,
    agentId,
    name: data.name,
    description: data.description || '',
    parameters: data.parameters || { type: 'object', properties: {} },
    endpointUrl: data.endpointUrl,
    httpMethod: data.httpMethod || 'POST',
    authType: data.authType || 'none',
    authValue: data.authValue || null,
    headers: data.headers || {},
    timeout: data.timeout || 5000,
    isBuiltIn: data.isBuiltIn || false,
    createdAt: new Date().toISOString(),
  };

  if (!tools.has(agentId)) tools.set(agentId, new Map());
  tools.get(agentId).set(id, tool);
  saveNestedStore('tools', tools);
  return tool;
}

export async function listTools(agentId) {
  const agentTools = tools.get(agentId);
  return agentTools ? Array.from(agentTools.values()) : [];
}

export async function updateTool(agentId, toolId, updates) {
  const agentTools = tools.get(agentId);
  if (!agentTools) return null;
  const tool = agentTools.get(toolId);
  if (!tool) return null;
  const updated = { ...tool, ...updates };
  agentTools.set(toolId, updated);
  saveNestedStore('tools', tools);
  return updated;
}

export async function deleteTool(agentId, toolId) {
  const agentTools = tools.get(agentId);
  if (agentTools) agentTools.delete(toolId);
  saveNestedStore('tools', tools);
  return true;
}

// ─── Call Logs ─────────────────────────────────────────────────────

export async function createCall(data) {
  const id = data.id || uuidv4();
  const call = {
    id,
    agentId: data.agentId,
    callerNumber: data.callerNumber || 'unknown',
    direction: data.direction || 'inbound',
    status: data.status || 'ringing',
    startedAt: new Date().toISOString(),
    endedAt: null,
    duration: null,
    recordingUrl: null,
    transcript: '',
    summary: null,
    toolsUsed: [],
    metadata: data.metadata || {},
  };

  calls.set(id, call);
  saveStore('calls', calls);
  return call;
}

export async function updateCall(callId, updates) {
  const call = calls.get(callId);
  if (!call) return null;
  const updated = { ...call, ...updates };
  calls.set(callId, updated);
  saveStore('calls', calls);
  return updated;
}

export async function getCall(callId) {
  return calls.get(callId) || null;
}

export async function listCalls(agentId, limit = 50) {
  return Array.from(calls.values())
    .filter(c => c.agentId === agentId)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, limit);
}
