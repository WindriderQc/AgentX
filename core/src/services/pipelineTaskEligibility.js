'use strict';

const { automationAdmissionReasons } = require('../../../shared/pipelineAutomationContract');

function taskEligibilityReasons(task, { now = new Date(), dependencyStatuses = new Map(), automated = false,
  activeLockKeys, protectedPathPrefixes } = {}) {
  const reasons = [];
  if (task.status !== 'queued' || task.assignee) reasons.push({ code: 'task_unavailable' });
  if (task.notBefore && new Date(task.notBefore).getTime() > now.getTime()) {
    reasons.push({ code: 'not_before', notBefore: new Date(task.notBefore).toISOString() });
  }
  if (!(task.dependsOn || []).every(id => dependencyStatuses.get(id) === 'done')) {
    reasons.push({ code: 'dependencies_incomplete' });
  }
  if (automated) {
    for (const reason of automationAdmissionReasons(task, { now, dependencyStatuses, activeLockKeys, protectedPathPrefixes })) {
      if (!reasons.some(item => item.code === reason.code)) reasons.push(reason);
    }
  }
  return reasons;
}

module.exports = { taskEligibilityReasons };
