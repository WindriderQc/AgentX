'use strict';

const PipelineTask = require('../../models/PipelineTask');
const { editToken } = require('./pipelineTaskEditorService');
const { safePlanningWorkerContext } = require('./planningWorkerContextService');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');
const { preparationTransition } = require('./pipelineTaskTransitionPaths');
const { buildRevision, recordPlanRevision } = require('./pipelineTaskPlans');
const workerTaskScope = require('../helpers/workerTaskScope');

function conflict(message) { return Object.assign(new Error(message), { statusCode: 409, code: 'TASK_PREPARATION_CONFLICT' }); }

async function load(pipelineId) {
  const task = await PipelineTask.findOne({ pipelineId }).lean();
  if (!task) throw Object.assign(new Error('Task not found'), { statusCode: 404 });
  return task;
}
async function read(pipelineId) {
  const task = await load(pipelineId);
  require('./taskIntakePolicy').assertAccepted(task);
  return { task, editToken: editToken(task), planningContext: await safePlanningWorkerContext(task) };
}

// The deployment owns planning; Core owns every write to the canonical task.
async function apply({ pipelineId, expectedUpdatedAt, automation, question, answer, plan, contextNotice, handoff = false, result, reportGrant }) {
  const task = await load(pipelineId);
  require('./taskIntakePolicy').assertAccepted(task);
  if (!['queued', 'blocked'].includes(task.status) || task.automationLease?.leaseId) throw conflict('The task is already running or awaiting review.');
  // A ticket the coding worker left blocked returns to the queue with the operator's answer.
  if (task.assignee && !(task.status === 'blocked' && (task.automation?.mode === 'review_only' || task.assignee === 'coding-team'))) throw conflict('Another worker owns this task.');
  if (String(new Date(task.updatedAt).toISOString()) !== expectedUpdatedAt) throw conflict('The task changed while the team prepared it. Your answer has not been discarded; try again.');
  if (!workerTaskScope.contains(task)) throw conflict('This task belongs to its personal or household workflow.');
  const at = new Date();
  const feedback = [];
  if (contextNotice) feedback.push({ by: 'coding-team', text: String(contextNotice), at });
  const previous = (task.feedback || []).at(-1);
  if (answer && !(previous?.by === 'operator' && previous.text === String(answer))) feedback.push({ by: 'operator', text: String(answer), at });
  if (question) feedback.push({ by: 'coding-team', text: String(question), at });
  if (plan) feedback.push({ by: 'coding-team', text: `Execution plan: ${String(plan)}`, at });
  const changes = question ? { status: 'blocked' } : { status: 'queued', assignee: null, heartbeatAt: null };
  if (result) {
    const selected = require('../../../shared/pipelineReportSelection').normalize(result);
    if (result.profile !== (selected.reportName ? 'report' : 'code')) throw conflict('The result profile is inconsistent.');
    changes.codingResult = { profile: result.profile, ...selected };
    if (result.profile === 'report') changes.codingReportAuthority = await require('./pipelineReportAuthority').prepare(task, selected, reportGrant);
    else if (task.codingReportAuthority) throw conflict('This task retains report authority; review its saved report before changing its result.');
  }
  if (handoff && task.service !== 'agentx-coding') {
    changes.service = 'agentx-coding';
    feedback.push({ by: 'operator', text: 'Task handed to the Coding Team for one worker execution.', at });
  }
  if (automation) {
    if (task.automationAttemptCount > 0) throw conflict('An existing attempt must resume its original scope.');
    changes.automation = normalizePipelineAutomationIntent(automation);
    changes.risk = 'low';
  }
  const update = { $set: changes, ...(feedback.length && { $push: { feedback: { $each: feedback } } }) };
  const options = { new: true, runValidators: true, writeConcern: { w: 1, j: true } };
  const latest = (task.automationAttempts || []).at(-1);
  if (!question && latest) {
    update.$set['automationAttempts.$[attempt].reviewOutcome'] = 'requeued';
    update.$set['automationAttempts.$[attempt].reviewedAt'] = at;
    options.arrayFilters = [{ 'attempt.attempt': latest.attempt }];
  }
  const query = { pipelineId, updatedAt: task.updatedAt, status: task.status, assignee: task.assignee ?? null,
    'codingReportAuthority.revision': task.codingReportAuthority?.revision ?? null,
    deliverableRegistryRevision: task.deliverableRegistryRevision ?? { $in: [0, null] },
    'automationLease.leaseId': null,
    $and: [workerTaskScope(), { service: task.service ?? null, source: task.source ?? null }] };
  preparationTransition(query, update, task, { question: Boolean(question), at });
  require('./taskIntakePolicy').guard(query, task);
  // The plan becomes a new, undecided revision bound to the scope written here.
  // It authorizes nothing: the operator's explicit launch still starts the work.
  if (plan && String(plan).trim()) recordPlanRevision(query, update, task, buildRevision(task, { text: plan, channel: 'task_preparation',
    declaredActor: 'coding-team', automation: changes.automation || task.automation, at }));
  const updated = await PipelineTask.findOneAndUpdate(query, update, options).lean();
  if (!updated) throw conflict('The task changed while saving. Try again with the current ticket.');
  return updated;
}

module.exports = { read, apply };
