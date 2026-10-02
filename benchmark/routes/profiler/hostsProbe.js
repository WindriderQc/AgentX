// Cross-host comparison and context-probe routes (mounted by ./hosts.js).
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const { testModelAcrossHosts, checkHost } = require('../../src/services/hostTestService');
const { probeModelContext, getProbeStatus } = require('../../src/services/contextProbeService');
const { resolveModelNumCtxDetails } = require('../../src/services/modelContextResolver');
const { acquireProfilerClaimLease } = require('../../src/services/profiler/profilerClaimLifecycle');
const { admitOllamaTargetResolved } = require('../../src/helpers/ollamaTargetAdmission');

const logger = require('../../config/logger');
const { runHostJournaled } = require('../../src/services/profiler/profilerHostRouteJournal');

/** POST /test/compare — test a model across all hosts */
router.post('/test/compare', async (req, res) => {
  let lease;
  try {
    const { modelName } = req.body;
    if (!modelName) return res.status(400).json({ status: 'error', message: 'modelName is required' });
    const checks = await Promise.all(getConfiguredHosts().map(async host => ({ host, check: await checkHost(host.url) })));
    const eligible = checks.filter(item => item.check.available && item.check.models.includes(String(modelName).replace(/:latest$/i, ''))).map(item => item.host.url);
    if (!eligible.length) return res.status(422).json({ status: 'error', message: 'Model is not installed on any reachable host' });
    lease = await acquireProfilerClaimLease(eligible, `profiler-compare-${crypto.randomBytes(8).toString('hex')}`, eligible.length * 10 * 60 * 1000);
    const data = await testModelAcrossHosts(modelName, {
      assertClaimActive: lease.assertActive,
      claimIdentityFor: hostUrl => lease.identityFor(hostUrl),
      runForHost: (host, operation) => runHostJournaled(lease, { hostId: host.id, hostUrl: host.url, modelName }, operation),
      signal: lease.signal
    });
    await lease.finalize();
    lease = null;
    res.json({ status: 'success', data });
  } catch (err) {
    if (lease && err.retainAdmission === true) {
      await lease.abandon(err);
      lease = null;
    }
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message, code: err.code || null });
  }
  finally {
    if (lease) {
      await lease.finalize().catch(error => logger.error('Host comparison lease finalization failed', { error: error.message }));
    }
  }
});

// ═══ CONTEXT PROBE ══════════════════════════════════════════════════════════

/** POST /test/context-probe/run */
router.post('/test/context-probe/run', async (req, res) => {
  let lease;
  try {
    const {
      modelName,
      hostUrl,
      timeoutMs,
      minCtx,
      maxCtx,
      contextProbeFillPct,
      promptFillPct,
      force,
      acknowledgeMaintenance
    } = req.body || {};
    if (!modelName) return res.status(400).json({ status: 'error', message: 'modelName is required' });
    if (!hostUrl) return res.status(400).json({ status: 'error', message: 'hostUrl is required for a claimed context probe' });
    if (acknowledgeMaintenance !== true) {
      return res.status(400).json({
        status: 'error',
        message: 'acknowledgeMaintenance:true is required — probe evicts KV cache and breaks live traffic on the target host'
      });
    }
    const admittedHostUrl = await admitOllamaTargetResolved(hostUrl, { configuredHosts: getConfiguredHosts() });
    lease = await acquireProfilerClaimLease([admittedHostUrl], `profiler-context-${crypto.randomBytes(8).toString('hex')}`, 45 * 60 * 1000);
    const data = await runHostJournaled(lease, { hostUrl: admittedHostUrl, modelName }, () => probeModelContext(modelName, {
      hostUrl: admittedHostUrl,
      timeoutMs,
      minCtx,
      maxCtx,
      contextProbeFillPct: contextProbeFillPct ?? promptFillPct,
      force: !!force,
      acknowledgeMaintenance: true,
      workloadId: lease.operationId,
      assertClaimActive: lease.assertActive,
      signal: lease.signal
    }));
    lease.assertActive();
    await lease.finalize();
    lease = null;
    res.json({ status: 'success', data });
  } catch (err) {
    if (lease && err.retainAdmission === true) {
      await lease.abandon(err);
      lease = null;
    }
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message, code: err.code || null });
  }
  finally {
    if (lease) {
      await lease.finalize().catch(error => logger.error('Context probe lease finalization failed', { error: error.message }));
    }
  }
});

/** GET /test/context-probe/status/:modelName */
router.get('/test/context-probe/status/:modelName', async (req, res) => {
  try {
    res.json({ status: 'success', data: await getProbeStatus(req.params.modelName, { hostUrl: req.query.hostUrl }) });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

/** GET /test/context-probe/resolve/:modelName */
router.get('/test/context-probe/resolve/:modelName', async (req, res) => {
  try {
    res.json({ status: 'success', data: await resolveModelNumCtxDetails(req.params.modelName, { targetHost: req.query.hostUrl, fallback: req.query.fallback }) });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

module.exports = router;
