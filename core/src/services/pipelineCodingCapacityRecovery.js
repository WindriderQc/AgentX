'use strict';

// A stopped coding owner's recovery, not a generic operator principal override.
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const Runtime = require('../../models/RuntimeCoordination');
const coordination = require('./runtimeCoordinationService');
const { digest, fail } = require('./pipelineCodingAutonomyPolicy');
const { resourceTopology, topologyMatches, resourcesFor } = require('./runtimePhysicalResources');
const PRINCIPAL = 'core-trusted-runtime';
const CONFIRMATION = 'ORIGINAL_CODING_WORKER_TERMINATED_RECOVER_NATIVE_CAPACITY';
const WC = { w: 1, j: true };
const refusal = message => fail(message, 'CODING_CAPACITY_RECOVERY_UNVERIFIED');
const journal = task => digest([task.codingAutonomy.runs.at(-1).modelReceipts,
  task.codingAutonomy.runs.at(-1).pendingInferences, task.codingAutonomy.spent]);

async function acknowledge(task, marker) {
  if (journal(task) !== marker.journalFingerprint
    || digest(task.automationAttempts.at(-1)) !== marker.attemptFingerprint)
    throw refusal('Original native verdict or model journal changed during verification');
  const prefix = `codingAutonomy.runs.${task.codingAutonomy.runs.length - 1}`;
  const run = task.codingAutonomy.runs.at(-1);
  // Embedded-document equality depends on BSON field order; Mongoose recasts
  // historical attempt documents. Match the durable native verdict by leaves.
  const attemptPrefix = `automationAttempts.${task.automationAttempts.length - 1}`;
  const attempt = task.automationAttempts.at(-1);
  const attemptQuery = Object.fromEntries(['dispatchRequestId', 'assignee', 'attempt', 'completedAt',
    'finalState', 'resultRequestFingerprint'].map(key => [`${attemptPrefix}.${key}`, attempt[key]]));
  if (attempt.evidence?.workerReceiptFingerprint)
    attemptQuery[`${attemptPrefix}.evidence.workerReceiptFingerprint`] = attempt.evidence.workerReceiptFingerprint;
  const checked = await Task.updateOne({ pipelineId: task.pipelineId, status: 'blocked', automationLease: null,
    'codingAutonomy.authorized': false, 'codingCapacityRecovery.fingerprint': marker.fingerprint,
    ...attemptQuery, 'codingAutonomy.spent': task.codingAutonomy.spent,
    [`${prefix}.requestId`]: marker.requestId, [`${prefix}.modelReceipts`]: run.modelReceipts,
    [`${prefix}.pendingInferences`]: run.pendingInferences },
  { $set: { 'codingCapacityRecovery.acknowledgedAt': new Date().toISOString() } }, { writeConcern: WC });
  if (!checked.acknowledged || checked.matchedCount !== 1)
    throw refusal('Original recovery proof was not durably re-acknowledged');
}

function residents(models) {
  if (!Array.isArray(models) || !models.length) throw refusal('The saved coding resident must be present');
  return models.map(m => {
    if (!(m.name || m.model) || !m.digest || !Number.isSafeInteger(m.context_length) || !Number.isFinite(m.size)
      || !Number.isFinite(m.size_vram) || !Number.isFinite(Date.parse(m.expires_at))
      || Date.parse(m.expires_at) < Date.now() + 365 * 86400000)
      throw refusal('Recovery requires exact persistent resident identities and GPU memory usage');
    return { model: m.name || m.model, digest: m.digest, context: m.context_length,
      size: m.size, sizeVram: m.size_vram, persistent: true };
  }).sort((a, b) => a.model.localeCompare(b.model));
}

async function evidence(pipelineId, requestId, input, control) {
  if (!/^\d{4}$/.test(pipelineId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId || '')
    || input.confirm !== true || input.confirmation !== CONFIRMATION
    || !/^[a-zA-Z0-9:_-]{1,120}$/.test(input.key || '') || input.workerTerminated !== true)
    throw refusal('Confirm the exact terminated coding worker and stable recovery identity');
  const task = await Task.findOne({ pipelineId }).lean();
  const config = await Settings.findById('coding-autonomy').lean();
  const attempts = (task?.automationAttempts || []).filter(a => a.dispatchRequestId === requestId);
  const attempt = attempts[0];
  const run = task?.codingAutonomy?.runs.at(-1);
  if (!task || task.service !== 'agentx-coding' || task.status !== 'blocked' || task.automationLease
    || task.codingAutonomy?.authorized !== false || config?.enabled !== false
    || config.active?.pipelineId !== pipelineId || config.active?.requestId !== requestId
    || run?.requestId !== requestId || attempts.length !== 1 || attempt.assignee !== 'coding-team'
    || !attempt.completedAt || attempt.finalState !== 'blocked'
    || attempt.attempt !== task.automationAttemptCount || !/^[a-f0-9]{64}$/.test(attempt.resultRequestFingerprint || '')
    || task.automationAttempts.at(-1).dispatchRequestId !== requestId)
    throw refusal('Pause autonomy and retain the exact unauthorized task with its received native verdict');
  if (!control) throw refusal('The original host owner must answer');
  const host = await control.status({ requestId });
  if (host.available !== true || host.busy !== false || host.run?.requestId !== requestId
    || host.run.pipelineId !== pipelineId || !['unknown', 'finished'].includes(host.run.phase)
    || host.run.progress?.requestId !== requestId || host.run.progress.pipelineId !== pipelineId)
    throw refusal('The original host worker is not independently verified terminated');
  return { task, attempt, run, host };
}

async function runtime(task, requestId, { allowUnknown = false } = {}) {
  const state = await Runtime.findById('runtime').select('+releaseReceipts').lean();
  const topology = resourceTopology();
  if (!state || !topologyMatches(state, topology) || state.maintenance)
    throw refusal('Runtime topology or maintenance prevents native coding recovery');
  const parent = state.workloads.find(w => w.principal === PRINCIPAL && w.requestId === requestId
    && w.kind === 'coding' && w.workloadId === `coding:${task.pipelineId}:${requestId}`);
  if (!parent) return { state, parent: null };
  const hosts = parent.hosts || [];
  const ids = new Set([...(parent.resourceIds || []), ...resourcesFor(topology, hosts)]);
  const overlaps = item => (item.hosts || [item.host]).some(h => hosts.includes(h))
    || [...(item.resourceIds || []), ...resourcesFor(topology, (item.hosts || [item.host]).filter(Boolean))]
      .some(id => ids.has(id));
  if (state.workloads.some(w => w.admissionId !== parent.admissionId && overlaps(w)))
    throw refusal('Another workload overlaps the original coding owner');
  const children = state.inferences.filter(overlaps);
  if (children.some(c => !allowUnknown || c.state !== 'UNKNOWN' || c.principal !== PRINCIPAL
    || c.workloadAdmissionId !== parent.admissionId || c.workloadGeneration !== parent.generation))
    throw refusal('Active, unknown or unrelated inference authority remains held');
  return { state, parent };
}

async function prepare(pipelineId, requestId, input, { control, readPs } = {}) {
  const { task, attempt } = await evidence(pipelineId, requestId, input, control);
  // Expiry is quarantined by the native owner before a new recovery lease.
  await coordination.listActive();
  const { state, parent } = await runtime(task, requestId, { allowUnknown: true });
  if (!parent || Date.parse(parent.expiresAt) > Date.now() || parent.recoveryRequired !== true)
    throw refusal('Only the original expired, armed coding workload can be adopted');
  if (task.codingCapacity?.admissionId !== parent.admissionId || task.codingCapacity.generation !== parent.generation)
    throw refusal('The original coding capacity proof differs from the native parent');
  const old = task.codingCapacityRecovery;
  const marker = { key: input.key, requestId, admissionId: parent.admissionId, generation: parent.generation,
    attemptFingerprint: digest(attempt), journalFingerprint: journal(task), confirmation: CONFIRMATION };
  marker.fingerprint = digest(marker);
  if (old && old.fingerprint !== marker.fingerprint) throw refusal('Original coding recovery intent changed');
  const fence = { kind: 'coding-capacity', key: marker.key, fingerprint: marker.fingerprint };
  const fenced = await Settings.updateOne({ _id: 'coding-autonomy', enabled: false,
    'active.pipelineId': pipelineId, 'active.requestId': requestId, $or: [
      { 'active.recovery': { $exists: false } }, { 'active.recovery': fence }
    ] }, { $set: { 'active.recovery': fence }, $inc: { revision: 1 } }, { writeConcern: WC });
  if (!fenced.acknowledged || fenced.matchedCount !== 1)
    throw refusal('Native capacity recovery fence acknowledgement is uncertain; reconcile this key');
  if (!old) {
    const snapshot = residents(await readPs(parent.hosts[0]));
    const cap = task.codingCapacity;
    if (parent.hosts.length !== 1 || cap?.host !== parent.hosts[0] || cap.keepAlive !== -1
      || !snapshot.some(m => m.model === cap.model && m.digest === cap.digest && m.context === cap.numCtx))
      throw refusal('The original frozen coding contract does not match runtime residency');
    const saved = await Task.updateOne({ pipelineId, updatedAt: task.updatedAt, automationLease: null,
      codingCapacityRecovery: { $exists: false }, 'codingAutonomy.authorized': false },
    { $set: { codingCapacityRecovery: { ...marker, snapshot, state: 'prepared',
      children: state.inferences.filter(c => c.workloadAdmissionId === parent.admissionId
        && c.workloadGeneration === parent.generation).map(c => ({ id: c.admissionId, generation: c.generation })) } } }, { writeConcern: WC });
    if (!saved.acknowledged || saved.modifiedCount !== 1) throw refusal('Recovery journal acknowledgement is uncertain; reconcile this key');
  }
  // Re-acknowledge even an applied first write whose reply was lost. A read of
  // a prepared marker alone never permits effects under an uncertain write.
  await acknowledge(task, marker);
  const lookup = await coordination.lookupWorkloadRecovery({ principal: PRINCIPAL,
    workloadId: parent.workloadId, recoveryRequestId: `recovery:${requestId}` });
  if (!lookup.found || lookup.admissionId !== parent.admissionId || lookup.generation !== parent.generation)
    throw refusal('Original native recovery identity is unavailable');
  const adopted = await coordination.adoptWorkloadRecovery({ recoveryId: lookup.recoveryId, principal: PRINCIPAL,
    recoveryRequestId: `recovery:${requestId}`, ownerId: `coding-recovery:${input.key}`, ttl: 15 * 60000 });
  if (!adopted.adopted) throw refusal(adopted.reason);
  return { prepared: true, pipelineId, requestId, ...adopted };
}

async function recoverChildren(pipelineId, requestId, input, { control } = {}) {
  const { task } = await evidence(pipelineId, requestId, input, control);
  const marker = task.codingCapacityRecovery;
  const { parent } = await runtime(task, requestId, { allowUnknown: true });
  if (!marker || marker.key !== input.key || marker.requestId !== requestId || !parent
    || parent.admissionId !== marker.admissionId || parent.generation !== marker.generation
    || !(await coordination.assertWorkloadRecovery({ recoveryId: parent.recoveryId,
      recoveryGeneration: parent.recoveryGeneration, principal: PRINCIPAL,
      ownerId: `coding-recovery:${input.key}` })).owned)
    throw refusal('The exact prepared coding recovery must own the runtime restart');
  const recovered = [];
  for (const child of marker.children) {
    const result = await coordination.recoverInferenceAfterRuntimeRestart({ ...child,
      principal: PRINCIPAL, receipt: input.restartReceipt });
    if (!result.recovered) throw refusal(result.reason);
    recovered.push(result);
  }
  return { recovered: true, children: recovered };
}

async function complete(pipelineId, requestId, input, { control, readPs } = {}) {
  const { task, attempt } = await evidence(pipelineId, requestId, input, control);
  const marker = task.codingCapacityRecovery;
  if (!marker || marker.key !== input.key || marker.requestId !== requestId
    || marker.attemptFingerprint !== digest(attempt)
    || marker.journalFingerprint !== journal(task))
    throw refusal('The original native verdict or model history changed');
  const { state, parent } = await runtime(task, requestId);
  const clearFence = async released => {
    const cleared = await Settings.updateOne({ _id: 'coding-autonomy', enabled: false,
      'active.pipelineId': pipelineId, 'active.requestId': requestId,
      'active.recovery.kind': 'coding-capacity', 'active.recovery.fingerprint': marker.fingerprint },
    { $unset: { 'active.recovery': 1 }, $inc: { revision: 1 } }, { writeConcern: WC });
    if (!cleared.acknowledged) throw refusal('Native release is received but fence acknowledgement is uncertain; reconcile this key');
    return released;
  };
  if (!parent) {
    const receipt = state.releaseReceipts.find(r => r.admissionId === marker.admissionId
      && r.generation === marker.generation && r.recoveryReceipt?.fingerprint === marker.fingerprint);
    if (!receipt) throw refusal('The original native release receipt is unavailable');
    return clearFence({ ...receipt, idempotent: true });
  }
  for (const child of marker.children) if (!state.releaseReceipts.some(r => r.admissionId === child.id
    && r.generation === child.generation && r.principal === PRINCIPAL && r.recovered === true
    && r.workloadAdmissionId === marker.admissionId && r.workloadGeneration === marker.generation))
    throw refusal('The original UNKNOWN child needs its durable native recovery receipt');
  const proof = { recoveryId: parent.recoveryId, recoveryGeneration: parent.recoveryGeneration,
    principal: PRINCIPAL, ownerId: `coding-recovery:${input.key}` };
  if (parent.admissionId !== marker.admissionId || parent.generation !== marker.generation
    || !(await coordination.heartbeatWorkloadRecovery({ ...proof, ttl: 15 * 60000 })).heartbeat)
    throw refusal('The exact adopted coding fence is unavailable; reconcile preparation');
  if (digest(residents(await readPs(parent.hosts[0]))) !== digest(marker.snapshot))
    throw refusal('Original persistent residents, context, artifacts or GPU memory usage were not restored');
  const verified = await evidence(pipelineId, requestId, input, control);
  const config = await Settings.findById('coding-autonomy').lean();
  if (verified.task.codingCapacityRecovery?.fingerprint !== marker.fingerprint
    || config.active?.recovery?.fingerprint !== marker.fingerprint
    || config.active.recovery.kind !== 'coding-capacity') throw refusal('Original task or recovery fence changed during verification');
  await acknowledge(verified.task, marker);
  const receipt = { contract: 'agentx.coding-capacity-recovery/v1', ...marker,
    workerTerminated: true, nativeInferencesReleased: true, residencyRestored: true };
  let version = parent.recoveryVersion;
  let phase = parent.recoveryState;
  const next = async target => {
    const result = await coordination.transitionWorkloadRecovery({ ...proof, expectedVersion: version, state: target, receipt });
    if (!result.transitioned) throw refusal(result.reason);
    version = result.recoveryVersion; phase = result.recoveryState;
  };
  if (phase === 'PREPARED') await next('MUTATING');
  if (['MUTATING', 'UNKNOWN'].includes(phase)) await next('VERIFIED');
  if (phase === 'VERIFIED') await next('RESTORED');
  const released = await coordination.resolveWorkloadRecovery(proof);
  if (!released.released) throw refusal(released.reason);
  return clearFence(released);
}

module.exports = { prepare, recoverChildren, complete, residents, CONFIRMATION };
