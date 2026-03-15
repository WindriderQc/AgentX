require('dotenv').config();
const connectDB = require('./config/db-mongodb');
const logger = require('./config/logger');
const { app, setRagWatcherInstance } = require('./src/app');
const systemHealth = require('./src/systemHealth');
const SelfHealingEngine = require('./src/services/selfHealingEngine');
const { getAutomationRunnerService } = require('./src/services/automationRunnerService');
const { getPatchProposalExpiryService } = require('./src/services/patchProposalExpiryService');
const { normalizeHostUrl } = require('./src/helpers/ollamaHostConfig');
const { getConfiguredRagDir } = require('./src/helpers/ragPaths');

const PORT = process.env.PORT || 3080;
const HOST = process.env.HOST || 'localhost';
const OLLAMA_HOST = normalizeHostUrl(process.env.OLLAMA_HOST);
if (!OLLAMA_HOST) {
  logger.warn('OLLAMA_HOST not defined in environment variables. Some features may be disabled.');
} else if (String(process.env.OLLAMA_HOST || '').includes('0.0.0.0')) {
  logger.warn('OLLAMA_HOST used a wildcard bind address; normalized to loopback for client requests.', {
    configured: process.env.OLLAMA_HOST,
    effective: OLLAMA_HOST
  });
}

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack,
    promise: promise
  });
});

process.on('uncaughtException', (error) => {
  // EPIPE = closed pipe/socket, ECONNRESET = abrupt client disconnect — both harmless, do not crash.
  if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
    logger.debug(`${error.code} ignored (closed connection)`);
    return;
  }
  logger.error('Uncaught Exception', {
    message: error.message,
    stack: error.stack
  });
  // Give time for logs to flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

// Prevent EPIPE on stdout/stderr from crashing the process (PM2 pipe issues)
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// Health Check Functions
async function checkMongoHealth() {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().ping();
      return { healthy: true, message: 'Connected' };
    }
    return { healthy: false, message: 'Not connected' };
  } catch (err) {
    return { healthy: false, message: err.message };
  }
}

async function checkOllamaHealth() {
  try {
    const fetch = require('node-fetch');
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      method: 'GET',
      timeout: 2000
    });

    if (response.ok) {
      return { healthy: true, message: 'Connected' };
    }
    return { healthy: false, message: `HTTP ${response.status}` };
  } catch (err) {
    return { healthy: false, message: err.message };
  }
}

let selfHealingEvaluationTimer = null;

async function runSelfHealingEvaluationCycle() {
  const lock = await SelfHealingEngine.acquireEvaluationLock();
  if (!lock.acquired) {
    logger.debug('Skipped self-healing evaluation tick (lock held by another worker)');
    return;
  }

  try {
    const results = await SelfHealingEngine.evaluateAndExecute();
    if (results.length > 0) {
      const summary = {
        total: results.length,
        success: results.filter(r => r.status === 'success').length,
        failed: results.filter(r => r.status === 'failed').length,
        pendingApproval: results.filter(r => r.status === 'pending_approval').length,
        skipped: results.filter(r => r.status === 'skipped').length
      };
      logger.info('Self-healing evaluation cycle completed', summary);
    } else {
      logger.debug('Self-healing evaluation cycle completed with no triggers');
    }
  } catch (error) {
    logger.error('Self-healing evaluation cycle failed', { error: error.message });
  } finally {
    await SelfHealingEngine.releaseEvaluationLock(lock.token);
  }
}

function startSelfHealingScheduler() {
  if (process.env.NODE_ENV === 'test') return;
  if (selfHealingEvaluationTimer) return;

  const schedulerEnabled = process.env.SELF_HEALING_SCHEDULER_ENABLED !== 'false';
  const intervalMs = Math.max(10000, parseInt(process.env.SELF_HEALING_EVALUATION_INTERVAL_MS || '300000', 10));

  if (!schedulerEnabled) {
    logger.info('Self-healing scheduler disabled via SELF_HEALING_SCHEDULER_ENABLED=false');
    return;
  }

  selfHealingEvaluationTimer = setInterval(() => {
    runSelfHealingEvaluationCycle().catch((error) => {
      logger.error('Unhandled self-healing scheduler tick error', { error: error.message });
    });
  }, intervalMs);

  logger.info('Self-healing scheduler started', { intervalMs });
}

// Health Check - Detailed (re-added here or we need to inject it into app.js)
// Since app.js defines routes, we can add this route there if we export the check functions,
// or we can add it here before listening.
// Adding it to app here works because 'app' is an express instance.
app.get('/health/detailed', async (_req, res) => {
  // Refresh checks
  const mongoStatus = await checkMongoHealth();
  const ollamaStatus = await checkOllamaHealth();

  // Check Qdrant if configured
  const VECTOR_STORE_TYPE = process.env.VECTOR_STORE_TYPE;
  const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
  let qdrantStatus = { healthy: false, message: 'Not configured' };

  if (VECTOR_STORE_TYPE === 'qdrant') {
    try {
      const response = await fetch(`${QDRANT_URL}/healthz`);
      if (response.ok) {
        qdrantStatus = { healthy: true, message: 'Connected' };
      } else {
        qdrantStatus = { healthy: false, message: `HTTP ${response.status}` };
      }
    } catch (err) {
      qdrantStatus = { healthy: false, message: err.message };
    }
  }

  const health = {
    status: (mongoStatus.healthy && ollamaStatus.healthy && (VECTOR_STORE_TYPE !== 'qdrant' || qdrantStatus.healthy)) ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      mongodb: {
        status: mongoStatus.healthy ? 'connected' : 'error',
        message: mongoStatus.message,
        lastCheck: new Date().toISOString()
      },
      ollama: {
        status: ollamaStatus.healthy ? 'connected' : 'error',
        message: ollamaStatus.message,
        host: OLLAMA_HOST,
        lastCheck: new Date().toISOString()
      },
      qdrant: {
        status: qdrantStatus.healthy ? 'connected' : (VECTOR_STORE_TYPE === 'qdrant' ? 'error' : 'not_configured'),
        message: qdrantStatus.message,
        url: VECTOR_STORE_TYPE === 'qdrant' ? QDRANT_URL : undefined,
        vectorStoreType: VECTOR_STORE_TYPE || 'memory',
        lastCheck: new Date().toISOString()
      }
    },
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
      }
    }
  };

  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});


// Startup initialization - perform health checks before starting server
async function startServer() {
  const packageJson = require('./package.json');
  const ragDir = getConfiguredRagDir();
  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║           AgentX v${packageJson.version} - Production Ready             ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);
  console.log(`🔍 Checking system dependencies...\n`);

  // Check MongoDB
  try {
    await connectDB();
    systemHealth.mongodb = { status: 'connected', lastCheck: new Date().toISOString(), error: null };
    console.log(`   ✓ MongoDB:  Connected`);
    logger.info('MongoDB connected successfully');

    // Seed default data (Workspace, User, Personas)
    try {
      const seedDefaultData = require('./src/helpers/initDb');
      await seedDefaultData();
    } catch (seedErr) {
      const logger = require('./config/logger');
      logger.warn('Failed to seed default data', { error: seedErr.message });
    }


    // Sync model registry from Ollama hosts
    try {
      const { syncAllHosts } = require('./src/services/modelSync/syncOrchestrator');
      const syncResult = await syncAllHosts();
      const syncParts = [];
      if (syncResult.created) syncParts.push(`${syncResult.created} new`);
      if (syncResult.updated) syncParts.push(`${syncResult.updated} updated`);
      if (syncResult.retired) syncParts.push(`${syncResult.retired} retired`);
      if (syncParts.length > 0) {
        console.log(`   ✓ Registry: Synced ${syncParts.join(', ')}`);
      } else {
        console.log(`   ✓ Registry: ${syncResult.unchanged} models up to date`);
      }
    } catch (syncErr) {
      logger.warn('Model registry sync failed (non-fatal)', { error: syncErr.message });
    }

    // Cleanup orphaned benchmark batches after DB connection
    try {
      const benchmarkService = require('./src/services/benchmark');
      const cleanedCount = await benchmarkService.cleanupStaleBatches();
      if (cleanedCount > 0) {
        console.log(`   ✓ Benchmark: Recovered ${cleanedCount} orphaned batch(es)`);
        logger.info('Recovered orphaned benchmark batches', { count: cleanedCount });
      }
    } catch (cleanupErr) {
      logger.warn('Failed to cleanup stale benchmark batches', { error: cleanupErr.message });
    }
  } catch (err) {
    systemHealth.mongodb = { status: 'error', lastCheck: new Date().toISOString(), error: err.message };
    console.log(`   ✗ MongoDB:  ${err.message}`);
    logger.warn('Starting without database connection - some features will be limited', { error: err.message });
  }

  // Check Ollama
  try {
    const ollamaResult = await checkOllamaHealth();
    if (ollamaResult.healthy) {
      systemHealth.ollama = { status: 'connected', lastCheck: new Date().toISOString(), error: null };
      console.log(`   ✓ Ollama:   Connected (${OLLAMA_HOST})`);
      logger.info('Ollama connected successfully', { host: OLLAMA_HOST });
    } else {
      throw new Error(ollamaResult.message);
    }
  } catch (err) {
    systemHealth.ollama = { status: 'error', lastCheck: new Date().toISOString(), error: err.message };
    console.log(`   ✗ Ollama:   ${err.message} (${OLLAMA_HOST})`);
    logger.warn('Ollama not available - chat features will not work until Ollama is running', {
      error: err.message,
      host: OLLAMA_HOST
    });
  }

  // Check Qdrant (only if configured)
  const VECTOR_STORE_TYPE = process.env.VECTOR_STORE_TYPE;
  const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
  if (VECTOR_STORE_TYPE === 'qdrant') {
    try {
      const response = await fetch(`${QDRANT_URL}/healthz`);
      if (response.ok) {
        systemHealth.qdrant = { status: 'connected', lastCheck: new Date().toISOString(), error: null };
        console.log(`   ✓ Qdrant:   Connected (${QDRANT_URL})`);
        logger.info('Qdrant connected successfully', { url: QDRANT_URL });
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      systemHealth.qdrant = { status: 'error', lastCheck: new Date().toISOString(), error: err.message };
      console.log(`   ✗ Qdrant:   ${err.message} (${QDRANT_URL})`);
      logger.warn('Qdrant not available - RAG will use in-memory fallback', {
        error: err.message,
        url: QDRANT_URL
      });
    }
  } else {
    systemHealth.qdrant = { status: 'not_configured', lastCheck: new Date().toISOString(), error: 'VECTOR_STORE_TYPE is not set to qdrant' };
    console.log(`   ℹ Qdrant:   Not configured (using ${VECTOR_STORE_TYPE || 'memory'} vector store)`);
  }

  // Load self-healing rules
  try {
    const rulesLoaded = await SelfHealingEngine.loadRules();
    console.log(`   ✓ Self-Healing: ${rulesLoaded} rules loaded`);
    logger.info('Self-healing rules loaded', { count: rulesLoaded });
    startSelfHealingScheduler();
  } catch (err) {
    console.log(`   ⚠ Self-Healing: ${err.message}`);
    logger.warn('Self-healing rules not loaded - automation disabled', { error: err.message });
  }

  // Initialize RAG file watcher
  let ragWatcher = null;
  try {
    const RagFileWatcher = require('./src/services/ragFileWatcher');
    ragWatcher = new RagFileWatcher({
      ragDir,
      source: 'rag-folder',
      vectorStoreType: process.env.VECTOR_STORE_TYPE,
      manifestUpdateInterval: 5 * 60 * 1000, // 5 minutes
      autoDeleteOnUnlink: process.env.RAG_WATCHER_AUTO_DELETE_ON_UNLINK === 'true',
      autoCleanupObsolete: process.env.RAG_WATCHER_AUTO_CLEANUP === 'true'
    });
    await ragWatcher.start();

    // Set the watcher instance on the app
    if (setRagWatcherInstance) {
      setRagWatcherInstance(ragWatcher);
    }

    console.log(`   ✓ RAG Watcher: Monitoring ${ragDir}`);
    logger.info('RAG file watcher started');
  } catch (err) {
    console.log(`   ⚠ RAG Watcher: ${err.message}`);
    logger.warn('RAG file watcher not started - automatic ingestion disabled', { error: err.message });
  }

  // Start SpecialX automation runner
  try {
    const specialXRunner = getAutomationRunnerService();
    await specialXRunner.start();
    console.log(`   ✓ SpecialX Runner: Active (${specialXRunner.instanceId})`);
    logger.info('SpecialX runner started', {
      instanceId: specialXRunner.instanceId,
      enabled: specialXRunner.enabled
    });
  } catch (err) {
    console.log(`   ⚠ SpecialX Runner: ${err.message}`);
    logger.warn('SpecialX runner failed to start', { error: err.message });
  }

  try {
    const patchProposalExpiryService = getPatchProposalExpiryService();
    patchProposalExpiryService.start();
    console.log('   ✓ Proposal Expiry Sweep: Scheduled');
  } catch (err) {
    console.log(`   ⚠ Proposal Expiry Sweep: ${err.message}`);
    logger.warn('Patch proposal expiry scheduler failed to start', { error: err.message });
  }

  // Start Host Monitor service (stale-host detection)
  try {
    const hostMonitorService = require('./src/services/hostMonitorService');
    hostMonitorService.start();
    console.log(`   ✓ Host Monitor: Active`);
  } catch (err) {
    console.log(`   ⚠ Host Monitor: ${err.message}`);
  }

  // Start Ollama Enrichment service (polls Ollama hosts for AI ops data)
  try {
    const ollamaEnrichmentService = require('./src/services/ollamaEnrichmentService');
    ollamaEnrichmentService.start();
    console.log(`   ✓ Ollama Enrichment: Active`);
  } catch (err) {
    console.log(`   ⚠ Ollama Enrichment: ${err.message}`);
  }

  // Start Express server
  app.listen(PORT, () => {
    console.log(`\n${'─'.repeat(58)}`);
    console.log(`🚀 Server:    http://${HOST}:${PORT}`);
    console.log(`💚 Health:    http://${HOST}:${PORT}/health/detailed`);
    console.log(`📚 Docs:      /docs folder`);
    console.log(`📋 Logs:      logs/combined.log & logs/error.log`);
    console.log(`${'─'.repeat(58)}\n`);
    
    const isHealthy = systemHealth.mongodb.status === 'connected' && 
                     systemHealth.ollama.status === 'connected';
    
    if (isHealthy) {
      console.log(`✅ All systems operational - Ready for production\n`);
    } else {
      console.log(`⚠️  WARNING: Running in degraded mode\n`);
      if (systemHealth.mongodb.status !== 'connected') {
        console.log(`   MongoDB Issue: ${systemHealth.mongodb.error}`);
      }
      if (systemHealth.ollama.status !== 'connected') {
        console.log(`   Ollama Issue: ${systemHealth.ollama.error}`);
      }
      console.log(`\n   Fix these issues for full functionality.\n`);
    }
    
    logger.info('AgentX server started', {
      port: PORT,
      host: process.env.SERVER_HOST || 'localhost',
      environment: process.env.NODE_ENV || 'development',
      mongodb: systemHealth.mongodb.status,
      ollama: systemHealth.ollama.status,
      healthy: isHealthy
    });
  });
}

// Start the server
startServer().catch(err => {
  logger.error('Failed to start server', { error: err.message, stack: err.stack });
  console.error(`\n❌ Fatal Error: ${err.message}\n`);
  process.exit(1);
});
