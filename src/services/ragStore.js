/**
 * RAG Store for AgentX V3
 * 
 * Vector store abstraction for document ingestion and semantic search.
 * Current implementation: In-memory vector store with cosine similarity
 * Can be swapped for: Qdrant, Chroma, Pinecone, etc.
 * 
 * Contract: V3_CONTRACT_SNAPSHOT.md § 1
 */

const crypto = require('crypto');
const { getEmbeddingsService } = require('./embeddings');

class RagStore {
  constructor(config = {}) {
    this.embeddings = getEmbeddingsService(config);
    this.documents = new Map(); // documentId -> metadata
    this.vectors = []; // Array of {documentId, chunkIndex, embedding, text, metadata}
    this.chunkSize = config.chunkSize || 800; // Characters per chunk
    this.chunkOverlap = config.chunkOverlap || 100; // Overlap between chunks
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
    console.log(`[RagStore] Embedding ${chunks.length} chunks for document ${documentId}`);
    const embeddings = await this.embeddings.embedTextBatch(chunks, ollamaHost);

    // Remove old chunks if document exists
    if (existingDoc) {
      this._removeDocumentChunks(documentId);
    }

    // Store document metadata
    this.documents.set(documentId, {
      documentId,
      source: metadata.source,
      path: metadata.path,
      title: metadata.title,
      hash: contentHash,
      tags: metadata.tags || [],
      chunkCount: chunks.length,
      createdAt: existingDoc ? existingDoc.createdAt : new Date(),
      updatedAt: new Date(),
    });

    // Store vectors
    for (let i = 0; i < chunks.length; i++) {
      this.vectors.push({
        documentId,
        chunkIndex: i,
        embedding: embeddings[i],
        text: chunks[i],
        metadata: {
          documentId,
          source: metadata.source,
          path: metadata.path,
          title: metadata.title,
          chunkIndex: i,
          tags: metadata.tags || [],
        }
      });
    }

    console.log(`[RagStore] Stored ${chunks.length} chunks for document ${documentId}`);

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

    // Calculate similarities for all vectors
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

    // Filter by min score
    results = results.filter(r => r.score >= minScore);

    // Sort by score descending and take top K
    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, topK);

    console.log(`[RagStore] Query "${query}" returned ${results.length} results`);

    return results;
  }

  /**
   * Get document metadata by ID
   * @param {string} documentId - Document ID
   * @returns {Object|null} Document metadata or null
   */
  getDocument(documentId) {
    return this.documents.get(documentId) || null;
  }

  /**
   * List all documents
   * @param {Object} filters - Optional filters (source, tags)
   * @returns {Array} Array of document metadata
   */
  listDocuments(filters = {}) {
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
   * @param {string} documentId - Document ID
   * @returns {boolean} True if deleted, false if not found
   */
  deleteDocument(documentId) {
    const doc = this.documents.get(documentId);
    if (!doc) return false;

    this.documents.delete(documentId);
    this._removeDocumentChunks(documentId);
    
    console.log(`[RagStore] Deleted document ${documentId}`);
    return true;
  }

  /**
   * Get store statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      documentCount: this.documents.size,
      chunkCount: this.vectors.length,
      avgChunksPerDoc: this.documents.size > 0 
        ? (this.vectors.length / this.documents.size).toFixed(2)
        : 0
    };
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
      let end = start + this.chunkSize;
      
      // Try to break at sentence boundary if possible
      if (end < text.length) {
        const breakPoint = text.lastIndexOf('. ', end);
        if (breakPoint > start && breakPoint > start + this.chunkSize * 0.5) {
          end = breakPoint + 1; // Include the period
        }
      } else {
        end = text.length;
      }

      const chunk = text.substring(start, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      // Move start forward with overlap
      start = end - this.chunkOverlap;
      if (start >= text.length) break;
    }

    return chunks;
  }

  /**
   * Remove all chunks for a document
   * @private
   */
  _removeDocumentChunks(documentId) {
    this.vectors = this.vectors.filter(v => v.documentId !== documentId);
  }

  /**
   * Calculate cosine similarity between two vectors
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
    console.log('[RagStore] Initialized in-memory vector store');
  }
  return ragStoreInstance;
}

module.exports = {
  RagStore,
  getRagStore,
};
