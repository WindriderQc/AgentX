'use strict';

const { SOURCE_PLAN_SCHEMA } = require('../../../shared/codeStepDagContract');
const { createPipelineCodeDagStateService } = require('../../src/services/pipelineCodeDagStateService');

const SOURCE = '1'.repeat(40);
const ROOT = '11111111-2222-4333-8444-555555555555';
const BASIS = 'a'.repeat(64);
const T0 = '2026-10-22T12:00:00.000Z';

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function valueAt(value, path) { return path.split('.').reduce((current, key) => current?.[key], value); }
function matches(value, filter) {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = valueAt(value, path);
    if (expected && typeof expected === 'object' && '$exists' in expected) return (actual !== undefined) === expected.$exists;
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
}

class FakeTaskModel {
  static task = null;
  static writes = [];
  static loseNextAck = false;
  static findOne(filter) { return Promise.resolve(matches(this.task, filter) ? clone(this.task) : null); }
  static findOneAndUpdate(filter, update) {
    this.writes.push({ filter: clone(filter), update: clone(update) });
    if (!matches(this.task, filter)) return Promise.resolve(null);
    Object.assign(this.task, clone(update.$set));
    if (this.loseNextAck) { this.loseNextAck = false; return Promise.resolve(null); }
    return Promise.resolve(clone(this.task));
  }
}

function budget(workSeconds = 100, testSeconds = 100, modelSeconds = 100, modelCalls = 10) {
  return { workSeconds, testSeconds, modelSeconds, modelCalls };
}

function plan() {
  return {
    schema: SOURCE_PLAN_SCHEMA,
    summary: 'Two independent focused changes',
    steps: [
      { id: 'step-01', title: 'First change', objective: 'Change the first file',
        paths: ['src/one.js'], testTargets: ['test:one'], dependsOn: [] },
      { id: 'step-02', title: 'Second change', objective: 'Change the second file',
        paths: ['src/two.js'], testTargets: ['test:two'], dependsOn: [] },
    ],
  };
}

function task() {
  return {
    pipelineId: '0946',
    automation: { scope: ['src/one.js', 'src/two.js'], lockKeys: ['file:src/one.js', 'file:src/two.js'] },
    codingAutonomy: {
      authorized: true,
      revision: 7,
      basis: BASIS,
      runs: [{ requestId: ROOT, sourceCommit: SOURCE, executorId: 'ugalien', harness: 'opencode', startedAt: T0 }],
    },
  };
}

function createInput(extra = {}) {
  return {
    taskBasis: BASIS,
    rootRequestId: ROOT,
    sourceCommit: SOURCE,
    plan: plan(),
    reviewedScope: ['src/one.js', 'src/two.js'],
    reviewedLockKeys: ['file:src/one.js', 'file:src/two.js'],
    budget: budget(),
    createdAt: T0,
    ...extra,
  };
}

let service;
beforeEach(() => {
  FakeTaskModel.task = task();
  FakeTaskModel.writes = [];
  FakeTaskModel.loseNextAck = false;
  service = createPipelineCodeDagStateService(FakeTaskModel);
});

test('creates one DAG only for the exact active root, source commit, task basis, scope and locks', async () => {
  const created = await service.create('0946', createInput());
  expect(created.replayed).toBe(false);
  expect(created.dag).toMatchObject({ revision: 0, rootRequestId: ROOT, sourceCommit: SOURCE,
    authority: { taskBasis: BASIS, rootRequestId: ROOT, coordinator: { id: 'ugalien', harness: 'opencode' } } });
  expect(created.summary).toMatchObject({ schema: 'agentx.code-step-graph-summary/v1', graphId: ROOT,
    state: 'running', activeSteps: [], counts: { pending: 2 } });
  expect(FakeTaskModel.writes[0].filter).toMatchObject({ pipelineId: '0946',
    'codingAutonomy.basis': BASIS, 'codingAutonomy.revision': 7,
    'codingAutonomy.runs.0.requestId': ROOT, 'codingAutonomy.runs.0.sourceCommit': SOURCE,
    'codingAutonomy.runs.1': { $exists: false }, codeStepDag: { $exists: false } });

  const replay = await service.create('0946', createInput());
  expect(replay.replayed).toBe(true);
  expect(FakeTaskModel.writes).toHaveLength(1);

  await expect(service.create('0946', createInput({ taskBasis: 'b'.repeat(64) })))
    .rejects.toMatchObject({ code: 'DAG_ROOT_CHANGED' });
  const changedScope = task();
  changedScope.automation.scope = ['src/one.js'];
  FakeTaskModel.task = changedScope;
  await expect(service.create('0946', createInput()))
    .rejects.toMatchObject({ code: 'DAG_REVIEWED_SCOPE_CHANGED' });
});

test('persists pure transitions with a single-document revision fence and replays a lost acknowledgement', async () => {
  await service.create('0946', createInput());
  const input = { expectedRevision: 0, stepId: 'step-01', executorId: 'ugbrutal', requestId: 'step-request-01',
    baseCommit: SOURCE, budget: budget(10, 10, 10, 1), startedAt: T0 };
  const started = await service.startAttempt('0946', input);
  expect(started).toMatchObject({ replayed: false, dag: { revision: 1 }, summary: {
    activeSteps: ['step-01'], counts: { running: 1, pending: 1 },
    steps: [{ id: 'step-01', executor: { id: 'ugbrutal', harness: 'unknown' } }, { id: 'step-02' }],
  } });
  expect(FakeTaskModel.writes.at(-1).filter).toMatchObject({
    'codeStepDag.revision': 0, 'codeStepDag.rootRequestId': ROOT,
    'codingAutonomy.runs.0.requestId': ROOT,
  });

  // Core committed the replacement but its response was lost. Repeating the
  // immutable request observes the durable receipt and performs no new write.
  const secondInput = { ...input, expectedRevision: 1, stepId: 'step-02', executorId: 'ugfrank', requestId: 'step-request-02' };
  FakeTaskModel.loseNextAck = true;
  const recovered = await service.startAttempt('0946', secondInput);
  expect(recovered).toMatchObject({ replayed: true, dag: { revision: 2 }, summary: {
    activeSteps: ['step-01', 'step-02'], counts: { running: 2 },
  } });
  expect(FakeTaskModel.writes).toHaveLength(3);

  await expect(service.startAttempt('0946', { ...secondInput, requestId: 'different-request' }))
    .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

test('journals, settles and explicitly reconciles step inference with CAS and replay recovery', async () => {
  await service.create('0946', createInput());
  await service.startAttempt('0946', { expectedRevision: 0, stepId: 'step-01', executorId: 'ugbrutal',
    requestId: 'step-request-01', baseCommit: SOURCE, budget: budget(10, 10, 10, 2), startedAt: T0 });
  const start = { expectedRevision: 1, stepId: 'step-01', requestId: 'step-request-01',
    callId: 'call-01', model: 'qwen-code', reservedSeconds: 8, startedAt: T0 };
  expect(await service.startInference('0946', start)).toMatchObject({ replayed: false, dag: { revision: 2 } });
  expect(await service.startInference('0946', start)).toMatchObject({ replayed: true, dag: { revision: 2 } });
  await expect(service.startInference('0946', { ...start, model: 'another-model' }))
    .rejects.toMatchObject({ code: 'INFERENCE_CALL_CONFLICT' });

  const unknown = { expectedRevision: 2, stepId: 'step-01', requestId: 'step-request-01', callId: 'call-01',
    outcome: 'unknown', durationSeconds: 3, finishedAt: '2026-10-22T12:00:03.000Z',
    receipt: { reason: 'lost_native_ack' } };
  FakeTaskModel.loseNextAck = true;
  expect(await service.settleInference('0946', unknown)).toMatchObject({ replayed: true, dag: { revision: 3 } });
  expect((await service.read('0946')).steps[0].attempts[0]).toMatchObject({
    pendingInferences: ['call-01'], modelReceipts: [{ callId: 'call-01', state: 'unknown' }],
  });

  const reconciled = { expectedRevision: 3, stepId: 'step-01', requestId: 'step-request-01', callId: 'call-01',
    outcome: 'completed', durationSeconds: 3, finishedAt: '2026-10-22T12:00:04.000Z',
    receipt: { responseSha256: 'f'.repeat(64) } };
  expect(await service.reconcileInference('0946', reconciled)).toMatchObject({ replayed: false, dag: { revision: 4 } });
  expect(await service.reconcileInference('0946', reconciled)).toMatchObject({ replayed: true, dag: { revision: 4 } });
  expect((await service.read('0946')).steps[0].attempts[0]).toMatchObject({
    pendingInferences: [], modelReceipts: [{ callId: 'call-01', state: 'completed', durationSeconds: 3 }],
  });
});

test('public reads expose bounded graph evidence but no plan paths, objectives, commands or workspace data', async () => {
  await service.create('0946', createInput());
  await service.startAttempt('0946', { expectedRevision: 0, stepId: 'step-01', executorId: 'ugalien',
    requestId: 'step-request-01', baseCommit: SOURCE, budget: budget(10, 10, 10, 1), startedAt: T0 });
  const projection = await service.projection('0946');
  expect(projection.steps[0]).toEqual({
    id: 'step-01', title: 'First change', state: 'running', dependsOn: [], attempt: 1,
    executor: { id: 'ugalien', label: 'ugalien', harness: 'opencode' }, tests: [],
  });
  const serialized = JSON.stringify(projection);
  expect(serialized).not.toMatch(/src\/one|objective|baseCommit|sourceCommit|worktree|ssh|command/i);
  expect((await service.read('0946')).plan.steps[0].paths).toEqual(['src/one.js']);
});

test('a changed or completed root fences every later DAG mutation', async () => {
  await service.create('0946', createInput());
  FakeTaskModel.task.codingAutonomy.runs[0].finishedAt = T0;
  await expect(service.startAttempt('0946', { expectedRevision: 0, stepId: 'step-01', executorId: 'ugalien',
    requestId: 'step-request-01', baseCommit: SOURCE, budget: budget(10, 10, 10, 1), startedAt: T0 }))
    .rejects.toMatchObject({ code: 'DAG_ROOT_NOT_ACTIVE' });
  expect(FakeTaskModel.task.codeStepDag.revision).toBe(0);
});
