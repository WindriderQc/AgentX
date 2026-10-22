'use strict';

const domain = require('../../src/services/pipelineCodeDagService');
const policy = require('../../src/services/pipelineCodingAutonomyPolicy');
const { createPipelineCodeDagCoordinator, deterministicUuid } = require('../../src/services/pipelineCodeDagCoordinator');

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
