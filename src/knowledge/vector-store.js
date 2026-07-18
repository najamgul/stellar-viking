/**
 * Persistent Vector Store
 * 
 * File-backed vector store using cosine similarity.
 * Each agent gets its own namespace (isolated vectors).
 * Persists to ./data/vectors-{agentId}.json
 * 
 * In production, replace with Pinecone, Qdrant, or pgvector.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

// agentId → [{ vector, text, metadata }]
const store = new Map();

// ─── Persistence Helpers ───────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function vectorFile(agentId) {
  return path.join(DATA_DIR, `vectors-${agentId}.json`);
}

function saveVectors(agentId) {
  try {
    ensureDataDir();
    const items = store.get(agentId) || [];
    fs.writeFileSync(vectorFile(agentId), JSON.stringify(items), 'utf-8');
  } catch (err) {
    logger.error({ error: err.message, agentId }, 'Failed to persist vectors');
  }
}

function loadVectors(agentId) {
  try {
    const fp = vectorFile(agentId);
    if (!fs.existsSync(fp)) return [];
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (err) {
    logger.error({ error: err.message, agentId }, 'Failed to load vectors');
    return [];
  }
}

// Load vectors for an agent lazily (on first access)
function ensureLoaded(agentId) {
  if (!store.has(agentId)) {
    const items = loadVectors(agentId);
    store.set(agentId, items);
    if (items.length > 0) {
      logger.debug({ agentId, count: items.length }, 'Vectors loaded from disk');
    }
  }
}

/**
 * Add vectors to the store for an agent.
 * @param {string} agentId 
 * @param {object[]} items - Array of { vector: number[], text: string, metadata: object }
 */
export function upsert(agentId, items) {
  ensureLoaded(agentId);
  const agentStore = store.get(agentId);

  for (const item of items) {
    agentStore.push({
      vector: item.vector,
      text: item.text,
      metadata: item.metadata || {},
    });
  }

  saveVectors(agentId);
  logger.debug({ agentId, count: items.length, total: agentStore.length }, 'Vectors upserted');
}

/**
 * Search for similar vectors.
 * @param {string} agentId 
 * @param {number[]} queryVector - Query embedding
 * @param {number} topK - Number of results
 * @param {string} [filterDocId] - Optional filter by document ID
 * @returns {object[]} Array of { text, score, metadata }
 */
export function search(agentId, queryVector, topK = 3, filterDocId = null) {
  ensureLoaded(agentId);
  const agentStore = store.get(agentId);
  if (!agentStore || agentStore.length === 0) return [];

  const results = agentStore
    .filter(item => !filterDocId || item.metadata.docId === filterDocId)
    .map(item => ({
      text: item.text,
      metadata: item.metadata,
      score: cosineSimilarity(queryVector, item.vector),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return results;
}

/**
 * Delete all vectors for a specific document.
 * @param {string} agentId 
 * @param {string} docId 
 */
export function deleteByDocument(agentId, docId) {
  ensureLoaded(agentId);
  const agentStore = store.get(agentId);
  if (!agentStore) return;

  const filtered = agentStore.filter(item => item.metadata.docId !== docId);
  store.set(agentId, filtered);
  saveVectors(agentId);

  logger.debug({ agentId, docId, removed: agentStore.length - filtered.length }, 'Vectors deleted');
}

/**
 * Delete all vectors for an agent.
 * @param {string} agentId 
 */
export function deleteByAgent(agentId) {
  store.delete(agentId);
  try {
    const fp = vectorFile(agentId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
}

/**
 * Get all stored items for an agent (used to rebuild the keyword index
 * after a restart — vectors persist to disk, the keyword index doesn't).
 * @param {string} agentId
 * @returns {object[]} Array of { vector, text, metadata }
 */
export function getAll(agentId) {
  ensureLoaded(agentId);
  return store.get(agentId) || [];
}

/**
 * Get stats for an agent's vector store.
 * @param {string} agentId
 * @returns {{ count: number, documents: string[] }}
 */
export function getStats(agentId) {
  ensureLoaded(agentId);
  const agentStore = store.get(agentId);
  if (!agentStore) return { count: 0, documents: [] };

  const documents = [...new Set(agentStore.map(item => item.metadata.docId))];
  return { count: agentStore.length, documents };
}

// ─── Cosine Similarity ──────────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
