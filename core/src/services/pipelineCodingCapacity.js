'use strict';

const crypto = require('crypto');
const PipelineTask = require('../../models/PipelineTask');
const coordination = require('./runtimeCoordinationService');
const PRINCIPAL = 'core-trusted-runtime';
const WC = { w: 1, j: true };
let routing;

function conflict(message, code = 'CODING_CAPACITY_CHANGED') {
  return Object.assign(new Error(message), { status: 409, statusCode: 409, code });
}

function selectedIdentity(target) {
  const artifact = target?.inferenceContract?.artifact;
  if (target?.inferenceContract?.qualification?.qualified !== true || !target.model
    || !target.hostUrl || !target.contextSize || !artifact?.digest || !artifact.runtimeFingerprint) {
    throw conflict('The coding lane needs a qualified, exact model and runtime identity.', 'CODING_CAPACITY_UNQUALIFIED');
  }
  return { model: target.model, host: target.hostUrl, numCtx: target.contextSize,
    keepAlive: target.keepAlive ?? null, digest: artifact.digest, runtimeFingerprint: artifact.runtimeFingerprint };
}

function taskBasis(task) {
  return crypto.createHash('sha256').update(JSON.stringify([
    task.title, task.spec, task.automation?.fingerprint, task.planRevision ?? null,
  ])).digest('hex');
}

async function readTarget(taskType) {
  routing ||= require('../extensions/trustedRuntimeServices').createTrustedRuntimeServices().routing;
  return (await routing.getEffectiveSnapshot({ includeCatalog: false, includeArtifactIdentity: true })).tasks[taskType];
}

function assertIdentity(capacity, target) {
  if (JSON.stringify(selectedIdentity(target)) !== JSON.stringify({ model: capacity.model, host: capacity.host,
    numCtx: capacity.numCtx, keepAlive: capacity.keepAlive ?? null, digest: capacity.digest,
    runtimeFingerprint: capacity.runtimeFingerprint })) {
    throw conflict('The selected coding model or runtime changed. Cancel the waiting request before choosing again.');
  }
}

// The task is the queue. Reserve through the same atomic runtime admission as
// other workloads, before the task claim increments its attempt count.
async function reserve(task, { taskType, assignee, requestId, ttl, target } = {}) {
  if (taskType !== 'code_generation') throw conflict('Only the coding lane may reserve coding capacity.');
  target ||= await readTarget(taskType);
  let capacity = task.codingCapacity;
  let observedUpdatedAt = task.updatedAt;
  if (capacity) {
    if (capacity.cancelled) throw conflict('This capacity request was cancelled; inspect its recovery before a new launch.');
    if (capacity.assignee !== assignee || capacity.taskType !== taskType || capacity.basis !== taskBasis(task)
      || (requestId && capacity.requestId !== requestId)) throw conflict('The waiting coding request changed.');
    assertIdentity(capacity, target);
  } else {
    capacity = { ...selectedIdentity(target), taskType, assignee, requestId: requestId || crypto.randomUUID(),
      basis: taskBasis(task), waitingSince: new Date(), admissionState: 'not_requested', reason: 'Waiting for the selected model host.' };
    const saved = await PipelineTask.findOneAndUpdate({ pipelineId: task.pipelineId, status: 'queued', assignee: null,
      updatedAt: task.updatedAt, codingCapacity: { $exists: false } }, { $set: { codingCapacity: capacity } }, { new: true, writeConcern: WC }).lean();
    if (!saved) throw conflict('The task changed before its capacity request was saved.');
    observedUpdatedAt = saved.updatedAt;
  }
  if (task.codingAutonomy) {
    // Check the frozen target before touching native admission on that host.
    const autonomy = require('./pipelineCodingAutonomyService');
    await autonomy.workerManifest(task.pipelineId, requestId);
    await autonomy.campaign(task, capacity.host);
  }
  const workloadId = `coding:${task.pipelineId}:${capacity.requestId}`;
  const acquiring = await PipelineTask.findOneAndUpdate({ pipelineId: task.pipelineId, status: 'queued', assignee: null,
    updatedAt: observedUpdatedAt, 'codingCapacity.requestId': capacity.requestId, 'codingCapacity.cancelled': { $ne: true } },
  { $set: { 'codingCapacity.admissionState': 'acquiring', 'codingCapacity.workloadId': workloadId } }, { new: true, writeConcern: WC }).lean();
  if (!acquiring) throw conflict('The capacity request changed before native admission.');
  const admitted = await coordination.acquireWorkload({ principal: PRINCIPAL, requestId: capacity.requestId,
    workloadId, kind: 'coding', hosts: [capacity.host], ttl });
  if (!admitted.acquired) {
    const reason = admitted.recoveryRequired ? 'The selected host requires recovery; no new execution is allowed.'
      : admitted.reason || 'The selected model host is occupied.';
    await PipelineTask.updateOne({ pipelineId: task.pipelineId, status: 'queued', assignee: null,
      'codingCapacity.requestId': capacity.requestId, 'codingCapacity.cancelled': { $ne: true } },
    { $set: { 'codingCapacity.reason': reason, 'codingCapacity.admissionState': admitted.recoveryRequired ? 'acquiring' : 'waiting' } }, { writeConcern: WC });
    throw conflict(reason, 'CODING_CAPACITY_WAITING');
  }
  const owned = { ...capacity, workloadId, admissionId: admitted.admissionId, generation: admitted.generation,
    admissionState: 'admitted', reason: null };
  const saved = await PipelineTask.findOneAndUpdate({ pipelineId: task.pipelineId, status: 'queued', assignee: null,
    'codingCapacity.requestId': capacity.requestId, 'codingCapacity.cancelled': { $ne: true } },
  { $set: { codingCapacity: owned } }, { new: true, writeConcern: WC }).lean();
  if (!saved) { await release(owned); throw conflict('The task changed after native admission.', 'TASK_UNAVAILABLE'); }
  return { ...owned, observedUpdatedAt: saved.updatedAt };
}

function proof(capacity) {
  return { id: capacity.admissionId, generation: capacity.generation, principal: PRINCIPAL };
}

async function release(capacity) {
  capacity = await recoverCapacity(capacity);
  if (!capacity?.admissionId) return;
  // The atomic release also refuses active/unknown children. A task verdict
  // alone never establishes that an inference stopped.
  const result = await coordination.release('workload', proof(capacity));
  if (!result.released) {
    const prior = await coordination.recoverRelease('workload', proof(capacity));
    if (!prior.released) throw conflict('Coding capacity remains held pending completion or recovery.', 'CODING_CAPACITY_RECOVERY_REQUIRED');
  }
}

async function recoverCapacity(capacity) {
  if (!capacity || capacity.admissionId || ['not_requested', 'waiting'].includes(capacity.admissionState)) return capacity;
  const original = await coordination.recoverWorkloadAcquisition({ principal: PRINCIPAL, requestId: capacity.requestId,
    workloadId: capacity.workloadId, kind: 'coding', hosts: [capacity.host] });
  if (!original.recovered) throw conflict('Original native admission is uncertain; retain this capacity request.', 'CODING_CAPACITY_RECOVERY_REQUIRED');
  return { ...capacity, admissionId: original.admissionId, generation: original.generation, admissionState: 'admitted' };
}

async function heartbeat(capacity, ttl) {
  if (!capacity?.admissionId) return;
  const result = await coordination.heartbeat('workload', { ...proof(capacity), ttl });
  if (!result.heartbeat) throw conflict('Coding capacity authority expired; inspect the existing attempt.', 'CODING_CAPACITY_RECOVERY_REQUIRED');
}

async function cancel(pipelineId, requestId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(String(requestId || ''))) {
    throw conflict('An exact waiting request UUID is required.');
  }
  const task = await PipelineTask.findOneAndUpdate({ pipelineId, status: { $in: ['queued', 'blocked'] }, assignee: null,
    'codingCapacity.requestId': requestId }, { $set: { 'codingCapacity.cancelled': true,
      'codingCapacity.reason': 'Capacity waiting was cancelled.' } }, { new: false, writeConcern: WC }).lean();
  if (!task) throw conflict('Only this queued capacity request can be cancelled.');
  const original = await recoverCapacity({ ...task.codingCapacity, workloadId: `coding:${pipelineId}:${requestId}` });
  if (original.admissionId) await PipelineTask.updateOne({ pipelineId, 'codingCapacity.requestId': requestId,
    'codingCapacity.cancelled': true }, { $set: { codingCapacity: { ...original, cancelled: true } } }, { writeConcern: WC });
  await release(original);
  await PipelineTask.updateOne({ pipelineId, status: { $in: ['queued', 'blocked'] }, assignee: null,
    'codingCapacity.requestId': requestId, 'codingCapacity.cancelled': true }, { $unset: { codingCapacity: 1 } }, { writeConcern: WC });
  return { cancelled: true, pipelineId, requestId };
}

async function authorizeInference(identity, { model, hostUrl, inferenceContract, numCtx } = {}) {
  if (!identity) return null;
  const task = await PipelineTask.findOne({ pipelineId: identity.pipelineId, status: 'in_progress',
    'automationLease.leaseId': identity.leaseId, 'automationLease.expiresAt': { $gt: new Date() } }).lean();
  const capacity = task?.codingCapacity;
  if (!capacity?.admissionId || capacity.model !== model || capacity.host !== hostUrl
    || capacity.numCtx !== numCtx || capacity.digest !== inferenceContract?.artifact?.digest
    || capacity.runtimeFingerprint !== inferenceContract?.artifact?.runtimeFingerprint) {
    throw conflict('Inference does not match the active coding task and its frozen capacity.', 'CODING_CAPACITY_PROOF_INVALID');
  }
  const result = await coordination.assertWorkloadAdmission({ ...proof(capacity), workloadId: capacity.workloadId, host: hostUrl });
  if (!result.admitted) throw conflict(result.reason, 'CODING_CAPACITY_PROOF_INVALID');
  return { principal: PRINCIPAL, workloadAdmissionId: capacity.admissionId, workloadGeneration: capacity.generation };
}

module.exports = { reserve, release, heartbeat, cancel, authorizeInference, assertIdentity, selectedIdentity };
