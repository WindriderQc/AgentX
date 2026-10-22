'use strict';

const { fingerprint } = require('../../../shared/codeStepDagContract');
const { MAX_ATTEMPTS, assertState } = require('./pipelineCodeDagService');

const TERMINAL_STATES = new Set(['failed', 'blocked']);
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

function receipt(input) {
  const required = ['expectedRevision', 'state', 'code', 'reason', 'finishedAt'];
  const allowed = new Set([...required, 'stepId']);
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
  return { state: input.state, code: input.code, reason: input.reason.trim(),
    stepId, finishedAt: new Date(input.finishedAt).toISOString() };
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
  const next = clone(dag);
  next.state = terminal.state;
  next.assembly.state = terminal.state;
  next.terminalFailure = terminal;
  next.terminalFailureFingerprint = fingerprint(terminal);
  next.revision += 1;
  return { dag: assertState(next), replayed: false };
}

module.exports = { PipelineCodeDagTerminalError, terminalize };
