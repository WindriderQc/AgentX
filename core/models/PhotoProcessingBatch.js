'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: String, runId: String, items: [String], inputHash: String, configHash: String,
  target: { model: String, host: String }, queueId: String,
  state: { type: String, default: 'queued', enum: ['queued', 'claimed', 'running', 'completed', 'failed', 'uncertain'] },
  workerSlot: String, processId: String, dispatchId: String,
  scanDispatchedAt: Date, projections: [mongoose.Schema.Types.Mixed],
  progress: mongoose.Schema.Types.Mixed, error: String, finishedAt: Date,
  indexRecovery: mongoose.Schema.Types.Mixed,
}, { timestamps: true, collection: 'photo_processing_batches', autoCreate: false, autoIndex: false });
schema.index({ workerSlot: 1 }, { unique: true, sparse: true });
let ready;
schema.statics.ensureProcessingIndexes = function () {
  if (!ready) ready = this.createIndexes().catch(error => { ready = null; throw error; });
  return ready;
};
module.exports = mongoose.models.PhotoProcessingBatch || mongoose.model('PhotoProcessingBatch', schema);
