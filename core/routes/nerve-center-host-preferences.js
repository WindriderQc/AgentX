/**
 * Nerve Center — Host Preferences
 *
 * Host pin management (get / put / delete pin, restore, swap), benchmark
 * claim coordination (claim / release / list / reap), and the host-prefs
 * list endpoint with live Ollama status.
 *
 * Extracted from `routes/nerve-center.js` to keep that file
 * under the 700-line cap. Mounted at `/api/nerve-center` alongside the
 * original; URLs unchanged.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');

const hostPrefService = require('../src/services/hostPreferenceService');
const { validateHostUrl } = require('../src/helpers/ollamaHostConfig');
const { emit: emitBuddyEvent } = require('../src/services/buddyEvents');
const { requestPrincipal } = require('../src/helpers/requestCaller');
const runtimeCoordinationService = require('../src/services/runtimeCoordinationService');
const runtimeDrainIntent = require('../src/services/runtimeDrainIntent');
const { runRuntimeMutation } = require('../src/services/runtimeMutationLeaseService');
const { projectHostPreferenceForRead } = require('../src/services/hostPreferencePublicProjection');



function resolveHostPreferenceUrl(req, res) {
  let rawHostUrl;
  try {
    rawHostUrl = decodeURIComponent(req.params.hostUrl);
  } catch {
    res.status(400).json({ status: 'error', message: 'hostUrl is invalid' });
    return null;
  }

  const validation = validateHostUrl(rawHostUrl);
  if (!validation.valid) {
    res.status(400).json({ status: 'error', message: validation.message });
    return null;
  }

  return validation.host || String(rawHostUrl || '').trim();
}

// ========================================
// GET /host-preferences — all host preferences with live status
// ========================================

router.use(require('./nerve-center-host-read'));

// ========================================
// PUT /host-preferences/health-check-interval — update health check interval
// ========================================

router.put('/host-preferences/health-check-interval', (req, res) => {
  try {
    const { intervalMs } = req.body || {};
    const parsed = parseInt(intervalMs, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
      return res.status(400).json({ status: 'error', message: 'intervalMs must be >= 10000' });
    }
    hostPrefService.setHealthCheckIntervalMs(parsed);
    logger.info('[NerveCenter] Health check interval updated', { intervalMs: parsed });
    res.json({ status: 'success', data: { intervalMs: parsed } });
  } catch (err) {
    logger.error('[NerveCenter] health check interval update failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// Pin Management: GET/PUT/DELETE pin, POST restore, POST swap
// (Must be registered BEFORE the general PUT /:hostUrl(*) catch-all)
// ========================================

router.use(require('./nerve-center-host-pins')(resolveHostPreferenceUrl));
router.use(require('./nerve-center-host-concurrency')(resolveHostPreferenceUrl));


// ========================================
// Benchmark Coordination
//
// Announce that a benchmark batch has taken over a host, or release the
// announcement when the batch is done. Sets HostPreference.status to
// 'benchmarking' so other consumers can route around the host.
// ========================================

router.post('/host-preferences/:hostUrl(*)/benchmark-claim', async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const { batchId, claimGeneration, admissionId, admissionGeneration, estimatedDurationMs, source, owner, note, heartbeatTtlMs } = req.body || {};
    if (!batchId || !claimGeneration) {
      return res.status(400).json({ status: 'error', message: 'batchId and claimGeneration are required' });
    }
    const admission = await runtimeCoordinationService.assertWorkloadAdmission({
      id: admissionId,
      generation: admissionGeneration,
      principal: requestPrincipal(req),
      workloadId: batchId,
      host: hostUrl
    });
    if (!admission.admitted) {
      return res.status(409).json({ status: 'error', code: 'WORKLOAD_ADMISSION_REQUIRED', message: admission.reason });
    }
    const claimOptions = {
      claimGeneration,
      admissionId: admission.admissionId,
      admissionGeneration: admission.generation,
      admissionPrincipal: admission.principal
    };
    if (source !== undefined) claimOptions.source = source;
    if (owner !== undefined) claimOptions.owner = owner;
    if (note !== undefined) claimOptions.note = note;
    if (heartbeatTtlMs !== undefined) claimOptions.heartbeatTtlMs = heartbeatTtlMs;
    const result = await hostPrefService.claimBenchmark(hostUrl, batchId, estimatedDurationMs, claimOptions);
    if (!result.claimed) {
      return res.status(409).json({ status: 'error', message: result.reason, data: result });
    }
    logger.info('[NerveCenter] Benchmark claim acquired', { hostUrl, batchId, estimatedDurationMs, source });
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] benchmark claim failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/host-preferences/:hostUrl(*)/benchmark-claim/:batchId/heartbeat', async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const batchId = req.params.batchId;
    const { claimGeneration, admissionId, admissionGeneration, estimatedDurationMs, source, owner, note, heartbeatTtlMs } = req.body || {};
    const admission = await runtimeCoordinationService.assertWorkloadAdmission({
      id: admissionId,
      generation: admissionGeneration,
      principal: requestPrincipal(req),
      workloadId: batchId,
      host: hostUrl
    });
    if (!admission.admitted) {
      return res.status(409).json({ status: 'error', code: 'WORKLOAD_ADMISSION_REQUIRED', message: admission.reason });
    }
    const result = await hostPrefService.heartbeatBenchmarkClaim(hostUrl, batchId, {
      claimGeneration,
      admissionId: admission.admissionId,
      admissionGeneration: admission.generation,
      admissionPrincipal: admission.principal,
      requireAdmissionProof: true,
      estimatedDurationMs,
      source,
      owner,
      note,
      heartbeatTtlMs
    });
    if (!result.heartbeat) {
      return res.status(409).json({ status: 'error', message: result.reason, data: result });
    }
    logger.debug('[NerveCenter] Benchmark claim heartbeat', { hostUrl, batchId, source });
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] benchmark claim heartbeat failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/host-preferences/:hostUrl(*)/benchmark-claim/:batchId/release-receipt', async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const batchId = req.params.batchId;
    const { claimGeneration, admissionId, admissionGeneration } = req.body || {};
    const admission = await runtimeCoordinationService.assertWorkloadAdmission({
      id: admissionId,
      generation: admissionGeneration,
      principal: requestPrincipal(req),
      workloadId: batchId,
      host: hostUrl
    });
    if (!admission.admitted) {
      return res.status(409).json({ status: 'error', code: 'WORKLOAD_ADMISSION_REQUIRED', message: admission.reason });
    }
    const result = await hostPrefService.recoverBenchmarkClaimRelease(hostUrl, batchId, { claimGeneration });
    return res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] benchmark claim release receipt recovery failed', { error: err.message });
    return res.status(500).json({ status: 'error', code: 'BENCHMARK_RELEASE_RECOVERY_FAILED', message: err.message });
  }
});

router.delete('/host-preferences/:hostUrl(*)/benchmark-claim/:batchId', async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const batchId = req.params.batchId;
    const { claimGeneration, admissionId, admissionGeneration, excludedModels } = req.body || {};
    const admission = await runtimeCoordinationService.assertWorkloadAdmission({
      id: admissionId,
      generation: admissionGeneration,
      principal: requestPrincipal(req),
      workloadId: batchId,
      host: hostUrl
    });
    if (!admission.admitted) {
      return res.status(409).json({ status: 'error', code: 'WORKLOAD_ADMISSION_REQUIRED', message: admission.reason });
    }
    const result = await hostPrefService.releaseBenchmarkClaim(hostUrl, batchId, {
      claimGeneration,
      admissionId: admission.admissionId,
      admissionGeneration: admission.generation,
      admissionPrincipal: admission.principal,
      requireAdmissionProof: true,
      excludedModels
    });
    if (!result.released) {
      // Still 200 — release is idempotent; caller just learns the reason
      return res.json({ status: 'success', data: result });
    }
    logger.info('[NerveCenter] Benchmark claim released', { hostUrl, batchId });
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] benchmark claim release failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/host-preferences/benchmark-claims/active', async (_req, res) => {
  try {
    const claims = await hostPrefService.listBenchmarkClaims();
    // Claim generations are bearer capabilities for the direct inference
    // lane. This operator/status projection must never disclose them.
    const publicClaims = claims.map(({
      claimGeneration: _claimSecret,
      admissionId: _admissionId,
      admissionGeneration: _admissionSecret,
      preClaimRuntime: _runtimeSecret,
      finalizeToken: _finalizerSecret,
      ...claim
    }) => claim);
    res.json({ status: 'success', data: { claims: publicClaims, count: publicClaims.length } });
  } catch (err) {
    logger.error('[NerveCenter] listing benchmark claims failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Runtime-wide maintenance/workload exclusion. Generations are minted only by
// Core and are returned solely to the authenticated acquiring principal.
router.post('/maintenance-leases', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.acquireMaintenance({
      principal: requestPrincipal(req),
      requestId: req.body?.requestId || req.body?.idempotencyKey,
      scope: req.body?.scope,
      ttl: req.body?.ttlMs
    });
    return res.status(result.acquired ? 200 : 409).json({ status: result.acquired ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'MAINTENANCE_LEASE_FAILED', message: error.message });
  }
});

router.post('/maintenance-leases/:leaseId/heartbeat', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.heartbeat('maintenance', {
      id: req.params.leaseId,
      generation: req.body?.generation,
      principal: requestPrincipal(req),
      ttl: req.body?.ttlMs
    });
    return res.status(result.heartbeat ? 200 : 409).json({ status: result.heartbeat ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'MAINTENANCE_HEARTBEAT_FAILED', message: error.message });
  }
});

router.post('/maintenance-leases/:leaseId/mark-unknown', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.markMaintenanceUnknown({
      id: req.params.leaseId,
      generation: req.body?.generation,
      principal: requestPrincipal(req),
      reason: req.body?.reason
    });
    return res.status(result.quarantined ? 200 : 409).json({
      status: result.quarantined ? 'success' : 'error',
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      code: 'MAINTENANCE_QUARANTINE_FAILED',
      message: error.message
    });
  }
});

router.delete('/maintenance-leases/:leaseId', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.release('maintenance', {
      id: req.params.leaseId,
      generation: req.body?.generation,
      principal: requestPrincipal(req)
    });
    return res.status(result.released ? 200 : 409).json({ status: result.released ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'MAINTENANCE_RELEASE_FAILED', message: error.message });
  }
});

router.post('/maintenance-leases/:leaseId/release-receipt', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.recoverRelease('maintenance', {
      id: req.params.leaseId,
      generation: req.body?.generation,
      principal: requestPrincipal(req)
    });
    return res.status(result.recovered ? 200 : 409).json({
      status: result.recovered ? 'success' : 'error',
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      code: 'MAINTENANCE_RELEASE_RECOVERY_FAILED',
      message: error.message
    });
  }
});

router.post('/maintenance-leases/:leaseId/recover', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.recoverMaintenanceAfterOperatorReconciliation({
      id: req.params.leaseId,
      generation: req.body?.generation,
      principal: requestPrincipal(req),
      receipt: {
        contract: req.body?.contract,
        maintenanceReconciled: req.body?.maintenanceReconciled,
        confirmation: req.body?.confirmation,
        reconciledAt: req.body?.reconciledAt
      }
    });
    return res.status(result.recovered ? 200 : 409).json({
      status: result.recovered ? 'success' : 'error',
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      code: 'MAINTENANCE_RECOVERY_FAILED',
      message: error.message
    });
  }
});

router.post('/workload-admissions', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.acquireWorkload({
      principal: requestPrincipal(req),
      requestId: req.body?.requestId || req.body?.idempotencyKey,
      workloadId: req.body?.workloadId,
      kind: req.body?.kind,
      batchId: req.body?.batchId,
      hosts: req.body?.hosts,
      recoveryRequestId: req.body?.recoveryRequestId,
      ttl: req.body?.ttlMs
    });
    return res.status(result.acquired ? 200 : 409).json({ status: result.acquired ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_ADMISSION_FAILED', message: error.message });
  }
});

router.post('/workload-admissions/:admissionId/heartbeat', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.heartbeat('workload', {
      id: req.params.admissionId,
      generation: req.body?.generation,
      principal: requestPrincipal(req),
      ttl: req.body?.ttlMs
    });
    return res.status(result.heartbeat ? 200 : 409).json({ status: result.heartbeat ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_HEARTBEAT_FAILED', message: error.message });
  }
});

router.post('/workload-admissions/:admissionId/recovery', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.armWorkloadRecovery({
      id: req.params.admissionId,
      generation: req.body?.generation,
      principal: requestPrincipal(req),
      recoveryRequestId: req.body?.recoveryRequestId
    });
    return res.status(result.armed ? 200 : 409).json({ status: result.armed ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_RECOVERY_ARM_FAILED', message: error.message });
  }
});

router.post('/workload-recoveries/:recoveryId/adopt', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.adoptWorkloadRecovery({
      recoveryId: req.params.recoveryId,
      principal: requestPrincipal(req),
      recoveryRequestId: req.body?.recoveryRequestId,
      ownerId: req.body?.ownerId,
      ttl: req.body?.ttlMs
    });
    return res.status(result.adopted ? 200 : 409).json({ status: result.adopted ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_RECOVERY_ADOPT_FAILED', message: error.message });
  }
});

router.post('/workload-recoveries/:recoveryId/heartbeat', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.heartbeatWorkloadRecovery({
      recoveryId: req.params.recoveryId,
      recoveryGeneration: req.body?.recoveryGeneration,
      principal: requestPrincipal(req),
      ownerId: req.body?.ownerId,
      ttl: req.body?.ttlMs
    });
    return res.status(result.heartbeat ? 200 : 409).json({ status: result.heartbeat ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_RECOVERY_HEARTBEAT_FAILED', message: error.message });
  }
});

router.post('/workload-recoveries/:recoveryId/assert', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.assertWorkloadRecovery({
      recoveryId: req.params.recoveryId,
      recoveryGeneration: req.body?.recoveryGeneration,
      principal: requestPrincipal(req),
      ownerId: req.body?.ownerId
    });
    return res.status(result.owned ? 200 : 409).json({ status: result.owned ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_RECOVERY_ASSERT_FAILED', message: error.message });
  }
});

router.post('/workload-recoveries/:recoveryId/transition', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.transitionWorkloadRecovery({
      recoveryId: req.params.recoveryId,
      recoveryGeneration: req.body?.recoveryGeneration,
      principal: requestPrincipal(req),
      ownerId: req.body?.ownerId,
      expectedVersion: req.body?.expectedVersion,
      state: req.body?.state,
      receipt: req.body?.receipt
    });
    return res.status(result.transitioned ? 200 : 409).json({
      status: result.transitioned ? 'success' : 'error',
      data: result
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_RECOVERY_TRANSITION_FAILED', message: error.message });
  }
});

router.post('/workload-recoveries/:recoveryId/restore-hosts', async (req, res) => {
  try {
    const result = await hostPrefService.restoreClaimsForWorkloadRecovery({
      recoveryId: req.params.recoveryId,
      recoveryGeneration: req.body?.recoveryGeneration,
      principal: requestPrincipal(req),
      ownerId: req.body?.ownerId,
      excludedModelsByHost: req.body?.excludedModelsByHost || {}
    });
    return res.status(result.restored ? 200 : 409).json({
      status: result.restored ? 'success' : 'error',
      data: result
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_RECOVERY_HOST_RESTORE_FAILED', message: error.message });
  }
});

router.delete('/workload-recoveries/:recoveryId', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.resolveWorkloadRecovery({
      recoveryId: req.params.recoveryId,
      recoveryGeneration: req.body?.recoveryGeneration,
      principal: requestPrincipal(req),
      ownerId: req.body?.ownerId
    });
    return res.status(result.released ? 200 : 409).json({ status: result.released ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_RECOVERY_RELEASE_FAILED', message: error.message });
  }
});

router.delete('/workload-admissions/:admissionId', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.release('workload', {
      id: req.params.admissionId,
      generation: req.body?.generation,
      principal: requestPrincipal(req)
    });
    return res.status(result.released ? 200 : 409).json({ status: result.released ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_RELEASE_FAILED', message: error.message });
  }
});

router.post('/workload-admissions/:admissionId/release-receipt', async (req, res) => {
  try {
    const result = await runtimeCoordinationService.recoverRelease('workload', {
      id: req.params.admissionId,
      generation: req.body?.generation,
      principal: requestPrincipal(req)
    });
    return res.status(result.recovered ? 200 : 409).json({
      status: result.recovered ? 'success' : 'error',
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      code: 'WORKLOAD_RELEASE_RECOVERY_FAILED',
      message: error.message
    });
  }
});

router.get('/runtime-coordination/active', async (_req, res) => {
  try {
    const data = await runtimeCoordinationService.listActive();
    // drain: a recreate is announced; resumable background work pauses before its next unit (#253).
    return res.json({ status: 'success', data: { ...data, drain: runtimeDrainIntent.current() } });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'RUNTIME_COORDINATION_STATUS_FAILED', message: error.message });
  }
});

router.post('/runtime-coordination/drain', (req, res) => {
  try {
    const data = runtimeDrainIntent.request({ scope: req.body?.scope, ttlMs: req.body?.ttlMs,
      principal: req.get('X-AgentX-Caller') || 'operator' });
    return res.json({ status: 'success', data });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ status: 'error', code: 'RUNTIME_DRAIN_REQUEST_INVALID', message: error.message });
  }
});

router.delete('/runtime-coordination/drain', (_req, res) => res.json({ status: 'success', data: runtimeDrainIntent.clear() }));

// What recreating a service would cut (#47): ?service=core|benchmark|all.
router.get('/runtime-coordination/deploy-blockers', async (req, res) => {
  try {
    const data = await runtimeCoordinationService.listDeployBlockers({ service: String(req.query.service || 'all') });
    return res.json({ status: 'success', data });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'RUNTIME_DEPLOY_BLOCKERS_FAILED', message: error.message });
  }
});

/**
 * POST /host-preferences/benchmark-claims/reap
 * Manually trigger the stale-claim reaper. Normally runs every 5 min via
 * server.js; this endpoint is for operator-initiated recovery.
 * Optional body: { graceFactor, hardCapMs }
 */
router.post('/host-preferences/benchmark-claims/reap', async (req, res) => {
  try {
    const result = await hostPrefService.reapStaleBenchmarkClaims(req.body || {});
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] benchmark claim reap failed', { error: err.message });
    res.status(err.code === 'BENCHMARK_REAPER_OPTIONS_INVALID' ? 400 : 500).json({
      status: 'error',
      code: err.code || 'BENCHMARK_CLAIM_REAP_FAILED',
      message: err.message
    });
  }
});

// ========================================
// PUT /host-preferences/:hostUrl — update host preference
// ========================================

router.put('/host-preferences/:hostUrl(*)', async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const updates = req.body || {};

    // Reject legacy-shape payloads. The back-compat translation
    // layer (defaultModels / pinnedModel / flat keepAlive / contextSize /
    // autoRestore) was retired when the hostpreferences migration completed
    // and the schema flipped to strict:true. Clients must now PUT
    // `pinnedModels: [{ model, keepAlive, contextSize, autoRestore }, ...]`.
    const legacyKeys = ['defaultModels', 'pinnedModel', 'keepAlive', 'contextSize', 'autoRestore'];
    const foundLegacy = legacyKeys.filter(k => updates[k] !== undefined);
    if (foundLegacy.length > 0) {
      return res.status(400).json({
        status: 'error',
        message: `Legacy host-preference fields are no longer accepted: ${foundLegacy.join(', ')}. Send pinnedModels: [{ model, keepAlive, contextSize, autoRestore }, ...] instead.`
      });
    }

    const allowed = ['hostKey', 'displayName', 'pinnedModels', 'maxConcurrentModels', 'vramTotalMiB', 'vramReservedMiB', 'gpu', 'tags'];
    const filtered = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) filtered[key] = updates[key];
    }

    const data = await runRuntimeMutation({
      principal: requestPrincipal(req),
      scope: 'host-preference:update'
    }, () => hostPrefService.updatePreference(hostUrl, filtered));
    emitBuddyEvent('host_preference_updated', 'infrastructure', `Host preference updated: ${data.displayName || hostUrl}`, 'normal');
    logger.info('[NerveCenter] Host preference updated', { hostUrl, updates: Object.keys(filtered) });
    res.json({ status: 'success', data: projectHostPreferenceForRead(data) });
  } catch (err) {
    logger.error('[NerveCenter] host preference update failed', { error: err.message });
    res.status(err.statusCode || 500).json({
      status: 'error',
      code: err.code || 'HOST_PREFERENCE_UPDATE_FAILED',
      message: err.message
    });
  }
});

// ========================================
// POST /host-preferences/:hostUrl/reload — reload default models on host
// ========================================

router.post('/host-preferences/:hostUrl(*)/reload', async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const pref = await hostPrefService.getByHost(hostUrl);
    const entries = hostPrefService.getPinnedEntries(pref);
    if (!entries.length) {
      return res.status(400).json({ status: 'error', message: 'No pinned models configured for this host' });
    }
    const results = await runRuntimeMutation({
      principal: requestPrincipal(req),
      scope: `host-pin:reload:${hostUrl}`
    }, ({ signal, assertActive }) => hostPrefService.warmHost(hostUrl, {
      signal,
      assertAuthorityActive: assertActive
    }));
    emitBuddyEvent('host_defaults_reloaded', 'infrastructure', `Reloaded pins on ${pref.displayName || hostUrl}`, 'normal');
    logger.info('[NerveCenter] Host pinned models reloaded', { hostUrl, results });
    res.json({ status: 'success', data: results });
  } catch (err) {
    logger.error('[NerveCenter] host preference reload failed', { error: err.message });
    res.status(err.statusCode || 500).json({ status: 'error', code: err.code || 'HOST_PIN_RELOAD_FAILED', message: err.message });
  }
});

module.exports = router;
