/**
 * Inworld STT WebSocket Client
 * 
 * Real-time speech-to-text using Inworld's streaming WebSocket API.
 * Receives PCM 16kHz audio from Twilio, sends to Inworld STT, 
 * returns transcriptions via callbacks.
 * 
 * Protocol:
 *   1. Send transcribe_config (first message)
 *   2. Stream audio_chunk messages with base64 LINEAR16 PCM
 *   3. Receive { result: { transcription: { transcript, isFinal } } }
 *   4. Send end_turn when speaker stops
 *   5. Send close_stream when done
 */

import WebSocket from 'ws';
import config from '../config.js';
import logger from '../utils/logger.js';

const STT_WS_URL = 'wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional';

export class InworldSTT {
  /**
   * @param {object} options
   * @param {Function} options.onTranscript - Called with (text, isFinal)
   * @param {Function} [options.onSpeechStarted] - Called when speech detected
   * @param {Function} [options.onVoiceProfile] - Called with voice profile data
   * @param {Function} [options.onError] - Called on errors
   * @param {Function} [options.onClose] - Called when connection closes
   * @param {string} [options.language='en-US'] - Language code
   * @param {object} [options.log] - Logger instance
   */
  constructor(options = {}) {
    this.options = options;
    this.ws = null;
    this.isConnected = false;
    this.isConfigured = false;
    this.log = options.log || logger;
    this._apiKey = config.inworldTtsApiKey; // Same key for STT and TTS
    this._language = options.language || 'en-US';
  }

  /**
   * Connect to Inworld STT WebSocket and send config.
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.log.info({ url: STT_WS_URL }, 'Connecting to Inworld STT...');

      this.ws = new WebSocket(STT_WS_URL, {
        headers: {
          'Authorization': `Basic ${this._apiKey}`,
        },
      });

      this.ws.on('open', () => {
        this.isConnected = true;
        this.log.info('✅ Inworld STT WebSocket connected');
        this._sendConfig();
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch (err) {
          this.log.error({ error: err.message }, 'Failed to parse STT response');
        }
      });

      this.ws.on('error', (err) => {
        this.log.error({ error: err.message }, 'Inworld STT error');
        if (this.options.onError) this.options.onError(err);
        if (!this.isConnected) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this.log.info({ code, reason: reason?.toString() }, 'Inworld STT closed');
        if (this.options.onClose) this.options.onClose(code, reason);
      });

      setTimeout(() => {
        if (!this.isConnected) reject(new Error('Inworld STT connection timed out'));
      }, 10000);
    });
  }

  /**
   * Send transcription config — must be the FIRST message.
   */
  _sendConfig() {
    const configMsg = {
      transcribe_config: {
        modelId: 'inworld/inworld-stt-1',
        audioEncoding: 'LINEAR16',
        sampleRateHertz: 16000,
        language: this._language,
        voiceProfileConfig: {
          enableVoiceProfile: true,
          topN: 3,
        },
        inworldConfig: {
          voiceProfileThreshold: 0.5,
        },
      },
    };

    this._send(configMsg);
    this.isConfigured = true;
    this.log.info({ language: this._language }, 'STT config sent');
  }

  /**
   * Handle incoming messages from Inworld STT.
   */
  _handleMessage(msg) {
    if (!msg.result) return;

    // Transcription result
    if (msg.result.transcription) {
      const { transcript, isFinal, wordTimestamps } = msg.result.transcription;
      
      if (transcript && this.options.onTranscript) {
        this.options.onTranscript(transcript, isFinal);
      }
    }

    // Speech started detection (VAD)
    if (msg.result.speechStarted) {
      this.log.debug({ startMs: msg.result.speechStarted.startTimeMs }, 'Speech detected');
      if (this.options.onSpeechStarted) {
        this.options.onSpeechStarted(msg.result.speechStarted);
      }
    }

    // Voice profile data
    if (msg.result.voiceProfile || msg.voiceProfile) {
      const vp = msg.result.voiceProfile || msg.voiceProfile;
      if (this.options.onVoiceProfile) {
        this.options.onVoiceProfile(vp);
      }
    }
  }

  /**
   * Send audio chunk for transcription.
   * @param {string} base64Audio - Base64-encoded LINEAR16 PCM 16kHz mono
   */
  sendAudio(base64Audio) {
    if (!this.isConnected || !this.isConfigured) return;

    this._send({
      audio_chunk: {
        content: base64Audio,
      },
    });
  }

  /**
   * Signal end of speaker's turn.
   */
  sendEndTurn() {
    if (!this.isConnected) return;
    this._send({ end_turn: {} });
  }

  /**
   * Close the stream gracefully.
   */
  closeStream() {
    if (!this.isConnected) return;
    this._send({ close_stream: {} });
  }

  /**
   * Send a JSON message.
   */
  _send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Disconnect.
   */
  disconnect() {
    if (this.ws) {
      try { this.closeStream(); } catch {}
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isConfigured = false;
  }
}
