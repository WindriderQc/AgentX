'use strict';
const { randomUUID } = require('node:crypto');
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const policy = require('./pipelineCodingAutonomyPolicy');
const { taskEligibilityReasons } = require('./pipelineTaskEligibility');
const { loadDependencyStatuses } = require('./pipelineTaskService');
const { recordTransition, buildTransition } = require('./pipelineTaskTransitions');
const WC = { w: 1, j: true };
const OBSERVATION_MS = 30000;
const ID = 'coding-autonomy';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
let control;
let ticking = false;
const terminal = new Set(['ready_for_review', 'blocked', 'stopped', 'closed']);
function configureControl(value) { control = value; }
async function settings() {
  try { await Settings.updateOne({ _id: ID }, { $setOnInsert: { enabled: false, revision: 0, active: null } }, { upsert: true, writeConcern: WC }); }
  catch (error) { if (error.code !== 11000) throw error; }
  return Settings.findById(ID).lean();
}
async function readTask(id) {
  const task = await Task.findOne({ pipelineId: id }).lean();
  if (!task) throw policy.fail('Task not found', 'NOT_FOUND', 404);
  return task;
}
async function save(task, state, extra = {}, transition, guard = {}) {
  const query = { ...guard, pipelineId: task.pipelineId, 'codingAutonomy.revision': task.codingAutonomy?.revision ?? null };
  const update = { $set: { codingAutonomy: { ...state, revision: (task.codingAutonomy?.revision || 0) + 1 }, ...extra } };
  if (transition) recordTransition(query, update, task, buildTransition(task, transition));
  const saved = await Task.findOneAndUpdate(query, update, { new: true, writeConcern: WC }).lean();
  if (!saved) throw policy.fail('Autonomy state changed; refresh the same request');
  return saved;
}
async function configure(input) {
  if (input.confirm !== true || typeof input.enabled !== 'boolean' || !Number.isInteger(input.expectedRevision))
    throw policy.fail('Confirm the switch and current revision', 'CODING_AUTONOMY_INVALID', 400);
  const current = await settings();
  if (input.enabled && (!control || control.target === '')) throw policy.fail('Coding runner is unavailable');
  if (input.enabled && current.active?.recovery) throw policy.fail('Reconcile the original recovery identity before enabling autonomy');
  const saved = await Settings.findOneAndUpdate({ _id: ID, revision: input.expectedRevision,
    ...(input.enabled && { 'active.recovery': { $exists: false } }) },
    { $set: { enabled: input.enabled, actor: 'operator' }, $inc: { revision: 1 } }, { new: true, writeConcern: WC }).lean();
  if (!saved) throw policy.fail('The autonomy switch changed');
  return { ...saved, previousEnabled: current.enabled };
}
async function authorize(id, input) {
  const task = await readTask(id);
  if (input.confirm !== true || typeof input.authorized !== 'boolean') throw policy.fail('Explicit task authorization required', 'CODING_AUTONOMY_INVALID', 400);
  const extra = {};
  if (input.authorized && !task.automation && input.scope) {
    if (task.service !== 'agentx-coding' || !require('../helpers/workerTaskScope').contains(task)
      || task.assignee || task.automationAttemptCount || input.lowRisk !== true)
      throw policy.fail('Review the exact scope of an unowned low-risk engineering task');
    const bounded = policy.limits(input.limits);
    const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');
    task.automation = normalizePipelineAutomationIntent({ schema: 'agentx.pipeline-automation/v1', mode: 'review_only',
      policyRef: 'agentx.coding-autonomy/v1', dataClassification: 'public', operations: ['create', 'update', 'delete'],
      scope: input.scope, sourceFiles: input.scope, lockKeys: input.scope.map(p => `file:${p}`),
      executionProfile: 'coding-sandbox/v1', verificationProfile: input.verificationProfile,
      budgets: { maxDurationMs: bounded.workSeconds * 1000, maxAttempts: bounded.maxResumes + 1, maxCostNanodollars: 0 },
      humanGates: ['review', 'merge', 'deploy', 'protected_change'] });
    task.risk = 'low';
    Object.assign(extra, { automation: task.automation, risk: task.risk });
  }
  if (input.authorized) {
    policy.assertTask(task);
    if (input.scope && policy.digest([...input.scope].sort()) !== policy.digest([...task.automation.scope].sort()))
      throw policy.fail('Authorization scope differs from the reviewed task intent');
    if (input.verificationProfile && input.verificationProfile !== task.automation.verificationProfile)
      throw policy.fail('Verification differs from the reviewed task intent');
    if (!['agentx-dispatcher-tests/v1', 'agentx-core-runner-tests/v1', 'agentx-benchmark-artifact-tests/v1'].includes(task.automation.verificationProfile))
      throw policy.fail('Select an installed independent verification profile');
  }
  if (input.expectedRevision !== (task.codingAutonomy?.revision || 0)) throw policy.fail('Task authorization changed');
  if (input.authorized && (!['queued', 'blocked'].includes(task.status) || task.assignee || task.automationLease)) throw policy.fail('Task is already owned or awaiting review');
  const existing = task.codingAutonomy;
  if (!existing && !input.authorized) throw policy.fail('Task has no autonomous authorization');
  if (!existing && await Task.countDocuments({ codingAutonomy: { $exists: true } }) >= 100)
    throw policy.fail('Autonomy scope is full; preserve its existing history');
  if (existing?.runs?.length && input.authorized) throw policy.fail('Completed/stopped campaigns cannot be reset; reconcile their original evidence');
  if (input.authorized && !UUID.test(input.queueRequestId || '')) throw policy.fail('Name the approved heavy-work campaign', 'CODING_AUTONOMY_INVALID', 400);
  const state = existing || { schema: 'agentx.pipeline-coding-autonomy/v1', revision: 0, runs: [], spent: {},
    observations: [], seenDiagnostics: [], seenStates: [], seenTests: [], manualInterventions: [] };
  if (!input.authorized) state.spent = ciSpent(state);
  Object.assign(state, { authorized: input.authorized, authorizedAt: state.authorizedAt || new Date().toISOString(),
    state: input.authorized ? 'queued' : 'stopped', reason: input.authorized ? null : 'authorization_removed' });
  if (input.authorized) Object.assign(state, { basis: policy.basis(task), limits: policy.limits(input.limits), queueRequestId: input.queueRequestId });
  // Removing authorization fences future resumes. An active worker is separately stopped.
  return projection(await save(task, state, extra));
}
function failedCIWatch(state) {
  return state.authorized && state.correction?.kind === 'failure'
    && (state.state === 'correction' || (state.state === 'blocked' && state.reason === 'resume_limit'));
}
function ciWatchStart(state, now = Date.now()) {
  // Legacy failure transitions charged the original wait and saved now+30s,
  // but retained ciStartedAt. Recover that accounting cursor once; never reset
  // the already charged seconds or infer model completion from this timestamp.
  const start = state.ciWatchStartedAt ? Date.parse(state.ciWatchStartedAt)
    : Date.parse(state.nextObservationAt) - OBSERVATION_MS;
  const original = Date.parse(state.ciStartedAt);
  if (!Number.isFinite(start) || !Number.isFinite(original) || start < original || start > now)
    throw policy.fail('CI accounting cursor requires reconciliation', 'CODING_AUTONOMY_CI_CURSOR');
  return new Date(start).toISOString();
}
function ciElapsed(state, now = Date.now()) {
  return Math.max(0, Math.floor((now - Date.parse(failedCIWatch(state)
    ? ciWatchStart(state, now) : state.ciStartedAt)) / 1000));
}
function ciSpent(state) {
  return { ...policy.spent(state), ciSeconds: (state.spent.ciSeconds || 0) +
    (state.state === 'waiting_ci' || failedCIWatch(state) ? ciElapsed(state) : 0) };
}
function projection(task) {
  const state = task.codingAutonomy;
  const remaining = policy.remaining(task);
  const last = state.runs.at(-1);
  const currentUsage = last && policy.usage(last, last.currentUsage);
  if (last && !last.finishedAt) for (const key of ['workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls'])
    remaining[key] = Math.max(0, remaining[key] - (currentUsage[key] || 0));
  if (state.state === 'waiting_ci' || failedCIWatch(state)) remaining.ciSeconds = Math.max(0, policy.totalLimits(state).ciSeconds - ciSpent(state).ciSeconds);
  return { pipelineId: task.pipelineId, title: task.title, taskStatus: task.status,
    nativeAttemptCount: task.automationAttemptCount || 0, nativeAttemptLimit: task.automation.budgets.maxAttempts,
    automationFingerprint: task.automation.fingerprint,
    failureCodes: task.automationAttempts?.at(-1)?.evidence?.failureCodes || [],
    disposition: state.disposition || null, delivery: state.delivery || null,
    continuationAborts: state.continuationAborts || [],
    ciObservationActive: Boolean(state.pr && last?.finishedAt && !task.automationLease && !task.codingCapacity
      && ['review', 'blocked'].includes(task.status) && (state.state === 'waiting_ci' || failedCIWatch(state))),
    scope: task.automation.scope, verificationProfile: state.verificationProfile || task.automation.verificationProfile,
    queueRequestId: state.queueRequestId, limits: state.limits, totalLimits: policy.totalLimits(state), budgetGrants: state.budgetGrants || [],
    authorizationRevision: state.revision, authorized: state.authorized, state: state.state, reason: state.reason,
    resumes: Math.max(0, state.runs.length - 1), remaining, pr: state.pr || null,
    lastUsefulProgressAt: state.lastUsefulProgressAt || null, manualInterventions: state.manualInterventions,
    runs: state.runs.map(({ leaseId, pendingInferences, ...run }) => ({ ...run,
      pendingInferenceCount: run.recovery?.state === 'confirmed' ? 0 : (pendingInferences || []).length,
      historicalPendingInferenceCount: (pendingInferences || []).length,
      unresolvedCallIds: run.recovery?.state === 'confirmed' ? [] : [...(pendingInferences || [])] })),
    observations: state.observations.slice(-8),
    nextAction: state.state === 'ready_for_review' ? 'Human review; merge, installation and product acceptance remain separate'
      : state.reason || (state.state === 'waiting_ci' ? 'Observe the exact published commit without calling a model' : state.state) };
}
async function status() {
  const config = await settings();
  const tasks = await Task.find({ codingAutonomy: { $exists: true } }).sort({ pipelineId: 1 }).limit(100).lean();
  return { schema: 'agentx.pipeline-coding-autonomy-status/v1', enabled: config.enabled,
    revision: config.revision, active: config.active, tasks: tasks.map(projection) };
}
async function recover(id, requestId, input) {
  const result = await require('./pipelineCodingAutonomyRecovery').recover(id, requestId, input, control);
  return { ...projection(result.task), alreadyRecovered: result.alreadyRecovered };
}
async function continueRecovered(id, requestId, input) {
  const task = await require('./pipelineCodingContinuation').continueRecovered(id, requestId, input, control);
  return projection(task);
}
async function campaign(task, host) {
  const job = await require('./heavyWorkQueueService').get(task.codingAutonomy.queueRequestId);
  const now = new Date().toISOString();
  if (!['dispatching', 'running'].includes(job.state) || job.executor?.mode !== 'operator' || job.source?.type !== 'coding'
    || !job.source.ref || !job.reservation || now < job.reservation.start || now >= job.reservation.end
    || (job.startBefore && now >= job.startBefore) || (host && !job.hosts.includes(host.replace(/\/+$/, ''))))
    throw policy.fail('The approved coding campaign is not within its active queue window', 'CODING_AUTONOMY_QUEUE_WAIT');
  return job;
}
async function workerManifest(id, requestId) {
  const task = await readTask(id);
  const state = task.codingAutonomy;
  const run = state?.runs.at(-1);
  const config = await settings();
  policy.assertTask(task);
  if (!state?.authorized || terminal.has(state.state) || run?.requestId !== requestId || !config.active
    || config.active.requestId !== requestId || state.basis !== policy.basis(task)) throw policy.fail('This execution no longer has task authority');
  const job = await campaign(task, task.codingCapacity?.host);
  return { queueEndAt: job.reservation.end, pipelineId: id, requestId, parentRequestId: run.parentRequestId, remaining: policy.remaining(task),
    limits: { ...state.limits, maxResumes: policy.totalLimits(state).maxResumes }, verificationProfile: state.verificationProfile || task.automation.verificationProfile, spent: policy.spent(state), lastUsefulWorkSeconds: state.lastUsefulWorkSeconds || 0,
    progressWindowStartedAtWorkSeconds: state.progressWindowStartedAtWorkSeconds || 0,
    continuationCheckpoint: (state.budgetGrants || []).find(grant => grant.parentRequestId === run.parentRequestId)?.head || null,
    seenStates: state.seenStates, seenTests: state.seenTests, pr: state.pr || null,
    scope: task.automation.scope, correction: state.correction || null, queueRequestId: state.queueRequestId };
}
async function clearActive(requestId) {
  await Settings.updateOne({ _id: ID, 'active.requestId': requestId, 'active.recovery': { $exists: false } },
    { $set: { active: null } }, { writeConcern: WC });
}
async function block(task, reason, guard = {}) {
  const state = { ...task.codingAutonomy, spent: ciSpent(task.codingAutonomy), state: 'blocked', reason,
    ...(failedCIWatch(task.codingAutonomy) && { ciWatchStartedAt: new Date().toISOString() }) };
  const saved = await save(task, state, {}, undefined, guard);
  // An unconfirmed worker/model stays held in the active slot for reconciliation.
  if (state.runs.at(-1)?.finishedAt) await clearActive(state.runs.at(-1).requestId);
  return saved;
}
async function recordReview(id, input) {
  let task = await readTask(id);
  const state = task.codingAutonomy;
  if (input.confirm !== true || !state?.pr || input.head !== state.pr.head || task.status !== 'review'
    || state.delivery?.state === 'closed' || state.delivery?.merged
    || !state.runs.at(-1)?.finishedAt || task.automationLease || task.codingCapacity || !control
    || !['waiting_ci', 'ready_for_review'].includes(state.state) || !input.text?.trim() || input.text.length > 4000)
    throw policy.fail('Review feedback must name the current PR commit and a completed worker');
  let observation;
  const currentRun = state.runs.at(-1);
  try { observation = await control.observe({ pipelineId: id, requestId: currentRun.requestId, pr: state.pr,
    ...(currentRun.executorId && { executorId: currentRun.executorId }) }); }
  catch { throw policy.fail('The current PR cannot be verified; retain this review without starting a correction'); }
  if (observation.state !== 'open' || observation.merged || observation.head !== state.pr.head)
    throw policy.fail('The PR was closed or its head changed; reconcile its current delivery before requesting a correction');
  const guard = { updatedAt: task.updatedAt, status: 'review', assignee: task.assignee ?? null,
    automationLease: null, codingCapacity: null, 'codingAutonomy.pr.head': state.pr.head };
  const message = input.text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  // Human review is labelled data; it is never interpreted as runner commands.
  const correction = { kind: 'human_review', head: input.head, text: message, by: 'operator' };
  task = await save(task, { ...state, spent: ciSpent(state), correction, state: 'correction', reason: null,
    manualInterventions: [...state.manualInterventions, { kind: 'review_feedback', at: new Date().toISOString(), head: input.head }] }, {}, undefined, guard);
  return projection(task);
}
async function stop(id, requestId, input = {}) {
  const task = await readTask(id);
  const state = task.codingAutonomy;
  if (input.confirm !== true || state?.runs.at(-1)?.requestId !== requestId) throw policy.fail('Confirm this exact task and execution');
  if (state.state === 'stopped') return projection(task);
  const waiting = ['waiting_ci', 'correction', 'ready_for_review'].includes(state.state);
  // Persist the stop intent before a potentially lost host response. It fences
  // every scheduler; host acceptance still shares its lock with publication.
  let saved = await save(task, { ...state, spent: ciSpent(state), authorized: false, state: 'stop_requested', reason: 'operator_stop' });
  if (!waiting) {
    try { await control.stop({ pipelineId: id, requestId, confirm: true,
      ...(state.runs.at(-1).executorId && { executorId: state.runs.at(-1).executorId }) }); }
    catch (error) {
      if (error.code === 'CODING_DISPATCH_STOP_TOO_LATE') {
        const latest = await readTask(id);
        await save(latest, { ...latest.codingAutonomy, reason: 'stop_too_late_publication',
          manualInterventions: [...latest.codingAutonomy.manualInterventions, { kind: 'stop_refused_publication', at: new Date().toISOString() }] });
        throw error;
      }
      if (error.code !== 'CODING_DISPATCH_OUTCOME_UNKNOWN') throw error; return projection(saved);
    }
  }
  saved = await readTask(id);
  saved = await save(saved, { ...saved.codingAutonomy, state: waiting ? 'stopped' : 'stopping', reason: 'operator_stop' });
  if (waiting) await clearActive(requestId);
  return projection(saved);
}
async function select(config) {
  const tasks = await Task.find({ 'codingAutonomy.authorized': true,
    'codingAutonomy.state': { $in: ['queued', 'correction'] } }).lean();
  tasks.sort((a, b) => policy.compare(a, b));
  const dependencies = await loadDependencyStatuses(tasks);
  for (let task of tasks) {
    try { policy.assertTask(task); }
    catch { await block(task, 'scope_changed'); continue; }
    if (task.codingAutonomy.basis !== policy.basis(task)) { await block(task, 'task_changed'); continue; }
    if (task.codingAutonomy.state === 'correction') {
      if (task.codingAutonomy.runs.length > policy.totalLimits(task.codingAutonomy).maxResumes) { await block(task, 'resume_limit'); continue; }
      if (!['review', 'blocked'].includes(task.status) || task.automationLease || task.codingCapacity) continue;
      const state = { ...task.codingAutonomy, spent: ciSpent(task.codingAutonomy), state: 'queued' };
      const exhausted = policy.exhausted({ ...task, codingAutonomy: state });
      if (exhausted) { await block(task, `cumulative_${exhausted}`); continue; }
      task = await save(task, state, { status: 'queued', assignee: null, heartbeatAt: null },
        { to: 'queued', kind: 'requeued', channel: 'task_preparation', reason: 'Core bounded correction', declaredActor: 'core-coding-autonomy' });
    }
    if (policy.exhausted(task)) { await block(task, `cumulative_${policy.exhausted(task)}`); continue; }
    if (taskEligibilityReasons(task, { now: new Date(), automated: true, dependencyStatuses: dependencies }).length) continue;
    try { await campaign(task); } catch { continue; }
    let executor = null;
    const previousExecutorId = task.codingAutonomy.runs.at(-1)?.executorId;
    try { executor = typeof control.select === 'function' ? await control.select({ profile: 'autonomous',
      ...(previousExecutorId && { executorId: previousExecutorId }) }) : null; }
    catch { continue; }
    const requestId = randomUUID();
    const active = { pipelineId: task.pipelineId, requestId, selectedAt: new Date().toISOString(),
      ...(executor && { executorId: executor.id, harness: executor.harness }) };
    const won = await Settings.findOneAndUpdate({ _id: ID, enabled: true, revision: config.revision, active: null },
      { $set: { active } }, { new: true, writeConcern: WC }).lean();
    if (!won) return;
    const state = { ...task.codingAutonomy, state: 'dispatching', reason: null,
      runs: [...task.codingAutonomy.runs, { requestId, parentRequestId: task.codingAutonomy.runs.at(-1)?.requestId || null,
        startedAt: active.selectedAt, expectedAttemptCount: task.automationAttemptCount || 0, pendingInferences: [],
        ...(executor && { executorId: executor.id, harness: executor.harness }) }] };
    try { await save(task, state); }
    catch (error) { await clearActive(requestId); throw error; }
    return;
  }
}
async function dispatch(task, config) {
  const state = task.codingAutonomy;
  const run = state.runs.at(-1);
  if (run.finishedAt) { await clearActive(run.requestId); return; }
  // Observe before every retry. Absence of a receipt permits only replay of
  // this saved identity; it never permits creating another attempt.
  const host = await control.status({ requestId: run.requestId, ...(run.executorId && { executorId: run.executorId }) });
  if (host.run?.phase === 'not_received') {
    if (!state.authorized) { await control.stop({ pipelineId: task.pipelineId, requestId: run.requestId, confirm: true,
      ...(run.executorId && { executorId: run.executorId }) }); return; }
    if (!config.enabled) return;
    if (task.status !== 'queued' || task.assignee || task.automationLease) {
      await save(task, { ...state, state: 'stop_requested', reason: 'task_owned_elsewhere' });
      await control.stop({ pipelineId: task.pipelineId, requestId: run.requestId, confirm: true,
        ...(run.executorId && { executorId: run.executorId }) }); return;
    }
    try { await workerManifest(task.pipelineId, run.requestId); }
    catch (error) {
      if (!error.statusCode) throw error;
      await save(task, { ...state, state: 'stop_requested', reason: error.code });
      await control.stop({ pipelineId: task.pipelineId, requestId: run.requestId, confirm: true,
        ...(run.executorId && { executorId: run.executorId }) }); return;
    }
    await control.launch({ pipelineId: task.pipelineId, requestId: run.requestId,
      expectedAttemptCount: run.expectedAttemptCount, confirm: true, autonomous: true,
      ...(run.executorId && { executorId: run.executorId }) });
    return;
  }
  if (host.run?.pipelineId !== task.pipelineId || host.run?.requestId !== run.requestId) throw policy.fail('Runner receipt identity mismatch');
  const receipt = host.run.progress;
  if (receipt && (receipt.pipelineId !== task.pipelineId || receipt.requestId !== run.requestId))
    return block(task, 'runner_outcome_unknown');
  const finished = receipt?.phase === 'finished' && ['review', 'blocked', 'local_only'].includes(receipt.result);
  if (finished && (host.run.phase === 'finished'
    || (['unknown', 'uncertain'].includes(host.run.phase) && host.busy === false))) {
    // The native feedback replay must have released this exact claim. A local
    // terminal file, absent process or expired lease never substitutes for it.
    if (receipt.coreRecorded !== true) {
      await control.reconcile({ pipelineId: task.pipelineId, requestId: run.requestId,
        ...(run.executorId && { executorId: run.executorId }) });
      return;
    }
    if (host.run.cancelledBeforeLaunch && task.automationLease?.dispatchRequestId !== run.requestId
      && task.codingCapacity?.requestId !== run.requestId) {
      await save(task, { ...state, state: state.authorized ? 'blocked' : 'stopped', reason: state.reason || 'selection_cancelled',
        runs: state.runs.map(item => item.requestId === run.requestId ? { ...item, finishedAt: new Date().toISOString(), result: 'cancelled_before_launch' } : item) });
      await clearActive(run.requestId); return;
    }
    if (receipt.preflight && (task.status !== 'queued' || (task.automationAttemptCount || 0) !== run.expectedAttemptCount))
      return block(task, 'preflight_completion_unverified');
    if (task.automationLease || task.codingCapacity || run.pendingInferences?.length)
      return block(task, 'native_completion_unverified');
    const runs = state.runs.slice();
    const usage = policy.usage(run, receipt.usage);
    runs[runs.length - 1] = { ...run, finishedAt: new Date().toISOString(), result: receipt.result,
      head: receipt.checkpoint, usage, progressAt: receipt.progressAt };
    const spent = policy.spent(state);
    for (const key of ['workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls']) spent[key] = (spent[key] || 0) + (usage[key] || 0);
    const next = { ...state, runs, spent,
      reason: ['runner_outcome_unknown', 'native_completion_unverified', 'preflight_completion_unverified'].includes(state.reason) ? null : state.reason,
      seenStates: receipt.seenStates || state.seenStates,
      seenTests: receipt.seenTests || state.seenTests, lastUsefulProgressAt: receipt.progressAt || state.lastUsefulProgressAt,
      lastUsefulWorkSeconds: receipt.lastUsefulWorkSeconds || state.lastUsefulWorkSeconds || 0 };
    if (receipt.manualHead) next.manualInterventions = [...state.manualInterventions,
      { kind: 'remote_branch_update', head: receipt.manualHead, at: run.startedAt }];
    if (receipt.pr) next.pr = receipt.pr;
    if (state.reason === 'operator_stop' || !state.authorized) Object.assign(next, { state: 'stopped', reason: state.reason || 'authorization_removed' });
    else if (receipt.stopReason === 'git_conflict_remaining' && task.status === 'blocked')
      Object.assign(next, { state: 'correction', reason: null, correction: { kind: 'git_conflict_remaining', head: receipt.checkpoint } });
    else if (receipt.result === 'blocked' && receipt.stopReason === 'tests_failed' && task.status === 'blocked'
      && !state.pr && !receipt.pr && receipt.lastTest?.outcome === 'failed'
      && /^[a-f0-9]{40}$/.test(receipt.checkpoint || '') && run.modelReceipts?.length
      && run.modelReceipts.every(call => call.state === 'completed')
      && task.automationAttempts.filter(attempt => attempt.dispatchRequestId === run.requestId).length === 1
      && task.automationAttempts.at(-1)?.dispatchRequestId === run.requestId
      && task.automationAttempts.at(-1)?.attempt === run.expectedAttemptCount + 1
      && task.automationAttemptCount === run.expectedAttemptCount + 1
      && task.automationAttempts.at(-1)?.finalState === 'blocked'
      && Number.isFinite(Date.parse(task.automationAttempts.at(-1)?.completedAt))
      && /^[a-f0-9]{64}$/.test(task.automationAttempts.at(-1)?.resultRequestFingerprint || '')
      && task.automationAttempts.at(-1)?.evidence?.source === 'coding-autonomous/v1'
      && task.automationAttempts.at(-1)?.evidence?.verification?.status === 'failed'
      && task.automationAttempts.at(-1)?.evidence?.failureCodes?.includes('tests_failed'))
      Object.assign(next, { state: 'correction', reason: null, correction: { kind: 'local_tests', head: receipt.checkpoint,
        ...(state.correction?.text && { text: state.correction.text, by: state.correction.by }) } });
    else if (receipt.result !== 'review' || task.status !== 'review' || !receipt.pr) Object.assign(next, { state: 'blocked', reason: next.reason || receipt.stopReason || 'publication_unverified' });
    else {
      if (state.pr && (state.pr.number !== receipt.pr.number || state.pr.branch !== receipt.pr.branch)) return block(task, 'pr_identity_changed');
      Object.assign(next, { state: 'waiting_ci', pr: receipt.pr, ciStartedAt: new Date().toISOString(),
        nextObservationAt: new Date().toISOString(), observationFailures: 0 });
    }
    task = await save(task, next);
    await clearActive(run.requestId);
    return task;
  }
  if (['unknown', 'uncertain'].includes(host.run.phase) && receipt && receipt.phase !== 'finished' && !receipt.coreRecorded) {
    try { await control.reconcile({ pipelineId: task.pipelineId, requestId: run.requestId,
      ...(run.executorId && { executorId: run.executorId }) }); return; }
    catch { /* An absent native verdict remains fenced; never relaunch. */ }
  }
  if (['unknown', 'uncertain', 'not_received', 'finished'].includes(host.run.phase)) return block(task, 'runner_outcome_unknown');
  if (['stopping', 'stop_requested'].includes(state.state)) return;
  return save(task, { ...state, runs: state.runs.map(item => item.requestId === run.requestId
    ? { ...item, currentUsage: receipt?.usage || item.currentUsage } : item),
    state: receipt?.stage || 'working', lastUsefulProgressAt: receipt?.progressAt || state.lastUsefulProgressAt });
}
async function observe(task) {
  const state = task.codingAutonomy;
  const watchingFailure = failedCIWatch(state);
  const last = state.runs.at(-1);
  if (!last?.finishedAt || task.automationLease || task.codingCapacity || !['review', 'blocked'].includes(task.status)) return;
  const guard = { status: task.status, assignee: task.assignee ?? null, updatedAt: task.updatedAt,
    automationLease: null, codingCapacity: null,
    'codingAutonomy.pr.head': state.pr.head, 'codingAutonomy.runs': { $size: state.runs.length },
    [`codingAutonomy.runs.${state.runs.length - 1}.requestId`]: last.requestId,
    [`codingAutonomy.runs.${state.runs.length - 1}.finishedAt`]: last.finishedAt };
  const now = Date.now();
  if (Date.parse(state.nextObservationAt) > now) return;
  const cursor = watchingFailure ? { ciWatchStartedAt: ciWatchStart(state, now) } : {};
  const elapsed = ciElapsed(state, now);
  if (elapsed + (state.spent.ciSeconds || 0) >= policy.totalLimits(state).ciSeconds) return block(task, 'ci_timeout', guard);
  let observation;
  try { observation = await control.observe({ pipelineId: task.pipelineId, requestId: last.requestId, pr: state.pr,
    ...(last.executorId && { executorId: last.executorId }) }); }
  catch {
    const failures = (state.observationFailures || 0) + 1;
    return save(task, { ...state, ...cursor, observationFailures: failures,
      nextObservationAt: new Date(now + Math.min(300000, 15000 * 2 ** Math.min(failures, 5))).toISOString() }, {}, undefined, guard);
  }
  const verdict = policy.verdict(observation, state.pr);
  const next = { ...state, ...cursor, observations: [...state.observations.slice(-19), observation], observationFailures: 0,
    nextObservationAt: new Date(now + OBSERVATION_MS).toISOString() };
  if (verdict === 'stale') {
    // External head changes are evidence of operator contribution. Reconcile
    // them through the worker; never attribute their green CI to our old head.
    next.manualInterventions = [...state.manualInterventions, { kind: 'remote_branch_update', head: observation.head, at: new Date(now).toISOString() }];
    next.correction = { kind: 'remote_head_changed', head: observation.head };
    next.state = 'correction';
  } else if (verdict === 'success') {
    next.state = 'ready_for_review'; next.reason = null;
    if (watchingFailure) delete next.correction;
  }
  else if (verdict === 'closed') { next.state = 'closed'; next.reason = observation.merged ? 'pr_merged_externally' : 'pr_closed_externally'; }
  else if (['conflict', 'failure'].includes(verdict) && !(watchingFailure && verdict === 'failure')) {
    const diagnostic = policy.digest([verdict, observation.baseHead, state.pr.diffFingerprint || state.pr.head,
      observation.checks.map(c => [c.name, c.state, c.diagnostics])]);
    if (state.seenDiagnostics.includes(diagnostic)) { next.state = 'blocked'; next.reason = 'repeated_diagnostic'; }
    else {
      next.seenDiagnostics = [...state.seenDiagnostics, diagnostic];
      next.state = 'correction';
      next.correction = { kind: verdict, head: observation.head, baseHead: observation.baseHead,
        checks: observation.checks.filter(c => c.state !== 'success').slice(0, 10) };
    }
  }
  // A rerun can settle the same published commit without another coding turn.
  // Keep observing a queued CI failure while work is paused or resume-limited;
  // repeated reads are not a repeated diagnostic from a new worker attempt.
  if (state.state === 'waiting_ci' && next.state !== 'waiting_ci') {
    next.spent = { ...state.spent, ciSeconds: (state.spent.ciSeconds || 0) + elapsed };
    if (failedCIWatch(next)) next.ciWatchStartedAt = new Date(now).toISOString();
  } else if (watchingFailure && !failedCIWatch(next)) next.spent = ciSpent(state);
  if (['ready_for_review', 'closed'].includes(next.state)) Object.assign(next, {
    delivery: require('./pipelineCodingDelivery').project(observation, state.pr, now),
    deliveryNextObservationAt: new Date(now + 60000).toISOString() });
  return save(task, next, {}, undefined, guard);
}
async function tick() {
  if (ticking || !control) return;
  ticking = true;
  try {
    let config = await settings();
    if (config.active) {
      const task = await readTask(config.active.pipelineId);
      if (config.active.recovery) {
        await require('./pipelineCodingAutonomyRecovery').releaseConfirmed(task, config, control);
        return;
      }
      if (task.codingAutonomy?.runs.at(-1)?.requestId !== config.active.requestId) {
        // A crash after selection but before the task journal made no host
        // effect. Resolve only a definitively absent exact host request.
        const host = await control.status({ requestId: config.active.requestId,
          ...(config.active.executorId && { executorId: config.active.executorId }) });
        if (host.run?.phase === 'not_received') await clearActive(config.active.requestId);
        return;
      }
      await dispatch(task, config);
    }
    // Bound one sweep and choose the least recently due PR first. No task can
    // monopolize observations; this cadence is independent of shared queue jobs.
    const waiting = await Task.find({ status: { $in: ['review', 'blocked'] }, automationLease: null, codingCapacity: null, $or: [
      { 'codingAutonomy.state': 'waiting_ci' },
      { 'codingAutonomy.authorized': true, 'codingAutonomy.correction.kind': 'failure',
        $or: [{ 'codingAutonomy.state': 'correction' },
          { 'codingAutonomy.state': 'blocked', 'codingAutonomy.reason': 'resume_limit' }] }
    ] })
      .sort({ 'codingAutonomy.nextObservationAt': 1, pipelineId: 1 }).limit(2).lean();
    for (const task of waiting) await observe(task);
    await require('./pipelineCodingDelivery').sweep(control, save);
    config = await settings();
    if (config.enabled && !config.active) await select(config);
  } finally { ticking = false; }
}
module.exports = { configureControl, settings, configure, authorize, status, projection, workerManifest,
  stop, recordReview, recover, continueRecovered, tick, campaign, save, readTask, UUID };
