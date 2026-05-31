/**
 * API Key Management
 * 
 * Generates and validates API keys for external system access.
 * Keys are stored in a file and checked on every API request.
 * 
 * Format: sv_live_<32 hex chars>
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_BASE = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const KEYS_FILE = path.join(DATA_BASE, 'api-keys.json');

// In-memory cache
let apiKeys = [];

function ensureDataDir() {
  const dir = path.dirname(KEYS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadKeys() {
  try {
    ensureDataDir();
    if (fs.existsSync(KEYS_FILE)) {
      apiKeys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
    }
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to load API keys');
    apiKeys = [];
  }
}

function saveKeys() {
  try {
    ensureDataDir();
    fs.writeFileSync(KEYS_FILE, JSON.stringify(apiKeys, null, 2), 'utf-8');
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to save API keys');
  }
}

// Load on startup
loadKeys();

/**
 * Generate a new API key.
 * @param {string} name - Descriptive name (e.g., "HubSpot Integration")
 * @param {string[]} scopes - Permission scopes: "read", "write", "calls", "agents", "all"
 * @returns {object} - { id, key, name, scopes, createdAt }
 */
export function generateApiKey(name, scopes = ['all']) {
  const key = `sv_live_${crypto.randomBytes(24).toString('hex')}`;
  const hashedKey = hashKey(key);

  const record = {
    id: crypto.randomUUID(),
    name,
    keyPrefix: key.slice(0, 12) + '...',  // Show prefix for identification
    hashedKey,
    scopes,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    requestCount: 0,
    isActive: true,
  };

  apiKeys.push(record);
  saveKeys();

  logger.info({ name, scopes }, '🔑 API key generated');

  // Return the full key ONLY this once (not stored)
  return { ...record, key };
}

/**
 * Validate an API key and return the key record.
 * @param {string} key - The raw API key
 * @returns {object|null} - Key record or null if invalid
 */
export function validateApiKey(key) {
  if (!key || !key.startsWith('sv_live_')) return null;

  const hashed = hashKey(key);
  const record = apiKeys.find(k => k.hashedKey === hashed && k.isActive);

  if (record) {
    record.lastUsedAt = new Date().toISOString();
    record.requestCount++;
    // Save periodically (every 10 requests) to avoid excessive disk IO
    if (record.requestCount % 10 === 0) saveKeys();
  }

  return record || null;
}

/**
 * Check if a key has a specific scope.
 * @param {object} keyRecord - Key record from validateApiKey
 * @param {string} scope - Required scope
 */
export function hasScope(keyRecord, scope) {
  if (!keyRecord) return false;
  return keyRecord.scopes.includes('all') || keyRecord.scopes.includes(scope);
}

/**
 * List all API keys (without hashed keys).
 */
export function listApiKeys() {
  return apiKeys.map(k => ({
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    scopes: k.scopes,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    requestCount: k.requestCount,
    isActive: k.isActive,
  }));
}

/**
 * Revoke (deactivate) an API key.
 * @param {string} id - Key ID
 */
export function revokeApiKey(id) {
  const key = apiKeys.find(k => k.id === id);
  if (key) {
    key.isActive = false;
    saveKeys();
    logger.info({ name: key.name }, '🔑 API key revoked');
    return true;
  }
  return false;
}

/**
 * Delete an API key permanently.
 * @param {string} id - Key ID
 */
export function deleteApiKey(id) {
  const idx = apiKeys.findIndex(k => k.id === id);
  if (idx !== -1) {
    apiKeys.splice(idx, 1);
    saveKeys();
    return true;
  }
  return false;
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}
