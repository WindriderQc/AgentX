/**
 * Abstract Vector Store Interface
 * 
 * Defines the contract that all vector store implementations must follow.
 * This allows swapping between in-memory, Qdrant, Chroma, Pinecone, etc.
 */

class VectorStoreAdapter {
  /**
   * Initialize the vector store
   * @param {Object} config - Configuration options
   */
  constructor(config = {}) {
    if (this.constructor === VectorStoreAdapter) {
      throw new Error('VectorStoreAdapter is an abstract class and cannot be instantiated directly');
    }
    this.config = config;
  }

  /**
   * Upsert a document with chunks
   * @param {string} documentId - Unique document identifier
   * @param {Object} metadata - Document metadata (source, path, title, tags, etc.)
   * @param {Array<Object>} chunks - Array of {text, embedding, chunkIndex}
   * @returns {Promise<{documentId: string, chunkCount: number, status: string}>}
   */
  async upsertDocument(documentId, metadata, chunks) {
    throw new Error('upsertDocument() must be implemented by subclass');
  }

  /**
   * Search for similar chunks
   * @param {Array<number>} queryEmbedding - Query vector
   * @param {Object} options - {topK, minScore, filters: {source, tags}}
   * @returns {Promise<Array<{text: string, score: number, metadata: Object}>>}
   */
  async searchSimilar(queryEmbedding, options = {}) {
    throw new Error('searchSimilar() must be implemented by subclass');
  }

  /**
   * Get document metadata
   * @param {string} documentId - Document ID
   * @returns {Promise<Object|null>}
   */
  async getDocument(documentId) {
    throw new Error('getDocument() must be implemented by subclass');
  }

  /**
   * List all documents
   * @param {Object} filters - Optional filters {source, tags}
   * @returns {Promise<Array<Object>>}
   */
  async listDocuments(filters = {}) {
    throw new Error('listDocuments() must be implemented by subclass');
  }

  /**
   * Delete a document and all its chunks
   * @param {string} documentId - Document ID
   * @returns {Promise<boolean>} True if deleted
   */
  async deleteDocument(documentId) {
    throw new Error('deleteDocument() must be implemented by subclass');
  }

  /**
   * Get store statistics
   * @returns {Promise<{documentCount: number, chunkCount: number}>}
   */
  async getStats() {
    throw new Error('getStats() must be implemented by subclass');
  }

  /**
   * Health check - verify store is accessible
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    throw new Error('healthCheck() must be implemented by subclass');
  }
}

module.exports = VectorStoreAdapter;
