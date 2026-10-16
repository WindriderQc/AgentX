'use strict';
// Reserve a file identity before its byte write. Every deposit honors the
// report workers already authorized by the same Task CAS.
const Task = require('../../models/PipelineTask');
const File = require('../../models/PipelineTaskDeliverable');
const Run = require('../../models/PipelineReportRun');
const { fail } = require('./pipelineManualReportClaim');
const { createHash } = require('crypto');
const WC = { w: 1, j: true };
const keyFor = (attempt, name) => createHash('sha256').update(JSON.stringify([attempt ?? null, name])).digest('hex');
async function occupancy(task) {
  const files = await File.find({ pipelineId: task.pipelineId }).select('attempt name reportOrigin').lean();
  const intents = task.deliverableIntents || [], keys = new Set(files.map(file => keyFor(file.attempt, file.name)));
  for (const intent of intents) keys.add(intent.key);
  const bindings = task.codingReportAuthority?.bindings || [], grant = task.codingReportAuthority?.grants.at(-1);
  const runs = await Run.find({ taskId: String(task._id) }).select('state result').lean();
  const savedRequests = new Set([...files.map(file => file.reportOrigin?.requestId), ...intents.map(row => row.reportRequestId)].filter(Boolean));
  let reserved = grant ? Math.max(0, grant.additionalRuns - bindings.filter(row => row.grantKey === grant.key).length) : 0;
  for (const binding of bindings) {
    const run = runs.find(row => row._id === binding.requestId);
    if (!savedRequests.has(binding.requestId) && (!run || run.state === 'active' || !run.result)) reserved++;
  }
  return { occupied: keys.size, reserved, keys };
}
async function reserve(pipelineId, payload, attempt, reportOrigin, maximum) {
  const key = keyFor(attempt, payload.name);
  for (let retry = 0; retry < 12; retry++) {
    const task = await Task.findOne({ pipelineId }).lean();
    if (!task) throw fail('Task not found', 'NOT_FOUND', 404);
    const previous = (task.deliverableIntents || []).find(row => row.key === key);
    if (previous) {
      if (previous.sha256 !== payload.sha256 || (previous.reportRequestId || null) !== (reportOrigin?.requestId || null))
        throw fail('This file identity already reserves different bytes or provenance', 'DELIVERABLE_CONFLICT');
      return;
    }
    const state = await occupancy(task);
    const ownSlot = reportOrigin && task.codingReportAuthority?.bindings.some(row => row.requestId === reportOrigin.requestId);
    if (state.occupied + state.reserved + (ownSlot ? 0 : 1) > maximum)
      throw fail('File capacity is reserved for the task’s authorized report checkpoints', 'DELIVERABLE_LIMIT');
    const saved = await Task.updateOne({ _id: task._id, deliverableRegistryRevision: task.deliverableRegistryRevision ?? { $in: [0, null] },
      'codingReportAuthority.revision': task.codingReportAuthority?.revision ?? null }, {
      $push: { deliverableIntents: { key, sha256: payload.sha256, reportRequestId: reportOrigin?.requestId || null } },
      $inc: { deliverableRegistryRevision: 1 },
    }, { timestamps: false, writeConcern: WC });
    if (saved.acknowledged !== true) throw fail('Reconcile this exact file reservation', 'DELIVERABLE_PERSISTENCE_UNVERIFIED', 503);
    if (saved.modifiedCount === 1) return;
  }
  throw fail('The file registry changed; retry the same immutable deposit', 'DELIVERABLE_CAPACITY_CHANGED');
}
module.exports = { occupancy, reserve };
