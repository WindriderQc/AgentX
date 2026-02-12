/**
 * Operations Center API Routes
 *
 * Unified operations API consolidating:
 * - System health checks (all services)
 * - n8n workflow management
 * - Activity timeline
 * - System metrics
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const logger = require('../config/logger');
const ActivityLog = require('../models/ActivityLog');
const { systemHealth } = require('../src/app');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// n8n configuration
const N8N_BASE = process.env.N8N_URL || 'http://localhost:5678';

// Workflow definitions (from n8n-monitor.html)
const WORKFLOWS = [
  { id: 'N0.0', name: 'Deployment Test', webhook: 'test-deployment', type: 'GET' },
  { id: 'N0.1', name: 'Health Dashboard', webhook: 'sbqc-health', type: 'GET' },
  { id: 'N1.1', name: 'System Health Monitor', webhook: 'sbqc-n1-1-system-health', type: 'GET' },
  { id: 'N1.3', name: 'Ops Diagnostic', webhook: 'sbqc-n1-3-ops-diagnostic', type: 'GET' },
  { id: 'N2.1', name: 'NAS Scan', webhook: 'sbqc-n2-1-nas-scan', type: 'POST' },
  { id: 'N2.2', name: 'NAS Full Scan', webhook: 'sbqc-n2-2-nas-full-scan', type: 'POST' },
  { id: 'N2.3', name: 'RAG Ingest', webhook: 'sbqc-n2-3-rag-ingest', type: 'POST' },
  { id: 'N3.1', name: 'Model Health & Latency Monitor', webhook: 'sbqc-n3-1-model-monitor', type: 'GET' },
  { id: 'N3.2', name: 'External AI Trigger Gateway', webhook: 'sbqc-ai-query', type: 'POST' },
  { id: 'N5.1', name: 'Feedback Analysis', webhook: 'sbqc-n5-1-feedback-analysis', type: 'GET' }
];

// ========================================
// Unified Health Check
// ========================================

/**
 * GET /api/operations/health
 * Comprehensive system health check for all services
 */
router.get('/health', async (req, res) => {
  try {
    // 0. Fetch PM2 Data if available
    let pm2Data = {};
    try {
      const { stdout } = await execPromise('pm2 jlist');
      const list = JSON.parse(stdout);
      list.forEach(proc => {
        if (proc.pm2_env.status === 'online') {
            // Keep the longest uptime if multiple instances (or just any)
            const uptime = Math.floor((Date.now() - proc.pm2_env.pm_uptime) / 1000);
            pm2Data[proc.name] = uptime;
        }
      });
    } catch (e) { /* ignore pm2 errors */ }

    const healthStatus = {
      timestamp: new Date().toISOString(),
      status: 'healthy', // Will be downgraded if any service fails
      services: {},
      metrics: {},
      system: {}
    };

    // 1. AgentX (always up if we're responding)
    healthStatus.services.agentx = {
      status: 'up',
      uptime: Math.floor(process.uptime()),
      pm2Uptime: pm2Data['agentx'],
      version: require('../package.json').version || '1.4.1',
      nodeVersion: process.version,
      pid: process.pid
    };

    // 2. MongoDB
    try {
      const mongoState = mongoose.connection.readyState;
      const isConnected = mongoState === 1;

      healthStatus.services.mongodb = {
        status: isConnected ? 'up' : 'down',
        readyState: mongoState,
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        db: mongoose.connection.name
      };

      if (isConnected) {
        // Get database stats
        const stats = await mongoose.connection.db.stats();
        healthStatus.services.mongodb.collections = stats.collections;
        healthStatus.services.mongodb.documents = stats.objects;
        healthStatus.services.mongodb.dataSize = Math.round(stats.dataSize / 1024 / 1024 * 100) / 100; // MB

        // Total on-disk size (data + indexes). Prefer Mongo's totalSize when available.
        const totalSizeBytes =
          typeof stats.totalSize === 'number'
            ? stats.totalSize
            : (Number(stats.storageSize) || 0) + (Number(stats.indexSize) || 0);
        healthStatus.services.mongodb.totalSizeMb = Math.round(totalSizeBytes / 1024 / 1024 * 100) / 100; // MB
      } else {
        healthStatus.status = 'degraded';
      }
    } catch (error) {
      healthStatus.services.mongodb = { status: 'error', error: error.message };
      healthStatus.status = 'degraded';
    }

    // 3. Ollama (primary host)
    try {
      const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
      const fetch = require('node-fetch');
      const response = await fetch(`${ollamaHost}/api/tags`, { timeout: 5000 });

      if (response.ok) {
        const data = await response.json();
        healthStatus.services.ollama = {
          status: 'up',
          host: ollamaHost,
          models: data.models?.length || 0
        };
      } else {
        healthStatus.services.ollama = { status: 'down', host: ollamaHost };
        healthStatus.status = 'degraded';
      }
    } catch (error) {
      healthStatus.services.ollama = {
        status: 'error',
        host: process.env.OLLAMA_HOST,
        error: error.message
      };
      healthStatus.status = 'degraded';
    }

    // 4. DataAPI
    try {
      const dataapiUrl = process.env.DATAAPI_BASE_URL || 'http://127.0.0.1:3003';
      const fetch = require('node-fetch');

      // DataAPI has a public /health endpoint (no auth required)
      const response = await fetch(`${dataapiUrl}/health`, { timeout: 5000 });

      if (response.ok) {
        const data = await response.json();
        healthStatus.services.dataapi = {
          status: 'up',
          url: dataapiUrl,
          uptime: pm2Data['dataapi'],
          version: data.version || 'unknown'
        };
      } else {
        healthStatus.services.dataapi = { status: 'down', url: dataapiUrl };
      }
    } catch (error) {
      healthStatus.services.dataapi = {
        status: 'error',
        url: process.env.DATAAPI_BASE_URL,
        error: error.message
      };
    }

    // 5. n8n
    try {
      const fetch = require('node-fetch');
      const response = await fetch(`${N8N_BASE}/healthz`, { timeout: 5000 });

      if (response.ok) {
        healthStatus.services.n8n = {
          status: 'up',
          url: N8N_BASE,
          workflows: WORKFLOWS.length
        };
      } else {
        healthStatus.services.n8n = { status: 'down', url: N8N_BASE };
      }
    } catch (error) {
      healthStatus.services.n8n = {
        status: 'error',
        url: N8N_BASE,
        error: error.message
      };
    }

    // 6. Qdrant (if configured)
    if (process.env.VECTOR_STORE_TYPE === 'qdrant') {
      try {
        const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
        const fetch = require('node-fetch');
        const response = await fetch(`${qdrantUrl}/healthz`, { timeout: 5000 });

        if (response.ok) {
          healthStatus.services.qdrant = {
            status: 'up',
            url: qdrantUrl,
            uptime: pm2Data['qdrant']
          };
        } else {
          healthStatus.services.qdrant = { status: 'down', url: qdrantUrl };
        }
      } catch (error) {
        healthStatus.services.qdrant = {
          status: 'error',
          url: process.env.QDRANT_URL,
          error: error.message
        };
      }
    }

    // 7. System Metrics
    const memUsage = process.memoryUsage();
    healthStatus.system = {
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100, // MB
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100, // MB
        rss: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100, // MB
        external: Math.round(memUsage.external / 1024 / 1024 * 100) / 100 // MB
      },
      uptime: Math.floor(process.uptime()),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version
    };

    // 8. Recent Metrics (last 24 hours)
    try {
      const PerformanceSnapshot = require('../models/PerformanceSnapshot');
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const recentSnapshots = await PerformanceSnapshot.find({
        hour: { $gte: oneDayAgo }
      }).lean();

      if (recentSnapshots.length > 0) {
        // Aggregate across all hourly snapshots
        const totalRequests = recentSnapshots.reduce((sum, s) => sum + (s.requests_total || 0), 0);
        const totalErrors = recentSnapshots.reduce((sum, s) => sum + (s.requests_failed || 0), 0);
        const avgLatency = recentSnapshots.reduce((sum, s) => sum + (s.latency?.avg || 0), 0) / recentSnapshots.length;

        healthStatus.metrics = {
          requests24h: totalRequests,
          avgLatency: Math.round(avgLatency * 100) / 100, // ms
          errorRate: totalRequests > 0
            ? Math.round((totalErrors / totalRequests) * 10000) / 100 // percentage
            : 0,
          errorCount: totalErrors
        };
      } else {
        healthStatus.metrics = {
          requests24h: 0,
          avgLatency: 0,
          errorRate: 0,
          errorCount: 0
        };
      }
    } catch (error) {
      logger.error('Failed to fetch recent metrics', { error: error.message });
      healthStatus.metrics = { error: 'Unable to fetch metrics' };
    }

    res.json(healthStatus);

  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Health check failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ========================================
// n8n Workflow Management
// ========================================

/**
 * GET /api/operations/workflows
 * List all n8n workflows with status
 */
router.get('/workflows', async (req, res) => {
  try {
    const workflowsWithStatus = WORKFLOWS.map(workflow => ({
      ...workflow,
      webhookUrl: `${N8N_BASE}/webhook/${workflow.webhook}`,
      status: 'unknown' // Frontend will test individually
    }));

    res.json({
      status: 'success',
      data: workflowsWithStatus,
      total: WORKFLOWS.length,
      n8nBase: N8N_BASE
    });

  } catch (error) {
    logger.error('Failed to list workflows', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to list workflows',
      error: error.message
    });
  }
});

/**
 * POST /api/operations/workflows/:id/test
 * Test a specific workflow webhook
 */
router.post('/workflows/:id/test', async (req, res) => {
  try {
    const { id } = req.params;
    const { payload } = req.body;

    const workflow = WORKFLOWS.find(w => w.id === id);
    if (!workflow) {
      return res.status(404).json({
        status: 'error',
        message: `Workflow ${id} not found`
      });
    }

    const webhookUrl = `${N8N_BASE}/webhook/${workflow.webhook}`;
    const fetch = require('node-fetch');

    const options = {
      method: workflow.type,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    };

    if (workflow.type === 'POST' && payload) {
      options.body = JSON.stringify(payload);
    }

    const startTime = Date.now();
    const response = await fetch(webhookUrl, options);
    const latency = Date.now() - startTime;

    let responseData;
    try {
      responseData = await response.json();
    } catch (e) {
      responseData = await response.text();
    }

    // Log activity
    await ActivityLog.logActivity({
      action: 'system_action',
      target: `workflow_test_${workflow.id}`,
      details: { workflowId: workflow.id, latency, statusCode: response.status },
      status: response.ok ? 'success' : 'failure'
    });

    res.json({
      status: 'success',
      workflow: {
        id: workflow.id,
        name: workflow.name,
        webhookUrl
      },
      response: {
        statusCode: response.status,
        statusText: response.statusText,
        ok: response.ok,
        latency,
        data: responseData
      }
    });

  } catch (error) {
    logger.error('Workflow test failed', { workflowId: req.params.id, error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Workflow test failed',
      error: error.message
    });
  }
});

// ========================================
// Activity Timeline
// ========================================

/**
 * GET /api/operations/activity
 * Get recent system activity across all sources
 */
router.get('/activity', async (req, res) => {
  try {
    const { limit = 50, hours = 24 } = req.query;

    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    // 1. Activity Logs
    const activityLogs = await ActivityLog.find({ timestamp: { $gte: cutoff } })
      .sort({ timestamp: -1 })
      .limit(parseInt(limit, 10))
      .lean();

    // 2. Recent Alerts (if Alert model exists)
    let recentAlerts = [];
    try {
      const Alert = require('../models/Alert');
      recentAlerts = await Alert.find({ createdAt: { $gte: cutoff } })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
    } catch (e) {
      // Alert model may not exist
    }

    // 3. Merge and sort by timestamp
    const timeline = [
      ...activityLogs.map(log => ({
        type: 'activity',
        action: log.action,
        target: log.target,
        username: log.username,
        status: log.status,
        timestamp: log.timestamp,
        details: log.details
      })),
      ...recentAlerts.map(alert => ({
        type: 'alert',
        level: alert.level,
        message: alert.message,
        timestamp: alert.createdAt,
        resolved: alert.status === 'resolved'
      }))
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, parseInt(limit, 10));

    res.json({
      status: 'success',
      data: timeline,
      total: timeline.length,
      period: `${hours}h`
    });

  } catch (error) {
    logger.error('Failed to get activity timeline', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch activity timeline',
      error: error.message
    });
  }
});

// ========================================
// Real-Time Events (SSE)
// ========================================

/**
 * GET /api/operations/events
 * Server-Sent Events endpoint for real-time dashboard updates
 */
router.get('/events', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering

  // Helper to send SSE event
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial connection event
  sendEvent('connected', {
    message: 'Operations dashboard connected',
    timestamp: new Date().toISOString()
  });

  // Import systemEvents from app
  const { systemEvents } = require('../src/app');

  // Event listeners
  const healthChangeHandler = (data) => {
    sendEvent('health-change', data);
  };

  const activityLogHandler = (data) => {
    sendEvent('activity', data);
  };

  const alertHandler = (data) => {
    sendEvent('alert', data);
  };

  const workflowTestHandler = (data) => {
    sendEvent('workflow-test', data);
  };

  const ragActivityHandler = (data) => {
    sendEvent('rag-activity', data);
  };

  // Register listeners
  systemEvents.on('health-change', healthChangeHandler);
  systemEvents.on('activity-log', activityLogHandler);
  systemEvents.on('alert-created', alertHandler);
  systemEvents.on('workflow-test', workflowTestHandler);
  systemEvents.on('rag-activity', ragActivityHandler);

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeatInterval = setInterval(() => {
    sendEvent('heartbeat', { timestamp: new Date().toISOString() });
  }, 30000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    systemEvents.off('health-change', healthChangeHandler);
    systemEvents.off('activity-log', activityLogHandler);
    systemEvents.off('alert-created', alertHandler);
    systemEvents.off('workflow-test', workflowTestHandler);
    systemEvents.off('rag-activity', ragActivityHandler);
    logger.info('Dashboard client disconnected from SSE');
  });

  logger.info('Dashboard client connected to SSE');
});

module.exports = router;
