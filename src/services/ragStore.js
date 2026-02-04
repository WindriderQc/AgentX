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
    // If first argument is string, swap them (support old signature: text, metadata)
    if (typeof metadata === 'string' && typeof text === 'object') {
        const temp = metadata;
        metadata = text;
        text = temp;
    }
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
    const existingDoc = await this.vectorStore.getDocument(documentId);
    const contentHash = metadata.hash || this._hashText(text);
    
    if (existingDoc && existingDoc.hash === contentHash) {
      return {
        documentId,
        chunkCount: existingDoc.chunkCount || 0,
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
      ...metadata, // Preserve other metadata fields
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
   * Expand query using LLM to generate related search terms
   * @param {string} query - Original query
   * @param {string} ollamaHost - Ollama host URL
   * @returns {Promise<Array<string>>} Array of related queries (excluding original)
   */
  async expandQuery(query, ollamaHost = null) {
    try {
      const fetch = require('node-fetch');
      const host = ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434';

      // Use small fast model for query expansion (gemma2:2b or fallback)
      const expansionModel = process.env.QUERY_EXPANSION_MODEL || 'gemma2:2b';

      const prompt = `Given this search query: "${query}"

Generate 2-3 related search queries that would help find relevant information. Focus on:
- Synonyms and alternative phrasings
- Related concepts
- More specific or general versions

Return ONLY the queries, one per line, without numbering or explanation.`;

      const response = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: expansionModel,
          prompt,
          stream: false,
          options: {
            temperature: 0.7,
            num_predict: 150, // Short expansion
            num_ctx: 8192
          }
        })
      });

      if (!response.ok) {
        logger.warn('Query expansion failed, using original query only');
        return [];
      }

      const data = await response.json();
      const expandedText = data.response || '';

      // Parse line-separated queries
      const relatedQueries = expandedText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && line.length < 200)
        .filter(line => !line.match(/^\d+[\.\)]/)) // Remove numbered items
        .slice(0, 3); // Max 3 expansions

      logger.info('Query expanded', {
        original: query.substring(0, 50),
        expansionCount: relatedQueries.length
      });

      return relatedQueries;
    } catch (error) {
      logger.error('Query expansion error', { error: error.message });
      return []; // Fallback to original query only
    }
  }

  /**
   * Search for similar chunks using semantic search
   * @param {string} query - Search query
   * @param {Object} options - Search options (topK, minScore, filters, expandQuery)
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
    const useExpansion = options.expandQuery === true;
    const useReranking = options.rerankResults === true;
    const useHybrid = options.hybridSearch === true;

    // Query Expansion (if enabled)
    let allResults = [];

    // Hybrid Search (Vector + Keyword with RRF)
    if (useHybrid) {
      // Run vector search and keyword search in parallel
      const [vectorResults, keywordResults] = await Promise.all([
        (async () => {
          const [queryEmbedding] = await this.embeddings.embedTextBatch([query], ollamaHost);
          return await this.vectorStore.searchSimilar(queryEmbedding, {
            topK: topK * 2, // Get more results for RRF
            minScore,
            filters
          });
        })(),
        this.keywordSearch(query, { topK: topK * 2, filters })
      ]);

      // Merge using Reciprocal Rank Fusion
      allResults = this._reciprocalRankFusion(vectorResults, keywordResults);
      allResults = allResults.slice(0, topK);

      logger.info('Hybrid search completed', {
        query: query.substring(0, 50) + '...',
        vectorCount: vectorResults.length,
        keywordCount: keywordResults.length,
        fusedCount: allResults.length
      });

      // Skip expansion/reranking if hybrid is used (too slow)
      if (allResults.length > 0) {
        return allResults;
      }
    }

    if (useExpansion) {
      const relatedQueries = await this.expandQuery(query, ollamaHost);
      const queriesToSearch = [query, ...relatedQueries];

      // Search with each query
      const searchPromises = queriesToSearch.map(async (q) => {
        const [queryEmbedding] = await this.embeddings.embedTextBatch([q], ollamaHost);
        return await this.vectorStore.searchSimilar(queryEmbedding, {
          topK: Math.ceil(topK / queriesToSearch.length), // Distribute topK across queries
          minScore,
          filters
        });
      });

      const resultsArrays = await Promise.all(searchPromises);
      allResults = resultsArrays.flat();

      // Deduplicate by chunk ID (keep highest score)
      const deduped = new Map();
      for (const result of allResults) {
        const key = `${result.metadata.documentId}:${result.metadata.chunkIndex}`;
        if (!deduped.has(key) || deduped.get(key).score < result.score) {
          deduped.set(key, result);
        }
      }

      allResults = Array.from(deduped.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      logger.info('RAG search with expansion completed', {
        query: query.substring(0, 50) + '...',
        expansionCount: relatedQueries.length,
        resultCount: allResults.length
      });

    } else {
      // Standard search (no expansion)
      const [queryEmbedding] = await this.embeddings.embedTextBatch([query], ollamaHost);

      allResults = await this.vectorStore.searchSimilar(queryEmbedding, {
        topK,
        minScore,
        filters
      });

      logger.info('RAG search completed', {
        query: query.substring(0, 50) + '...',
        resultCount: allResults.length
      });
    }

    // Re-ranking (if enabled)
    if (useReranking && allResults.length > 0) {
      allResults = await this.rerankResults(query, allResults, ollamaHost, topK);
      logger.info('Results re-ranked', {
        query: query.substring(0, 50) + '...',
        finalCount: allResults.length
      });
    }

    return allResults;
  }

  /**
   * Re-rank search results using LLM judge for relevance scoring
   * @param {string} query - Original search query
   * @param {Array} results - Results from vector search
   * @param {string} ollamaHost - Ollama host URL
   * @param {number} topK - Number of results to return after re-ranking
   * @returns {Promise<Array>} Re-ranked results with llmScore added
   */
  async rerankResults(query, results, ollamaHost = null, topK = 5) {
    if (!results || results.length === 0) {
      return results;
    }

    try {
      const fetch = require('node-fetch');
      const host = ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434';

      // Use judge model for relevance scoring (llama3.1:8b or similar)
      const judgeModel = process.env.JUDGE_MODEL || 'llama3.1:8b';

      // Score each result in parallel
      const scoringPromises = results.map(async (result, idx) => {
        const prompt = `You are a relevance judge. Rate how relevant this text is to the query on a scale of 0-10.

Query: "${query}"

Text: "${result.text.substring(0, 500)}"

Return ONLY a number from 0 to 10, where:
- 0 = completely irrelevant
- 5 = somewhat relevant
- 10 = perfectly relevant

Score:`;

        try {
          const response = await fetch(`${host}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: judgeModel,
              prompt,
              stream: false,
              options: {
                temperature: 0.1, // Low temperature for consistent scoring
                num_predict: 10, // Just need a number
                num_ctx: 8192
              }
            })
          });

          if (!response.ok) {
            logger.warn(`Re-ranking failed for result ${idx}`, { status: response.status });
            return { ...result, llmScore: result.score }; // Fallback to vector score
          }

          const data = await response.json();
          const scoreText = (data.response || '').trim();

          // Extract first number from response
          const match = scoreText.match(/(\d+\.?\d*)/);
          const llmScore = match ? Math.min(parseFloat(match[1]), 10) : result.score;

          return {
            ...result,
            llmScore: llmScore / 10, // Normalize to 0-1
            vectorScore: result.score // Preserve original vector score
          };
        } catch (error) {
          logger.warn(`Re-ranking error for result ${idx}`, { error: error.message });
          return { ...result, llmScore: result.score };
        }
      });

      const scoredResults = await Promise.all(scoringPromises);

      // Sort by LLM score (descending) and return top K
      const reranked = scoredResults
        .sort((a, b) => b.llmScore - a.llmScore)
        .slice(0, topK);

      logger.info('Results re-ranked', {
        originalCount: results.length,
        rerankedCount: reranked.length,
        avgLlmScore: (reranked.reduce((sum, r) => sum + r.llmScore, 0) / reranked.length).toFixed(3)
      });

      return reranked;
    } catch (error) {
      logger.error('Re-ranking error', { error: error.message });
      return results.slice(0, topK); // Fallback to original results
    }
  }

  /**
   * Keyword search (full-text search) in documents
   * @param {string} query - Search query
   * @param {Object} options - Search options (topK, filters)
   * @returns {Promise<Array>} Array of {text, score, metadata}
   */
  async keywordSearch(query, options = {}) {
    const topK = options.topK || 10;
    const filters = options.filters || {};

    try {
      // Get all documents from vector store
      const allDocuments = await this.vectorStore.listDocuments(filters);

      if (allDocuments.length === 0) {
        return [];
      }

      // Search for query terms in document chunks
      const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      const results = [];

      for (const doc of allDocuments) {
        // Get all chunks for this document
        const chunks = await this.vectorStore.getDocumentChunks(doc.id);

        if (!chunks) continue;

        for (const chunk of chunks) {
          const text = chunk.text.toLowerCase();
          let score = 0;

          // Calculate score based on term frequency and position
          for (const term of queryTerms) {
            const termCount = (text.match(new RegExp(term, 'g')) || []).length;
            const firstPos = text.indexOf(term);

            if (termCount > 0) {
              // Score: term frequency * position bonus (earlier = better)
              const positionBonus = firstPos >= 0 ? (1.0 - (firstPos / text.length) * 0.5) : 1.0;
              score += termCount * positionBonus;
            }
          }

          if (score > 0) {
            results.push({
              text: chunk.text,
              score: Math.min(score / 10, 1.0), // Normalize to 0-1
              metadata: {
                documentId: doc.id,
                chunkIndex: chunk.chunkIndex || 0,
                source: doc.source,
                title: doc.title,
                searchType: 'keyword'
              }
            });
          }
        }
      }

      // Sort by score and return top K
      return results
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

    } catch (error) {
      logger.error('Keyword search error', { error: error.message });
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion (RRF) to merge ranked lists
   * @param {Array} list1 - First ranked list
   * @param {Array} list2 - Second ranked list
   * @param {number} k - RRF constant (default: 60)
   * @returns {Array} Merged and re-ranked list
   */
  _reciprocalRankFusion(list1, list2, k = 60) {
    const scoreMap = new Map();

    // Calculate RRF scores for list1
    list1.forEach((item, rank) => {
      const key = `${item.metadata.documentId}:${item.metadata.chunkIndex}`;
      const rrfScore = 1 / (k + rank + 1);
      scoreMap.set(key, { item, score: rrfScore });
    });

    // Add/update scores for list2
    list2.forEach((item, rank) => {
      const key = `${item.metadata.documentId}:${item.metadata.chunkIndex}`;
      const rrfScore = 1 / (k + rank + 1);

      if (scoreMap.has(key)) {
        // Item appears in both lists - add scores
        const existing = scoreMap.get(key);
        existing.score += rrfScore;
      } else {
        // Item only in list2
        scoreMap.set(key, { item, score: rrfScore });
      }
    });

    // Convert map to array and sort by RRF score
    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map(entry => ({
        ...entry.item,
        rrfScore: entry.score
      }));
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
   *
   * CRITICAL BUG FIX (2026-01-21):
   * - Added safety limit (MAX_CHUNKS = 10000) to prevent infinite loops
   * - Added minimum advance guarantee: max(50, 10% of chunkSize)
   * - Fixed edge case where chunkSize <= chunkOverlap would cause infinite loop
   * - Ensures nextStart > start always (forced advance if needed)
   *
   * Edge cases handled:
   * - chunkSize = chunkOverlap (e.g., 100 = 100): Forces 10-50 char advance
   * - chunkOverlap > chunkSize (e.g., 200 > 100): Caps overlap to allow progress
   * - Very small chunkSize (e.g., 10): Still guarantees minimum 1 char advance
   *
   * @private
   */
  _splitIntoChunks(text) {
    const chunks = [];
    let start = 0;
    const MAX_CHUNKS = 10000; // Safety limit to prevent infinite loops

    while (start < text.length) {
      // Safety check: prevent infinite loop from bad configuration
      if (chunks.length >= MAX_CHUNKS) {
        logger.error('Chunking safety limit reached', {
          chunkCount: chunks.length,
          chunkSize: this.chunkSize,
          chunkOverlap: this.chunkOverlap,
          textLength: text.length
        });
        break;
      }

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

      // Move start forward with overlap, ensuring we ALWAYS advance
      // Minimum advance: max(50, 10% of chunkSize) to guarantee progress
      const minAdvance = Math.max(50, Math.floor(this.chunkSize * 0.1));
      const overlap = Math.min(this.chunkOverlap, this.chunkSize - minAdvance);
      const nextStart = end - overlap;

      // Critical: Ensure nextStart is always greater than start
      if (nextStart <= start) {
        // Force advance by minimum amount
        const oldStart = start;
        start = oldStart + minAdvance;
        logger.warn('Chunking forced advance', {
          oldStart,
          newStart: start,
          chunkSize: this.chunkSize,
          chunkOverlap: this.chunkOverlap,
          minAdvance
        });
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
