'use strict';
const Runtime = require('../../../models/RuntimeCoordination');
const { reapExpired } = require('../runtimeCoordinationState');
const drain = require('../runtimeDrainIntent');
const { fail } = require('./importFiles');
const control = require('./photoProcessingControl');
const Batches = require('../../../models/PhotoProcessingBatch');
const KIND = 'photo-processing', WC = { w: 1, j: true };
const proof = row => ({ kind: KIND, operationId: row._id, queueId: row.queueId, processId: row.processId });
const draining = () => Boolean(drain.current());

// This is a Core writer fence, not a resource/inference admission. It shares
// the maintenance CAS document so neither side can enter through a gap in the
// other's lifetime. No TTL can prove that a remote scan/export/model stopped.
async function acquire(row) {
  if (draining() || await control.isPaused()) return false;
  await reapExpired();
  const owner = { ...proof(row), hosts: [row.target.host], acquiredAt: new Date(), state: 'ACTIVE' };
  const saved = await Runtime.findOneAndUpdate({ _id: 'runtime', maintenance: null,
    'coreWriters.0': { $exists: false }, ...control.admissionFilter() }, { $push: { coreWriters: owner } },
  { new: true, writeConcern: WC }).lean();
  if (!saved) return false;
  // Drain may have arrived while the CAS was awaiting Mongo. No effect has
  // started yet; withdraw this admission and leave the selection queued.
  if (draining()) { await release(row); return false; }
  return true;
}
// Only a persisted, explicitly selected operator batch may enter a paused lane.
// Normal acquire() and FIFO keep the same closed admission predicate.
async function acquireSelected(row) {
  if (draining()) return false;
  const saved = await Batches.findById(row._id).lean(), permit = saved?.operatorAttempt;
  if (!saved || saved.state !== 'claimed' || saved.processId !== row.processId || saved.queueId !== row.queueId
    || saved.dispatchId !== row.dispatchId || saved.inputHash !== row.inputHash
    || permit?.kind !== 'selected-images-while-paused' || !Array.isArray(permit.sha256)
    || !permit.sha256.length || permit.sha256.length > 2 || new Set(permit.sha256).size !== permit.sha256.length
    || permit.sha256.some(value => !/^[a-f0-9]{64}$/.test(value))
    || saved.items.length !== permit.sha256.length) return false;
  const state = await control.status();
  if (!state.paused || state.revision !== permit.controlRevision || state.requestId !== permit.controlRequestId) return false;
  const job = await require('../heavyWorkQueueService').get(saved.queueId);
  if (job.state !== 'dispatching' || job.dispatchId !== saved.dispatchId || job.kind !== 'diagnostic'
    || job.key !== 'photo-analysis-reconcile:'+saved._id || job.executor?.mode !== 'operator'
    || job.executor.receiptRef !== permit.receiptRef || !Number.isFinite(Date.parse(job.reservation?.start))
    || !Number.isFinite(Date.parse(job.reservation?.end)) || Date.now() < Date.parse(job.reservation.start)
    || Date.now() >= Date.parse(job.reservation.end)) return false;
  const owner = { ...proof(row), hosts: [saved.target.host], acquiredAt: new Date(), state: 'ACTIVE' };
  const acquired = await Runtime.findOneAndUpdate({ _id: 'runtime', maintenance: null,
    'coreWriters.0': { $exists: false }, 'photoProcessingControl.version': 1,
    'photoProcessingControl.paused': true, 'photoProcessingControl.revision': permit.controlRevision,
    'photoProcessingControl.requestId': permit.controlRequestId }, { $push: { coreWriters: owner } },
  { new: true, writeConcern: WC }).lean();
  if (!acquired) return false;
  if (draining()) { await release(row); return false; }
  return true;
}
async function release(row) {
  await Runtime.updateOne({ _id: 'runtime' }, { $pull: { coreWriters: proof(row) } }, { writeConcern: WC });
}
async function unknown(row) {
  await Runtime.updateOne({ _id: 'runtime', coreWriters: { $elemMatch: proof(row) } },
    { $set: { 'coreWriters.$.state': 'UNKNOWN' } }, { writeConcern: WC });
}
async function assert(row) {
  if (!await held(row, 'ACTIVE'))
    throw fail('PHOTO_WRITER_HELD', 'The original photo batch writer needs reconciliation');
}
const held = (row, state) => Runtime.exists({ _id: 'runtime',
  coreWriters: { $elemMatch: { ...proof(row), ...(state ? { state } : {}) } } });
module.exports = { acquire, acquireSelected, release, unknown, assert, held, draining };
