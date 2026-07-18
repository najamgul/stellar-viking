/**
 * Keyword Search (BM25-style) for Hybrid Retrieval
 * 
 * Implements a TF-IDF/BM25 scoring algorithm for keyword matching.
 * Used alongside vector similarity for hybrid search.
 * 
 * Stores an inverted index per agent for fast keyword lookup.
 */

// agentId → { terms: Map<term, Set<docIndex>>, docs: [{ text, metadata }] }
const indexes = new Map();

// BM25 parameters
const K1 = 1.5;
const B = 0.75;

/**
 * Tokenize text into normalized terms.
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/**
 * Seed the index from a provider if it's empty for this agent.
 * The keyword index lives in memory only; after a restart it must be
 * rebuilt from the persisted vector store or hybrid search silently
 * degrades to vector-only.
 * @param {string} agentId
 * @param {() => object[]} provider - Returns [{ text, metadata }]
 */
export function ensureSeeded(agentId, provider) {
  const idx = indexes.get(agentId);
  if (idx && idx.docs.length > 0) return;
  const items = provider();
  if (items && items.length > 0) {
    addToIndex(agentId, items.map(i => ({ text: i.text, metadata: i.metadata })));
  }
}

/**
 * Add documents to the keyword index.
 * @param {string} agentId
 * @param {object[]} items - Array of { text, metadata }
 */
export function addToIndex(agentId, items) {
  if (!indexes.has(agentId)) {
    indexes.set(agentId, { terms: new Map(), docs: [], avgDl: 0 });
  }

  const idx = indexes.get(agentId);
  const startIndex = idx.docs.length;

  for (let i = 0; i < items.length; i++) {
    const docIndex = startIndex + i;
    idx.docs.push({ text: items[i].text, metadata: items[i].metadata });

    const tokens = tokenize(items[i].text);
    const seen = new Set();

    for (const token of tokens) {
      if (!idx.terms.has(token)) idx.terms.set(token, new Set());
      idx.terms.get(token).add(docIndex);
      seen.add(token);
    }
  }

  // Recompute average document length
  const totalLen = idx.docs.reduce((s, d) => s + tokenize(d.text).length, 0);
  idx.avgDl = totalLen / idx.docs.length;
}

/**
 * Search the keyword index using BM25 scoring.
 * @param {string} agentId
 * @param {string} queryText
 * @param {number} topK
 * @param {string} [filterDocId]
 * @returns {object[]} Array of { text, score, metadata }
 */
export function keywordSearch(agentId, queryText, topK = 10, filterDocId = null) {
  const idx = indexes.get(agentId);
  if (!idx || idx.docs.length === 0) return [];

  const queryTokens = tokenize(queryText);
  if (queryTokens.length === 0) return [];

  const N = idx.docs.length;
  const scores = new Float64Array(N);

  for (const term of queryTokens) {
    const postings = idx.terms.get(term);
    if (!postings) continue;

    const df = postings.size;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

    for (const docIndex of postings) {
      if (filterDocId && idx.docs[docIndex].metadata.docId !== filterDocId) continue;

      const docTokens = tokenize(idx.docs[docIndex].text);
      const tf = docTokens.filter(t => t === term).length;
      const dl = docTokens.length;
      const normTf = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl / idx.avgDl));

      scores[docIndex] += idf * normTf;
    }
  }

  // Rank and return top-K
  const results = [];
  for (let i = 0; i < N; i++) {
    if (scores[i] > 0) {
      if (filterDocId && idx.docs[i].metadata.docId !== filterDocId) continue;
      results.push({
        text: idx.docs[i].text,
        metadata: idx.docs[i].metadata,
        score: scores[i],
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

/**
 * Remove documents from the keyword index.
 * @param {string} agentId
 * @param {string} docId
 */
export function removeFromIndex(agentId, docId) {
  const idx = indexes.get(agentId);
  if (!idx) return;

  // Find and remove matching docs
  const newDocs = idx.docs.filter(d => d.metadata.docId !== docId);
  
  // Rebuild index from scratch (simpler than incremental removal)
  indexes.delete(agentId);
  if (newDocs.length > 0) {
    addToIndex(agentId, newDocs);
  }
}

/**
 * Clear the entire index for an agent.
 * @param {string} agentId
 */
export function clearIndex(agentId) {
  indexes.delete(agentId);
}
