'use strict';
const Task = require('../../models/PipelineTask');
const state = require('../../src/services/pipelineCodeDagStateService');
const { createCodeStepInferenceBridge } = require('../../src/services/pipelineCodingInferenceService');
const policy = require('../../src/services/pipelineCodingAutonomyPolicy');
const ROOT = '11111111-2222-4333-8444-555555555555';
const REQUEST = '21111111-2222-4333-8444-555555555555';
const CALL = '31111111-2222-4333-8444-555555555555';
const SOURCE = 'a'.repeat(40), T0 = '2026-10-22T12:00:00.000Z';
const budget = { workSeconds: 10, testSeconds: 10, modelSeconds: 10, modelCalls: 2 };
async function fixture() {
  const record = { pipelineId: '0991', title: 'Synthetic code delegation', spec: 'Public fixture only',
    service: 'agentx-coding', status: 'in_progress', assignee: 'coding-team', risk: 'low',
    automation: require('../../../shared/pipelineAutomationContract').normalizePipelineAutomationIntent({
      schema: 'agentx.pipeline-automation/v1', mode: 'review_only', policyRef: 'synthetic/v1', dataClassification: 'public',
      operations: ['update'], scope: ['src/one.js'], lockKeys: ['file:src/one.js'], executionProfile: 'coding-sandbox/v1',
      verificationProfile: 'agentx-core-runner-tests/v1', budgets: { maxDurationMs: 900000, maxAttempts: 2, maxCostNanodollars: 0 },
      humanGates: ['review', 'merge', 'deploy'] }),
    automationLease: { leaseId: 'synthetic-lease', assignee: 'coding-team', acquiredAt: T0, heartbeatAt: T0,
      expiresAt: '2099-01-01T00:00:00.000Z', durationMs: 900000, attempt: 1 },
    codingCapacity: { model: 'synthetic', admissionId: 'synthetic-admission', requestId: ROOT, host: 'http://runtime.invalid' } };
  record.codingAutonomy = { authorized: true, revision: 1, basis: policy.basis(record),
    runs: [{ requestId: ROOT, sourceCommit: SOURCE, executorId: 'coordinator', startedAt: T0 }] };
  await Task.create(record);
  await state.create('0991', { taskBasis: record.codingAutonomy.basis, rootRequestId: ROOT, sourceCommit: SOURCE,
    plan: { schema: 'agentx.coding-code-plan/v1', summary: 'Synthetic bounded change', steps: [{ id: 'step-01',
      title: 'Change one', objective: 'Synthetic change', paths: ['src/one.js'], testTargets: ['test:one'], dependsOn: [] }] },
    reviewedScope: record.automation.scope, reviewedLockKeys: record.automation.lockKeys, budget, createdAt: T0 });
  await state.startAttempt('0991', { expectedRevision: 0, stepId: 'step-01', requestId: REQUEST,
    executorId: 'worker', baseCommit: SOURCE, budget, startedAt: T0 });
  return record;
}
beforeEach(async () => { await Task.deleteMany({}); });
afterEach(() => jest.restoreAllMocks());
test('real persisted child inference records its original completion after the root is revoked', async () => {
  await fixture();
  // Native lease validation has its own integration suite; no admission or model
  // runtime is invoked here. The real durable DAG owns journalling and receipts.
  const bridge = createCodeStepInferenceBridge({ assertLease: () => {}, clock: () => Date.parse(T0) });
  const headers = { 'x-agentx-coding-task': '0991', 'x-agentx-code-graph': ROOT, 'x-agentx-code-step': 'step-01',
    'x-agentx-code-step-request': REQUEST, 'x-agentx-code-step-executor': 'worker',
    'x-agentx-coding-call': CALL, 'x-agentx-coding-lease': 'synthetic-lease' };
  const active = await bridge.prepareCodeStep(headers, 'synthetic');
  await Task.updateOne({ pipelineId: '0991' }, { $set: { 'codingAutonomy.authorized': false }, $inc: { 'codingAutonomy.revision': 1 } });
  await active.finish('completed');
  expect((await state.read('0991')).steps[0].attempts[0]).toMatchObject({ pendingInferences: [],
    modelReceipts: [{ callId: CALL, state: 'completed' }] });
  await expect(bridge.prepareCodeStep({ ...headers, 'x-agentx-coding-call': '41111111-2222-4333-8444-555555555555' }, 'synthetic'))
    .rejects.toMatchObject({ code: 'CODING_STEP_ROOT_INVALID' });
  expect((await Task.findOne({ pipelineId: '0991' }).lean()).codingAutonomy.authorized).toBe(false);
});
test('real Mongo scope-change race leaves the graph and budget unmodified', async () => {
  await fixture(); const before = await state.read('0991');
  const original = Task.findOneAndUpdate;
  jest.spyOn(Task, 'findOneAndUpdate').mockImplementationOnce((...args) => ({ lean: async () => {
    await Task.updateOne({ pipelineId: '0991' }, { $set: { spec: 'Changed after the authority read' } });
    return original.apply(Task, args).lean();
  } }));
  await expect(state.startInference('0991', { expectedRevision: 1, stepId: 'step-01', requestId: REQUEST,
    callId: CALL, model: 'synthetic', reservedSeconds: 5, startedAt: T0 })).rejects.toMatchObject({ code: 'DAG_ROOT_NOT_ACTIVE' });
  expect(await state.read('0991')).toEqual(before);
});
