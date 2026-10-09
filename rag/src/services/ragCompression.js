/**
 * RAG Contextual Compression Service
 *
 * Uses a small LLM to extract only the relevant sentences from retrieved chunks,
 * reducing token count before context injection. Ported from legacy AgentX monolith.
 *
 * Routed via Core task type `rag_compression`, so RAG does not own model
 * selection or host placement.
 * Features: LRU cache with TTL, compression-ratio metrics, graceful fallback.
 */

'use strict';

const crypto = require('crypto');
const fetchWithTimeout = require('../utils/fetchWithTimeout');
const {
  SERVICE_OUTBOUND_OPERATION_IDS,
  SERVICE_OUTBOUND_TIMEOUTS,
  configuredServiceOrigin,
} = require('../clients/serviceOutboundClient');
const { boundedConcurrency } = require('../utils/boundedConcurrency');
const logger = require('../../config/logger');

const CORE_PROXY_URL = configuredServiceOrigin(process.env.CORE_PROXY_URL || 'http://localhost:3080');
const COMPRESSION_TIMEOUT = SERVICE_OUTBOUND_TIMEOUTS[
  SERVICE_OUTBOUND_OPERATION_IDS.COMPRESSION_GENERATE
];
const COMPRESSION_CONCURRENCY = Number(process.env.COMPRESSION_CONCURRENCY) || 2;

class RAGCompressionService {
  constructor() {
    this.compressionCache = new Map();
    this.cacheTTL = parseInt(process.env.COMPRESSION_CACHE_TTL, 10) || 3600000; // 1 hour
  }

  /**
   * Compress retrieved chunks by extracting only relevant sentences via LLM.
   *
   * @param {string} query - User's original query
   * @param {Array} chunks - Retrieved RAG chunks with text and metadata
   * @param {Object} options - Compression options
   * @returns {Promise<Array>} Compressed chunks with original metadata preserved
   */
  async compressChunks(query, chunks, options = {}) {
    const {
      minRelevanceScore = 0.6,
      maxSentencesPerChunk = 5,
      useCache = true
    } = options;

    if (!chunks || chunks.length === 0) {
      return [];
    }

    const originalTokens = this._estimateTokens(chunks);

    logger.info('Starting contextual compression', {
      queryLength: query.length,
      chunkCount: chunks.length,
      originalTokens
    });

    // Bounded fan-out — one LLM call per chunk; unbounded Promise.all on
    // 50 chunks would saturate the compression host and evict its KV cache.
    // Tune via COMPRESSION_CONCURRENCY env var.
    const compressedChunks = await boundedConcurrency(chunks, async (chunk) => {
      // Check cache first
      const cacheKey = this._buildCacheKey(query, chunk, minRelevanceScore, maxSentencesPerChunk);
      if (useCache && this.compressionCache.has(cacheKey)) {
        const cached = this.compressionCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTTL) {
          logger.debug('Compression cache hit');
          return cached.result;
        }
        // Expired — remove stale entry
        this.compressionCache.delete(cacheKey);
      }

      const compressed = await this._compressChunk(
        query, chunk, minRelevanceScore, maxSentencesPerChunk
      );

      if (useCache) {
        this.compressionCache.set(cacheKey, {
          result: compressed,
          timestamp: Date.now()
        });
      }

      return compressed;
    }, COMPRESSION_CONCURRENCY);

    // Filter out chunks that became empty after compression
    const validChunks = compressedChunks.filter(c => c.compressedText && c.compressedText.length > 0);

    const compressedTokens = this._estimateTokens(validChunks, 'compressedText');
    const reductionPercent = this._calculateReduction(chunks, validChunks);

    logger.debug('Compression complete', {
      originalChunks: chunks.length,
      compressedChunks: validChunks.length,
      originalTokens,
      compressedTokens,
      reductionPercent
    });

    return validChunks;
  }

  /**
   * Build stable cache key for a query/chunk pair.
   * Include content and selection policy even when the chunk has an identifier.
   * @private
   */
  _buildCacheKey(query, chunk, minScore = 0.6, maxSentences = 5) {
    const metadata = chunk && chunk.metadata ? chunk.metadata : {};
    const documentId = metadata.documentId || chunk.documentId || chunk._id || chunk.id || '';
    const chunkIndex = metadata.chunkIndex ?? chunk.chunkIndex ?? '';

    const textHash = crypto
      .createHash('sha256')
      .update(chunk && typeof chunk.text === 'string' ? chunk.text : '')
      .digest('hex');
    return JSON.stringify([query, documentId, chunkIndex, textHash, minScore, maxSentences]);
  }

  // A compression is an extract, so every complete sentence must occur in the
  // source in the same order. Unverifiable output keeps the original context.
  _isSourceExtract(source, extract, maximum) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    const sentences = text => Array.from(segmenter.segment(text), part => part.segment.trim()).filter(Boolean);
    const original = sentences(source);
    const selected = extract.split('\n').flatMap(sentences);
    if (!selected.length || selected.length > maximum) return false;
    let next = 0;
    return selected.every(sentence => {
      const index = original.indexOf(sentence, next);
      if (index < 0) return false;
      next = index + 1;
      return true;
    });
  }

  /**
   * Compress a single chunk via LLM sentence extraction.
   * @private
   */
  async _compressChunk(query, chunk, minScore, maxSentences) {
    const systemPrompt = `You are a sentence extraction assistant. Your task is to extract ONLY the sentences from the given text that are directly relevant to answering the user's query.

Rules:
1. Extract complete sentences only (no partial sentences)
2. Preserve original wording exactly (no paraphrasing)
3. Keep sentences in original order
4. If no sentences are relevant, return "NO_RELEVANT_CONTENT"
5. Maximum ${maxSentences} sentences
6. Only include sentences with relevance score >= ${minScore}/1.0

Return ONLY the extracted sentences, one per line. No numbering, no commentary.`;

    const userPrompt = `Query: "${query}"

Text to extract from:
${chunk.text}

Extract the most relevant sentences:`;

    try {
      const url = `${CORE_PROXY_URL}/api/inference/generate`;

      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskType: 'rag_compression',
          prompt: userPrompt,
          system: systemPrompt,
          stream: false,
          responseMode: 'normalized',
          think: false,
          callerDetail: 'rag-compression',
          options: {
            temperature: 0.1,
            num_predict: 300
          }
        })
      }, COMPRESSION_TIMEOUT, {
        expectedOrigins: [CORE_PROXY_URL],
        operationId: SERVICE_OUTBOUND_OPERATION_IDS.COMPRESSION_GENERATE,
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (data.done === false || /length|max(?:imum)?[_ -]?tokens|token_limit/i.test(data.done_reason || '')) {
        throw new Error('Compression output is incomplete');
      }
      let extractedText = data.response ? data.response.trim() : '';

      // Post-processing cleanup
      extractedText = extractedText.replace(/^(Here are|Sure|Here is|Below are).*?:\s*/im, '');
      extractedText = extractedText.replace(/^["']|["']$/g, '');
      extractedText = extractedText.replace(/\[Sentence \d+\]:?/gi, '');
      extractedText = extractedText.replace(/^[\*\-]\s*/gm, '');
      extractedText = extractedText.replace(/\n\s*\n/g, '\n');
      extractedText = extractedText.trim();

      // Handle "no content" case
      if (extractedText === 'NO_RELEVANT_CONTENT') {
        logger.debug('No relevant content found in chunk', {
          queryLength: query.length
        });
        return {
          ...chunk,
          compressedText: '',
          originalText: chunk.text,
          compressionRatio: 0,
          wasCompressed: true
        };
      }

      if (!this._isSourceExtract(chunk.text, extractedText, maxSentences)) {
        throw new Error('Compression output is not an exact source sentence extract');
      }

      const originalLength = chunk.text.length;
      const compressedLength = extractedText.length;
      const compressionRatio = originalLength > 0
        ? parseFloat(((originalLength - compressedLength) / originalLength * 100).toFixed(1))
        : 0;

      return {
        ...chunk,
        compressedText: extractedText,
        originalText: chunk.text,
        compressionRatio,
        wasCompressed: true
      };
    } catch (error) {
      logger.error('Compression failed for chunk', { error: error.message });

      // Fallback: return original chunk unmodified
      return {
        ...chunk,
        compressedText: chunk.text,
        originalText: chunk.text,
        compressionRatio: 0,
        wasCompressed: false,
        compressionError: error.message
      };
    }
  }

  /**
   * Estimate token count (rough: 4 chars ~ 1 token).
   * @private
   */
  _estimateTokens(chunks, textField = 'text') {
    return chunks.reduce((total, chunk) => {
      const text = chunk[textField] || '';
      return total + Math.ceil(text.length / 4);
    }, 0);
  }

  /**
   * Calculate compression reduction percentage.
   * @private
   */
  _calculateReduction(originalChunks, compressedChunks) {
    const originalTokens = this._estimateTokens(originalChunks);
    const compressedTokens = this._estimateTokens(compressedChunks, 'compressedText');
    if (originalTokens === 0) return 0;
    return parseFloat(((originalTokens - compressedTokens) / originalTokens * 100).toFixed(1));
  }

  /** Clear all cached compression results. */
  clearCache() {
    this.compressionCache.clear();
    logger.info('Compression cache cleared');
  }

  /** Get cache statistics. */
  getCacheStats() {
    return {
      size: this.compressionCache.size,
      ttl: this.cacheTTL
    };
  }
}

let instance = null;

function getCompressionService() {
  if (!instance) {
    instance = new RAGCompressionService();
  }
  return instance;
}

/** Reset singleton (for testing). */
function resetCompressionService() {
  instance = null;
}

module.exports = { RAGCompressionService, getCompressionService, resetCompressionService };
