/**
 * Inworld Realtime Speech-to-Speech Session
 * 
 * Single WebSocket connection handles STT + LLM + TTS.
 * OpenAI Realtime-compatible protocol with Inworld extensions.
 * 
 * Audio: PCM16 24kHz mono — both input and output
 * 
 * Flow:
 *   1. Connect → receive session.created
 *   2. Send session.update with config
 *   3. Stream user audio via input_audio_buffer.append
 *   4. Receive agent audio via response.output_audio.delta
 *   5. Handle interruptions via input_audio_buffer.speech_started
 */

import WebSocket from 'ws';
import config from '../config.js';
import logger from '../utils/logger.js';

const REALTIME_BASE = 'wss://api.inworld.ai/api/v1/realtime/session';

export class PipelineLiveSession {
  constructor(options) {
    this.options = options;
    this.isConnected = false;
    this.isConfigured = false;
    this.log = options.log || logger;

    this._apiKey = config.inworldTtsApiKey;
    this._ws = null;
    this._sessionId = null;

    // Map voice names to Inworld TTS voices
    this._voiceId = this._mapVoice(options.voice);
    this._temperature = options.temperature || 0.8;
    this._speed = options.speechSpeed || 1.0;
  }

  _mapVoice(voice) {
    // Inworld TTS voices are used directly.
    // Supported: Clive, Lily, Riya, Adam, James, Olivia, Dennis, Alex, Chloe, Aria
    return voice || 'Clive';
  }

  /**
   * Connect to the Inworld Realtime WebSocket.
   */
  async connect() {
    return new Promise((resolve, reject) => {
      const timestamp = Date.now();
      const url = `${REALTIME_BASE}?key=voice-${timestamp}&protocol=realtime`;

      this.log.info({ voice: this._voiceId }, '🔗 Inworld Realtime S2S connecting...');

      this._ws = new WebSocket(url, {
        headers: {
          'Authorization': `Basic ${this._apiKey}`,
        },
      });

      this._ws.on('open', () => {
        this.log.info('✅ Inworld Realtime WebSocket open');
      });

      this._ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleEvent(msg);

          // Resolve the connect() promise when session is fully configured
          if (msg.type === 'session.updated') {
            this.isConnected = true;
            this.isConfigured = true;
            resolve();
          }
        } catch (err) {
          this.log.error({ error: err.message, raw: data.toString().slice(0, 200) }, 'Failed to parse Realtime event');
        }
      });

      this._ws.on('error', (err) => {
        this.log.error({ error: err.message }, 'Realtime WebSocket error');
        if (this.options.onError) this.options.onError(err);
        if (!this.isConnected) reject(err);
      });

      this._ws.on('close', (code, reason) => {
        this.isConnected = false;
        this.log.info({ code, reason: reason?.toString() }, 'Realtime WebSocket closed');
        if (this.options.onClose) this.options.onClose();
      });

      // Timeout
      setTimeout(() => {
        if (!this.isConnected) reject(new Error('Inworld Realtime connection timed out'));
      }, 15000);
    });
  }

  /**
   * Handle all events from the Inworld Realtime API.
   */
  _handleEvent(msg) {
    switch (msg.type) {

      // ── Connection lifecycle ──────────────────────────────
      case 'session.created':
        this._sessionId = msg.session?.id;
        this.log.info({ sessionId: this._sessionId }, '📡 Session created — sending config');
        this._sendSessionUpdate();
        break;

      case 'session.updated':
        this.log.info('✅ Session configured — ready for audio');
        // Trigger the agent's initial greeting immediately.
        // Without this, the agent waits silently for user speech (semantic_vad).
        this._send({ type: 'response.create' });
        this.log.info('🎙️ Triggered initial greeting');
        break;

      // ── User speech events ────────────────────────────────
      case 'input_audio_buffer.speech_started':
        this.log.debug('🎤 User speech started — interrupting agent');
        if (this.options.onInterrupted) this.options.onInterrupted();
        // Cancel any in-progress response
        this._send({ type: 'response.cancel' });
        break;

      case 'input_audio_buffer.committed':
        this.log.debug('📎 Audio buffer committed');
        break;

      // ── Agent audio output ────────────────────────────────
      case 'response.output_audio.delta':
        if (msg.delta && this.options.onAudioData) {
          this._audioChunkCount = (this._audioChunkCount || 0) + 1;
          if (this._audioChunkCount <= 2 || this._audioChunkCount === 5) {
            const raw = Buffer.from(msg.delta, 'base64');
            const mid = Math.floor(raw.length / 2);
            const samples = [];
            for (let i = mid; i < Math.min(mid + 20, raw.length - 1); i += 2) {
              samples.push(raw.readInt16LE(i));
            }
            this.log.info({ chunk: this._audioChunkCount, deltaLen: msg.delta.length, rawBytes: raw.length, midSamples: samples }, `🔊 Audio chunk #${this._audioChunkCount}`);
          }
          this.options.onAudioData(msg.delta);
        }
        break;

      // ── Agent text transcript ─────────────────────────────
      case 'response.output_text.delta':
        // Text delta from agent (accumulated)
        break;

      case 'response.output_audio_transcript.delta':
        // Agent speech transcript — accumulate for logging
        if (msg.delta && this.options.onAgentTranscript) {
          this.options.onAgentTranscript(msg.delta, 'agent');
        }
        break;

      // ── User transcript (from STT) ────────────────────────
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript && this.options.onTranscript) {
          this.options.onTranscript(msg.transcript, 'user');
          this.log.info({ text: msg.transcript.slice(0, 80) }, '👤 User said');
        }
        break;

      // ── Response lifecycle ────────────────────────────────
      case 'response.created':
        this.log.debug('Agent response started');
        break;

      case 'response.done':
        this.log.debug('Agent response complete');
        break;

      // ── Tool calling ──────────────────────────────────────
      case 'response.function_call_arguments.done':
        this._handleToolCall(msg);
        break;

      // ── Errors ────────────────────────────────────────────
      case 'error':
        this.log.error({ error: msg.error }, 'Realtime API error');
        break;

      default:
        this.log.debug({ type: msg.type }, 'Realtime event');
    }
  }

  /**
   * Send session configuration after session.created.
   */
  _sendSessionUpdate() {
    // Match the exact format from Inworld docs:
    // https://docs.inworld.ai/realtime/usage/using-realtime-models
     const sessionConfig = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'google-ai-studio/gemini-2.0-flash',   // 2.0-flash is ~3x faster than 2.5-flash for voice
        instructions: this.options.systemPrompt || 'You are a helpful voice agent.',
        tools: this._convertTools(this.options.tools),  // KB, transfer, end_call + custom tools
        output_modalities: ['audio'],                   // Audio only — skip text generation for lower latency
        temperature: this._temperature,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        audio: {
          input: {
            format: 'pcm16',
            sample_rate: 24000,
            transcription: {
              model: 'assemblyai/u3-rt-pro',            // Fast real-time STT
            },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'high',                        // Faster turn-end detection
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: 'pcm16',
            sample_rate: 24000,
            voice: this._voiceId,
            model: 'inworld-tts-2',                     // Latest TTS model
            speed: this._speed,
          },
        },
      },
    };

    this._send(sessionConfig);
  }

  /**
   * Convert Gemini-style tool definitions to OpenAI Realtime format.
   */
  _convertTools(tools) {
    if (!tools || !Array.isArray(tools)) return [];

    const converted = [];
    for (const tool of tools) {
      if (tool.functionDeclarations) {
        for (const fd of tool.functionDeclarations) {
          converted.push({
            type: 'function',
            name: fd.name,
            description: fd.description,
            parameters: fd.parameters || { type: 'object', properties: {} },
          });
        }
      }
    }
    return converted;
  }

  /**
   * Handle tool calls from the agent.
   */
  _handleToolCall(msg) {
    if (!this.options.onFunctionCall) return;

    const call = {
      id: msg.call_id,
      name: msg.name,
      args: JSON.parse(msg.arguments || '{}'),
    };

    this.log.info({ tool: call.name }, '🔧 Tool call');
    this.options.onFunctionCall([call]);
  }

  /**
   * Send tool response back to the Realtime session.
   */
  sendToolResponse(functionResponses) {
    for (const fr of functionResponses) {
      // Send function output
      this._send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: fr.id,
          output: JSON.stringify(fr.response),
        },
      });
    }

    // Trigger follow-up response
    this._send({ type: 'response.create' });
  }

  /**
   * Stream user audio to the Realtime API.
   * @param {string} base64Audio - Base64-encoded PCM16, 24kHz, mono
   */
  sendAudio(base64Audio) {
    if (!this.isConnected) return;

    this._send({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    });
  }

  /**
   * Send a JSON message over the WebSocket.
   */
  _send(msg) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Disconnect the session.
   */
  disconnect() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this.isConnected = false;
    this.isConfigured = false;
  }
}
