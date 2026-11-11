'use strict';
const queue = require('../heavyWorkQueueService');
const evidence = require('../heavyWorkQueueEvidence');
const Images = require('../../../models/ImageOperation');
const { hosts, fail } = require('../heavyWorkQueueContract');
const WC = { w: 1, j: true };

// A worker can disappear after manual dispatch but before acceptance creates
// an operation. Store this conclusive refusal before returning the HTTP error.
async function refuseBeforeAccept(body, config, requestHash, reason) {
  if (!body.queueRequestId || !body.queueDispatchId) return;
  const job = await queue.get(body.queueRequestId);
  if (job.kind !== 'image' || job.executor?.actionKey !== body.actionKey
    || require('./imageService').validate(job.executor, config).requestHash !== requestHash) {
    throw fail('Queued image differs from this request', 409);
  }
  if (await Images.exists({ actionKey: body.actionKey })) throw fail('Original image receipt must be reconciled', 409);
  await queue.assertDispatch(job.id, body.queueDispatchId);
  await queue.refused(job.id, { dispatchId: body.queueDispatchId, code: 'IMAGE_WORKER_UNAVAILABLE', reason }, 'core-images', 'core-launch-refusal');
  await evidence.reconcile(job.id, 'core-images');
}

async function enroll(op, config, body) {
  const prior = (await queue.list())?.jobs || [];
  for (const item of prior) {
    if (item.id === body.queueRequestId) continue;
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
async function discardWaiting(op, job) {
  // Cancellation is conclusive only while the original queue entry has not
  // crossed begin. A lost response/another dispatcher remains its own identity.
  if (!['requested', 'reserved', 'cancelled'].includes(job.state)) return false;
  if (job.state !== 'cancelled') {
    try { await queue.cancel(job.id, { expectedRevision: job.revision }, 'core-images'); }
    catch (error) {
      // Reconcile the same cancellation after a lost reply. Never repeat it or
      // overwrite an operation another dispatcher has already admitted.
      const current = await queue.get(job.id);
      if (error.code === 'HEAVY_QUEUE_STALE' && ['dispatching', 'running', 'uncertain'].includes(current.state)) return false;
      if (current.state !== 'cancelled') throw error;
    }
  }
  await Images.updateOne({ _id: op._id, state: 'queued' }, { $set: { state: 'cancelled', cancelRequested: true,
    error: 'The immediate image slot was unavailable. This request will not run later.' }, $unset: { workerSlot: 1 } }, { writeConcern: WC });
  return false;
}
async function dispatch(op, launch, { immediateAttempt = false } = {}) {
  if (!op.queueRequestId) throw fail('Image has no queue identity', 409);
  let job = await queue.get(op.queueRequestId);
  if (op.admissionPolicy === 'opportunistic' && !immediateAttempt) return discardWaiting(op, job);
  if (job.state === 'cancelled') {
    await Images.updateOne({ _id: op._id, state: 'queued' }, { $set: { state: 'cancelled', cancelRequested: true }, $unset: { workerSlot: 1 } }, { writeConcern: WC });
    return false;
  }
  if (op.queueDispatchId) {
    try { await queue.assertDispatch(job.id, op.queueDispatchId); }
    catch (error) {
      // A concurrent dispatcher may already own this exact image. A loser
      // observes it without starting work or overwriting its live state.
      const current = await queue.get(job.id);
      if (current.dispatchId === op.queueDispatchId && current.operation?.id === op._id) return false;
      throw error;
    }
  } else {
    if (['requested', 'reserved'].includes(job.state) && job.startBefore && Date.now() >= Date.parse(job.startBefore)) {
      await queue.cancel(job.id, { expectedRevision: job.revision }, 'core-images');
      await Images.updateOne({ _id: op._id, state: 'queued' }, { $set: { state: 'cancelled', error: 'Image slot expired. New request required.' }, $unset: { workerSlot: 1 } }, { writeConcern: WC });
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
      if (['HEAVY_QUEUE_CONFLICT', 'HEAVY_QUEUE_STALE', 'HEAVY_QUEUE_TOPOLOGY_CHANGED', 'HEAVY_QUEUE_WINDOW_CLOSED'].includes(error.code)) {
        if (op.admissionPolicy === 'opportunistic') return discardWaiting(op, await queue.get(job.id));
        return false;
      }
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
module.exports = { enroll, dispatch, refuseBeforeAccept };
