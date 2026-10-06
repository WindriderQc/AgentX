'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const { resourceTopology, topologyMatches } = require('./runtimePhysicalResources');
const {
  clean, ttlMs, normalizedHosts, ensureDocument, reapExpired
} = require('./runtimeCoordinationState');

// Heartbeat, release, release recovery and the active listing shared by
// maintenance leases and workload admissions.
async function heartbeat(kind, { id, generation, principal, ttl } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { heartbeat: false, reason: 'exact lease proof required' };
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs(ttl));
  const isMaintenance = kind === 'maintenance';
  const filter = isMaintenance
    ? {
      _id: 'runtime',
      'maintenance.leaseId': id,
      'maintenance.generation': generation,
      'maintenance.principal': principal,
      'maintenance.state': { $in: ['ACTIVE', null] },
      'maintenance.expiresAt': { $gt: now }
    }
    : { _id: 'runtime', workloads: { $elemMatch: { admissionId: id, generation, principal, expiresAt: { $gt: now } } } };
  const set = isMaintenance
    ? { 'maintenance.heartbeatAt': now, 'maintenance.expiresAt': expiresAt }
    : { 'workloads.$.heartbeatAt': now, 'workloads.$.expiresAt': expiresAt };
  const updated = await RuntimeCoordination.findOneAndUpdate(filter, { $set: set }, { new: true }).lean();
  if (!updated) return { heartbeat: false, reason: 'lease proof no longer owns coordination state' };
  const owned = isMaintenance
    ? updated.maintenance
    : updated.workloads.find(item => item.admissionId === id && item.generation === generation);
  return isMaintenance ? {
    heartbeat: true,
    leaseId: owned.leaseId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    scope: owned.scope,
    heartbeatAt: owned.heartbeatAt,
    expiresAt: owned.expiresAt
  } : {
    heartbeat: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    recoveryRequired: owned.recoveryRequired === true,
    recoveryId: owned.recoveryId || null,
    recoveryGeneration: owned.recoveryGeneration || null,
    recoveryState: owned.recoveryState || null,
    recoveryVersion: Number.isInteger(owned.recoveryVersion) ? owned.recoveryVersion : null,
    heartbeatAt: owned.heartbeatAt,
    expiresAt: owned.expiresAt
  };
}

async function release(kind, { id, generation, principal } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { released: false, reason: 'exact lease proof required' };
  const isMaintenance = kind === 'maintenance';
  const now = new Date();
  await reapExpired(now);
  const current = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
  const owned = isMaintenance
    ? current?.maintenance
    : (current?.workloads || []).find(item => item.admissionId === id && item.generation === generation);
  const exactOwner = owned
    && owned.generation === generation
    && owned.principal === principal
    && (isMaintenance ? owned.leaseId === id : owned.admissionId === id);
  if (!exactOwner) return { released: false, reason: 'lease proof no longer owns coordination state' };
  if (isMaintenance && (owned.state || 'ACTIVE') !== 'ACTIVE') {
    return {
      released: false,
      recoveryRequired: true,
      reason: 'maintenance lease is quarantined pending operator reconciliation'
    };
  }
  if (!isMaintenance && owned.recoveryRequired === true && owned.recoveryState !== 'PREPARED') {
    return { released: false, reason: 'workload is protected by durable recovery quarantine' };
  }
  const releasedAt = new Date();
  const releaseReceipt = isMaintenance ? {
    coordinationKind: 'maintenance',
    released: true,
    leaseId: owned.leaseId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    scope: owned.scope,
    releasedAt
  } : {
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
    releasedAt
  };
  const filter = isMaintenance
    ? {
      _id: 'runtime',
      'maintenance.leaseId': id,
      'maintenance.generation': generation,
      'maintenance.principal': principal,
      'maintenance.state': { $in: ['ACTIVE', null] },
      'maintenance.expiresAt': { $gt: releasedAt }
    }
    : { _id: 'runtime', inferences: { $not: { $elemMatch: { workloadAdmissionId: id, workloadGeneration: generation } } }, workloads: { $elemMatch: {
      admissionId: id, generation, principal, expiresAt: { $gt: releasedAt }
    } } };
  const update = {
    ...(isMaintenance
      ? { $set: { maintenance: null } }
      : { $pull: { workloads: { admissionId: id, generation, principal } } }),
    $push: { releaseReceipts: { $each: [releaseReceipt], $slice: -100 } }
  };
  const prior = await RuntimeCoordination.findOneAndUpdate(filter, update, { new: false }).lean();
  if (!prior) return { released: false, reason: 'lease proof no longer owns coordination state' };
  return isMaintenance ? {
    released: true,
    leaseId: owned.leaseId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    scope: owned.scope,
    releasedAt
  } : {
    released: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    releasedAt
  };
}

async function recoverRelease(kind, { id, generation, principal } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { recovered: false, released: false, reason: 'exact lease proof required' };
  await ensureDocument();
  const isMaintenance = kind === 'maintenance';
  const current = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
  const receipt = [...(current?.releaseReceipts || [])].reverse().find(item => (
    item?.coordinationKind === kind
    && item.generation === generation
    && item.principal === principal
    && (isMaintenance ? item.leaseId === id : item.admissionId === id)
  ));
  if (receipt) return { recovered: true, ...receipt };
  const active = isMaintenance
    ? current?.maintenance
    : (current?.workloads || []).find(item => item.admissionId === id);
  if (active?.generation === generation && active?.principal === principal) {
    return isMaintenance ? {
      recovered: true,
      released: false,
      retryable: (active.state || 'ACTIVE') === 'ACTIVE',
      leaseId: active.leaseId,
      generation: active.generation,
      principal: active.principal,
      requestId: active.requestId,
      scope: active.scope,
      state: active.state || 'ACTIVE',
      recoveryRequired: active.state === 'UNKNOWN',
      reason: active.state === 'UNKNOWN'
        ? 'maintenance lease is quarantined pending operator reconciliation'
        : 'exact lease remains active'
    } : {
      recovered: true,
      released: false,
      retryable: true,
      admissionId: active.admissionId,
      generation: active.generation,
      principal: active.principal,
      requestId: active.requestId,
      workloadId: active.workloadId,
      kind: active.kind,
      batchId: active.batchId,
      hosts: normalizedHosts(active.hosts),
      recoveryRequired: active.recoveryRequired === true,
      recoveryId: active.recoveryId || null,
      recoveryGeneration: active.recoveryGeneration || null,
      recoveryOwnerId: active.recoveryOwnerId || null,
      recoveryState: active.recoveryState || null,
      recoveryVersion: active.recoveryVersion ?? null,
      reason: 'exact lease remains active'
    };
  }
  return { recovered: false, released: false, retryable: false, reason: 'no matching release receipt or active lease' };
}

async function listActive() {
  await reapExpired();
  const state = await RuntimeCoordination.findById('runtime').lean();
  let physicalResources;
  try {
    const topology = resourceTopology();
    physicalResources = { configured: topology.resources.length > 0, configurationValid: true,
      mappingChangeBlocked: !topologyMatches(state, topology), resourceCount: topology.resources.length };
  } catch {
    physicalResources = { configured: true, configurationValid: false,
      mappingChangeBlocked: true, resourceCount: null };
  }
  return {
    physicalResources,
    maintenance: state?.maintenance ? {
      active: (state.maintenance.state || 'ACTIVE') === 'ACTIVE',
      quarantined: state.maintenance.state === 'UNKNOWN',
      leaseId: state.maintenance.leaseId,
      principal: state.maintenance.principal,
      scope: state.maintenance.scope,
      acquiredAt: state.maintenance.acquiredAt,
      heartbeatAt: state.maintenance.heartbeatAt,
      expiresAt: state.maintenance.expiresAt,
      unknownAt: state.maintenance.unknownAt || null,
      unknownReason: state.maintenance.unknownReason || null
    } : null,
    workloads: (state?.workloads || []).map(item => ({
      admissionId: item.admissionId,
      principal: item.principal,
      workloadId: item.workloadId,
      kind: item.kind,
      batchId: item.batchId,
      hosts: item.hosts,
      resourceIds: item.resourceIds || [],
      recoveryRequired: item.recoveryRequired === true,
      acquiredAt: item.acquiredAt,
      heartbeatAt: item.heartbeatAt,
      expiresAt: item.expiresAt
    })),
    inferences: (state?.inferences || []).map(item => ({
      active: item.state === 'ACTIVE',
      quarantined: item.state === 'UNKNOWN',
      host: item.host,
      resourceIds: item.resourceIds || [],
      model: item.model,
      kind: item.kind, unknownOrigin: item.unknownOrigin || null,
      mode: item.mode || 'shared',
      acquiredAt: item.acquiredAt,
      heartbeatAt: item.heartbeatAt,
      expiresAt: item.expiresAt
    }))
  };
}

module.exports = {
  heartbeat,
  release,
  recoverRelease,
  listActive
};
