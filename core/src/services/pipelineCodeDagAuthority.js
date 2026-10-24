'use strict';

const { fingerprint } = require('../../../shared/codeStepDagContract');
const policy = require('./pipelineCodingAutonomyPolicy');
const intake = require('./taskIntakePolicy');
const workerScope = require('../helpers/workerTaskScope');
const same = (left, right) => fingerprint(left) === fingerprint(right);
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code, message, statusCode = 409) => { throw policy.fail(message, code, statusCode); };

// Receipt settlement preserves the original root identity. It never grants a
// new attempt, inference or executable manifest after revocation/scope changes.
const SETTLEMENT_OPERATIONS = new Set(['settleInference', 'reconcileInference', 'settleAttempt', 'reconcileUnknown', 'recordAdoption', 'completeAssembly', 'terminalize']);
function assertCurrent(task) {
  if (!workerScope.contains(task) || task.profileId || task.origin === 'family') {
    fail('DAG_PRIVATE_SCOPE', 'Private and household work cannot enter a coding delegation');
  }
  intake.assertAccepted(task);
  if (task.codingAutonomy.basis !== policy.basis(task)) {
    fail('DAG_ROOT_NOT_ACTIVE', 'The current task content no longer matches its reviewed coding authority');
  }
}
function currentFilter(task) {
  const fields = ['title', 'spec', 'service', 'source', 'profileId', 'origin', 'automation.fingerprint',
    'automation.scope', 'automation.lockKeys', 'intake.revision'];
  return Object.fromEntries(fields.map(path => {
    const value = path.split('.').reduce((current, key) => current?.[key], task);
    return [path, value === undefined ? { $exists: false } : value];
  }));
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

function authority(task, input, { settlement = false } = {}) {
  const current = latestRun(task);
  const state = task?.codingAutonomy;
  if (!current || (!settlement && (state?.authorized !== true || current.run.finishedAt))) {
    fail('DAG_ROOT_NOT_ACTIVE', 'The task has no active autonomous root run');
  }
  if (state.basis !== input.taskBasis || current.run.requestId !== input.rootRequestId) {
    fail('DAG_ROOT_CHANGED', 'The autonomous task basis or root request changed');
  }
  if (!settlement) assertCurrent(task);
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

function authorityFilter(task, binding, { settlement = false } = {}) {
  return {
    ...(!settlement && currentFilter(task)),
    pipelineId: task.pipelineId,
    'codingAutonomy.authorized': task.codingAutonomy.authorized,
    'codingAutonomy.basis': binding.taskBasis,
    'codingAutonomy.revision': binding.autonomyRevision,
    [`codingAutonomy.runs.${binding.runIndex}.requestId`]: binding.rootRequestId,
    [`codingAutonomy.runs.${binding.runIndex}.${binding.sourceField}`]: binding.sourceCommit,
    [`codingAutonomy.runs.${binding.runIndex}.finishedAt`]: task.codingAutonomy.runs[binding.runIndex].finishedAt ?? { $exists: false },
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

module.exports = { authority, authorityFilter, sameAuthority, frozenAuthority, assertReviewedAuthority, SETTLEMENT_OPERATIONS };
