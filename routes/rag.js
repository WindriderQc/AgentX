/**
 * RAG Routes for AgentX V3
 * 
 * Implements ingestion and search endpoints for n8n integration.
 * Contract: V3_CONTRACT_SNAPSHOT.md § 2
 * 
 * Endpoints:
 * - POST /api/rag/ingest - Ingest documents from n8n
 * - POST /api/rag/search - Semantic search for debugging
 */

const express = require('express');
const router = express.Router();
const { getRagStore } = require('../src/services/ragStore');

// Initialize RAG store
const ragStore = getRagStore();

// Helper to resolve Ollama target
function resolveTarget(target) {
  const fallback = 'http://localhost:11434';
  if (!target || typeof target !== 'string') return fallback;
  const trimmed = target.trim();
  if (!trimmed) return fallback;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return `http://${trimmed.replace(/\/+$/, '')}`;
}

/**
 * POST /api/rag/ingest
 * 
 * Ingest a document into the RAG system.
 * Called by n8n workflows to add documents for semantic search.
 * 
 * Contract: V3_CONTRACT_SNAPSHOT.md § 2.1
 */
router.post('/ingest', async (req, res) => {
  try {
    // Extract and validate required fields
    const { source, path, title, text, hash, tags, metadata, target } = req.body;
    
    // Resolve Ollama host (use target if provided, otherwise fall back to default)
    const ollamaHost = target ? resolveTarget(target) : null;

    // Validation per contract
    if (!source || typeof source !== 'string') {
      return res.status(400).json({
        error: 'Validation error',
        details: {
          field: 'source',
          message: 'source is required and must be a string'
        }
      });
    }

    // Validate source format (alphanumeric, underscore, hyphen only)
    if (!/^[a-zA-Z0-9_-]+$/.test(source)) {
      return res.status(400).json({
        error: 'Validation error',
        details: {
          field: 'source',
          message: 'source must match pattern: ^[a-zA-Z0-9_-]+$'
        }
      });
    }

    if (!path || typeof path !== 'string') {
      return res.status(400).json({
        error: 'Validation error',
        details: {
          field: 'path',
          message: 'path is required and must be a string'
        }
      });
    }

    if (!title || typeof title !== 'string') {
      return res.status(400).json({
        error: 'Validation error',
        details: {
          field: 'title',
          message: 'title is required and must be a string'
        }
      });
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({
        error: 'Validation error',
        details: {
          field: 'text',
          message: 'text is required and must be a non-empty string'
        }
      });
    }

    // Validate tags if provided
    if (tags !== undefined && !Array.isArray(tags)) {
      return res.status(400).json({
        error: 'Validation error',
        details: {
          field: 'tags',
          message: 'tags must be an array of strings'
        }
      });
    }

    // Build metadata object
    const docMetadata = {
      source,
      path,
      title,
      hash,
      tags: Array.isArray(tags) ? tags : [],
      ...metadata // Allow additional metadata from n8n
    };

    // Upsert document (pass ollamaHost for dynamic embedding service)
    const result = await ragStore.upsertDocumentWithChunks(docMetadata, text, ollamaHost);

    // Return response matching contract exactly
    // DO NOT add extra fields - n8n parses this!
    res.json({
      status: result.status,
      documentId: result.documentId,
      chunkCount: result.chunkCount
    });

    console.log(`[RAG Ingest] ${result.status}: ${result.documentId} (${result.chunkCount} chunks)`);

  } catch (error) {
    console.error('[RAG Ingest] Error:', error);
    
    // Check if it's a service availability error
    if (error.message.includes('Ollama') || error.message.includes('embedding')) {
      return res.status(503).json({
        error: 'Service Unavailable',
        message: 'Embeddings service (Ollama) is not available'
      });
    }

    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * POST /api/rag/search
 * 
 * Semantic search for relevant document chunks.
 * Used for debugging and n8n testing.
 * 
 * Contract: V3_CONTRACT_SNAPSHOT.md § 2.2
 */
router.post('/search', async (req, res) => {
  try {
    const { query, topK, minScore, filters, target } = req.body;
    
    // Resolve Ollama host
    const ollamaHost = target ? resolveTarget(target) : null;

    // Validation
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({
        error: 'Validation error',
        details: {
          field: 'query',
          message: 'query is required and must be a non-empty string'
        }
      });
    }

    // Validate topK range per contract (1-20)
    if (topK !== undefined) {
      const topKNum = Number(topK);
      if (isNaN(topKNum) || topKNum < 1 || topKNum > 20) {
        return res.status(400).json({
          error: 'Validation error',
          details: {
            field: 'topK',
            message: 'topK must be a number between 1 and 20'
          }
        });
      }
    }

    // Validate minScore range (0-1)
    if (minScore !== undefined) {
      const minScoreNum = Number(minScore);
      if (isNaN(minScoreNum) || minScoreNum < 0 || minScoreNum > 1) {
        return res.status(400).json({
          error: 'Validation error',
          details: {
            field: 'minScore',
            message: 'minScore must be a number between 0.0 and 1.0'
          }
        });
      }
    }

    // Perform search
    const results = await ragStore.searchSimilarChunks(query, {
      topK,
      minScore,
      filters,
      ollamaHost
    });

    // Return response matching contract
    res.json({
      query,
      resultCount: results.length,
      results
    });

    console.log(`[RAG Search] Query "${query}" -> ${results.length} results`);

  } catch (error) {
    console.error('[RAG Search] Error:', error);
    
    // Check if it's a service availability error
    if (error.message.includes('Ollama') || error.message.includes('embedding')) {
      return res.status(503).json({
        error: 'Service Unavailable',
        message: 'Embeddings service (Ollama) is not available'
      });
    }

    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * GET /api/rag/documents
 * 
 * List all documents in the RAG store (for debugging).
 * NOT in contract but useful for development.
 */
router.get('/documents', (req, res) => {
  try {
    const { source, tags } = req.query;
    const filters = {};
    
    if (source) filters.source = source;
    if (tags) filters.tags = tags.split(',');

    const documents = ragStore.listDocuments(filters);
    const stats = ragStore.getStats();

    res.json({
      stats,
      count: documents.length,
      documents
    });
  } catch (error) {
    console.error('[RAG Documents] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * DELETE /api/rag/documents/:documentId
 * 
 * Delete a document from the RAG store (for debugging).
 * NOT in contract but useful for development.
 */
router.delete('/documents/:documentId', (req, res) => {
  try {
    const { documentId } = req.params;
    const deleted = ragStore.deleteDocument(documentId);

    if (!deleted) {
      return res.status(404).json({
        error: 'Not found',
        message: `Document ${documentId} not found`
      });
    }

    res.json({
      message: 'Document deleted successfully',
      documentId
    });
  } catch (error) {
    console.error('[RAG Delete] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;
