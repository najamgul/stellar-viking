/**
 * Tool Dispatcher — routes function calls from Gemini to the correct handler.
 * 
 * Built-in tools: query_knowledge_base, log_call_summary, transfer_call, end_call
 * User-defined tools: HTTP calls to configured endpoints
 */

import logger from '../utils/logger.js';
import { decrypt } from '../utils/crypto.js';
import * as db from '../storage/database.js';
import { query as queryKnowledge } from '../knowledge/retriever.js';

/**
 * Execute a tool call from the Gemini Live API.
 * @param {string} toolName - Name of the tool to execute
 * @param {object} args - Arguments passed by the LLM
 * @param {object} session - Current call session context
 * @returns {string} - Stringified result to return to Gemini
 */
export async function executeTool(toolName, args, session) {
  const { callId, agentId, agent, log } = session;

  log.info({ tool: toolName, args }, 'Executing tool');

  try {
    switch (toolName) {
      case 'query_knowledge_base':
        return await executeKnowledgeQuery(args, session);

      case 'log_call_summary':
        return await executeLogSummary(args, session);

      case 'transfer_call':
        return await executeTransferCall(args, session);

      case 'end_call':
        return await executeEndCall(args, session);

      default:
        return await executeExternalTool(toolName, args, session);
    }
  } catch (error) {
    log.error({ tool: toolName, error: error.message }, 'Tool execution failed');
    return JSON.stringify({
      error: true,
      message: `I'm having trouble with that right now. ${error.message}`
    });
  }
}

// ─── Built-in Tool: Knowledge Base Query ───────────────────────────

async function executeKnowledgeQuery(args, session) {
  const { query } = args;
  const { agentId, log } = session;

  try {
    const results = await queryKnowledge(agentId, query, 3);

    if (results.length === 0) {
      return JSON.stringify({
        answer: 'No relevant information found in the knowledge base.',
        sources: []
      });
    }

    return JSON.stringify({
      answer: results.map(r => r.text).join('\n\n'),
      sources: results.map(r => ({
        file: r.metadata?.fileName || 'unknown',
        score: r.score?.toFixed(3),
      }))
    });
  } catch (error) {
    log.error({ error: error.message }, 'Knowledge base query failed');
    return JSON.stringify({
      answer: 'The knowledge base is temporarily unavailable.',
      sources: []
    });
  }
}

// ─── Built-in Tool: Log Call Summary ───────────────────────────────

async function executeLogSummary(args, session) {
  const { summary, callerIntent, followUpNeeded } = args;
  const { callId, log } = session;

  await db.updateCall(callId, {
    summary,
    metadata: {
      ...((await db.getCall(callId))?.metadata || {}),
      callerIntent: callerIntent || 'unknown',
      followUpNeeded: followUpNeeded || false,
    }
  });

  log.info({ summary }, 'Call summary logged');

  return JSON.stringify({ success: true, message: 'Summary saved.' });
}

// ─── Built-in Tool: Transfer Call ──────────────────────────────────

async function executeTransferCall(args, session) {
  const { reason } = args;
  const { callId, agent, log, onTransfer } = session;

  if (!agent.transferNumber) {
    return JSON.stringify({
      error: true,
      message: 'No transfer number is configured for this agent.'
    });
  }

  log.info({ reason, transferTo: agent.transferNumber }, 'Transferring call');

  await db.updateCall(callId, { status: 'transferred' });

  // Signal the session manager to execute the Twilio transfer
  if (onTransfer) {
    onTransfer(agent.transferNumber, reason);
  }

  return JSON.stringify({
    success: true,
    message: `Transferring to ${agent.transferNumber}.`
  });
}

// ─── Built-in Tool: End Call ───────────────────────────────────────

async function executeEndCall(args, session) {
  const { reason } = args;
  const { callId, log, onEndCall } = session;

  log.info({ reason }, 'Ending call');

  await db.updateCall(callId, {
    status: 'completed',
    endedAt: new Date().toISOString(),
  });

  if (onEndCall) {
    onEndCall(reason);
  }

  return JSON.stringify({ success: true, message: 'Call ending.' });
}

// ─── User-Defined External Tools ───────────────────────────────────

async function executeExternalTool(toolName, args, session) {
  const { agentId, log } = session;

  // Find the tool config
  const agentTools = await db.listTools(agentId);
  const toolConfig = agentTools.find(t => t.name === toolName);

  if (!toolConfig) {
    log.warn({ tool: toolName }, 'Unknown tool');
    return JSON.stringify({ error: true, message: `Unknown tool: ${toolName}` });
  }

  // Build URL (supports template variables like {{orderId}})
  let url = toolConfig.endpointUrl;
  for (const [key, val] of Object.entries(args)) {
    url = url.replace(`{{${key}}}`, encodeURIComponent(String(val)));
  }

  // Build headers with auth
  const headers = {
    'Content-Type': 'application/json',
    ...toolConfig.headers,
  };

  if (toolConfig.authType === 'bearer' && toolConfig.authValue) {
    try {
      headers['Authorization'] = `Bearer ${decrypt(toolConfig.authValue)}`;
    } catch {
      headers['Authorization'] = `Bearer ${toolConfig.authValue}`;
    }
  } else if (toolConfig.authType === 'api_key' && toolConfig.authValue) {
    try {
      headers['X-API-Key'] = decrypt(toolConfig.authValue);
    } catch {
      headers['X-API-Key'] = toolConfig.authValue;
    }
  }

  // Execute with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), toolConfig.timeout || 5000);

  try {
    log.info({ tool: toolName, url, method: toolConfig.httpMethod }, 'Calling external tool API');

    const fetchOptions = {
      method: toolConfig.httpMethod || 'POST',
      headers,
      signal: controller.signal,
    };

    if (toolConfig.httpMethod !== 'GET') {
      fetchOptions.body = JSON.stringify(args);
    }

    const response = await fetch(url, fetchOptions);

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Track tool usage
    const call = await db.getCall(session.callId);
    if (call) {
      const toolsUsed = new Set(call.toolsUsed || []);
      toolsUsed.add(toolName);
      await db.updateCall(session.callId, { toolsUsed: Array.from(toolsUsed) });
    }

    log.info({ tool: toolName, status: response.status }, 'External tool succeeded');
    return JSON.stringify(data);

  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      throw new Error(`Tool "${toolName}" timed out after ${toolConfig.timeout || 5000}ms`);
    }
    throw error;
  }
}
