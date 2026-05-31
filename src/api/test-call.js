/**
 * Browser Test WebSocket — lets you test the voice agent from a browser
 * WITHOUT Twilio. Connects browser microphone directly to the configured
 * AI provider (Gemini Live, Inworld, or Pipeline).
 * 
 * The browser sends:   { type: "audio", data: "base64 PCM 16kHz" }
 * The server resends:  { type: "audio", data: "base64 PCM 24kHz" }  (from AI)
 *                      { type: "transcript", role: "user"|"agent", text: "..." }
 * 
 * NOTE: For Inworld/Pipeline provider, the browser audio (16kHz) is
 * resampled to 24kHz before forwarding, since Inworld S2S expects 24kHz.
 */

import { v4 as uuidv4 } from 'uuid';
import { createCallLogger } from '../utils/logger.js';
import { GeminiLiveSession } from '../engine/realtime-session.js';
import { InworldLiveSession } from '../engine/inworld-session.js';
import { PipelineLiveSession } from '../engine/pipeline-session.js';
import { buildSystemPrompt, buildToolDefinitions } from '../engine/prompt-builder.js';
import { executeTool } from '../engine/tool-dispatcher.js';
import * as db from '../storage/database.js';
import logger from '../utils/logger.js';

const AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase();

/**
 * Resample PCM 16kHz → 24kHz (simple linear interpolation).
 * Both input and output are base64-encoded PCM16 LE.
 */
function resample16kTo24k(base64Pcm16k) {
  const inputBuf = Buffer.from(base64Pcm16k, 'base64');
  const inputSamples = inputBuf.length / 2;
  const outputSamples = Math.floor(inputSamples * 1.5); // 24000/16000 = 1.5
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = (i * 16000) / 24000;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    const s0 = srcIdx < inputSamples ? inputBuf.readInt16LE(srcIdx * 2) : 0;
    const s1 = (srcIdx + 1) < inputSamples ? inputBuf.readInt16LE((srcIdx + 1) * 2) : s0;

    const interpolated = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
  }

  return output.toString('base64');
}

/**
 * Register the browser test WebSocket route.
 * @param {import('fastify').FastifyInstance} app 
 */
export function registerTestCall(app) {
  app.register(async function (fastify) {
    fastify.get('/test-call', { websocket: true }, async (socket, req) => {
      const agentId = req.query.agentId;

      if (!agentId) {
        socket.send(JSON.stringify({ type: 'error', message: 'Missing agentId query param' }));
        socket.close();
        return;
      }

      const agent = await db.getAgent(agentId);
      if (!agent) {
        socket.send(JSON.stringify({ type: 'error', message: `Agent ${agentId} not found` }));
        socket.close();
        return;
      }

      const callId = uuidv4();
      const log = createCallLogger(callId, agentId);

      // Determine whether this provider needs 24kHz input
      const needs24k = (AI_PROVIDER === 'inworld' || AI_PROVIDER === 'pipeline');

      log.info({ agent: agent.name, provider: AI_PROVIDER }, '🧪 Browser test call started');

      // Create call record
      await db.createCall({
        id: callId,
        agentId: agent.id,
        callerNumber: 'browser-test',
        direction: 'inbound',
        status: 'active',
      });

      // Load tools & build prompt
      const agentTools = await db.listTools(agentId);
      const systemPrompt = buildSystemPrompt(agent, agentTools);
      const toolDefinitions = buildToolDefinitions(agent, agentTools);

      // Tool execution context
      const toolContext = {
        callId,
        agentId: agent.id,
        agent,
        log,
        retriever: null,
        onTransfer: () => log.info('Transfer requested (no-op in test mode)'),
        onEndCall: (reason) => {
          log.info({ reason }, 'Agent ended call');
          socket.send(JSON.stringify({ type: 'transcript', role: 'system', text: `Agent ended call: ${reason}` }));
          socket.close();
        },
      };

      // Select AI session class based on AI_PROVIDER
      const providerMap = {
        'inworld': InworldLiveSession,
        'pipeline': PipelineLiveSession,
      };
      const SessionClass = providerMap[AI_PROVIDER] || GeminiLiveSession;
      let aiSession = null;

      try {
        // Connect to AI provider
        aiSession = new SessionClass({
          systemPrompt,
          tools: toolDefinitions,
          voice: agent.voice || 'Kore',
          language: agent.language || 'en',
          temperature: agent.temperature || 0.8,
          speechSpeed: agent.speechSpeed || 1.0,
          log,

          // Audio from agent → browser
          onAudioData: (base64Pcm24k) => {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: 'audio', data: base64Pcm24k }));
            }
          },

          // Function calls
          onFunctionCall: async (functionCalls) => {
            const responses = [];
            for (const fc of functionCalls) {
              try {
                const result = await executeTool(fc.name, fc.args || {}, toolContext);
                responses.push({
                  id: fc.id,
                  name: fc.name,
                  response: { result: JSON.parse(result) },
                });
              } catch (error) {
                log.error({ tool: fc.name, error: error.message }, 'Tool error');
                responses.push({
                  id: fc.id,
                  name: fc.name,
                  response: { result: { error: true, message: error.message } },
                });
              }
            }
            aiSession.sendToolResponse(responses);
          },

          // User transcript
          onTranscript: (text) => {
            if (text.trim() && socket.readyState === 1) {
              socket.send(JSON.stringify({ type: 'transcript', role: 'user', text }));
            }
          },

          // Agent transcript
          onAgentTranscript: (text) => {
            if (text.trim() && socket.readyState === 1) {
              socket.send(JSON.stringify({ type: 'transcript', role: 'agent', text }));
            }
          },

          onInterrupted: () => {
            log.debug('Agent interrupted by user');
          },

          onError: (error) => {
            log.error({ error: error.message }, 'AI session error');
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: 'error', message: error.message }));
            }
          },

          onClose: () => {
            log.info('AI session closed');
          }
        });

        await aiSession.connect();

        socket.send(JSON.stringify({
          type: 'transcript',
          role: 'system',
          text: `Connected via ${AI_PROVIDER.toUpperCase()} (${agent.voice || 'default'} voice). Start speaking!`
        }));

      } catch (err) {
        log.error({ error: err.message }, 'Failed to connect to AI provider');
        socket.send(JSON.stringify({
          type: 'error',
          message: `Failed to connect: ${err.message}`
        }));
        socket.close();
        return;
      }

      // ─── Handle browser messages ──────────────────────────

      socket.on('message', (message) => {
        try {
          const msg = JSON.parse(message.toString());

          if (msg.type === 'audio' && msg.data) {
            // Browser sends PCM 16kHz.
            // Inworld/Pipeline needs 24kHz — resample if needed.
            const audioData = needs24k ? resample16kTo24k(msg.data) : msg.data;
            aiSession.sendAudio(audioData);
          }
        } catch (err) {
          log.error({ error: err.message }, 'Error processing browser message');
        }
      });

      socket.on('close', async () => {
        log.info('Browser WebSocket closed');
        if (aiSession) aiSession.disconnect();
        await db.updateCall(callId, {
          status: 'completed',
          endedAt: new Date().toISOString(),
        });
      });

      socket.on('error', (err) => {
        log.error({ error: err.message }, 'Browser WebSocket error');
      });
    });
  });
}
