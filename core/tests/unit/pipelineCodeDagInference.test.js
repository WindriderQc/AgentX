'use strict';

const dagDomain = require('../../src/services/pipelineCodeDagService');
const { createCodeStepInferenceBridge } = require('../../src/services/pipelineCodingInferenceService');
const { SOURCE_PLAN_SCHEMA } = require('../../../shared/codeStepDagContract');

const ROOT = '11111111-2222-4333-8444-555555555555';
const REQUEST_ONE = '21111111-2222-4333-8444-555555555555';
const REQUEST_TWO = '31111111-2222-4333-8444-555555555555';
const CALL_ONE = '41111111-2222-4333-8444-555555555555';
const CALL_TWO = '51111111-2222-4333-8444-555555555555';
const CALL_THREE = '61111111-2222-4333-8444-555555555555';
const LEASE = 'parent-lease';
const MODEL = 'synthetic-code-model';
const SOURCE = '1'.repeat(40);
const T0 = '2026-10-22T12:00:00.000Z';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function budget(modelSeconds = 20, modelCalls = 3) {
  return { workSeconds: 100, testSeconds: 100, modelSeconds, modelCalls };
}
function attemptBudget(modelSeconds) {
  return { workSeconds: 20, testSeconds: 20, modelSeconds, modelCalls: 3 };
}

function initialDag() {
  let dag = dagDomain.create({ pipelineId: '0946', rootRequestId: ROOT, sourceCommit: SOURCE,
    plan: { schema: SOURCE_PLAN_SCHEMA, summary: 'Two parallel code steps', steps: [
      { id: 'step-01', title: 'First', objective: 'Change first', paths: ['src/one.js'],
        testTargets: ['test:one'], dependsOn: [] },
      { id: 'step-02', title: 'Second', objective: 'Change second', paths: ['src/two.js'],
        testTargets: ['test:two'], dependsOn: [] },
    ] }, reviewedScope: ['src/one.js', 'src/two.js'],
    reviewedLockKeys: ['file:src/one.js', 'file:src/two.js'], budget: budget(40, 6), createdAt: T0 });
  dag = dagDomain.startAttempt(dag, { expectedRevision: 0, stepId: 'step-01', executorId: 'ugalien',
    requestId: REQUEST_ONE, baseCommit: SOURCE, budget: attemptBudget(5), startedAt: T0 }).dag;
  return dagDomain.startAttempt(dag, { expectedRevision: 1, stepId: 'step-02', executorId: 'ugbrutal',
    requestId: REQUEST_TWO, baseCommit: SOURCE, budget: attemptBudget(8), startedAt: T0 }).dag;
}

function memoryState() {
  let dag = initialDag();
  return {
    read: jest.fn(async () => clone(dag)),
    startInference: jest.fn(async (_pipelineId, input) => {
      await Promise.resolve();
      const result = dagDomain.startInference(dag, input);
      dag = result.dag;
      return clone(result);
    }),
    settleInference: jest.fn(async (_pipelineId, input) => {
      await Promise.resolve();
      const result = dagDomain.settleInference(dag, input);
      dag = result.dag;
      return clone(result);
    }),
    reconcileInference: jest.fn(async (_pipelineId, input) => {
      const result = dagDomain.reconcileInference(dag, input);
      dag = result.dag;
      return clone(result);
    }),
    current: () => clone(dag),
  };
}

function task() {
  return { pipelineId: '0946', automationLease: { leaseId: LEASE, attempt: 7 },
    codingCapacity: { model: MODEL, admissionId: 'parent-admission', requestId: ROOT,
      host: 'http://ollama.invalid:11434' },
    codingAutonomy: { authorized: true, runs: [{ requestId: ROOT }] } };
}

function headers({ step = 'step-01', request = REQUEST_ONE, executor = 'ugalien', call = CALL_ONE,
  lease = LEASE } = {}) {
  return { 'x-agentx-coding-task': '0946', 'x-agentx-coding-request': request,
    'x-agentx-coding-lease': lease, 'x-agentx-coding-call': call,
    'x-agentx-code-graph': ROOT, 'x-agentx-code-step': step,
    'x-agentx-code-step-request': request, 'x-agentx-code-step-executor': executor };
}

function fixture() {
  const state = memoryState();
  let now = Date.parse(T0);
  const assertLease = jest.fn((value, proof) => {
    if (value.automationLease?.leaseId !== proof.leaseId) {
      throw Object.assign(new Error('wrong lease'), { code: 'AUTOMATION_LEASE_CONFLICT', statusCode: 409 });
    }
  });
  const bridge = createCodeStepInferenceBridge({ stateService: state,
    readTask: jest.fn(async () => clone(task())), assertLease, clock: () => now });
  return { state, bridge, assertLease, advance: seconds => { now += seconds * 1000; } };
}

test('two independent step attempts call concurrently under the parent capacity and settle their own budgets', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    f.bridge.prepareCodeStep(headers(), MODEL),
    f.bridge.prepareCodeStep(headers({ step: 'step-02', request: REQUEST_TWO,
      executor: 'ugbrutal', call: CALL_TWO }), MODEL),
  ]);
  expect(first.options).toMatchObject({ codingDeadlineAt: Date.parse(T0) + 5000,
    codingCapacity: { pipelineId: '0946', leaseId: LEASE },
    attribution: { workItemId: '0946', attempt: 7, correlationId: REQUEST_ONE, runtime: 'agentx' } });
  expect(second.options.codingDeadlineAt).toBe(Date.parse(T0) + 8000);
  expect(f.state.startInference).toHaveBeenCalledTimes(3); // one stale-revision retry

  f.advance(2);
  await Promise.all([first.finish('completed'), second.finish('refused')]);
  const dag = f.state.current();
  const firstAttempt = dag.steps[0].attempts[0];
  const secondAttempt = dag.steps[1].attempts[0];
  expect(firstAttempt.modelReceipts[0]).toMatchObject({ callId: CALL_ONE, state: 'completed',
    reservedSeconds: 5, durationSeconds: 2 });
  expect(secondAttempt.modelReceipts[0]).toMatchObject({ callId: CALL_TWO, state: 'failed',
    reservedSeconds: 8, durationSeconds: 2, settlement: { receipt: { code: 'runtime_refused' } } });
  await first.finish('completed');
  expect(f.state.settleInference).toHaveBeenCalledTimes(3); // concurrent CAS retry, no duplicate finish write
});

test('unknown keeps only its step fenced until explicit state reconciliation', async () => {
  const f = fixture();
  const first = await f.bridge.prepareCodeStep(headers(), MODEL);
  f.advance(1);
  await first.finish('unknown');
  expect(f.state.current().steps[0].attempts[0]).toMatchObject({ pendingInferences: [CALL_ONE],
    modelReceipts: [{ state: 'unknown', durationSeconds: 1 }] });
  await expect(f.bridge.prepareCodeStep(headers({ call: CALL_THREE }), MODEL))
    .rejects.toMatchObject({ code: 'CODING_INFERENCE_COMPLETION_PENDING' });

  const current = f.state.current();
  await f.state.reconcileInference('0946', { expectedRevision: current.revision, stepId: 'step-01',
    requestId: REQUEST_ONE, callId: CALL_ONE, outcome: 'completed', durationSeconds: 1,
    finishedAt: new Date(Date.parse(T0) + 2000).toISOString(), receipt: { responseSha256: 'a'.repeat(64) } });
  const next = await f.bridge.prepareCodeStep(headers({ call: CALL_THREE }), MODEL);
  expect(next.options.codingDeadlineAt).toBe(Date.parse(T0) + 1000 + 4000);
  await next.finish('completed');
  expect(f.state.current().steps[0].attempts[0].modelReceipts).toHaveLength(2);
});

test.each([
  ['executor', headers({ executor: 'ugfrank' }), MODEL, 'CODING_STEP_EXECUTOR_INVALID'],
  ['request', headers({ request: '71111111-2222-4333-8444-555555555555' }), MODEL, 'CODING_STEP_REQUEST_INVALID'],
  ['lease', headers({ lease: 'wrong-lease' }), MODEL, 'AUTOMATION_LEASE_CONFLICT'],
  ['model', headers(), 'other-model', 'CODING_CAPACITY_PROOF_INVALID'],
])('refuses a wrong %s before journalling', async (_kind, inputHeaders, model, code) => {
  const f = fixture();
  await expect(f.bridge.prepareCodeStep(inputHeaders, model)).rejects.toMatchObject({ code });
  expect(f.state.startInference).not.toHaveBeenCalled();
});

