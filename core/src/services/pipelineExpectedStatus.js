'use strict';

const { observedVersion, repairGuardQuery } = require('./pipelineTaskDiagnosis');

function statusError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// Optional compare-and-set for an operator acting on a diagnosis. The client
// sends the entire public observedVersion; Core compares it with the current
// read and then puts the same state into the atomic status-update predicate.
function expectedStatusGuard(task, expected) {
  const observed = observedVersion(task);
  const keys = Object.keys(observed);
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)
    || Object.keys(expected).length !== keys.length || keys.some(key => !Object.hasOwn(expected, key))) {
    throw statusError(400, 'INVALID_EXPECTED_VERSION', 'expected must be the complete diagnosis observedVersion');
  }
  if (keys.some(key => expected[key] !== observed[key])) {
    throw statusError(409, 'TASK_EXPECTED_VERSION_CONFLICT', 'Task changed since the diagnosis; reload it');
  }
  const guard = repairGuardQuery(task.pipelineId, observed);
  // The diagnosis helper omits zero for legacy reads. A status write must also
  // reject a concurrent first attempt while accepting legacy absent counters.
  if (observed.automationAttemptCount === 0) guard.automationAttemptCount = { $in: [0, null] };
  guard['automationLease.leaseId'] = task.automationLease?.leaseId || null;
  return guard;
}

module.exports = { expectedStatusGuard };
