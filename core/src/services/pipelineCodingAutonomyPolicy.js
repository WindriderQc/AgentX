'use strict';
const crypto = require('node:crypto');
const workerScope = require('../helpers/workerTaskScope');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');
const DEFAULT_LIMITS = Object.freeze({ maxResumes: 2, workSeconds: 14400, testSeconds: 4800,
  modelSeconds: 5400, modelCalls: 128, ciSeconds: 3600, noProgressSeconds: 2700 });
const CHECKS = ['tests (core)', 'tests (benchmark)', 'tests (rag)', 'tests (data)', 'compose'];
const fail = (message, code = 'CODING_AUTONOMY_CONFLICT', statusCode = 409) =>
  Object.assign(new Error(message), { code, statusCode, status: statusCode });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const basis = task => digest([task.title, task.spec, task.service, task.automation?.fingerprint]);
function limits(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !(k in DEFAULT_LIMITS)))
    throw fail('Unsupported coding budget', 'CODING_AUTONOMY_INVALID', 400);
  const value = { ...DEFAULT_LIMITS, ...raw };
  for (const [key, item] of Object.entries(value)) {
    const minimum = key === 'maxResumes' ? 0 : key === 'workSeconds' ? 10 : 1;
    if (!Number.isSafeInteger(item) || item < minimum || item > DEFAULT_LIMITS[key])
      throw fail(`Invalid ${key}`, 'CODING_AUTONOMY_INVALID', 400);
  }
  return value;
}
function assertTask(task) {
  if (!task || task.service !== 'agentx-coding' || !workerScope.contains(task) || task.profileId || task.origin === 'family')
    throw fail('Only explicitly routed engineering tasks can be authorized', 'CODING_AUTONOMY_PRIVATE');
  const automation = normalizePipelineAutomationIntent(task.automation);
  if (automation.mode !== 'review_only' || task.risk !== 'low' || !['public', 'internal'].includes(automation.dataClassification))
    throw fail('A reviewed low-risk public/internal automation scope is required', 'CODING_AUTONOMY_SCOPE');
  if (automation.budgets.maxDurationMs < 10000)
    throw fail('The reviewed duration must support a native lease of at least 10000 ms', 'CODING_AUTONOMY_SCOPE');
  return automation;
}
function remaining(task) {
  const state = task.codingAutonomy;
  const spent = state.spent || {};
  return Object.fromEntries(Object.entries(state.limits).map(([key, value]) => [key,
    key === 'maxResumes' ? Math.max(0, value - Math.max(0, state.runs.length - 1)) : Math.max(0, value - (spent[key] || 0))]));
}
function exhausted(task) {
  const rem = remaining(task);
  return ['workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls', 'ciSeconds'].find(k => rem[k] <= 0) || null;
}
function compare(a, b, now = Date.now()) {
  // Aging eventually outranks every newly authorized priority. Stable ID breaks ties.
  const rank = t => (t.priority || 3) - Math.floor((now - Date.parse(t.codingAutonomy.authorizedAt)) / 21600000);
  return rank(a) - rank(b) || a.codingAutonomy.authorizedAt.localeCompare(b.codingAutonomy.authorizedAt)
    || a.pipelineId.localeCompare(b.pipelineId);
}
function verdict(observation, expected) {
  if (observation.head !== expected.head) return 'stale';
  if (observation.state !== 'open') return 'closed';
  if (observation.mergeable === 'conflict') return 'conflict';
  if (observation.mergeable !== 'clean') return 'pending';
  const checks = observation.checks || [];
  if (CHECKS.some(name => !checks.some(c => c.name === name && c.head === expected.head))) return 'pending';
  const current = checks.filter(c => CHECKS.includes(c.name) && c.head === expected.head);
  if (current.some(c => ['failure', 'cancelled', 'timeout'].includes(c.state))) return 'failure';
  return current.every(c => c.state === 'success') ? 'success' : 'pending';
}
module.exports = { DEFAULT_LIMITS, CHECKS, fail, digest, basis, limits, assertTask, remaining, exhausted, compare, verdict };
