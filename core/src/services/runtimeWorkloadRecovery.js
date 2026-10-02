'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const {
  clean, ttlMs, secret, normalizedHosts, ensureDocument
} = require('./runtimeCoordinationState');

async function armWorkloadRecovery({ id, generation, principal, recoveryRequestId } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  recoveryRequestId = clean(recoveryRequestId);
  if (!id || !generation || !principal || !recoveryRequestId) {
    return { armed: false, reason: 'exact workload proof and recoveryRequestId required' };
  }
  await ensureDocument();
  const current = await RuntimeCoordination.findById('runtime').lean();
  const existing = (current?.workloads || []).find(item => item.admissionId === id && item.generation === generation);
  if (existing?.principal === principal && existing.recoveryRequired === true) {
    if (existing.recoveryRequestId !== recoveryRequestId) {
      return { armed: false, reason: 'workload already binds a different recovery intent' };
    }
    return {
      armed: true,
      admissionId: existing.admissionId,
      generation: existing.generation,
      principal: existing.principal,
      requestId: existing.requestId,
      workloadId: existing.workloadId,
      kind: existing.kind,
      batchId: existing.batchId,
      hosts: normalizedHosts(existing.hosts),
      recoveryRequired: true,
      recoveryId: existing.recoveryId,
      recoveryGeneration: existing.recoveryGeneration,
      recoveryRequestId: existing.recoveryRequestId,
      recoveryArmedAt: existing.recoveryArmedAt,
      recoveryState: existing.recoveryState,
      recoveryVersion: existing.recoveryVersion,
      idempotent: true
    };
  }
  const now = new Date();
  const recoveryId = secret();
  const recoveryGeneration = secret();
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        admissionId: id,
        generation,
        principal,
        expiresAt: { $gt: now },
        recoveryRequired: { $ne: true }
      } }
    },
    {
      $set: {
        'workloads.$.recoveryRequired': true,
        'workloads.$.recoveryId': recoveryId,
        'workloads.$.recoveryGeneration': recoveryGeneration,
        'workloads.$.recoveryRequestId': recoveryRequestId,
        'workloads.$.recoveryOwnerId': null,
        'workloads.$.recoveryArmedAt': now,
        'workloads.$.recoveryAdoptedAt': null,
        'workloads.$.recoveryState': 'PREPARED',
        'workloads.$.recoveryVersion': 0,
        'workloads.$.recoveryReceipt': null
      }
    },
    { new: true }
  ).lean();
  if (!updated) return { armed: false, reason: 'workload proof no longer owns coordination state' };
  const owned = updated.workloads.find(item => item.admissionId === id && item.generation === generation);
  return {
    armed: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    recoveryRequired: true,
    recoveryId: owned.recoveryId,
    recoveryGeneration: owned.recoveryGeneration,
    recoveryRequestId: owned.recoveryRequestId,
    recoveryArmedAt: owned.recoveryArmedAt,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion
  };
}

async function adoptWorkloadRecovery({ recoveryId, principal, recoveryRequestId, ownerId, ttl } = {}) {
  recoveryId = clean(recoveryId);
  principal = clean(principal);
  recoveryRequestId = clean(recoveryRequestId);
  ownerId = clean(ownerId);
  if (!recoveryId || !principal || !recoveryRequestId || !ownerId) {
    return { adopted: false, reason: 'exact recovery identity and ownerId required' };
  }
  await ensureDocument();
  const current = await RuntimeCoordination.findById('runtime').lean();
  const existing = (current?.workloads || []).find(item => item.recoveryId === recoveryId);
  if (!existing || existing.principal !== principal || existing.recoveryRequestId !== recoveryRequestId) {
    return { adopted: false, reason: 'recovery identity no longer owns coordination state' };
  }
  const adoptedAt = new Date();
  const ownerExpiresAt = existing.recoveryExpiresAt
    ? new Date(existing.recoveryExpiresAt)
    : null;
  if (existing.recoveryOwnerId === ownerId
    && ownerExpiresAt
    && ownerExpiresAt.getTime() > adoptedAt.getTime()) {
    return {
      adopted: true,
      admissionId: existing.admissionId,
      generation: existing.generation,
      principal: existing.principal,
      requestId: existing.requestId,
      workloadId: existing.workloadId,
      kind: existing.kind,
      batchId: existing.batchId,
      hosts: normalizedHosts(existing.hosts),
      recoveryRequired: true,
      recoveryId: existing.recoveryId,
      recoveryGeneration: existing.recoveryGeneration,
      recoveryRequestId: existing.recoveryRequestId,
      recoveryOwnerId: existing.recoveryOwnerId,
      recoveryHeartbeatAt: existing.recoveryHeartbeatAt,
      recoveryExpiresAt: existing.recoveryExpiresAt,
      recoveryState: existing.recoveryState,
      recoveryVersion: existing.recoveryVersion,
      idempotent: true
    };
  }
  if (new Date(existing.expiresAt).getTime() > adoptedAt.getTime()) {
    return { adopted: false, retryable: true, reason: 'original workload owner remains live' };
  }
  if (existing.recoveryOwnerId
    && ownerExpiresAt
    && ownerExpiresAt.getTime() > adoptedAt.getTime()) {
    return { adopted: false, retryable: true, reason: 'recovery owner lease remains live' };
  }
  const nextGeneration = secret();
  const recoveryExpiresAt = new Date(adoptedAt.getTime() + ttlMs(ttl));
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        admissionId: existing.admissionId,
        generation: existing.generation,
        principal,
        recoveryRequired: true,
        recoveryId,
        recoveryGeneration: existing.recoveryGeneration,
        recoveryRequestId,
        expiresAt: { $lte: adoptedAt },
        $or: [
          { recoveryOwnerId: null },
          { recoveryOwnerId: { $exists: false } },
          { recoveryExpiresAt: null },
          { recoveryExpiresAt: { $exists: false } },
          { recoveryExpiresAt: { $lte: adoptedAt } }
        ]
      } }
    },
    {
      $set: {
        'workloads.$.recoveryGeneration': nextGeneration,
        'workloads.$.recoveryOwnerId': ownerId,
        'workloads.$.recoveryAdoptedAt': adoptedAt,
        'workloads.$.recoveryHeartbeatAt': adoptedAt,
        'workloads.$.recoveryExpiresAt': recoveryExpiresAt
      }
    },
    { new: true }
  ).lean();
  if (!updated) return { adopted: false, retryable: true, reason: 'recovery ownership changed concurrently' };
  const owned = updated.workloads.find(item => item.recoveryId === recoveryId);
  return {
    adopted: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    recoveryRequired: true,
    recoveryId: owned.recoveryId,
    recoveryGeneration: owned.recoveryGeneration,
    recoveryRequestId: owned.recoveryRequestId,
    recoveryOwnerId: owned.recoveryOwnerId,
    recoveryAdoptedAt: owned.recoveryAdoptedAt,
    recoveryHeartbeatAt: owned.recoveryHeartbeatAt,
    recoveryExpiresAt: owned.recoveryExpiresAt,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion
  };
}

async function heartbeatWorkloadRecovery({ recoveryId, recoveryGeneration, principal, ownerId, ttl } = {}) {
  recoveryId = clean(recoveryId);
  recoveryGeneration = clean(recoveryGeneration);
  principal = clean(principal);
  ownerId = clean(ownerId);
  if (!recoveryId || !recoveryGeneration || !principal || !ownerId) {
    return { heartbeat: false, reason: 'exact recovery proof and ownerId required' };
  }
  const now = new Date();
  const recoveryExpiresAt = new Date(now.getTime() + ttlMs(ttl));
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        recoveryRequired: true,
        recoveryId,
        recoveryGeneration,
        principal,
        recoveryOwnerId: ownerId,
        recoveryExpiresAt: { $gt: now }
      } }
    },
    {
      $set: {
        'workloads.$.recoveryHeartbeatAt': now,
        'workloads.$.recoveryExpiresAt': recoveryExpiresAt
      }
    },
    { new: true }
  ).lean();
  if (!updated) return { heartbeat: false, reason: 'recovery owner lease no longer owns quarantine' };
  const owned = updated.workloads.find(item => item.recoveryId === recoveryId);
  return {
    heartbeat: true,
    recoveryId: owned.recoveryId,
    recoveryGeneration: owned.recoveryGeneration,
    recoveryOwnerId: owned.recoveryOwnerId,
    recoveryHeartbeatAt: owned.recoveryHeartbeatAt,
    recoveryExpiresAt: owned.recoveryExpiresAt,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion
  };
}

const RECOVERY_TRANSITIONS = Object.freeze({
  PREPARED: new Set(['MUTATING', 'UNKNOWN']),
  MUTATING: new Set(['UNKNOWN', 'VERIFIED']),
  UNKNOWN: new Set(['VERIFIED']),
  VERIFIED: new Set(['RESTORED']),
  RESTORED: new Set()
});

async function transitionWorkloadRecovery({
  recoveryId,
  recoveryGeneration,
  principal,
  ownerId = null,
  expectedVersion,
  state,
  receipt = null
} = {}) {
  recoveryId = clean(recoveryId);
  recoveryGeneration = clean(recoveryGeneration);
  principal = clean(principal);
  ownerId = clean(ownerId);
  state = clean(state, 32)?.toUpperCase() || null;
  const version = Number(expectedVersion);
  if (!recoveryId || !recoveryGeneration || !principal || !Number.isInteger(version) || version < 0 || !state) {
    return { transitioned: false, reason: 'exact recovery proof, expectedVersion, and state required' };
  }
  const current = await RuntimeCoordination.findById('runtime').lean();
  const existing = (current?.workloads || []).find(item => item.recoveryId === recoveryId);
  const now = new Date();
  const ownerLeaseLive = existing?.recoveryOwnerId
    ? ownerId === existing.recoveryOwnerId
      && existing.recoveryExpiresAt
      && new Date(existing.recoveryExpiresAt).getTime() > now.getTime()
    : existing?.expiresAt && new Date(existing.expiresAt).getTime() > now.getTime();
  if (!existing
    || existing.recoveryGeneration !== recoveryGeneration
    || existing.principal !== principal
    || !ownerLeaseLive) {
    return { transitioned: false, reason: 'recovery proof no longer owns quarantine' };
  }
  if (existing.recoveryState === state && Number(existing.recoveryVersion) === version + 1) {
    return {
      transitioned: true,
      recoveryId,
      recoveryGeneration,
      recoveryOwnerId: existing.recoveryOwnerId || null,
      recoveryState: existing.recoveryState,
      recoveryVersion: existing.recoveryVersion,
      idempotent: true
    };
  }
  const allowed = RECOVERY_TRANSITIONS[existing.recoveryState];
  if (!allowed?.has(state)) {
    return { transitioned: false, reason: `invalid recovery transition ${existing.recoveryState || 'NONE'} -> ${state}` };
  }
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        recoveryRequired: true,
        recoveryId,
        recoveryGeneration,
        principal,
        recoveryVersion: version,
        recoveryState: existing.recoveryState,
        ...(existing.recoveryOwnerId
          ? { recoveryOwnerId: ownerId, recoveryExpiresAt: { $gt: now } }
          : { expiresAt: { $gt: now } }),
      } }
    },
    {
      $set: {
        'workloads.$.recoveryState': state,
        'workloads.$.recoveryVersion': version + 1,
        'workloads.$.recoveryReceipt': receipt && typeof receipt === 'object' ? receipt : null,
        ...(state === 'UNKNOWN' ? { 'workloads.$.expiresAt': new Date() } : {})
      }
    },
    { new: true }
  ).lean();
  if (!updated) return { transitioned: false, reason: 'recovery state changed concurrently' };
  const owned = updated.workloads.find(item => item.recoveryId === recoveryId);
  return {
    transitioned: true,
    recoveryId,
    recoveryGeneration,
    recoveryOwnerId: owned.recoveryOwnerId || null,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion
  };
}

async function assertWorkloadRecovery({ recoveryId, recoveryGeneration, principal, ownerId = null } = {}) {
  recoveryId = clean(recoveryId);
  recoveryGeneration = clean(recoveryGeneration);
  principal = clean(principal);
  ownerId = clean(ownerId);
  if (!recoveryId || !recoveryGeneration || !principal) {
    return { owned: false, reason: 'exact recovery proof required' };
  }
  const now = new Date();
  const state = await RuntimeCoordination.findOne({
    _id: 'runtime',
    workloads: { $elemMatch: {
      recoveryRequired: true,
      recoveryId,
      recoveryGeneration,
      principal,
      ...(ownerId
        ? { recoveryOwnerId: ownerId, recoveryExpiresAt: { $gt: now } }
        : { recoveryOwnerId: null, expiresAt: { $gt: now } })
    } }
  }).lean();
  if (!state) return { owned: false, reason: 'recovery proof no longer owns quarantine' };
  const owned = state.workloads.find(item => item.recoveryId === recoveryId && item.recoveryGeneration === recoveryGeneration);
  return {
    owned: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    workloadId: owned.workloadId,
    recoveryId: owned.recoveryId,
    recoveryGeneration: owned.recoveryGeneration,
    recoveryOwnerId: owned.recoveryOwnerId || null,
    recoveryHeartbeatAt: owned.recoveryHeartbeatAt || null,
    recoveryExpiresAt: owned.recoveryExpiresAt || null,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion
  };
}

async function resolveWorkloadRecovery({ recoveryId, recoveryGeneration, principal, ownerId = null } = {}) {
  const ownership = await assertWorkloadRecovery({ recoveryId, recoveryGeneration, principal, ownerId });
  if (ownership.owned !== true) return { released: false, reason: ownership.reason };
  const current = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
  const owned = (current?.workloads || []).find(item => item.recoveryId === recoveryId
    && item.recoveryGeneration === recoveryGeneration
    && item.principal === principal
    && (!ownerId || item.recoveryOwnerId === ownerId));
  if (!owned) return { released: false, reason: 'recovery proof no longer owns quarantine' };
  if (owned.recoveryState !== 'RESTORED' || !owned.recoveryReceipt) {
    return { released: false, reason: 'recovery quarantine is not VERIFIED and RESTORED with a receipt' };
  }
  const releasedAt = new Date();
  const releaseReceipt = {
    coordinationKind: 'workload',
    released: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    recoveryRequired: true,
    recoveryId: owned.recoveryId,
    recoveryGeneration: owned.recoveryGeneration,
    recoveryOwnerId: owned.recoveryOwnerId || null,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion,
    recoveryReceipt: owned.recoveryReceipt,
    releasedAt
  };
  const prior = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        admissionId: owned.admissionId,
        generation: owned.generation,
        principal,
        recoveryRequired: true,
        recoveryId,
        recoveryGeneration,
        recoveryState: 'RESTORED',
        recoveryVersion: owned.recoveryVersion,
        recoveryReceipt: { $ne: null },
        ...(ownerId
          ? { recoveryOwnerId: ownerId, recoveryExpiresAt: { $gt: releasedAt } }
          : { recoveryOwnerId: null, expiresAt: { $gt: releasedAt } })
      } }
    },
    {
      $pull: { workloads: {
        admissionId: owned.admissionId,
        generation: owned.generation,
        principal,
        recoveryId,
        recoveryGeneration,
        recoveryState: 'RESTORED',
        recoveryVersion: owned.recoveryVersion,
        ...(ownerId ? { recoveryOwnerId: ownerId } : { recoveryOwnerId: null })
      } },
      $push: { releaseReceipts: { $each: [releaseReceipt], $slice: -100 } }
    },
    { new: false }
  ).lean();
  return prior ? releaseReceipt : { released: false, reason: 'recovery proof changed during release' };
}

module.exports = {
  armWorkloadRecovery,
  adoptWorkloadRecovery,
  heartbeatWorkloadRecovery,
  assertWorkloadRecovery,
  transitionWorkloadRecovery,
  resolveWorkloadRecovery
};
