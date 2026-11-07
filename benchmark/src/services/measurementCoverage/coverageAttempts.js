'use strict';

const Attempt = require('../../../models/CoverageAttempt');
const WC = { w: 1, j: true };

const active = () => Attempt.findOne({ active: true }).lean();
const get = id => Attempt.findById(id).lean();

async function create(id, intent) {
  // The unique active slot serializes workers even before their first effect.
  await Attempt.init();
  try {
    await new Attempt({ _id: id, active: true, intent }).save({ writeConcern: WC });
  } catch (error) {
    if (error.code !== 11000) throw error;
    return active();
  }
  return get(id);
}

async function update(id, fields) {
  return Attempt.findByIdAndUpdate(id, { $set: fields }, { new: true, writeConcern: WC }).lean();
}

async function beginPost(id, queueId, dispatchId) {
  return Attempt.findOneAndUpdate({ _id: id, active: true, queueId, nativePostAt: { $exists: false } },
    { $set: { dispatchId, nativePostAt: new Date() } }, { new: true, writeConcern: WC }).lean();
}

async function beginNative(id, queueId, dispatchId) {
  return Attempt.findOneAndUpdate({ _id: id, active: true, queueId, dispatchId, nativeDispatchedAt: { $exists: false } },
    { $set: { nativeDispatchedAt: new Date() } }, { new: true, writeConcern: WC }).lean();
}

module.exports = { active, get, create, update, beginPost, beginNative };
