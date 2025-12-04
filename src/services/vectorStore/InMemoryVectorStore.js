/**
 * In-Memory Vector Store Implementation
 * 
 * Fast, simple vector store using in-memory data structures.
 * Suitable for development and small-scale deployments.
 * 
 * Limitations:
 * - Data lost on restart (not persistent)
 * - Memory constrained (limited by RAM)
 * - No distributed search
 */

const VectorStoreAdapter = require('./VectorStoreAdapter');

class InMemoryVectorStore extends VectorStoreAdapter {
  constructor(config = {}) {
    super(config);
    this.documents = new Map(); // documentId -> metadata
    this.vectors = []; // Array of {documentId, chunkIndex, embedding, text, metadata}
  }

  /**
   * Upsert a document with its chunks
   */
  async upsertDocument(documentId, metadata, chunks) {
    // Remove old chunks if document exists
    const existingDoc = this.documents.get(documentId);
    if (existingDoc) {
      this.vectors = this.vectors.filter(v => v.documentId !== documentId);
    }

    // Store document metadata
    this.documents.set(documentId, {
      documentId,
      ...metadata,
      chunkCount: chunks.length,
      createdAt: existingDoc ? existingDoc.createdAt : new Date(),
      updatedAt: new Date(),
    });

    // Store vectors
    for (const chunk of chunks) {
      this.vectors.push({
        documentId,
        chunkIndex: chunk.chunkIndex,
        embedding: chunk.embedding,
        text: chunk.text,
        metadata: {
          documentId,
          ...metadata,
          chunkIndex: chunk.chunkIndex,
        }
      });
    }

    return {
      documentId,
      chunkCount: chunks.length,
      status: existingDoc ? 'updated' : 'created'
    };
  }

  /**
   * Search for similar chunks using cosine similarity
   */
  async searchSimilar(queryEmbedding, options = {}) {
    const topK = Math.min(options.topK || 5, 20);
    const minScore = options.minScore !== undefined ? options.minScore : 0.0;
    const filters = options.filters || {};

    // Calculate similarities
    let results = this.vectors.map(vec => {
      const score = this._cosineSimilarity(queryEmbedding, vec.embedding);
      return {
        text: vec.text,
        score,
        metadata: vec.metadata
      };
    });

    // Apply filters
    if (filters.source) {
      results = results.filter(r => r.metadata.source === filters.source);
    }
    if (filters.tags && filters.tags.length > 0) {
      results = results.filter(r => 
        r.metadata.tags && r.metadata.tags.some(tag => filters.tags.includes(tag))
      );
    }

    // Filter by min score and sort
    results = results
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return results;
  }

  /**
   * Get document metadata
   */
  async getDocument(documentId) {
    return this.documents.get(documentId) || null;
  }

  /**
   * List all documents with optional filters
   */
  async listDocuments(filters = {}) {
    let docs = Array.from(this.documents.values());

    if (filters.source) {
      docs = docs.filter(d => d.source === filters.source);
    }
    if (filters.tags && filters.tags.length > 0) {
      docs = docs.filter(d => 
        d.tags && d.tags.some(tag => filters.tags.includes(tag))
      );
    }

    return docs;
  }

  /**
   * Delete a document and its chunks
   */
  async deleteDocument(documentId) {
    const doc = this.documents.get(documentId);
    if (!doc) return false;

    this.documents.delete(documentId);
    this.vectors = this.vectors.filter(v => v.documentId !== documentId);
    
    return true;
  }

  /**
   * Get store statistics
   */
  async getStats() {
    return {
      documentCount: this.documents.size,
      chunkCount: this.vectors.length
    };
  }

  /**
   * Health check
   */
  async healthCheck() {
    return true; // In-memory store is always healthy if initialized
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  _cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

module.exports = InMemoryVectorStore;
