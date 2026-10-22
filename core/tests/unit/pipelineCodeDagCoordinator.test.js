'use strict';

const domain = require('../../src/services/pipelineCodeDagService');
const policy = require('../../src/services/pipelineCodingAutonomyPolicy');
const { createPipelineCodeDagCoordinator, deterministicUuid } = require('../../src/services/pipelineCodeDagCoordinator');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');

const ROOT = '11111111-2222-4333-8444-555555555555';
const SOURCE = 'a'.repeat(40);
const T0 = '2026-10-22T12:00:00.000Z';
const budget = (workSeconds = 900, testSeconds = 300, modelSeconds = 300, modelCalls = 9) =>
  ({ workSeconds, testSeconds, modelSeconds, modelCalls });
const step = (id, path, dependsOn = []) => ({ id, title: `Change ${id}`, objective: `Implement ${id}`,
  paths: [path], testTargets: [`test:${id}`], dependsOn });
const clone = value => JSON.parse(JSON.stringify(value));

function fixture({ lostLaunch = false, limit = budget() } = {}) {
  const plan = { schema: 'agentx.coding-code-plan/v1', summary: 'Parallel fake plan', steps: [
    step('step-01', 'src/one.js'), step('step-02', 'src/two.js'), step('step-03', 'src/three.js', ['step-01']),
  ] };
  const memory = { dag: domain.create({ pipelineId: '0946', rootRequestId: ROOT, sourceCommit: SOURCE, plan,
    reviewedScope: plan.steps.map(item => item.paths[0]), reviewedLockKeys: [], budget: limit, createdAt: T0 }) };
  const taskRecord = { pipelineId: '0946', title: 'Synthetic DAG', spec: 'Public fake work', service: 'agentx-coding',
    automation: { fingerprint: 'f'.repeat(64), verificationProfile: 'agentx-core-runner-tests/v1' }, automationAttemptCount: 1,
    automationLease: { leaseId: 'root-lease' }, codingCapacity: { model: 'qwen3-coder:30b' } };
  const basis = policy.basis(taskRecord);
  memory.dag.authority = { taskBasis: basis, rootRequestId: ROOT, sourceCommit: SOURCE, runIndex: 0,
    sourceField: 'sourceCommit', coordinator: { id: 'ugfrank', label: 'ugFrank', harness: 'opencode' } };
  memory.dag.coordination = { schema: 'agentx.pipeline-code-step-coordination/v1',
    assemblyRequestId: deterministicUuid(ROOT, 'assembly'), requestedAt: null };
  const transition = operation => async (_pipelineId, input) => {
    const result = domain[operation](memory.dag, input); memory.dag = result.dag; return result;
  };
  const stateService = {
    read: jest.fn(async () => clone(memory.dag)),
    projection: jest.fn(async () => ({ graphId: ROOT })),
    startAttempt: jest.fn(transition('startAttempt')),
    reconcileInference: jest.fn(transition('reconcileInference')),
    settleAttempt: jest.fn(transition('settleAttempt')),
    reconcileUnknown: jest.fn(transition('reconcileUnknown')),
    recordAdoption: jest.fn(transition('recordAdoption')),
    completeAssembly: jest.fn(transition('completeAssembly')),
    terminalize: jest.fn(async (_pipelineId, input) => {
      const terminal = require('../../src/services/pipelineCodeDagTerminalService');
      const result = terminal.terminalize(memory.dag, input); memory.dag = result.dag; return result;
    }),
  };
  Object.assign(taskRecord, { codeStepDag: memory.dag, codingAutonomy: { authorized: true, revision: 2, basis,
    queueRequestId: '99999999-9999-4999-8999-999999999999',
    runs: [{ requestId: ROOT, sourceCommit: SOURCE, executorId: 'ugfrank', harness: 'opencode' }] } });
  const TaskModel = {
    findOne: jest.fn(() => ({ lean: async () => clone({ ...taskRecord, codeStepDag: memory.dag }) })),
    findOneAndUpdate: jest.fn((_filter, update) => {
      if (update.$set?.codeStepDag) memory.dag = clone(update.$set.codeStepDag);
      if (update.$set?.['codeStepDag.coordination.requestedAt']) {
        memory.dag.coordination.requestedAt = update.$set['codeStepDag.coordination.requestedAt'];
      }
      return { lean: async () => clone({ ...taskRecord, codeStepDag: memory.dag }) };
    }),
  };
  const stored = new Map();
  const artifactService = {
    read: jest.fn(async id => {
      if (!stored.has(id)) throw Object.assign(new Error('missing'), { code: 'CODE_STEP_ARTIFACT_NOT_FOUND' });
      return stored.get(id);
    }),
  };
  const runs = new Map();
  const launches = [];
  let lose = lostLaunch;
  const executors = [
    { id: 'ugfrank', label: 'ugFrank', harness: 'opencode', profiles: ['autonomous'], available: true, busy: true, priority: 1 },
    { id: 'ugalien', label: 'ugAlien', harness: 'opencode', profiles: ['autonomous'], available: true, busy: false, priority: 2 },
    { id: 'ugbrutal', label: 'ugBrutal', harness: 'opencode', profiles: ['autonomous'], available: true, busy: false, priority: 3 },
  ];
  const control = {
    status: jest.fn(async input => input.requestId
      ? { busy: runs.get(input.requestId)?.phase === 'running', run: runs.get(input.requestId) || { requestId: input.requestId, phase: 'not_received' } }
      : { executors }),
    launch: jest.fn(async input => {
      launches.push(clone(input)); runs.set(input.requestId, { requestId: input.requestId, pipelineId: input.pipelineId, phase: 'running' });
      if (lose) { lose = false; throw Object.assign(new Error('lost'), { code: 'CODING_DISPATCH_OUTCOME_UNKNOWN' }); }
      return { accepted: true };
    }),
    stop: jest.fn(async () => ({ accepted: true })),
  };
  let counter = 0;
  const requestIds = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
  const create = () => createPipelineCodeDagCoordinator({ TaskModel, stateService, artifactService, control,
    campaignReader: async () => ({ state: 'running', executor: { mode: 'operator' }, source: { type: 'coding', ref: 'fake' },
      reservation: { start: '2026-10-22T11:00:00.000Z', end: '2026-10-22T13:00:00.000Z' } }),
    clock: () => Date.parse(T0) + counter * 1000, randomUUID: () => requestIds[counter++] });
  const addArtifact = (stepId, requestId, commit, letter) => {
    const metadata = { id: `code-step-${letter.repeat(40)}`, sha256: letter.repeat(64), sizeBytes: 120,
      format: 'git-bundle/v1', owner: { pipelineId: '0946', graphId: ROOT, stepId, requestId } };
    stored.set(metadata.id, { metadata, bytes: Buffer.from('bundle') });
    return metadata;
  };
  const verify = async (coordinator, stepId, commit, letter) => {
    const current = memory.dag.steps.find(item => item.id === stepId); const attempt = current.attempts.at(-1);
    const artifact = addArtifact(stepId, attempt.requestId, commit, letter);
    await coordinator.settleStep('0946', attempt.requestId, { outcome: 'verified', actualUsage: budget(10, 5, 4, 1),
      receipt: { commit, changedPaths: [...current.paths], tests: current.testTargets.map(target =>
        ({ target, profile: 'focused', outcome: 'passed', durationMs: 25 })), artifact: {
        id: artifact.id, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, format: artifact.format }, finishedAt: T0 } });
    return attempt.requestId;
  };
  return { memory, stateService, TaskModel, control, launches, runs, create, verify };
}

function submissionFixture(executors, initialDag = null, unavailableExecutors = []) {
  const plan = { schema: 'agentx.coding-code-plan/v1', summary: 'One distributed change', steps: [
    step('step-01', 'src/one.js'),
  ] };
  const automation = normalizePipelineAutomationIntent({ schema: 'agentx.pipeline-automation/v1', mode: 'review_only',
    policyRef: 'agentx.coding-autonomy/v1', dataClassification: 'public', operations: ['update'],
    scope: ['src/one.js'], sourceFiles: ['src/one.js'], lockKeys: ['file:src/one.js'],
    executionProfile: 'coding-sandbox/v1', verificationProfile: 'agentx-core-runner-tests/v1',
    budgets: { maxDurationMs: 900000, maxAttempts: 3, maxCostNanodollars: 0 }, humanGates: ['review', 'merge'] });
  const taskRecord = { pipelineId: '0946', title: 'Synthetic DAG', spec: 'Public fake work',
    service: 'agentx-coding', risk: 'low', automation };
  const basis = policy.basis(taskRecord);
  Object.assign(taskRecord, { codingAutonomy: { authorized: true, revision: 2, basis,
    limits: policy.limits(), spent: {}, runs: [{ requestId: ROOT, sourceCommit: SOURCE,
      executorId: 'ugfrank', harness: 'opencode', startedAt: T0 }] } });
  let dag = clone(initialDag);
  const stateService = {
    read: jest.fn(async () => clone(dag)),
    create: jest.fn(async (_pipelineId, input) => {
      dag = domain.create({ pipelineId: '0946', rootRequestId: input.rootRequestId,
        sourceCommit: input.sourceCommit, plan: input.plan, reviewedScope: input.reviewedScope,
        reviewedLockKeys: input.reviewedLockKeys, budget: input.budget, createdAt: input.createdAt });
      dag.authority = { taskBasis: basis, rootRequestId: ROOT, sourceCommit: SOURCE, runIndex: 0,
        sourceField: 'sourceCommit', coordinator: { id: 'ugfrank', label: 'ugfrank', harness: 'opencode' } };
      return { dag: clone(dag), replayed: false };
    }),
    projection: jest.fn(async () => ({ graphId: dag?.rootRequestId })),
  };
  const TaskModel = {
    findOne: jest.fn(() => ({ lean: async () => clone({ ...taskRecord, ...(dag && { codeStepDag: dag }) }) })),
    findOneAndUpdate: jest.fn((_filter, update) => {
      if (update.$set?.['codeStepDag.coordination']) dag.coordination = clone(update.$set['codeStepDag.coordination']);
      return { lean: async () => clone({ ...taskRecord, codeStepDag: dag }) };
    }),
  };
  const control = { status: jest.fn(async () => ({ executors, unavailableExecutors })) };
  const coordinator = createPipelineCodeDagCoordinator({ TaskModel, stateService, control, clock: () => Date.parse(T0) });
  return { coordinator, stateService, control, input: { sourceCommit: SOURCE, plan,
    budget: budget(100, 100, 100, 2) } };
}

test('refuses DAG creation when the configured fleet contains only the historical root', async () => {
  const f = submissionFixture([{ id: 'ugfrank', profiles: ['autonomous'], available: true, busy: false }]);
  await expect(f.coordinator.submitPlan('0946', ROOT, f.input)).rejects.toMatchObject({
    code: 'CODING_DISTRIBUTION_UNAVAILABLE', statusCode: 409,
  });
  expect(f.stateService.create).not.toHaveBeenCalled();
});

test('reports distribution unavailable when dispatch control has no fleet snapshot', async () => {
  const f = submissionFixture([]);
  f.coordinator.configureControl(null);
  await expect(f.coordinator.submitPlan('0946', ROOT, f.input)).rejects.toMatchObject({
    code: 'CODING_DISTRIBUTION_UNAVAILABLE',
  });
  expect(f.stateService.create).not.toHaveBeenCalled();
});

test('accepts a configured non-root worker while it is temporarily busy', async () => {
  const f = submissionFixture([
    { id: 'ugfrank', profiles: ['autonomous'], available: true, busy: true },
    { id: 'ugalien', profiles: ['autonomous'], enabled: true, available: true, busy: true },
  ]);
  await expect(f.coordinator.submitPlan('0946', ROOT, f.input)).resolves.toMatchObject({
    graphId: ROOT, replayed: false,
  });
  expect(f.stateService.create).toHaveBeenCalledTimes(1);
});

test('accepts an offline configured worker from the dispatch-control unavailable inventory', async () => {
  const f = submissionFixture(
    [{ id: 'ugfrank', profiles: ['autonomous'], available: true, busy: true }],
    null,
    [{ id: 'ugalien', profiles: ['autonomous'], harness: 'opencode', available: false }],
  );
  await expect(f.coordinator.submitPlan('0946', ROOT, f.input)).resolves.toMatchObject({
    graphId: ROOT, replayed: false,
  });
  expect(f.stateService.create).toHaveBeenCalledTimes(1);
});

test('delegates a terminal prior-run graph to the atomic correction replacement', async () => {
  const oldRoot = '99999999-9999-4999-8999-999999999999';
  let oldDag = domain.create({ pipelineId: '0946', rootRequestId: oldRoot, sourceCommit: '9'.repeat(40),
    plan: { schema: 'agentx.coding-code-plan/v1', summary: 'Prior run', steps: [step('step-01', 'src/one.js')] },
    reviewedScope: ['src/one.js'], reviewedLockKeys: ['file:src/one.js'], budget: budget(10, 10, 10, 1), createdAt: T0 });
  oldDag = require('../../src/services/pipelineCodeDagTerminalService').terminalize(oldDag, {
    expectedRevision: 0, state: 'blocked', code: 'cumulative_budget_exhausted', reason: 'Prior run ended',
    stepId: null, finishedAt: T0,
  }).dag;
  const f = submissionFixture([
    { id: 'ugfrank', profiles: ['autonomous'], busy: true },
    { id: 'ugalien', profiles: ['autonomous'], available: false },
  ], oldDag);
  await expect(f.coordinator.submitPlan('0946', ROOT, f.input)).resolves.toMatchObject({
    graphId: ROOT, replayed: false,
  });
  expect(f.stateService.create).toHaveBeenCalledTimes(1);
});

test('dispatches a maximal two-host wave and starts the dependency wave from the adopted head', async () => {
  const f = fixture(); const coordinator = f.create();
  await coordinator.tick('0946');
  expect(f.launches).toHaveLength(2);
  expect(f.launches.map(item => [item.stepId, item.executorId])).toEqual([
    ['step-01', 'ugalien'], ['step-02', 'ugbrutal'],
  ]);
  expect(f.launches.every(item => item.distributedRole === 'step')).toBe(true);
  expect(f.launches.every(item => item.executorId !== 'ugfrank')).toBe(true);
  expect(f.memory.dag.executorProfiles).toMatchObject({
    ugalien: { label: 'ugAlien', harness: 'opencode' }, ugbrutal: { label: 'ugBrutal', harness: 'opencode' },
  });
  expect(f.memory.dag.budget.reserved.workSeconds).toBeGreaterThan(0);

  await f.verify(coordinator, 'step-01', 'b'.repeat(40), '1');
  await f.verify(coordinator, 'step-02', 'c'.repeat(40), '2');
  await coordinator.tick('0946');
  expect(f.launches).toHaveLength(2);
  const assemblyId = deterministicUuid(ROOT, 'assembly');
  const first = await coordinator.manifest('0946', assemblyId);
  expect(first).toMatchObject({ role: 'assembly', executorId: 'ugfrank', requestId: assemblyId,
    model: 'qwen3-coder:30b', rootLeaseId: 'root-lease', verificationProfile: 'agentx-core-runner-tests/v1',
    task: { title: 'Synthetic DAG', spec: 'Public fake work' },
    adoptionOrder: ['step-01', 'step-02', 'step-03'], adoptedSteps: [], finalReady: false,
    readyAdoption: { stepId: 'step-01', commit: 'b'.repeat(40), parent: SOURCE,
      allowedPaths: ['src/one.js'], effectiveDependsOn: [] } });
  expect(first.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/);

  await coordinator.recordAdoption('0946', assemblyId, { stepId: 'step-01', sourceCommit: 'b'.repeat(40),
    parentCommit: SOURCE, adoptedCommit: 'd'.repeat(40), artifactSha256: '1'.repeat(64), adoptedAt: T0 });
  await coordinator.recordAdoption('0946', assemblyId, { stepId: 'step-02', sourceCommit: 'c'.repeat(40),
    parentCommit: 'd'.repeat(40), adoptedCommit: 'e'.repeat(40), artifactSha256: '2'.repeat(64), adoptedAt: T0 });
  await coordinator.tick('0946');
  expect(f.launches).toHaveLength(3);
  expect(f.launches[2]).toMatchObject({ stepId: 'step-03', distributedRole: 'step' });
  const third = f.memory.dag.steps[2].attempts[0];
  expect(third.baseCommit).toBe('e'.repeat(40));
  expect(await coordinator.manifest('0946', third.requestId)).toMatchObject({
    sourceCommit: SOURCE,
    baseCommit: 'e'.repeat(40),
    baseAdoptions: [
      { stepId: 'step-01', requestId: expect.any(String), commit: 'b'.repeat(40), parent: SOURCE,
        adoptedParent: SOURCE, adoptedCommit: 'd'.repeat(40), allowedPaths: ['src/one.js'],
        artifact: { sha256: '1'.repeat(64), format: 'git-bundle/v1' },
        downloadPath: expect.stringContaining('/artifacts/code-step-') },
      { stepId: 'step-02', requestId: expect.any(String), commit: 'c'.repeat(40), parent: SOURCE,
        adoptedParent: 'd'.repeat(40), adoptedCommit: 'e'.repeat(40), allowedPaths: ['src/two.js'],
        artifact: { sha256: '2'.repeat(64), format: 'git-bundle/v1' },
        downloadPath: expect.stringContaining('/artifacts/code-step-') },
    ],
  });
  expect(f.control.launch.mock.calls.flatMap(([input]) => input.distributedRole === 'assembly' ? [input] : [])).toEqual([]);

  await f.verify(coordinator, 'step-03', 'f'.repeat(40), '3');
  await coordinator.recordAdoption('0946', assemblyId, { stepId: 'step-03', sourceCommit: 'f'.repeat(40),
    parentCommit: 'e'.repeat(40), adoptedCommit: '7'.repeat(40), artifactSha256: '3'.repeat(64), adoptedAt: T0 });
  expect(await coordinator.manifest('0946', assemblyId)).toMatchObject({
    finalReady: true, readyAdoption: null, adoptedSteps: ['step-01', 'step-02', 'step-03'],
  });
});

test('a lost launch response keeps the exact request and restart observes it without replacement', async () => {
  const f = fixture({ lostLaunch: true }); const first = f.create();
  await first.tick('0946');
  const requestId = f.memory.dag.steps[0].attempts[0].requestId;
  expect(f.launches.filter(item => item.requestId === requestId)).toHaveLength(1);
  expect(f.memory.dag.steps[0].state).toBe('running');

  const restarted = f.create();
  await restarted.tick('0946');
  expect(f.memory.dag.steps[0].attempts).toHaveLength(1);
  expect(f.memory.dag.steps[0].attempts[0].requestId).toBe(requestId);
  expect(f.launches.filter(item => item.requestId === requestId)).toHaveLength(1);
  expect(f.memory.dag.budget.reserved.modelCalls).toBeGreaterThan(0);
  expect((await restarted.manifest('0946', requestId))).toMatchObject({ role: 'step', requestId, stepId: 'step-01' });
  expect((await restarted.manifest('0946', deterministicUuid(ROOT, 'assembly'))).requestId)
    .toBe(deterministicUuid(ROOT, 'assembly'));
});

test('resumes the exact running request without creating a replacement attempt', async () => {
  const f = fixture(); const coordinator = f.create();
  await coordinator.tick('0946');
  const attempt = f.memory.dag.steps[0].attempts[0];
  f.runs.get(attempt.requestId).phase = 'resumable';
  await coordinator.tick('0946');
  expect(f.memory.dag.steps[0].attempts).toHaveLength(1);
  expect(f.launches.filter(item => item.requestId === attempt.requestId)).toHaveLength(2);
  expect(f.launches.filter(item => item.requestId === attempt.requestId)[1]).toMatchObject({
    graphId: ROOT, stepId: 'step-01', executorId: attempt.executorId,
    distributedRole: 'step', manifestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});

test('reconciles unknown model receipts as failed before accepting the executor terminal result', async () => {
  const f = fixture(); const coordinator = f.create();
  await coordinator.tick('0946');
  const requestId = f.memory.dag.steps[0].attempts[0].requestId;
  f.memory.dag = domain.startInference(f.memory.dag, { expectedRevision: f.memory.dag.revision,
    stepId: 'step-01', requestId, callId: 'call-unknown', model: 'qwen3-coder:30b',
    reservedSeconds: 10, startedAt: T0 }).dag;
  f.memory.dag = domain.settleInference(f.memory.dag, { expectedRevision: f.memory.dag.revision,
    stepId: 'step-01', requestId, callId: 'call-unknown', outcome: 'unknown', durationSeconds: 3,
    finishedAt: T0, receipt: { reason: 'acknowledgement_lost' } }).dag;
  f.runs.set(requestId, { requestId, pipelineId: '0946', phase: 'finished', codeStepResult: {
    outcome: 'failed', actualUsage: budget(5, 0, 3, 1),
    receipt: { code: 'harness_failed', finishedAt: T0 },
  } });
  f.control.status.mockImplementation(async input => input.requestId
    ? { busy: false, run: f.runs.get(input.requestId) }
    : { executors: [] });

  await coordinator.tick('0946');
  const settled = f.memory.dag.steps[0].attempts[0];
  expect(settled).toMatchObject({ state: 'failed', pendingInferences: [], modelReceipts: [{
    callId: 'call-unknown', state: 'failed', durationSeconds: 3,
    settlement: { receipt: { code: 'executor_terminal_after_unknown' } },
  }] });
  expect(f.stateService.reconcileInference).toHaveBeenCalledWith('0946', expect.objectContaining({
    requestId, callId: 'call-unknown', outcome: 'failed', durationSeconds: 3,
  }));
});

test('terminal submission settles its exact unknown model receipt before host result persistence and replays concurrently', async () => {
  const f = fixture(); const coordinator = f.create();
  await coordinator.tick('0946');
  const requestId = f.memory.dag.steps[0].attempts[0].requestId;
  f.memory.dag = domain.startInference(f.memory.dag, { expectedRevision: f.memory.dag.revision,
    stepId: 'step-01', requestId, callId: 'call-post-unknown', model: 'qwen3-coder:30b',
    reservedSeconds: 10, startedAt: T0 }).dag;
  f.memory.dag = domain.settleInference(f.memory.dag, { expectedRevision: f.memory.dag.revision,
    stepId: 'step-01', requestId, callId: 'call-post-unknown', outcome: 'unknown', durationSeconds: 3,
    finishedAt: T0, receipt: { reason: 'terminal_post_acknowledgement_lost' } }).dag;
  const terminal = { outcome: 'failed', actualUsage: budget(5, 0, 3, 1),
    receipt: { code: 'harness_failed', finishedAt: T0 } };

  // RunnerStepAdapter posts this terminal before it can persist codeStepResult
  // in the host receipt. The POST itself must therefore break the fence.
  expect(f.runs.get(requestId)).not.toHaveProperty('codeStepResult');
  await expect(coordinator.settleStep('0946', requestId, { ...terminal,
    actualUsage: budget(5, 0, 2, 1) })).rejects.toMatchObject({ code: 'INFERENCE_USAGE_MISMATCH' });
  expect(f.memory.dag.steps[0].attempts[0]).toMatchObject({ state: 'running',
    pendingInferences: ['call-post-unknown'], modelReceipts: [{ state: 'unknown' }] });
  expect(f.stateService.reconcileInference).not.toHaveBeenCalled();

  const concurrent = await Promise.all([
    coordinator.settleStep('0946', requestId, terminal),
    coordinator.settleStep('0946', requestId, terminal),
  ]);

  expect(concurrent.map(result => result.replayed).sort()).toEqual([false, true]);
  expect(f.memory.dag.steps[0].attempts[0]).toMatchObject({ state: 'failed', pendingInferences: [],
    modelReceipts: [{ callId: 'call-post-unknown', state: 'failed', durationSeconds: 3,
      finishedAt: T0, settlement: { receipt: { code: 'executor_terminal_after_unknown' } } }] });
  expect(f.runs.get(requestId)).not.toHaveProperty('codeStepResult');
  expect(f.stateService.reconcileInference).toHaveBeenCalledTimes(2);
  await expect(coordinator.settleStep('0946', requestId, terminal)).resolves.toMatchObject({ replayed: true });
  expect(f.stateService.reconcileInference).toHaveBeenCalledTimes(2);
});

test('records and replays a deterministic conflict on the next verified adoption', async () => {
  const f = fixture(); const coordinator = f.create();
  await coordinator.tick('0946');
  await f.verify(coordinator, 'step-01', 'b'.repeat(40), '1');
  await f.verify(coordinator, 'step-02', 'c'.repeat(40), '2');
  const assemblyId = deterministicUuid(ROOT, 'assembly');
  const failure = { state: 'failed', code: 'assembly_conflict', stepId: 'step-01',
    reason: 'step-01 conflicts in src/one.js', finishedAt: T0 };
  expect(await coordinator.failAssembly('0946', assemblyId, failure)).toMatchObject({
    replayed: false, dag: { state: 'failed', terminalFailure: failure } });
  expect(await coordinator.failAssembly('0946', assemblyId, failure)).toMatchObject({ replayed: true });
  expect(await coordinator.manifest('0946', assemblyId)).toMatchObject({
    terminalFailure: { code: 'assembly_conflict', stepId: 'step-01' },
    codeStepGraph: { graphId: ROOT }, failureReceiptPath: expect.stringContaining('assembly-failure'),
  });
});

test('records final verification failure with duration and releases the graph for correction', async () => {
  const f = fixture(); const coordinator = f.create();
  await coordinator.tick('0946');
  await f.verify(coordinator, 'step-01', 'b'.repeat(40), '1');
  await f.verify(coordinator, 'step-02', 'c'.repeat(40), '2');
  const assemblyId = deterministicUuid(ROOT, 'assembly');
  await coordinator.recordAdoption('0946', assemblyId, { stepId: 'step-01', sourceCommit: 'b'.repeat(40),
    parentCommit: SOURCE, adoptedCommit: 'd'.repeat(40), artifactSha256: '1'.repeat(64), adoptedAt: T0 });
  await coordinator.recordAdoption('0946', assemblyId, { stepId: 'step-02', sourceCommit: 'c'.repeat(40),
    parentCommit: 'd'.repeat(40), adoptedCommit: 'e'.repeat(40), artifactSha256: '2'.repeat(64), adoptedAt: T0 });
  await coordinator.tick('0946');
  await f.verify(coordinator, 'step-03', 'f'.repeat(40), '3');
  await coordinator.recordAdoption('0946', assemblyId, { stepId: 'step-03', sourceCommit: 'f'.repeat(40),
    parentCommit: 'e'.repeat(40), adoptedCommit: '7'.repeat(40), artifactSha256: '3'.repeat(64), adoptedAt: T0 });
  const tests = ['test:step-01', 'test:step-02', 'test:step-03'].map(target => ({ target,
    profile: 'agentx-core-runner-tests/v1', outcome: 'failed', durationMs: 1501 }));
  const failure = { state: 'failed', code: 'assembly_verification_failed',
    reason: 'Independent final verification did not pass', finishedAt: T0, tests };
  const terminal = await coordinator.failAssembly('0946', assemblyId, failure);
  expect(terminal).toMatchObject({ replayed: false, dag: {
    state: 'failed', assembly: { state: 'failed', usage: { workSeconds: 2, testSeconds: 2 } },
    terminalFailure: { code: 'assembly_verification_failed', stepId: null, tests },
  } });
  expect(await coordinator.failAssembly('0946', assemblyId, failure)).toMatchObject({ replayed: true });
  expect(await coordinator.manifest('0946', assemblyId)).toMatchObject({
    terminalFailure: { code: 'assembly_verification_failed' },
    codeStepGraph: { graphId: ROOT },
  });
});

test('stop fans out only exact unsettled child requests', async () => {
  const f = fixture(); const coordinator = f.create(); await coordinator.tick('0946');
  const result = await coordinator.stopChildren('0946');
  expect(result).toHaveLength(2);
  expect(f.control.stop).toHaveBeenCalledTimes(2);
  expect(f.control.stop.mock.calls.map(([input]) => input.requestId).sort()).toEqual(
    f.memory.dag.steps.slice(0, 2).map(item => item.attempts[0].requestId).sort());
  expect(f.control.stop.mock.calls.every(([input]) => input.confirm === true && input.executorId !== 'ugfrank')).toBe(true);
});

test('terminalizes a graph instead of dispatching a zero-dimension reservation', async () => {
  const f = fixture({ limit: budget(900, 300, 300, 2) });
  const coordinator = f.create();
  const blocked = await coordinator.tick('0946');
  expect(f.launches).toEqual([]);
  expect(blocked).toMatchObject({ state: 'blocked', assembly: { state: 'blocked' },
    terminalFailure: { code: 'cumulative_budget_exhausted', stepId: null } });
  expect(await coordinator.tick('0946')).toMatchObject({ revision: 1, state: 'blocked' });
  expect(f.stateService.terminalize).toHaveBeenCalledTimes(1);
  const manifest = await coordinator.manifest('0946', deterministicUuid(ROOT, 'assembly'));
  expect(manifest).toMatchObject({ finalReady: false, codeStepGraph: { graphId: ROOT },
    terminalFailure: { code: 'cumulative_budget_exhausted', reason: expect.any(String) } });
});

test('terminalizes a settled failed step after its bounded attempts are exhausted', async () => {
  const f = fixture();
  for (let attempt = 1; attempt <= domain.MAX_ATTEMPTS; attempt += 1) {
    const requestId = `exhausted-${attempt}`;
    f.memory.dag = domain.startAttempt(f.memory.dag, { expectedRevision: f.memory.dag.revision,
      stepId: 'step-01', executorId: 'ugalien', requestId, baseCommit: SOURCE,
      budget: budget(10, 10, 10, 1), startedAt: T0 }).dag;
    f.memory.dag = domain.settleAttempt(f.memory.dag, { expectedRevision: f.memory.dag.revision,
      requestId, outcome: 'failed', actualUsage: budget(1, 1, 1, 1),
      receipt: { code: 'focused_tests_failed', finishedAt: T0 } }).dag;
  }
  const failed = await f.create().tick('0946');
  expect(f.launches).toEqual([]);
  expect(failed).toMatchObject({ state: 'failed', terminalFailure: {
    code: 'step_attempts_exhausted', stepId: 'step-01' } });
});
