'use strict';

const service = require('../../src/services/pipelineCodeDagService');
const { SOURCE_PLAN_SCHEMA } = require('../../../shared/codeStepDagContract');

const SOURCE = '1'.repeat(40);
const STEP_ONE_COMMIT = '2'.repeat(40);
const STEP_TWO_COMMIT = '3'.repeat(40);
const ADOPT_ONE = '4'.repeat(40);
const ADOPT_TWO = '5'.repeat(40);
const ARTIFACT_ONE = 'a'.repeat(64);
const ARTIFACT_TWO = 'b'.repeat(64);
const FINAL_ARTIFACT = 'c'.repeat(64);
const T0 = '2026-10-22T12:00:00.000Z';

function budget(workSeconds = 100, testSeconds = 100, modelSeconds = 100, modelCalls = 10) {
  return { workSeconds, testSeconds, modelSeconds, modelCalls };
}

function rawPlan(stepCount = 2) {
  return {
    schema: SOURCE_PLAN_SCHEMA,
    summary: 'Parallel reviewed changes',
    steps: [
      {
        id: 'step-01', title: 'First', objective: 'Change the first file',
        paths: ['src/one.js'], testTargets: ['test:one'], dependsOn: [],
      },
      {
        id: 'step-02', title: 'Second', objective: 'Change the second file',
        paths: ['src/two.js'], testTargets: ['test:two'], dependsOn: [],
      },
    ].slice(0, stepCount),
  };
}

function createDag({ stepCount = 2, limit = budget() } = {}) {
  const reviewedScope = stepCount === 1 ? ['src/one.js'] : ['src/one.js', 'src/two.js'];
  return service.create({
    pipelineId: '0946',
    rootRequestId: 'root-request-946',
    sourceCommit: SOURCE,
    plan: rawPlan(stepCount),
    reviewedScope,
    reviewedLockKeys: reviewedScope.map(path => `file:${path}`),
    budget: limit,
    createdAt: T0,
  });
}

function start(dag, stepId, executorId, requestId, reservation = budget(10, 10, 10, 1)) {
  return service.startAttempt(dag, {
    expectedRevision: dag.revision,
    stepId,
    executorId,
    requestId,
    baseCommit: SOURCE,
    budget: reservation,
    startedAt: T0,
  });
}

function verifiedReceipt(step) {
  const one = step === 1;
  return {
    commit: one ? STEP_ONE_COMMIT : STEP_TWO_COMMIT,
    changedPaths: [one ? 'src/one.js' : 'src/two.js'],
    tests: [{ target: one ? 'test:one' : 'test:two', profile: 'jest/cpu/v1', outcome: 'passed', durationMs: 12 }],
    artifact: {
      id: one ? 'artifact-step-01' : 'artifact-step-02',
      sha256: one ? ARTIFACT_ONE : ARTIFACT_TWO,
      sizeBytes: 128,
      format: 'git-bundle/v1',
    },
    finishedAt: T0,
  };
}

function settleVerified(dag, requestId, step) {
  return service.settleAttempt(dag, {
    expectedRevision: dag.revision,
    requestId,
    outcome: 'verified',
    actualUsage: budget(4, 3, 2, 1),
    receipt: verifiedReceipt(step),
  });
}

test('selects a deterministic maximal ready set with distinct executors', () => {
  const dag = createDag();
  expect(service.readySet(dag, ['executor-z', 'executor-a', 'executor-a']))
    .toEqual([
      { stepId: 'step-01', executorId: 'executor-a' },
      { stepId: 'step-02', executorId: 'executor-z' },
    ]);

  const locked = service.create({
    pipelineId: '0946', rootRequestId: 'locked', sourceCommit: SOURCE, plan: rawPlan(),
    reviewedScope: ['src/one.js', 'src/two.js'],
    reviewedLockKeys: ['repo:shared'], budget: budget(), createdAt: T0,
  });
  expect(service.readySet(locked, ['executor-z', 'executor-a']))
    .toEqual([{ stepId: 'step-01', executorId: 'executor-a' }]);

  let pinned = createDag();
  pinned = start(pinned, 'step-02', 'executor-a', 'pin-step-02').dag;
  pinned = service.settleAttempt(pinned, {
    expectedRevision: pinned.revision,
    requestId: 'pin-step-02',
    outcome: 'failed',
    actualUsage: budget(1, 1, 1, 1),
    receipt: { code: 'retry', finishedAt: T0 },
  }).dag;
  expect(service.readySet(pinned, ['executor-a', 'executor-b']))
    .toEqual([
      { stepId: 'step-01', executorId: 'executor-b' },
      { stepId: 'step-02', executorId: 'executor-a' },
    ]);
});

test('pins immutable attempt identity, executor, base and budget across replay and retry', () => {
  let dag = createDag({ stepCount: 1 });
  const input = {
    expectedRevision: 0, stepId: 'step-01', executorId: 'executor-a', requestId: 'request-01',
    baseCommit: SOURCE, budget: budget(10, 10, 10, 1), startedAt: T0,
  };
  const first = service.startAttempt(dag, input);
  dag = first.dag;
  expect(first.replayed).toBe(false);
  expect(dag.budget.reserved).toEqual(input.budget);

  const replay = service.startAttempt(JSON.parse(JSON.stringify(dag)), input);
  expect(replay.replayed).toBe(true);
  expect(replay.dag.revision).toBe(1);
  expect(() => service.startAttempt(dag, { ...input, baseCommit: '9'.repeat(40) }))
    .toThrow(expect.objectContaining({ code: 'REQUEST_ID_CONFLICT' }));

  dag = service.settleAttempt(dag, {
    expectedRevision: dag.revision,
    requestId: 'request-01',
    outcome: 'failed',
    actualUsage: budget(3, 2, 1, 1),
    receipt: { code: 'tests_failed', finishedAt: T0 },
  }).dag;
  expect(dag.budget.reserved).toEqual(budget(0, 0, 0, 0));
  expect(dag.budget.spent).toEqual(budget(3, 2, 1, 1));
  expect(service.readySet(dag, ['executor-z'])).toEqual([]);
  expect(service.readySet(dag, ['executor-a']))
    .toEqual([{ stepId: 'step-01', executorId: 'executor-a' }]);
  expect(() => start(dag, 'step-01', 'executor-z', 'request-02'))
    .toThrow(expect.objectContaining({ code: 'EXECUTOR_PIN_CONFLICT' }));
});

test('reserves aggregate budgets and retains unknown reservations until reconciliation', () => {
  let dag = createDag({ limit: budget(10, 10, 10, 2) });
  dag = start(dag, 'step-01', 'executor-a', 'request-01', budget(6, 6, 6, 1)).dag;
  expect(() => start(dag, 'step-02', 'executor-b', 'request-02', budget(5, 5, 5, 1)))
    .toThrow(expect.objectContaining({ code: 'BUDGET_EXHAUSTED' }));

  dag = service.settleAttempt(dag, {
    expectedRevision: dag.revision,
    requestId: 'request-01',
    outcome: 'unknown',
    actualUsage: budget(2, 1, 2, 1),
    receipt: { reason: 'executor response lost', observedAt: T0 },
  }).dag;
  expect(dag.budget.reserved).toEqual(budget(6, 6, 6, 1));
  expect(dag.budget.spent).toEqual(budget(0, 0, 0, 0));
  expect(service.readySet(dag, ['executor-a', 'executor-b']))
    .toEqual([{ stepId: 'step-02', executorId: 'executor-b' }]);

  dag = service.reconcileUnknown(dag, {
    expectedRevision: dag.revision,
    requestId: 'request-01',
    outcome: 'failed',
    actualUsage: budget(3, 2, 2, 1),
    receipt: { code: 'executor_failed', finishedAt: T0 },
  }).dag;
  expect(dag.budget.reserved).toEqual(budget(0, 0, 0, 0));
  expect(dag.budget.spent).toEqual(budget(3, 2, 2, 1));
  expect(service.reconcileUnknown(JSON.parse(JSON.stringify(dag)), {
    expectedRevision: 0,
    requestId: 'request-01',
    outcome: 'failed',
    actualUsage: budget(3, 2, 2, 1),
    receipt: { code: 'executor_failed', finishedAt: T0 },
  }).replayed).toBe(true);
});

test('requires terminal commit, test and artifact receipts, then assembles in deterministic order', () => {
  let dag = createDag();
  dag = start(dag, 'step-01', 'executor-a', 'request-01').dag;
  dag = start(dag, 'step-02', 'executor-b', 'request-02').dag;

  expect(() => service.settleAttempt(dag, {
    expectedRevision: dag.revision,
    requestId: 'request-01',
    outcome: 'verified',
    actualUsage: budget(4, 3, 2, 1),
    receipt: { ...verifiedReceipt(1), tests: [] },
  })).toThrow(expect.objectContaining({ code: 'INVALID_RECEIPT' }));

  dag = settleVerified(dag, 'request-01', 1).dag;
  dag = settleVerified(dag, 'request-02', 2).dag;
  expect(service.adoptionOrder(dag)).toEqual(['step-01', 'step-02']);

  expect(() => service.recordAdoption(dag, {
    expectedRevision: dag.revision,
    stepId: 'step-02', sourceCommit: STEP_TWO_COMMIT, parentCommit: SOURCE,
    adoptedCommit: ADOPT_TWO, artifactSha256: ARTIFACT_TWO, adoptedAt: T0,
  })).toThrow(expect.objectContaining({ code: 'ADOPTION_ORDER_CONFLICT' }));

  const firstAdoption = {
    expectedRevision: dag.revision,
    stepId: 'step-01', sourceCommit: STEP_ONE_COMMIT, parentCommit: SOURCE,
    adoptedCommit: ADOPT_ONE, artifactSha256: ARTIFACT_ONE, adoptedAt: T0,
  };
  dag = service.recordAdoption(dag, firstAdoption).dag;
  expect(service.recordAdoption(JSON.parse(JSON.stringify(dag)), firstAdoption).replayed).toBe(true);

  dag = service.recordAdoption(dag, {
    expectedRevision: dag.revision,
    stepId: 'step-02', sourceCommit: STEP_TWO_COMMIT, parentCommit: ADOPT_ONE,
    adoptedCommit: ADOPT_TWO, artifactSha256: ARTIFACT_TWO, adoptedAt: T0,
  }).dag;
  const completion = {
    expectedRevision: dag.revision,
    headCommit: ADOPT_TWO,
    tests: [
      { target: 'test:one', profile: 'jest/cpu/v1', outcome: 'passed', durationMs: 20 },
      { target: 'test:two', profile: 'jest/cpu/v1', outcome: 'passed', durationMs: 20 },
    ],
    artifact: { id: 'assembled', sha256: FINAL_ARTIFACT, sizeBytes: 256, format: 'git-bundle/v1' },
    completedAt: T0,
  };
  dag = service.completeAssembly(dag, completion).dag;
  expect(dag.state).toBe('verified');
  expect(dag.assembly.state).toBe('verified');
  expect(service.completeAssembly(JSON.parse(JSON.stringify(dag)), completion).replayed).toBe(true);
});

test('rejects stale non-replay transitions with a CAS revision conflict', () => {
  let dag = createDag();
  dag = start(dag, 'step-01', 'executor-a', 'request-01').dag;
  expect(() => service.startAttempt(dag, {
    expectedRevision: 0,
    stepId: 'step-02', executorId: 'executor-b', requestId: 'request-02',
    baseCommit: SOURCE, budget: budget(10, 10, 10, 1), startedAt: T0,
  })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
});
