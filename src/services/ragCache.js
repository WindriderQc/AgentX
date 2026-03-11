/**
 * RAG Semantic Cache Service
 * 
 * Implements LRU/similarity-based cache for repeated or near-duplicate RAG queries.
 * Avoids re-embedding and re-searching for similar questions.
 * 
 * Features:
 * - LRU cache with TTL expiration
 * - Similarity-based query matching
 * - Cache hit/miss statistics
 * - Integration with existing RAG system
 */

const logger = require('../../config/logger');
const { EmbeddingsService } = require('./embeddings');
const { RagStore } = require('./ragStore');
const crypto = require('crypto');

class RAGCache {
  constructor(config = {}) {
    this.cacheSize = config.cacheSize || 1000;
    this.ttl = config.ttl || 3600000; // 1 hour
    this.similarityThreshold = config.similarityThreshold || 0.85;
    this.cache = new Map(); // Map<hash, {result, timestamp, embedding}>
    this.hitCount = 0;
    this.missCount = 0;
    this.embeddingService = new EmbeddingsService();
    this.ragStore = new RagStore();
    
    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => this._cleanup(), 60 * 60 * 1000); // Every hour
    if (this.cleanupInterval && typeof this.cleanupInterval.unref === 'function') {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Generate hash for text content
   * @param {string} text - Text to hash
   * @returns {string} SHA256 hash
   * @private
   */
  _hash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /**
   * Check if a query is already cached
   * @param {string} query - User query
   * @returns {Promise<Object|null>} Cached result or null if not found
   */
  async get(query) {
    const queryHash = this._hash(query);
    const entry = this.cache.get(queryHash);

    if (!entry) {
      this.missCount++;
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(queryHash);
      this.missCount++;
      return null;
    }

    // Check similarity with cached embedding
    const cachedEmbedding = entry.embedding;
    const queryEmbedding = await this.embeddingService.embedTextBatch([query]);
    
    if (cachedEmbedding && queryEmbedding.length > 0) {
      const similarity = this._cosineSimilarity(cachedEmbedding[0], queryEmbedding[0]);
      
      if (similarity >= this.similarityThreshold) {
        // Move to end (LRU)
        this.cache.delete(queryHash);
        this.cache.set(queryHash, entry);
        this.hitCount++;
        logger.info('RAG cache hit', { 
          query: query.substring(0, 50) + '.',
          similarity: similarity.toFixed(3)
        });
        return entry.result;
      }
    }

    // Similarity below threshold - treat as cache miss
    this.cache.delete(queryHash);
    this.missCount++;
    return null;
  }

  /**
   * Store query result in cache
   * @param {string} query - User query
   * @param {Object} result - RAG search result
   * @returns {Promise<void>}
   */
  async set(query, result) {
    const queryHash = this._hash(query);
    
    // Evict oldest entry if at capacity (LRU)
    if (this.cache.size >= this.cacheSize && !this.cache.has(queryHash)) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    // Generate embedding for similarity checking
    const queryEmbedding = await this.embeddingService.embedTextBatch([query]);
    
    this.cache.set(queryHash, {
      result,
      timestamp: Date.now(),
      embedding: queryEmbedding
    });
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getStats() {
    const total = this.hitCount + this.missCount;
    const hitRate = total > 0 ? (this.hitCount / total * 100).toFixed(2) : 0;

    return {
      size: this.cache.size,
      maxSize: this.cacheSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: `${hitRate}%`,
      ttl: this.ttl,
      similarityThreshold: this.similarityThreshold
    };
  }

  /**
   * Calculate cosine similarity between two embedding vectors
   * @param {number[]} vec1 - First embedding vector
   * @param {number[]} vec2 - Second embedding vector
   * @returns {number} Similarity score (0-1)
   * @private
   */
  _cosineSimilarity(vec1, vec2) {
    if (vec1.length !== vec2.length) {
      throw new Error('Vectors must have same length');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  /**
   * Remove expired entries
   * @private
   */
  _cleanup() {
    const now = Date.now();
    let removed = 0;

    for (const [hash, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(hash);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug('RAGCache cleanup', { removedEntries: removed });
    }
  }

  /**
   * Clear all cache entries
   */
  clear() {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

  /**
   * Destroy cache and cleanup
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.clear();
  }
}

// Export singleton
let instance = null;
function getRAGCache() {
  if (!instance) {
    instance = new RAGCache();
  }
  return instance;
}

module.exports = {
  RAGCache,
  getRAGCache
};