/**
 * AI Call Summary Generator
 * 
 * Uses Gemini to auto-generate structured call summaries
 * after each call ends. Extracts:
 * - Topic/purpose
 * - Sentiment
 * - Action items
 * - Resolution status
 * - Key details
 */

import { GoogleGenAI } from '@google/genai';
import config from '../config.js';
import logger from '../utils/logger.js';
import * as db from '../storage/database.js';

let genAI;

function getClient() {
  if (!genAI) {
    genAI = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return genAI;
}

const SUMMARY_PROMPT = `You are a call analysis AI. Analyze the following phone call transcript and produce a structured summary.

Return a JSON object with these fields:
- "topic": A one-line summary of what the call was about
- "sentiment": One of: "positive", "neutral", "negative", "mixed"
- "resolution": One of: "resolved", "escalated", "pending", "dropped"
- "actionItems": Array of specific follow-up actions (empty array if none)
- "keyDetails": Object with important extracted details like names, dates, amounts, account numbers
- "durationAssessment": Brief note on call efficiency ("efficient", "lengthy", "too short")

TRANSCRIPT:
---
{TRANSCRIPT}
---

AGENT NAME: {AGENT_NAME}
CALLER: {CALLER}

Respond with ONLY the JSON object, no markdown formatting.`;

/**
 * Generate an AI summary for a completed call.
 * @param {string} callId
 */
export async function generateCallSummary(callId) {
  try {
    const call = await db.getCall(callId);
    if (!call || !call.transcript || call.transcript.trim().length < 20) {
      logger.debug({ callId }, 'Skipping summary — transcript too short');
      return null;
    }

    const agent = await db.getAgent(call.agentId);
    const agentName = agent?.name || 'AI Agent';

    const prompt = SUMMARY_PROMPT
      .replace('{TRANSCRIPT}', call.transcript)
      .replace('{AGENT_NAME}', agentName)
      .replace('{CALLER}', call.callerNumber);

    const client = getClient();
    const response = await client.models.generateContent({
      model: config.chatModel,
      contents: prompt,
    });

    const text = response.text.trim();

    // Parse JSON from response (handle potential markdown wrapping)
    let summary;
    try {
      const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      summary = JSON.parse(jsonStr);
    } catch {
      // If parsing fails, create a basic summary
      summary = {
        topic: text.slice(0, 200),
        sentiment: 'neutral',
        resolution: 'pending',
        actionItems: [],
        keyDetails: {},
        durationAssessment: 'unknown',
      };
    }

    // Save summary to call record
    await db.updateCall(callId, { summary });

    // Cross-channel memory: write the call outcome onto the chat lead so
    // the WhatsApp agent knows about the phone conversation.
    try {
      const chatStore = await import('../storage/chat-store.js');
      const lead = await chatStore.getLeadByPhone(call.agentId, call.callerNumber);
      if (lead) {
        await chatStore.addLeadNote(lead.id,
          `Voice call: ${summary.topic}${summary.resolution ? ` (${summary.resolution})` : ''}`, 'system');
        if (['positive', 'neutral', 'negative'].includes(summary.sentiment)) {
          await chatStore.updateLead(lead.id, { sentiment: summary.sentiment });
        }
      }
    } catch (err) {
      logger.warn({ error: err.message }, 'Could not sync call summary to lead');
    }

    logger.info({ callId, topic: summary.topic, sentiment: summary.sentiment }, '📋 Call summary generated');
    return summary;

  } catch (error) {
    logger.error({ callId, error: error.message }, 'Failed to generate call summary');
    return null;
  }
}
