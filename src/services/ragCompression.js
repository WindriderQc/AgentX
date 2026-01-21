/**
 * RAG Contextual Compression Service
 * Uses an LLM to extract only relevant sentences from retrieved chunks
 */

const logger = require('../../config/logger');
const fetch = require('node-fetch');
const { getFetchOptions } = require('../helpers/httpAgent');

class RAGCompressionService {
  constructor() {
    // Use a fast, small model for compression
    this.compressionModel = process.env.COMPRESSION_MODEL || 'gemma2:2b';
    this.compressionCache = new Map(); // Cache compressed results
    this.cacheTTL = parseInt(process.env.COMPRESSION_CACHE_TTL, 10) || 3600000; // 1 hour
    this.ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  }

  /**
   * Compress retrieved chunks by extracting relevant sentences
   * @param {string} query - User's original query
   * @param {Array} chunks - Retrieved RAG chunks with text and metadata
   * @param {Object} options - Compression options
   * @returns {Promise<Array>} Compressed chunks with original metadata preserved
   */
  async compressChunks(query, chunks, options = {}) {
    const {
      compressionModel = this.compressionModel,
      minRelevanceScore = 0.6,  // Only keep sentences scoring ≥0.6
      maxSentencesPerChunk = 5,  // Limit to prevent over-compression
      useCache = true
    } = options;

    if (!chunks || chunks.length === 0) {
      return [];
    }

    logger.info('Starting contextual compression', {
      query: query.substring(0, 50) + '...',
      chunkCount: chunks.length,
      originalTokens: this._estimateTokens(chunks)
    });

    const compressionPromises = chunks.map(async (chunk) => {
      // Check cache first
      const cacheKey = `${query}:${chunk._id || chunk.id}`;
      if (useCache && this.compressionCache.has(cacheKey)) {
        const cached = this.compressionCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTTL) {
          logger.debug('Compression cache hit', { chunkId: chunk._id });
          return cached.result;
        }
      }

      // Perform compression
      const compressed = await this._compressChunk(
        query,
        chunk,
        compressionModel,
        minRelevanceScore,
        maxSentencesPerChunk
      );

      // Cache result
      if (useCache) {
        this.compressionCache.set(cacheKey, {
          result: compressed,
          timestamp: Date.now()
        });
      }

      return compressed;
    });

    const compressedChunks = await Promise.all(compressionPromises);

    // Filter out chunks that became empty after compression
    const validChunks = compressedChunks.filter(c => c.compressedText && c.compressedText.length > 0);

    logger.info('Compression complete', {
      originalChunks: chunks.length,
      compressedChunks: validChunks.length,
      originalTokens: this._estimateTokens(chunks),
      compressedTokens: this._estimateTokens(validChunks, 'compressedText'),
      reductionPercent: this._calculateReduction(chunks, validChunks)
    });

    return validChunks;
  }

  /**
   * Compress a single chunk
   * @private
   */
  async _compressChunk(query, chunk, model, minScore, maxSentences) {
    const systemPrompt = `You are a sentence extraction assistant. Your task is to extract ONLY the sentences from the given text that are directly relevant to answering the user's query.

Rules:
1. Extract complete sentences only (no partial sentences)
2. Preserve original wording exactly (no paraphrasing)
3. Keep sentences in original order
4. If no sentences are relevant, return "NO_RELEVANT_CONTENT"
5. Maximum ${maxSentences} sentences
6. Only include sentences with relevance score ≥${minScore}/1.0

Format your response as a list of sentences. DO NOT include "Here are the sentences" or any conversational text.
[Sentence 1]
[Sentence 2]
...`;

    const userPrompt = `Query: "${query}"

Text to extract from:
${chunk.text}

Extract the most relevant sentences:`;

    try {
      const url = `${this.ollamaHost}/api/generate`;
      const fetchOptions = getFetchOptions(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: userPrompt,
          system: systemPrompt,
          stream: false,
          options: {
            temperature: 0.1,  // Low temperature for consistency
            num_predict: 300,   // Limit response length
            num_ctx: 8192
          }
        })
      });
      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.statusText}`);
      }

      const data = await response.json();
      let extractedText = data.response ? data.response.trim() : '';

      // Post-processing cleanup
      extractedText = extractedText.replace(/^(Here are|Sure|Here is|Below are).*?:\s*/im, '');
      extractedText = extractedText.replace(/^["']|["']$/g, '');
      extractedText = extractedText.replace(/\[Sentence \d+\]:?/gi, ''); // Remove [Sentence 1] markers
      extractedText = extractedText.replace(/^[\*\-]\s*/gm, ''); // Remove bullets
      extractedText = extractedText.replace(/\n\s*\n/g, '\n'); // Remove extra newlines

      // Handle "no content" case
      if (extractedText.includes('NO_RELEVANT_CONTENT') || extractedText.length < 10) {
        logger.debug('No relevant content found in chunk', {
          chunkId: chunk._id,
          query: query.substring(0, 50)
        });
        return {
          ...chunk,
          compressedText: '',
          originalText: chunk.text,
          compressionRatio: 0,
          wasCompressed: true
        };
      }

      // Calculate compression ratio
      const originalLength = chunk.text.length;
      const compressedLength = extractedText.length;
      const compressionRatio = originalLength > 0 
        ? ((originalLength - compressedLength) / originalLength * 100).toFixed(1)
        : 0;

      return {
        ...chunk,
        compressedText: extractedText,
        originalText: chunk.text,
        compressionRatio: parseFloat(compressionRatio),
        wasCompressed: true
      };

    } catch (error) {
      logger.error('Compression failed for chunk', {
        error: error.message,
        chunkId: chunk._id
      });

      // Fallback: return original chunk
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
   * Estimate token count
   * @private
   */
  _estimateTokens(chunks, textField = 'text') {
    return chunks.reduce((total, chunk) => {
      const text = chunk[textField] || '';
      return total + Math.ceil(text.length / 4); // Rough estimate: 4 chars ≈ 1 token
    }, 0);
  }

  /**
   * Calculate compression reduction percentage
   * @private
   */
  _calculateReduction(originalChunks, compressedChunks) {
    const originalTokens = this._estimateTokens(originalChunks);
    const compressedTokens = this._estimateTokens(compressedChunks, 'compressedText');
    const reduction = originalTokens > 0 
        ? ((originalTokens - compressedTokens) / originalTokens * 100).toFixed(1)
        : 0;
    return reduction;
  }

  /**
   * Clear compression cache
   */
  clearCache() {
    this.compressionCache.clear();
    logger.info('Compression cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.compressionCache.size,
      ttl: this.cacheTTL
    };
  }
}

// Export singleton
let instance = null;
function getCompressionService() {
  if (!instance) {
    instance = new RAGCompressionService();
  }
  return instance;
}

module.exports = { getCompressionService };
