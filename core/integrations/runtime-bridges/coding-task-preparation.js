'use strict';

const workerTaskScope = require('../../src/helpers/workerTaskScope');

function failure(message, statusCode = 409) { return Object.assign(new Error(message), { statusCode }); }

// Handing a task to the coding worker needs no plan or declared file scope:
// the worker reads the ticket and its discussion, then works on its own branch.
// Preparation records the explicit coding handoff and any operator answer.
class CodingTaskPreparation {
  constructor({ pipeline }) { this.pipeline = pipeline; }
  async prepare(input) {
    require('../../../shared/pipelineReportSelection').normalize(input);
    const pipelineId = String(input.pipelineId || '');
    if (!/^\d{4}$/.test(pipelineId)) throw failure('Choose an exact task.', 400);
    const answer = String(input.answer || '').trim();
    if (answer.length > 3000) throw failure('Keep the answer within 3000 characters.', 400);
    const { task } = await this.pipeline.read(pipelineId);
    if (task.automation?.mode === 'review_only' || task.codingAutonomy || task.automationAttemptCount > 0 || task.automationAttempts?.length)
      throw failure('Resume this managed task through its existing Coding Team correction loop.');
    if (!workerTaskScope.contains(task)) throw failure('This task belongs to its personal or household workflow.');
    if (!['queued', 'blocked'].includes(task.status) || task.automationLease?.leaseId) throw failure('The task is already running or awaiting review.');
    if (task.assignee && !(task.status === 'blocked' && (task.automation?.mode === 'review_only' || task.assignee === 'coding-team'))) throw failure('Another worker owns this task.');
    if (answer || task.status === 'blocked' || task.service !== 'agentx-coding') {
      await this.pipeline.apply({ pipelineId, expectedUpdatedAt: new Date(task.updatedAt).toISOString(), answer, handoff: true });
    }
    return { ready: true };
  }
}
module.exports = { CodingTaskPreparation };
