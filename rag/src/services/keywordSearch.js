/**
 * Keyword Search — BM25-like scoring for full-text search across document chunks.
 *
 * Ported from legacy AgentX ragStore.keywordSearch().
 * Scores: termFrequency * positionBonus (earlier terms weighted higher).
 * Returns normalized 0-1 scores.
 */

'use strict';

const logger = require('../../config/logger');

// Two-letter function words dropped from queries (French and English). Other
// two-letter tokens such as "IA" or "AI" are kept.
const SHORT_STOPWORDS = new Set([
  'de', 'la', 'le', 'du', 'un', 'et', 'en', 'au', 'ce', 'se', 'sa', 'ne', 'ou', 'on', 'il', 'je', 'tu', 'ma', 'me', 'te',
  'of', 'to', 'is', 'in', 'at', 'an', 'as', 'be', 'by', 'or', 'it', 'if', 'no', 'so', 'do', 'we', 'he', 'my'
]);
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Lowercased query terms: edge punctuation stripped, 2-letter stopwords and 1-character tokens dropped. */
function tokenizeQuery(query) {
  const terms = String(query).normalize('NFC').toLowerCase().split(/\s+/)
    .map((token) => token.replace(EDGE_PUNCTUATION, ''))
    .filter((token) => token.length > 2 || (token.length === 2 && !SHORT_STOPWORDS.has(token)));
  return [...new Set(terms)];
}

/** Whole-word matcher; letters and digits on either side (Unicode-aware) prevent a match. */
function termPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
}

/**
 * Calculate BM25-like relevance score for a chunk against query terms.
 *
 * @param {string} text - Chunk text (lowercased)
 * @param {string[]} queryTerms - Lowercased query terms (see tokenizeQuery)
 * @returns {number} Raw score (0 = no match)
 */
function scoreChunk(text, queryTerms) {
  let score = 0;

  for (const term of queryTerms) {
    const matches = [...text.matchAll(termPattern(term))];
    const termCount = matches.length;

    if (termCount > 0) {
      const firstPos = matches[0].index;
      // Position bonus: earlier occurrence = higher bonus
      const positionBonus = 1.0 - (firstPos / text.length) * 0.5;
      score += termCount * positionBonus;
    }
  }

  return score;
}

// Chunks read per query. The store returns chunks containing any query term;
// they are scored here, so the cap bounds work, not result quality on small corpora.
const CANDIDATE_LIMIT = 500;

/**
 * Run keyword search across the vector store.
 *
 * @param {object} vectorStore - VectorStoreAdapter instance
 * @param {string} query - Search query
 * @param {object} options - { topK, filters }
 * @returns {Promise<Array<{text: string, score: number, metadata: object}>>}
 * Store errors propagate so the caller can report a failed keyword search.
 */
async function keywordSearch(vectorStore, query, options = {}) {
  const topK = options.topK || 10;
  const filters = options.filters || {};

  if (typeof vectorStore.findKeywordCandidates !== 'function') {
    logger.warn('Keyword search not supported by current vector store adapter');
    return [];
  }

  const queryTerms = tokenizeQuery(query);
  if (queryTerms.length === 0) {
    return [];
  }

  const candidates = await vectorStore.findKeywordCandidates(queryTerms, { filters, limit: CANDIDATE_LIMIT });
  const results = [];

  for (const chunk of candidates || []) {
    if (!chunk || typeof chunk.text !== 'string') continue;
    const meta = chunk.metadata || {};
    if (!meta.documentId) continue;

    const rawScore = scoreChunk(chunk.text.normalize('NFC').toLowerCase(), queryTerms);
    if (rawScore > 0) {
      results.push({
        text: chunk.text,
        score: Math.min(rawScore / 10, 1.0), // Normalize to 0-1
        metadata: {
          documentId: meta.documentId,
          chunkIndex: chunk.chunkIndex || 0,
          source: meta.source,
          ...(meta.scope ? { scope: meta.scope, sensitivity: meta.sensitivity } : {}),
          title: meta.title,
          searchType: 'keyword'
        }
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

module.exports = { keywordSearch, scoreChunk, tokenizeQuery };
