/**
 * Inworld AI Realtime API WebSocket Client
 * 
 * Drop-in replacement for GeminiLiveSession.
 * Uses the OpenAI-compatible Realtime protocol from Inworld AI.
 * 
 * Protocol: WebSocket to api.inworld.ai
 * Input audio:  PCM 16-bit 24kHz mono (base64)
 * Output audio: PCM 16-bit 24kHz mono (base64)
 * 
 * Events follow the OpenAI Realtime spec:
 *   Client → Server:  session.update, input_audio_buffer.append, conversation.item.create, response.create
 *   Server → Client:  session.created, response.audio.delta, response.function_call_arguments.done, etc.
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import config from '../config.js';
import logger from '../utils/logger.js';

const INWORLD_WS_URL = 'wss://api.inworld.ai/api/v1/realtime/session';

export class InworldLiveSession {
  /**
   * Same callback interface as GeminiLiveSession for zero-change session-manager compatibility.
   * @param {object} options
   * @param {string} options.systemPrompt
   * @param {object[]} options.tools - Gemini-format [{functionDeclarations: [...]}]
   * @param {string} options.voice
   * @param {string} options.language
   * @param {Function} options.onAudioData - Called with base64 PCM 24kHz audio
   * @param {Function} options.onFunctionCall - Called with [{id, name, args}]
   * @param {Function} options.onTranscript - Called with (text, 'user')
   * @param {Function} options.onAgentTranscript - Called with (text, 'agent')
   * @param {Function} options.onError
   * @param {Function} options.onClose
   * @param {Function} options.onInterrupted
   * @param {object} options.log
   */
  constructor(options) {
    this.options = options;
    this.ws = null;
    this.isConnected = false;
    this.isConfigured = false;
    this.log = options.log || logger;
    this._pendingFunctionArgs = new Map(); // callId → accumulated args
    this._currentResponseId = null;
  }

  /**
   * Connect to Inworld Realtime API.
   */
  async connect() {
    return new Promise((resolve, reject) => {
      // Generate unique session ID
      const sessionId = crypto.randomUUID();
      const url = `${INWORLD_WS_URL}?key=${sessionId}&protocol=realtime`;

      // Build Basic auth from JWT Key + Secret
      const basicAuth = config.inworldBasicAuth || 
        Buffer.from(`${config.inworldApiKey}:${config.inworldApiSecret}`).toString('base64');

      this.log.info({ url: INWORLD_WS_URL, sessionId }, 'Connecting to Inworld...');

      this._resolveConnect = resolve;
      this._rejectConnect = reject;
      this._connectResolved = false;

      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
        }
      });

      this.ws.on('open', () => {
        this.isConnected = true;
        this.log.info('✅ WebSocket OPEN to Inworld');
      });

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          this._handleEvent(event);
        } catch (err) {
          this.log.error({ error: err.message, raw: data.toString().slice(0, 200) }, 'Failed to parse Inworld event');
        }
      });

      this.ws.on('error', (err) => {
        this.log.error({ error: err.message }, 'Inworld WebSocket error');
        if (this.options.onError) this.options.onError(err);
        if (!this._connectResolved) {
          this._connectResolved = true;
          reject(err);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this.log.info({ code, reason: reason?.toString() }, 'Inworld WebSocket closed');
        if (!this._connectResolved) {
          this._connectResolved = true;
          reject(new Error(`Inworld closed during connect: ${code}`));
        }
        if (this.options.onClose) this.options.onClose(code, reason);
      });

      // Timeout
      setTimeout(() => {
        if (!this._connectResolved) {
          this._connectResolved = true;
          reject(new Error('Inworld session creation timed out'));
        }
      }, 15000);
    });
  }

  /**
   * Send session configuration via session.update event.
   */
  _sendConfig() {
    const voiceMap = {
      'Kore': 'shimmer',
      'Aoede': 'alloy',
      'Leda': 'nova',
      'Puck': 'echo',
      'Charon': 'onyx',
      'Fenrir': 'fable',
      'Orus': 'ash',
    };

    const selectedVoice = voiceMap[this.options.voice] || 'shimmer';

    // Convert tools, but skip them if conversion fails
    let tools = [];
    try {
      tools = this._convertTools(this.options.tools);
    } catch (err) {
      this.log.warn({ error: err.message }, 'Tool conversion failed — starting without tools');
    }

    this.log.info({ voice: selectedVoice, toolCount: tools.length, promptLength: this.options.systemPrompt?.length }, 'Sending session.update to Inworld');

    this._send({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: this.options.systemPrompt,
        voice: selectedVoice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
        },
        tools,
      },
    });

    this.isConfigured = true;
    this.log.info('session.update sent — waiting for session.updated');
  }

  /**
   * Trigger initial AI greeting after session is fully configured.
   * Inworld requires at least one user message before generating a response.
   */
  _triggerGreeting() {
    // First, create a user message to satisfy Inworld's requirement
    this._send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Hello',
        }],
      },
    });

    // Now trigger the response
    this._send({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
      },
    });
    this.log.info('🎙️ Triggered initial greeting via conversation.item + response.create');
  }

  /**
   * Convert Gemini tool definitions to OpenAI function format.
   * Gemini: [{ functionDeclarations: [{name, description, parameters: {type:'OBJECT', properties, required}}] }]
   * OpenAI: [{ type: 'function', name, description, parameters: {type:'object', properties, required} }]
   */
  _convertTools(geminiTools) {
    if (!geminiTools || !geminiTools[0]?.functionDeclarations) return [];

    return geminiTools[0].functionDeclarations.map(fd => ({
      type: 'function',
      name: fd.name,
      description: fd.description,
      parameters: this._convertParams(fd.parameters),
    }));
  }

  _convertParams(params) {
    if (!params) return { type: 'object', properties: {} };

    const typeMap = { 'STRING': 'string', 'NUMBER': 'number', 'INTEGER': 'integer', 'BOOLEAN': 'boolean', 'OBJECT': 'object', 'ARRAY': 'array' };

    const result = { type: typeMap[params.type] || 'object' };

    if (params.properties) {
      result.properties = {};
      for (const [key, val] of Object.entries(params.properties)) {
        result.properties[key] = {
          type: typeMap[val.type] || 'string',
          description: val.description || '',
        };
      }
    }

    if (params.required) result.required = params.required;
    return result;
  }

  /**
   * Stream audio from caller to Inworld.
   * Audio MUST be PCM 16-bit 24kHz mono, base64 encoded.
   * @param {string} base64Audio
   */
  sendAudio(base64Audio) {
    if (!this.isConnected || !this.isConfigured) return;

    this._send({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    });
  }

  /**
   * Send tool responses back to Inworld.
   * Must create conversation items then trigger response.
   * @param {object[]} functionResponses - [{id, name, response: {result}}]
   */
  sendToolResponse(functionResponses) {
    if (!this.isConnected) return;

    for (const fr of functionResponses) {
      this._send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: fr.id,
          output: JSON.stringify(fr.response.result),
        },
      });
    }

    // Trigger the model to respond based on tool results
    this._send({ type: 'response.create' });

    this.log.info({ count: functionResponses.length }, 'Tool response sent to Inworld');
  }

  /**
   * Disconnect from Inworld.
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
      this.isConfigured = false;
    }
  }

  // ─── Event Handlers ──────────────────────────────────────────────

  _handleEvent(event) {
    switch (event.type) {
      // ─── Session lifecycle ─────────────────────────
      case 'session.created':
        this.log.info('Inworld session created — sending config');
        this._sendConfig();
        break;

      case 'session.updated':
        this.log.info('✅ Inworld session updated — triggering greeting');
        // Session is fully configured — trigger AI greeting and resolve
        this._triggerGreeting();
        if (!this._connectResolved) {
          this._connectResolved = true;
          this._resolveConnect();
        }
        break;

      // ─── Audio from agent ──────────────────────────
      case 'response.audio.delta':
        if (event.delta && this.options.onAudioData) {
          this._audioChunks = (this._audioChunks || 0) + 1;
          if (this._audioChunks === 1) {
            this.log.info({ deltaLen: event.delta.length }, '🔊 First audio chunk received from Inworld');
          } else if (this._audioChunks % 50 === 0) {
            this.log.debug({ chunks: this._audioChunks }, 'Audio streaming');
          }
          this.options.onAudioData(event.delta);
        }
        break;

      // ─── User transcript ───────────────────────────
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript && this.options.onTranscript) {
          this.options.onTranscript(event.transcript, 'user');
        }
        break;

      // ─── Agent transcript ──────────────────────────
      case 'response.audio_transcript.delta':
        if (event.delta && this.options.onAgentTranscript) {
          this.options.onAgentTranscript(event.delta, 'agent');
        }
        break;

      // ─── Function call arguments streaming ─────────
      case 'response.function_call_arguments.delta':
        if (event.call_id) {
          const existing = this._pendingFunctionArgs.get(event.call_id) || '';
          this._pendingFunctionArgs.set(event.call_id, existing + (event.delta || ''));
        }
        break;

      // ─── Function call complete ────────────────────
      case 'response.function_call_arguments.done':
        if (event.call_id && this.options.onFunctionCall) {
          let args = {};
          try {
            args = JSON.parse(event.arguments || this._pendingFunctionArgs.get(event.call_id) || '{}');
          } catch { args = {}; }

          this._pendingFunctionArgs.delete(event.call_id);

          // Convert to Gemini-compatible format for tool-dispatcher
          this.options.onFunctionCall([{
            id: event.call_id,
            name: event.name,
            args,
          }]);
        }
        break;

      // ─── Interruption (user barged in) ─────────────
      case 'input_audio_buffer.speech_started':
        if (this.options.onInterrupted) {
          this.options.onInterrupted();
        }
        break;

      // ─── Response done ─────────────────────────────
      case 'response.done':
        this.log.debug('Inworld response complete');
        break;

      // ─── Errors ────────────────────────────────────
      case 'error':
        this.log.error({ error: event.error }, 'Inworld API error');
        if (this.options.onError) {
          this.options.onError(new Error(event.error?.message || 'Inworld error'));
        }
        break;

      // ─── Rate limit ────────────────────────────────
      case 'rate_limits.updated':
        this.log.debug({ limits: event.rate_limits }, 'Rate limits updated');
        break;

      default:
        this.log.debug({ type: event.type }, 'Unhandled Inworld event');
    }
  }

  // ─── Send helper ─────────────────────────────────────────────────

  _send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(data));
  }
}
