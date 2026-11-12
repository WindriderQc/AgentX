'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ _id: String, requestIds: [String], cursor: { type: Number, default: 0 },
  total: Number, state: { type: String, default: 'active' }, lastObservedAt: Date, error: String,
}, { timestamps: true, collection: 'photo_processing_runs', autoCreate: false, autoIndex: false });
schema.index({ requestIds: 1 }, { unique: true });
let ready;
schema.statics.ensureProcessingIndexes = function () {
  if (!ready) ready = this.createIndexes().catch(error => { ready = null; throw error; });
  return ready;
};
module.exports = mongoose.models.PhotoProcessingRun || mongoose.model('PhotoProcessingRun', schema);
