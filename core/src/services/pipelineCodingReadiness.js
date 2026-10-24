'use strict';
const { basis } = require('./pipelineCodingAutonomyPolicy');
const { createHash } = require('node:crypto');
const workerScope = require('../helpers/workerTaskScope');
const SCHEMA = 'agentx.coding-readiness/v1';
const PROFILES = Object.freeze({
  'agentx-dispatcher-tests/v1': path => path.startsWith('integrations/coding/'),
  'agentx-core-runner-tests/v1': path => ['core/src/services/inferenceRuntimePolicy.js',
    'core/tests/unit/inferenceRuntimePolicy.test.js'].includes(path),
  'agentx-benchmark-artifact-tests/v1': path => /^benchmark\/src\/services\/benchmark\/(artifactComparison(?:Contract|Coverage)?|pairedStatistics|regressionDetector)\.js$/.test(path)
    || /^benchmark\/tests\/unit\/benchmark\/(artifactComparison\w*|pairedStatistics|regressionDetector\.paired)\.test\.js$/.test(path),
});
const SUPPORTED = new Set(['source_read', 'source_write', 'cpu_tests']);
const CAPABILITIES = [...SUPPORTED, 'network', 'private_data', 'live_inference', 'deployment', 'physical_device'];
const verificationProfile = task => task.codingAutonomy?.verificationProfile || task.automation?.verificationProfile;
const taskBasis = task => createHash('sha256').update(JSON.stringify([basis(task),
  (Array.isArray(task.automation?.scope) ? [...task.automation.scope].sort() : []), verificationProfile(task) || null])).digest('hex');
function invalid(message) {
  return Object.assign(new Error(message), { code: 'CODING_READINESS_INVALID', statusCode: 400 });
}
function definition(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['acceptanceCriteria', 'requiredCapabilities', 'estimate'].includes(key)))
    throw invalid('Describe acceptance criteria, required capabilities and the estimated work.');
  const criteria = value.acceptanceCriteria;
  const capabilities = value.requiredCapabilities;
  const estimate = value.estimate;
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > 12
    || criteria.some(text => typeof text !== 'string' || !text.trim() || text.length > 500))
    throw invalid('Supply one to twelve observable acceptance criteria, at most 500 characters each.');
  if (!Array.isArray(capabilities) || !capabilities.length || capabilities.length > CAPABILITIES.length
    || new Set(capabilities).size !== capabilities.length || capabilities.some(item => !CAPABILITIES.includes(item)))
    throw invalid('Select the capabilities the task actually needs. Unknown capabilities are not assumed available.');
  if (!estimate || typeof estimate !== 'object' || Array.isArray(estimate)
    || Object.keys(estimate).some(key => !['workSeconds', 'modelCalls'].includes(key))
    || !['workSeconds', 'modelCalls'].every(key => Number.isSafeInteger(estimate[key]) && estimate[key] > 0))
    throw invalid('Supply positive whole-number estimates for work seconds and model calls.');
  return { acceptanceCriteria: criteria.map(text => text.trim()), requiredCapabilities: [...capabilities].sort(),
    estimate: { workSeconds: estimate.workSeconds, modelCalls: estimate.modelCalls } };
}

// Necessary conditions, not a prediction of model competence. No model calls,
// queue reservations, task mutations or dependency installation occur here.
function assess(task, limits, proposed) {
  const declared = definition(proposed);
  const issues = [];
  const add = (code, status, message, nextAction) => issues.push({ code, status, message, nextAction });
  if (task.service !== 'agentx-coding' || !workerScope.contains(task) || task.profileId || task.origin === 'family')
    add('workflow_not_supported', 'unsupported_by_worker', 'This task is outside the engineering coding workflow.',
      'Keep personal and family work in its owning workflow; engineering handoff remains explicit.');
  if (!declared) add('acceptance_not_defined', 'needs_clarification',
    'The task has no reviewed acceptance criteria or capability requirements.',
    'Describe observable success, required access and estimated work before authorizing a worker.');
  const profile = verificationProfile(task);
  if (!limits) add('budget_missing', 'needs_clarification', 'No work envelope has been selected.', 'Select work and model-call limits for this assessment.');
  const covered = PROFILES[profile];
  if (!covered) add('verification_unavailable', 'missing_prerequisite',
    'No supported independent verification profile is selected.', 'Select an installed verification profile.');
  const scope = task.automation?.scope;
  if (!Array.isArray(scope) || !scope.length) add('scope_missing', 'needs_clarification',
    'No exact source scope is selected.', 'Select the files this worker may change.');
  else if (scope.some(path => typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')))
    add('scope_invalid', 'needs_clarification', 'The scope contains an invalid repository path.', 'Use exact repository-relative file paths.');
  else if (covered && scope.some(path => !covered(path) && !path.endsWith('.md')))
    add('verification_scope_mismatch', 'missing_prerequisite',
      'The verification profile does not cover every selected code area.',
      'Split the task by verified area or provide a matching runner-owned verification profile.');
  for (const capability of declared?.requiredCapabilities || []) if (!SUPPORTED.has(capability))
    add(`capability_${capability}`, 'unsupported_by_worker',
      `This isolated coding worker cannot supply ${capability}.`,
      'Separate that work and its receipt from the offline source change; keep native ownership and approval.');
  if (declared && limits) for (const key of ['workSeconds', 'modelCalls']) {
    if (!Number.isSafeInteger(limits[key]) || declared.estimate[key] > limits[key])
      add(`estimate_exceeds_${key}`, 'needs_decomposition',
        `The reviewed ${key} estimate exceeds the authorized envelope.`,
        'Reduce the scope or review a different envelope; no budget is increased automatically.');
  }
  const status = ['unsupported_by_worker', 'missing_prerequisite', 'needs_clarification', 'needs_decomposition']
    .find(value => issues.some(issue => issue.status === value)) || 'ready';
  return { schema: SCHEMA, status, canAuthorize: issues.length === 0, executionAuthority: 'none', taskBasis: taskBasis(task),
    issues, definition: declared, verificationProfile: profile || null,
    evidence: 'Deterministic contract checks; criteria, capabilities and estimates are operator-declared. Source availability, runtime admission and model competence require their own receipts.' };
}
function assertReady(task, limits, proposed) {
  const view = assess(task, limits, proposed);
  if (!view.canAuthorize) throw Object.assign(new Error(view.issues.map(issue => issue.message + ' ' + issue.nextAction).join(' ')),
    { code: 'CODING_TASK_NOT_READY', statusCode: 409 });
  return view;
}
module.exports = { SCHEMA, CAPABILITIES, definition, assess, assertReady, taskBasis };
