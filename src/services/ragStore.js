/**
 * RAG Store for AgentX V3
 * 
 * High-level document management layer with chunking and embedding generation.
 * Uses pluggable vector store backends (in-memory, Qdrant, etc.)
 * 
 * Contract: V3_CONTRACT_SNAPSHOT.md § 1
 */

const crypto = require('crypto');
const path = require('path');
const { getEmbeddingsService } = require('./embeddings');
const { createVectorStore } = require('./vectorStore/factory');
const logger = require(path.join(__dirname, '../../config/logger'));

class RagStore {
  constructor(config = {}) {
    this.embeddings = getEmbeddingsService(config);
    this.vectorStore = createVectorStore(config.vectorStoreType, config);
    this.chunkSize = config.chunkSize || 800; // Characters per chunk
    this.chunkOverlap = config.chunkOverlap || 100; // Overlap between chunks
    logger.info('RagStore initialized', { 
      vectorStore: config.vectorStoreType || 'memory',
      chunkSize: this.chunkSize,
      chunkOverlap: this.chunkOverlap
    });
  }

  /**
   * Upsert a document with automatic chunking and embedding
   * @param {Object} metadata - Document metadata {source, path, title, tags, author, createdAt}
   * @param {string} text - Full document text
   * @param {string} ollamaHost - Optional Ollama host override
   * @returns {Promise<{documentId: string, chunkCount: number, status: string}>}
   */
  async upsertDocumentWithChunks(metadata, text, ollamaHost = null) {
    // Validate inputs
    if (!metadata || typeof metadata !== 'object') {
      throw new Error('metadata must be an object');
    }
    if (!metadata.source || !metadata.path || !metadata.title) {
      throw new Error('metadata must include source, path, and title');
    }
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('text must be a non-empty string');
    }

    // Generate document ID from source + path
    const documentId = this._generateDocumentId(metadata.source, metadata.path);
    
    // Check for existing document with same hash
    const existingDoc = this.documents.get(documentId);
    const contentHash = metadata.hash || this._hashText(text);
    
    if (existingDoc && existingDoc.hash === contentHash) {
      return {
        documentId,
        chunkCount: existingDoc.chunkCount,
        status: 'unchanged'
      };
    }

    // Split text into chunks
    const chunks = this._splitIntoChunks(text);
    
    if (chunks.length === 0) {
      throw new Error('Text produced no chunks (too short?)');
    }

    // Generate embeddings for all chunks
    logger.info('Embedding chunks', { documentId, chunkCount: chunks.length });
    const embeddings = await this.embeddings.embedTextBatch(chunks, ollamaHost);

    // Prepare chunks with embeddings for vector store
    const chunksWithEmbeddings = chunks.map((text, i) => ({
      text,
      embedding: embeddings[i],
      chunkIndex: i
    }));

    // Upsert to vector store
    const result = await this.vectorStore.upsertDocument(documentId, {
      source: metadata.source,
      path: metadata.path,
      title: metadata.title,
      hash: contentHash,
      tags: metadata.tags || [],
      createdAt: existingDoc ? existingDoc.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, chunksWithEmbeddings);

    logger.info('Document upserted to vector store', { 
      documentId, 
      chunkCount: result.chunkCount,
      status: result.status
    });

    return {
      documentId,
      chunkCount: chunks.length,
      status: existingDoc ? 'updated' : 'created'
    };
  }

  /**
   * Search for similar chunks using semantic search
   * @param {string} query - Search query
   * @param {Object} options - Search options (topK, minScore, filters)
   * @returns {Promise<Array>} Array of {text, score, metadata}
   */
  async searchSimilarChunks(query, options = {}) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('query must be a non-empty string');
    }

    const topK = Math.min(options.topK || 5, 20); // Max 20 as per contract
    const minScore = options.minScore !== undefined ? options.minScore : 0.0;
    const filters = options.filters || {};
    const ollamaHost = options.ollamaHost || null;

    // Generate query embedding
    const [queryEmbedding] = await this.embeddings.embedTextBatch([query], ollamaHost);

    // Search using vector store
    const results = await this.vectorStore.searchSimilar(queryEmbedding, {
      topK,
      minScore,
      filters
    });

    logger.info('RAG search completed', { 
      query: query.substring(0, 50) + '...', 
      resultCount: results.length 
    });

    return results;
  }

  /**
   * Get document metadata by ID
   * @param {string} documentId - Document ID
   * @returns {Promise<Object|null>} Document metadata or null
   */
  async getDocument(documentId) {
    return await this.vectorStore.getDocument(documentId);
  }

  /**
   * List all documents
   * @param {Object} filters - Optional filters (source, tags)
   * @returns {Promise<Array>} Array of document metadata
   */
  async listDocuments(filters = {}) {
    return await this.vectorStore.listDocuments(filters);
  }

  /**
   * Delete a document and its chunks
   * @param {string} documentId - Document ID
   * @returns {Promise<boolean>} True if deleted, false if not found
   */
  async deleteDocument(documentId) {
    const deleted = await this.vectorStore.deleteDocument(documentId);
    
    if (deleted) {
      logger.info('Document deleted', { documentId });
    }
    
    return deleted;
  }

  /**
   * Get store statistics
   * @returns {Promise<Object>} Statistics
   */
  async getStats() {
    const stats = await this.vectorStore.getStats();
    
    return {
      ...stats,
      avgChunksPerDoc: stats.documentCount > 0 
        ? (stats.chunkCount / stats.documentCount).toFixed(2)
        : 0
    };
  }

  /**
   * Check vector store health
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    return await this.vectorStore.healthCheck();
  }

  // ========== PRIVATE METHODS ==========

  /**
   * Generate consistent document ID from source and path
   * @private
   */
  _generateDocumentId(source, path) {
    const combined = `${source}:${path}`;
    return crypto.createHash('md5').update(combined).digest('hex');
  }

  /**
   * Generate content hash
   * @private
   */
  _hashText(text) {
    return crypto.createHash('md5').update(text).digest('hex');
  }

  /**
   * Split text into overlapping chunks
   * @private
   */
  _splitIntoChunks(text) {
    const chunks = [];
    let start = 0;

    while (start < text.length) {
      // Find chunk end
      let end = Math.min(start + this.chunkSize, text.length);
      
      // Try to break at sentence boundary if possible
      if (end < text.length) {
        const breakPoint = text.lastIndexOf('. ', end);
        if (breakPoint > start && breakPoint > start + this.chunkSize * 0.5) {
          end = breakPoint + 1; // Include the period
        }
      }

      const chunk = text.substring(start, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      // Move start forward with overlap, ensuring we always advance
      const nextStart = end - this.chunkOverlap;
      if (nextStart <= start) {
        // Prevent infinite loop: if we're not advancing, force move forward
        start = start + Math.max(1, this.chunkSize - this.chunkOverlap);
      } else {
        start = nextStart;
      }
      
      if (start >= text.length) break;
    }

    return chunks;
  }

}

// Singleton instance
let ragStoreInstance = null;

/**
 * Get the singleton RAG store instance
 * @param {Object} config - Configuration options
 * @returns {RagStore}
 */
function getRagStore(config = {}) {
  if (!ragStoreInstance) {
    ragStoreInstance = new RagStore(config);
    logger.info('RagStore singleton initialized');
  }
  return ragStoreInstance;
}

module.exports = {
  RagStore,
  getRagStore,
};
