'use strict';

function failure(message, statusCode = 409) { return Object.assign(new Error(message), { statusCode }); }

// Handing a task to the coding worker needs no plan or declared file scope:
// the worker reads the ticket and its discussion, then works on its own branch.
// Preparation only records the operator's answer and puts the ticket back in the queue.
class CodingTaskPreparation {
  constructor({ pipeline }) { this.pipeline = pipeline; }
  async prepare(input) {
    const pipelineId = String(input.pipelineId || '');
    if (!/^\d{4}$/.test(pipelineId)) throw failure('Choose an exact task.', 400);
    const answer = String(input.answer || '').trim();
    if (answer.length > 3000) throw failure('Keep the answer within 3000 characters.', 400);
    const { task } = await this.pipeline.read(pipelineId);
    if (answer || task.status === 'blocked') {
      await this.pipeline.apply({ pipelineId, expectedUpdatedAt: new Date(task.updatedAt).toISOString(), answer });
    } else if (task.status !== 'queued') {
      throw failure('The task is already running or awaiting review.');
    }
    return { ready: true };
  }
}
module.exports = { CodingTaskPreparation };
