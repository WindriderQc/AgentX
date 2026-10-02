const express = require('express');
const router = express.Router();
const hostProfileService = require('../../src/services/profiler/hostProfileService');
const modelDiscoveryService = require('../../src/services/profiler/modelDiscoveryService');
const hostFitReportService = require('../../src/services/profiler/hostFitReportService');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');

const logger = require('../../config/logger'); const { projectHostProfileForRead } = require('../../src/services/profiler/profilerRecoveryReadProjection');

// ═══ HOST PROFILE — Static routes (MUST come before /:hostId params) ════════

router.get('/', async (req, res) => {
  try { res.json({ status: 'success', data: (await hostProfileService.getAll()).map(projectHostProfileForRead) }); }
  catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

/** POST /discover — seed HostProfile docs from env-configured hosts */
router.post('/discover', async (req, res) => {
  try {
    const configured = getConfiguredHosts();
    const results = [];
    for (const h of configured) {
      const status = await hostProfileService.checkStatus(h.url);
      const models = status.models || [];
      const profile = await hostProfileService.upsertMetadata({
        hostId: h.id,
        hostUrl: h.url,
        displayName: h.name,
        gpu: { vramTotalMiB: h.vramMb },
        status: status.status,
        lastSeenAt: status.status === 'online' ? new Date() : undefined,
        modelCount: models.length,
      });
      // Detect CPU cores for local hosts
      const cpuCores = await hostProfileService.detectCpuCores(h.url);
      if (cpuCores) {
        await hostProfileService.upsertMetadata({ hostId: h.id, cpu: { cores: cpuCores } });
      }
      results.push(profile);
    }
    res.json({ status: 'success', data: results });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

// Sub-routers keep the original registration order: static /test/* routes,
// then POST /:hostId/release, then the /:hostId param routes below.
router.use(require('./hostsTestRun'));
router.use(require('./hostsFleet'));
router.use(require('./hostsProbe'));
router.use(require('./hostsResults'));
router.use(require('./hostsRelease'));

// ═══ HOST PROFILE — Param routes (MUST come after /test/* static routes) ════

router.get('/:hostId', async (req, res) => {
  try {
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    res.json({ status: 'success', data: projectHostProfileForRead(host) });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.get('/:hostId/status', async (req, res) => {
  try {
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    // GET is observational only. Live probes update evidence and therefore use
    // the protected POST /status/refresh action below.
    res.json({ status: 'success', data: {
      hostId: req.params.hostId,
      status: host.status || 'unknown',
      lastSeenAt: host.lastSeenAt || null,
      dedicated: host.dedicated || null
    }});
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.post('/:hostId/status/refresh', async (req, res) => {
  try {
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    const status = await hostProfileService.checkStatus(host.hostUrl);
    await hostProfileService.updateStatusMetadata(req.params.hostId, status.status);
    res.json({ status: 'success', data: { hostId: req.params.hostId, ...status } });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

/** GET /:hostId/fit-report — measured + estimated model fit for one host */
router.get('/:hostId/fit-report', async (req, res) => {
  try {
    const data = await hostFitReportService.buildHostFitReport(req.params.hostId);
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('Host fit report failed', { hostId: req.params.hostId, error: err.message });
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  }
});

router.put('/:hostId', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const allowedTopLevel = new Set(['displayName', 'cpu']);
    const rejectedTopLevel = Object.keys(body).filter(field => !allowedTopLevel.has(field));
    const cpu = body.cpu && typeof body.cpu === 'object' && !Array.isArray(body.cpu) ? body.cpu : {};
    const rejectedCpu = Object.keys(cpu).filter(field => field !== 'threadOverride');
    if (rejectedTopLevel.length || rejectedCpu.length) {
      return res.status(400).json({
        status: 'error',
        code: 'HOST_PROFILE_FIELD_NOT_WRITABLE',
        error: 'Only displayName and cpu.threadOverride may be changed through this route',
        fields: [...rejectedTopLevel, ...rejectedCpu.map(field => `cpu.${field}`)]
      });
    }
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(body, 'displayName')) {
      const displayName = String(body.displayName || '').trim();
      if (!displayName) {
        return res.status(400).json({ status: 'error', code: 'HOST_PROFILE_DISPLAY_NAME_INVALID', error: 'displayName must be non-empty' });
      }
      updates.displayName = displayName;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'cpu')) {
      const threadOverride = Number(cpu.threadOverride);
      if (!Number.isInteger(threadOverride) || threadOverride <= 0 || threadOverride > 1024) {
        return res.status(400).json({ status: 'error', code: 'HOST_PROFILE_THREAD_OVERRIDE_INVALID', error: 'cpu.threadOverride must be an integer from 1 to 1024' });
      }
      updates.cpu = { threadOverride };
    }
    res.json({ status: 'success', data: await hostProfileService.upsertMetadata({ ...updates, hostId: req.params.hostId }) }); }
  catch (err) { res.status(err.statusCode || 500).json({ status: 'error', error: err.message }); }
});

router.post('/:hostId/sync', async (req, res) => {
  try {
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    res.json({ status: 'success', data: await modelDiscoveryService.syncHostModels(host.hostUrl, req.params.hostId) });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

module.exports = router;
