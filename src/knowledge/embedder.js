/**
 * Google Embedding Service
 * 
 * Uses Google's text-embedding-004 model to generate embeddings.
 * Supports batching for efficiency.
 */

import config from '../config.js';
import logger from '../utils/logger.js';

const EMBED_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Embed a single text string.
 * @param {string} text 
 * @returns {Promise<number[]>} Embedding vector
 */
export async function embedText(text) {
  const vectors = await embedBatch([text]);
  return vectors[0];
}

/**
 * Embed a batch of text strings.
 * Google's API supports batching via embedContent.
 * 
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
export async function embedBatch(texts) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const model = config.embeddingModel || 'text-embedding-004';
  const url = `${EMBED_API_URL}/${model}:batchEmbedContents?key=${config.geminiApiKey}`;

  // Build batch request
  const requests = texts.map(text => ({
    model: `models/${model}`,
    content: {
      parts: [{ text }]
    },
    taskType: 'RETRIEVAL_DOCUMENT',
  }));

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Embedding API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();

    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error('Unexpected embedding response format');
    }

    return data.embeddings.map(e => e.values);
  } catch (error) {
    logger.error({ error: error.message, textCount: texts.length }, 'Embedding failed');
    throw error;
  }
}

/**
 * Embed a query string (uses RETRIEVAL_QUERY task type for better search).
 * @param {string} query 
 * @returns {Promise<number[]>} Embedding vector
 */
export async function embedQuery(query) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const model = config.embeddingModel || 'text-embedding-004';
  const url = `${EMBED_API_URL}/${model}:embedContent?key=${config.geminiApiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${model}`,
      content: {
        parts: [{ text: query }]
      },
      taskType: 'RETRIEVAL_QUERY',
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return data.embedding.values;
}
