/**
 * REST API Routes — Agent CRUD, Knowledge, Tools, Calls
 * 
 * All routes are prefixed with /api
 */

import * as db from '../storage/database.js';
import logger from '../utils/logger.js';
import { encrypt } from '../utils/crypto.js';
import { getActiveSessionCount } from '../engine/session-manager.js';
import { indexDocument, removeDocument, getKnowledgeStats, query as kbQuery } from '../knowledge/retriever.js';
import { generateCallSummary } from '../engine/call-summary.js';
import { TOOL_TEMPLATES, getTemplatesByCategory } from './tool-templates.js';
import { generateApiKey, listApiKeys, revokeApiKey } from './api-keys.js';

/**
 * Register all API routes.
 * @param {import('fastify').FastifyInstance} app 
 */
export function registerApiRoutes(app) {

  // ─── Health & Status ─────────────────────────────────────────────

  app.get('/api/status', async () => ({
    status: 'ok',
    activeCalls: getActiveSessionCount(),
    timestamp: new Date().toISOString(),
  }));

  // ─── Agents ──────────────────────────────────────────────────────

  app.get('/api/agents', async () => {
    const agents = await db.listAgents();
    return { agents };
  });

  app.post('/api/agents', async (request, reply) => {
    const agent = await db.createAgent(request.body);
    reply.code(201);
    return { agent };
  });

  app.get('/api/agents/:id', async (request, reply) => {
    const agent = await db.getAgent(request.params.id);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return { agent };
  });

  app.put('/api/agents/:id', async (request, reply) => {
    const agent = await db.updateAgent(request.params.id, request.body);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return { agent };
  });

  app.delete('/api/agents/:id', async (request, reply) => {
    await db.deleteAgent(request.params.id);
    return { success: true };
  });

  // ─── Knowledge Base (per agent) ──────────────────────────────────

  app.get('/api/agents/:id/knowledge', async (request) => {
    const documents = await db.listDocuments(request.params.id);
    return { documents };
  });

  app.post('/api/agents/:id/knowledge', async (request, reply) => {
    const { fileName, fileType, content } = request.body;

    if (!content || content.trim().length === 0) {
      return reply.code(400).send({ error: 'Content is required' });
    }

    // Save document record
    const doc = await db.addDocument(request.params.id, {
      fileName,
      fileType: fileType || 'txt',
    });

    // Index the document: chunk → embed → store
    try {
      await indexDocument(request.params.id, doc.id, content, fileName);
    } catch (err) {
      logger.error({ error: err.message, docId: doc.id }, 'Indexing failed');
      return reply.code(500).send({ error: 'Failed to index document', details: err.message });
    }

    const updatedDoc = await db.updateDocument(request.params.id, doc.id, { status: 'ready' });
    reply.code(201);
    return { document: updatedDoc || doc };
  });

  app.delete('/api/agents/:id/knowledge/:docId', async (request, reply) => {
    try {
      removeDocument(request.params.id, request.params.docId);
    } catch (err) {
      // Vector/keyword store may not have this doc — that's OK
      logger.warn({ error: err.message, docId: request.params.docId }, 'removeDocument cleanup warning');
    }
    await db.deleteDocument(request.params.id, request.params.docId);
    return { success: true };
  });

  app.get('/api/agents/:id/knowledge/stats', async (request) => {
    const stats = getKnowledgeStats(request.params.id);
    return { stats };
  });

  // ─── Tools (per agent) ──────────────────────────────────────────

  app.get('/api/agents/:id/tools', async (request) => {
    const tools = await db.listTools(request.params.id);
    // Don't expose encrypted auth values
    const sanitized = tools.map(t => ({ ...t, authValue: t.authValue ? '***' : null }));
    return { tools: sanitized };
  });

  app.post('/api/agents/:id/tools', async (request, reply) => {
    const data = { ...request.body };

    // Encrypt auth credentials if provided
    if (data.authValue && data.authType !== 'none') {
      try {
        data.authValue = encrypt(data.authValue);
      } catch (err) {
        logger.warn('Encryption not configured — storing auth value in plaintext');
      }
    }

    const tool = await db.addTool(request.params.id, data);
    reply.code(201);
    return { tool: { ...tool, authValue: tool.authValue ? '***' : null } };
  });

  app.put('/api/agents/:id/tools/:toolId', async (request) => {
    const data = { ...request.body };

    if (data.authValue && data.authType !== 'none') {
      try {
        data.authValue = encrypt(data.authValue);
      } catch {
        // Store as-is if encryption not configured
      }
    }

    const tool = await db.updateTool(request.params.id, request.params.toolId, data);
    return { tool: { ...tool, authValue: '***' } };
  });

  app.delete('/api/agents/:id/tools/:toolId', async (request) => {
    await db.deleteTool(request.params.id, request.params.toolId);
    return { success: true };
  });

  // ─── Call Logs (per agent) ───────────────────────────────────────

  app.get('/api/agents/:id/calls', async (request) => {
    const limit = parseInt(request.query.limit || '50', 10);
    const calls = await db.listCalls(request.params.id, limit);
    return { calls };
  });

  app.get('/api/calls/:callId', async (request, reply) => {
    const call = await db.getCall(request.params.callId);
    if (!call) return reply.code(404).send({ error: 'Call not found' });
    return { call };
  });

  // ─── Agent Clone ────────────────────────────────────────────────

  app.post('/api/agents/:id/clone', async (request, reply) => {
    const source = await db.getAgent(request.params.id);
    if (!source) return reply.code(404).send({ error: 'Agent not found' });

    const clone = await db.createAgent({
      name: `${source.name} (Copy)`,
      companyName: source.companyName,
      role: source.role,
      personality: source.personality,
      systemPrompt: source.systemPrompt,
      voice: source.voice,
      language: source.language,
      greeting: source.greeting,
      guardrails: source.guardrails,
      transferNumber: source.transferNumber,
      consentMessage: source.consentMessage,
      phoneNumber: null,  // Don't duplicate phone
      webhookUrl: source.webhookUrl,
      status: 'draft',
    });

    reply.code(201);
    return { agent: clone, message: 'Agent cloned successfully' };
  });

  // ─── KB Test Query ──────────────────────────────────────────────

  app.post('/api/agents/:id/knowledge/query', async (request, reply) => {
    const { question, topK } = request.body;
    if (!question) return reply.code(400).send({ error: 'Question is required' });

    const results = await kbQuery(request.params.id, question, topK || 3);
    return {
      question,
      results: results.map(r => ({
        text: r.text,
        score: parseFloat(r.score.toFixed(4)),
        vectorScore: r.vectorScore ? parseFloat(r.vectorScore.toFixed(4)) : undefined,
        keywordScore: r.keywordScore ? parseFloat(r.keywordScore.toFixed(4)) : undefined,
        source: r.metadata?.fileName || 'unknown',
      })),
    };
  });

  // ─── Call Summary (regenerate) ─────────────────────────────────

  app.post('/api/calls/:callId/summarize', async (request, reply) => {
    const call = await db.getCall(request.params.callId);
    if (!call) return reply.code(404).send({ error: 'Call not found' });

    const summary = await generateCallSummary(request.params.callId);
    return { summary };
  });

  // ─── Export Calls ──────────────────────────────────────────────

  app.get('/api/agents/:id/calls/export', async (request, reply) => {
    const format = request.query.format || 'json';
    const calls = await db.listCalls(request.params.id, 500);
    const agent = await db.getAgent(request.params.id);

    if (format === 'csv') {
      const header = 'Call ID,Caller,Direction,Status,Duration,Started At,Topic,Sentiment\n';
      const rows = calls.map(c => {
        const s = c.summary || {};
        return [
          c.id,
          c.callerNumber,
          c.direction,
          c.status,
          c.duration || '',
          c.startedAt,
          (s.topic || '').replace(/,/g, ';'),
          s.sentiment || '',
        ].join(',');
      }).join('\n');

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="${agent?.name || 'calls'}-export.csv"`);
      return header + rows;
    }

    // Default: JSON
    return {
      agent: agent ? { id: agent.id, name: agent.name } : null,
      exportedAt: new Date().toISOString(),
      totalCalls: calls.length,
      calls: calls.map(c => ({
        id: c.id,
        callerNumber: c.callerNumber,
        direction: c.direction,
        status: c.status,
        duration: c.duration,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        summary: c.summary || null,
        transcript: c.transcript || '',
        toolsUsed: c.toolsUsed,
      })),
    };
  });

  // ─── Tool Templates ────────────────────────────────────────────

  app.get('/api/tool-templates', async () => {
    return {
      templates: TOOL_TEMPLATES.map(t => ({
        id: t.id,
        name: t.name,
        category: t.category,
        icon: t.icon,
        label: t.label,
        description: t.description,
        suggestedPrompt: t.suggestedPrompt,
        defaultConfig: t.defaultConfig,
        examples: t.examples,
      })),
      categories: getTemplatesByCategory(),
    };
  });

  // Install a template as a tool for an agent
  app.post('/api/agents/:id/tools/from-template', async (request, reply) => {
    const { templateId, endpointUrl, authType, authValue } = request.body;

    const template = TOOL_TEMPLATES.find(t => t.id === templateId);
    if (!template) return reply.code(400).send({ error: 'Unknown template' });

    const data = {
      name: template.name,
      description: template.description,
      endpointUrl: endpointUrl || template.defaultConfig.endpointUrl,
      httpMethod: template.defaultConfig.httpMethod,
      authType: authType || template.defaultConfig.authType,
      parameters: template.defaultConfig.parameters,
    };

    if (authValue && data.authType !== 'none') {
      try { data.authValue = encrypt(authValue); } catch { data.authValue = authValue; }
    }

    const tool = await db.addTool(request.params.id, data);
    reply.code(201);
    return { tool: { ...tool, authValue: '***' }, message: `${template.label} tool installed` };
  });

  // ─── API Keys ──────────────────────────────────────────────────

  app.get('/api/keys', async () => {
    return { keys: listApiKeys() };
  });

  app.post('/api/keys', async (request, reply) => {
    const { name, scopes } = request.body;
    if (!name) return reply.code(400).send({ error: 'Name is required' });

    const key = generateApiKey(name, scopes || ['all']);
    reply.code(201);
    return {
      key: key.key,  // Full key — shown only once
      id: key.id,
      name: key.name,
      scopes: key.scopes,
      message: '⚠️ Save this key now — it won\'t be shown again.',
    };
  });

  app.delete('/api/keys/:id', async (request) => {
    const revoked = revokeApiKey(request.params.id);
    return { success: revoked };
  });
}
