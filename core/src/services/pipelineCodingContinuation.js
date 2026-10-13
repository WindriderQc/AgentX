'use strict';
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('./heavyWorkQueueService');
const policy = require('./pipelineCodingAutonomyPolicy');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');
const { resourceTopology, resourcesFor, topologyMatches } = require('./runtimePhysicalResources');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = 'coding-autonomy', WC = { w: 1, j: true };
const CONFIRMATION = 'CONTINUE_RECOVERED_CHECKPOINT_WITH_ADDITIONAL_BUDGET';
const NATIVE_CONFIRMATION = 'CONTINUE_NATIVE_CHECKPOINT_WITH_ADDITIONAL_BUDGET';
const REVIEWED_CONFIRMATION = 'CONTINUE_TERMINAL_CHECKPOINT_WITH_REVIEWED_ATTEMPT_LIMIT';
const NATIVE_STOPS = new Set(['no_useful_progress', 'model_budget_reserve', 'model_call_limit', 'hard_budget', 'soft_budget_no_progress']);
const REVIEWED_STOPS = new Set([...NATIVE_STOPS, 'worker_exit', 'model_output_limit', 'tests_failed']);
const CREDITS = ['workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls', 'ciSeconds'];
const TOTAL_CEILINGS = Object.freeze(Object.fromEntries(CREDITS.map(key => [key, policy.DEFAULT_LIMITS[key] * 4])));
const PROFILES = ['agentx-dispatcher-tests/v1', 'agentx-core-runner-tests/v1', 'agentx-benchmark-artifact-tests/v1'];
const fail = message => policy.fail(message, 'CODING_CONTINUATION_UNVERIFIED');
const same = (a, b) => a?.key === b.key && a?.fingerprint === b.fingerprint;
function intent(input, requestId) {
  const reviewed = input.confirmation === REVIEWED_CONFIRMATION;
  if (input.confirm !== true || ![CONFIRMATION, NATIVE_CONFIRMATION, REVIEWED_CONFIRMATION].includes(input.confirmation) || !UUID.test(requestId)
    || !/^[a-zA-Z0-9:_-]{1,160}$/.test(input.key || '') || !/^[a-f0-9]{40}$/.test(input.head || '')
    || !UUID.test(input.queueRequestId || '') || !PROFILES.includes(input.verificationProfile)
    || !Number.isSafeInteger(input.expectedRevision) || !Number.isSafeInteger(input.additionalRuns)
    || input.additionalRuns < 1 || input.additionalRuns > 3
    || !input.budget || Object.keys(input.budget).length !== CREDITS.length
    || CREDITS.some(key => !Number.isSafeInteger(input.budget[key]) || input.budget[key] < (key === 'workSeconds' ? 10 : 1)
      || input.budget[key] > policy.DEFAULT_LIMITS[key])
    || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000
    || (reviewed ? !Number.isSafeInteger(input.expectedNativeAttemptLimit) || !Number.isSafeInteger(input.nativeAttemptLimit)
      || !/^[a-f0-9]{64}$/.test(input.expectedAutomationFingerprint || '')
      || input.nativeAttemptLimit < input.expectedNativeAttemptLimit || input.nativeAttemptLimit > 10
      : input.expectedNativeAttemptLimit !== undefined || input.nativeAttemptLimit !== undefined))
    throw policy.fail('Review the exact recovered checkpoint, campaign, credits and additional worker count', 'CODING_CONTINUATION_INVALID', 400);
  const value = { key: input.key, parentRequestId: requestId, head: input.head, queueRequestId: input.queueRequestId,
    ...([NATIVE_CONFIRMATION, REVIEWED_CONFIRMATION].includes(input.confirmation) && { checkpointAuthority: 'native-terminal' }),
    ...(reviewed && { attemptLimit: { before: input.expectedNativeAttemptLimit, after: input.nativeAttemptLimit,
      originalFingerprint: input.expectedAutomationFingerprint } }),
    verificationProfile: input.verificationProfile, additionalRuns: input.additionalRuns,
    budget: Object.fromEntries(CREDITS.map(key => [key, input.budget[key]])), text: input.text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') };
  return { ...value, fingerprint: policy.digest(value) };
}
async function evidence(task, requestId, wanted, control) {
  policy.assertTask(task);
  const state = task.codingAutonomy, run = state?.runs.at(-1);
  const attempt = task.automationAttempts?.at(-1);
  if (state?.authorized !== false || state.state !== 'stopped' || state.disposition || task.status !== 'blocked'
    || (task.assignee && task.assignee !== 'coding-team') || task.automationLease || task.codingCapacity || state.basis !== policy.basis(task)
    || run?.requestId !== requestId || !run.finishedAt || attempt?.dispatchRequestId !== requestId
    || task.automationAttemptCount !== attempt.attempt || !control)
    throw fail('Only the exact stopped, released execution can receive a continuation');
  const native = wanted.checkpointAuthority === 'native-terminal';
  if (!native && (run.recovery?.state !== 'confirmed' || run.recovery.authority !== 'operator-reconciliation'
    || !run.recovery.releaseVerifiedAt || run.recovery.historicalJournalFingerprint !== policy.digest([run.modelReceipts, run.pendingInferences])
    || run.recovery.nativeAttemptFingerprint !== policy.digest(attempt)))
    throw fail('Administrative recovery must retain its confirmed original evidence');
  if (native && (run.recovery || state.pr || run.result !== 'blocked' || run.head !== wanted.head
    || run.pendingInferences?.length || !run.modelReceipts?.length
    || new Set(run.modelReceipts.map(call => call.callId)).size !== run.modelReceipts.length
    || run.modelReceipts.some(call => !UUID.test(call.callId) || call.state !== 'completed'
      || call.settlement?.state !== 'completed' || call.settlement.finishedAt !== call.finishedAt
      || !Number.isFinite(Date.parse(call.startedAt)) || !Number.isFinite(Date.parse(call.finishedAt)))
    || task.automationAttempts.filter(item => item.dispatchRequestId === requestId).length !== 1
    || attempt.attempt !== run.expectedAttemptCount + 1 || attempt.finalState !== 'blocked'
    || !Number.isFinite(Date.parse(attempt.completedAt)) || !/^[a-f0-9]{64}$/.test(attempt.resultRequestFingerprint || '')
    || attempt.evidence?.source !== 'coding-autonomous/v1'))
    throw fail('Native continuation requires an unpublished terminal attempt with every model call completed');
  if (native && state.runs.slice(0, -1).some(old => (old.pendingInferences?.length
    || old.modelReceipts?.some(call => call.state !== 'completed')) && (!old.finishedAt
    || old.recovery?.state !== 'confirmed' || old.recovery.authority !== 'operator-reconciliation'
    || !old.recovery.releaseVerifiedAt
    || old.recovery.historicalJournalFingerprint !== policy.digest([old.modelReceipts, old.pendingInferences])
    || old.recovery.nativeAttemptFingerprint !== policy.digest(task.automationAttempts.find(item => item.dispatchRequestId === old.requestId)))))
    throw fail('Historical unresolved calls retain their original reconciliation barrier');
  const ceiling = wanted.attemptLimit?.after ?? task.automation.budgets.maxAttempts;
  if (wanted.attemptLimit && (wanted.attemptLimit.before !== task.automation.budgets.maxAttempts
    || wanted.attemptLimit.originalFingerprint !== task.automation.fingerprint
    || (ceiling !== wanted.attemptLimit.before && task.planRevision != null)))
    throw fail('Review the current native attempt limit; an existing plan must be explicitly reconciled before amendment');
  if (wanted.attemptLimit && CREDITS.some(key => policy.totalLimits(state)[key] + wanted.budget[key] > TOTAL_CEILINGS[key]))
    throw fail('The cumulative task budget, including every previous grant, exceeds the reviewed continuation ceiling');
  if ((state.budgetGrants || []).length >= 100 || wanted.additionalRuns > ceiling - task.automationAttemptCount)
    throw fail('Additional workers must remain within the original reviewed native attempt ceiling');
  if ((state.budgetGrants || []).some(grant => grant.parentRequestId === requestId))
    throw fail('This recovered execution already received its continuation; reconcile that grant');
  if (wanted.verificationProfile === 'agentx-benchmark-artifact-tests/v1'
    && task.automation.scope.some(path => !/^benchmark\/(src\/services\/benchmark|tests\/unit\/benchmark)\/[^/]+\.(js|cjs)$/.test(path)))
    throw fail('The Benchmark verification profile requires its reviewed service and unit-test scope');
  const host = await control.status({ requestId });
  if (host.busy !== false || host.run?.phase !== 'finished' || host.run.pipelineId !== task.pipelineId
    || host.run.requestId !== requestId || host.run.progress?.phase !== 'finished'
    || host.run.progress.pipelineId !== task.pipelineId || host.run.progress.requestId !== requestId
    || host.run.progress.coreRecorded !== true || host.run.progress.checkpoint !== wanted.head
    || host.run.progress.result !== attempt.finalState)
    throw fail('The exact stopped worker checkpoint must have its native terminal receipt');
  if (native && (host.run.progress.pr || !(wanted.attemptLimit ? REVIEWED_STOPS : NATIVE_STOPS).has(host.run.progress.stopReason)
    || !attempt.evidence.failureCodes?.includes(host.run.progress.stopReason)))
    throw fail('Only a proven native budget or no-progress stop can receive this continuation');
  const previous = await queue.get(state.queueRequestId);
  const job = await queue.get(wanted.queueRequestId), now = new Date().toISOString();
  if (job.id !== wanted.queueRequestId || job.id === state.queueRequestId || job.executor?.mode !== 'operator'
    || (!native && previous.id !== run.recovery.campaignId) || previous.source?.type !== 'coding'
    || job.source?.type !== 'coding' || !job.source.ref || job.source.ref !== previous.source.ref || job.source.taskId !== task.pipelineId
    || !['dispatching', 'running'].includes(job.state) || !job.hosts?.length || !Array.isArray(job.resourceIds) || !job.reservation
    || now < job.reservation.start || now >= job.reservation.end || (job.startBefore && now >= job.startBefore))
    throw fail('A new approved active operator campaign must name this same task and coding session');
  if (native && (previous.state !== 'failed' || !Number.isFinite(Date.parse(previous.finishedAt))
    || previous.source.taskId !== task.pipelineId || previous.releaseReceipt?.authority !== 'operator-attestation'
    || previous.releaseReceipt.confirmation !== 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED'
    || previous.releaseReceipt.operationId !== previous.dispatchId || !previous.dispatchId
    || previous.releaseReceipt.receiptRef !== previous.executor?.receiptRef
    || !/^[a-f0-9]{64}$/.test(previous.releaseReceipt.receiptSha256 || '')))
    throw fail('Close the original failed campaign through its native operator receipt before continuing');
  const runtime = await Runtime.findById('runtime').lean(), topology = resourceTopology();
  const physical = new Set([...(job.resourceIds || []), ...resourcesFor(topology, job.hosts.map(hostUrlKey))]);
  if (!runtime || !topologyMatches(runtime, topology) || runtime.maintenance
    || [...(runtime.workloads || []), ...(runtime.inferences || [])].some(item => item.requestId === requestId || queue.runtimeOverlaps(job, item)
      || (item.resourceIds || []).some(id => physical.has(id))
      || resourcesFor(topology, (item.hosts || [item.host]).filter(Boolean).map(hostUrlKey)).some(id => physical.has(id))))
    throw fail('Native runtime authority remains held; reconcile its original owner first');
  return run;
}
async function release(pipelineId, requestId, wanted) {
  const result = await Settings.updateOne({ _id: ID, enabled: false, 'active.pipelineId': pipelineId,
    'active.requestId': requestId, 'active.recovery.kind': 'coding-continuation',
    'active.recovery.key': wanted.key, 'active.recovery.fingerprint': wanted.fingerprint },
  { $set: { active: null }, $inc: { revision: 1 } }, { writeConcern: WC });
  if (!result.acknowledged) throw fail('Continuation release acknowledgement lost; reconcile this same key');
}
async function continueRecovered(pipelineId, requestId, input, control) {
  const wanted = intent(input, requestId);
  let task = await Task.findOne({ pipelineId }).lean();
  if (!task) throw policy.fail('Task not found', 'NOT_FOUND', 404);
  const prior = (task.codingAutonomy?.budgetGrants || []).find(grant => grant.key === wanted.key);
  if (prior) {
    if (!same(prior, wanted)) throw fail('This key already names a different continuation');
    // Re-acknowledge the same journal without changing credits or old receipts.
    const ack = await Task.updateOne({ pipelineId, 'codingAutonomy.budgetGrants': { $elemMatch: {
      key: wanted.key, fingerprint: wanted.fingerprint } } },
    { $set: { 'codingAutonomy.budgetGrants.$[grant].reacknowledgedAt': new Date().toISOString() } },
    { arrayFilters: [{ 'grant.key': wanted.key }], writeConcern: WC });
    if (!ack.acknowledged || ack.modifiedCount !== 1) throw fail('Continuation acknowledgement remains uncertain');
    await release(pipelineId, requestId, wanted);
    return Task.findOne({ pipelineId }).lean();
  }
  let config = await Settings.findById(ID).lean();
  const own = config?.active?.pipelineId === pipelineId && config.active.requestId === requestId
    && config.active.recovery?.kind === 'coding-continuation' && same(config.active.recovery, wanted);
  if (!config || config.enabled !== false || (config.active && !own)
    || task.codingAutonomy?.revision !== input.expectedRevision)
    throw fail('Pause autonomy, release its active slot and review the current task revision');
  await evidence(task, requestId, wanted, control);
  if (!own) {
    const locked = await Settings.updateOne({ _id: ID, enabled: false, active: null, revision: config.revision },
    { $set: { active: { pipelineId, requestId, recovery: { kind: 'coding-continuation', key: wanted.key,
      fingerprint: wanted.fingerprint } } }, $inc: { revision: 1 } }, { writeConcern: WC });
    if (!locked.acknowledged || locked.modifiedCount !== 1) throw fail('Continuation fence uncertain; reconcile this same key');
  }
  task = await Task.findOne({ pipelineId }).lean();
  await evidence(task, requestId, wanted, control);
  const state = task.codingAutonomy, at = new Date().toISOString();
  const { fingerprint: originalFingerprint, ...originalIntent } = task.automation;
  const automation = wanted.attemptLimit ? normalizePipelineAutomationIntent({ ...originalIntent,
    budgets: { ...originalIntent.budgets, maxAttempts: wanted.attemptLimit.after } }) : task.automation;
  const grant = { ...wanted, schema: 'agentx.coding-budget-grant/v1', authority: 'operator-continuation', at,
    ...(wanted.attemptLimit && { originalAutomation: task.automation, originalBasis: state.basis,
      amendedAutomationFingerprint: automation.fingerprint }),
    originalLimits: state.limits, spentBefore: policy.spent(state) };
  const saved = await Task.updateOne({ pipelineId, updatedAt: task.updatedAt, 'codingAutonomy.revision': state.revision,
    'codingAutonomy.authorized': false, 'automation.fingerprint': originalFingerprint,
    automationAttemptCount: task.automationAttemptCount, planRevision: task.planRevision ?? null, status: 'blocked', assignee: task.assignee,
    automationLease: { $exists: false }, codingCapacity: { $exists: false } },
  { $set: { ...(wanted.attemptLimit && { automation }), codingAutonomy: { ...state,
    basis: policy.basis({ ...task, automation }), revision: state.revision + 1, authorized: true, state: 'correction', reason: null,
    budgetGrants: [...(state.budgetGrants || []), grant], resumeCeiling: state.runs.length - 1 + wanted.additionalRuns,
    progressWindowStartedAtWorkSeconds: policy.spent(state).workSeconds || 0,
    queueRequestId: wanted.queueRequestId, verificationProfile: wanted.verificationProfile,
    correction: { kind: 'operator_continuation', head: wanted.head, text: wanted.text, by: 'operator' },
    manualInterventions: [...state.manualInterventions, { kind: 'additional_budget', at, key: wanted.key, requestId,
      authority: grant.authority }] } } }, { writeConcern: WC });
  if (!saved.acknowledged || saved.modifiedCount !== 1) throw fail('Continuation journal acknowledgement uncertain; reconcile this same key');
  await release(pipelineId, requestId, wanted);
  return Task.findOne({ pipelineId }).lean();
}
module.exports = { continueRecovered, CONFIRMATION, NATIVE_CONFIRMATION, REVIEWED_CONFIRMATION, TOTAL_CEILINGS };
