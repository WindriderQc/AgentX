/**
 * Embedding Cache Service
 * 
 * Caches embeddings to avoid redundant Ollama API calls for identical text.
 * Uses hash-based lookup with configurable in-memory LRU cache.
 * 
 * Expected Impact: 50-80% reduction in embedding API calls for repeated text
 */

const crypto = require('crypto');

class EmbeddingCache {
  constructor(config = {}) {
    this.maxSize = config.maxSize || 1000; // Maximum cache entries
    this.ttl = config.ttl || 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    this.cache = new Map(); // Map<hash, {embedding, timestamp}>
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;

    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => this._cleanup(), 60 * 60 * 1000); // Every hour
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
   * Get embedding from cache if available
   * @param {string} text - Text to look up
   * @returns {number[] | null} Cached embedding or null if not found/expired
   */
  get(text) {
    const hash = this._hash(text);
    const entry = this.cache.get(hash);

    if (!entry) {
      this.missCount++;
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(hash);
      this.missCount++;
      return null;
    }

    // Move to end (LRU)
    this.cache.delete(hash);
    this.cache.set(hash, entry);
    this.hitCount++;
    
    return entry.embedding;
  }

  /**
   * Store embedding in cache
   * @param {string} text - Text that was embedded
   * @param {number[]} embedding - Generated embedding vector
   */
  set(text, embedding) {
    const hash = this._hash(text);

    // Evict oldest entry if at capacity (LRU)
    if (this.cache.size >= this.maxSize && !this.cache.has(hash)) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
      this.evictionCount++;
    }

    this.cache.set(hash, {
      embedding,
      timestamp: Date.now()
    });
  }

  /**
   * Get or compute embedding with cache
   * @param {string} text - Text to embed
   * @param {Function} computeFn - Function to compute embedding if cache miss: (text) => Promise<number[]>
   * @returns {Promise<number[]>} Embedding vector
   */
  async getOrCompute(text, computeFn) {
    // Check cache first
    const cached = this.get(text);
    if (cached) {
      return cached;
    }

    // Cache miss - compute and store
    const embedding = await computeFn(text);
    this.set(text, embedding);
    return embedding;
  }

  /**
   * Clear all cache entries
   */
  clear() {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
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
      console.log(`[EmbeddingCache] Cleaned up ${removed} expired entries`);
    }
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
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      evictionCount: this.evictionCount,
      hitRate: `${hitRate}%`,
      ttl: this.ttl
    };
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

// Singleton instance
let cacheInstance = null;

/**
 * Get or create cache instance
 * @param {Object} config - Cache configuration
 * @returns {EmbeddingCache}
 */
function getCache(config = {}) {
  if (!cacheInstance) {
    cacheInstance = new EmbeddingCache(config);
  }
  return cacheInstance;
}

/**
 * Reset cache instance (for testing)
 */
function resetCache() {
  if (cacheInstance) {
    cacheInstance.destroy();
    cacheInstance = null;
  }
}

module.exports = {
  EmbeddingCache,
  getCache,
  resetCache
};
