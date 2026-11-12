'use strict';
const Runtime = require('../../../models/RuntimeCoordination');
const { reapExpired } = require('../runtimeCoordinationState');
const drain = require('../runtimeDrainIntent');
const { fail } = require('./importFiles');
const KIND = 'photo-processing', WC = { w: 1, j: true };
const proof = row => ({ kind: KIND, operationId: row._id, queueId: row.queueId, processId: row.processId });
const draining = () => Boolean(drain.current());

// This is a Core writer fence, not a resource/inference admission. It shares
// the maintenance CAS document so neither side can enter through a gap in the
// other's lifetime. No TTL can prove that a remote scan/export/model stopped.
async function acquire(row) {
  if (draining()) return false;
  await reapExpired();
  const owner = { ...proof(row), hosts: [row.target.host], acquiredAt: new Date(), state: 'ACTIVE' };
  const saved = await Runtime.findOneAndUpdate({ _id: 'runtime', maintenance: null,
    'coreWriters.0': { $exists: false } }, { $push: { coreWriters: owner } },
  { new: true, writeConcern: WC }).lean();
  if (!saved) return false;
  // Drain may have arrived while the CAS was awaiting Mongo. No effect has
  // started yet; withdraw this admission and leave the selection queued.
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
module.exports = { acquire, release, unknown, assert, held, draining };
