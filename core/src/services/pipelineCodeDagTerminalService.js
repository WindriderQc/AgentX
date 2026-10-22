'use strict';

const { fingerprint } = require('../../../shared/codeStepDagContract');
const { MAX_ATTEMPTS, assertState } = require('./pipelineCodeDagService');

const TERMINAL_STATES = new Set(['failed', 'blocked']);
const FINAL_ASSEMBLY_CODES = new Set([
  'assembly_verification_failed',
  'assembly_source_changed',
  'assembly_publication_failed',
  'assembly_budget_exhausted',
]);
const CODE = /^[a-z][a-z0-9_]{0,119}$/;
const STEP = /^step-(?:0[1-9]|1[0-6])$/;

class PipelineCodeDagTerminalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PipelineCodeDagTerminalError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PipelineCodeDagTerminalError(code, message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function zeroUsage() {
  return { workSeconds: 0, testSeconds: 0, modelSeconds: 0, modelCalls: 0 };
}

function finalTests(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    fail('INVALID_TERMINAL_RECEIPT', 'final assembly failure requires bounded test receipts');
  }
  return value.map((test, index) => {
    const fields = Object.keys(test || {}).sort();
    const hasBudgetedDuration = fields.includes('budgetedDurationMs');
    const expectedFields = hasBudgetedDuration
      ? 'budgetedDurationMs,durationMs,outcome,profile,target' : 'durationMs,outcome,profile,target';
    if (fields.join(',') !== expectedFields
      || typeof test.target !== 'string' || !test.target.trim() || test.target.trim().length > 512
      || typeof test.profile !== 'string' || !test.profile.trim() || test.profile.trim().length > 160
      || !['passed', 'failed'].includes(test.outcome)
      || !Number.isSafeInteger(test.durationMs) || test.durationMs < 0 || test.durationMs > 604_800_000
      || hasBudgetedDuration && (!Number.isSafeInteger(test.budgetedDurationMs)
        || test.budgetedDurationMs < 0 || test.budgetedDurationMs > test.durationMs)) {
      fail('INVALID_TERMINAL_RECEIPT', `tests[${index}] is invalid`);
    }
    return { target: test.target.trim(), profile: test.profile.trim(), outcome: test.outcome,
      durationMs: test.durationMs, ...(hasBudgetedDuration && { budgetedDurationMs: test.budgetedDurationMs }) };
  });
}

function receipt(input) {
  const required = ['expectedRevision', 'state', 'code', 'reason', 'finishedAt'];
  const allowed = new Set([...required, 'stepId', 'tests']);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || required.some(key => !Object.prototype.hasOwnProperty.call(input, key))
    || Object.keys(input).some(key => !allowed.has(key))) {
    fail('INVALID_TERMINAL_RECEIPT', 'terminal input has invalid fields');
  }
  const stepId = input.stepId ?? null;
  if (!TERMINAL_STATES.has(input.state) || !CODE.test(input.code || '')
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 500
    || /[\u0000-\u001f\u007f]/.test(input.reason)
    || stepId !== null && !STEP.test(stepId || '')
    || typeof input.finishedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.finishedAt)
    || Number.isNaN(Date.parse(input.finishedAt))) {
    fail('INVALID_TERMINAL_RECEIPT', 'terminal state, code, reason, step and timestamp must be bounded');
  }
  const tests = input.tests == null ? null : finalTests(input.tests);
  return { state: input.state, code: input.code, reason: input.reason.trim(),
    stepId, finishedAt: new Date(input.finishedAt).toISOString(), ...(tests && { tests }) };
}

function terminalize(dag, input) {
  assertState(dag);
  const terminal = receipt(input);
  if (dag.terminalFailure) {
    const storedFingerprint = dag.terminalFailureFingerprint || fingerprint(dag.terminalFailure);
    if (storedFingerprint !== fingerprint(dag.terminalFailure)) {
      fail('INVALID_DAG', 'the durable terminal receipt fingerprint does not match its receipt');
    }
    if (fingerprint(dag.terminalFailure) !== fingerprint(terminal)) {
      fail('TERMINAL_RECEIPT_CONFLICT', 'the code-step graph already has a different terminal receipt');
    }
    return { dag: clone(dag), replayed: true };
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== dag.revision) {
    fail('REVISION_CONFLICT', `expected revision ${input.expectedRevision}; current revision is ${dag.revision}`);
  }
  if (dag.state !== 'executing' || dag.steps.some(step => ['running', 'unknown'].includes(step.state)
    || step.attempts.some(attempt => attempt.pendingInferences?.length))) {
    fail('DAG_NOT_TERMINALIZABLE', 'settle every child attempt and inference before terminalizing the graph');
  }
  if (terminal.code === 'cumulative_budget_exhausted'
    && (terminal.state !== 'blocked' || terminal.stepId !== null)) {
    fail('INVALID_TERMINAL_RECEIPT', 'cumulative budget exhaustion is a graph-level blocked result');
  }
  if (terminal.code === 'step_attempts_exhausted') {
    const step = dag.steps.find(candidate => candidate.id === terminal.stepId);
    if (terminal.state !== 'failed' || !step || step.state !== 'failed' || step.attempts.length < MAX_ATTEMPTS) {
      fail('INVALID_TERMINAL_RECEIPT', 'attempt exhaustion must name its failed exhausted step');
    }
  }
  let assemblyUsage = zeroUsage();
  if (FINAL_ASSEMBLY_CODES.has(terminal.code)) {
    const order = dag.plan.steps.map(step => step.id);
    const covered = new Set((terminal.tests || []).map(test => test.target));
    const requiredTargets = new Set(dag.steps.flatMap(step => step.testTargets));
    const publicationFailure = terminal.code === 'assembly_publication_failed';
    const verificationFailure = terminal.code === 'assembly_verification_failed';
    const budgetFailure = terminal.code === 'assembly_budget_exhausted';
    if (terminal.state !== (budgetFailure ? 'blocked' : 'failed') || terminal.stepId !== null
      || dag.steps.some(step => step.state !== 'verified')
      || dag.assembly.adoptions.length !== order.length
      || !terminal.tests || covered.size !== requiredTargets.size
      || terminal.tests.length !== requiredTargets.size
      || [...requiredTargets].some(target => !covered.has(target))
      || (publicationFailure && terminal.tests.some(test => test.outcome !== 'passed'))
      || (verificationFailure && terminal.tests.every(test => test.outcome === 'passed'))
      || terminal.tests.some(test => Object.hasOwn(test, 'budgetedDurationMs') !== budgetFailure)) {
      fail('INVALID_TERMINAL_RECEIPT', 'final assembly failure must follow complete adoption and exact final verification');
    }
    const durationSeconds = Math.ceil(Math.max(...terminal.tests.map(test =>
      test.budgetedDurationMs ?? test.durationMs)) / 1000);
    assemblyUsage = { ...zeroUsage(), workSeconds: durationSeconds, testSeconds: durationSeconds };
  } else if (terminal.tests) {
    fail('INVALID_TERMINAL_RECEIPT', 'only a final assembly failure may carry final test receipts');
  }
  const next = clone(dag);
  next.assembly.usage ||= zeroUsage();
  for (const key of Object.keys(assemblyUsage)) {
    if (next.budget.spent[key] + next.budget.reserved[key] + assemblyUsage[key] > next.budget.limit[key]) {
      fail('ASSEMBLY_BUDGET_EXHAUSTED', `final assembly ${key} usage exceeds the aggregate limit`);
    }
    next.budget.spent[key] += assemblyUsage[key];
    next.assembly.usage[key] += assemblyUsage[key];
  }
  next.state = terminal.state;
  next.assembly.state = terminal.state;
  next.terminalFailure = terminal;
  next.terminalFailureFingerprint = fingerprint(terminal);
  next.revision += 1;
  return { dag: assertState(next), replayed: false };
}

module.exports = { PipelineCodeDagTerminalError, terminalize };
