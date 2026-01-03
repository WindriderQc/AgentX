const mongoose = require('mongoose');
const logger = require('./logger');

const connectDB = async () => {
  try {
    const isTest = process.env.NODE_ENV === 'test';
    const conn = await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx', {
      serverSelectionTimeoutMS: 2000, // Fail fast if no DB
      // Connection pooling optimization (Week 2 Performance)
      maxPoolSize: 50,        // Maximum connections in pool (default: 100)
      minPoolSize: 10,        // Minimum connections to maintain (default: 0)
      maxIdleTimeMS: 30000,   // Close idle connections after 30s
      socketTimeoutMS: 45000, // Close sockets after 45s inactivity
      family: 4,              // Use IPv4, skip IPv6 resolution
      // In tests we create a time-series collection explicitly; prevent Mongoose
      // from eagerly creating regular collections/indexes for registered models.
      autoCreate: !isTest,
      autoIndex: !isTest
    });
    logger.info('MongoDB connected', { 
      host: conn.connection.host, 
      port: conn.connection.port,
      db: conn.connection.name,
      poolSize: `${conn.connection.client.options.minPoolSize}-${conn.connection.client.options.maxPoolSize}`
    });
    
    // Ensure time-series collection for metrics exists before other startup tasks
    await ensureTimeSeriesCollections();

    // V4: Initialize default PromptConfig if none exist
    await ensureDefaultPromptConfig();
  } catch (err) {
    logger.error('MongoDB connection failed', { error: err.message });
    // Don't kill the server if DB is missing, just log error for now to allow frontend verification
    // process.exit(1);
  }
};

/**
 * V4: Ensure at least one active PromptConfig exists
 * Contract: specs/V4_ANALYTICS_ARCHITECTURE.md § 1
 */
async function ensureDefaultPromptConfig() {
  try {
    const PromptConfig = require('../models/PromptConfig');
    
    const activePrompt = await PromptConfig.findOne({ name: 'default_chat', isActive: true });
    
    if (!activePrompt) {
      logger.info('[V4] No active prompt found, creating default_chat v1');
      
      const defaultPrompt = new PromptConfig({
        name: 'default_chat',
        version: 1,
        systemPrompt: 'You are AgentX, a concise and capable local assistant. Keep answers brief and actionable.',
        description: 'Initial default system prompt',
        isActive: true,
        author: 'system'
      });
      
      await defaultPrompt.save();
      logger.info('[V4] Created default_chat v1', { status: 'active' });
    } else {
      logger.info('[V4] Active prompt loaded', { 
        name: activePrompt.name, 
        version: activePrompt.version 
      });
    }
  } catch (err) {
    logger.error('[V4] Failed to initialize PromptConfig', { error: err.message });
  }
}

/**
 * Ensure time-series collections are created for historical metrics storage.
 * MongoDB will handle auto-creation for regular collections via mongoose models,
 * but time-series collections must be explicitly created with the correct options.
 */
async function ensureTimeSeriesCollections() {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection not initialized');
    }

    const tryDrop = async (collectionName) => {
      try {
        await db.command({ drop: collectionName });
      } catch (_) {
        // ignore (NamespaceNotFound, etc.)
      }
    };
    const [metricsInfo] = await db.listCollections({ name: 'metricssnapshots' }).toArray();
    const [bucketsInfo] = await db
      .listCollections({ name: 'system.buckets.metricssnapshots' })
      .toArray();

    const isMetricsTimeSeries =
      metricsInfo &&
      (metricsInfo.type === 'timeseries' ||
        (metricsInfo.options && metricsInfo.options.timeseries));

    // In tests we want a deterministic, queryable time-series collection.
    // We've observed states where the buckets collection exists but the logical
    // collection isn't readable (queries return 0 while buckets fill up).
    // Safest fix for tests: drop and recreate the time-series collection.
    const shouldRepairInTest =
      process.env.NODE_ENV === 'test' &&
      (!metricsInfo || !isMetricsTimeSeries || bucketsInfo);

    if (shouldRepairInTest) {
      // Drop buckets first; it's the authoritative storage for time-series.
      await tryDrop('system.buckets.metricssnapshots');
      await tryDrop('metricssnapshots');
    }

    const [metricsInfoAfter] = await db.listCollections({ name: 'metricssnapshots' }).toArray();
    const isReady =
      metricsInfoAfter &&
      (metricsInfoAfter.type === 'timeseries' ||
        (metricsInfoAfter.options && metricsInfoAfter.options.timeseries));

    if (!isReady) {
      await db.createCollection('metricssnapshots', {
        timeseries: {
          timeField: 'timestamp',
          metaField: 'metadata',
          granularity: 'minutes'
        },
        expireAfterSeconds: 7776000 // 90 days
      });
      logger.info('✓ Created time-series collection: metricssnapshots');
    }
  } catch (err) {
    logger.error('Failed to ensure time-series collections', { error: err.message });
  }
}

module.exports = connectDB;
