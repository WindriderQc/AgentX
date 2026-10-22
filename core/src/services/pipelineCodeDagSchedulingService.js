'use strict';

const MAX_ATTEMPTS = 3;

class PipelineCodeDagSchedulingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PipelineCodeDagSchedulingError';
    this.code = code;
  }
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) {
    throw new PipelineCodeDagSchedulingError('INVALID_EXECUTORS', `${label} must be a bounded identifier`);
  }
  return value.trim();
}

function dependenciesReady(dag, step) {
  const adopted = new Set(dag.assembly.adoptions.map(adoption => adoption.stepId));
  const frozenStep = dag.plan.steps.find(candidate => candidate.id === step.id);
  if (!frozenStep) throw new PipelineCodeDagSchedulingError('INVALID_DAG', `${step.id} is missing from the frozen plan`);
  return frozenStep.effectiveDependsOn.every(dependencyId => {
    const dependency = dag.steps.find(candidate => candidate.id === dependencyId);
    return dependency?.state === 'verified' && adopted.has(dependencyId);
  });
}

function readySet(dag, availableExecutorIds) {
  if (!Array.isArray(availableExecutorIds)) {
    throw new PipelineCodeDagSchedulingError('INVALID_EXECUTORS', 'availableExecutorIds must be an array');
  }
  const busy = new Set(dag.steps.filter(step => ['running', 'unknown'].includes(step.state)).map(step => step.executorId));
  const available = [...new Set(availableExecutorIds.map((value, index) => identifier(value, `availableExecutorIds[${index}]`)))]
    .filter(executorId => !busy.has(executorId));
  const candidates = dag.steps.filter(step => ['pending', 'failed'].includes(step.state)
    && step.attempts.length < MAX_ATTEMPTS && dependenciesReady(dag, step));
  const assigned = new Set();
  const assignments = new Map();
  for (const step of candidates.filter(candidate => candidate.executorId)) {
    if (available.includes(step.executorId) && !assigned.has(step.executorId)) {
      assigned.add(step.executorId);
      assignments.set(step.id, step.executorId);
    }
  }
  for (const step of candidates.filter(candidate => !candidate.executorId)) {
    const executorId = available.find(candidate => !assigned.has(candidate));
    if (!executorId) break;
    assigned.add(executorId);
    assignments.set(step.id, executorId);
  }
  return candidates.filter(step => assignments.has(step.id))
    .map(step => ({ stepId: step.id, executorId: assignments.get(step.id) }));
}

module.exports = { MAX_ATTEMPTS, PipelineCodeDagSchedulingError, dependenciesReady, readySet };
