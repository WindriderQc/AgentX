/**
 * RAG Routes for AgentX V3
 *
 * Implements ingestion and search endpoints for n8n integration.
 * Contract: V3_CONTRACT_SNAPSHOT.md § 2
 *
 * Endpoints:
 * - POST /api/rag/ingest - Ingest documents from n8n
 * - POST /api/rag/search - Semantic search for debugging
 * - GET /api/rag/watcher/status - Get file watcher status
 * - POST /api/rag/watcher/trigger-scan - Manually trigger folder scan
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const mongoose = require('mongoose');
const { getRagStore } = require('../src/services/ragStore');
const { resolveTarget } = require('../src/utils');
const logger = require('../config/logger');
const n8nAuth = require('../src/middleware/n8nAuth');
const RagManifest = require('../models/RagManifest');

// Global reference to RAG watcher (set during server startup)
const routeId = Math.random();

console.log('RAG routes loaded, ID:', routeId);

// Legacy function for backward compatibility - no longer used
function setRagWatcherInstance(watcher) {
  console.log('setRagWatcherInstance called (legacy), route ID:', routeId, 'watcher:', !!watcher);
  // This function is kept for module export compatibility but no longer used
  // The watcher instance is now stored in app.locals
}

// Get watcher instance from app.locals (set by server.js)
function getRagWatcherInstance() {
  try {
    const { app } = require('../src/app');
    console.log('App instance found:', !!app);
    console.log('App.locals exists:', !!app.locals);
    console.log('App.locals.ragWatcherInstance exists:', !!app.locals?.ragWatcherInstance);
    if (app && app.locals && app.locals.ragWatcherInstance) {
      console.log('Returning watcher from app.locals');
      return app.locals.ragWatcherInstance;
    }
  } catch (e) {
    console.log('Error accessing app:', e.message);
  }

  console.log('No watcher instance found in app.locals');
  return null;
}

function classifyRagAvailabilityError(error) {
  const message = error?.message || '';
  const stack = error?.stack || '';
  const combined = `${message}\n${stack}`;

  // Vector store (Qdrant) issues can include the collection name `agentx_embeddings`
  // which would otherwise be misclassified as an embeddings failure.
  if (/(qdrant|QdrantVectorStore|\b6333\b|ECONNREFUSED.*6333|agentx_embeddings)/i.test(combined)) {
    return {
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Vector store (Qdrant) is not available'
    };
  }

  if (/(ollama|\/api\/embeddings|embeddings API|Failed to generate embedding|\bembedding\b)/i.test(combined)) {
    return {
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Embeddings service (Ollama) is not available'
    };
  }

  return null;
}

// Initialize RAG store with environment config
const ragStore = getRagStore({
  vectorStoreType: process.env.VECTOR_STORE_TYPE || 'memory',
  url: process.env.QDRANT_URL,
  collection: process.env.QDRANT_COLLECTION
});

function requireMongoReady(res) {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      status: 'error',
      message: 'Database not connected'
    });
    return false;
  }
  return true;
}

function normalizeRoot(root) {
  if (!root || typeof root !== 'string') return '';
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

function normalizeRelativePath(filePath, root) {
  if (!filePath || typeof filePath !== 'string') return '';
  const normalized = filePath.replace(/\\/g, '/');
  const cleanRoot = normalizeRoot(root);

  if (cleanRoot && normalized.startsWith(cleanRoot + '/')) {
    return normalized.slice(cleanRoot.length + 1);
  }

  // Treat leading slash as non-relative; strip it for comparison.
  return normalized.replace(/^\/+/, '');
}

async function computeMdFolderStats(rootDir, options = {}) {
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 50000;
  const result = { totalFiles: 0, mdFiles: 0, totalBytes: 0 };

  async function walk(dir) {
    if (result.totalFiles >= maxFiles) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // If the directory can't be read, stop gracefully.
      logger.warn('Failed to read RAG directory while computing stats', { dir, error: error.message });
      return;
    }

    for (const entry of entries) {
      if (result.totalFiles >= maxFiles) return;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      result.totalFiles++;

      if (!entry.name.toLowerCase().endsWith('.md')) continue;

      try {
        const stats = await fs.stat(fullPath);
        result.mdFiles++;
        result.totalBytes += stats.size || 0;
      } catch (error) {
        logger.warn('Failed to stat RAG file while computing stats', { filePath: fullPath, error: error.message });
      }
    }
  }

  await walk(rootDir);
  return result;
}

/**
 * POST /api/rag/ingest (and /api/rag/documents)
 * 
 * Ingest a document into the RAG system.
 * Called by n8n workflows to add documents for semantic search.
 * 
 * Contract: V3_CONTRACT_SNAPSHOT.md § 2.1
 */
router.post(['/ingest', '/documents'], async (req, res) => {
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

    // Track processing time
    const startTime = Date.now();
    
    // Upsert document (pass ollamaHost for dynamic embedding service)
    const result = await ragStore.upsertDocumentWithChunks(docMetadata, text, ollamaHost);
    
    const processingTimeMs = Date.now() - startTime;

    // Return response matching contract exactly
    // DO NOT add extra fields - n8n parses this!
    res.json({
      status: result.status,
      documentId: result.documentId,
      chunkCount: result.chunkCount
    });

    logger.info('RAG document ingested', {
      status: result.status,
      documentId: result.documentId,
      chunkCount: result.chunkCount,
      processingTimeMs,
      textLength: text.length,
      source,
      title
    });

  } catch (error) {
    logger.error('RAG ingest error', { error: error.message, stack: error.stack });

    const availability = classifyRagAvailabilityError(error);
    if (availability) {
      return res.status(availability.statusCode).json({
        error: availability.error,
        message: availability.message
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

    logger.info('RAG search completed', {
      query: query.substring(0, 50),
      resultCount: results.length
    });

  } catch (error) {
    logger.error('RAG search error', { error: error.message, stack: error.stack });

    const availability = classifyRagAvailabilityError(error);
    if (availability) {
      return res.status(availability.statusCode).json({
        error: availability.error,
        message: availability.message
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
router.get('/documents', async (req, res) => {
  try {
    const { source, tags } = req.query;
    const filters = {};
    
    if (source) filters.source = source;
    if (tags) filters.tags = tags.split(',');

    const documents = await ragStore.listDocuments(filters);
    const stats = await ragStore.getStats();

    res.json({
      status: 'success',
      data: documents,
      stats,
      count: documents.length
    });
  } catch (error) {
    logger.error('RAG documents error', { error: error.message, stack: error.stack });
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
router.delete('/documents/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const deleted = await ragStore.deleteDocument(documentId);

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
    logger.error('RAG delete error', { error: error.message, stack: error.stack });
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * GET /api/rag/metrics
 * 
 * Get detailed RAG system metrics including vector store stats,
 * collection health, and ingestion performance.
 */
router.get('/metrics', async (req, res) => {
  const timestamp = new Date().toISOString();
  let warning = null;
  let healthy = false;
  let stats = {};
  let documents = [];

  try {
    healthy = await ragStore.healthCheck();
  } catch (error) {
    warning = warning || error.message;
    logger.warn('RAG health check failed', { error: error.message });
  }

  try {
    stats = await ragStore.getStats();
  } catch (error) {
    warning = warning || error.message;
    logger.warn('RAG getStats failed', { error: error.message });
    stats = {};
  }

  try {
    documents = await ragStore.listDocuments();
  } catch (error) {
    warning = warning || error.message;
    logger.warn('RAG listDocuments failed', { error: error.message });
    documents = [];
  }

  // Calculate additional metrics (safe even when documents is empty)
  const sourceBreakdown = {};
  let totalChunks = 0;
  let oldestDoc = null;
  let newestDoc = null;

  documents.forEach(doc => {
    const source = doc && doc.source ? doc.source : 'unknown';
    if (!sourceBreakdown[source]) {
      sourceBreakdown[source] = { count: 0, chunks: 0 };
    }

    sourceBreakdown[source].count++;
    sourceBreakdown[source].chunks += doc.chunkCount || 0;
    totalChunks += doc.chunkCount || 0;

    if (doc.createdAt) {
      // Fix: Compare timestamps directly to avoid creating new Date objects repeatedly
      const docTime = new Date(doc.createdAt).getTime();
      const oldestTime = oldestDoc ? new Date(oldestDoc).getTime() : Infinity;
      const newestTime = newestDoc ? new Date(newestDoc).getTime() : -Infinity;

      if (docTime < oldestTime) {
        oldestDoc = doc.createdAt;
      }
      if (docTime > newestTime) {
        newestDoc = doc.createdAt;
      }
    }
  });

  res.json({
    status: 'success',
    healthy: Boolean(healthy),
    ...(warning ? { warning } : {}),
    stats: {
      ...stats,
      totalDocuments: documents.length,
      totalChunks,
      avgChunksPerDoc: documents.length > 0 ? (totalChunks / documents.length).toFixed(2) : '0.00',
      sourceBreakdown,
      oldestDocument: oldestDoc,
      newestDocument: newestDoc
    },
    timestamp
  });
});

/**
 * GET /api/rag/collections/:collection/info
 * 
 * Get detailed information about a specific Qdrant collection.
 * Requires vector store to be Qdrant.
 */
router.get('/collections/:collection/info', async (req, res) => {
  try {
    const { collection } = req.params;
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    const fetch = require('node-fetch');
    
    // Get collection info from Qdrant
    const response = await fetch(`${qdrantUrl}/collections/${collection}`);
    
    if (!response.ok) {
      return res.status(404).json({
        error: 'Collection not found',
        message: `Collection '${collection}' does not exist in Qdrant`
      });
    }
    
    const data = await response.json();
    
    res.json({
      status: 'success',
      collection: collection,
      info: data.result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Collection info error', { error: error.message, stack: error.stack });
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * POST /api/rag/manifests
 *
 * Store/update the latest folder manifest for a given source+root.
 * Intended to be called by n8n (or other automation) after a folder scan.
 *
 * Body:
 * {
 *   source: "nas-docs",
 *   root: "/mnt/share/RAG",
 *   scanId: "..." (optional),
 *   generatedAt: "2026-01-10T..." (optional),
 *   files: [{ path, sha256, size, mtime }]
 * }
 */
router.post('/manifests', n8nAuth, async (req, res) => {
  try {
    if (!requireMongoReady(res)) return;

    const { source, root, scanId, generatedAt, files } = req.body || {};

    if (!source || typeof source !== 'string') {
      return res.status(400).json({
        status: 'error',
        message: 'source is required'
      });
    }

    if (!root || typeof root !== 'string') {
      return res.status(400).json({
        status: 'error',
        message: 'root is required'
      });
    }

    if (!Array.isArray(files)) {
      return res.status(400).json({
        status: 'error',
        message: 'files must be an array'
      });
    }

    const cleanRoot = normalizeRoot(root);
    const manifestFiles = [];
    let totalBytes = 0;

    for (const entry of files) {
      if (!entry || typeof entry !== 'object') continue;
      if (!entry.path || typeof entry.path !== 'string') continue;

      const size = Number.isFinite(entry.size) ? entry.size : (entry.size ? Number(entry.size) : undefined);
      if (Number.isFinite(size)) totalBytes += size;

      manifestFiles.push({
        path: normalizeRelativePath(entry.path, cleanRoot),
        sha256: typeof entry.sha256 === 'string' ? entry.sha256 : undefined,
        size: Number.isFinite(size) ? size : undefined,
        mtime: entry.mtime ? new Date(entry.mtime) : undefined
      });
    }

    const fileCount = manifestFiles.length;
    const genAt = generatedAt ? new Date(generatedAt) : new Date();

    const saved = await RagManifest.findOneAndUpdate(
      { source, root: cleanRoot },
      {
        $set: {
          scanId: scanId || undefined,
          generatedAt: genAt,
          files: manifestFiles,
          stats: { fileCount, totalBytes }
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({
      status: 'success',
      data: {
        source: saved.source,
        root: saved.root,
        scanId: saved.scanId,
        generatedAt: saved.generatedAt,
        fileCount: saved.stats?.fileCount || 0,
        totalBytes: saved.stats?.totalBytes || 0,
        updatedAt: saved.updatedAt
      }
    });
  } catch (error) {
    logger.error('RAG manifest upsert error', { error: error.message, stack: error.stack });
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/rag/manifests/latest
 *
 * Fetch latest manifest metadata for a source+root.
 */
router.get('/manifests/latest', async (req, res) => {
  try {
    if (!requireMongoReady(res)) return;

    const { source, root } = req.query;
    if (!source || !root) {
      return res.status(400).json({
        status: 'error',
        message: 'source and root are required'
      });
    }

    const manifest = await RagManifest.findOne({
      source: String(source),
      root: normalizeRoot(String(root))
    }).lean();

    if (!manifest) {
      return res.status(404).json({ status: 'error', message: 'Manifest not found' });
    }

    return res.json({
      status: 'success',
      data: {
        source: manifest.source,
        root: manifest.root,
        scanId: manifest.scanId,
        generatedAt: manifest.generatedAt,
        fileCount: manifest.stats?.fileCount || manifest.files?.length || 0,
        totalBytes: manifest.stats?.totalBytes || 0,
        updatedAt: manifest.updatedAt
      }
    });
  } catch (error) {
    logger.error('RAG manifest latest error', { error: error.message });
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/rag/deletion-preview
 *
 * Compare RAG documents (by source) against the latest stored manifest.
 * Returns candidates that exist in RAG but are missing from the manifest.
 * Does NOT delete anything.
 */
router.get('/deletion-preview', async (req, res) => {
  try {
    if (!requireMongoReady(res)) return;

    const source = req.query.source ? String(req.query.source) : '';
    const root = req.query.root ? String(req.query.root) : '';
    if (!source || !root) {
      return res.status(400).json({
        status: 'error',
        message: 'source and root are required'
      });
    }

    const cleanRoot = normalizeRoot(root);
    const manifest = await RagManifest.findOne({ source, root: cleanRoot }).lean();

    if (!manifest) {
      return res.json({
        status: 'success',
        data: {
          source,
          root: cleanRoot,
          manifestMissing: true,
          summary: {
            ragDocuments: 0,
            manifestFiles: 0,
            candidates: 0
          },
          candidates: []
        }
      });
    }

    const manifestSet = new Set(
      (manifest.files || [])
        .map(f => normalizeRelativePath(f.path, cleanRoot))
        .filter(Boolean)
    );

    const docs = await ragStore.listDocuments({ source });

    const candidates = [];
    for (const doc of docs) {
      const docPath = normalizeRelativePath(doc.path, cleanRoot);
      if (!docPath) {
        candidates.push({
          documentId: doc.documentId,
          title: doc.title,
          source: doc.source,
          path: doc.path,
          reason: 'missing_path'
        });
        continue;
      }

      if (!manifestSet.has(docPath)) {
        candidates.push({
          documentId: doc.documentId,
          title: doc.title,
          source: doc.source,
          path: doc.path,
          reason: 'missing_from_manifest',
          updatedAt: doc.updatedAt,
          chunkCount: doc.chunkCount
        });
      }
    }

    return res.json({
      status: 'success',
      data: {
        source,
        root: cleanRoot,
        manifest: {
          scanId: manifest.scanId,
          generatedAt: manifest.generatedAt,
          updatedAt: manifest.updatedAt,
          fileCount: manifest.stats?.fileCount || manifest.files?.length || 0
        },
        summary: {
          ragDocuments: docs.length,
          manifestFiles: manifest.stats?.fileCount || manifest.files?.length || 0,
          candidates: candidates.length
        },
        candidates
      }
    });
  } catch (error) {
    logger.error('RAG deletion preview error', { error: error.message, stack: error.stack });
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/rag/watcher/status
 * Get RAG file watcher status
 */
router.get('/watcher/status', async (req, res) => {
  console.log('RAG watcher status endpoint called');
  try {
    const watcher = getRagWatcherInstance();
    console.log('Watcher instance:', !!watcher);
    if (!watcher) {
      return res.json({
        status: 'success',
        data: {
          isRunning: false,
          message: 'RAG file watcher not initialized'
        }
      });
    }

    const status = watcher.getStatus() || {};
    const ragDir = status.ragDir || status.root || watcher.ragDir || '/mnt/datalake/RAG';

    let diskStats = null;
    try {
      diskStats = await computeMdFolderStats(ragDir);
    } catch (error) {
      logger.warn('Failed to compute RAG disk stats', { ragDir, error: error.message });
    }

    const mergedStatus = {
      ...status,
      ragDir,
      diskMdFiles: diskStats?.mdFiles,
      diskTotalBytes: diskStats?.totalBytes,
      diskTotalFiles: diskStats?.totalFiles
    };

    // Backfill for UIs that expect these fields.
    if (
      (!mergedStatus.lastManifestStats || typeof mergedStatus.lastManifestStats !== 'object') &&
      diskStats &&
      typeof diskStats.totalBytes === 'number'
    ) {
      mergedStatus.lastManifestStats = {
        fileCount: diskStats.mdFiles || 0,
        totalBytes: diskStats.totalBytes || 0
      };
    }

    res.json({
      status: 'success',
      data: mergedStatus
    });
  } catch (error) {
    logger.error('RAG watcher status error', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/rag/watcher/trigger-scan
 * Manually trigger a folder scan and manifest update
 */
router.post('/watcher/trigger-scan', async (req, res) => {
  try {
    const watcher = getRagWatcherInstance();
    if (!watcher) {
      return res.status(503).json({
        status: 'error',
        message: 'RAG file watcher not initialized'
      });
    }

    logger.info('Manual RAG folder scan triggered');

    // Perform scan
    await watcher.initialScan();

    res.json({
      status: 'success',
      message: 'RAG folder scan completed successfully'
    });
  } catch (error) {
    logger.error('Manual RAG scan error', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/rag/watcher/cleanup-obsolete
 * Manually trigger cleanup of obsolete documents
 */
router.post('/watcher/cleanup-obsolete', async (req, res) => {
  try {
    const watcher = getRagWatcherInstance();
    if (!watcher) {
      return res.status(503).json({
        status: 'error',
        message: 'RAG file watcher not initialized'
      });
    }

    logger.info('Manual obsolete document cleanup triggered');

    const cleanedCount = await watcher.cleanupObsoleteDocuments();

    res.json({
      status: 'success',
      message: `Obsolete document cleanup completed`,
      data: { cleanedCount }
    });
  } catch (error) {
    logger.error('Manual cleanup error', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

module.exports = router;
module.exports.setRagWatcherInstance = setRagWatcherInstance;
module.exports.getRagWatcherInstance = getRagWatcherInstance;
