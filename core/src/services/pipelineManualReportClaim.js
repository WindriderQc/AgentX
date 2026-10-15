'use strict';
const crypto = require('crypto');
const scope = require('../helpers/workerTaskScope');
const fail = (message, code = 'REPORT_CLAIM_CHANGED', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const specHash = task => crypto.createHash('sha256').update(String(task.spec || '')).digest('hex');

function query(task, claim, statuses = ['in_progress']) {
  const latest = (task.transitions || []).slice().reverse().find(row => row.kind === 'claimed');
  if (!claim || !Number.isSafeInteger(claim.claimSeq) || claim.claimSeq < 1 || !/^[a-f0-9]{64}$/.test(claim.specSha256 || ''))
    throw fail('Report needs its exact claim and specification digest', 'REPORT_CLAIM_INVALID', 400);
  if (!scope.contains(task) || !statuses.includes(task.status) || task.assignee !== 'coding-team'
    || task.automationLease?.leaseId || task.codingAutonomy || task.automation?.mode === 'review_only' || Number(task.automationAttemptCount) > 0
    || (task.automationAttempts || []).length || (claim.taskId && String(task._id) !== claim.taskId)
    || latest?.seq !== claim.claimSeq || specHash(task) !== claim.specSha256)
    throw fail('The original manual report claim no longer owns this scope');
  return { _id: task._id, pipelineId: task.pipelineId, status: task.status, assignee: 'coding-team', transitionSeq: task.transitionSeq,
    spec: task.spec, 'automation.mode': task.automation?.mode ?? null, 'automationLease.leaseId': null, codingAutonomy: task.codingAutonomy ?? null,
    automationAttemptCount: { $in: [0, null] },
    $and: [scope(), { service: task.service ?? null, source: task.source ?? null },
      { $or: [{ automationAttempts: { $size: 0 } }, { automationAttempts: { $exists: false } }] }] };
}
module.exports = { query, specHash, fail };
