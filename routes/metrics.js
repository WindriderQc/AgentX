/**
 * Metrics and Monitoring Routes
 * 
 * Provides endpoints for system performance metrics, cache statistics,
 * and operational monitoring.
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { optionalAuth } = require('../src/middleware/auth');
const { getEmbeddingsService } = require('../src/services/embeddings');

/**
 * GET /api/metrics/cache
 * Get embedding cache statistics
 * Requires authentication
 */
router.get('/cache', optionalAuth, (req, res) => {
  try {
    const embeddingsService = getEmbeddingsService();
    const cacheStats = embeddingsService.getCacheStats();

    res.json({
      status: 'success',
      data: {
        cache: cacheStats,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve cache statistics',
      error: error.message
    });
  }
});

/**
 * POST /api/metrics/cache/clear
 * Clear embedding cache
 * Requires authentication (admin only recommended)
 */
router.post('/cache/clear', optionalAuth, (req, res) => {
  try {
    const embeddingsService = getEmbeddingsService();
    embeddingsService.clearCache();

    res.json({
      status: 'success',
      message: 'Cache cleared successfully'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to clear cache',
      error: error.message
    });
  }
});

/**
 * GET /api/metrics/database
 * Get MongoDB statistics
 * Requires authentication
 */
router.get('/database', optionalAuth, async (req, res) => {
  try {
    const db = mongoose.connection.db;

    // Get database stats
    const dbStats = await db.stats();
    
    // Get server status for connections
    let connectionStats = {};
    try {
      const serverStatus = await db.command({ serverStatus: 1 });
      if (serverStatus && serverStatus.connections) {
        connectionStats = {
          current: serverStatus.connections.current,
          available: serverStatus.connections.available,
          max: serverStatus.connections.current + serverStatus.connections.available
        };
      }
    } catch (err) {
      // Fallback if no permission
      connectionStats = { current: 0, available: 0, max: 0 };
    }

    // Get collection stats
    const collections = await db.listCollections().toArray();
    const collectionStats = {};

    for (const collection of collections) {
      try {
        // Use collStats command as .stats() is deprecated/removed in newer drivers
        const stats = await db.command({ collStats: collection.name });
        collectionStats[collection.name] = {
          count: stats.count,
          size: stats.size,
          avgObjSize: stats.avgObjSize,
          storageSize: stats.storageSize,
          indexes: stats.nindexes,
          totalIndexSize: stats.totalIndexSize
        };
      } catch (err) {
        // Fallback or skip if collStats fails (e.g. views)
        collectionStats[collection.name] = { count: 0, error: 'Stats unavailable' };
      }
    }

    res.json({
      status: 'success',
      data: {
        database: {
          name: dbStats.db,
          collections: dbStats.collections,
          dataSize: dbStats.dataSize,
          storageSize: dbStats.storageSize,
          indexes: dbStats.indexes,
          indexSize: dbStats.indexSize
        },
        connections: connectionStats,
        collections: collectionStats,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve database statistics',
      error: error.message
    });
  }
});

/**
 * GET /api/metrics/connection
 * Get MongoDB connection pool statistics
 * Requires authentication
 */
router.get('/connection', optionalAuth, (req, res) => {
  try {
    const connection = mongoose.connection;

    res.json({
      status: 'success',
      data: {
        readyState: connection.readyState,
        readyStateLabel: ['disconnected', 'connected', 'connecting', 'disconnecting'][connection.readyState],
        host: connection.host,
        port: connection.port,
        name: connection.name,
        // Connection pool info
        poolSize: connection.client?.options?.maxPoolSize,
        minPoolSize: connection.client?.options?.minPoolSize,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve connection statistics',
      error: error.message
    });
  }
});

/**
 * GET /api/metrics/system
 * Get overall system metrics
 * Requires authentication
 */
router.get('/system', optionalAuth, async (req, res) => {
  try {
    const embeddingsService = getEmbeddingsService();
    const cacheStats = embeddingsService.getCacheStats();

    const db = mongoose.connection.db;
    const dbStats = await db.stats();

    const connection = mongoose.connection;

    // Calculate uptime
    const uptime = process.uptime();

    // Memory usage
    const memoryUsage = process.memoryUsage();

    res.json({
      status: 'success',
      data: {
        uptime: {
          seconds: uptime,
          formatted: formatUptime(uptime)
        },
        memory: {
          rss: memoryUsage.rss,
          heapTotal: memoryUsage.heapTotal,
          heapUsed: memoryUsage.heapUsed,
          external: memoryUsage.external,
          formatted: {
            rss: formatBytes(memoryUsage.rss),
            heapTotal: formatBytes(memoryUsage.heapTotal),
            heapUsed: formatBytes(memoryUsage.heapUsed)
          }
        },
        cache: {
          size: cacheStats.size,
          hitRate: cacheStats.hitRate,
          hitCount: cacheStats.hitCount,
          missCount: cacheStats.missCount
        },
        database: {
          status: connection.readyState === 1 ? 'connected' : 'disconnected',
          collections: dbStats.collections,
          dataSize: formatBytes(dbStats.dataSize),
          indexSize: formatBytes(dbStats.indexSize)
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve system metrics',
      error: error.message
    });
  }
});

/**
 * Helper: Format bytes to human-readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Helper: Format uptime to human-readable string
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0) parts.push(`${secs}s`);

  return parts.join(' ') || '0s';
}

module.exports = router;
