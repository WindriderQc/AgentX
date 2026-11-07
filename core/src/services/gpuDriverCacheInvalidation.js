'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const coordination = require('./runtimeCoordinationService');
const { getBenchmarkServiceClient } = require('./benchmarkServiceClient');
const { invalidateRoutingSnapshots } = require('./routing/routingSnapshotCache');
const { clearReadinessCache } = require('./modelReadinessService');
const { _clearCache: clearContextCache } = require('./modelContextInfoService');
const { GPU_DRIVER_IDENTITY_VERSION } = require('../../../shared/artifactIdentity');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const { validRequestId, operationWorkloadId, confirmedCacheReceipt } = require('../../../shared/gpuDriverTransition');

const refused = message => Object.assign(new Error(message), { code: 'GPU_DRIVER_CACHE_INVALIDATION_REFUSED', statusCode: 409 });

async function invalidateDriverCaches(input, overrides = {}) {
  const d = { model: RuntimeCoordination, assertRecovery: coordination.assertWorkloadRecovery,
    client: getBenchmarkServiceClient(), clearRouting: invalidateRoutingSnapshots,
    clearReadiness: clearReadinessCache, clearContext: clearContextCache,
    clearModels: () => require('./modelAggregator').clearCache(), now: () => new Date(), ...overrides };
  const { requestId, preparationId, targetFingerprint, host, principal, authority } = input;
  if (principal !== 'benchmark-service' || !validRequestId(requestId)
    || !validRequestId(preparationId) || !/^[a-f0-9]{64}$/.test(targetFingerprint || '') || !authority?.workloadId) throw refused('An exact activation identity and native recovery proof are required');
  const owned = await d.assertRecovery({ recoveryId: authority.recoveryId, recoveryGeneration: authority.recoveryGeneration,
    principal, ownerId: authority.recoveryOwnerId || null });
  if (owned?.owned !== true || owned.workloadId !== authority.workloadId) throw refused('The activation workload no longer owns its reservation');
  const match = { recoveryId: authority.recoveryId, recoveryGeneration: authority.recoveryGeneration, principal,
    workloadId: authority.workloadId, kind: 'gpu-driver-activation',
    ...(authority.recoveryOwnerId ? { recoveryOwnerId: authority.recoveryOwnerId, recoveryExpiresAt: { $gt: d.now() } }
      : { recoveryOwnerId: null, expiresAt: { $gt: d.now() } }) };
  const state = await d.model.findOne({ _id: 'runtime', workloads: { $elemMatch: match } })
    .select('+workloads.gpuDriverCacheReceipt').lean();
  const workload = state?.workloads?.find(row => row.recoveryId === authority.recoveryId);
  if (!workload || !workload.hosts.some(value => hostUrlKey(value) === hostUrlKey(host))) throw refused('The exact activation reservation does not cover this host');
  const profile = await d.client.getHostProfile(host);
  const activation = profile?.gpuDriverActivation;
  if (profile?.gpuDriverIdentityVersion !== GPU_DRIVER_IDENTITY_VERSION
    || authority.workloadId !== operationWorkloadId(profile.hostId, requestId) || activation?.requestId !== requestId
    || activation.preparationId !== preparationId || activation.targetFingerprint !== targetFingerprint
    || !['published', 'complete'].includes(activation.state)) throw refused('Benchmark has not published this exact activation');
  const previous = workload.gpuDriverCacheReceipt;
  const intent = { requestId, preparationId, targetFingerprint, workloadId: authority.workloadId };
  if (previous) {
    if (!confirmedCacheReceipt(previous, intent)) throw refused('The workload cache receipt is invalid or binds another intent');
    return previous;
  }
  const generations = { routing: d.clearRouting(), readiness: d.clearReadiness(), context: d.clearContext(), models: d.clearModels() };
  if (!Object.values(generations).every(value => Number.isSafeInteger(value) && value > 0)) throw refused('A native cache did not acknowledge invalidation');
  const receipt = { contract: 'agentx.gpu-driver-cache-invalidation/v1', requestId, preparationId, workloadId: authority.workloadId,
    targetFingerprint, cleared: true, generations, clearedAt: d.now().toISOString() };
  const committed = await d.model.updateOne({ _id: 'runtime', workloads: { $elemMatch: {
    ...match, gpuDriverCacheReceipt: { $exists: false }
  } } }, { $set: { 'workloads.$.gpuDriverCacheReceipt': receipt } });
  if (committed.matchedCount !== 1) {
    const replay = await d.model.findOne({ _id: 'runtime', workloads: { $elemMatch: match } })
      .select('+workloads.gpuDriverCacheReceipt').lean();
    const recorded = replay?.workloads?.find(row => row.recoveryId === authority.recoveryId)?.gpuDriverCacheReceipt;
    if (confirmedCacheReceipt(recorded, intent)) return recorded;
    throw refused('The cache invalidation lost its exact owner fence');
  }
  return receipt;
}

module.exports = { invalidateDriverCaches };
