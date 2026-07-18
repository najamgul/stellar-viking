/**
 * Knowledge Base Retriever — Hybrid Search
 * 
 * Combines vector similarity (cosine) with keyword matching (BM25)
 * for significantly improved retrieval accuracy.
 * 
 * Score = (VECTOR_WEIGHT × vector_score) + (KEYWORD_WEIGHT × keyword_score_normalized)
 * 
 * Provides:
 *   - indexDocument(): chunk → embed → store (both vector + keyword index)
 *   - query(): hybrid search → return relevant text
 */

import { chunkDocument } from './chunker.js';
import { embedBatch, embedQuery } from './embedder.js';
import * as vectorStore from './vector-store.js';
import * as keywordIndex from './keyword-search.js';
import * as db from '../storage/database.js';
import logger from '../utils/logger.js';

const EMBED_BATCH_SIZE = 20;
const VECTOR_WEIGHT = 0.70;   // 70% vector similarity
const KEYWORD_WEIGHT = 0.30;  // 30% keyword (BM25)

/**
 * Index a document: chunk it, embed chunks, store in both indexes.
 * 
 * @param {string} agentId - Agent the document belongs to
 * @param {string} docId - Document ID
 * @param {string} content - Raw text content
 * @param {string} fileName - Original file name
 */
export async function indexDocument(agentId, docId, content, fileName) {
  logger.info({ agentId, docId, fileName, contentLength: content.length }, 'Indexing document');

  // 1. Chunk the document
  const chunks = chunkDocument(content, {
    agentId,
    docId,
    fileName,
    chunkSize: 500,
    overlap: 50,
  });

  if (chunks.length === 0) {
    logger.warn({ docId }, 'No chunks generated from document');
    await db.updateDocument(agentId, docId, { status: 'empty', chunkCount: 0 });
    return;
  }

  logger.info({ docId, chunkCount: chunks.length }, 'Document chunked');

  // 2. Embed chunks in batches
  const allItems = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(c => c.text);

    try {
      const vectors = await embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        allItems.push({
          vector: vectors[j],
          text: batch[j].text,
          metadata: batch[j].metadata,
        });
      }
    } catch (error) {
      logger.error({ docId, batchStart: i, error: error.message }, 'Embedding batch failed');
      await db.updateDocument(agentId, docId, { status: 'error' });
      throw error;
    }
  }

  // 3. Store in vector store
  vectorStore.upsert(agentId, allItems);

  // 4. Store in keyword index (for hybrid search)
  keywordIndex.addToIndex(agentId, allItems.map(item => ({
    text: item.text,
    metadata: item.metadata,
  })));

  // 5. Update document status
  await db.updateDocument(agentId, docId, {
    status: 'ready',
    chunkCount: chunks.length,
  });

  logger.info({ agentId, docId, chunks: chunks.length }, '✅ Document indexed (vector + keyword)');
}

/**
 * Query the knowledge base using hybrid search.
 * 
 * Combines vector similarity and keyword (BM25) scores
 * for better accuracy on both semantic and exact-match queries.
 * 
 * @param {string} agentId - Agent to search
 * @param {string} queryText - Natural language question
 * @param {number} topK - Number of results
 * @returns {Promise<object[]>} Array of { text, score, vectorScore, keywordScore, metadata }
 */
export async function query(agentId, queryText, topK = 3) {
  // Check if agent has any vectors
  const stats = vectorStore.getStats(agentId);
  if (stats.count === 0) {
    return [];
  }

  // Rebuild the in-memory keyword index from persisted vectors if needed
  keywordIndex.ensureSeeded(agentId, () => vectorStore.getAll(agentId));

  // 1. Vector search
  const queryVector = await embedQuery(queryText);
  const vectorResults = vectorStore.search(agentId, queryVector, topK * 3); // Get more candidates

  // 2. Keyword search
  const keywordResults = keywordIndex.keywordSearch(agentId, queryText, topK * 3);

  // 3. Merge results using Reciprocal Rank Fusion (RRF)
  const merged = mergeResults(vectorResults, keywordResults, topK);

  logger.debug({
    agentId,
    query: queryText,
    vectorHits: vectorResults.length,
    keywordHits: keywordResults.length,
    merged: merged.length,
    topScore: merged[0]?.score?.toFixed(3),
  }, '🔍 Hybrid search completed');

  return merged;
}

/**
 * Merge vector and keyword results with weighted scoring.
 */
function mergeResults(vectorResults, keywordResults, topK) {
  const resultMap = new Map(); // text → merged result

  // Normalize keyword scores (0-1 range)
  const maxKeywordScore = keywordResults.length > 0
    ? Math.max(...keywordResults.map(r => r.score))
    : 1;

  // Add vector results
  for (const r of vectorResults) {
    const key = r.text.slice(0, 100); // Use text prefix as key
    resultMap.set(key, {
      text: r.text,
      metadata: r.metadata,
      vectorScore: r.score,
      keywordScore: 0,
      score: 0,
    });
  }

  // Merge keyword results
  for (const r of keywordResults) {
    const key = r.text.slice(0, 100);
    const normalizedScore = r.score / (maxKeywordScore || 1);

    if (resultMap.has(key)) {
      resultMap.get(key).keywordScore = normalizedScore;
    } else {
      resultMap.set(key, {
        text: r.text,
        metadata: r.metadata,
        vectorScore: 0,
        keywordScore: normalizedScore,
        score: 0,
      });
    }
  }

  // Compute combined scores
  for (const r of resultMap.values()) {
    r.score = (VECTOR_WEIGHT * r.vectorScore) + (KEYWORD_WEIGHT * r.keywordScore);
  }

  // Sort by combined score and return top-K
  return Array.from(resultMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Remove a document's vectors and keywords from the stores.
 * @param {string} agentId 
 * @param {string} docId 
 */
export function removeDocument(agentId, docId) {
  vectorStore.deleteByDocument(agentId, docId);
  keywordIndex.removeFromIndex(agentId, docId);
}

/**
 * Get knowledge base stats for an agent.
 * @param {string} agentId 
 */
export function getKnowledgeStats(agentId) {
  return vectorStore.getStats(agentId);
}
