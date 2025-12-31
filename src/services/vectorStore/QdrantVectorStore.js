/**
 * Qdrant Vector Store Implementation
 * 
 * Production-grade vector database with:
 * - Persistent storage
 * - Efficient similarity search (HNSW)
 * - Filtering and metadata support
 * - Horizontal scaling
 * 
 * Setup: Requires Qdrant server running
 * Docker: docker run -p 6333:6333 qdrant/qdrant
 * 
 * Configuration:
 * - QDRANT_URL: http://localhost:6333
 * - QDRANT_COLLECTION: agentx_embeddings
 */

const VectorStoreAdapter = require('./VectorStoreAdapter');

class QdrantVectorStore extends VectorStoreAdapter {
  constructor(config = {}) {
    super(config);
    this.host = config.host || config.url || process.env.QDRANT_URL || process.env.QDRANT_HOST || 'http://localhost:6333';
    this.collection = config.collection || process.env.QDRANT_COLLECTION || 'agentx_embeddings';
    this.fetch = require('node-fetch');
    this.initialized = false;
  }

  /**
   * Initialize Qdrant collection if not exists
   */
  async _ensureCollection() {
    if (this.initialized) return;

    try {
      // Check if collection exists
      const checkRes = await this.fetch(`${this.host}/collections/${this.collection}`);
      
      if (checkRes.status === 404) {
        // Create collection
        const createRes = await this.fetch(`${this.host}/collections/${this.collection}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vectors: {
              size: 768, // nomic-embed-text dimension
              distance: 'Cosine'
            },
            optimizers_config: {
              indexing_threshold: 10000
            }
          })
        });

        if (!createRes.ok) {
          throw new Error(`Failed to create collection: ${await createRes.text()}`);
        }
      }

      this.initialized = true;
    } catch (err) {
      throw new Error(`Qdrant initialization failed: ${err.message}`);
    }
  }

  /**
   * Generate a UUID v5 from documentId and chunkIndex
   * Qdrant requires either UUID or integer
   */
  _generatePointId(documentId, chunkIndex) {
    const crypto = require('crypto');
    const hash = crypto.createHash('md5');
    hash.update(`${documentId}_${chunkIndex}`);
    const hashBuffer = hash.digest();
    
    // Convert to UUID format (RFC 4122)
    hashBuffer[6] = (hashBuffer[6] & 0x0f) | 0x50; // Version 5
    hashBuffer[8] = (hashBuffer[8] & 0x3f) | 0x80; // Variant 10
    
    return [
      hashBuffer.toString('hex', 0, 4),
      hashBuffer.toString('hex', 4, 6),
      hashBuffer.toString('hex', 6, 8),
      hashBuffer.toString('hex', 8, 10),
      hashBuffer.toString('hex', 10, 16)
    ].join('-');
  }

  /**
   * Upsert a document with chunks
   */
  async upsertDocument(documentId, metadata, chunks) {
    await this._ensureCollection();

    // Delete existing document chunks first
    await this.deleteDocument(documentId);

    // Prepare points for Qdrant (use numeric IDs)
    const points = chunks.map(chunk => ({
      id: this._generatePointId(documentId, chunk.chunkIndex),
      vector: chunk.embedding,
      payload: {
        documentId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        ...metadata
      }
    }));

    // Batch upsert
    const response = await this.fetch(`${this.host}/collections/${this.collection}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points })
    });

    if (!response.ok) {
      throw new Error(`Qdrant upsert failed: ${await response.text()}`);
    }

    return {
      documentId,
      chunkCount: chunks.length,
      status: 'created'
    };
  }

  /**
   * List all unique documents in the store
   * @returns {Promise<Array<{documentId: string, title: string, source: string, chunkCount: number}>>}
   */
  async listDocuments() {
    await this._ensureCollection();

    const documents = new Map();
    let nextOffset = null;
    let hasMore = true;

    // Scroll through all points to find unique documents
    // Note: This is inefficient for very large collections, but acceptable for < 100k chunks
    // Optimization: We only fetch payload fields we need
    while (hasMore) {
      const response = await this.fetch(`${this.host}/collections/${this.collection}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          limit: 1000,
          offset: nextOffset,
          with_payload: true,
          with_vector: false
        })
      });

      if (!response.ok) {
        throw new Error(`Qdrant scroll failed: ${await response.text()}`);
      }

      const data = await response.json();
      const points = data.result.points;
      nextOffset = data.result.next_page_offset;

      for (const point of points) {
        const { documentId, title, source } = point.payload;
        if (documentId && !documents.has(documentId)) {
          documents.set(documentId, {
            documentId,
            title: title || 'Untitled',
            source: source || 'unknown',
            chunkCount: 1
          });
        } else if (documentId) {
          const doc = documents.get(documentId);
          doc.chunkCount++;
        }
      }

      if (!nextOffset) {
        hasMore = false;
      }
    }

    return Array.from(documents.values());
  }

  /**
   * Search for similar chunks
   */
  async searchSimilar(queryEmbedding, options = {}) {
    await this._ensureCollection();

    const topK = Math.min(options.topK || 5, 20);
    const minScore = options.minScore !== undefined ? options.minScore : 0.0;
    const filters = options.filters || {};

    // Build Qdrant filter
    const must = [];
    if (filters.source) {
      must.push({ key: 'source', match: { value: filters.source } });
    }
    if (filters.tags && filters.tags.length > 0) {
      must.push({ key: 'tags', match: { any: filters.tags } });
    }

    const searchRequest = {
      vector: queryEmbedding,
      limit: topK,
      score_threshold: minScore,
      with_payload: true,
      ...(must.length > 0 && { filter: { must } })
    };

    const response = await this.fetch(`${this.host}/collections/${this.collection}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(searchRequest)
    });

    if (!response.ok) {
      throw new Error(`Qdrant search failed: ${await response.text()}`);
    }

    const data = await response.json();
    
    return data.result.map(hit => ({
      text: hit.payload.text,
      score: hit.score,
      metadata: {
        documentId: hit.payload.documentId,
        source: hit.payload.source,
        path: hit.payload.path,
        title: hit.payload.title,
        chunkIndex: hit.payload.chunkIndex,
        tags: hit.payload.tags || []
      }
    }));
  }

  /**
   * Get document metadata (aggregated from chunks)
   */
  async getDocument(documentId) {
    await this._ensureCollection();

    // Scroll through points with this documentId
    const response = await this.fetch(`${this.host}/collections/${this.collection}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          must: [{ key: 'documentId', match: { value: documentId } }]
        },
        limit: 1,
        with_payload: true,
        with_vector: false
      })
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (!data.result.points || data.result.points.length === 0) return null;

    const firstChunk = data.result.points[0].payload;
    
    // Count total chunks
    const countRes = await this.fetch(`${this.host}/collections/${this.collection}/points/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          must: [{ key: 'documentId', match: { value: documentId } }]
        }
      })
    });

    const countData = await countRes.json();

    return {
      documentId,
      source: firstChunk.source,
      path: firstChunk.path,
      title: firstChunk.title,
      tags: firstChunk.tags || [],
      chunkCount: countData.result.count,
      createdAt: firstChunk.createdAt,
      updatedAt: firstChunk.updatedAt
    };
  }

  /**
   * List all documents
   */
  async listDocuments(filters = {}) {
    await this._ensureCollection();

    // Build filter
    const must = [];
    if (filters.source) {
      must.push({ key: 'source', match: { value: filters.source } });
    }
    if (filters.tags && filters.tags.length > 0) {
      must.push({ key: 'tags', match: { any: filters.tags } });
    }

    // Get all unique documentIds
    const response = await this.fetch(`${this.host}/collections/${this.collection}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit: 1000,
        with_payload: true,
        with_vector: false,
        ...(must.length > 0 && { filter: { must } })
      })
    });

    if (!response.ok) return [];

    const data = await response.json();
    
    // Group by documentId
    const docMap = new Map();
    for (const point of data.result.points) {
      const docId = point.payload.documentId;
      if (!docMap.has(docId)) {
        docMap.set(docId, {
          documentId: docId,
          source: point.payload.source,
          path: point.payload.path,
          title: point.payload.title,
          tags: point.payload.tags || [],
          chunkCount: 0,
          createdAt: point.payload.createdAt,
          updatedAt: point.payload.updatedAt
        });
      }
      docMap.get(docId).chunkCount++;
    }

    return Array.from(docMap.values());
  }

  /**
   * Delete a document and all its chunks
   */
  async deleteDocument(documentId) {
    await this._ensureCollection();

    const response = await this.fetch(`${this.host}/collections/${this.collection}/points/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          must: [{ key: 'documentId', match: { value: documentId } }]
        }
      })
    });

    if (!response.ok) return false;

    const data = await response.json();
    return data.result.operation_id !== undefined;
  }

  /**
   * Get store statistics
   */
  async getStats() {
    await this._ensureCollection();

    const response = await this.fetch(`${this.host}/collections/${this.collection}`);
    
    if (!response.ok) {
      return { documentCount: 0, chunkCount: 0 };
    }

    const data = await response.json();
    
    // Get unique document count
    const docsResponse = await this.fetch(`${this.host}/collections/${this.collection}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit: 10000,
        with_payload: ['documentId'],
        with_vector: false
      })
    });

    const docsData = await docsResponse.json();
    const uniqueDocs = new Set(docsData.result.points.map(p => p.payload.documentId));

    return {
      documentCount: uniqueDocs.size,
      chunkCount: data.result.points_count || 0
    };
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const response = await this.fetch(`${this.host}/healthz`, {
        timeout: 2000
      });
      return response.ok;
    } catch (err) {
      return false;
    }
  }
}

module.exports = QdrantVectorStore;
