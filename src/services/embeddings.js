/**
 * Embeddings Service for AgentX V3 RAG
 * 
 * Generates vector embeddings using Ollama's local embedding models.
 * Provides a clean abstraction that can be swapped for other providers.
 * 
 * Features:
 * - Batch embedding generation
 * - Automatic caching to reduce API calls (50-80% reduction)
 * - LRU cache with TTL expiration
 * 
 * Contract: V3_CONTRACT_SNAPSHOT.md § 4
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const { getCache } = require('./embeddingCache');
const logger = require('../../config/logger');

class EmbeddingsService {
  constructor(config = {}) {
    this.ollamaHost = config.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.model = config.embeddingModel || process.env.EMBEDDING_MODEL || 'nomic-embed-text';
    this.dimension = 768; // nomic-embed-text default dimension
    this.batchSize = 10; // Process in batches to avoid memory issues
    this.cache = getCache({
      maxSize: config.cacheSize || 1000,
      ttl: config.cacheTtl || 24 * 60 * 60 * 1000 // 24 hours
    });
    this.cacheEnabled = config.cacheEnabled !== false; // Default: enabled
  }

  /**
   * Set Ollama host dynamically
   * @param {string} host - Ollama host URL (e.g., 'http://192.168.2.99:11434')
   */
  setOllamaHost(host) {
    if (host && typeof host === 'string') {
      this.ollamaHost = host.startsWith('http') ? host : `http://${host}`;
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   * @param {string[]} texts - Array of text strings to embed
   * @param {string} ollamaHost - Optional Ollama host override
   * @returns {Promise<number[][]>} Array of embedding vectors
   */
  async embedTextBatch(texts, ollamaHost = null) {
    const host = ollamaHost || this.ollamaHost;
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error('texts must be a non-empty array');
    }

    const results = [];
    
    // Process in batches to avoid overwhelming Ollama
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchResults = await Promise.all(
        batch.map(text => this._embedSingle(text, host))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Generate embedding for a single text
   * @param {string} text - Text to embed
   * @param {string} host - Ollama host URL
   * @returns {Promise<number[]>} Embedding vector
   * @private
   */
  async _embedSingle(text, host = null) {
    const ollamaHost = host || this.ollamaHost;
    if (!text || typeof text !== 'string') {
      throw new Error('text must be a non-empty string');
    }

    // Truncate very long texts (Ollama has token limits)
    const truncatedText = text.length > 8000 ? text.substring(0, 8000) : text;

    // Try cache first if enabled
    if (this.cacheEnabled) {
      return await this.cache.getOrCompute(truncatedText, async (text) => {
        return await this._generateEmbedding(text, ollamaHost);
      });
    }

    // Cache disabled - compute directly
    return await this._generateEmbedding(truncatedText, ollamaHost);
  }

  /**
   * Generate embedding from Ollama API (no caching)
   * @param {string} text - Text to embed
   * @param {string} ollamaHost - Ollama host URL
   * @returns {Promise<number[]>} Embedding vector
   * @private
   */
  async _generateEmbedding(text, ollamaHost) {
    try {
      const response = await fetch(`${ollamaHost}/api/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt: text,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama embeddings API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Invalid response from Ollama embeddings API');
      }

      return data.embedding;
    } catch (error) {
      console.error('[Embeddings] Error generating embedding:', error.message);
      throw new Error(`Failed to generate embedding: ${error.message}`);
    }
  }

  /**
   * Get the dimension of embeddings produced by this model
   * @returns {number} Embedding dimension
   */
  getDimension() {
    return this.dimension;
  }

  /**
   * Test connection to Ollama embeddings service
   * @returns {Promise<boolean>} True if connection successful
   */
  async testConnection() {
    try {
      const embedding = await this._embedSingle('test');
      return Array.isArray(embedding) && embedding.length === this.dimension;
    } catch (error) {
      console.error('[Embeddings] Connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats including hit rate
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Clear embedding cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Calculate cosine similarity between two embedding vectors
   * @param {number[]} vec1 - First embedding vector
   * @param {number[]} vec2 - Second embedding vector
   * @returns {number} Similarity score (0-1)
   */
  static cosineSimilarity(vec1, vec2) {
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
}

// Singleton instance
let embeddingsServiceInstance = null;

/**
 * Get the singleton embeddings service instance
 * @param {Object} config - Configuration options
 * @returns {EmbeddingsService}
 */
function getEmbeddingsService(config = {}) {
  if (!embeddingsServiceInstance) {
    embeddingsServiceInstance = new EmbeddingsService(config);
    logger.info('EmbeddingsService initialized', { model: embeddingsServiceInstance.model });
  }
  return embeddingsServiceInstance;
}

module.exports = {
  EmbeddingsService,
  getEmbeddingsService,
};
