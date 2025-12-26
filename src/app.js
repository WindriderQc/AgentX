const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
const logger = require('../config/logger');
const { requestLogger, errorLogger } = require('./middleware/logging');
const { attachUser } = require('./middleware/auth');
const { createProxyMiddleware } = require('http-proxy-middleware');

// Initialize app
const app = express();
const IN_PROD = process.env.NODE_ENV === 'production';
const IN_TEST = process.env.NODE_ENV === 'test';

// System Health State (exported for updates)
const systemHealth = {
  mongodb: { status: 'checking', lastCheck: null, error: null },
  ollama: { status: 'checking', lastCheck: null, error: null },
  startup: new Date().toISOString()
};

// Basic security headers only (removed helmet for local network compatibility)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Middleware Setup
const allowedOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : IN_PROD ? ['http://localhost:3080'] : true;

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Sanitize MongoDB queries (prevent NoSQL injection)
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    logger.warn('Sanitized malicious input', { 
      ip: req.ip, 
      key,
      path: req.path 
    });
  }
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

// Session configuration
// In tests we avoid creating a Mongo-backed session store to prevent open handles.
let store;
// Check for E2E testing flag or standard test env
const IS_E2E = process.env.NODE_ENV === 'test_e2e';

if (!IN_TEST || IS_E2E) {
  // Allow overriding the URI for E2E tests with memory server
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';

  store = new MongoDBStore({
    uri: mongoUri,
    collection: 'sessions',
    // databaseName is often part of URI in memory server, but we can specify it if needed
    // For memory server, the URI includes the DB name usually.
  });

  store.on('error', (error) => {
    logger.error('Session store error:', error);
  });
}

const sessionOptions = {
  secret: process.env.SESSION_SECRET || 'agentx-secret-change-in-production',
  name: 'agentx.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24, // 24 hours
    httpOnly: true,
    secure: IN_PROD,
    sameSite: IN_PROD ? 'none' : 'lax'
  }
};

if (store) {
  sessionOptions.store = store;
}

app.use(session(sessionOptions));

// Attach user to all requests (from session)
app.use(attachUser);

// Request logging middleware
app.use(requestLogger);

// Auth routes
const authRoutes = require('../routes/auth');
app.use('/api/auth', authRoutes);

// V3: Mount RAG routes
const ragRoutes = require('../routes/rag');
app.use('/api/rag', ragRoutes);

// V4: Mount Analytics & Dataset routes
const analyticsRoutes = require('../routes/analytics');
app.use('/api/analytics', analyticsRoutes);

const datasetRoutes = require('../routes/dataset');
app.use('/api/dataset', datasetRoutes);

// Metrics routes (performance monitoring)
const metricsRoutes = require('../routes/metrics');
app.use('/api/metrics', metricsRoutes);

// n8n integration routes (API key authentication)
const n8nRoutes = require('../routes/n8n');
app.use('/api/n8n', n8nRoutes);

// New Modular Routes
const profileRoutes = require('../routes/profile');
app.use('/api/profile', profileRoutes);

const historyRoutes = require('../routes/history');
app.use('/api/history', historyRoutes);

const dataapiRoutes = require('../routes/dataapi');
app.use('/api/dataapi', dataapiRoutes);

// Voice routes (STT, TTS, voice chat)
const voiceRoutes = require('../routes/voice');
app.use('/api/voice', voiceRoutes);

// Dashboard routes
const dashboardRoutes = require('../routes/dashboard');
app.use('/api/dashboard', dashboardRoutes);

// Legacy/Compatibility routes
// Map /conversations -> history
app.use('/api/conversations', historyRoutes);

// Map /user/profile -> profile
// But express router mounting strips prefix. We need to be careful.
// The historyRoutes already has /:id for GET /api/history/:id
// The legacy route is /api/conversations/:id -> historyRoutes handles this fine.

// Proxy /api/v1 to DataAPI (localhost:3003)
app.use('/api/v1', (req, res, next) => {
  if (process.env.DATAAPI_API_KEY) {
    req.headers['x-api-key'] = process.env.DATAAPI_API_KEY;
  }
  next();
}, createProxyMiddleware({
  target: process.env.DATAAPI_BASE_URL ? `${process.env.DATAAPI_BASE_URL}/api/v1` : 'http://localhost:3003/api/v1',
  changeOrigin: true
}));

// Mount Main API routes (Chat, Feedback, Ollama)
// This is still 'api.js' but stripped of other concerns
const apiRoutes = require('../routes/api');
app.use('/api', apiRoutes);

// Health Check - Basic
app.get('/health', (_req, res) => {
  const isHealthy = systemHealth.mongodb.status === 'connected';

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    port: process.env.PORT || 3080,
    details: {
        mongodb: systemHealth.mongodb.status,
        ollama: systemHealth.ollama.status
    }
  });
});

// Config endpoint - expose server configuration
app.get('/api/config', (_req, res) => {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
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
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

module.exports = { app, systemHealth };
