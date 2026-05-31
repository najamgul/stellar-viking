import crypto from 'crypto';
import config from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * Encrypt a plaintext string (e.g. tool API credentials).
 * Returns a hex string: iv:tag:ciphertext
 */
export function encrypt(plaintext) {
  if (!config.encryptionKey) throw new Error('ENCRYPTION_KEY not configured');

  const key = crypto.scryptSync(config.encryptionKey, 'salt', 32);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string encrypted by encrypt().
 */
export function decrypt(encryptedStr) {
  if (!config.encryptionKey) throw new Error('ENCRYPTION_KEY not configured');
  if (!encryptedStr) return null;

  const [ivHex, tagHex, ciphertext] = encryptedStr.split(':');
  const key = crypto.scryptSync(config.encryptionKey, 'salt', 32);
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
