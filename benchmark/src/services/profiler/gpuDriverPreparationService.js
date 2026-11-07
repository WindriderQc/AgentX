'use strict';

const HostProfile = require('../../../models/HostProfile');
const hostProfiles = require('./hostProfileService');
const { syncHostRuntimeSettings } = require('./hostRuntimeSettingsService');
const { captureScope, hash } = require('./gpuDriverPreparationScope');
const { driverTarget, preparedTarget, refusal } = require('./gpuDriverPreparationIdentity');
const { buildRuntimeFingerprint } = require('../../../../shared/artifactIdentity');

function dependencies(overrides = {}) {
  return { model: HostProfile, getHost: hostProfiles.getById, sync: syncHostRuntimeSettings,
    capture: captureScope, now: () => new Date(), ...overrides };
}

async function prepare({ hostId, requestId, expectedFingerprint }, overrides = {}) {
  const d = dependencies(overrides);
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(requestId)
    || !/^[a-f0-9]{64}$/.test(String(expectedFingerprint || ''))) {
    throw refusal('A stable requestId and exact expected active fingerprint are required', 'GPU_DRIVER_PREPARATION_INPUT');
  }
  let host = await d.getHost(hostId);
  if (!host) throw refusal('Host not found', 'GPU_DRIVER_HOST_REQUIRED');
  const existing = host.gpuDriverPreparation;
  if (existing?.requestId === requestId) {
    if (existing.activeFingerprint !== expectedFingerprint) throw refusal('The requestId already binds another intent');
    return existing;
  }
  if (existing?.requestId) throw refusal('Another host preparation already exists; inspect that exact operation');
  await d.sync({ hostId, hostUrl: host.hostUrl }, { force: true });
  host = await d.getHost(hostId);
  if (buildRuntimeFingerprint(host) !== expectedFingerprint) throw refusal('The expected active fingerprint changed');
  const now = d.now();
  const target = driverTarget(host, now);
  const targetFingerprint = buildRuntimeFingerprint(target);
  if (targetFingerprint === expectedFingerprint) throw refusal('The observed driver is already in this identity');
  const first = await d.capture(host);
  const second = await d.capture(host);
  if (first.scopeFingerprint !== second.scopeFingerprint) throw refusal('Qualified scope or pins changed during preparation');
  if (!first.manifest.length) throw refusal('The host has no currently qualified scope to preserve', 'GPU_DRIVER_SCOPE_EMPTY');
  // Re-read after all owner reads. This CAS fences concurrent observation,
  // configuration, identity or preparation changes; no evidence is mutated.
  await d.sync({ hostId, hostUrl: host.hostUrl }, { force: true });
  const current = await d.getHost(hostId);
  if (hash(driverTarget(current, d.now()).gpus) !== hash(target.gpus)
    || buildRuntimeFingerprint(current) !== expectedFingerprint) throw refusal('Host changed during preparation');
  const preparation = { requestId, state: 'prepared', preparedAt: d.now(),
    activeFingerprint: expectedFingerprint, targetFingerprint, ...first };
  const saved = await d.model.findOneAndUpdate({
    hostId, updatedAt: current.updatedAt,
    'gpuDriverPreparation.requestId': { $exists: false }
  }, { $set: { gpuDriverPreparation: preparation } }, { new: true, runValidators: true }).lean();
  if (!saved) {
    const replay = await d.getHost(hostId);
    if (replay?.gpuDriverPreparation?.requestId === requestId
      && replay.gpuDriverPreparation.activeFingerprint === expectedFingerprint) return replay.gpuDriverPreparation;
    throw refusal('Host preparation lost its concurrency fence', 'GPU_DRIVER_PREPARATION_CAS_FAILED');
  }
  return saved.gpuDriverPreparation;
}

async function inspect(hostId, overrides = {}) {
  const d = dependencies(overrides);
  const host = await d.getHost(hostId);
  if (!host) throw refusal('Host not found', 'GPU_DRIVER_HOST_REQUIRED');
  return { hostId, activeFingerprint: buildRuntimeFingerprint(host), preparation: host.gpuDriverPreparation || null };
}

async function assertScopeUnchanged(host, requestId, overrides = {}) {
  const d = dependencies(overrides);
  const first = host.gpuDriverPreparation?.manifest?.[0];
  if (!first) throw refusal('The complete frozen host scope is missing');
  preparedTarget(host, requestId, first.modelName, d.now());
  const scope = await d.capture(host);
  if (scope.scopeFingerprint !== host.gpuDriverPreparation.scopeFingerprint) {
    throw refusal('Currently qualified scope, serving context or pins changed; this preparation cannot be activated', 'GPU_DRIVER_SCOPE_DRIFT');
  }
  return scope;
}

module.exports = { prepare, inspect, assertScopeUnchanged };
