require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const fetch = require('node-fetch');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
const logger = require('../config/logger');
const { requestLogger, errorLogger } = require('./middleware/logging');
const { attachUser } = require('./middleware/auth');
const systemHealth = require('./systemHealth');
const { normalizeHostUrl } = require('./helpers/ollamaHostConfig');

const DATAAPI_BASE_URL = normalizeHostUrl(process.env.DATAAPI_BASE_URL) || 'http://127.0.0.1:3003';
const DATAAPI_API_KEY = process.env.DATAAPI_API_KEY;
const PRIMARY_OLLAMA_HOST = normalizeHostUrl(process.env.OLLAMA_HOST) || 'http://127.0.0.1:11434';

function getDataApiHeaders() {
  return DATAAPI_API_KEY ? { 'x-api-key': DATAAPI_API_KEY } : {};
}

// Initialize app
const app = express();
const IN_PROD = process.env.NODE_ENV === 'production';
const IN_TEST = process.env.NODE_ENV === 'test';

// EventEmitter for system events (SSE broadcasting)
const EventEmitter = require('events');
const systemEvents = new EventEmitter();

// Security Headers Configuration
if (process.env.NODE_ENV === 'production') {
  // Production: Use Helmet with strict CSP
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'", // TODO: Remove after refactoring inline scripts
          "https://cdn.jsdelivr.net" // marked.js, Chart.js
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'", // TODO: Remove after refactoring inline styles
          "https://fonts.googleapis.com"
        ],
        fontSrc: [
          "'self'",
          "https://fonts.gstatic.com"
        ],
        imgSrc: [
          "'self'",
          "data:", // Base64 images
          "https:" // Allow external images (user avatars, etc.)
        ],
        connectSrc: [
          "'self'"
          // Add Ollama hosts if external
          // process.env.OLLAMA_HOST ? new URL(process.env.OLLAMA_HOST).origin : null
        ].filter(Boolean),
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"], // Equivalent to X-Frame-Options: DENY
        upgradeInsecureRequests: [] // Force HTTPS
      }
    },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true
    },
    referrerPolicy: {
      policy: 'strict-origin-when-cross-origin'
    },
    noSniff: true, // X-Content-Type-Options: nosniff
    xssFilter: true, // X-XSS-Protection: 1; mode=block
    hidePoweredBy: true // Remove X-Powered-By header
  }));

  logger.info('Production security headers enabled (Helmet + CSP)');
} else {
  // Development: Basic security headers only (for local network compatibility)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  logger.info('Development security headers enabled (basic)');
}

// Middleware Setup
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : IN_PROD ? ['http://localhost:3080'] : true;

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(cookieParser());

// Response Compression (Week 3 Day 12: Performance Optimization)
const compression = require('compression');
app.use(compression({
  level: 6, // Balance between speed and compression ratio
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false; // Skip compression if client requests it
    }
    return compression.filter(req, res);
  }
}));

// Janitor Proxy (DataAPI) - Must be before body parser
const janitorRoutes = require('../routes/janitor');
app.use('/api/janitor', janitorRoutes);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

// Session configuration BEFORE static files
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

// Performance tracking middleware (must come early to track all requests)
const performanceTracker = require('./middleware/performanceTracker');
app.use(performanceTracker.trackRequest);

// ============================================
// API ROUTES (must come BEFORE static files)
// ============================================

// Apply rate limiters
const { apiLimiter, benchmarkLimiter, roundtableLimiter, specialXLimiter, chatLimiter, strictLimiter, authLimiter } = require('./middleware/rateLimiter');

// Apply general API rate limiter to all /api routes (except specific ones)
app.use('/api/', apiLimiter);

// Apply strict limiter to expensive operations BEFORE their routers are mounted
app.use('/api/rag/ingest', strictLimiter);
app.use('/api/prompts/:name/analyze-failures', strictLimiter);

// Auth routes (with stricter limit for brute force protection)
const authRoutes = require('../routes/auth');
app.use('/api/auth', authLimiter, authRoutes);

// API Key Management routes (Week 3 Day 7: Security Hardening)
const apiKeysRoutes = require('../routes/api-keys');
app.use('/api/keys', apiKeysRoutes);

// Audit Log routes (Week 3 Day 8: Audit Logging)
const auditLogsRoutes = require('../routes/audit-logs');
app.use('/api/audit-logs', auditLogsRoutes);

// Cache Management routes (Week 3 Day 10: Redis Caching)
const cacheRoutes = require('../routes/cache');
app.use('/api/cache', cacheRoutes);

// Workspace Management routes (Week 4 Day 2: Multi-Tenancy)
const workspaceRoutes = require('../routes/workspaces');
app.use('/api/workspaces', workspaceRoutes);

// Workspace Invitations routes (Post-Week 4: Email Invitations)
const invitationRoutes = require('../routes/invitations');
app.use('/api/invitations', invitationRoutes);

// Workspace Audit Logs routes (Post-Week 4: Activity Audit Logs)
const workspaceAuditRoutes = require('../routes/workspace-audit');
app.use('/api/workspaces', workspaceAuditRoutes);

// Image gallery routes (visual_llm UI)
const galleryRoutes = require('../routes/gallery');
app.use('/api/gallery', galleryRoutes);

// V3: Mount RAG routes
const ragRoutes = require('../routes/rag');
app.use('/api/rag', ragRoutes);

// V4: Mount Analytics & Dataset routes
const analyticsRoutes = require('../routes/analytics');
app.use('/api/analytics', analyticsRoutes);

// Custom Dashboards (Week 4 Day 4) - ARCHIVED 2026-01-09
// Feature archived - not required for current release
// See: /archive/custom-dashboards/README.md
// const customDashboardRoutes = require('../routes/dashboards');
// app.use('/api/dashboards', customDashboardRoutes);

const datasetRoutes = require('../routes/dataset');
app.use('/api/dataset', datasetRoutes);

// Metrics routes (performance monitoring)
const metricsRoutes = require('../routes/metrics');
app.use('/api/metrics', metricsRoutes);

// Config Variant routes (configuration presets for benchmarking)
const configVariantRoutes = require('../routes/configVariant');
app.use('/api/config-variants', configVariantRoutes);

// Alert routes (Track 1: Alerts & Notifications)
const alertRoutes = require('../routes/alerts');
app.use('/api/alerts', alertRoutes);

// Self-Healing routes (Track 4: Self-Healing & Resilience)
const selfHealingRoutes = require('../routes/self-healing');
app.use('/api/self-healing', selfHealingRoutes);

// n8n integration routes (API key authentication)
const n8nRoutes = require('../routes/n8n');
app.use('/api/n8n', n8nRoutes);

// New Modular Routes
const profileRoutes = require('../routes/profile');
app.use('/api/profile', profileRoutes);

const historyRoutes = require('../routes/history');
app.use('/api/history', historyRoutes);

// Voice routes (STT, TTS, voice chat)
const voiceRoutes = require('../routes/voice');
app.use('/api/voice', voiceRoutes);

// Prompt management routes (A/B testing)
const promptRoutes = require('../routes/prompts');
app.use('/api/prompts', promptRoutes);

// Prompt template routes (CRUD, render, duplicate)
const promptTemplateRoutes = require('../routes/prompt-templates');
app.use('/api/prompt-templates', promptTemplateRoutes);

// AgentX routes (unified agents with model + prompt + tools)
const agentRoutes = require('../routes/agents');
app.use('/api/agents', agentRoutes);

// Tool execution routes (N8N proxy for LLM tool calls)
const toolRoutes = require('../routes/tools');
app.use('/api/tools', toolRoutes);

// Benchmark routes (LLM performance testing)
const benchmarkRoutes = require('../routes/benchmark');
app.use('/api/benchmark', benchmarkLimiter, benchmarkRoutes);

// Roundtable routes (multi-agent discussion)
const roundtableRoutes = require('../routes/roundtable');
app.use('/api/roundtable', roundtableLimiter, roundtableRoutes);

// Ollama hosts routes (configuration and models)
const ollamaHostsRoutes = require('../routes/ollama-hosts');
app.use('/api/ollama-hosts', ollamaHostsRoutes);

// Ollama VRAM metrics (via SSH + nvidia-smi)
const ollamaVramRoutes = require('../routes/ollama-vram');
app.use('/api/ollama-vram', ollamaVramRoutes);

// Host performance testing routes
const hostTestRoutes = require('../routes/host-test');
app.use('/api/host-test', hostTestRoutes);

// Host monitoring (agent heartbeats + dashboard)
const hostMonitorRoutes = require('../routes/host-monitor');
app.use('/api/hosts', hostMonitorRoutes);

// Cluster schedule (unified cross-host task schedule + live state)
const clusterScheduleRoutes = require('../routes/cluster-schedule');
app.use('/api/cluster', clusterScheduleRoutes);

// Workflow Generator routes (N6.1)
const workflowGeneratorRoutes = require('../routes/workflowGenerator');
app.use('/api/workflow', workflowGeneratorRoutes);

// Backup & Recovery routes (Track 6)
const backupRoutes = require('../routes/backup');
app.use('/api/backup', backupRoutes);

// Feature Dashboard routes (Tracks 3 & 4)
const featureRoutes = require('../routes/features');
app.use('/api/features', featureRoutes);

// Custom Model Management routes (Track 3)
const customModelsRoutes = require('../routes/custom-models');
app.use('/api/custom-models', customModelsRoutes);

// Model Registry routes (Benchmark Enhancement)
const modelRegistryRoutes = require('../routes/model-registry');
app.use('/api/models/registry', modelRegistryRoutes);

// Unified Models API (Aggregates Ollama + n8n + custom + registry)
const modelsUnifiedRoutes = require('../routes/models-unified');
app.use('/api/models', modelsUnifiedRoutes);

// Performance routes
const performanceRoutes = require('../routes/performance');
app.use('/api/performance', performanceRoutes);

// Dashboard routes
const dashboardRoutes = require('../routes/dashboard');
app.use('/api/dashboard', dashboardRoutes);

// Operations Center routes (unified health, workflows, activity)
const operationsRoutes = require('../routes/operations');
app.use('/api/operations', operationsRoutes);

// Export routes (MD documentation download)
const exportRoutes = require('../routes/export');
app.use('/api/export', exportRoutes);

// Repo Watcher routes (code quality monitoring)
const repoWatcherRoutes = require('../routes/repoWatcher');
app.use('/api/repoWatcher', repoWatcherRoutes);

// DocJanitor routes (documentation maintenance scanning)
const docJanitorRoutes = require('../routes/docJanitor');
app.use('/api/docJanitor', docJanitorRoutes);

// SpecialX automation routes (24/7 queue runner + task profiles)
const specialXRoutes = require('../routes/specialx');
app.use('/api/specialx', specialXLimiter, specialXRoutes);
const specialXProposalRoutes = require('../routes/specialx-proposals');
app.use('/api/specialx/proposals', specialXLimiter, specialXProposalRoutes);

// Inference Telemetry routes (Sprint 1: GPU usage observability)
const inferenceTelemetryRoutes = require('../routes/inference-telemetry');
app.use('/api/telemetry', inferenceTelemetryRoutes);

// Maintenance routes (Sprint 2: unified repo health + finding lifecycle)
const maintenanceRoutes = require('../routes/maintenance');
app.use('/api/maintenance', maintenanceRoutes);

// Legacy/Compatibility routes
// Map /conversations -> history
app.use('/api/conversations', historyRoutes);

// Map /user/profile -> profile
// But express router mounting strips prefix. We need to be careful.
// The historyRoutes already has /:id for GET /api/history/:id
// The legacy route is /api/conversations/:id -> historyRoutes handles this fine.


// Mount Main API routes (Chat, Feedback, Ollama)
// This is still 'api.js' but stripped of other concerns
const apiRoutes = require('../routes/api');
// Apply chat-specific rate limiter to chat endpoint
app.use('/api/chat', chatLimiter);
app.use('/api', apiRoutes);

// ============================================
// STATIC FILES (must come AFTER API routes)
// ============================================
app.use(express.static(path.join(__dirname, '..', 'public')));

// Browsers often request /favicon.ico implicitly. We serve a real icon to avoid noisy 404s.
app.get('/favicon.ico', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'img', 'favicon.ico'));
});

// Legacy UI route: prompt management page was previously personas.html
app.get('/personas.html', (req, res) => {
  res.redirect(301, '/prompts.html');
});

// Health Check - Basic (liveness probe, reads cached in-memory systemHealth)
app.get('/health', (_req, res) => {
  const { version } = require('../package.json');
  const isHealthy = systemHealth.mongodb.status === 'connected';
  const isDegraded =
    systemHealth.ollama.status === 'error' ||
    (systemHealth.qdrant.status !== 'not_configured' && systemHealth.qdrant.status === 'error');

  const overallStatus = !isHealthy ? 'down' : isDegraded ? 'degraded' : 'ok';

  res.status(isHealthy ? 200 : 503).json({
    status: overallStatus,
    version,
    uptime: Math.floor(process.uptime()),
    startup: systemHealth.startup,
    services: {
      mongodb: systemHealth.mongodb,
      ollama: systemHealth.ollama,
      qdrant: systemHealth.qdrant
    }
  });
});

// Config endpoint - expose server configuration
app.get('/api/config', (_req, res) => {
  const ollamaHost = normalizeHostUrl(process.env.OLLAMA_HOST);
  
  if (!ollamaHost) {
    return res.status(500).json({ 
      status: 'error',
      message: 'OLLAMA_HOST environment variable is not configured' 
    });
  }

  const match = ollamaHost.match(/^(?:https?:\/\/)?([^:]+)(?::(\d+))?/);
  const host = match ? match[1] : 'localhost';
  const port = match && match[2] ? match[2] : '11434';

  res.json({
    ollama: {
      host,
      port,
      fullUrl: ollamaHost
    },
    embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text:v1.5'
  });
});

// External Health Check - Checks DataAPI and other Ollama hosts
app.get('/api/health/external', async (_req, res) => {
  const targets = [
    { name: 'dataapi', url: `${DATAAPI_BASE_URL}/health` },
    { name: 'ollama', url: `${PRIMARY_OLLAMA_HOST}/api/tags` },
    { name: 'n8n', url: (process.env.N8N_URL || 'http://localhost:5678') + '/healthz' }
  ];

  const results = {};

  await Promise.all(targets.map(async (target) => {
    try {
      const response = await fetch(target.url, { timeout: 3000 });
      results[target.name] = { status: response.ok ? 'ok' : 'error' };
    } catch (err) {
      results[target.name] = { status: 'error' };
    }
  }));

  res.json(results);
});

// Proxy for DataAPI appevents (to avoid CORS and simplify dashboard)
app.get('/api/events/system', async (req, res) => {
  const limit = req.query.limit || 10;

  if (!DATAAPI_API_KEY) {
    return res.status(503).json({
      status: 'error',
      message: 'DATAAPI_API_KEY environment variable is not configured'
    });
  }

  try {
    const response = await fetch(`${DATAAPI_BASE_URL}/api/v1/collection/appevents/items?limit=${limit}`, {
      headers: getDataApiHeaders()
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[AgentX] Failed to proxy appevents:', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch system events' });
  }
});

// Error logging middleware (must be after routes)
app.use(errorLogger);

// Global error handler
app.use((err, req, res, _next) => {
  // Handle PayloadTooLargeError specifically
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      status: 'error',
      message: 'Payload too large. The document exceeds the maximum allowed size (50MB).',
      code: 'PAYLOAD_TOO_LARGE'
    });
  }

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    status: 'error',
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler for API routes (catch API paths that don't exist)
app.use('/api', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `API endpoint not found: ${req.method} ${req.path}`,
    code: 'API_NOT_FOUND'
  });
});

// SPA Fallback for Frontend Routes
// Serve index.html for all non-API, non-static routes
// This allows client-side routing to work properly
app.use((req, res) => {
  // Check if it's a request for a static file that doesn't exist
  const isStaticRequest = /\.\w+$/.test(req.path); // Has file extension
  
  if (isStaticRequest) {
    // It's a static file request that wasn't found
    res.status(404).json({
      status: 'error',
      message: `Resource not found: ${req.path}`,
      code: 'NOT_FOUND'
    });
  } else {
    // It's a navigation route - serve the SPA
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

module.exports = {
  app,
  systemHealth,
  systemEvents,
  setRagWatcherInstance: (watcher) => {
    app.locals.ragWatcherInstance = watcher;
  }
};
