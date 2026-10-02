// Fleet queue routes: sequential run-all across hosts (mounted by ./hosts.js).
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const { testAllModelsOnHost, checkHost } = require('../../src/services/hostTestService');
const baselineModelService = require('../../src/services/profiler/baselineModelService');
const { acquireProfilerClaimLease } = require('../../src/services/profiler/profilerClaimLifecycle');

const logger = require('../../config/logger');

// ── In-memory fleet-queue tracker (sequential test-all across hosts) ────────
const activeFleetQueues = new Map();
const FLEET_TTL_MS = 6 * 60 * 60 * 1000; // 6h: a full fleet sweep can take a while
function cleanupStaleFleets() {
  const now = Date.now();
  for (const [id, q] of activeFleetQueues) {
    if (now - q.startedAt > FLEET_TTL_MS) activeFleetQueues.delete(id);
  }
}
const { buildBaselineFromResults, updateBaselineUnderLease } = require('../../src/services/profiler/hostTestBaseline');
const { runHostJournaled } = require('../../src/services/profiler/profilerHostRouteJournal');

/** POST /test/run-fleet — sequentially run-all on every selected host */
router.post('/test/run-fleet', async (req, res) => {
  try {
    const { hostIds, includeOffline } = req.body || {};
    const configured = getConfiguredHosts();

    // Resolve target hosts: caller-provided hostIds or all configured.
    let targets = configured;
    if (Array.isArray(hostIds) && hostIds.length) {
      const wanted = new Set(hostIds.map(String));
      targets = configured.filter(h => wanted.has(String(h.id)));
    }

    // Probe connectivity (skip offline unless caller insists)
    const checks = await Promise.all(targets.map(async h => {
      const c = await checkHost(h.url);
      return { host: h, available: c.available, models: c.models, error: c.error || null };
    }));
    const queueHosts = checks.filter(c => includeOffline || c.available);
    if (!queueHosts.length) {
      return res.status(503).json({ status: 'error', message: 'No reachable hosts to queue' });
    }
    const baselineModel = await baselineModelService.getBaselineModel();

    cleanupStaleFleets();
    const queueId = crypto.randomBytes(8).toString('hex');
    const tracker = {
      status: 'running',
      cancelled: false,
      currentIndex: 0,
      totalHosts: queueHosts.length,
      hosts: queueHosts.map(({ host, available, models, error }) => ({
        hostId: host.id,
        hostUrl: host.url,
        displayName: host.name,
        status: available ? 'pending' : 'offline',
        models: models.slice(),
        total: models.length,
        completed: 0,
        failed: 0,
        currentModel: available && models[0] ? models[0] : null,
        results: [],
        summary: null,
        error: available ? null : (error || 'Host unreachable'),
        startedAt: null,
        finishedAt: null
      })),
      summary: null,
      startedAt: Date.now(),
      finishedAt: null,
      error: null
    };
    const lease = await acquireProfilerClaimLease(
      queueHosts.filter(item => item.available).map(item => item.host.url),
      `profiler-fleet-${queueId}`,
      Math.max(30 * 60 * 1000, queueHosts.reduce((sum, item) => sum + item.models.length, 0) * 5 * 60 * 1000),
      { onFatal: err => { tracker.cancelled = true; tracker.error = err.message; } }
    );
    activeFleetQueues.set(queueId, tracker);

    // Fire-and-forget driver
    (async () => {
      for (let i = 0; i < tracker.hosts.length; i++) {
        if (tracker.cancelled || lease.lost) break;
        const slot = tracker.hosts[i];
        tracker.currentIndex = i;
        if (slot.status === 'offline') continue; // skip unreachable hosts
        slot.status = 'running';
        slot.startedAt = Date.now();
        slot.currentModel = slot.models[0] || null;
        try {
          const { summary } = await runHostJournaled(lease, { hostId: slot.hostId, hostUrl: slot.hostUrl, modelName: slot.models.join(',') }, () => testAllModelsOnHost(slot.hostUrl, {
            hostId: slot.hostId,
            shouldAbort: () => tracker.cancelled || lease.lost,
            benchmarkClaim: lease.identityFor(slot.hostUrl),
            assertClaimActive: lease.assertActive,
            signal: lease.signal,
            onProgress: (modelName, result, index, total) => {
              slot.completed = index + 1;
              slot.currentModel = index + 1 < total ? slot.models[index + 1] : null;
              if (result?.status !== 'pass') slot.failed++;
              slot.results.push({ modelName, ...result });
            }
          }));
          lease.assertActive();
          slot.summary = summary;
          slot.status = 'completed';
          slot.currentModel = null;
          // Update host baseline aggregate (same as /test/run-all)
          const baseline = buildBaselineFromResults(slot.results, baselineModel);
          if (slot.hostId && baseline) {
            lease.assertActive();
            await updateBaselineUnderLease(slot.hostId, baseline, lease);
          }
        } catch (err) {
          slot.status = 'failed';
          slot.error = err.message;
          if (err.retainAdmission === true) {
            tracker.cancelled = true;
            await lease.abandon(err);
            throw err;
          }
          logger.error('Fleet: host sweep failed', { hostUrl: slot.hostUrl, error: err.message });
        } finally {
          slot.finishedAt = Date.now();
        }
      }

      tracker.finishedAt = Date.now();
      const fleetSummary = tracker.hosts.reduce((acc, h) => {
        acc.modelsTested += h.results.length;
        acc.passed += h.results.filter(r => r.status === 'pass').length;
        acc.failed += h.failed;
        return acc;
      }, { hostsCompleted: tracker.hosts.filter(h => h.status === 'completed').length,
           hostsFailed: tracker.hosts.filter(h => h.status === 'failed').length,
           hostsSkipped: tracker.hosts.filter(h => h.status === 'offline').length,
           modelsTested: 0, passed: 0, failed: 0 });
      tracker.summary = fleetSummary;
      tracker.status = tracker.cancelled ? 'cancelled' : 'completed';
      await lease.finalize();
    })().catch(err => {
      tracker.status = 'failed';
      tracker.error = err.message;
      tracker.finishedAt = Date.now();
      logger.error('Fleet queue driver crashed', { queueId, error: err.message });
      lease.finalize().catch(releaseErr => logger.warn('Fleet claim finalization failed', { queueId, error: releaseErr.message }));
    });

    res.json({ status: 'success', data: {
      queueId,
      totalHosts: tracker.totalHosts,
      hosts: tracker.hosts.map(h => ({
        hostId: h.hostId, hostUrl: h.hostUrl, displayName: h.displayName,
        status: h.status, total: h.total, error: h.error
      }))
    }});
  } catch (err) {
    logger.error('Fleet queue start failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/** GET /test/run-fleet/:queueId/progress */
router.get('/test/run-fleet/:queueId/progress', (req, res) => {
  const tracker = activeFleetQueues.get(req.params.queueId);
  if (!tracker) return res.status(404).json({ status: 'error', message: 'Queue not found or expired' });
  res.json({ status: 'success', data: {
    queueStatus: tracker.status,
    currentIndex: tracker.currentIndex,
    totalHosts: tracker.totalHosts,
    cancelled: tracker.cancelled,
    summary: tracker.summary,
    error: tracker.error,
    startedAt: tracker.startedAt,
    finishedAt: tracker.finishedAt,
    hosts: tracker.hosts.map(h => ({
      hostId: h.hostId,
      hostUrl: h.hostUrl,
      displayName: h.displayName,
      status: h.status,
      total: h.total,
      completed: h.completed,
      failed: h.failed,
      currentModel: h.currentModel,
      summary: h.summary,
      error: h.error,
      startedAt: h.startedAt,
      finishedAt: h.finishedAt
    }))
  }});
});

/** POST /test/run-fleet/:queueId/cancel — skip remaining hosts (current host runs to completion) */
router.post('/test/run-fleet/:queueId/cancel', (req, res) => {
  const tracker = activeFleetQueues.get(req.params.queueId);
  if (!tracker) return res.status(404).json({ status: 'error', message: 'Queue not found or expired' });
  if (tracker.status !== 'running') {
    return res.json({ status: 'success', data: { queueStatus: tracker.status, cancelled: tracker.cancelled } });
  }
  tracker.cancelled = true;
  res.json({ status: 'success', data: { queueStatus: 'running', cancelled: true } });
});

/** GET /test/run-fleet/active — currently running fleet queues (for page reloads) */
router.get('/test/run-fleet/active', (_req, res) => {
  cleanupStaleFleets();
  const active = [];
  for (const [id, q] of activeFleetQueues) {
    if (q.status === 'running') {
      active.push({
        queueId: id,
        currentIndex: q.currentIndex,
        totalHosts: q.totalHosts,
        startedAt: q.startedAt,
        elapsed: Date.now() - q.startedAt
      });
    }
  }
  res.json({ status: 'success', data: { active } });
});

module.exports = router;
