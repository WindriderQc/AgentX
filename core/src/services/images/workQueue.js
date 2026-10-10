'use strict';
const queue = require('../heavyWorkQueueService');
const evidence = require('../heavyWorkQueueEvidence');
const Images = require('../../../models/ImageOperation');
const { hosts, fail } = require('../heavyWorkQueueContract');
const WC = { w: 1, j: true };

async function enroll(op, config, body) {
  const prior = (await queue.list())?.jobs || [];
  for (const item of prior) {
    if (item.kind !== 'image' || !['dispatching', 'running', 'uncertain'].includes(item.state)) continue;
    try { await evidence.reconcile(item.id, 'core-images'); } catch { /* Existing uncertainty remains fenced. */ }
  }
  let job;
  if (body.queueRequestId || body.queueDispatchId) {
    job = await queue.get(body.queueRequestId);
    await queue.assertDispatch(job.id, body.queueDispatchId);
    if (job.kind !== 'image' || job.executor?.actionKey !== op.actionKey
      || require('./imageService').validate(job.executor, config).requestHash !== op.requestHash) {
      throw fail('Queued image differs from this request', 409);
    }
  } else {
    job = await queue.submit({ key: `image:${op.actionKey}`, title: `Image · ${op.profile.label || op.profile.id}`, kind: 'image',
      hosts: hosts([...config.ollamaHosts, new URL(config.workerUrl).origin]),
      estimatedMinutes: Math.ceil((config.timeoutMs || 900000) / 60000) + 5,
      notBefore: new Date(op.createdAt).toISOString(), startBefore: new Date(new Date(op.createdAt).getTime() + 15 * 60000).toISOString(),
      source: { type: op.conversation ? 'nestor' : 'operator', ref: op.conversation?.sessionId || op.actionKey },
      executor: { mode: 'image-operation', operationId: op._id, actionKey: op.actionKey, requestHash: op.requestHash }
    }, 'core-images');
  }
  await Images.updateOne({ _id: op._id, state: 'queued' }, { $set: { queueRequestId: job.id,
    ...(body.queueDispatchId && { queueDispatchId: body.queueDispatchId }) } }, { writeConcern: WC });
  return job;
}
async function dispatch(op, launch) {
  if (!op.queueRequestId) throw fail('Image has no queue identity', 409);
  let job = await queue.get(op.queueRequestId);
  if (job.state === 'cancelled') {
    await Images.updateOne({ _id: op._id, state: 'queued' }, { $set: { state: 'cancelled', cancelRequested: true }, $unset: { workerSlot: 1 } }, { writeConcern: WC });
    return false;
  }
  if (op.queueDispatchId) {
    await queue.assertDispatch(job.id, op.queueDispatchId);
  } else {
    if (['requested', 'reserved'].includes(job.state) && job.startBefore && Date.now() >= Date.parse(job.startBefore)) {
      await queue.cancel(job.id, { expectedRevision: job.revision }, 'core-images');
      await Images.updateOne({ _id: op._id, state: 'queued' }, { $set: { state: 'cancelled', error: 'Créneau image expiré. Nouvelle demande requise.' }, $unset: { workerSlot: 1 } }, { writeConcern: WC });
      return false;
    }
    if (!['requested', 'reserved'].includes(job.state)) {
      // Another winner may be between its queue CAS and image CAS. Do not
      // overwrite it. Startup marks prior-process dispatch gaps as unknown.
      return false;
    }
    try {
      if (job.state === 'requested') job = await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date().toISOString() }, 'core-images');
      await evidence.preDispatch(job);
      job = await queue.begin(job.id, { expectedRevision: job.revision }, 'core-images');
    } catch (error) {
      if (['HEAVY_QUEUE_CONFLICT', 'HEAVY_QUEUE_STALE', 'HEAVY_QUEUE_TOPOLOGY_CHANGED', 'HEAVY_QUEUE_WINDOW_CLOSED'].includes(error.code)) return false;
      throw error;
    }
  }
  await queue.record(job.id, { dispatchId: job.dispatchId, state: 'running', operationId: op._id }, 'core-images');
  const accepted = await Images.findOneAndUpdate({ _id: op._id, state: 'queued' }, { $set: { state: 'accepted', workerSlot: op.workerUrl, queueDispatchId: job.dispatchId } },
    { new: true, writeConcern: WC }).select('+request +referenceStorage +workerUrl').lean();
  if (!accepted) return false;
  // Only the CAS winner starts the existing executor. GPU admission and model
  // restoration remain in that executor, not in this planning worker.
  launch(accepted);
  return true;
}
module.exports = { enroll, dispatch };
