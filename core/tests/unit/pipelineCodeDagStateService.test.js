'use strict';

const { SOURCE_PLAN_SCHEMA } = require('../../../shared/codeStepDagContract');
const { HISTORY_LIMIT, createPipelineCodeDagStateService } = require('../../src/services/pipelineCodeDagStateService');

const SOURCE = '1'.repeat(40);
const ROOT = '11111111-2222-4333-8444-555555555555';
const NEXT_ROOT = '22222222-3333-4444-8555-666666666666';
const NEXT_SOURCE = '2'.repeat(40);
const BASIS = require('../../src/services/pipelineCodingAutonomyPolicy').basis({});
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
  static beforeWrite = null;
  static findOne(filter) { return Promise.resolve(matches(this.task, filter) ? clone(this.task) : null); }
  static findOneAndUpdate(filter, update) {
    if (this.beforeWrite) { const hook = this.beforeWrite; this.beforeWrite = null; hook(this.task); }
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
  FakeTaskModel.beforeWrite = null;
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

test('persists and projects one replay-safe cumulative-budget terminal receipt', async () => {
  await service.create('0946', createInput({ budget: budget(1, 1, 1, 1) }));
  const input = { expectedRevision: 0, state: 'blocked', code: 'cumulative_budget_exhausted',
    reason: 'No positive reservation remains for every required budget dimension', stepId: null,
    finishedAt: T0 };
  FakeTaskModel.loseNextAck = true;
  const result = await service.terminalize('0946', input);
  expect(result).toMatchObject({ replayed: true, dag: { revision: 1, state: 'blocked' }, summary: {
    state: 'blocked', activeSteps: [], counts: { blocked: 2 },
    steps: [{ id: 'step-01', state: 'blocked', attempt: 0,
      failureCode: 'cumulative_budget_exhausted' }, { id: 'step-02', state: 'blocked', attempt: 0 }],
    assembly: { state: 'blocked', adoptedSteps: 0 },
  } });
  expect(result.summary.assembly.receiptFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(result.summary.assembly.receiptFingerprint).toBe(result.dag.terminalFailureFingerprint);
  expect(await service.terminalize('0946', input)).toMatchObject({ replayed: true, dag: { revision: 1 } });
  await expect(service.startAttempt('0946', { expectedRevision: 1, stepId: 'step-01', executorId: 'ugalien',
    requestId: 'late-request', baseCommit: SOURCE, budget: budget(1, 1, 1, 1), startedAt: T0 }))
    .rejects.toMatchObject({ code: 'DAG_TERMINAL' });
});

test('atomically archives a terminal graph for a correction run and replays the replacement', async () => {
  await service.create('0946', createInput());
  await service.terminalize('0946', { expectedRevision: 0, state: 'blocked', code: 'cumulative_budget_exhausted',
    reason: 'The first run used its distributed budget', stepId: null, finishedAt: T0 });
  const originalGraph = clone(FakeTaskModel.task.codeStepDag);
  FakeTaskModel.task.codeStepDagHistory = Array.from({ length: HISTORY_LIMIT }, (_, index) => ({
    graphId: `historical-${index}`, archivedAt: T0, codeStepGraph: { graphId: `historical-${index}` },
  }));
  FakeTaskModel.task.codingAutonomy.revision = 8;
  FakeTaskModel.task.codingAutonomy.state = 'correction';
  FakeTaskModel.task.codingAutonomy.runs[0].finishedAt = T0;
  FakeTaskModel.task.codingAutonomy.runs.push({ requestId: NEXT_ROOT, sourceCommit: NEXT_SOURCE,
    parentRequestId: ROOT, executorId: 'ugfrank', harness: 'opencode', startedAt: T0 });
  const next = createInput({ rootRequestId: NEXT_ROOT, sourceCommit: NEXT_SOURCE,
    createdAt: '2026-10-22T12:01:00.000Z' });

  FakeTaskModel.loseNextAck = true;
  const replaced = await service.create('0946', next);
  expect(replaced).toMatchObject({ replayed: true, dag: { rootRequestId: NEXT_ROOT, revision: 0 } });
  expect(FakeTaskModel.task.codeStepDagHistory).toHaveLength(HISTORY_LIMIT);
  expect(FakeTaskModel.task.codeStepDagHistory.at(-1)).toMatchObject({ graphId: ROOT,
    archivedAt: next.createdAt, codeStepGraph: { graphId: ROOT, state: 'blocked' } });
  expect(FakeTaskModel.task.codeStepDagHistory[0].graphId).toBe('historical-1');
  expect(FakeTaskModel.task.codeStepDagHistory.at(-1).codeStepGraph.assembly.receiptFingerprint)
    .toBe(originalGraph.terminalFailureFingerprint);
  expect(await service.create('0946', next)).toMatchObject({ replayed: true,
    dag: { rootRequestId: NEXT_ROOT } });
  expect(FakeTaskModel.task.codeStepDagHistory).toHaveLength(HISTORY_LIMIT);

  await expect(service.create('0946', { ...next, plan: { ...plan(), summary: 'A racing different plan' } }))
    .rejects.toMatchObject({ code: 'DAG_ALREADY_EXISTS' });
});

test('never replaces a non-terminal graph when a newer autonomous run races it', async () => {
  await service.create('0946', createInput());
  FakeTaskModel.task.codingAutonomy.revision = 8;
  FakeTaskModel.task.codingAutonomy.runs[0].finishedAt = T0;
  FakeTaskModel.task.codingAutonomy.runs.push({ requestId: NEXT_ROOT, sourceCommit: NEXT_SOURCE,
    parentRequestId: ROOT, executorId: 'ugfrank', harness: 'opencode', startedAt: T0 });
  await expect(service.create('0946', createInput({ rootRequestId: NEXT_ROOT, sourceCommit: NEXT_SOURCE })))
    .rejects.toMatchObject({ code: 'DAG_ALREADY_EXISTS' });
  expect(FakeTaskModel.task.codeStepDag.rootRequestId).toBe(ROOT);
  expect(FakeTaskModel.task.codeStepDagHistory).toBeUndefined();
});

test('does not archive a terminal graph until its owning native run is finished', async () => {
  await service.create('0946', createInput());
  await service.terminalize('0946', { expectedRevision: 0, state: 'blocked', code: 'cumulative_budget_exhausted',
    reason: 'Graph terminal but native root unsettled', stepId: null, finishedAt: T0 });
  FakeTaskModel.task.codingAutonomy.revision = 8;
  FakeTaskModel.task.codingAutonomy.runs.push({ requestId: NEXT_ROOT, sourceCommit: NEXT_SOURCE,
    parentRequestId: ROOT, executorId: 'ugfrank', harness: 'opencode', startedAt: T0 });
  await expect(service.create('0946', createInput({ rootRequestId: NEXT_ROOT, sourceCommit: NEXT_SOURCE })))
    .rejects.toMatchObject({ code: 'DAG_ALREADY_EXISTS' });
  expect(FakeTaskModel.task.codeStepDag.rootRequestId).toBe(ROOT);
});

test('a changed or completed root fences every later DAG mutation', async () => {
  await service.create('0946', createInput());
  FakeTaskModel.task.codingAutonomy.runs[0].finishedAt = T0;
  await expect(service.startAttempt('0946', { expectedRevision: 0, stepId: 'step-01', executorId: 'ugalien',
    requestId: 'step-request-01', baseCommit: SOURCE, budget: budget(10, 10, 10, 1), startedAt: T0 }))
    .rejects.toMatchObject({ code: 'DAG_ROOT_NOT_ACTIVE' });
  expect(FakeTaskModel.task.codeStepDag.revision).toBe(0);
});

test.each(['revocation', 'content', 'private_domain', 'intake', 'reviewed_scope'])(
  '%s blocks new effects while preserving exact inference and child result settlement', async change => {
    await service.create('0946', createInput());
    await service.startAttempt('0946', { expectedRevision: 0, stepId: 'step-01', executorId: 'worker',
      requestId: 'original-request', baseCommit: SOURCE, budget: budget(10, 10, 10, 2), startedAt: T0 });
    await service.startInference('0946', { expectedRevision: 1, stepId: 'step-01', requestId: 'original-request',
      callId: 'original-call', model: 'synthetic', reservedSeconds: 5, startedAt: T0 });
    const record = FakeTaskModel.task;
    if (change === 'revocation') { record.codingAutonomy.authorized = false; record.codingAutonomy.revision += 1; }
    if (change === 'content') record.title = 'New request content';
    if (change === 'private_domain') record.origin = 'family';
    if (change === 'intake') record.intake = { state: 'needs_clarification', revision: 2 };
    if (change === 'reviewed_scope') record.automation.scope = ['src/one.js'];
    await expect(service.startAttempt('0946', { expectedRevision: 2, stepId: 'step-02', executorId: 'other',
      requestId: 'new-request', baseCommit: SOURCE, budget: budget(10, 10, 10, 1), startedAt: T0 })).rejects.toBeDefined();
    const done = await service.settleInference('0946', { expectedRevision: 2, stepId: 'step-01', requestId: 'original-request',
      callId: 'original-call', outcome: 'failed', durationSeconds: 2, finishedAt: T0, receipt: { code: 'runtime_refused' } });
    expect(done.dag.steps[0].attempts[0].pendingInferences).toEqual([]);
    const terminal = await service.settleAttempt('0946', { expectedRevision: 3, requestId: 'original-request',
      outcome: 'failed', actualUsage: budget(2, 2, 2, 1), receipt: { code: 'stopped', finishedAt: T0 } });
    expect(terminal.dag.steps[0].state).toBe('failed');
    expect(terminal.dag.steps[1].attempts).toHaveLength(0);
    await expect(service.startInference('0946', { expectedRevision: 4, stepId: 'step-01', requestId: 'original-request',
      callId: 'replacement-call', model: 'synthetic', reservedSeconds: 1, startedAt: T0 })).rejects.toBeDefined();
  });

test('the atomic write rejects content, intake and private-domain changes after the authority read', async () => {
  for (const mutate of [record => { record.title = 'Raced'; }, record => { record.source = 'household-requests'; },
    record => { record.intake = { revision: 9, state: 'declined' }; },
    record => { record.automation.scope = ['src/other.js']; }]) {
    FakeTaskModel.task = task();
    await service.create('0946', createInput());
    FakeTaskModel.beforeWrite = mutate;
    await expect(service.startAttempt('0946', { expectedRevision: 0, stepId: 'step-01', executorId: 'worker',
      requestId: 'raced-request', baseCommit: SOURCE, budget: budget(10, 10, 10, 1), startedAt: T0 })).rejects.toBeDefined();
    expect(FakeTaskModel.task.codeStepDag.revision).toBe(0);
    expect(FakeTaskModel.task.codeStepDag.steps[0].attempts).toHaveLength(0);
  }
});

test('revocation cannot turn an unrelated root into settlement authority', async () => {
  await service.create('0946', createInput());
  FakeTaskModel.task.codingAutonomy.authorized = false;
  FakeTaskModel.task.codingAutonomy.runs[0].requestId = NEXT_ROOT;
  await expect(service.settleAttempt('0946', { expectedRevision: 0, requestId: 'nonexistent', outcome: 'failed',
    actualUsage: budget(0, 0, 0, 0), receipt: { code: 'stopped', finishedAt: T0 } }))
    .rejects.toMatchObject({ code: 'DAG_ROOT_CHANGED' });
});
