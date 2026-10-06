'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const { resourceTopology, resourcesFor, topologyGuard, topologyMatches, resourceFailure, overlaps } = require('./runtimePhysicalResources');
const { inferenceConflict } = require('./runtimeInferenceConflict');
const { WORKLOAD_INFERENCE_MAINTENANCE_FILTER } = require('./runtimeDeployGate');
const { clean, ttlMs, secret, canonicalHost, reapExpired } = require('./runtimeCoordinationState');
const { buildInferenceResidencySpec, buildInferenceResidencyKey } = require('./runtimeInferenceResidency');
const { modelIdentityKey } = require('../../../shared/modelNames');

// Several models may run on one host at once. The same model under another
// residency (context, runner options, keep-alive) would make Ollama reload it
// under the running call, so that pair still conflicts.
function modelKeyOf(model) {
  return modelIdentityKey(model) || null;
}

function sameInferenceIntent(existing, {
  host, model, residencyKey, kind, mode, workloadAdmissionId, workloadGeneration
}) {
  return existing?.host === host
    && existing?.model === model
    && existing?.residencyKey === residencyKey
    && existing?.kind === kind
    && (existing?.mode || 'shared') === mode
    && (existing?.workloadAdmissionId || null) === (workloadAdmissionId || null)
    && (existing?.workloadGeneration || null) === (workloadGeneration || null);
}

async function acquireInference({
  principal,
  requestId,
  host,
  model,
  kind = 'inference',
  mode = 'shared',
  workloadAdmissionId = null,
  workloadGeneration = null,
  runtimeOptions = null,
  keepAlive,
  hostIdle = false,
  ttl
} = {}) {
  principal = clean(principal);
  requestId = clean(requestId);
  host = canonicalHost(host);
  model = clean(model, 500);
  kind = clean(kind) || 'inference';
  mode = mode === 'exclusive' ? 'exclusive' : 'shared';
  workloadAdmissionId = clean(workloadAdmissionId);
  workloadGeneration = clean(workloadGeneration);
  if (!principal || !requestId || !host || !model) {
    return { acquired: false, reason: 'principal, requestId, host, and model are required' };
  }
  if (Boolean(workloadAdmissionId) !== Boolean(workloadGeneration)) {
    return { acquired: false, reason: 'workload admission id and generation must be supplied together' };
  }
  const keepAliveSupplied = keepAlive !== undefined;
  const residencySpec = buildInferenceResidencySpec({ model, runtimeOptions, keepAlive, keepAliveSupplied });
  const residencyKey = buildInferenceResidencyKey({ model, runtimeOptions, keepAlive, keepAliveSupplied });
  const modelKey = modelKeyOf(model);
  let topology;
  try { topology = resourceTopology(); } catch (error) { return resourceFailure(error.code); }
  const resourceIds = resourcesFor(topology, [host]);
  await reapExpired();
  const current = await RuntimeCoordination.findById('runtime').lean();
  if (!topologyMatches(current, topology)) return resourceFailure('runtime_resource_configuration_changed');
  const existing = (current?.inferences || []).find(item =>
    item.requestId === requestId && item.principal === principal);
  if (existing) {
    if (!sameInferenceIntent(existing, {
      host, model, residencyKey, kind, mode, workloadAdmissionId, workloadGeneration
    })) {
      return { acquired: false, reason: 'idempotency key already binds a different inference intent' };
    }
    if (existing.state !== 'ACTIVE' || new Date(existing.expiresAt).getTime() <= Date.now()) {
      return { acquired: false, recoveryRequired: true, reason: 'inference requires operator runtime recovery' };
    }
    if ((current.workloads || []).some(w => (w.drainingHosts || []).includes(host))) {
      return { acquired: false, reason: 'workload is draining on this host' };
    }
    return { acquired: true, ...existing, idempotent: true };
  }

  const now = new Date();
  const duration = ttlMs(ttl);
  const admission = {
    admissionId: secret(),
    generation: secret(),
    principal,
    requestId,
    host,
    model,
    modelKey,
    residencyKey,
    residencySpec,
    resourceIds,
    kind,
    mode,
    workloadAdmissionId,
    workloadGeneration,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: new Date(now.getTime() + duration),
    state: 'ACTIVE',
    unknownAt: null
  };

  const incompatibleInference = {
    $and: [
      { $or: [{ host }, ...(resourceIds.length ? [{ resourceIds: { $in: resourceIds } }] : [])] },
      { $or: [
        { host: { $ne: host } },
        { state: 'UNKNOWN' },
        { mode: 'exclusive' },
        // Admissions written before modelKey existed keep the old one-residency rule.
        ...(mode === 'exclusive' ? [{}] : [{ residencyKey: { $ne: residencyKey }, $or: [{ modelKey }, { modelKey: null }] }])
      ] }
    ]
  };
  // A caller that must not queue behind anything (a health probe on a host
  // that serves one request at a time) is admitted only beside nothing.
  const otherInference = hostIdle ? [{ host }] : [];
  // A workload's shared host keeps admitting shared inference; another
  // endpoint on the same device does not.
  const resourceWorkload = resourceIds.length ? [{ resourceIds: { $in: resourceIds },
    ...(mode === 'shared' && { $or: [{ hosts: { $ne: host } },
      { yieldedAt: null, sharedHosts: { $ne: host } }, { drainingHosts: host, sharedHosts: { $ne: host } }] }) }] : [];
  const ordinaryFilter = {
    _id: 'runtime',
    ...topologyGuard(topology),
    maintenance: null,
    inferences: { $not: { $elemMatch: {
      $or: [
        { requestId, principal },
        incompatibleInference,
        ...otherInference
      ]
    } } },
    workloads: { $not: { $elemMatch: { $or: [
      mode === 'exclusive' ? { hosts: host }
        : { hosts: host, sharedHosts: { $ne: host }, $or: [{ yieldedAt: null }, { drainingHosts: host }] },
      ...resourceWorkload
    ] } } }
  };
  const workloadFilter = {
    _id: 'runtime',
    ...topologyGuard(topology),
    ...WORKLOAD_INFERENCE_MAINTENANCE_FILTER,
    inferences: { $not: { $elemMatch: {
      $or: [
        { requestId, principal },
        incompatibleInference,
        ...otherInference
      ]
    } } },
    workloads: { $elemMatch: {
      admissionId: workloadAdmissionId,
      generation: workloadGeneration,
      principal,
      hosts: host,
      drainingHosts: { $ne: host },
      expiresAt: { $gt: now }, yieldedAt: null
    } }
  };
  const updated = await RuntimeCoordination.findOneAndUpdate(
    workloadAdmissionId ? workloadFilter : ordinaryFilter,
    { $push: { inferences: admission }, $set: { resourceTopologyHash: topology.hash } },
    { new: true }
  ).lean();
  if (updated) return { acquired: true, ...admission };
  const blocked = await RuntimeCoordination.findById('runtime').lean();
  if (!topologyMatches(blocked, topology)) return resourceFailure('runtime_resource_configuration_changed');
  const recoveryRequired = blocked?.maintenance?.state === 'UNKNOWN'
    || (blocked?.inferences || []).some(item => overlaps(item, host, resourceIds) && item.state === 'UNKNOWN');
  return {
    acquired: false,
    recoveryRequired,
    failure: inferenceConflict(blocked, { host, resourceIds, mode, residencyKey, modelKey, principal, workloadAdmissionId, workloadGeneration }, now),
    reason: workloadAdmissionId
      ? 'exact workload proof is absent/expired, or a conflicting inference residency blocks this host'
      : 'maintenance, workload, UNKNOWN inference, or incompatible residency blocks inference on this host'
  };
}

async function heartbeatInference({ id, generation, principal, ttl } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { heartbeat: false, reason: 'exact inference proof required' };
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs(ttl));
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      inferences: { $elemMatch: {
        admissionId: id,
        generation,
        principal,
        state: 'ACTIVE',
        expiresAt: { $gt: now }
      } }
    },
    { $set: { 'inferences.$.heartbeatAt': now, 'inferences.$.expiresAt': expiresAt } },
    { new: true }
  ).lean();
  if (!updated) return { heartbeat: false, reason: 'inference proof no longer owns active coordination state' };
  const owned = updated.inferences.find(item => item.admissionId === id && item.generation === generation);
  return { heartbeat: true, ...owned };
}

async function releaseInference({ id, generation, principal } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { released: false, reason: 'exact inference proof required' };
  const now = new Date();
  await reapExpired(now);
  const current = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
  const priorReceipt = [...(current?.releaseReceipts || [])].reverse().find(item => (
    item?.coordinationKind === 'inference'
    && item?.admissionId === id
    && item?.generation === generation
    && item?.principal === principal
  ));
  if (priorReceipt) return { ...priorReceipt, idempotent: true };
  const owned = (current?.inferences || []).find(item => (
    item?.admissionId === id
    && item?.generation === generation
    && item?.principal === principal
    && item?.state === 'ACTIVE'
  ));
  const releasedAt = new Date();
  const releaseReceipt = {
    contract: 'agentx.runtime-inference-completion/v1',
    coordinationKind: 'inference',
    released: true,
    admissionId: id,
    generation,
    principal,
    requestId: owned?.requestId || null,
    host: owned?.host || null,
    model: owned?.model || null,
    kind: owned?.kind || null,
    mode: owned?.mode || 'shared',
    residencyKey: owned?.residencyKey || null,
    residencySpec: owned?.residencySpec || null,
    acquiredAt: owned?.acquiredAt || null,
    heartbeatAt: owned?.heartbeatAt || null,
    releasedAt
  };
  const released = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      inferences: { $elemMatch: {
        admissionId: id, generation, principal, state: 'ACTIVE', expiresAt: { $gt: releasedAt }
      } }
    },
    {
      $pull: { inferences: { admissionId: id, generation, principal, state: 'ACTIVE' } },
      $push: { releaseReceipts: { $each: [releaseReceipt], $slice: -100 } }
    },
    { new: false }
  ).lean();
  return released
    ? releaseReceipt
    : { released: false, reason: 'inference proof is absent or quarantined' };
}

async function markInferenceUnknown({ id, generation, principal, reason = null, origin = null } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { quarantined: false, reason: 'exact inference proof required' };
  const now = new Date();
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      inferences: { $elemMatch: { admissionId: id, generation, principal, state: 'ACTIVE' } }
    },
    { $set: {
      'inferences.$.state': 'UNKNOWN',
      'inferences.$.unknownAt': now,
      'inferences.$.unknownReason': clean(reason, 500),
      'inferences.$.unknownOrigin': ['caller-abort', 'deadline-abort', 'runtime-disconnect'].includes(origin) ? origin : null
    } },
    { new: true }
  ).lean();
  const owned = updated?.inferences?.find(item => item.admissionId === id && item.generation === generation);
  if (owned) {
    return {
      contract: 'agentx.runtime-inference-quarantine/v1',
      quarantined: true,
      admissionId: id,
      generation,
      principal,
      requestId: owned.requestId || null,
      host: owned.host,
      model: owned.model,
      kind: owned.kind,
      mode: owned.mode || 'shared',
      residencyKey: owned.residencyKey,
      residencySpec: owned.residencySpec,
      acquiredAt: owned.acquiredAt,
      heartbeatAt: owned.heartbeatAt,
      expiresAt: owned.expiresAt,
      unknownAt: owned.unknownAt,
      reason: owned.unknownReason || null
    };
  }
  const existing = await RuntimeCoordination.findOne({
    _id: 'runtime',
    inferences: { $elemMatch: { admissionId: id, generation, principal, state: 'UNKNOWN' } }
  }).lean();
  const quarantined = existing?.inferences?.find(item => item.admissionId === id && item.generation === generation);
  return quarantined
    ? {
      contract: 'agentx.runtime-inference-quarantine/v1',
      quarantined: true,
      admissionId: id,
      generation,
      principal,
      requestId: quarantined.requestId || null,
      host: quarantined.host,
      model: quarantined.model,
      kind: quarantined.kind,
      mode: quarantined.mode || 'shared',
      residencyKey: quarantined.residencyKey,
      residencySpec: quarantined.residencySpec,
      acquiredAt: quarantined.acquiredAt,
      heartbeatAt: quarantined.heartbeatAt,
      expiresAt: quarantined.expiresAt,
      unknownAt: quarantined.unknownAt,
      reason: quarantined.unknownReason || null,
      idempotent: true
    }
    : { quarantined: false, reason: 'inference proof no longer owns active coordination state' };
}

async function recoverInferenceAfterRuntimeRestart({ id, generation, principal, receipt } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  const restartedAt = new Date(receipt?.restartedAt || '');
  const exactReceipt = receipt?.contract === 'agentx.ollama-runtime-restart/v1'
    && receipt?.runtimeRestarted === true
    && receipt?.confirmation === 'OLLAMA_RUNTIME_RESTARTED_AND_PRIOR_REQUESTS_TERMINATED'
    && typeof receipt?.restartedAt === 'string'
    && Number.isFinite(restartedAt.getTime())
    && restartedAt.getTime() <= Date.now() + 5 * 60_000;
  if (!id || !generation || !exactReceipt) {
    return { recovered: false, reason: 'exact inference proof and runtime restart receipt required' };
  }
  const exactInference = {
    admissionId: id,
    generation,
    state: 'UNKNOWN',
    unknownAt: { $lte: restartedAt },
    ...(principal && { principal })
  };
  const recovered = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      inferences: { $elemMatch: exactInference }
    },
    { $pull: { inferences: { admissionId: id, generation, state: 'UNKNOWN', ...(principal && { principal }) } } },
    { new: false }
  ).lean();
  const inference = recovered?.inferences?.find((entry) => entry.admissionId === id
    && entry.generation === generation
    && entry.state === 'UNKNOWN'
    && (!principal || entry.principal === principal));
  return inference
    ? { recovered: true, admissionId: id, generation, principal: inference.principal, receipt }
    : { recovered: false, reason: 'matching quarantined inference was not found' };
}

async function hostHasActiveInferences(host) {
  host = canonicalHost(host);
  if (!host) return false;
  let topology;
  try { topology = resourceTopology(); } catch { return true; }
  const resourceIds = resourcesFor(topology, [host]);
  await reapExpired();
  const current = await RuntimeCoordination.findById('runtime').lean();
  if (!topologyMatches(current, topology)) return true;
  return Boolean(await RuntimeCoordination.exists({
    _id: 'runtime',
    inferences: { $elemMatch: { $or: [{ host },
      ...(resourceIds.length ? [{ resourceIds: { $in: resourceIds } }] : [])] } }
  }));
}

module.exports = {
  acquireInference,
  heartbeatInference,
  releaseInference,
  markInferenceUnknown,
  recoverInferenceAfterRuntimeRestart,
  hostHasActiveInferences
};
