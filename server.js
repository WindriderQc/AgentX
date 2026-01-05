require('dotenv').config();
const path = require('path');
const connectDB = require('./config/db-mongodb');
const logger = require('./config/logger');
const { app, systemHealth } = require('./src/app');
const SelfHealingEngine = require('./src/services/selfHealingEngine');

const PORT = process.env.PORT || 3080;
const HOST = process.env.HOST || 'localhost';
const OLLAMA_HOST = process.env.OLLAMA_HOST;
if (!OLLAMA_HOST) {
  logger.warn('OLLAMA_HOST not defined in environment variables. Some features may be disabled.');
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
  logger.error('Uncaught Exception', {
    message: error.message,
    stack: error.stack
  });
  // Give time for logs to flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

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
  } catch (err) {
    console.log(`   ⚠ Self-Healing: ${err.message}`);
    logger.warn('Self-healing rules not loaded - automation disabled', { error: err.message });
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
