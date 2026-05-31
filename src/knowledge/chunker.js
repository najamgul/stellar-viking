/**
 * Document Chunker
 * 
 * Splits documents into overlapping chunks for embedding.
 * Uses a sliding window approach with configurable chunk size and overlap.
 */

const DEFAULT_CHUNK_SIZE = 500;     // ~500 chars ≈ ~100 tokens
const DEFAULT_CHUNK_OVERLAP = 50;   // 50 char overlap between chunks

/**
 * Split text into overlapping chunks.
 * 
 * @param {string} text - Raw document text
 * @param {object} options
 * @param {number} options.chunkSize - Max characters per chunk
 * @param {number} options.overlap - Overlap between chunks
 * @param {string} options.fileName - Source file name (for metadata)
 * @param {string} options.agentId - Agent this document belongs to
 * @param {string} options.docId - Document ID
 * @returns {object[]} Array of { text, metadata }
 */
export function chunkDocument(text, options = {}) {
  const {
    chunkSize = DEFAULT_CHUNK_SIZE,
    overlap = DEFAULT_CHUNK_OVERLAP,
    fileName = 'unknown',
    agentId = '',
    docId = '',
  } = options;

  if (!text || text.trim().length === 0) return [];

  // Clean text: normalize whitespace, remove excessive newlines
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Strategy: Split by paragraphs first, then merge into chunks
  const paragraphs = cleaned.split(/\n\n+/);

  const chunks = [];
  let currentChunk = '';
  let chunkIndex = 0;

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // If adding this paragraph would exceed chunk size, flush current chunk
    if (currentChunk.length + trimmed.length + 1 > chunkSize && currentChunk.length > 0) {
      chunks.push({
        text: currentChunk.trim(),
        metadata: {
          agentId,
          docId,
          fileName,
          chunkIndex,
          charStart: 0, // simplified
        }
      });
      chunkIndex++;

      // Keep overlap from end of current chunk
      if (overlap > 0 && currentChunk.length > overlap) {
        currentChunk = currentChunk.slice(-overlap) + '\n\n' + trimmed;
      } else {
        currentChunk = trimmed;
      }
    } else {
      currentChunk = currentChunk ? currentChunk + '\n\n' + trimmed : trimmed;
    }
  }

  // Flush remaining
  if (currentChunk.trim().length > 0) {
    chunks.push({
      text: currentChunk.trim(),
      metadata: {
        agentId,
        docId,
        fileName,
        chunkIndex,
        charStart: 0,
      }
    });
  }

  // Handle case where a single chunk is still too large — force split
  const result = [];
  for (const chunk of chunks) {
    if (chunk.text.length <= chunkSize * 1.5) {
      result.push(chunk);
    } else {
      // Force split by sentences
      const sentences = chunk.text.match(/[^.!?]+[.!?]+/g) || [chunk.text];
      let subChunk = '';
      let subIndex = 0;

      for (const sentence of sentences) {
        if (subChunk.length + sentence.length > chunkSize && subChunk.length > 0) {
          result.push({
            text: subChunk.trim(),
            metadata: { ...chunk.metadata, chunkIndex: chunk.metadata.chunkIndex + subIndex * 0.1 }
          });
          subIndex++;
          subChunk = sentence;
        } else {
          subChunk += sentence;
        }
      }
      if (subChunk.trim()) {
        result.push({
          text: subChunk.trim(),
          metadata: { ...chunk.metadata, chunkIndex: chunk.metadata.chunkIndex + subIndex * 0.1 }
        });
      }
    }
  }

  return result;
}
