const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const metricsCollector = require('../src/services/metricsCollector');
const { optionalAuth } = require('../src/middleware/auth');
const { getEmbeddingsService } = require('../src/services/embeddings');
let EmbeddingCacheStats;
try {
  EmbeddingCacheStats = require('../models/EmbeddingCacheStats');
} catch (_e) {
  EmbeddingCacheStats = null;
}

const METRIC_TYPES = ['health', 'performance', 'cost', 'resource', 'quality', 'usage'];

function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

// ---------------------------------------------------------------------------
// Dashboard monitoring endpoints (used by /dashboard.html and /analytics.html)
// ---------------------------------------------------------------------------

router.get('/cache', optionalAuth, async (_req, res) => {
  try {
    const embeddings = getEmbeddingsService();
    const stats = embeddings.getCacheStats() || {};

    // Prefer aggregated (cross-worker) counters if available
    let hitCount = Number(stats.hitCount) || 0;
    let missCount = Number(stats.missCount) || 0;
    let evictionCount = Number(stats.evictionCount) || 0;

    if (EmbeddingCacheStats && mongoose.connection.readyState === 1) {
      const global = await EmbeddingCacheStats.findById('embedding').lean();
      if (global) {
        hitCount = Number(global.hitCount) || hitCount;
        missCount = Number(global.missCount) || missCount;
        evictionCount = Number(global.evictionCount) || evictionCount;
      }
    }

    const total = hitCount + missCount;
    const hitRate = total > 0 ? hitCount / total : 0;

    // Best-effort memory estimate (embeddings are arrays of numbers)
    // We intentionally keep this cheap and safe.
    const memorySizeBytes = 0;
    const avgEntrySizeBytes = 0;

    res.json({
      status: 'success',
      data: {
        cache: {
          size: Number(stats.size) || 0,
          maxSize: Number(stats.maxSize) || 0,
          hitCount,
          missCount,
          evictions: evictionCount,
          hitRate,
          ttlMs: Number(stats.ttl) || 0,
          memorySizeBytes,
          avgEntrySizeBytes,
          // Back-compat keys used in some UI code paths
          hitCountTotal: hitCount,
          missCountTotal: missCount,
          hits: hitCount,
          misses: missCount
        }
      }
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

router.post('/cache/clear', optionalAuth, async (_req, res) => {
  try {
    const embeddings = getEmbeddingsService();
    embeddings.clearCache();

    if (EmbeddingCacheStats && mongoose.connection.readyState === 1) {
      await EmbeddingCacheStats.updateOne(
        { _id: 'embedding' },
        { $set: { hitCount: 0, missCount: 0, evictionCount: 0, updatedAt: new Date() } },
        { upsert: true }
      );
    }

    return res.json({ status: 'success', message: 'Cache cleared' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

router.get('/database', optionalAuth, async (_req, res) => {
  try {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      return res.status(503).json({
        status: 'error',
        message: 'Database not connected'
      });
    }

    const db = mongoose.connection.db;
    const dbStats = await db.stats();
    let serverStatus;
    try {
      serverStatus = await db.admin().serverStatus();
    } catch (_e) {
      serverStatus = null;
    }

    const currentConnections = Number(serverStatus?.connections?.current) || 0;
    const availableConnections = Number(serverStatus?.connections?.available) || 0;
    const maxConnections = currentConnections + availableConnections;

    const collections = await db.listCollections().toArray();
    const collectionStats = {};

    // Count docs per collection (counts only; keep it lightweight)
    await Promise.all(
      collections
        .filter((c) => c?.name && !c.name.startsWith('system.'))
        .map(async (c) => {
          const count = await db.collection(c.name).countDocuments();
          collectionStats[c.name] = { count };
        })
    );

    return res.json({
      status: 'success',
      data: {
        connections: {
          current: currentConnections,
          available: availableConnections,
          max: maxConnections
        },
        database: {
          name: mongoose.connection.name,
          collections: dbStats.collections,
          indexes: dbStats.indexes,
          dataSize: dbStats.dataSize,
          storageSize: dbStats.storageSize
        },
        collections: collectionStats
      }
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

router.get('/connection', optionalAuth, async (_req, res) => {
  try {
    const connected = mongoose.connection.readyState === 1 && mongoose.connection.db;

    let serverStatus;
    if (connected) {
      try {
        serverStatus = await mongoose.connection.db.admin().serverStatus();
      } catch (_e) {
        serverStatus = null;
      }
    }

    const current = Number(serverStatus?.connections?.current) || 0;
    const available = Number(serverStatus?.connections?.available) || 0;
    const maxConnections = current + available;

    const options = mongoose.connection.client?.options || {};
    const minPoolSize = Number(options.minPoolSize) || 0;

    return res.json({
      status: 'success',
      data: {
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        readyState: mongoose.connection.readyState,
        activeConnections: current,
        availableConnections: available,
        waitingConnections: 0,
        poolSize: maxConnections,
        minPoolSize
      }
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

router.get('/system', optionalAuth, async (_req, res) => {
  try {
    const mem = process.memoryUsage();
    const seconds = process.uptime();
    return res.json({
      status: 'success',
      data: {
        uptime: {
          seconds,
          formatted: formatUptime(seconds)
        },
        nodeVersion: process.version,
        platform: process.platform,
        memory: {
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers,
          formatted: {
            rss: formatBytes(mem.rss),
            heapTotal: formatBytes(mem.heapTotal),
            heapUsed: formatBytes(mem.heapUsed)
          }
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

function createRecordHandler(type) {
  return async (req, res) => {
    const { componentId, value, metadata = {}, timestamp } = req.body || {};

    if (!componentId || !Number.isFinite(value)) {
      return res.status(400).json({
        status: 'error',
        message: 'componentId and numeric value are required'
      });
    }

    try {
      const meta = { ...metadata };
      if (timestamp) meta.timestamp = timestamp;

      const metric = await metricsCollector.record(type, componentId, value, meta);
      await metricsCollector.flush();

      return res.status(201).json({
        status: 'success',
        data: {
          metricId: metric._id,
          timestamp: metric.timestamp,
          type: metric.type,
          componentId: metric.componentId,
          value: metric.value,
          metadata: metric.metadata
        }
      });
    } catch (error) {
      return res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  };
}

METRIC_TYPES.forEach((type) => {
  router.post(`/${type}`, optionalAuth, createRecordHandler(type));
});

router.get('/query', optionalAuth, async (req, res) => {
  const { type, componentId, from, to, metadata } = req.query;

  let parsedMetadata = {};
  if (metadata) {
    try {
      parsedMetadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    } catch (err) {
      return res.status(400).json({ status: 'error', message: 'metadata must be valid JSON' });
    }
  }

  try {
    const result = await metricsCollector.query(
      { type, componentId, metadata: parsedMetadata },
      { from, to }
    );

    return res.json({
      status: 'success',
      data: {
        count: result.count,
        results: result.results
      }
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

router.get('/latest', optionalAuth, async (req, res) => {
  const { componentId, type } = req.query;

  if (!componentId) {
    return res.status(400).json({ status: 'error', message: 'componentId is required' });
  }

  try {
    const metric = await metricsCollector.getLatest(componentId, type || null);

    if (!metric) {
      return res.status(404).json({ status: 'error', message: 'No metrics found' });
    }

    return res.json({
      status: 'success',
      data: metric
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

module.exports = router;
