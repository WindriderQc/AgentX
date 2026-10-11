'use strict';
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('./heavyWorkQueueService');
const policy = require('./pipelineCodingAutonomyPolicy');
const { resourceTopology, resourcesFor, topologyMatches } = require('./runtimePhysicalResources');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const WC = { w: 1, j: true };
const ID = 'coding-autonomy';
const CONFIRMATION = 'ORIGINAL_WORKER_TERMINATED_AND_NATIVE_AUTHORITY_RELEASED';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = message => policy.fail(message, 'CODING_RECOVERY_UNVERIFIED');
const unacknowledged = () => policy.fail('Recovery acknowledgement is uncertain; reconcile this same recovery identity', 'CODING_RECOVERY_ACKNOWLEDGEMENT_UNKNOWN', 503);

function intent(input) {
  if (input.confirmation !== CONFIRMATION || input.confirm !== true
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || typeof input.key !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(input.key)
    || typeof input.receiptRef !== 'string' || !input.receiptRef.trim() || input.receiptRef.length > 500
    || !/^[a-f0-9]{64}$/.test(input.receiptSha256 || '')
    || !Array.isArray(input.callIds) || !input.callIds.length || input.callIds.length > 128
    || input.callIds.some(id => typeof id !== 'string' || !UUID.test(id))
    || new Set(input.callIds).size !== input.callIds.length)
    throw policy.fail('Confirm the exact stopped execution, unresolved calls and received campaign receipt', 'CODING_RECOVERY_INVALID', 400);
  const value = { key: input.key, confirmation: input.confirmation, callIds: [...input.callIds].sort(),
    receiptRef: input.receiptRef, receiptSha256: input.receiptSha256 };
  return { ...value, fingerprint: policy.digest(value) };
}
const matches = (receipt, wanted) => receipt?.key === wanted.key && receipt?.fingerprint === wanted.fingerprint;
const campaignFingerprint = job => policy.digest([job.id, job.dispatchId, job.finishedAt,
  job.releaseReceipt, job.hosts, job.resourceIds, job.source, job.operation]);
function assertRecordedProof(run, proof) {
  if (run.recovery.historicalJournalFingerprint !== policy.digest([run.modelReceipts, run.pendingInferences])
    || run.recovery.nativeAttemptFingerprint !== policy.digest(proof.attempt)
    || run.recovery.campaignFingerprint !== campaignFingerprint(proof.job))
    throw fail('The original recovery evidence changed; retain its recovery fence');
}

async function releaseConfirmed(task, config, control) {
  task = await Task.findOne({ pipelineId: task.pipelineId }).lean();
  config = await Settings.findById(ID).lean();
  const run = task.codingAutonomy?.runs.at(-1);
  const marker = config.active?.recovery;
  if (!marker || !matches(run?.recovery, marker) || run.recovery.state !== 'confirmed'
    || run.recovery.authority !== 'operator-reconciliation'
    || run.recovery.historicalJournalFingerprint !== policy.digest([run.modelReceipts, run.pendingInferences])
    || !run.finishedAt || task.codingAutonomy.authorized !== false || task.automationLease || task.codingCapacity) return false;
  const proof = await evidence(task, run.requestId, run.recovery, control);
  assertRecordedProof(run, proof);
  const verified = await Task.updateOne({ pipelineId: task.pipelineId, updatedAt: task.updatedAt,
    'codingAutonomy.authorized': false, automationLease: { $exists: false }, codingCapacity: { $exists: false },
    'codingAutonomy.runs': { $elemMatch: { requestId: run.requestId, 'recovery.state': 'confirmed',
      'recovery.key': marker.key, 'recovery.fingerprint': marker.fingerprint,
      modelReceipts: run.modelReceipts, pendingInferences: run.pendingInferences } } },
  { $set: { 'codingAutonomy.runs.$[run].recovery.releaseVerifiedAt': new Date().toISOString() },
    $inc: { 'codingAutonomy.revision': 1 } }, { arrayFilters: [{ 'run.requestId': run.requestId }], writeConcern: WC });
  if (!verified.acknowledged) throw unacknowledged();
  if (verified.modifiedCount !== 1) throw fail('The task changed before release verification; retain its recovery fence');
  const result = await Settings.updateOne({ _id: ID, enabled: false,
    'active.pipelineId': task.pipelineId, 'active.requestId': run.requestId,
    'active.recovery.key': marker.key, 'active.recovery.fingerprint': marker.fingerprint },
  { $set: { active: null }, $inc: { revision: 1 } }, { writeConcern: WC });
  if (!result.acknowledged) throw unacknowledged();
  if (!result.modifiedCount) {
    const latest = await Settings.findById(ID).lean();
    if (latest.active?.pipelineId === task.pipelineId && latest.active?.requestId === run.requestId)
      throw fail('The original recovery slot changed; retain its fence');
  }
  return true;
}

async function evidence(task, requestId, wanted, control) {
  policy.assertTask(task);
  const state = task.codingAutonomy;
  const run = state?.runs.at(-1);
  if (!run || run.requestId !== requestId || state.authorized !== false || task.automationLease || task.codingCapacity
    || !['blocked', 'review'].includes(task.status)
    || !['blocked', 'stopping', 'stop_requested', 'stopped'].includes(state.state))
    throw fail('The exact execution must be stopped, unauthorized and free of its native task claim');
  if (policy.digest([...(run.pendingInferences || [])].sort()) !== policy.digest(wanted.callIds)
    || wanted.callIds.some(id => !(run.modelReceipts || []).some(call => call.callId === id && ['unknown', 'pending'].includes(call.state))))
    throw fail('The recovery must cover exactly the original unresolved model receipts');
  const attempts = (task.automationAttempts || []).filter(item => item.dispatchRequestId === requestId);
  const attempt = attempts[0];
  if (attempts.length !== 1 || attempt.assignee !== 'coding-team' || !attempt.completedAt
    || !Number.isFinite(Date.parse(attempt.completedAt)) || attempt.attempt !== run.expectedAttemptCount + 1
    || task.automationAttemptCount !== attempt.attempt || task.automationAttempts.at(-1).dispatchRequestId !== requestId
    || !['blocked', 'review'].includes(attempt.finalState) || !/^[a-f0-9]{64}$/.test(attempt.resultRequestFingerprint || ''))
    throw fail('The original native worker verdict has not been durably received');
  if (!control) throw fail('The native coding owner is unavailable');
  const host = await control.status({ requestId });
  const progress = host.run?.progress;
  if (host.busy !== false || host.run?.phase !== 'finished' || host.run.pipelineId !== task.pipelineId
    || host.run.requestId !== requestId || progress?.pipelineId !== task.pipelineId || progress.requestId !== requestId
    || progress.phase !== 'finished' || progress.coreRecorded !== true || progress.result !== attempt.finalState)
    throw fail('The exact native worker has no verified terminal receipt');
  const job = await queue.get(state.queueRequestId);
  const receipt = job.releaseReceipt;
  if (job.id !== state.queueRequestId || !['completed', 'failed', 'cancelled'].includes(job.state) || job.source?.type !== 'coding'
    || !job.source.ref || (job.source.taskId ? job.source.taskId !== task.pipelineId
      : !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(job.source.issueUrl || ''))
    || job.executor?.mode !== 'operator' || !job.hosts?.length
    || !Array.isArray(job.resourceIds) || !job.dispatchId || job.operation?.id !== job.dispatchId
    || receipt?.authority !== 'operator-attestation' || receipt.operationId !== job.dispatchId
    || receipt.confirmation !== 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED'
    || receipt.receiptRef !== wanted.receiptRef || receipt.receiptRef !== job.executor.receiptRef
    || receipt.receiptSha256 !== wanted.receiptSha256
    || !Number.isFinite(Date.parse(job.finishedAt)) || Date.parse(job.finishedAt) < Date.parse(attempt.completedAt))
    throw fail('The original campaign needs its received operator termination and runtime release attestation');
  // Read raw authority, including quarantines. Never reap, recover or delete it.
  const runtime = await Runtime.findById('runtime').lean();
  const topology = resourceTopology();
  const physical = new Set([...job.resourceIds, ...resourcesFor(topology, job.hosts.map(hostUrlKey))]);
  const overlaps = item => queue.runtimeOverlaps(job, item) ||
    resourcesFor(topology, (item.hosts || [item.host]).filter(Boolean).map(hostUrlKey)).some(id => physical.has(id));
  if (!runtime || !topologyMatches(runtime, topology) || runtime.maintenance || [...(runtime.workloads || []), ...(runtime.inferences || [])]
    .some(item => item.requestId === requestId || overlaps(item)))
    throw fail('Native runtime authority remains held; reconcile through its owner first');
  return { run, attempt, progress, job };
}

function conservativeUsage(run, progress, attempt) {
  const reported = {};
  for (const key of ['workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls']) {
    const values = [run.currentUsage?.[key], progress.usage?.[key]];
    reported[key] = Math.max(0, ...values.filter(value => Number.isSafeInteger(value) && value >= 0));
  }
  reported.workSeconds = Math.max(reported.workSeconds,
    Math.ceil(Math.max(0, Date.parse(attempt.completedAt) - Date.parse(run.startedAt)) / 1000),
    Math.ceil((attempt.evidence?.usage?.durationMs || 0) / 1000));
  return policy.usage(run, reported);
}

async function recover(pipelineId, requestId, input, control) {
  if (!/^\d{4}$/.test(pipelineId) || !UUID.test(requestId))
    throw policy.fail('Exact coding task and request IDs are required', 'CODING_RECOVERY_INVALID', 400);
  const wanted = intent(input);
  let task = await Task.findOne({ pipelineId }).lean();
  if (!task) throw policy.fail('Task not found', 'NOT_FOUND', 404);
  let config = await Settings.findById(ID).lean();
  let run = task.codingAutonomy?.runs.at(-1);
  if (run?.recovery && !matches(run.recovery, wanted)) throw fail('This execution already owns a different recovery identity or receipt');
  if (run?.requestId === requestId && run.recovery?.state === 'confirmed') {
    const released = await releaseConfirmed(task, config, control);
    if (!released && config.active?.pipelineId === pipelineId && config.active.requestId === requestId)
      throw fail('The confirmed recovery still owns its fence; reconcile this same identity');
    return { task: await Task.findOne({ pipelineId }).lean(), alreadyRecovered: true };
  }
  if (!config || config.enabled !== false || config.active?.pipelineId !== pipelineId || config.active?.requestId !== requestId
    || (config.active.recovery && !matches(config.active.recovery, wanted)))
    throw fail('Pause autonomy and retain the exact original active slot before recovery');
  if (!run?.recovery && input.expectedRevision !== task.codingAutonomy?.revision)
    throw fail('The task changed; refresh this same recovery identity');
  const proof = await evidence(task, requestId, wanted, control);
  if (run.recovery) assertRecordedProof(run, proof);
  if (!config.active.recovery) {
    const locked = await Settings.updateOne({ _id: ID, enabled: false, revision: config.revision,
      'active.pipelineId': pipelineId, 'active.requestId': requestId, 'active.recovery': { $exists: false } },
    { $set: { 'active.recovery': { key: wanted.key, fingerprint: wanted.fingerprint } }, $inc: { revision: 1 } }, { writeConcern: WC });
    if (!locked.acknowledged) throw unacknowledged();
    if (locked.modifiedCount !== 1) throw fail('The recovery slot changed; refresh this same identity');
  }
  config = await Settings.findById(ID).lean();
  if (config.enabled !== false || !matches(config.active?.recovery, wanted)
    || config.active.pipelineId !== pipelineId || config.active.requestId !== requestId)
    throw fail('The original recovery fence is not owned');
  const state = task.codingAutonomy;
  let result;
  if (!run.recovery) {
    const at = new Date().toISOString();
    const recovery = { ...wanted, schema: 'agentx.coding-recovery/v1', state: 'prepared',
      authority: 'operator-reconciliation', actor: 'operator', resolvedAt: at,
      campaignId: state.queueRequestId, dispatchId: proof.job.dispatchId,
      campaignRelease: proof.job.releaseReceipt, nativeVerdictFingerprint: proof.attempt.resultRequestFingerprint,
      nativeAttemptFingerprint: policy.digest(proof.attempt), campaignFingerprint: campaignFingerprint(proof.job),
      historicalJournalFingerprint: policy.digest([run.modelReceipts, run.pendingInferences]) };
    const closed = { ...run, recovery, finishedAt: at, result: proof.progress.result };
    closed.usage = conservativeUsage(closed, proof.progress, proof.attempt);
    const spent = policy.spent(state);
    for (const [key, amount] of Object.entries(closed.usage)) spent[key] = (spent[key] || 0) + amount;
    result = await Task.updateOne({ pipelineId, updatedAt: task.updatedAt, status: task.status, 'codingAutonomy.revision': state.revision,
      'codingAutonomy.authorized': false, automationLease: { $exists: false }, codingCapacity: { $exists: false },
      'codingAutonomy.runs': { $elemMatch: { requestId, modelReceipts: run.modelReceipts, pendingInferences: run.pendingInferences } },
      automationAttempts: { $elemMatch: { dispatchRequestId: requestId, resultRequestFingerprint: proof.attempt.resultRequestFingerprint } } },
    { $set: { codingAutonomy: { ...state, revision: state.revision + 1, authorized: false, state: 'stopped',
      reason: 'operator_reconciled_native_completion', spent,
      runs: [...state.runs.slice(0, -1), closed], manualInterventions: [...state.manualInterventions,
        { kind: 'native_completion_reconciliation', at, requestId, key: wanted.key, authority: recovery.authority }] } } }, { writeConcern: WC });
  } else {
    // Re-acknowledge the same prepared journal after a lost response. Usage and
    // historical receipts are immutable; no replacement attempt is permitted.
    result = await Task.updateOne({ pipelineId, updatedAt: task.updatedAt, status: task.status,
      automationLease: { $exists: false }, codingCapacity: { $exists: false }, 'codingAutonomy.revision': state.revision,
      'codingAutonomy.authorized': false, 'codingAutonomy.runs': { $elemMatch: { requestId,
        'recovery.key': wanted.key, 'recovery.fingerprint': wanted.fingerprint, 'recovery.state': 'prepared',
        modelReceipts: run.modelReceipts, pendingInferences: run.pendingInferences } } },
    { $set: { 'codingAutonomy.runs.$[run].recovery.reacknowledgedAt': new Date().toISOString() },
      $inc: { 'codingAutonomy.revision': 1 } }, { arrayFilters: [{ 'run.requestId': requestId }], writeConcern: WC });
  }
  if (!result.acknowledged) throw unacknowledged();
  if (result.modifiedCount !== 1) throw fail('The task changed before recovery was durably received; retain this recovery fence');
  task = await Task.findOne({ pipelineId }).lean();
  run = task.codingAutonomy.runs.at(-1);
  const freshProof = await evidence(task, requestId, wanted, control);
  assertRecordedProof(run, freshProof);
  const confirmed = await Task.updateOne({ pipelineId, 'codingAutonomy.authorized': false,
    updatedAt: task.updatedAt, 'codingAutonomy.revision': task.codingAutonomy.revision,
    automationLease: { $exists: false }, codingCapacity: { $exists: false },
    'codingAutonomy.runs': { $elemMatch: { requestId, 'recovery.key': wanted.key,
      'recovery.fingerprint': wanted.fingerprint, 'recovery.state': 'prepared',
      modelReceipts: run.modelReceipts, pendingInferences: run.pendingInferences } } },
  { $set: { 'codingAutonomy.runs.$[run].recovery.state': 'confirmed' }, $inc: { 'codingAutonomy.revision': 1 } },
  { arrayFilters: [{ 'run.requestId': requestId }], writeConcern: WC });
  if (!confirmed.acknowledged) throw unacknowledged();
  task = await Task.findOne({ pipelineId }).lean();
  if (!matches(task.codingAutonomy?.runs.at(-1)?.recovery, wanted)
    || task.codingAutonomy.runs.at(-1).recovery.state !== 'confirmed') throw fail('The recovery confirmation is not durable');
  if (!await releaseConfirmed(task, config, control)) throw fail('The confirmed recovery still owns its fence; reconcile this same identity');
  return { task: await Task.findOne({ pipelineId }).lean(), alreadyRecovered: false };
}
module.exports = { recover, releaseConfirmed, CONFIRMATION };
