/**
 * Sarvam AI STT WebSocket Client
 * 
 * Real-time speech-to-text using Sarvam's WebSocket streaming API.
 * Model: saaras:v3 — supports English + 22 Indian languages.
 * 
 * Protocol:
 *   1. Connect to WSS URL with query params (model, language, codec)
 *   2. Send raw PCM 16kHz binary audio chunks
 *   3. Receive JSON { transcript, isFinal, ... }
 */

import WebSocket from 'ws';
import config from '../config.js';
import logger from '../utils/logger.js';

const STT_WS_BASE = 'wss://api.sarvam.ai/speech-to-text/ws';

export class SarvamSTT {
  /**
   * @param {object} options
   * @param {Function} options.onTranscript - Called with (text, isFinal)
   * @param {Function} [options.onError] - Called on errors
   * @param {Function} [options.onClose] - Called when connection closes
   * @param {string} [options.language='en-IN'] - BCP-47 language code
   * @param {object} [options.log] - Logger instance
   */
  constructor(options = {}) {
    this.options = options;
    this.ws = null;
    this.isConnected = false;
    this.isConfigured = false;
    this.log = options.log || logger;
    this._apiKey = config.sarvamApiKey;
    this._language = options.language || 'en-IN';
  }

  /**
   * Connect to Sarvam STT WebSocket.
   * Config is passed as query parameters (not a JSON message).
   */
  async connect() {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        'api-subscription-key': this._apiKey,
        model: 'saaras:v3',
        language_code: this._language,
        mode: 'transcribe',
        input_audio_codec: 'pcm_s16le',
      });

      const url = `${STT_WS_BASE}?${params.toString()}`;
      this.log.info('Connecting to Sarvam STT...');

      this.ws = new WebSocket(url, {
        headers: {
          'Api-Subscription-Key': this._apiKey,
        },
      });

      this.ws.on('open', () => {
        this.isConnected = true;
        this.isConfigured = true;
        this.log.info('✅ Sarvam STT connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch (err) {
          this.log.error({ error: err.message, raw: data.toString().slice(0, 200) }, 'Failed to parse STT response');
        }
      });

      this.ws.on('error', (err) => {
        this.log.error({ error: err.message }, 'Sarvam STT error');
        if (this.options.onError) this.options.onError(err);
        if (!this.isConnected) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this.log.info({ code, reason: reason?.toString() }, 'Sarvam STT closed');
        if (this.options.onClose) this.options.onClose(code, reason);
      });

      setTimeout(() => {
        if (!this.isConnected) reject(new Error('Sarvam STT connection timed out'));
      }, 10000);
    });
  }

  /**
   * Handle incoming transcript messages.
   */
  _handleMessage(msg) {
    // Sarvam returns { transcript, is_final } or { type: "transcript", ... }
    const transcript = msg.transcript;
    const isFinal = msg.is_final || msg.isFinal || msg.type === 'final';

    if (transcript && this.options.onTranscript) {
      this.options.onTranscript(transcript, isFinal);
    }
  }

  /**
   * Send raw PCM audio for transcription.
   * @param {string} base64Audio - Base64-encoded PCM 16kHz 16-bit mono
   */
  sendAudio(base64Audio) {
    if (!this.isConnected) return;

    try {
      // Sarvam expects raw binary PCM audio, not base64-wrapped JSON
      const buffer = Buffer.from(base64Audio, 'base64');
      this.ws.send(buffer);
    } catch (err) {
      this.log.error({ error: err.message }, 'Failed to send audio to Sarvam STT');
    }
  }

  /**
   * Disconnect.
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isConfigured = false;
  }
}
