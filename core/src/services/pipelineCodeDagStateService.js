'use strict';

const Task = require('../../models/PipelineTask');
const dagService = require('./pipelineCodeDagService');
const dagTerminal = require('./pipelineCodeDagTerminalService');
const { fingerprint } = require('../../../shared/codeStepDagContract');
const graphSummary = require('../../../shared/codeStepGraphSummary');

const WC = { w: 1, j: true };

class PipelineCodeDagStateError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'PipelineCodeDagStateError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new PipelineCodeDagStateError(code, message, statusCode);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function same(left, right) {
  return fingerprint(left) === fingerprint(right);
}

function queryResult(value) {
  return value && typeof value.lean === 'function' ? value.lean() : value;
}

function latestRun(task) {
  const runs = task?.codingAutonomy?.runs;
  return Array.isArray(runs) && runs.length ? { run: runs[runs.length - 1], index: runs.length - 1 } : null;
}

function sourceBinding(run) {
  if (/^[a-f0-9]{40}$/.test(run?.sourceCommit || '')) return { field: 'sourceCommit', value: run.sourceCommit };
  if (/^[a-f0-9]{40}$/.test(run?.head || '')) return { field: 'head', value: run.head };
  return null;
}

function authority(task, input) {
  const current = latestRun(task);
  const state = task?.codingAutonomy;
  if (!current || state?.authorized !== true || current.run.finishedAt) {
    fail('DAG_ROOT_NOT_ACTIVE', 'The task has no active autonomous root run');
  }
  if (state.basis !== input.taskBasis || current.run.requestId !== input.rootRequestId) {
    fail('DAG_ROOT_CHANGED', 'The autonomous task basis or root request changed');
  }
  const source = sourceBinding(current.run);
  if (!source || source.value !== input.sourceCommit) {
    fail('DAG_SOURCE_CHANGED', 'The root run source commit changed or was not recorded');
  }
  return {
    taskBasis: state.basis,
    autonomyRevision: state.revision,
    rootRequestId: current.run.requestId,
    sourceCommit: source.value,
    runIndex: current.index,
    sourceField: source.field,
    coordinator: {
      id: current.run.executorId || 'coordinator',
      label: current.run.executorId || 'Coordinator',
      harness: current.run.harness || 'unknown',
    },
  };
}

function authorityFilter(task, binding) {
  return {
    pipelineId: task.pipelineId,
    'codingAutonomy.authorized': true,
    'codingAutonomy.basis': binding.taskBasis,
    'codingAutonomy.revision': binding.autonomyRevision,
    [`codingAutonomy.runs.${binding.runIndex}.requestId`]: binding.rootRequestId,
    [`codingAutonomy.runs.${binding.runIndex}.${binding.sourceField}`]: binding.sourceCommit,
    [`codingAutonomy.runs.${binding.runIndex}.finishedAt`]: { $exists: false },
    [`codingAutonomy.runs.${binding.runIndex + 1}`]: { $exists: false },
  };
}

function sameAuthority(current, frozen) {
  if (!frozen) return false;
  const fields = ['taskBasis', 'rootRequestId', 'sourceCommit', 'runIndex', 'sourceField', 'coordinator'];
  return same(Object.fromEntries(fields.map(field => [field, current[field]])),
    Object.fromEntries(fields.map(field => [field, frozen[field]])));
}

function frozenAuthority(binding) {
  const fields = ['taskBasis', 'rootRequestId', 'sourceCommit', 'runIndex', 'sourceField', 'coordinator'];
  return Object.fromEntries(fields.map(field => [field, clone(binding[field])]));
}

function assertReviewedAuthority(task, dag) {
  if (!task.automation || !same(dag.plan.reviewedScope, [...(task.automation.scope || [])].sort())
    || !same(dag.plan.reviewedLockKeys, [...(task.automation.lockKeys || [])].sort())) {
    fail('DAG_REVIEWED_SCOPE_CHANGED', 'The DAG scope or locks differ from the current reviewed task intent');
  }
}

function publicBudget(value) {
  return { workSeconds: value.workSeconds, testSeconds: value.testSeconds,
    modelSeconds: value.modelSeconds, modelCalls: value.modelCalls, ciSeconds: 0 };
}

function stepState(dag, step) {
  if (step.state === 'verified') return 'passed';
  if (dag.terminalFailure) return dag.terminalFailure.state === 'failed'
    && dag.terminalFailure.stepId === step.id ? 'failed' : 'blocked';
  if (step.state === 'unknown') return 'uncertain';
  if (step.state === 'failed') return 'failed';
  if (step.state === 'running') return 'running';
  return step.effectiveDependsOn.some(id => dag.steps.find(candidate => candidate.id === id)?.state !== 'verified')
    ? 'waiting' : 'pending';
}

function attemptExecutor(dag, step) {
  if (!step.attempts.length) return null;
  const attempt = step.attempts[step.attempts.length - 1];
  const publicExecutor = dag.executorProfiles?.[attempt.executorId];
  return publicExecutor || { id: attempt.executorId, label: attempt.executorId, harness: 'unknown' };
}

function projectStep(dag, step) {
  const state = stepState(dag, step);
  const attempt = step.attempts[step.attempts.length - 1];
  const adoption = dag.assembly.adoptions.find(item => item.stepId === step.id);
  const projected = {
    id: step.id,
    title: step.title,
    state,
    dependsOn: [...step.effectiveDependsOn],
    attempt: step.attempts.length,
    tests: step.verifiedReceipt?.tests.map(test => ({
      profile: test.profile,
      outcome: test.outcome,
      durationMs: test.durationMs,
    })) || [],
  };
  const executor = attemptExecutor(dag, step);
  if (executor) projected.executor = executor;
  if (state === 'passed') projected.commit = step.verifiedReceipt.commit;
  if (state === 'waiting') projected.waitCode = 'dependencies_pending';
  if (state === 'uncertain') projected.waitCode = 'executor_outcome_unknown';
  if (state === 'failed') projected.failureCode = dag.terminalFailure?.stepId === step.id
    ? dag.terminalFailure.code : (attempt?.settlement?.receipt?.code || 'step_failed');
  if (state === 'blocked') projected.failureCode = dag.terminalFailure.code;
  if (adoption) projected.adoption = {
    state: 'adopted',
    assemblyCommit: adoption.adoptedCommit,
    receiptFingerprint: fingerprint(adoption),
  };
  return projected;
}

function projectAssembly(dag) {
  const adoptedSteps = dag.assembly.adoptions.length;
  if (dag.terminalFailure) {
    const latest = dag.assembly.adoptions[adoptedSteps - 1];
    return { state: dag.terminalFailure.state,
      executor: dag.authority?.coordinator || { id: 'coordinator', label: 'Coordinator', harness: 'unknown' },
      baseCommit: dag.sourceCommit, ...(latest && { headCommit: latest.adoptedCommit }), adoptedSteps,
      receiptFingerprint: dag.terminalFailureFingerprint || fingerprint(dag.terminalFailure) };
  }
  if (!dag.assembly.completion && adoptedSteps === 0) return { state: 'pending', adoptedSteps };
  const coordinator = dag.authority?.coordinator || { id: 'coordinator', label: 'Coordinator', harness: 'unknown' };
  const latest = dag.assembly.adoptions[adoptedSteps - 1];
  if (!dag.assembly.completion) return {
    state: 'assembling',
    executor: coordinator,
    baseCommit: dag.sourceCommit,
    ...(latest && { headCommit: latest.adoptedCommit }),
    adoptedSteps,
  };
  const publication = dag.assembly.completion.publication;
  return {
    state: 'published',
    executor: coordinator,
    baseCommit: dag.sourceCommit,
    headCommit: dag.assembly.completion.headCommit,
    adoptedSteps,
    verification: {
      profile: dag.assembly.completion.tests[0]?.profile || 'dag-final-tests',
      outcome: 'passed',
      durationMs: dag.assembly.completion.tests.reduce((total, test) => total + test.durationMs, 0),
    },
    publication: { state: 'published', headCommit: publication.headCommit,
      prNumber: publication.prNumber, url: publication.url },
    receiptFingerprint: fingerprint(dag.assembly.completion),
  };
}

function project(dag) {
  if (!dag) return null;
  const steps = dag.steps.map(step => projectStep(dag, step));
  const states = graphSummary.STEP_STATES;
  const assembly = projectAssembly(dag);
  const summary = {
    schema: graphSummary.SCHEMA,
    graphId: dag.rootRequestId,
    planFingerprint: dag.planFingerprint,
    state: dag.terminalFailure?.state || (dag.state === 'published' ? 'published'
      : (dag.assembly.adoptions.length ? 'assembling' : 'running')),
    activeSteps: steps.filter(step => ['running', 'uncertain'].includes(step.state)).map(step => step.id),
    counts: Object.fromEntries(states.map(state => [state, steps.filter(step => step.state === state).length])),
    budget: { reserved: publicBudget(dag.budget.reserved), spent: publicBudget(dag.budget.spent) },
    steps,
    assembly,
  };
  return graphSummary.normalize(summary);
}

function createPipelineCodeDagStateService(Model = Task) {
  async function find(pipelineId) {
    return queryResult(Model.findOne({ pipelineId }));
  }

  async function read(pipelineId) {
    const task = await find(pipelineId);
    if (!task) fail('TASK_NOT_FOUND', 'Pipeline task not found', 404);
    return task.codeStepDag ? clone(task.codeStepDag) : null;
  }

  async function create(pipelineId, input) {
    const task = await find(pipelineId);
    if (!task) fail('TASK_NOT_FOUND', 'Pipeline task not found', 404);
    const binding = authority(task, input);
    const candidate = dagService.create({
      pipelineId,
      rootRequestId: input.rootRequestId,
      sourceCommit: input.sourceCommit,
      plan: input.plan,
      reviewedScope: input.reviewedScope,
      reviewedLockKeys: input.reviewedLockKeys,
      budget: input.budget,
      createdAt: input.createdAt,
    });
    assertReviewedAuthority(task, candidate);
    candidate.authority = frozenAuthority(binding);
    candidate.executorProfiles = {};
    if (binding.coordinator.id !== 'coordinator') candidate.executorProfiles[binding.coordinator.id] = binding.coordinator;
    const candidateSummary = project(candidate);
    if (task.codeStepDag) {
      if (!same(task.codeStepDag, candidate)) fail('DAG_ALREADY_EXISTS', 'The task already has a different code-step DAG');
      return { dag: clone(task.codeStepDag), summary: candidateSummary, replayed: true };
    }
    const saved = await queryResult(Model.findOneAndUpdate(
      { ...authorityFilter(task, binding), codeStepDag: { $exists: false } },
      { $set: { codeStepDag: candidate } },
      { new: true, runValidators: true, writeConcern: WC },
    ));
    if (saved) return { dag: clone(saved.codeStepDag), summary: project(saved.codeStepDag), replayed: false };
    const current = await find(pipelineId);
    if (current?.codeStepDag && same(current.codeStepDag, candidate)) {
      return { dag: clone(current.codeStepDag), summary: project(current.codeStepDag), replayed: true };
    }
    fail('DAG_CREATE_CONFLICT', 'The autonomous root or DAG changed while it was being created');
  }

  async function transition(pipelineId, operation, input) {
    const task = await find(pipelineId);
    if (!task) fail('TASK_NOT_FOUND', 'Pipeline task not found', 404);
    if (!task.codeStepDag) fail('DAG_NOT_FOUND', 'The task has no code-step DAG', 404);
    const dag = clone(task.codeStepDag);
    if (dag.terminalFailure && operation !== 'terminalize') {
      fail('DAG_TERMINAL', 'The code-step graph already has a durable terminal result');
    }
    const binding = authority(task, {
      taskBasis: dag.authority?.taskBasis,
      rootRequestId: dag.rootRequestId,
      sourceCommit: dag.sourceCommit,
    });
    if (!sameAuthority(binding, dag.authority)) fail('DAG_ROOT_CHANGED', 'The persisted DAG authority no longer matches the root run');
    const operationService = operation === 'terminalize' ? dagTerminal : dagService;
    const result = operationService[operation](dag, input);
    if (result.replayed) return { dag: result.dag, summary: project(result.dag), replayed: true };
    const resultSummary = project(result.dag);
    const saved = await queryResult(Model.findOneAndUpdate(
      { ...authorityFilter(task, binding), 'codeStepDag.revision': input.expectedRevision,
        'codeStepDag.rootRequestId': binding.rootRequestId },
      { $set: { codeStepDag: result.dag } },
      { new: true, runValidators: true, writeConcern: WC },
    ));
    if (saved) return { dag: clone(saved.codeStepDag), summary: resultSummary, replayed: false };

    const current = await find(pipelineId);
    if (current?.codeStepDag) {
      const currentBinding = authority(current, {
        taskBasis: current.codeStepDag.authority?.taskBasis,
        rootRequestId: current.codeStepDag.rootRequestId,
        sourceCommit: current.codeStepDag.sourceCommit,
      });
      if (!sameAuthority(currentBinding, current.codeStepDag.authority)) {
        fail('DAG_ROOT_CHANGED', 'The persisted DAG authority no longer matches the root run');
      }
      const replay = operationService[operation](clone(current.codeStepDag), input);
      if (replay.replayed) return { dag: replay.dag, summary: project(replay.dag), replayed: true };
    }
    fail('DAG_REVISION_CONFLICT', 'The code-step DAG changed; read its current revision before retrying');
  }

  return {
    create,
    read,
    projection: async pipelineId => project(await read(pipelineId)),
    readySet: async (pipelineId, executorIds) => dagService.readySet(await read(pipelineId), executorIds),
    startAttempt: (pipelineId, input) => transition(pipelineId, 'startAttempt', input),
    startInference: (pipelineId, input) => transition(pipelineId, 'startInference', input),
    settleInference: (pipelineId, input) => transition(pipelineId, 'settleInference', input),
    reconcileInference: (pipelineId, input) => transition(pipelineId, 'reconcileInference', input),
    settleAttempt: (pipelineId, input) => transition(pipelineId, 'settleAttempt', input),
    reconcileUnknown: (pipelineId, input) => transition(pipelineId, 'reconcileUnknown', input),
    recordAdoption: (pipelineId, input) => transition(pipelineId, 'recordAdoption', input),
    completeAssembly: (pipelineId, input) => transition(pipelineId, 'completeAssembly', input),
    terminalize: (pipelineId, input) => transition(pipelineId, 'terminalize', input),
  };
}

module.exports = {
  PipelineCodeDagStateError,
  createPipelineCodeDagStateService,
  project,
  ...createPipelineCodeDagStateService(),
};
