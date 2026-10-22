'use strict';

const service = require('../../src/services/pipelineCodeDagService');
const terminal = require('../../src/services/pipelineCodeDagTerminalService');
const { project } = require('../../src/services/pipelineCodeDagStateService');
const { SOURCE_PLAN_SCHEMA } = require('../../../shared/codeStepDagContract');

const SOURCE = '1'.repeat(40);
const STEP_ONE_COMMIT = '2'.repeat(40);
const STEP_TWO_COMMIT = '3'.repeat(40);
const ADOPT_ONE = '4'.repeat(40);
const ADOPT_TWO = '5'.repeat(40);
const ARTIFACT_ONE = 'a'.repeat(64);
const ARTIFACT_TWO = 'b'.repeat(64);
const RESPONSE = 'e'.repeat(64);
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

function assemblyCompletion(expectedRevision, headCommit = ADOPT_TWO) {
  return {
    expectedRevision,
    headCommit,
    tests: [
      { target: 'test:one', profile: 'jest/cpu/v1', outcome: 'passed', durationMs: 20 },
      { target: 'test:two', profile: 'jest/cpu/v1', outcome: 'passed', durationMs: 20 },
    ],
    publication: { requestId: 'assembly-request:publish', state: 'published',
      url: 'https://github.com/WindriderQc/AgentX/pull/946', prNumber: 946, headCommit },
    completedAt: T0,
  };
}

function startModel(dag, stepId, requestId, callId, reservedSeconds) {
  return service.startInference(dag, {
    expectedRevision: dag.revision, stepId, requestId, callId,
    model: 'synthetic-code-model', reservedSeconds, startedAt: T0,
  });
}

function settleModel(dag, stepId, requestId, callId, outcome, durationSeconds) {
  return service.settleInference(dag, {
    expectedRevision: dag.revision, stepId, requestId, callId, outcome, durationSeconds, finishedAt: T0,
    receipt: outcome === 'completed' ? { responseSha256: RESPONSE }
      : outcome === 'failed' ? { code: 'model_refused' } : { reason: 'acknowledgement_lost' },
  });
}

test('terminalizes budget exhaustion only at a settled boundary and replays its exact receipt', () => {
  let dag = createDag({ limit: budget(1, 1, 1, 1) });
  const input = { expectedRevision: dag.revision, state: 'blocked', code: 'cumulative_budget_exhausted',
    reason: 'No positive reservation remains for every required budget dimension', stepId: null, finishedAt: T0 };
  const blocked = terminal.terminalize(dag, input);
  expect(blocked).toMatchObject({ replayed: false, dag: { revision: 1, state: 'blocked',
    assembly: { state: 'blocked' }, terminalFailure: { code: 'cumulative_budget_exhausted' } } });
  expect(blocked.dag.terminalFailureFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(terminal.terminalize(blocked.dag, input)).toMatchObject({ replayed: true, dag: { revision: 1 } });
  expect(() => terminal.terminalize(blocked.dag, { ...input, reason: 'different' }))
    .toThrow(expect.objectContaining({ code: 'TERMINAL_RECEIPT_CONFLICT' }));

  dag = start(createDag(), 'step-01', 'executor-a', 'unsettled').dag;
  expect(() => terminal.terminalize(dag, { ...input, expectedRevision: dag.revision }))
    .toThrow(expect.objectContaining({ code: 'DAG_NOT_TERMINALIZABLE' }));
});

test('terminalizes an exhausted failed step with deterministic failure evidence', () => {
  let dag = createDag({ stepCount: 1 });
  for (let attempt = 1; attempt <= service.MAX_ATTEMPTS; attempt += 1) {
    const requestId = `attempt-${attempt}`;
    dag = start(dag, 'step-01', 'executor-a', requestId).dag;
    dag = service.settleAttempt(dag, { expectedRevision: dag.revision, requestId, outcome: 'failed',
      actualUsage: budget(1, 1, 1, 1), receipt: { code: 'focused_tests_failed', finishedAt: T0 } }).dag;
  }
  const failed = terminal.terminalize(dag, { expectedRevision: dag.revision, state: 'failed',
    code: 'step_attempts_exhausted', reason: 'step-01 exhausted its bounded attempts',
    stepId: 'step-01', finishedAt: T0 });
  expect(failed.dag).toMatchObject({ state: 'failed', assembly: { state: 'failed' },
    terminalFailure: { code: 'step_attempts_exhausted', stepId: 'step-01' } });
});

test('terminalizes and charges a deterministic final verification failure exactly once', () => {
  let dag = createDag({ stepCount: 1 });
  dag = start(dag, 'step-01', 'executor-a', 'request-final').dag;
  dag = settleVerified(dag, 'request-final', 1).dag;
  dag = service.recordAdoption(dag, {
    expectedRevision: dag.revision,
    stepId: 'step-01', sourceCommit: STEP_ONE_COMMIT, parentCommit: SOURCE,
    adoptedCommit: ADOPT_ONE, artifactSha256: ARTIFACT_ONE, adoptedAt: T0,
  }).dag;
  const input = { expectedRevision: dag.revision, state: 'failed',
    code: 'assembly_verification_failed', reason: 'Independent final verification did not pass',
    stepId: null, finishedAt: T0,
    tests: [{ target: 'test:one', profile: 'jest/cpu/v1', outcome: 'failed', durationMs: 2101 }],
  };
  const failed = terminal.terminalize(dag, input);
  expect(failed).toMatchObject({ replayed: false, dag: {
    state: 'failed', assembly: { state: 'failed', usage: { workSeconds: 3, testSeconds: 3 } },
    budget: { spent: { workSeconds: 7, testSeconds: 6, modelSeconds: 2, modelCalls: 1 } },
    terminalFailure: { code: 'assembly_verification_failed', tests: [{ durationMs: 2101 }] },
  } });
  expect(project(failed.dag)).toMatchObject({ state: 'failed',
    budget: { spent: { workSeconds: 7, testSeconds: 6 } },
    assembly: { state: 'failed', verification: {
      profile: 'jest/cpu/v1', outcome: 'failed', durationMs: 2101,
    } },
  });
  expect(terminal.terminalize(failed.dag, input)).toMatchObject({ replayed: true,
    dag: { revision: failed.dag.revision, budget: { spent: { workSeconds: 7, testSeconds: 6 } } } });
});

test('publication failure requires passing final tests and final failures require every adoption', () => {
  let dag = createDag({ stepCount: 1 });
  dag = start(dag, 'step-01', 'executor-a', 'request-final-invalid').dag;
  dag = settleVerified(dag, 'request-final-invalid', 1).dag;
  const base = { expectedRevision: dag.revision, state: 'failed', code: 'assembly_publication_failed',
    reason: 'Publication refused before dispatch', stepId: null, finishedAt: T0,
    tests: [{ target: 'test:one', profile: 'jest/cpu/v1', outcome: 'passed', durationMs: 10 }],
  };
  expect(() => terminal.terminalize(dag, base))
    .toThrow(expect.objectContaining({ code: 'INVALID_TERMINAL_RECEIPT' }));
  dag = service.recordAdoption(dag, {
    expectedRevision: dag.revision,
    stepId: 'step-01', sourceCommit: STEP_ONE_COMMIT, parentCommit: SOURCE,
    adoptedCommit: ADOPT_ONE, artifactSha256: ARTIFACT_ONE, adoptedAt: T0,
  }).dag;
  expect(() => terminal.terminalize(dag, { ...base, expectedRevision: dag.revision,
    tests: [{ ...base.tests[0], outcome: 'failed' }] }))
    .toThrow(expect.objectContaining({ code: 'INVALID_TERMINAL_RECEIPT' }));
  expect(terminal.terminalize(dag, { ...base, expectedRevision: dag.revision,
    code: 'assembly_source_changed', reason: 'Assembly source changed after final verification' }))
    .toMatchObject({ dag: { terminalFailure: { code: 'assembly_source_changed',
      tests: [{ outcome: 'passed' }] } } });
});

test('selects a deterministic maximal ready set with distinct executors', () => {
  const dag = createDag();
  expect(service.readySet(dag, ['executor-z', 'executor-a', 'executor-a']))
    .toEqual([
      { stepId: 'step-01', executorId: 'executor-z' },
      { stepId: 'step-02', executorId: 'executor-a' },
    ]);

  const locked = service.create({
    pipelineId: '0946', rootRequestId: 'locked', sourceCommit: SOURCE, plan: rawPlan(),
    reviewedScope: ['src/one.js', 'src/two.js'],
    reviewedLockKeys: ['repo:shared'], budget: budget(), createdAt: T0,
  });
  expect(service.readySet(locked, ['executor-z', 'executor-a']))
    .toEqual([{ stepId: 'step-01', executorId: 'executor-z' }]);

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

test('runs dependency waves from the adopted assembly head', () => {
  const wavePlan = {
    schema: SOURCE_PLAN_SCHEMA,
    summary: 'Two parallel roots followed by their dependent',
    steps: [
      ...rawPlan().steps,
      {
        id: 'step-03', title: 'Dependent', objective: 'Build on both adopted roots',
        paths: ['src/three.js'], testTargets: ['test:three'], dependsOn: ['step-01', 'step-02'],
      },
    ],
  };
  let dag = service.create({
    pipelineId: '0946', rootRequestId: 'dependency-waves', sourceCommit: SOURCE, plan: wavePlan,
    reviewedScope: ['src/one.js', 'src/two.js', 'src/three.js'],
    reviewedLockKeys: ['file:src/one.js', 'file:src/two.js', 'file:src/three.js'],
    budget: budget(), createdAt: T0,
  });

  expect(service.adoptionOrder(dag)).toEqual(['step-01', 'step-02', 'step-03']);
  expect(service.readySet(dag, ['executor-b', 'executor-a', 'executor-c']))
    .toEqual([
      { stepId: 'step-01', executorId: 'executor-b' },
      { stepId: 'step-02', executorId: 'executor-a' },
    ]);
  dag = start(dag, 'step-01', 'executor-a', 'wave-request-01').dag;
  dag = start(dag, 'step-02', 'executor-b', 'wave-request-02').dag;
  expect(dag.steps[0].attempts[0].baseCommit).toBe(SOURCE);
  expect(dag.steps[1].attempts[0].baseCommit).toBe(SOURCE);

  dag = settleVerified(dag, 'wave-request-01', 1).dag;
  dag = service.recordAdoption(dag, {
    expectedRevision: dag.revision,
    stepId: 'step-01', sourceCommit: STEP_ONE_COMMIT, parentCommit: SOURCE,
    adoptedCommit: ADOPT_ONE, artifactSha256: ARTIFACT_ONE, adoptedAt: T0,
  }).dag;
  expect(dag.steps[1].state).toBe('running');
  expect(service.readySet(dag, ['executor-c'])).toEqual([]);
  expect(() => service.completeAssembly(dag, assemblyCompletion(dag.revision, ADOPT_ONE)))
    .toThrow(expect.objectContaining({ code: 'DAG_NOT_VERIFIED' }));

  dag = settleVerified(dag, 'wave-request-02', 2).dag;
  dag = service.recordAdoption(dag, {
    expectedRevision: dag.revision,
    stepId: 'step-02', sourceCommit: STEP_TWO_COMMIT, parentCommit: ADOPT_ONE,
    adoptedCommit: ADOPT_TWO, artifactSha256: ARTIFACT_TWO, adoptedAt: T0,
  }).dag;
  expect(service.readySet(dag, ['executor-c']))
    .toEqual([{ stepId: 'step-03', executorId: 'executor-c' }]);
  expect(() => service.startAttempt(dag, {
    expectedRevision: dag.revision,
    stepId: 'step-03', executorId: 'executor-c', requestId: 'wave-request-03-wrong',
    baseCommit: SOURCE, budget: budget(10, 10, 10, 1), startedAt: T0,
  })).toThrow(expect.objectContaining({ code: 'BASE_COMMIT_CONFLICT' }));

  dag = service.startAttempt(dag, {
    expectedRevision: dag.revision,
    stepId: 'step-03', executorId: 'executor-c', requestId: 'wave-request-03',
    baseCommit: ADOPT_TWO, budget: budget(10, 10, 10, 1), startedAt: T0,
  }).dag;
  expect(dag.steps[2].attempts[0].baseCommit).toBe(ADOPT_TWO);
});

test('journals inference independently for parallel step attempts', () => {
  let dag = createDag();
  dag = start(dag, 'step-01', 'executor-a', 'parallel-request-01', budget(10, 10, 10, 2)).dag;
  dag = start(dag, 'step-02', 'executor-b', 'parallel-request-02', budget(10, 10, 10, 2)).dag;
  const firstStart = {
    expectedRevision: dag.revision, stepId: 'step-01', requestId: 'parallel-request-01', callId: 'call-01',
    model: 'synthetic-code-model', reservedSeconds: 6, startedAt: T0,
  };
  dag = service.startInference(dag, firstStart).dag;
  dag = startModel(dag, 'step-02', 'parallel-request-02', 'call-02', 7).dag;
  expect(dag.steps[0].attempts[0].pendingInferences).toEqual(['call-01']);
  expect(dag.steps[1].attempts[0].pendingInferences).toEqual(['call-02']);
  expect(service.startInference(JSON.parse(JSON.stringify(dag)), firstStart).replayed).toBe(true);
  expect(() => service.startInference(dag, { ...firstStart, model: 'different-model' }))
    .toThrow(expect.objectContaining({ code: 'INFERENCE_CALL_CONFLICT' }));

  dag = settleModel(dag, 'step-01', 'parallel-request-01', 'call-01', 'completed', 4).dag;
  dag = settleModel(dag, 'step-02', 'parallel-request-02', 'call-02', 'failed', 3).dag;
  expect(dag.steps[0].attempts[0].modelReceipts[0]).toMatchObject({ state: 'completed', durationSeconds: 4 });
  expect(dag.steps[1].attempts[0].modelReceipts[0]).toMatchObject({ state: 'failed', durationSeconds: 3 });
  expect(dag.steps.map((step) => step.attempts[0].pendingInferences)).toEqual([[], []]);
  expect(dag.budget.reserved).toEqual(budget(20, 20, 20, 4));
});

test('enforces per-attempt inference call and duration reservations', () => {
  let calls = createDag({ stepCount: 1 });
  calls = start(calls, 'step-01', 'executor-a', 'call-budget-attempt', budget(10, 10, 5, 1)).dag;
  calls = startModel(calls, 'step-01', 'call-budget-attempt', 'only-call', 5).dag;
  calls = settleModel(calls, 'step-01', 'call-budget-attempt', 'only-call', 'completed', 3).dag;
  expect(() => startModel(calls, 'step-01', 'call-budget-attempt', 'extra-call', 1))
    .toThrow(expect.objectContaining({ code: 'INFERENCE_CALL_BUDGET_EXHAUSTED' }));

  let duration = createDag({ stepCount: 1 });
  duration = start(duration, 'step-01', 'executor-a', 'duration-budget-attempt', budget(10, 10, 5, 2)).dag;
  duration = startModel(duration, 'step-01', 'duration-budget-attempt', 'duration-call-01', 3).dag;
  duration = settleModel(duration, 'step-01', 'duration-budget-attempt', 'duration-call-01', 'completed', 3).dag;
  expect(() => startModel(duration, 'step-01', 'duration-budget-attempt', 'duration-call-02', 3))
    .toThrow(expect.objectContaining({ code: 'INFERENCE_DURATION_BUDGET_EXHAUSTED' }));
});

test('keeps a lost inference acknowledgement fenced until explicit reconciliation', () => {
  let dag = createDag({ stepCount: 1 });
  dag = start(dag, 'step-01', 'executor-a', 'lost-ack-attempt', budget(10, 10, 10, 2)).dag;
  dag = startModel(dag, 'step-01', 'lost-ack-attempt', 'lost-call', 6).dag;
  const unknown = {
    expectedRevision: dag.revision, stepId: 'step-01', requestId: 'lost-ack-attempt', callId: 'lost-call',
    outcome: 'unknown', durationSeconds: 2, finishedAt: T0, receipt: { reason: 'acknowledgement_lost' },
  };
  dag = service.settleInference(dag, unknown).dag;
  expect(dag.steps[0].attempts[0]).toMatchObject({
    pendingInferences: ['lost-call'], modelReceipts: [{ callId: 'lost-call', state: 'unknown', reservedSeconds: 6 }],
  });
  expect(() => startModel(dag, 'step-01', 'lost-ack-attempt', 'blocked-call', 1))
    .toThrow(expect.objectContaining({ code: 'INFERENCE_PENDING' }));
  expect(service.settleInference(JSON.parse(JSON.stringify(dag)), unknown).replayed).toBe(true);
  expect(() => service.settleInference(dag, { ...unknown, receipt: { reason: 'different_result' } }))
    .toThrow(expect.objectContaining({ code: 'INFERENCE_SETTLEMENT_CONFLICT' }));

  const reconciled = {
    expectedRevision: dag.revision, stepId: 'step-01', requestId: 'lost-ack-attempt', callId: 'lost-call',
    outcome: 'completed', durationSeconds: 4, finishedAt: T0, receipt: { responseSha256: RESPONSE },
  };
  dag = service.reconcileInference(dag, reconciled).dag;
  expect(dag.steps[0].attempts[0]).toMatchObject({
    pendingInferences: [], modelReceipts: [{ callId: 'lost-call', state: 'completed', durationSeconds: 4 }],
  });
  expect(service.reconcileInference(JSON.parse(JSON.stringify(dag)), reconciled).replayed).toBe(true);
  dag = startModel(dag, 'step-01', 'lost-ack-attempt', 'after-reconcile', 6).dag;
  expect(dag.steps[0].attempts[0].pendingInferences).toEqual(['after-reconcile']);
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
  expect(() => service.completeAssembly(dag, assemblyCompletion(dag.revision)))
    .toThrow(expect.objectContaining({ code: 'ASSEMBLY_INCOMPLETE' }));

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
  const completion = assemblyCompletion(dag.revision);
  dag = service.completeAssembly(dag, completion).dag;
  expect(dag.state).toBe('published');
  expect(dag.assembly.state).toBe('published');
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
