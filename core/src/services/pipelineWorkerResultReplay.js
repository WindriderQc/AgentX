'use strict';

const { createHash } = require('node:crypto');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function workerResultFingerprint(body) {
  return createHash('sha256').update(JSON.stringify(stable(body))).digest('hex');
}

// A replay is proof of the same completed attempt and request, not permission
// to submit a new result. Legacy attempts without a fingerprint stay fenced.
function recordedWorkerResult(task, body) {
  const leaseId = String(body?.leaseId || '').trim();
  const assignee = String(body?.leaseAssignee || body?.assignee || body?.by || '').trim();
  if (!leaseId || !assignee) return null;
  const attempt = task?.automationAttempts?.find(item => String(item.leaseId) === leaseId);
  if (!attempt || !attempt.completedAt || !['review', 'blocked'].includes(attempt.finalState)
    || String(attempt.assignee) !== assignee
    || attempt.resultRequestFingerprint !== workerResultFingerprint(body)) return null;
  return { leaseId, pipelineId: task.pipelineId, assignee, attempt: Number(attempt.attempt) };
}

module.exports = { workerResultFingerprint, recordedWorkerResult };
