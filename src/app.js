const express = require('express');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
const logger = require('../config/logger');
const { requestLogger, errorLogger } = require('./middleware/logging');
const { attachUser } = require('./middleware/auth');

// Initialize app
const app = express();
const IN_PROD = process.env.NODE_ENV === 'production';

// System Health State (exported for updates)
const systemHealth = {
  mongodb: { status: 'checking', lastCheck: null, error: null },
  ollama: { status: 'checking', lastCheck: null, error: null },
  startup: new Date().toISOString()
};

// Middleware Setup
app.use(cors({
  origin: IN_PROD ? ['http://192.168.2.33:3080', 'http://192.168.2.12'] : true,
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Session configuration
const store = new MongoDBStore({
  uri: process.env.MONGODB_URI,
  collection: 'sessions',
  databaseName: 'agentx',
  connectionOptions: {
    useNewUrlParser: true,
    useUnifiedTopology: true
  }
});

store.on('error', (error) => {
  logger.error('Session store error:', error);
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'agentx-secret-change-in-production',
  name: 'agentx.sid',
  resave: false,
  saveUninitialized: false,
  store: store,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24, // 24 hours
    httpOnly: true,
    secure: IN_PROD,
    sameSite: IN_PROD ? 'none' : 'lax'
  }
}));

// Attach user to all requests (from session)
app.use(attachUser);

// Request logging middleware
app.use(requestLogger);

// Auth routes (must come before protected routes)
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

// Mount API routes
const apiRoutes = require('../routes/api');
app.use('/api', apiRoutes);

// Health Check - Basic
app.get('/health', (_req, res) => {
  const isHealthy = systemHealth.mongodb.status === 'connected' &&
                   systemHealth.ollama.status === 'connected';

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    port: process.env.PORT || 3080
  });
});

// Health Check - Detailed (Dependencies injected or imported in server.js, but logic here needs helpers)
// To keep app.js clean, we will export the app and let server.js handle the detailed health check route
// OR we move the health check logic to a separate controller/service.
// For now, to match server.js functionality, we'll keep the route here but it needs access to health check functions.
// We will export systemHealth so server.js can update it.

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
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

module.exports = { app, systemHealth };
