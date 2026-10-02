'use strict';

const PipelineTask = require('../../models/PipelineTask');
const PipelineAutomationSlot = require('../../models/PipelineAutomationSlot');
const workerTaskScope = require('../helpers/workerTaskScope');
const { loadDependencyStatuses, AUTOMATION_SLOT_ID } = require('./pipelineTaskService');
const { taskEligibilityReasons } = require('./pipelineTaskEligibility');

async function readTaskEligibility(pipelineId, { automated = false, now = new Date() } = {}) {
  const task = await PipelineTask.findOne({ pipelineId, ...workerTaskScope() })
    .select('pipelineId status assignee notBefore dependsOn risk automation automationAttemptCount').lean();
  if (!task) return null;
  const dependencyStatuses = await loadDependencyStatuses([task]);
  const reasons = taskEligibilityReasons(task, { now, dependencyStatuses, automated })
    .map(({ code, notBefore }) => ({ code, ...(notBefore && { notBefore }) }));
  if (automated) {
    const slot = await PipelineAutomationSlot.findById(AUTOMATION_SLOT_ID).select('leaseId expiresAt').lean();
    if (slot?.leaseId && slot.expiresAt && new Date(slot.expiresAt).getTime() > now.getTime()) {
      reasons.push({ code: 'automation_slot_occupied' });
    }
  }
  return { schema: 'agentx.pipeline-eligibility/v1', pipelineId, mode: automated ? 'review_only' : 'manual',
    observedAt: now.toISOString(), observedEligible: reasons.length === 0, reasons,
    authorization: 'not_granted', consistency: 'snapshot; selection and atomic claim revalidate current state' };
}

module.exports = { readTaskEligibility };
