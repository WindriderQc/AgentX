'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const {
  clean, ttlMs, secret, canonicalHost, normalizedHosts, reapExpired
} = require('./runtimeCoordinationState');

function sameWorkloadIntent(existing, { workloadId, kind, batchId, hosts }) {
  const existingHosts = normalizedHosts(existing?.hosts);
  const requestedHosts = normalizedHosts(hosts);
  return existing?.workloadId === workloadId
    && existing?.kind === kind
    && (existing?.batchId || null) === (batchId || null)
    && JSON.stringify(existingHosts) === JSON.stringify(requestedHosts);
}

async function acquireWorkload({ principal, requestId, workloadId, kind, batchId, hosts, recoveryRequestId, ttl } = {}) {
  principal = clean(principal);
  requestId = clean(requestId);
  workloadId = clean(workloadId);
  kind = clean(kind) || 'benchmark';
  batchId = clean(batchId);
  recoveryRequestId = clean(recoveryRequestId) || (requestId ? `recovery:${requestId}` : null);
  hosts = normalizedHosts(hosts);
  if (!principal || !requestId || !workloadId) {
    return { acquired: false, reason: 'principal, requestId, and workloadId required' };
  }
  await reapExpired();
  const current = await RuntimeCoordination.findById('runtime').lean();
  const existing = (current?.workloads || []).find(item =>
    item.requestId === requestId && item.principal === principal);
  if (existing) {
    if (!sameWorkloadIntent(existing, { workloadId, kind, batchId, hosts })) {
      return { acquired: false, reason: 'idempotency key already binds a different workload intent' };
    }
    if (existing.recoveryRequired === true
      && new Date(existing.expiresAt).getTime() <= Date.now()) {
      return { acquired: false, recoveryRequired: true, reason: 'expired workload requires fenced recovery adoption' };
    }
    return { acquired: true, ...existing, idempotent: true };
  }
  const now = new Date();
  const duration = ttlMs(ttl);
  const recoveryId = secret();
  const recoveryGeneration = secret();
  const admission = {
    admissionId: secret(),
    generation: secret(),
    principal,
    requestId,
    workloadId,
    kind,
    batchId,
    hosts,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: new Date(now.getTime() + duration),
    recoveryRequired: true,
    recoveryId,
    recoveryGeneration,
    recoveryRequestId,
    recoveryOwnerId: null,
    recoveryArmedAt: now,
    recoveryAdoptedAt: null,
    recoveryHeartbeatAt: null,
    recoveryExpiresAt: null,
    recoveryState: 'PREPARED',
    recoveryVersion: 0,
    recoveryReceipt: null
  };
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      maintenance: null,
      // Workload admission is exclusive for every requested host. This veto
      // lives in the same CAS as the workload insert so inference/workload
      // acquisition is linearizable in both directions. UNKNOWN inference
      // entries deliberately continue to block.
      ...(hosts.length > 0
        ? { inferences: { $not: { $elemMatch: { host: { $in: hosts } } } } }
        : { 'inferences.0': { $exists: false } }),
      workloads: { $not: { $elemMatch: {
        $or: [
          { requestId, principal },
          ...(hosts.length > 0 ? [{ hosts: { $in: hosts } }] : [])
        ]
      } } }
    },
    { $push: { workloads: admission } },
    { new: true }
  ).lean();
  if (updated) return { acquired: true, ...admission };
  const raced = await RuntimeCoordination.findById('runtime').lean();
  const racedAdmission = (raced?.workloads || []).find(item =>
    item.requestId === requestId && item.principal === principal);
  if (racedAdmission) {
    if (!sameWorkloadIntent(racedAdmission, { workloadId, kind, batchId, hosts })) {
      return { acquired: false, reason: 'idempotency key already binds a different workload intent' };
    }
    if (racedAdmission.recoveryRequired === true
      && new Date(racedAdmission.expiresAt).getTime() <= Date.now()) {
      return { acquired: false, recoveryRequired: true, reason: 'expired workload requires fenced recovery adoption' };
    }
    return { acquired: true, ...racedAdmission, idempotent: true };
  }
  return {
    acquired: false,
    reason: 'active maintenance lease, inference admission, or conflicting workload blocks workload admission'
  };
}

async function isWorkloadRecoveryRequired({ id, generation, principal } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return false;
  const state = await RuntimeCoordination.findOne({
    _id: 'runtime',
    workloads: { $elemMatch: { admissionId: id, generation, principal, recoveryRequired: true } }
  }).lean();
  return Boolean(state);
}

async function assertWorkloadAdmission({ id, generation, principal, workloadId, host } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  workloadId = clean(workloadId);
  host = canonicalHost(host);
  if (!id || !generation || !principal || !workloadId) {
    return { admitted: false, reason: 'exact workload admission proof required' };
  }
  await reapExpired();
  const state = await RuntimeCoordination.findOne({
    _id: 'runtime',
    workloads: { $elemMatch: {
      admissionId: id,
      generation,
      principal,
      workloadId,
      expiresAt: { $gt: new Date() },
      ...(host ? { hosts: host } : {})
    } }
  }).lean();
  if (!state) return { admitted: false, reason: 'workload admission proof is absent, expired, or does not cover this host' };
  const owned = state.workloads.find(item => item.admissionId === id && item.generation === generation);
  return {
    admitted: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    expiresAt: owned.expiresAt
  };
}

module.exports = {
  acquireWorkload,
  isWorkloadRecoveryRequired,
  assertWorkloadAdmission
};
