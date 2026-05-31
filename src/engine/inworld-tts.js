/**
 * Inworld TTS WebSocket Client
 * 
 * Connects to Inworld's bidirectional TTS WebSocket for real-time
 * text-to-speech streaming. Used in the pipeline architecture:
 *   Twilio Audio → STT → Gemini LLM → Inworld TTS → Twilio Audio
 * 
 * Endpoint: wss://api.inworld.ai/tts/v1/voice:streamBidirectional
 * Auth:     Basic <base64-key>
 * Output:   MP3 audio chunks (base64-encoded)
 */

import WebSocket from 'ws';
import config from '../config.js';
import logger from '../utils/logger.js';

const TTS_WS_URL = 'wss://api.inworld.ai/tts/v1/voice:streamBidirectional';
const TTS_HTTP_URL = 'https://api.inworld.ai/tts/v1/voice:stream';

export class InworldTTS {
  /**
   * @param {object} options
   * @param {string} [options.voiceId='Riya'] - Inworld voice name
   * @param {string} [options.modelId='inworld-tts-1.5-max'] - TTS model
   * @param {number} [options.speakingRate=1] - Speaking rate
   * @param {number} [options.temperature=1] - Voice temperature
   * @param {Function} options.onAudioChunk - Called with base64 MP3 audio
   * @param {Function} [options.onError] - Called on errors
   * @param {object} [options.log] - Logger instance
   */
  constructor(options = {}) {
    this.voiceId = options.voiceId || 'Riya';
    this.modelId = options.modelId || 'inworld-tts-1.5-max';
    this.speakingRate = options.speakingRate || 1;
    this.temperature = options.temperature || 1;
    this.onAudioChunk = options.onAudioChunk;
    this.onError = options.onError;
    this.log = options.log || logger;
    this.ws = null;
    this.isConnected = false;
    this._apiKey = config.inworldTtsApiKey || config.inworldBasicAuth;
  }

  /**
   * Connect to Inworld TTS WebSocket for bidirectional streaming.
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.log.info({ url: TTS_WS_URL, voice: this.voiceId }, 'Connecting to Inworld TTS...');

      this.ws = new WebSocket(TTS_WS_URL, {
        headers: {
          'Authorization': `Basic ${this._apiKey}`,
        }
      });

      this.ws.on('open', () => {
        this.isConnected = true;
        this.log.info('✅ Connected to Inworld TTS WebSocket');
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          // Each message is an NDJSON line with { result: { audioContent: "base64" } }
          const msg = JSON.parse(data.toString());
          if (msg.result?.audioContent && this.onAudioChunk) {
            this.onAudioChunk(msg.result.audioContent);
          }
        } catch (err) {
          this.log.error({ error: err.message }, 'Failed to parse TTS response');
        }
      });

      this.ws.on('error', (err) => {
        this.log.error({ error: err.message }, 'Inworld TTS WebSocket error');
        if (this.onError) this.onError(err);
        if (!this.isConnected) reject(err);
      });

      this.ws.on('close', (code) => {
        this.isConnected = false;
        this.log.info({ code }, 'Inworld TTS WebSocket closed');
      });

      setTimeout(() => {
        if (!this.isConnected) reject(new Error('Inworld TTS connection timed out'));
      }, 10000);
    });
  }

  /**
   * Send text to be spoken. Audio chunks arrive via onAudioChunk callback.
   * Supports SSML-like markup: [happy], [sad], <break time="500ms"/>, etc.
   * @param {string} text - Text to synthesize
   */
  speak(text) {
    if (!this.isConnected || !this.ws) {
      this.log.warn('TTS not connected, cannot speak');
      return;
    }

    this.ws.send(JSON.stringify({
      text,
      voice_id: this.voiceId,
      model_id: this.modelId,
      audio_config: {
        audio_encoding: 'MP3',
        speaking_rate: this.speakingRate,
      },
      temperature: this.temperature,
    }));
  }

  /**
   * Use HTTP streaming as fallback — simpler, no persistent connection.
   * Returns a readable stream of audio chunks.
   * @param {string} text
   * @returns {Promise<string>} Base64-encoded MP3 audio
   */
  async speakHTTP(text) {
    const response = await fetch(TTS_HTTP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${this._apiKey}`,
      },
      body: JSON.stringify({
        text,
        voice_id: this.voiceId,
        model_id: this.modelId,
        audio_config: {
          audio_encoding: 'MP3',
          speaking_rate: this.speakingRate,
        },
        temperature: this.temperature,
      }),
    });

    if (!response.ok) {
      throw new Error(`Inworld TTS HTTP error: ${response.status}`);
    }

    // Read NDJSON stream
    const body = await response.text();
    const chunks = body.split('\n').filter(Boolean).map(line => {
      const parsed = JSON.parse(line);
      return parsed.result?.audioContent || '';
    });

    return chunks.join('');
  }

  /**
   * Disconnect from TTS WebSocket.
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }
  }
}
