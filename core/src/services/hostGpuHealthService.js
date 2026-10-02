'use strict';

const { gpuResidency, expectedStatus } = require('../../../shared/gpuResidency');
const { hostResidency } = require('../helpers/hostResidency');
const { getPinnedEntries, findLoadedModelInfo, fetchRunningModelInfosStrict } = require('./hostPinPrimitives');
const { hasActiveBenchmarkClaim } = require('./benchmarkClaimService');
const { hasActiveSessionHold } = require('./hostSessionHoldService');
const { getGpuTelemetryForHosts } = require('./gpuTelemetryService');

function assessHostGpuHealth(pref, runningModels, telemetry, checkedAt = new Date().toISOString()) {
  const pins = getPinnedEntries(pref);
  // A CPU host expects its pins outside VRAM and needs no GPU inventory.
  const residency = hostResidency(pref?.hostUrl);
  const expected = expectedStatus(residency);
  const entries = pins.map(pin => {
    const loaded = findLoadedModelInfo(runningModels, pin.model);
    return { model: pin.model, loaded: Boolean(loaded), expected, ...gpuResidency(loaded) };
  });
  const spill = entries.filter(entry => entry.status !== 'unknown' && entry.status !== expected);
  const freshNoGpu = residency === 'gpu' && telemetry?.telemetry?.status === 'fresh' && telemetry.gpus?.length === 0;
  const status = !pins.length ? 'not_applicable' : spill.length || freshNoGpu ? 'degraded'
    : entries.every(entry => entry.loaded && entry.status === expected) ? 'healthy' : 'unknown';
  return { schema: 'agentx.host-gpu-health/v1', host: pref?.hostUrl || null, residency, checkedAt, status,
    reason: spill.length ? 'pinned_model_gpu_spill' : freshNoGpu && pins.length ? 'fresh_gpu_inventory_empty'
      : status === 'unknown' ? 'gpu_residency_unverified' : null,
    entries, telemetry: telemetry?.telemetry || { status: 'unavailable' } };
}

async function readHostGpuHealth(host, { pref, runningModels, telemetry, checkedAt = new Date().toISOString() } = {}) {
  try {
    if (pref === undefined) {
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1) return { status: 'unknown', reason: 'preferences_unavailable', checkedAt };
      pref = await require('../../models/HostPreference').findOne({ hostUrl: host }).maxTimeMS(1000).lean();
    }
    if (!getPinnedEntries(pref).length) return assessHostGpuHealth(pref || { hostUrl: host }, [], null, checkedAt);
    if (hasActiveBenchmarkClaim(pref) || hasActiveSessionHold(pref) || pref.status === 'restoring') {
      return { status: 'unknown', reason: 'runtime_owner_active', host, checkedAt };
    }
    if (runningModels === undefined) runningModels = await fetchRunningModelInfosStrict(host, 2000);
    if (!Array.isArray(runningModels)) throw new Error('Malformed model inventory');
    if (telemetry === undefined) {
      const samples = await getGpuTelemetryForHosts([{ id: host, url: host }]);
      telemetry = samples.get(host);
    }
    return assessHostGpuHealth(pref, runningModels, telemetry, checkedAt);
  } catch {
    return { schema: 'agentx.host-gpu-health/v1', host, status: 'unknown',
      reason: 'gpu_residency_unverified', checkedAt };
  }
}

async function observeHostGpuHealth(pref, runningModels) {
  const health = await readHostGpuHealth(pref.hostUrl, { pref, runningModels });
  // Reuse the pin reconciler's incident and fingerprint for missing GPU inventory.
  // The reconciler emits observed pin spills itself, once per health tick.
  if (health.status === 'degraded' && health.reason === 'fresh_gpu_inventory_empty') {
    await require('./laneObservabilityService').observePinVramSpill({
      host: pref.hostUrl, hostKey: pref.hostKey, gpuHealth: health, source: 'pin-reconciler'
    });
  } else if (health.status === 'healthy') {
    await require('./alertIncidentRecovery').resolveGpuRecovery(health);
  }
  return health;
}

module.exports = { assessHostGpuHealth, readHostGpuHealth, observeHostGpuHealth };
