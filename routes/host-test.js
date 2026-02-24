/**
 * Host Test Routes
 *
 * API endpoints for running performance tests on models across Ollama hosts.
 * Results persist to ModelRegistry.hostPerformance[] and update capabilities.
 *
 * Endpoints:
 *   GET  /api/host-test/hosts-status          - All hosts with connectivity + model list
 *   POST /api/host-test/run                   - Test a single model on a host
 *   POST /api/host-test/run-all               - Test all models on a host (background)
 *   GET  /api/host-test/run-all/:testId/progress - Poll batch test progress
 *   GET  /api/host-test/results               - Query all host performance snapshots
 *   GET  /api/host-test/results/:modelName    - Host performance history for a model
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const logger = require('../config/logger');
const ModelRegistry = require('../models/ModelRegistry');
const { testModelOnHost, testAllModelsOnHost, checkHost } = require('../src/services/hostTest/hostTestService');
const { requireAuth } = require('../src/middleware/auth');

// ── Host Discovery (same logic as ollama-hosts.js) ─────────────────────────────

function normalizeHostUrl(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function getConfiguredHosts() {
  const hosts = [];
  const envFirst = (...keys) => {
    for (const key of keys) {
      const v = process.env[key];
      if (v && String(v).trim()) return String(v).trim();
    }
    return null;
  };

  const primary = normalizeHostUrl(envFirst('OLLAMA_HOST', 'OLLAMA_HOST_1', 'OLLAMA_HOST_PRIMARY'));
  if (primary) hosts.push({ id: 'primary', name: 'Primary', url: primary, priority: 1 });

  const secondary = normalizeHostUrl(envFirst('OLLAMA_HOST_2', 'OLLAMA_HOST_HEAVY', 'OLLAMA_HOST_SECONDARY'));
  if (secondary) hosts.push({ id: 'secondary', name: 'Secondary', url: secondary, priority: 2 });

  const tertiary = normalizeHostUrl(envFirst('OLLAMA_HOST_3', 'OLLAMA_HOST_TERTIARY'));
  if (tertiary) hosts.push({ id: 'tertiary', name: 'Tertiary', url: tertiary, priority: 3 });

  return hosts;
}

// ── In-Memory Progress Tracker ─────────────────────────────────────────────────

const activeTests = new Map();
const TEST_TTL_MS = 30 * 60 * 1000; // 30 min auto-cleanup

function cleanupStale() {
  const now = Date.now();
  for (const [id, test] of activeTests) {
    if (now - test.startedAt > TEST_TTL_MS) activeTests.delete(id);
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/host-test/hosts-status
 * Returns all configured hosts with connectivity, model count, latency.
 */
router.get('/hosts-status', async (_req, res) => {
  try {
    const configured = getConfiguredHosts();
    const results = await Promise.all(
      configured.map(async (host) => {
        const check = await checkHost(host.url);
        return {
          ...host,
          available: check.available,
          latency: check.latency,
          modelCount: check.models.length,
          models: check.models,
          error: check.error || null
        };
      })
    );

    res.json({
      status: 'success',
      data: {
        hosts: results,
        total: results.length,
        available: results.filter(h => h.available).length
      }
    });
  } catch (err) {
    logger.error('Failed to get hosts status', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * POST /api/host-test/run
 * Run a single model performance test on a host.
 * Body: { modelName, hostUrl, hostId? }
 */
router.post('/run', requireAuth, async (req, res) => {
  try {
    const { modelName, hostUrl, hostId } = req.body;
    if (!modelName || !hostUrl) {
      return res.status(400).json({ status: 'error', message: 'modelName and hostUrl are required' });
    }

    const snapshot = await testModelOnHost(modelName, hostUrl, { hostId });
    res.json({ status: 'success', data: snapshot });
  } catch (err) {
    logger.error('Host test run failed', { error: err.message, body: req.body });
    const code = err.message.includes('not found') ? 404
      : err.message.includes('unreachable') ? 503 : 500;
    res.status(code).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/host-test/run-all
 * Test all models on a host (background). Returns immediately with testId.
 * Body: { hostUrl, hostId? }
 */
router.post('/run-all', requireAuth, async (req, res) => {
  try {
    const { hostUrl, hostId } = req.body;
    if (!hostUrl) {
      return res.status(400).json({ status: 'error', message: 'hostUrl is required' });
    }

    // Check host availability and get model count
    const hostCheck = await checkHost(hostUrl);
    if (!hostCheck.available) {
      return res.status(503).json({ status: 'error', message: `Host unreachable: ${hostCheck.error}` });
    }

    cleanupStale();

    const testId = crypto.randomBytes(8).toString('hex');
    const tracker = {
      status: 'running',
      total: hostCheck.models.length,
      completed: 0,
      failed: 0,
      currentModel: null,
      results: [],
      startedAt: Date.now()
    };
    activeTests.set(testId, tracker);

    // Fire-and-forget
    testAllModelsOnHost(hostUrl, {
      hostId,
      onProgress: (modelName, result, index, total) => {
        tracker.completed = index + 1;
        tracker.currentModel = index + 1 < total ? hostCheck.models[index + 1] : null;
        if (result.status !== 'pass') tracker.failed++;
        tracker.results.push({ modelName, ...result });
      }
    }).then(({ summary }) => {
      tracker.status = 'completed';
      tracker.summary = summary;
      tracker.currentModel = null;
      logger.info('Host test run-all completed', { testId, hostUrl, summary });
    }).catch(err => {
      tracker.status = 'failed';
      tracker.error = err.message;
      logger.error('Host test run-all failed', { testId, hostUrl, error: err.message });
    });

    res.json({
      status: 'success',
      data: { testId, totalModels: hostCheck.models.length, models: hostCheck.models }
    });
  } catch (err) {
    logger.error('Failed to start run-all', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/host-test/run-all/:testId/progress
 * Poll progress of a batch test.
 */
router.get('/run-all/:testId/progress', (req, res) => {
  const tracker = activeTests.get(req.params.testId);
  if (!tracker) {
    return res.status(404).json({ status: 'error', message: 'Test not found or expired' });
  }
  res.json({
    status: 'success',
    data: {
      testStatus: tracker.status,
      total: tracker.total,
      completed: tracker.completed,
      failed: tracker.failed,
      currentModel: tracker.currentModel,
      results: tracker.results,
      summary: tracker.summary || null,
      error: tracker.error || null
    }
  });
});

/**
 * GET /api/host-test/results
 * Query all host performance snapshots across models.
 * Query params: hostUrl?, hostId?, limit (default 100)
 */
router.get('/results', async (req, res) => {
  try {
    const { hostUrl, hostId, limit: rawLimit } = req.query;
    const limit = Math.min(parseInt(rawLimit, 10) || 100, 500);

    const query = { isActive: true, 'hostPerformance.0': { $exists: true } };
    const models = await ModelRegistry.find(query, {
      modelName: 1, displayName: 1, hostPerformance: 1, capabilities: 1
    }).lean();

    let results = [];
    for (const model of models) {
      for (const snap of (model.hostPerformance || [])) {
        if (hostUrl && snap.hostUrl !== hostUrl) continue;
        if (hostId && snap.hostId !== hostId) continue;
        results.push({ modelName: model.modelName, displayName: model.displayName, ...snap });
      }
    }

    // Sort by testedAt desc, apply limit
    results.sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt));
    results = results.slice(0, limit);

    const passing = results.filter(r => r.status === 'pass');
    const summary = {
      modelsTested: new Set(results.map(r => r.modelName)).size,
      totalSnapshots: results.length,
      avgTps: passing.length > 0
        ? Number((passing.reduce((s, r) => s + r.tokensPerSec, 0) / passing.length).toFixed(2))
        : 0,
      avgLatency: passing.length > 0
        ? Math.round(passing.reduce((s, r) => s + r.latencyMs, 0) / passing.length)
        : 0
    };

    res.json({ status: 'success', data: { results, summary } });
  } catch (err) {
    logger.error('Failed to get host test results', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/host-test/results/:modelName
 * Get host performance history for a specific model.
 */
router.get('/results/:modelName', async (req, res) => {
  try {
    const model = await ModelRegistry.findOne(
      { modelName: req.params.modelName },
      { modelName: 1, displayName: 1, hostPerformance: 1, capabilities: 1 }
    ).lean();

    if (!model) {
      return res.status(404).json({ status: 'error', message: `Model not found: ${req.params.modelName}` });
    }

    res.json({
      status: 'success',
      data: {
        modelName: model.modelName,
        displayName: model.displayName,
        capabilities: model.capabilities,
        hostPerformance: (model.hostPerformance || []).sort(
          (a, b) => new Date(b.testedAt) - new Date(a.testedAt)
        )
      }
    });
  } catch (err) {
    logger.error('Failed to get model host results', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
