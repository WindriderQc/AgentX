require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const logger = require('./config/logger');
const { requestLogger, errorLogger } = require('./src/middleware/logging');

const app = express();
const PORT = process.env.PORT || 3080;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

// System Health State
const systemHealth = {
  mongodb: { status: 'unknown', lastCheck: null, error: null },
  ollama: { status: 'unknown', lastCheck: null, error: null },
  startup: new Date().toISOString()
};

// Connect to Database
connectDB()
  .then(() => {
    systemHealth.mongodb = { status: 'connected', lastCheck: new Date().toISOString(), error: null };
    logger.info('MongoDB connected successfully');
  })
  .catch((err) => {
    systemHealth.mongodb = { status: 'error', lastCheck: new Date().toISOString(), error: err.message };
    logger.warn('Starting without database connection - some features will be limited', { error: err.message });
  });

// Check Ollama availability at startup
checkOllamaHealth()
  .then(() => {
    systemHealth.ollama = { status: 'connected', lastCheck: new Date().toISOString(), error: null };
    logger.info('Ollama connected successfully', { host: OLLAMA_HOST });
  })
  .catch((err) => {
    systemHealth.ollama = { status: 'error', lastCheck: new Date().toISOString(), error: err.message };
    logger.warn('Ollama not available - chat features will not work until Ollama is running', { error: err.message });
  });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Request logging middleware
app.use(requestLogger);

// V3: Mount RAG routes
const ragRoutes = require('./routes/rag');
app.use('/api/rag', ragRoutes);

// V4: Mount Analytics & Dataset routes
const analyticsRoutes = require('./routes/analytics');
app.use('/api/analytics', analyticsRoutes);

const datasetRoutes = require('./routes/dataset');
app.use('/api/dataset', datasetRoutes);

// Mount API routes
const apiRoutes = require('./routes/api');
app.use('/api', apiRoutes);

function buildErrorResponse(err) {
  return {
    status: 'error',
    message: err.message || 'Unknown error',
    details: err.body || undefined,
  };
}

// Health Check - Basic
app.get('/health', (_req, res) => {
  const isHealthy = systemHealth.mongodb.status === 'connected' && 
                   systemHealth.ollama.status === 'connected';
  
  res.status(isHealthy ? 200 : 503).json({ 
    status: isHealthy ? 'ok' : 'degraded',
    port: PORT 
  });
});

// Health Check - Detailed
app.get('/health/detailed', async (_req, res) => {
  // Refresh checks
  const mongoStatus = await checkMongoHealth();
  const ollamaStatus = await checkOllamaHealth();
  
  const health = {
    status: (mongoStatus.healthy && ollamaStatus.healthy) ? 'healthy' : 'degraded',
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

// Config endpoint - expose server configuration
app.get('/api/config', (_req, res) => {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  // Parse host and port from OLLAMA_HOST
  const match = ollamaHost.match(/^(?:https?:\/\/)?([^:]+)(?::(\d+))?/);
  const host = match ? match[1] : 'localhost';
  const port = match && match[2] ? match[2] : '11434';
  
  res.json({
    ollama: {
      host,
      port,
      fullUrl: ollamaHost
    },
    embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text'
  });
});

// Error logging middleware (must be after routes)
app.use(errorLogger);

// Global error handler
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    status: 'error',
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Fallback to Frontend
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║           AgentX v1.0.0 - Production Ready            ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);
  console.log(`🚀 Server:    http://localhost:${PORT}`);
  console.log(`💚 Health:    http://localhost:${PORT}/health/detailed`);
  console.log(`📚 Docs:      Check /docs folder for complete guides`);
  console.log(`📋 Logs:      logs/combined.log & logs/error.log\n`);
  
  console.log(`📊 System Status:`);
  console.log(`   MongoDB:   ${systemHealth.mongodb.status === 'connected' ? '✓' : '✗'} ${systemHealth.mongodb.status}`);
  console.log(`   Ollama:    ${systemHealth.ollama.status === 'connected' ? '✓' : '✗'} ${systemHealth.ollama.status} (${OLLAMA_HOST})`);
  
  if (systemHealth.mongodb.status !== 'connected' || systemHealth.ollama.status !== 'connected') {
    console.log(`\n⚠️  WARNING: Running in degraded mode`);
    if (systemHealth.mongodb.status !== 'connected') {
      console.log(`   - MongoDB: ${systemHealth.mongodb.error}`);
    }
    if (systemHealth.ollama.status !== 'connected') {
      console.log(`   - Ollama: ${systemHealth.ollama.error}`);
    }
  } else {
    console.log(`\n✅ All systems operational\n`);
  }
  
  logger.info('AgentX server started', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    mongodb: systemHealth.mongodb.status,
    ollama: systemHealth.ollama.status
  });
});
