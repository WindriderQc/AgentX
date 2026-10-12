'use strict';
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('./heavyWorkQueueService');
const policy = require('./pipelineCodingAutonomyPolicy');
const { resourceTopology, resourcesFor, topologyMatches } = require('./runtimePhysicalResources');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = 'coding-autonomy', WC = { w: 1, j: true };
const CONFIRMATION = 'CONTINUE_RECOVERED_CHECKPOINT_WITH_ADDITIONAL_BUDGET';
const CREDITS = ['workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls', 'ciSeconds'];
const PROFILES = ['agentx-dispatcher-tests/v1', 'agentx-core-runner-tests/v1', 'agentx-benchmark-artifact-tests/v1'];
const fail = message => policy.fail(message, 'CODING_CONTINUATION_UNVERIFIED');
const same = (a, b) => a?.key === b.key && a?.fingerprint === b.fingerprint;
function intent(input, requestId) {
  if (input.confirm !== true || input.confirmation !== CONFIRMATION || !UUID.test(requestId)
    || !/^[a-zA-Z0-9:_-]{1,160}$/.test(input.key || '') || !/^[a-f0-9]{40}$/.test(input.head || '')
    || !UUID.test(input.queueRequestId || '') || !PROFILES.includes(input.verificationProfile)
    || !Number.isSafeInteger(input.expectedRevision) || !Number.isSafeInteger(input.additionalRuns)
    || input.additionalRuns < 1 || input.additionalRuns > 3
    || !input.budget || Object.keys(input.budget).length !== CREDITS.length
    || CREDITS.some(key => !Number.isSafeInteger(input.budget[key]) || input.budget[key] < (key === 'workSeconds' ? 10 : 1)
      || input.budget[key] > policy.DEFAULT_LIMITS[key])
    || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000)
    throw policy.fail('Review the exact recovered checkpoint, campaign, credits and additional worker count', 'CODING_CONTINUATION_INVALID', 400);
  const value = { key: input.key, parentRequestId: requestId, head: input.head, queueRequestId: input.queueRequestId,
    verificationProfile: input.verificationProfile, additionalRuns: input.additionalRuns,
    budget: Object.fromEntries(CREDITS.map(key => [key, input.budget[key]])), text: input.text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') };
  return { ...value, fingerprint: policy.digest(value) };
}
async function evidence(task, requestId, wanted, control) {
  policy.assertTask(task);
  const state = task.codingAutonomy, run = state?.runs.at(-1);
  const attempt = task.automationAttempts?.at(-1);
  if (state?.authorized !== false || state.state !== 'stopped' || task.status !== 'blocked'
    || (task.assignee && task.assignee !== 'coding-team') || task.automationLease || task.codingCapacity || state.basis !== policy.basis(task)
    || run?.requestId !== requestId || !run.finishedAt || run.recovery?.state !== 'confirmed'
    || run.recovery.authority !== 'operator-reconciliation' || !run.recovery.releaseVerifiedAt
    || run.recovery.historicalJournalFingerprint !== policy.digest([run.modelReceipts, run.pendingInferences])
    || attempt?.dispatchRequestId !== requestId || run.recovery.nativeAttemptFingerprint !== policy.digest(attempt)
    || task.automationAttemptCount !== attempt.attempt || !control)
    throw fail('Only the exact administratively recovered, released execution can receive a continuation');
  if ((state.budgetGrants || []).length >= 100 || wanted.additionalRuns > task.automation.budgets.maxAttempts - task.automationAttemptCount)
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
  const job = await queue.get(wanted.queueRequestId), now = new Date().toISOString();
  if (job.id !== wanted.queueRequestId || job.id === state.queueRequestId || job.executor?.mode !== 'operator'
    || job.source?.type !== 'coding' || !job.source.ref || job.source.taskId !== task.pipelineId
    || !['dispatching', 'running'].includes(job.state) || !job.hosts?.length || !job.reservation
    || now < job.reservation.start || now >= job.reservation.end || (job.startBefore && now >= job.startBefore))
    throw fail('A new approved active operator campaign must name this same task and coding session');
  const runtime = await Runtime.findById('runtime').lean(), topology = resourceTopology();
  const physical = new Set(resourcesFor(topology, job.hosts.map(hostUrlKey)));
  if (!runtime || !topologyMatches(runtime, topology) || runtime.maintenance
    || [...(runtime.workloads || []), ...(runtime.inferences || [])].some(item => item.requestId === requestId
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
  const grant = { ...wanted, schema: 'agentx.coding-budget-grant/v1', authority: 'operator-continuation', at,
    originalLimits: state.limits, spentBefore: policy.spent(state) };
  const saved = await Task.updateOne({ pipelineId, updatedAt: task.updatedAt, 'codingAutonomy.revision': state.revision,
    'codingAutonomy.authorized': false, status: 'blocked', assignee: task.assignee,
    automationLease: { $exists: false }, codingCapacity: { $exists: false } },
  { $set: { codingAutonomy: { ...state, revision: state.revision + 1, authorized: true, state: 'correction', reason: null,
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
module.exports = { continueRecovered, CONFIRMATION };
