'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const HostPreference = require('../../models/HostPreference');
const { CLAIM_FINALIZE_TTL_MS } = require('./benchmarkClaimShared');

// A release request ends dispatch on this host before Core reconciles its
// closed caller connections. The parent workload remains held throughout.
function exactParentForHost(state, host, inferences, { draining = false } = {}) {
  const covering = (state?.workloads || []).filter(w => (w.hosts || []).includes(host));
  if (covering.length !== 1) return null;
  const parent = covering[0];
  if (!['benchmark', 'benchmark-cloud'].includes(parent.kind) || parent.principal !== 'benchmark-service'
    || parent.yieldedAt || (draining && !(parent.drainingHosts || []).includes(host))) return null;
  return inferences.every(i => i.principal === parent.principal
    && i.workloadAdmissionId === parent.admissionId && i.workloadGeneration === parent.generation)
    ? parent : null;
}

function parentPredicate(parent, host) {
  return { admissionId: parent.admissionId, generation: parent.generation,
    principal: parent.principal, kind: parent.kind, hosts: host, yieldedAt: null };
}

async function deferClaimReleaseForInferences(host, preference, options = {}) {
  const claim = preference?.benchmarkClaim;
  if (options.requireAdmissionProof !== true || claim?.admissionPrincipal !== 'benchmark-service'
    || claim.finalizeToken) return null;
  const state = await RuntimeCoordination.findById('runtime').lean();
  const onHost = (state?.inferences || []).filter(i => i.host === host);
  const parent = exactParentForHost(state, host, onHost);
  const now = new Date();
  if (!parent || state.maintenance || parent.admissionId !== claim.admissionId
    || parent.generation !== claim.admissionGeneration || parent.workloadId !== claim.batchId
    || new Date(parent.expiresAt).getTime() <= now.getTime()
    || !onHost.every(i => i.state === 'ACTIVE' || (i.state === 'UNKNOWN'
      && ['caller-abort', 'deadline-abort'].includes(i.unknownOrigin)))) {
    return null;
  }
  const blocked = { host, $or: [
    { principal: { $ne: parent.principal } }, { workloadAdmissionId: { $ne: parent.admissionId } },
    { workloadGeneration: { $ne: parent.generation } },
    { state: { $nin: ['ACTIVE', 'UNKNOWN'] } },
    { state: 'UNKNOWN', unknownOrigin: { $nin: ['caller-abort', 'deadline-abort'] } }
  ] };
  const drained = await RuntimeCoordination.findOneAndUpdate({
    _id: 'runtime', maintenance: null,
    workloads: { $elemMatch: { ...parentPredicate(parent, host), expiresAt: { $gt: now } } },
    $and: [
      { workloads: { $not: { $elemMatch: { hosts: host, admissionId: { $ne: parent.admissionId } } } } },
      { inferences: { $not: { $elemMatch: blocked } } }
    ]
  }, { $addToSet: { 'workloads.$.drainingHosts': host } }, { new: true }).lean();
  if (!drained) return null;
  // Even an empty host must stop accepting dispatch before restoration. A
  // request already admitted when the fence landed still needs settlement.
  if (!(drained.inferences || []).some(i => i.host === host)) return null;

  // Host heartbeats have drained at this boundary. Keep the exact claim alive
  // while the caller polls; do not acquire a finalizer token before settlement.
  const renewed = await HostPreference.updateOne({
    _id: preference._id, hostUrl: host, status: 'benchmarking',
    'benchmarkClaim.batchId': claim.batchId, 'benchmarkClaim.claimGeneration': claim.claimGeneration,
    'benchmarkClaim.admissionId': parent.admissionId,
    'benchmarkClaim.admissionGeneration': parent.generation, 'benchmarkClaim.finalizeToken': null
  }, { $set: { 'benchmarkClaim.heartbeatAt': now, 'benchmarkClaim.heartbeatTtlMs': CLAIM_FINALIZE_TTL_MS } });
  if (renewed.matchedCount !== 1) return null;
  return { released: false, callerAbortRecoveryPending: true,
    contract: 'agentx.benchmark-caller-abort-drain/v1', hostUrl: host, batchId: claim.batchId,
    claimGeneration: claim.claimGeneration, admissionId: parent.admissionId,
    admissionGeneration: parent.generation, retryAfterMs: 5_000,
    reason: 'Core inference is draining before exact runtime restoration' };
}

module.exports = { deferClaimReleaseForInferences, exactParentForHost, parentPredicate };
