/**
 * Audio Transcoder — converts between Twilio and Gemini Live API audio formats.
 * 
 * Twilio sends/receives: mulaw 8kHz mono (base64 encoded chunks)
 * Gemini input expects:  PCM 16-bit signed LE, 16kHz mono (base64)
 * Gemini output returns: PCM 16-bit signed LE, 24kHz mono (base64)
 * 
 * We handle:
 *   mulaw 8kHz → PCM 16-bit 16kHz  (Twilio → Gemini input)
 *   PCM 16-bit 24kHz → mulaw 8kHz  (Gemini output → Twilio)
 */

// ─── mulaw decode/encode tables ────────────────────────────────────

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

const mulawDecodeTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let mulaw = ~i;
  let sign = mulaw & 0x80;
  let exponent = (mulaw >> 4) & 0x07;
  let mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  mulawDecodeTable[i] = sign ? -sample : sample;
}

/**
 * Encode a single PCM 16-bit signed sample to mulaw byte.
 */
function encodeMulaw(sample) {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  const exponentMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & exponentMask) break;
    sample <<= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa);
  return mulawByte & 0xff;
}

// ─── Linear interpolation resampler ────────────────────────────────

/**
 * Resample PCM samples from sourceRate to targetRate using linear interpolation.
 * @param {Int16Array} samples 
 * @param {number} sourceRate 
 * @param {number} targetRate 
 * @returns {Int16Array}
 */
function resample(samples, sourceRate, targetRate) {
  if (sourceRate === targetRate) return samples;

  const ratio = sourceRate / targetRate;
  const outputLength = Math.ceil(samples.length / ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, samples.length - 1);
    const frac = srcIndex - srcFloor;

    output[i] = Math.round(samples[srcFloor] * (1 - frac) + samples[srcCeil] * frac);
  }

  return output;
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Decode mulaw 8kHz audio → PCM 16-bit 16kHz (for Gemini Live API input).
 * @param {Buffer} mulawBuffer - Raw mulaw bytes from Twilio
 * @returns {Buffer} - PCM 16-bit LE at 16kHz
 */
export function mulawToPcm16k(mulawBuffer) {
  // Step 1: Decode mulaw → PCM 8kHz
  const pcm8k = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8k[i] = mulawDecodeTable[mulawBuffer[i]];
  }

  // Step 2: Upsample 8kHz → 16kHz
  const pcm16k = resample(pcm8k, 8000, 16000);

  // Step 3: Convert to Buffer (LE bytes)
  const buffer = Buffer.alloc(pcm16k.length * 2);
  for (let i = 0; i < pcm16k.length; i++) {
    buffer.writeInt16LE(pcm16k[i], i * 2);
  }

  return buffer;
}

/**
 * Decode mulaw 8kHz audio → PCM 16-bit 24kHz (for Inworld/OpenAI Realtime API input).
 * @param {Buffer} mulawBuffer - Raw mulaw bytes from Twilio
 * @returns {Buffer} - PCM 16-bit LE at 24kHz
 */
export function mulawToPcm24k(mulawBuffer) {
  // Step 1: Decode mulaw → PCM 8kHz
  const pcm8k = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8k[i] = mulawDecodeTable[mulawBuffer[i]];
  }

  // Step 2: Upsample 8kHz → 24kHz
  const pcm24k = resample(pcm8k, 8000, 24000);

  // Step 3: Convert to Buffer (LE bytes)
  const buffer = Buffer.alloc(pcm24k.length * 2);
  for (let i = 0; i < pcm24k.length; i++) {
    buffer.writeInt16LE(pcm24k[i], i * 2);
  }

  return buffer;
}

/**
 * Encode PCM 16-bit 24kHz → mulaw 8kHz (for Twilio playback).
 * Gemini output audio is 24kHz — we downsample to 8kHz for telephony.
 * @param {Buffer} pcmBuffer - PCM 16-bit LE at 24kHz from Gemini
 * @returns {Buffer} - Raw mulaw bytes at 8kHz
 */
export function pcm24kToMulaw(pcmBuffer) {
  // Step 1: Read PCM samples
  const sampleCount = pcmBuffer.length / 2;
  const pcm24k = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm24k[i] = pcmBuffer.readInt16LE(i * 2);
  }

  // Step 2: Downsample 24kHz → 8kHz
  const pcm8k = resample(pcm24k, 24000, 8000);

  // Step 3: Encode to mulaw
  const mulawBuffer = Buffer.alloc(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) {
    mulawBuffer[i] = encodeMulaw(pcm8k[i]);
  }

  return mulawBuffer;
}
