'use strict';
const Task = require('../../models/PipelineTask');
const policy = require('./pipelineCodingAutonomyPolicy');
function project(observation, pr, now = Date.now()) {
  const checks = (observation.checks || []).filter(check => check.head === observation.head);
  const ci = policy.verdict({ ...observation, state: 'open', mergeable: 'clean' }, { head: observation.head });
  return { observedAt: new Date(now).toISOString(), head: observation.head, expectedHead: pr.head,
    headMatches: observation.head === pr.head, state: observation.state, merged: observation.merged === true,
    ci, checks, acceptance: 'not_recorded' };
}

// Publication observations never accept a task, debit a stopped campaign,
// amend its PR identity, or grant permission for another coding turn.
async function refresh(task, control, save) {
  const state = task.codingAutonomy, last = state.runs.at(-1), now = Date.now();
  if (!state.pr || !last?.finishedAt || task.automationLease || task.codingCapacity
    || Date.parse(state.deliveryNextObservationAt) > now) return;
  const guard = { updatedAt: task.updatedAt, status: task.status, assignee: task.assignee ?? null,
    automationLease: null, codingCapacity: null, 'codingAutonomy.state': state.state,
    'codingAutonomy.pr.head': state.pr.head, 'codingAutonomy.runs': { $size: state.runs.length },
    [`codingAutonomy.runs.${state.runs.length - 1}.requestId`]: last.requestId,
    [`codingAutonomy.runs.${state.runs.length - 1}.finishedAt`]: last.finishedAt };
  let observation;
  try {
    observation = await control.observe({ pipelineId: task.pipelineId, requestId: last.requestId, pr: state.pr });
  } catch {
    const failures = (state.deliveryObservationFailures || 0) + 1;
    return save(task, { ...state, deliveryObservationFailures: failures,
      deliveryNextObservationAt: new Date(now + Math.min(300000, 15000 * 2 ** Math.min(failures, 5))).toISOString() }, {}, undefined, guard);
  }
  // CI remains a separate fact even after merge. The original publication head
  // stays visible when an operator subsequently changes the remote branch.
  const delivery = project(observation, state.pr, now);
  return save(task, { ...state, delivery, deliveryObservationFailures: 0,
    deliveryNextObservationAt: new Date(now + 60000).toISOString() }, {}, undefined, guard);
}
async function sweep(control, save) {
  const tasks = await Task.find({ status: { $in: ['review', 'blocked', 'done'] }, automationLease: null, codingCapacity: null,
    'codingAutonomy.pr': { $exists: true }, 'codingAutonomy.state': { $in: ['ready_for_review', 'stopped', 'closed', 'blocked'] },
    $or: [{ 'codingAutonomy.deliveryNextObservationAt': { $exists: false } },
      { 'codingAutonomy.deliveryNextObservationAt': { $lte: new Date().toISOString() } }],
    $nor: [{ 'codingAutonomy.authorized': true, 'codingAutonomy.correction.kind': 'failure',
      'codingAutonomy.state': 'blocked', 'codingAutonomy.reason': 'resume_limit' }] })
    .sort({ 'codingAutonomy.deliveryNextObservationAt': 1, pipelineId: 1 }).limit(2).lean();
  for (const task of tasks) await refresh(task, control, save);
}
module.exports = { project, refresh, sweep };
