'use strict';

const crypto = require('crypto');
const { buildRuntimeFingerprint, stableSerialize, GPU_DRIVER_IDENTITY_VERSION } = require('../../../../shared/artifactIdentity');
const { normalizeGpuInventory } = require('../../../../shared/gpuInventory');
const { gpuDriverOf } = require('../../../../shared/measuredRuntime');

function refusal(message, code = 'GPU_DRIVER_PREPARATION_DRIFT') {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function driverTarget(host, now = new Date()) {
  const inventory = normalizeGpuInventory(host?.gpus);
  const observed = normalizeGpuInventory(host?.gpuDriverObservation?.gpus);
  const withoutDrivers = gpus => gpus?.map(gpu => ({ ...gpu, driver: null }));
  if (!inventory || !observed || !gpuDriverOf(host, { observedAt: now })
    || stableSerialize(withoutDrivers(inventory)) !== stableSerialize(withoutDrivers(observed))) {
    throw refusal('A complete fresh Data driver observation for the exact stored GPU inventory is required', 'GPU_DRIVER_OBSERVATION_REQUIRED');
  }
  return { ...host, gpus: observed, gpuDriverIdentityVersion: GPU_DRIVER_IDENTITY_VERSION };
}

function preparedTarget(host, requestId, modelName, now = new Date()) {
  const preparation = host?.gpuDriverPreparation;
  if (!requestId || preparation?.requestId !== requestId || preparation.state !== 'prepared') {
    throw refusal('The exact prepared host request is required', 'GPU_DRIVER_PREPARATION_REQUIRED');
  }
  const scopeHash = crypto.createHash('sha256').update(stableSerialize({
    pins: preparation.pins, manifest: preparation.manifest
  })).digest('hex');
  if (scopeHash !== preparation.scopeFingerprint) throw refusal('The frozen preparation manifest changed');
  const target = driverTarget(host, now);
  if (buildRuntimeFingerprint(host) !== preparation.activeFingerprint
    || buildRuntimeFingerprint(target) !== preparation.targetFingerprint) {
    throw refusal('The active runtime or the prepared GPU driver identity changed');
  }
  const entry = preparation.manifest.find(item => item.modelName === modelName);
  if (!entry) throw refusal('The model is outside the complete frozen host scope', 'GPU_DRIVER_MODEL_OUTSIDE_SCOPE');
  return { target, preparation, entry };
}

function projectionPaths(preparationId) {
  return preparationId
    ? { readiness: 'preparedReadiness', thinking: 'preparedThinkingProfiles' }
    : { readiness: 'readiness', thinking: 'thinkingProfiles' };
}

module.exports = { refusal, driverTarget, preparedTarget, projectionPaths };
