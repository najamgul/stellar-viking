/**
 * Gemini Live API WebSocket Client
 * 
 * Manages the WebSocket connection to Google's Gemini Live API.
 * Handles session configuration, bidirectional audio streaming,
 * function call events, and transcription.
 * 
 * Protocol: Raw WebSocket to generativelanguage.googleapis.com
 * Input audio:  PCM 16-bit 16kHz mono (base64)
 * Output audio: PCM 16-bit 24kHz mono (base64)
 */

import WebSocket from 'ws';
import config from '../config.js';
import logger from '../utils/logger.js';

const GEMINI_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export class GeminiLiveSession {
  /**
   * @param {object} options
   * @param {string} options.systemPrompt - Dynamic system prompt
   * @param {object[]} options.tools - Gemini tool definitions (functionDeclarations)
   * @param {string} options.voice - Voice name (Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus, Zephyr)
   * @param {string} options.language - Language code
   * @param {Function} options.onAudioData - Called with base64 PCM 24kHz audio from the model
   * @param {Function} options.onFunctionCall - Called with (functionCalls[]) when model invokes tools
   * @param {Function} options.onTranscript - Called with (text, role) for user transcription
   * @param {Function} options.onAgentTranscript - Called with (text, role) for model transcription
   * @param {Function} options.onError - Called on error
   * @param {Function} options.onClose - Called when connection closes
   * @param {Function} options.onInterrupted - Called when user interrupts agent
   * @param {object} options.log - Pino child logger
   */
  constructor(options) {
    this.options = options;
    this.ws = null;
    this.isConnected = false;
    this.isConfigured = false;
    this.log = options.log || logger;
  }

  /**
   * Connect to Gemini Live API and send session config.
   */
  async connect() {
    return new Promise((resolve, reject) => {
      const url = `${GEMINI_WS_BASE}?key=${config.geminiApiKey}`;

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.isConnected = true;
        this.log.info('Connected to Gemini Live API');
        this._sendConfig();
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          this._handleEvent(event);
        } catch (err) {
          this.log.error({ error: err.message }, 'Failed to parse Gemini event');
        }
      });

      this.ws.on('error', (err) => {
        this.log.error({ error: err.message }, 'Gemini WebSocket error');
        if (this.options.onError) this.options.onError(err);
        if (!this.isConnected) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this.log.info({ code, reason: reason?.toString() }, 'Gemini WebSocket closed');
        if (this.options.onClose) this.options.onClose(code, reason);
      });
    });
  }

  /**
   * Send the initial session configuration.
   * Must be the FIRST message after connection opens.
   */
  _sendConfig() {
    const liveModel = config.geminiLiveModel || config.geminiModel;
    const configMsg = {
      setup: {
        model: `models/${liveModel}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.options.voice || 'Kore',
              }
            }
          }
        },
        systemInstruction: {
          parts: [{ text: this.options.systemPrompt }]
        },
        tools: this.options.tools || [],
        // Enable input/output transcription
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      }
    };

    this._send(configMsg);
    this.isConfigured = true;
    this.log.info({ model: liveModel }, 'Gemini Live session configured');
  }

  /**
   * Stream audio from the caller to Gemini.
   * Audio MUST be PCM 16-bit 16kHz mono, base64 encoded.
   * @param {string} base64Audio - Base64-encoded PCM 16-bit 16kHz mono
   */
  sendAudio(base64Audio) {
    if (!this.isConnected || !this.isConfigured) return;

    this._send({
      realtimeInput: {
        audio: {
          data: base64Audio,
          mimeType: 'audio/pcm;rate=16000'
        }
      }
    });
  }

  /**
   * Send a tool response back to Gemini after executing a function call.
   * @param {object[]} functionResponses - Array of { id, name, response: { result } }
   */
  sendToolResponse(functionResponses) {
    if (!this.isConnected) return;

    this._send({
      toolResponse: {
        functionResponses: functionResponses
      }
    });

    this.log.info({ count: functionResponses.length }, 'Tool response sent to Gemini');
  }

  /**
   * Disconnect from Gemini.
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
    // ─── Setup complete ─────────────────────────────────
    if (event.setupComplete) {
      this.log.info('Gemini setup complete — session ready');
      return;
    }

    // ─── Server content (audio, transcriptions, turn status) ──
    if (event.serverContent) {
      const sc = event.serverContent;

      // Audio from agent
      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.data) {
            if (this.options.onAudioData) {
              this.options.onAudioData(part.inlineData.data);
            }
          }
        }
      }

      // User speech transcription
      if (sc.inputTranscription?.text) {
        if (this.options.onTranscript) {
          this.options.onTranscript(sc.inputTranscription.text, 'user');
        }
      }

      // Agent speech transcription
      if (sc.outputTranscription?.text) {
        if (this.options.onAgentTranscript) {
          this.options.onAgentTranscript(sc.outputTranscription.text, 'agent');
        }
      }

      // Turn complete
      if (sc.turnComplete) {
        this.log.debug('Turn complete');
      }

      // Interrupted (barge-in)
      if (sc.interrupted) {
        this.log.debug('Agent interrupted by user');
        if (this.options.onInterrupted) {
          this.options.onInterrupted();
        }
      }

      return;
    }

    // ─── Tool call from model ───────────────────────────
    if (event.toolCall) {
      this.log.info(
        { functions: event.toolCall.functionCalls?.map(fc => fc.name) },
        'Gemini tool call received'
      );

      if (this.options.onFunctionCall) {
        this.options.onFunctionCall(event.toolCall.functionCalls || []);
      }
      return;
    }

    // ─── Tool call cancellation ─────────────────────────
    if (event.toolCallCancellation) {
      this.log.warn(
        { ids: event.toolCallCancellation.ids },
        'Tool call cancelled by Gemini'
      );
      return;
    }

    // ─── Unknown event ──────────────────────────────────
    this.log.debug({ event }, 'Unhandled Gemini event');
  }

  // ─── Send helper ─────────────────────────────────────────────────

  _send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(data));
  }
}
