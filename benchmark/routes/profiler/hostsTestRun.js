// Host-test configuration, readiness, single-run and run-all routes (mounted by ./hosts.js).
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const {
  testModelOnHost,
  testAllModelsOnHost,
  checkHost,
  getConfig
} = require('../../src/services/hostTestService');
const liveProbeService = require('../../src/services/profiler/liveProbeService');
const baselineModelService = require('../../src/services/profiler/baselineModelService');
const { acquireProfilerClaimLease } = require('../../src/services/profiler/profilerClaimLifecycle');

const logger = require('../../config/logger');

// ── In-memory progress tracker for run-all ──────────────────────────────────
const activeTests = new Map();
const TEST_TTL_MS = 30 * 60 * 1000;
function cleanupStale() {
  const now = Date.now();
  for (const [id, test] of activeTests) {
    if (now - test.startedAt > TEST_TTL_MS) activeTests.delete(id);
  }
}
const { buildBaselineFromResults, updateBaselineUnderLease } = require('../../src/services/profiler/hostTestBaseline');
const { runHostJournaled } = require('../../src/services/profiler/profilerHostRouteJournal');

// ═══ HOST TEST CONFIG (static /test/* — before /:hostId) ════════════════════

/** GET /test/config — baseline model + test parameters */
router.get('/test/config', async (_req, res) => {
  try {
    const svcConfig = getConfig();
    res.json({ status: 'success', data: {
      baselineModel: await baselineModelService.getBaselineModel(),
      timeoutMs: svcConfig.timeoutMs,
      numPredict: svcConfig.numPredict,
      contextFillPct: svcConfig.contextFillPct,
      warmup: svcConfig.warmup,
    }});
  } catch (_) {
    res.status(500).json({ status: 'error', message: 'Unable to resolve profiler baseline configuration' });
  }
});

/** PUT /test/config — save baseline model to DB */
router.put('/test/config', async (req, res) => {
  try {
    const { baselineModel } = req.body;
    const saved = await baselineModelService.setBaselineModel(baselineModel);
    res.json({ status: 'success', data: { baselineModel: saved } });
  } catch (err) { res.status(err.statusCode || 500).json({ status: 'error', error: err.message, message: err.message }); }
});

// ═══ HOST TESTING ═════════════════════════════════════════════════════════���═

/** GET /test/hosts-status — all configured hosts with live connectivity */
router.get('/test/hosts-status', async (_req, res) => {
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
      data: { hosts: results, total: results.length, available: results.filter(h => h.available).length }
    });
  } catch (err) {
    logger.error('Failed to get hosts status', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/** POST /test/ensure-baseline — pull the configured baseline when absent. */
router.post('/test/ensure-baseline', async (req, res) => {
  let lease;
  try {
    const target = baselineModelService.resolveConfiguredHost(req.body?.hostId);
    const operationId = `profiler-baseline-${crypto.randomBytes(8).toString('hex')}`;
    lease = await acquireProfilerClaimLease([target.url], operationId, 30 * 60 * 1000);
    const data = await baselineModelService.ensureBaselineModel(req.body?.hostId, {
      signal: lease.signal,
      assertClaimActive: lease.assertActive,
      operationId
    });
    lease.assertActive();
    await lease.finalize(data.pulled ? {
      beforeWorkloadRelease: () => baselineModelService.resolveBaselineReconciliation(
        req.body?.hostId,
        data.reconciliation,
        { assertClaimActive: lease.assertActive }
      )
    } : {});
    lease = null;
    res.json({
      status: 'success',
      data,
      message: data.pulled
        ? `Pulled ${data.modelName} to ${data.hostName}.`
        : `${data.modelName} is already installed on ${data.hostName}.`
    });
  } catch (err) {
    if (lease && err.retainAdmission === true) {
      await lease.abandon(err);
      lease = null;
    }
    logger.error('Baseline model preparation failed', { hostId: req.body?.hostId, error: err.message });
    res.status(err.statusCode || 502).json({ status: 'error', message: err.message, code: err.code || null });
  } finally {
    if (lease) await lease.finalize().catch(error => logger.error('Baseline lease finalization failed', { error: error.message }));
  }
});

/** POST /test/detect-host — detect an ad-hoc Ollama host and persist it as a HostProfile */
router.post('/test/detect-host', async (req, res) => {
  try {
    const data = await liveProbeService.detectOllamaHost(req.body || {});
    res.json({ status: 'success', data });
  } catch (err) {
    logger.warn('Profiler host detection failed', {
      error: err.message,
      targetProvided: typeof req.body?.hostUrl === 'string' && Boolean(req.body.hostUrl.trim()),
      displayNameProvided: typeof req.body?.displayName === 'string' && Boolean(req.body.displayName.trim())
    });
    res.status(err.statusCode || 500).json({
      status: 'error',
      message: err.message,
      data: err.data || null
    });
  }
});

/** GET /test/live-probes/status — validate live probe readiness for all HostProfiles */
router.get('/test/live-probes/status', async (_req, res) => {
  try {
    const data = await liveProbeService.getLiveProbeStatus();
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('Live probe status failed', { error: err.message });
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  }
});

/** GET /test/live-probes/:hostId/status — validate live probe readiness for one host */
router.get('/test/live-probes/:hostId/status', async (req, res) => {
  try {
    const data = await liveProbeService.getLiveProbeStatus(req.params.hostId);
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('Live probe status failed', { hostId: req.params.hostId, error: err.message });
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  }
});

/** POST /test/run — single model test on a host */
router.post('/test/run', async (req, res) => {
  let lease;
  let operationId = null;
  try {
    const { modelName, hostId } = req.body;
    if (!modelName || !hostId) {
      return res.status(400).json({ status: 'error', message: 'modelName and hostId are required' });
    }
    const configuredHost = baselineModelService.resolveConfiguredHost(hostId);
    const baselineModel = await baselineModelService.getBaselineModel();
    const isBaseline = String(modelName).trim().replace(/:latest$/i, '').toLowerCase()
      === String(baselineModel).trim().replace(/:latest$/i, '').toLowerCase();
    operationId = `profiler-host-test-${crypto.randomBytes(8).toString('hex')}`;
    lease = await acquireProfilerClaimLease([configuredHost.url], operationId, 30 * 60 * 1000);
    const preparation = isBaseline && hostId
      ? await baselineModelService.ensureBaselineModel(hostId, {
        signal: lease.signal,
        assertClaimActive: lease.assertActive,
        operationId
      })
      : null;
    const targetHostUrl = preparation?.hostUrl || configuredHost.url;
    const snapshot = await runHostJournaled(lease, { hostId, hostUrl: targetHostUrl, modelName }, () => testModelOnHost(modelName, targetHostUrl, {
      hostId,
      benchmarkClaim: lease.identityFor(targetHostUrl),
      assertClaimActive: lease.assertActive,
      signal: lease.signal
    }));
    lease.assertActive();
    if (isBaseline && snapshot?.status === 'pass') {
      lease.assertActive();
      await updateBaselineUnderLease(hostId, {
        referenceModel: modelName,
        tokensPerSec: snapshot.tokensPerSec,
        latencyMs: snapshot.latencyMs,
        ttftMs: snapshot.timeToFirstTokenMs,
        ttftMeasurement: snapshot.ttftMeasurement || undefined,
        testedAt: snapshot.testedAt
      }, lease);
    }
    await lease.finalize();
    lease = null;
    res.json({ status: 'success', data: { ...snapshot, preparation } });
  } catch (err) {
    if (lease && err.retainAdmission === true) {
      await lease.abandon(err);
      lease = null;
    }
    logger.error('Host test run failed', { error: err.message, body: req.body });
    const code = err.statusCode || (err.message.includes('not found') ? 422
      : err.message.includes('unreachable') ? 503 : 500);
    res.status(code).json({ status: 'error', message: err.message, code: err.code || null });
  } finally {
    if (lease) {
      await lease.finalize().catch(error => logger.error('Host test lease finalization failed', { error: error.message }));
    }
  }
});

/** POST /test/run-all — test all models on a host (background) */
router.post('/test/run-all', async (req, res) => {
  try {
    const { hostId } = req.body;
    if (!hostId) return res.status(400).json({ status: 'error', message: 'hostId is required' });
    const hostUrl = baselineModelService.resolveConfiguredHost(hostId).url;
    const hostCheck = await checkHost(hostUrl);
    if (!hostCheck.available) return res.status(503).json({ status: 'error', message: `Host unreachable: ${hostCheck.error}` });
    const baselineModel = await baselineModelService.getBaselineModel();
    cleanupStale();
    const testId = crypto.randomBytes(8).toString('hex');
    const tracker = { status: 'running', total: hostCheck.models.length, completed: 0, failed: 0, currentModel: hostCheck.models[0] || null, results: [], startedAt: Date.now() };
    const lease = await acquireProfilerClaimLease([hostUrl], `profiler-host-all-${testId}`, Math.max(10 * 60 * 1000, hostCheck.models.length * 5 * 60 * 1000), {
      onFatal: err => { tracker.status = 'failed'; tracker.error = err.message; }
    });
    activeTests.set(testId, tracker);
    runHostJournaled(lease, { hostId, hostUrl, modelName: hostCheck.models.join(',') }, () => testAllModelsOnHost(hostUrl, {
      hostId,
      benchmarkClaim: lease.identityFor(hostUrl),
      assertClaimActive: lease.assertActive,
      signal: lease.signal,
      shouldAbort: () => lease.lost,
      onProgress: (modelName, result, index, total) => {
        tracker.completed = index + 1;
        tracker.currentModel = index + 1 < total ? hostCheck.models[index + 1] : null;
        if (result.status !== 'pass') tracker.failed++;
        tracker.results.push({ modelName, ...result });
      }
    })).then(async ({ summary }) => {
      lease.assertActive();
      tracker.status = 'completed'; tracker.summary = summary; tracker.currentModel = null;
      const baseline = buildBaselineFromResults(tracker.results, baselineModel);
      if (hostId && baseline) {
        lease.assertActive();
        await updateBaselineUnderLease(hostId, baseline, lease);
      }
    }).catch(async err => {
      tracker.status = 'failed';
      tracker.error = err.message;
      if (err.retainAdmission === true) await lease.abandon(err);
    })
      .finally(async () => {
        try {
          await lease.finalize();
        } catch (error) {
          tracker.status = 'failed';
          tracker.error = error.message;
        }
      });
    res.json({ status: 'success', data: { testId, totalModels: hostCheck.models.length, models: hostCheck.models } });
  } catch (err) { res.status(err.statusCode || 500).json({ status: 'error', message: err.message }); }
});

/** GET /test/run-all/:testId/progress */
router.get('/test/run-all/:testId/progress', (req, res) => {
  const tracker = activeTests.get(req.params.testId);
  if (!tracker) return res.status(404).json({ status: 'error', message: 'Test not found or expired' });
  res.json({ status: 'success', data: {
    testStatus: tracker.status, total: tracker.total, completed: tracker.completed,
    failed: tracker.failed, currentModel: tracker.currentModel,
    results: tracker.results, summary: tracker.summary || null, error: tracker.error || null
  }});
});

module.exports = router;
