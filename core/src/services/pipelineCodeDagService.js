'use strict';

const {
  DAG_SCHEMA,
  fingerprint,
  repositoryPath,
  validatePlan,
} = require('../../../shared/codeStepDagContract');

const BUDGET_KEYS = ['workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls'];
const MAX_ATTEMPTS = 3;

class PipelineCodeDagError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PipelineCodeDagError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PipelineCodeDagError(code, message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('INVALID_INPUT', `${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function identifier(value, label, maximum = 160) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    fail('INVALID_INPUT', `${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value.trim();
}

function commit(value, label) {
  const normalized = identifier(value, label, 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) fail('INVALID_COMMIT', `${label} must be a full git commit sha`);
  return normalized;
}

function sha256(value, label) {
  const normalized = identifier(value, label, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) fail('INVALID_SHA256', `${label} must be a sha256 digest`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = identifier(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(normalized) || Number.isNaN(Date.parse(normalized))) {
    fail('INVALID_TIMESTAMP', `${label} must be an ISO-8601 UTC timestamp`);
  }
  return normalized;
}

function normalizeBudget(value, label, { requirePositive = false } = {}) {
  exactObject(value, BUDGET_KEYS, label);
  const result = {};
  for (const key of BUDGET_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      fail('INVALID_BUDGET', `${label}.${key} must be a non-negative safe integer`);
    }
    result[key] = value[key];
  }
  if (requirePositive && BUDGET_KEYS.every((key) => result[key] === 0)) {
    fail('INVALID_BUDGET', `${label} must reserve at least one budget unit`);
  }
  return result;
}

function zeroBudget() {
  return Object.fromEntries(BUDGET_KEYS.map((key) => [key, 0]));
}

function same(left, right) {
  return fingerprint(left) === fingerprint(right);
}

function assertState(dag) {
  if (!dag || dag.schema !== DAG_SCHEMA || !Number.isSafeInteger(dag.revision) || dag.revision < 0) {
    fail('INVALID_DAG', 'invalid pipeline code DAG state');
  }
  if (fingerprint(dag.plan) !== dag.planFingerprint) fail('PLAN_FINGERPRINT_MISMATCH', 'plan fingerprint mismatch');
  normalizeBudget(dag.budget.limit, 'dag.budget.limit');
  normalizeBudget(dag.budget.reserved, 'dag.budget.reserved');
  normalizeBudget(dag.budget.spent, 'dag.budget.spent');
  if (!Array.isArray(dag.steps) || dag.steps.length !== dag.plan.steps.length) {
    fail('INVALID_DAG', 'durable steps do not match the frozen plan');
  }
  const calculatedReserved = zeroBudget();
  const calculatedSpent = zeroBudget();
  const requestIds = new Set();
  dag.steps.forEach((step, index) => {
    if (step.id !== dag.plan.steps[index].id || !Array.isArray(step.attempts)) {
      fail('INVALID_DAG', 'durable steps do not match the frozen plan order');
    }
    for (const attempt of step.attempts) {
      if (requestIds.has(attempt.requestId)) fail('INVALID_DAG', `duplicate requestId ${attempt.requestId}`);
      requestIds.add(attempt.requestId);
      normalizeBudget(attempt.budget, `attempt ${attempt.requestId}.budget`);
      const aggregate = ['running', 'unknown'].includes(attempt.state) ? calculatedReserved : calculatedSpent;
      const usage = ['running', 'unknown'].includes(attempt.state) ? attempt.budget : attempt.settlement?.actualUsage;
      if (!usage) fail('INVALID_DAG', `attempt ${attempt.requestId} has no settlement usage`);
      for (const key of BUDGET_KEYS) aggregate[key] += usage[key];
    }
  });
  for (const key of BUDGET_KEYS) {
    if (dag.budget.reserved[key] !== calculatedReserved[key] || dag.budget.spent[key] !== calculatedSpent[key]) {
      fail('INVALID_DAG', `aggregate ${key} budget does not match attempt receipts`);
    }
    if (dag.budget.reserved[key] + dag.budget.spent[key] > dag.budget.limit[key]) {
      fail('INVALID_DAG', `aggregate ${key} budget exceeds its limit`);
    }
  }
  return dag;
}

function expectRevision(dag, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== dag.revision) {
    fail('REVISION_CONFLICT', `expected revision ${expectedRevision}; current revision is ${dag.revision}`);
  }
}

function findStep(dag, stepId) {
  const step = dag.steps.find((candidate) => candidate.id === stepId);
  if (!step) fail('STEP_NOT_FOUND', `unknown step ${stepId}`);
  return step;
}

function adoptedStepIds(dag) {
  return new Set(dag.assembly.adoptions.map((adoption) => adoption.stepId));
}

function currentAssemblyHead(dag) {
  return dag.assembly.adoptions.length
    ? dag.assembly.adoptions[dag.assembly.adoptions.length - 1].adoptedCommit
    : dag.sourceCommit;
}

function dependenciesReady(dag, step) {
  const adopted = adoptedStepIds(dag);
  const frozenStep = dag.plan.steps.find((candidate) => candidate.id === step.id);
  if (!frozenStep) fail('INVALID_DAG', `${step.id} is missing from the frozen plan`);
  return frozenStep.effectiveDependsOn.every(
    (dependencyId) => findStep(dag, dependencyId).state === 'verified' && adopted.has(dependencyId),
  );
}

function create(input) {
  exactObject(
    input,
    ['pipelineId', 'rootRequestId', 'sourceCommit', 'plan', 'reviewedScope', 'reviewedLockKeys', 'budget', 'createdAt'],
    'input',
  );
  const normalizedPlan = validatePlan(input.plan, {
    reviewedScope: input.reviewedScope,
    reviewedLockKeys: input.reviewedLockKeys,
  });
  const dag = {
    schema: DAG_SCHEMA,
    revision: 0,
    pipelineId: identifier(input.pipelineId, 'pipelineId'),
    rootRequestId: identifier(input.rootRequestId, 'rootRequestId'),
    sourceCommit: commit(input.sourceCommit, 'sourceCommit'),
    createdAt: timestamp(input.createdAt, 'createdAt'),
    state: 'executing',
    plan: normalizedPlan.plan,
    planFingerprint: normalizedPlan.fingerprint,
    budget: {
      limit: normalizeBudget(input.budget, 'budget', { requirePositive: true }),
      reserved: zeroBudget(),
      spent: zeroBudget(),
    },
    steps: normalizedPlan.plan.steps.map((step) => ({
      ...clone(step),
      state: 'pending',
      executorId: null,
      attempts: [],
      verifiedReceipt: null,
    })),
    assembly: { state: 'pending', adoptions: [], completion: null },
  };
  return assertState(dag);
}

function readySet(dag, availableExecutorIds) {
  assertState(dag);
  if (!Array.isArray(availableExecutorIds)) fail('INVALID_EXECUTORS', 'availableExecutorIds must be an array');
  const busy = new Set(dag.steps.filter((step) => ['running', 'unknown'].includes(step.state)).map((step) => step.executorId));
  const available = [...new Set(availableExecutorIds.map((value, index) => identifier(value, `availableExecutorIds[${index}]`)))]
    .filter((executorId) => !busy.has(executorId))
    .sort();
  const candidates = dag.steps.filter((step) =>
    ['pending', 'failed'].includes(step.state) && step.attempts.length < MAX_ATTEMPTS && dependenciesReady(dag, step));
  const assigned = new Set();
  const assignments = new Map();
  for (const step of candidates.filter((candidate) => candidate.executorId)) {
    if (available.includes(step.executorId) && !assigned.has(step.executorId)) {
      assigned.add(step.executorId);
      assignments.set(step.id, step.executorId);
    }
  }
  for (const step of candidates.filter((candidate) => !candidate.executorId)) {
    const executorId = available.find((candidate) => !assigned.has(candidate));
    if (!executorId) break;
    assigned.add(executorId);
    assignments.set(step.id, executorId);
  }
  return candidates.filter((step) => assignments.has(step.id))
    .map((step) => ({ stepId: step.id, executorId: assignments.get(step.id) }));
}

function startAttempt(dag, input) {
  assertState(dag);
  exactObject(input, ['expectedRevision', 'stepId', 'executorId', 'requestId', 'baseCommit', 'budget', 'startedAt'], 'input');
  const requestId = identifier(input.requestId, 'requestId');
  const intent = {
    stepId: identifier(input.stepId, 'stepId'),
    executorId: identifier(input.executorId, 'executorId'),
    requestId,
    baseCommit: commit(input.baseCommit, 'baseCommit'),
    budget: normalizeBudget(input.budget, 'budget', { requirePositive: true }),
    startedAt: timestamp(input.startedAt, 'startedAt'),
  };
  for (const existingStep of dag.steps) {
    const existing = existingStep.attempts.find((attempt) => attempt.requestId === requestId);
    if (existing) {
      const existingIntent = Object.fromEntries(Object.keys(intent).map((key) => [key, existing[key]]));
      if (!same(existingIntent, intent)) fail('REQUEST_ID_CONFLICT', `requestId ${requestId} has different immutable fields`);
      return { dag: clone(dag), replayed: true };
    }
  }
  expectRevision(dag, input.expectedRevision);
  const next = clone(dag);
  const step = findStep(next, intent.stepId);
  if (!['pending', 'failed'].includes(step.state) || !dependenciesReady(next, step)) {
    fail('STEP_NOT_READY', `${step.id} is not ready`);
  }
  const expectedBaseCommit = currentAssemblyHead(next);
  if (intent.baseCommit !== expectedBaseCommit) {
    fail('BASE_COMMIT_CONFLICT', `${step.id} must start from current assembly head ${expectedBaseCommit}`);
  }
  if (step.attempts.length >= MAX_ATTEMPTS) fail('ATTEMPTS_EXHAUSTED', `${step.id} exhausted its attempts`);
  if (step.executorId && step.executorId !== intent.executorId) {
    fail('EXECUTOR_PIN_CONFLICT', `${step.id} is pinned to ${step.executorId}`);
  }
  if (next.steps.some((candidate) => candidate.id !== step.id
    && ['running', 'unknown'].includes(candidate.state) && candidate.executorId === intent.executorId)) {
    fail('EXECUTOR_BUSY', `${intent.executorId} already owns an unsettled attempt`);
  }
  for (const key of BUDGET_KEYS) {
    if (next.budget.spent[key] + next.budget.reserved[key] + intent.budget[key] > next.budget.limit[key]) {
      fail('BUDGET_EXHAUSTED', `${key} reservation exceeds aggregate limit`);
    }
    next.budget.reserved[key] += intent.budget[key];
  }
  step.executorId = intent.executorId;
  step.state = 'running';
  step.attempts.push({
    number: step.attempts.length + 1,
    ...intent,
    state: 'running',
    settlement: null,
    settlementFingerprint: null,
  });
  next.revision += 1;
  return { dag: assertState(next), replayed: false };
}

function normalizeTests(value, step) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) fail('INVALID_RECEIPT', 'tests must be a non-empty array');
  const tests = value.map((test, index) => {
    exactObject(test, ['target', 'profile', 'outcome', 'durationMs'], `tests[${index}]`);
    if (test.outcome !== 'passed') fail('INVALID_RECEIPT', 'verified test outcomes must be passed');
    if (!Number.isSafeInteger(test.durationMs) || test.durationMs < 0) fail('INVALID_RECEIPT', 'test durationMs must be non-negative');
    return {
      target: identifier(test.target, `tests[${index}].target`, 512),
      profile: identifier(test.profile, `tests[${index}].profile`, 160),
      outcome: 'passed',
      durationMs: test.durationMs,
    };
  });
  const covered = new Set(tests.map((test) => test.target));
  if (step.testTargets.some((target) => !covered.has(target))) fail('INVALID_RECEIPT', 'tests do not cover every planned test target');
  return tests;
}

function normalizeVerifiedReceipt(receipt, step) {
  exactObject(receipt, ['commit', 'changedPaths', 'tests', 'artifact', 'finishedAt'], 'receipt');
  if (!Array.isArray(receipt.changedPaths) || receipt.changedPaths.length === 0) {
    fail('INVALID_RECEIPT', 'changedPaths must be non-empty');
  }
  const changedPaths = [...new Set(receipt.changedPaths.map((path, index) => repositoryPath(path, `changedPaths[${index}]`)))].sort();
  if (changedPaths.some((path) => !step.paths.some((scope) => path === scope || path.startsWith(`${scope}/`)))) {
    fail('INVALID_RECEIPT', 'changedPaths exceed the step path scope');
  }
  exactObject(receipt.artifact, ['id', 'sha256', 'sizeBytes', 'format'], 'receipt.artifact');
  if (!Number.isSafeInteger(receipt.artifact.sizeBytes) || receipt.artifact.sizeBytes <= 0) {
    fail('INVALID_RECEIPT', 'artifact.sizeBytes must be a positive safe integer');
  }
  return {
    commit: commit(receipt.commit, 'receipt.commit'),
    changedPaths,
    tests: normalizeTests(receipt.tests, step),
    artifact: {
      id: identifier(receipt.artifact.id, 'receipt.artifact.id'),
      sha256: sha256(receipt.artifact.sha256, 'receipt.artifact.sha256'),
      sizeBytes: receipt.artifact.sizeBytes,
      format: identifier(receipt.artifact.format, 'receipt.artifact.format', 80),
    },
    finishedAt: timestamp(receipt.finishedAt, 'receipt.finishedAt'),
  };
}

function normalizeSettlement(input, step) {
  if (!['verified', 'failed', 'unknown'].includes(input.outcome)) fail('INVALID_OUTCOME', 'outcome must be verified, failed, or unknown');
  const actualUsage = normalizeBudget(input.actualUsage, 'actualUsage');
  if (input.outcome === 'verified') return { outcome: 'verified', actualUsage, receipt: normalizeVerifiedReceipt(input.receipt, step) };
  if (input.outcome === 'failed') {
    exactObject(input.receipt, ['code', 'finishedAt'], 'receipt');
    return {
      outcome: 'failed',
      actualUsage,
      receipt: { code: identifier(input.receipt.code, 'receipt.code', 160), finishedAt: timestamp(input.receipt.finishedAt, 'receipt.finishedAt') },
    };
  }
  exactObject(input.receipt, ['reason', 'observedAt'], 'receipt');
  return {
    outcome: 'unknown',
    actualUsage,
    receipt: {
      reason: identifier(input.receipt.reason, 'receipt.reason', 500),
      observedAt: timestamp(input.receipt.observedAt, 'receipt.observedAt'),
    },
  };
}

function settleAttempt(dag, input) {
  assertState(dag);
  exactObject(input, ['expectedRevision', 'requestId', 'outcome', 'actualUsage', 'receipt'], 'input');
  const requestId = identifier(input.requestId, 'requestId');
  const located = dag.steps
    .map((step) => ({ step, attempt: step.attempts.find((candidate) => candidate.requestId === requestId) }))
    .find((entry) => entry.attempt);
  if (!located) fail('ATTEMPT_NOT_FOUND', `unknown requestId ${requestId}`);
  const settlement = normalizeSettlement(input, located.step);
  const settlementFingerprint = fingerprint(settlement);
  if (located.attempt.settlementFingerprint) {
    if (located.attempt.settlementFingerprint !== settlementFingerprint) fail('SETTLEMENT_CONFLICT', 'attempt already has a different settlement');
    return { dag: clone(dag), replayed: true };
  }
  expectRevision(dag, input.expectedRevision);
  if (located.attempt.state !== 'running') fail('ATTEMPT_NOT_SETTLEABLE', 'attempt is not running');
  for (const key of BUDGET_KEYS) {
    if (settlement.actualUsage[key] > located.attempt.budget[key]) fail('USAGE_EXCEEDS_RESERVATION', `${key} exceeds its reservation`);
  }
  const next = clone(dag);
  const step = findStep(next, located.step.id);
  const attempt = step.attempts.find((candidate) => candidate.requestId === requestId);
  attempt.state = settlement.outcome;
  attempt.settlement = settlement;
  attempt.settlementFingerprint = settlementFingerprint;
  if (settlement.outcome === 'unknown') {
    step.state = 'unknown';
  } else {
    for (const key of BUDGET_KEYS) {
      next.budget.reserved[key] -= attempt.budget[key];
      next.budget.spent[key] += settlement.actualUsage[key];
    }
    step.state = settlement.outcome;
    if (settlement.outcome === 'verified') step.verifiedReceipt = clone(settlement.receipt);
  }
  next.revision += 1;
  return { dag: assertState(next), replayed: false };
}

function reconcileUnknown(dag, input) {
  assertState(dag);
  exactObject(input, ['expectedRevision', 'requestId', 'outcome', 'actualUsage', 'receipt'], 'input');
  if (!['verified', 'failed'].includes(input.outcome)) fail('INVALID_OUTCOME', 'unknown attempts reconcile to verified or failed');
  const requestId = identifier(input.requestId, 'requestId');
  const located = dag.steps
    .map((step) => ({ step, attempt: step.attempts.find((candidate) => candidate.requestId === requestId) }))
    .find((entry) => entry.attempt);
  if (!located) fail('ATTEMPT_NOT_FOUND', `unknown requestId ${requestId}`);
  const settlement = normalizeSettlement(input, located.step);
  const settlementFingerprint = fingerprint(settlement);
  if (['verified', 'failed'].includes(located.attempt.state)) {
    if (located.attempt.settlementFingerprint !== settlementFingerprint) {
      fail('RECONCILIATION_CONFLICT', 'attempt already has a different reconciled settlement');
    }
    return { dag: clone(dag), replayed: true };
  }
  if (located.attempt.state !== 'unknown') fail('ATTEMPT_NOT_UNKNOWN', 'attempt is not unknown');
  expectRevision(dag, input.expectedRevision);
  for (const key of BUDGET_KEYS) {
    if (settlement.actualUsage[key] > located.attempt.budget[key]) fail('USAGE_EXCEEDS_RESERVATION', `${key} exceeds its reservation`);
  }
  const next = clone(dag);
  const step = findStep(next, located.step.id);
  const attempt = step.attempts.find((candidate) => candidate.requestId === requestId);
  for (const key of BUDGET_KEYS) {
    next.budget.reserved[key] -= attempt.budget[key];
    next.budget.spent[key] += settlement.actualUsage[key];
  }
  attempt.state = settlement.outcome;
  attempt.settlement = settlement;
  attempt.settlementFingerprint = settlementFingerprint;
  step.state = settlement.outcome;
  if (settlement.outcome === 'verified') step.verifiedReceipt = clone(settlement.receipt);
  next.revision += 1;
  return { dag: assertState(next), replayed: false };
}

function adoptionOrder(dag) {
  assertState(dag);
  const remaining = new Set(dag.plan.steps.map((step) => step.id));
  const adopted = new Set();
  const order = [];
  while (remaining.size) {
    const step = dag.plan.steps.find(
      (candidate) => remaining.has(candidate.id) && candidate.effectiveDependsOn.every((dependency) => adopted.has(dependency)),
    );
    if (!step) fail('INVALID_DAG', 'step dependency graph contains a cycle');
    remaining.delete(step.id);
    adopted.add(step.id);
    order.push(step.id);
  }
  return order;
}

function recordAdoption(dag, input) {
  assertState(dag);
  exactObject(input, ['expectedRevision', 'stepId', 'sourceCommit', 'parentCommit', 'adoptedCommit', 'artifactSha256', 'adoptedAt'], 'input');
  const adoption = {
    stepId: identifier(input.stepId, 'stepId'),
    sourceCommit: commit(input.sourceCommit, 'sourceCommit'),
    parentCommit: commit(input.parentCommit, 'parentCommit'),
    adoptedCommit: commit(input.adoptedCommit, 'adoptedCommit'),
    artifactSha256: sha256(input.artifactSha256, 'artifactSha256'),
    adoptedAt: timestamp(input.adoptedAt, 'adoptedAt'),
  };
  const existing = dag.assembly.adoptions.find((candidate) => candidate.stepId === adoption.stepId);
  if (existing) {
    if (!same(existing, adoption)) fail('ADOPTION_CONFLICT', `${adoption.stepId} has a different adoption receipt`);
    return { dag: clone(dag), replayed: true };
  }
  expectRevision(dag, input.expectedRevision);
  const order = adoptionOrder(dag);
  const expectedStepId = order[dag.assembly.adoptions.length];
  if (adoption.stepId !== expectedStepId) fail('ADOPTION_ORDER_CONFLICT', `expected adoption of ${expectedStepId}`);
  const step = findStep(dag, adoption.stepId);
  if (step.state !== 'verified' || !step.verifiedReceipt) {
    fail('STEP_NOT_VERIFIED', `${step.id} must be verified before adoption`);
  }
  if (
    adoption.sourceCommit !== step.verifiedReceipt.commit ||
    adoption.artifactSha256 !== step.verifiedReceipt.artifact.sha256
  ) {
    fail('ADOPTION_RECEIPT_MISMATCH', 'adoption does not match the verified step receipt');
  }
  const expectedParent = dag.assembly.adoptions.length
    ? dag.assembly.adoptions[dag.assembly.adoptions.length - 1].adoptedCommit
    : dag.sourceCommit;
  if (adoption.parentCommit !== expectedParent) fail('ADOPTION_PARENT_CONFLICT', `expected parent ${expectedParent}`);
  const next = clone(dag);
  next.assembly.state = 'adopting';
  next.assembly.adoptions.push(adoption);
  next.revision += 1;
  return { dag: assertState(next), replayed: false };
}

function completeAssembly(dag, input) {
  assertState(dag);
  exactObject(input, ['expectedRevision', 'headCommit', 'tests', 'artifact', 'completedAt'], 'input');
  const order = adoptionOrder(dag);
  if (dag.steps.some((step) => step.state !== 'verified')) {
    fail('DAG_NOT_VERIFIED', 'every step must be verified before completing assembly');
  }
  if (dag.assembly.adoptions.length !== order.length) fail('ASSEMBLY_INCOMPLETE', 'not every verified step has been adopted');
  const expectedHead = currentAssemblyHead(dag);
  const pseudoStep = { testTargets: [...new Set(dag.steps.flatMap((step) => step.testTargets))] };
  exactObject(input.artifact, ['id', 'sha256', 'sizeBytes', 'format'], 'artifact');
  if (!Number.isSafeInteger(input.artifact.sizeBytes) || input.artifact.sizeBytes <= 0) fail('INVALID_RECEIPT', 'artifact size must be positive');
  const completion = {
    headCommit: commit(input.headCommit, 'headCommit'),
    tests: normalizeTests(input.tests, pseudoStep),
    artifact: {
      id: identifier(input.artifact.id, 'artifact.id'),
      sha256: sha256(input.artifact.sha256, 'artifact.sha256'),
      sizeBytes: input.artifact.sizeBytes,
      format: identifier(input.artifact.format, 'artifact.format', 80),
    },
    completedAt: timestamp(input.completedAt, 'completedAt'),
  };
  if (dag.assembly.completion) {
    if (!same(dag.assembly.completion, completion)) fail('ASSEMBLY_COMPLETION_CONFLICT', 'assembly already has a different completion receipt');
    return { dag: clone(dag), replayed: true };
  }
  expectRevision(dag, input.expectedRevision);
  if (completion.headCommit !== expectedHead) fail('ASSEMBLY_HEAD_CONFLICT', `expected assembly head ${expectedHead}`);
  const next = clone(dag);
  next.assembly.state = 'verified';
  next.assembly.completion = completion;
  next.state = 'verified';
  next.revision += 1;
  return { dag: assertState(next), replayed: false };
}

module.exports = {
  BUDGET_KEYS,
  MAX_ATTEMPTS,
  PipelineCodeDagError,
  create,
  readySet,
  startAttempt,
  settleAttempt,
  reconcileUnknown,
  adoptionOrder,
  recordAdoption,
  completeAssembly,
};
