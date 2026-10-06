'use strict';
const PipelineTask = require('../../models/PipelineTask');
const { loadDependencyStatuses } = require('./pipelineTaskService');
const { taskNextAction } = require('./pipelineNextAction');
const { taskSummaryWithTimeline } = require('./pipelineTaskTimeline');
const { taskEvidenceReferences } = require('./pipelineEvidenceReferences');
const { TIMELINE_TRANSITIONS, transitionLog } = require('./pipelineTaskTransitions');
const { planView } = require('./pipelineTaskPlans');
const SUMMARY_FIELD_LIST = [
  'pipelineId title service status assignee heartbeatAt epic source priority dependsOn notBefore dueAt risk',
  'automation automationAttemptCount automationLease.expiresAt codingCapacity planningItemIds scheduleEntryIds createdAt updatedAt resolution',
  'automationAttempts.attempt automationAttempts.acquiredAt automationAttempts.completedAt automationAttempts.finalState',
  'automationAttempts.reviewedAt automationAttempts.reviewOutcome automationAttempts.evidence.schema',
  'automationAttempts.evidence.failureCodes automationAttempts.evidence.verification.status',
  'automationAttempts.evidence.inference.state automationAttempts.evidence.inference.cause transitionSeq'
].join(' ');
// Summary reads carry only the most recent transitions; the store keeps more.
const SUMMARY_FIELDS = {
  ...Object.fromEntries(SUMMARY_FIELD_LIST.split(' ').map((field) => [field, 1])),
  transitions: { $slice: -TIMELINE_TRANSITIONS },
};

function withoutLeaseId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { leaseId, ...safe } = value;
  return safe;
}

function redactTaskLeaseIds(task) {
  const row = typeof task?.toObject === 'function' ? task.toObject({ depopulate: true }) : task;
  return {
    ...row,
    ...(row.codingCapacity ? { codingCapacity: (() => {
      const { admissionId, generation, workloadId, ...visible } = row.codingCapacity;
      return visible;
    })() } : {}),
    ...(row.automationLease ? { automationLease: withoutLeaseId(row.automationLease) } : {}),
    ...(Array.isArray(row.automationAttempts)
      ? { automationAttempts: row.automationAttempts.map(withoutLeaseId) } : {}),
  };
}

async function projectTaskRows(tasks, { summary = false, now = new Date(), references = true } = {}) {
  const dependencyStatuses = await loadDependencyStatuses(tasks);
  const options = { now, dependencyStatuses };
  return tasks.map(task => redactTaskLeaseIds(summary ? taskSummaryWithTimeline(task, options)
    : { ...task, nextAction: taskNextAction(task, options), transitionLog: transitionLog(task), plan: planView(task),
      ...(references ? { evidenceReferences: taskEvidenceReferences(task) } : {}) }));
}
async function loadDeliveryTasks(query) {
  const tasks = await PipelineTask.find(query).select(SUMMARY_FIELDS).sort({ pipelineId: 1 }).lean();
  return projectTaskRows(tasks, { summary: true });
}
module.exports = { SUMMARY_FIELDS, projectTaskRows, loadDeliveryTasks, redactTaskLeaseIds };
