'use strict';
const crypto = require('node:crypto');
const Task = require('../../models/PipelineTask');
const autonomy = require('./pipelineCodingAutonomyService');
const codeDagState = require('./pipelineCodeDagStateService');
const { fail, remaining, nativeModelMs } = require('./pipelineCodingAutonomyPolicy');
const { assertLeaseMutationAllowed } = require('./pipelineTaskService');

const STEP_ID = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const EXECUTOR_ID = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const MAX_CAS_RETRIES = 8;

function stepFail(message, code, statusCode = 409) {
  throw fail(message, code, statusCode);
}

function stepIdentity(headers) {
  const identity = {
    pipelineId: headers['x-agentx-coding-task'],
    rootRequestId: headers['x-agentx-code-graph'],
    stepId: headers['x-agentx-code-step'],
    requestId: headers['x-agentx-code-step-request'],
    executorId: headers['x-agentx-code-step-executor'],
    callId: headers['x-agentx-coding-call'],
    leaseId: headers['x-agentx-coding-lease'],
  };
  if (!/^\d{4}$/.test(identity.pipelineId || '')
    || !autonomy.UUID.test(identity.rootRequestId || '')
    || !autonomy.UUID.test(identity.requestId || '')
    || !autonomy.UUID.test(identity.callId || '')
    || !STEP_ID.test(identity.stepId || '')
    || !EXECUTOR_ID.test(identity.executorId || '')
    || typeof identity.leaseId !== 'string' || !identity.leaseId) {
    stepFail('Invalid code-step inference identity', 'CODING_STEP_INFERENCE_INVALID', 400);
  }
  const legacyRequest = headers['x-agentx-coding-request'];
  if (legacyRequest !== undefined && legacyRequest !== identity.requestId) {
    stepFail('The code-step request headers disagree', 'CODING_STEP_REQUEST_INVALID', 400);
  }
  return identity;
}

function locateAttempt(dag, identity) {
  if (!dag || dag.pipelineId !== identity.pipelineId || dag.rootRequestId !== identity.rootRequestId) {
    stepFail('The code-step graph does not match this task and root request', 'CODING_STEP_ROOT_INVALID');
  }
  const step = dag.steps?.find(candidate => candidate.id === identity.stepId);
  const attempt = step?.attempts?.find(candidate => candidate.requestId === identity.requestId);
  if (!step || !attempt) stepFail('The exact code-step attempt was not found', 'CODING_STEP_REQUEST_INVALID');
  if (step.state !== 'running' || attempt.state !== 'running'
    || step.attempts.at(-1)?.requestId !== identity.requestId) {
    stepFail('The exact code-step attempt is not active', 'CODING_STEP_REQUEST_NOT_ACTIVE');
  }
  if (attempt.executorId !== identity.executorId) {
    stepFail('The code-step attempt belongs to another executor', 'CODING_STEP_EXECUTOR_INVALID');
  }
  return { step, attempt };
}

function usedInferenceSeconds(attempt) {
  return (attempt.modelReceipts || []).reduce((total, receipt) => total
    + (['pending', 'unknown'].includes(receipt.state) ? receipt.reservedSeconds : receipt.durationSeconds), 0);
}

function settlementReceipt(identity, outcome, durationSeconds, finishedAt) {
  if (outcome === 'completed') return { responseSha256: crypto.createHash('sha256')
    .update(`${identity.callId}\0${durationSeconds}\0${finishedAt}`).digest('hex') };
  if (outcome === 'failed') return { code: 'runtime_refused' };
  return { reason: 'runtime_outcome_unknown' };
}

function createCodeStepInferenceBridge(options = {}) {
  const State = options.stateService || codeDagState;
  const readTask = options.readTask || autonomy.readTask;
  const assertLease = options.assertLease || assertLeaseMutationAllowed;
  const clock = options.clock || Date.now;

  async function mutate(identity, operation, buildInput) {
    for (let retry = 0; retry < MAX_CAS_RETRIES; retry += 1) {
      const dag = await State.read(identity.pipelineId);
      locateAttempt(dag, identity);
      try {
        return await State[operation](identity.pipelineId, buildInput(dag));
      } catch (error) {
        if (!['DAG_REVISION_CONFLICT', 'REVISION_CONFLICT'].includes(error?.code)
          || retry === MAX_CAS_RETRIES - 1) throw error;
      }
    }
    stepFail('The code-step graph kept changing', 'DAG_REVISION_CONFLICT');
  }

  async function prepareCodeStep(headers, model, signal) {
    const identity = stepIdentity(headers);
    const task = await readTask(identity.pipelineId);
    assertLease(task, { assignee: 'coding-team', leaseId: identity.leaseId });
    const rootRun = task.codingAutonomy?.runs?.at(-1);
    if (task.codingAutonomy?.authorized !== true || rootRun?.finishedAt
      || rootRun?.requestId !== identity.rootRequestId) {
      stepFail('The parent coding run is not active', 'CODING_STEP_ROOT_INVALID');
    }
    if (task.codingCapacity?.model !== model || !task.codingCapacity?.admissionId
      || (task.codingCapacity.requestId && task.codingCapacity.requestId !== identity.rootRequestId)) {
      stepFail('The model must match the parent native coding capacity', 'CODING_CAPACITY_PROOF_INVALID');
    }

    const dag = await State.read(identity.pipelineId);
    const authority = require('./pipelineCodeDagAuthority');
    const binding = authority.authority(task, { taskBasis: dag?.authority?.taskBasis,
      rootRequestId: identity.rootRequestId, sourceCommit: dag?.sourceCommit });
    if (!authority.sameAuthority(binding, dag.authority)) stepFail('The code-step authority changed', 'DAG_ROOT_CHANGED');
    authority.assertReviewedAuthority(task, dag);
    const { attempt } = locateAttempt(dag, identity);
    if ((attempt.modelReceipts || []).some(receipt => receipt.callId === identity.callId)) {
      stepFail('This code-step model request is already journalled', 'CODING_INFERENCE_ALREADY_RECEIVED');
    }
    if (attempt.pendingInferences?.length) {
      stepFail('A prior code-step inference is unresolved', 'CODING_INFERENCE_COMPLETION_PENDING');
    }
    if ((attempt.modelReceipts || []).length >= attempt.budget.modelCalls) {
      stepFail('The code-step model call budget is exhausted', 'CODING_MODEL_BUDGET');
    }
    const reservedSeconds = attempt.budget.modelSeconds - usedInferenceSeconds(attempt);
    if (reservedSeconds <= 0) stepFail('The code-step model duration is exhausted', 'CODING_MODEL_BUDGET');
    const startedMs = clock();
    const startedAt = new Date(startedMs).toISOString();
    await mutate(identity, 'startInference', current => ({ expectedRevision: current.revision,
      stepId: identity.stepId, requestId: identity.requestId, callId: identity.callId,
      model, reservedSeconds, startedAt }));

    const deadlineAt = startedMs + reservedSeconds * 1000;
    const deadline = new AbortController();
    const expire = () => deadline.abort(fail('Code-step model duration exhausted', 'CODING_MODEL_BUDGET'));
    const timer = deadlineAt > clock() ? setTimeout(expire, Math.min(deadlineAt - clock(), 0x7fffffff)) : null;
    if (timer) timer.unref?.(); else expire();
    let finishState = null;
    let finishPromise = null;
    async function finish(state) {
      const outcome = state === 'completed' ? 'completed' : state === 'refused' ? 'failed' : 'unknown';
      if (finishState && finishState !== outcome) {
        stepFail('The code-step inference already has a different terminal outcome', 'CODING_INFERENCE_SETTLEMENT_CONFLICT');
      }
      if (finishPromise) return finishPromise;
      finishState = outcome;
      clearTimeout(timer);
      const finishedMs = clock();
      const finishedAt = new Date(finishedMs).toISOString();
      const durationSeconds = Math.min(reservedSeconds, Math.max(0, Math.ceil((finishedMs - startedMs) / 1000)));
      const receipt = settlementReceipt(identity, outcome, durationSeconds, finishedAt);
      finishPromise = mutate(identity, 'settleInference', current => ({ expectedRevision: current.revision,
        stepId: identity.stepId, requestId: identity.requestId, callId: identity.callId,
        outcome, durationSeconds, finishedAt, receipt })).then(() => undefined);
      return finishPromise;
    }
    return { options: {
      signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
      codingDeadlineAt: deadlineAt,
      codingCapacity: { pipelineId: identity.pipelineId, leaseId: identity.leaseId },
      hostUrl: task.codingCapacity.host,
      attribution: { workItemId: identity.pipelineId, attempt: task.automationLease.attempt,
        correlationId: identity.requestId, runtime: 'agentx' },
    }, finish };
  }

  return Object.freeze({ prepareCodeStep });
}

const codeStepBridge = createCodeStepInferenceBridge();

// The runner adds these headers outside the network-free worker. The existing
// claim lease is the capability; request/call IDs are only replay identities.
async function prepare(headers, model, signal) {
  if (headers['x-agentx-report-request']) return require('./pipelineReportInference').prepare(headers, model, signal);
  if (headers['x-agentx-code-step-request']) return codeStepBridge.prepareCodeStep(headers, model, signal);
  const requestId = headers['x-agentx-coding-request'];
  if (!requestId) return null;
  const pipelineId = headers['x-agentx-coding-task'];
  const callId = headers['x-agentx-coding-call'];
  const leaseId = headers['x-agentx-coding-lease'];
  if (!autonomy.UUID.test(requestId) || !autonomy.UUID.test(callId) || !/^\d{4}$/.test(pipelineId || ''))
    throw fail('Invalid coding inference identity', 'CODING_INFERENCE_INVALID', 400);
  const task = await autonomy.readTask(pipelineId);
  await autonomy.workerManifest(pipelineId, requestId);
  assertLeaseMutationAllowed(task, { assignee: 'coding-team', leaseId });
  const run = task.codingAutonomy.runs.at(-1);
  if (task.codingCapacity?.model !== model || !task.codingCapacity?.admissionId)
    throw fail('The model must match the native coding capacity', 'CODING_CAPACITY_PROOF_INVALID');
  if ((run.modelReceipts || []).some(item => item.callId === callId))
    throw fail('A model request is already journalled; reconcile it without inference replay', 'CODING_INFERENCE_ALREADY_RECEIVED');
  if ((run.modelReceipts || []).length >= remaining(task).modelCalls)
    throw fail('Cumulative model request budget exhausted', 'CODING_MODEL_BUDGET');
  const startedAt = new Date();
  const modelMs = remaining(task).modelSeconds * 1000 - Math.max(nativeModelMs(run, startedAt.getTime()), (run.currentUsage?.modelSeconds || 0) * 1000);
  if (modelMs <= 0) throw fail('Cumulative model duration exhausted', 'CODING_MODEL_BUDGET');
  const reserveMs = Math.min(120, Math.floor(remaining(task).modelSeconds / 4)) * 1000;
  if (modelMs <= reserveMs) throw fail('Preserve the remaining model budget for native completion', 'CODING_MODEL_RESERVE');
  if (run.pendingInferences?.length)
    throw fail('A prior coding inference has not settled; reconcile it before another call', 'CODING_INFERENCE_COMPLETION_PENDING');
  const deadlineAt = startedAt.getTime() + modelMs;
  const saved = await Task.updateOne({ pipelineId, 'automationLease.leaseId': leaseId,
    'codingAutonomy.revision': task.codingAutonomy.revision }, {
    $push: { 'codingAutonomy.runs.$[run].modelReceipts': { callId, state: 'pending', startedAt: startedAt.toISOString() },
      'codingAutonomy.runs.$[run].pendingInferences': callId },
    $inc: { 'codingAutonomy.revision': 1 },
  }, { arrayFilters: [{ 'run.requestId': requestId }], writeConcern: { w: 1, j: true } });
  if (!saved.modifiedCount) throw fail('Coding execution changed before inference');
  const deadline = new AbortController();
  const expire = () => deadline.abort(fail('Coding model duration exhausted', 'CODING_MODEL_BUDGET'));
  const timer = deadlineAt > Date.now() ? setTimeout(expire, deadlineAt - Date.now()) : null;
  if (timer) timer.unref?.(); else expire();
  async function finish(state) {
    clearTimeout(timer);
    const finishedAt = new Date().toISOString();
    const prefix = 'codingAutonomy.runs.$[run].modelReceipts.$[call]';
    // A lost first acknowledgement must leave unknown + pending, even when
    // Mongo applied the native outcome. Never clear the fence in this write.
    const update = { $set: { [`${prefix}.state`]: 'unknown', [`${prefix}.finishedAt`]: finishedAt },
      $inc: { 'codingAutonomy.revision': 1 } };
    if (state !== 'unknown') update.$set[`${prefix}.settlement`] = { state, finishedAt };
    const settled = await Task.updateOne({ pipelineId, 'codingAutonomy.runs': { $elemMatch: {
      requestId, modelReceipts: { $elemMatch: { callId, state: 'pending' } },
    } } }, update, { arrayFilters: [{ 'run.requestId': requestId }, { 'call.callId': callId, 'call.state': 'pending' }], writeConcern: { w: 1, j: true } });
    if (!settled.acknowledged || settled.modifiedCount !== 1)
      throw fail('The exact coding inference receipt was not durably settled', 'CODING_INFERENCE_SETTLEMENT_UNVERIFIED', 503);
    if (state === 'unknown') return;
    // The native outcome now has a durable acknowledged proof. Cleanup cannot
    // invalidate it: if cleanup fails, the retained fence still blocks calls.
    try {
      await Task.updateOne({ pipelineId, 'codingAutonomy.runs': { $elemMatch: {
        requestId, modelReceipts: { $elemMatch: { callId, state: 'unknown',
          'settlement.state': state, 'settlement.finishedAt': finishedAt } },
      } } }, { $set: { [`${prefix}.state`]: state },
        $pull: { 'codingAutonomy.runs.$[run].pendingInferences': callId },
        $inc: { 'codingAutonomy.revision': 1 } }, {
        arrayFilters: [{ 'run.requestId': requestId }, { 'call.callId': callId, 'call.state': 'unknown',
          'call.settlement.state': state, 'call.settlement.finishedAt': finishedAt }], writeConcern: { w: 1, j: true },
      });
    } catch (_) { /* Native completion is proven; unresolved cleanup stays fenced. */ }
  }
  return { options: { signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    codingDeadlineAt: deadlineAt, codingCapacity: { pipelineId, leaseId }, hostUrl: task.codingCapacity.host,
    attribution: { workItemId: pipelineId, attempt: task.automationLease.attempt, correlationId: requestId,
      runtime: 'agentx' } }, finish };
}
module.exports = { createCodeStepInferenceBridge, prepare };
