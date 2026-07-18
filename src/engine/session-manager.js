/**
 * Session Manager — orchestrates a single live call.
 * 
 * Ties together:
 *   - Twilio audio stream (caller side)
 *   - Gemini Live API session (AI side)
 *   - Tool execution (knowledge base, external APIs)
 *   - Call logging (transcript, summary, recording)
 * 
 * One SessionManager instance per active call.
 */

import { v4 as uuidv4 } from 'uuid';
import { createCallLogger } from '../utils/logger.js';
import { GeminiLiveSession } from './realtime-session.js';
import { InworldLiveSession } from './inworld-session.js';
import { PipelineLiveSession } from './pipeline-session.js';
import { buildSystemPrompt, buildToolDefinitions } from './prompt-builder.js';
import { executeTool } from './tool-dispatcher.js';
import { mulawToPcm16k, mulawToPcm24k, pcm24kToMulaw } from '../telephony/audio-transcoder.js';

const AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
import config from '../config.js';
import * as db from '../storage/database.js';
import { broadcast } from '../api/admin-events.js';
import { generateCallSummary } from './call-summary.js';

// Track all active sessions globally
const activeSessions = new Map();

export function getActiveSessionCount() {
  return activeSessions.size;
}

export function getActiveSession(callId) {
  return activeSessions.get(callId);
}

/**
 * Create and start a new call session.
 * 
 * @param {object} options
 * @param {object} options.agent - Agent config from database
 * @param {string} options.callerNumber - Caller's phone number
 * @param {string} options.twilioStreamSid - Twilio Media Stream SID
 * @param {WebSocket} options.twilioWs - Twilio WebSocket connection
 * @param {object} [options.retriever] - Knowledge base retriever instance
 * @returns {SessionManager}
 */
export async function createSession(options) {
  const session = new SessionManager(options);
  await session.start();
  return session;
}

class SessionManager {
  constructor(options) {
    this.callId = uuidv4();
    this.agent = options.agent;
    this.callerNumber = options.callerNumber;
    this.twilioStreamSid = options.twilioStreamSid;
    this.twilioCallSid = options.twilioCallSid || null;
    this.twilioWs = options.twilioWs;
    this.retriever = options.retriever || null;

    this.log = createCallLogger(this.callId, this.agent.id);
    this.geminiSession = null;
    this.transcript = [];
    this.startTime = Date.now();
    this.isEnding = false;
    this.finalStatus = 'completed';   // overridden to 'transferred' on transfer
  }

  async start() {
    this.log.info({
      agent: this.agent.name,
      company: this.agent.companyName,
      caller: this.callerNumber,
    }, '📞 Starting call session');

    // Register active session
    activeSessions.set(this.callId, this);

    // Create call log in database
    await db.createCall({
      id: this.callId,
      agentId: this.agent.id,
      callerNumber: this.callerNumber,
      direction: 'inbound',
      status: 'active',
    });

    // Broadcast call started
    broadcast('call.started', {
      callId: this.callId,
      agentId: this.agent.id,
      agentName: this.agent.name,
      callerNumber: this.callerNumber,
      startTime: this.startTime,
    });

    // Load agent's tools
    const agentTools = await db.listTools(this.agent.id);

    // Build dynamic prompt and Gemini tool definitions
    const systemPrompt = buildSystemPrompt(this.agent, agentTools);
    const toolDefinitions = buildToolDefinitions(this.agent, agentTools);

    this.log.debug({ promptLength: systemPrompt.length, toolCount: toolDefinitions[0]?.functionDeclarations?.length || 0 }, 'Prompt built');

    // Create the tool execution context
    const toolContext = {
      callId: this.callId,
      agentId: this.agent.id,
      agent: this.agent,
      log: this.log,
      retriever: this.retriever,
      onTransfer: (number, reason) => this._handleTransfer(number, reason),
      onEndCall: (reason) => this._handleEndCall(reason),
    };

    // Connect to AI session (Gemini, Inworld, or Pipeline)
    const providerMap = {
      'inworld': InworldLiveSession,
      'pipeline': PipelineLiveSession,
    };
    const SessionClass = providerMap[AI_PROVIDER] || GeminiLiveSession;
    this.log.info({ provider: AI_PROVIDER }, '🤖 Connecting to AI provider');

    this.geminiSession = new SessionClass({
      systemPrompt,
      tools: toolDefinitions,
      voice: this.agent.voice || 'Lily',
      language: this.agent.language || 'en',
      temperature: this.agent.temperature || 0.8,
      speechSpeed: this.agent.speechSpeed || 1.0,
      log: this.log,

      // Agent audio → Twilio (caller hears the agent)
      // Gemini sends PCM 24kHz — we convert to mulaw 8kHz for Twilio
      onAudioData: (base64Pcm24k) => {
        this._sendAudioToTwilio(base64Pcm24k);
      },

      // Function calls from Gemini
      // Gemini sends an array of functionCalls (can be multiple)
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
            this.log.error({ tool: fc.name, error: error.message }, 'Tool execution error');
            responses.push({
              id: fc.id,
              name: fc.name,
              response: { result: { error: true, message: 'Tool execution failed.' } },
            });
          }
        }

        // Send all responses back to Gemini
        this.geminiSession.sendToolResponse(responses);
      },

      // User speech transcript
      onTranscript: (text, role) => {
        if (text.trim()) {
          this.transcript.push({ role: 'user', text, timestamp: new Date().toISOString() });
          this.log.debug({ text }, '🗣️ User said');
          broadcast('call.transcript', { callId: this.callId, agentName: this.agent.name, role: 'user', text });
        }
      },

      // Agent speech transcript
      onAgentTranscript: (text, role) => {
        if (text.trim()) {
          this.transcript.push({ role: 'agent', text, timestamp: new Date().toISOString() });
          this.log.debug({ text }, '🤖 Agent said');
          broadcast('call.transcript', { callId: this.callId, agentName: this.agent.name, role: 'agent', text });
        }
      },

      onInterrupted: () => {
        this.log.debug('Agent speech interrupted by user');
      },

      onError: (error) => {
        this.log.error({ error: error.message }, 'Gemini session error');
      },

      onClose: () => {
        this.log.info({ provider: AI_PROVIDER }, 'AI session closed');
        this._cleanup();
      }
    });

    await this.geminiSession.connect();
    this.log.info('✅ Call session fully connected');
  }

  /**
   * Handle incoming audio from Twilio (caller speaking).
   * Twilio sends mulaw 8kHz — we convert to PCM 16kHz for Gemini.
   * @param {string} base64Mulaw - Base64-encoded mulaw audio from Twilio
   */
  handleTwilioAudio(base64Mulaw) {
    if (!this.geminiSession?.isConnected) return;

    const mulawBuffer = Buffer.from(base64Mulaw, 'base64');

    // Inworld Realtime S2S needs 24kHz PCM, Gemini uses 16kHz
    const pcmBuffer = (AI_PROVIDER === 'inworld' || AI_PROVIDER === 'pipeline')
      ? mulawToPcm24k(mulawBuffer)
      : mulawToPcm16k(mulawBuffer);

    this.geminiSession.sendAudio(pcmBuffer.toString('base64'));
  }

  /**
   * Send AI-generated audio back to Twilio (caller hears the agent).
   * Gemini outputs PCM 24kHz — we convert to mulaw 8kHz for Twilio.
   * @param {string} base64Pcm24k - Base64-encoded PCM 24kHz audio from Gemini
   */
  _sendAudioToTwilio(base64Pcm24k) {
    if (!this.twilioWs || this.twilioWs.readyState !== 1) return; // 1 = OPEN

    // PCM 24kHz → mulaw 8kHz
    const pcmBuffer = Buffer.from(base64Pcm24k, 'base64');
    const mulawBuffer = pcm24kToMulaw(pcmBuffer);

    if (!this._twilioAudioLogged) {
      // Debug: check first PCM samples and mulaw bytes
      const firstPcmSamples = [];
      for (let i = 0; i < Math.min(10, pcmBuffer.length / 2); i++) {
        firstPcmSamples.push(pcmBuffer.readInt16LE(i * 2));
      }
      const firstMulaw = Array.from(mulawBuffer.slice(0, 10));
      this.log.info({
        pcmBytes: pcmBuffer.length,
        mulawBytes: mulawBuffer.length,
        firstPcmSamples,
        firstMulaw,
        streamSid: this.twilioStreamSid,
        wsOpen: this.twilioWs.readyState === 1,
      }, '🔊 First audio chunk → Twilio (debug)');
      this._twilioAudioLogged = true;
    }

    // Send to Twilio
    try {
      this.twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid: this.twilioStreamSid,
        media: {
          payload: mulawBuffer.toString('base64'),
        }
      }));
    } catch (err) {
      this.log.error({ error: err.message }, 'Failed to send audio to Twilio');
    }
  }

  /**
   * Handle Twilio stream ending (caller hung up).
   */
  async handleStreamEnd() {
    this.log.info('📴 Twilio stream ended (caller hung up)');
    await this._cleanup();
  }

  // ─── Internal handlers ───────────────────────────────────────────

  async _handleTransfer(number, reason) {
    this.log.info({ number, reason }, '🔀 Transferring call');
    this.finalStatus = 'transferred';

    if (this.twilioCallSid && config.twilioAccountSid && config.twilioAuthToken) {
      try {
        const twilio = (await import('twilio')).default;
        const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
        await client.calls(this.twilioCallSid).update({
          twiml: `<Response><Say>Connecting you now.</Say><Dial>${number}</Dial></Response>`,
        });
        this.log.info({ number }, '✅ Twilio call redirected');
        // Twilio tears down the media stream; _cleanup runs via handleStreamEnd
        return;
      } catch (err) {
        this.log.error({ error: err.message }, 'Twilio transfer failed — ending call');
      }
    } else {
      this.log.warn('Cannot transfer: missing Twilio CallSid or credentials — ending call');
    }
    this._cleanup();
  }

  _handleEndCall(reason) {
    this.log.info({ reason }, '📴 Agent ending call');
    this._cleanup();
  }

  async _cleanup() {
    if (this.isEnding) return;
    this.isEnding = true;

    const duration = Math.round((Date.now() - this.startTime) / 1000);

    // Disconnect Gemini
    if (this.geminiSession) {
      this.geminiSession.disconnect();
    }

    // Build full transcript
    const fullTranscript = this.transcript
      .map(t => `[${t.role}] ${t.text}`)
      .join('\n');

    // Update call log (finalStatus preserves 'transferred' set by _handleTransfer)
    await db.updateCall(this.callId, {
      status: this.finalStatus,
      endedAt: new Date().toISOString(),
      duration,
      transcript: fullTranscript,
    });

    // Generate AI call summary (fire-and-forget)
    generateCallSummary(this.callId).catch(err => {
      this.log.warn({ error: err.message }, 'Call summary generation failed');
    });

    // Dispatch webhook if configured
    if (this.agent.webhookUrl) {
      this._dispatchWebhook(duration, fullTranscript);
    }

    // Remove from active sessions
    activeSessions.delete(this.callId);

    // Broadcast call ended
    broadcast('call.ended', {
      callId: this.callId,
      agentId: this.agent.id,
      agentName: this.agent.name,
      duration,
      transcriptLines: this.transcript.length,
    });

    this.log.info({ duration: `${duration}s`, transcriptLines: this.transcript.length }, '✅ Call session ended');
  }

  async _dispatchWebhook(duration, transcript) {
    try {
      const call = await db.getCall(this.callId);
      await fetch(this.agent.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'call.completed',
          callId: this.callId,
          agentId: this.agent.id,
          callerNumber: this.callerNumber,
          duration,
          summary: call?.summary || null,
          transcript,
          toolsUsed: call?.toolsUsed || [],
          timestamp: new Date().toISOString(),
        }),
      });
      this.log.info({ webhookUrl: this.agent.webhookUrl }, 'Webhook dispatched');
    } catch (error) {
      this.log.error({ error: error.message }, 'Webhook dispatch failed');
    }
  }
}
