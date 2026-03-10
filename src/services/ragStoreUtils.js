'use strict';
/**
 * RAG Store Utilities
 *
 * Pure helper functions extracted from ragStore.js.
 * No class state — all parameters are passed explicitly.
 *
 * Consumed by: src/services/ragStore.js
 */

const crypto = require('crypto');
const path = require('path');
const logger = require(path.join(__dirname, '../../config/logger'));

/**
 * Generate consistent document ID from source and file path.
 * MUST produce the same hash as RagStore._generateDocumentId.
 *
 * @param {string} source
 * @param {string} filePath
 * @returns {string} MD5 hex string
 */
function generateDocumentId(source, filePath) {
  const combined = `${source}:${filePath}`;
  return crypto.createHash('md5').update(combined).digest('hex');
}

/**
 * Generate MD5 content hash from a text string.
 *
 * @param {string} text
 * @returns {string} MD5 hex string
 */
function hashText(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

/**
 * Split text into overlapping chunks.
 *
 * CRITICAL BUG FIX (2026-01-21):
 * - Added safety limit (MAX_CHUNKS = 10000) to prevent infinite loops
 * - Added minimum advance guarantee: max(50, 10% of chunkSize)
 * - Fixed edge case where chunkSize <= chunkOverlap would cause infinite loop
 * - Ensures nextStart > start always (forced advance if needed)
 *
 * Edge cases handled:
 * - chunkSize = chunkOverlap (e.g., 100 = 100): Forces 10-50 char advance
 * - chunkOverlap > chunkSize (e.g., 200 > 100): Caps overlap to allow progress
 * - Very small chunkSize (e.g., 10): Still guarantees minimum 1 char advance
 *
 * @param {string} text
 * @param {number} chunkSize   - Max characters per chunk
 * @param {number} chunkOverlap - Overlap between consecutive chunks
 * @returns {Array<string>}
 */
function splitIntoChunks(text, chunkSize, chunkOverlap) {
  const chunks = [];
  let start = 0;
  const MAX_CHUNKS = 10000; // Safety limit to prevent infinite loops

  while (start < text.length) {
    // Safety check: prevent infinite loop from bad configuration
    if (chunks.length >= MAX_CHUNKS) {
      logger.error('Chunking safety limit reached', {
        chunkCount: chunks.length,
        chunkSize,
        chunkOverlap,
        textLength: text.length
      });
      break;
    }

    // Find chunk end
    let end = Math.min(start + chunkSize, text.length);

    // Try to break at sentence boundary if possible
    if (end < text.length) {
      const breakPoint = text.lastIndexOf('. ', end);
      if (breakPoint > start && breakPoint > start + chunkSize * 0.5) {
        end = breakPoint + 1; // Include the period
      }
    }

    const chunk = text.substring(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    // Move start forward with overlap, ensuring we ALWAYS advance
    // Minimum advance: max(50, 10% of chunkSize) to guarantee progress
    const minAdvance = Math.max(50, Math.floor(chunkSize * 0.1));
    const overlap = Math.min(chunkOverlap, chunkSize - minAdvance);
    const nextStart = end - overlap;

    // Critical: Ensure nextStart is always greater than start
    if (nextStart <= start) {
      // Force advance by minimum amount
      const oldStart = start;
      start = oldStart + minAdvance;
      logger.warn('Chunking forced advance', {
        oldStart,
        newStart: start,
        chunkSize,
        chunkOverlap,
        minAdvance
      });
    } else {
      start = nextStart;
    }

    if (start >= text.length) break;
  }

  return chunks;
}

module.exports = { generateDocumentId, hashText, splitIntoChunks };
