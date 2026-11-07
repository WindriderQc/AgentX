'use strict';
const mongoose = require('mongoose');
// The original hashes claim one group forever, even if its card is retired or
// a display photo is removed. No source file is renamed, deleted or written.
const schema = new mongoose.Schema({
  _id: String,
  hashes: { type: [String], required: true },
  plantId: { type: mongoose.Schema.Types.ObjectId, required: true },
  nickname: String, room: String,
  files: [{ _id: false, name: String, sha256: String, mimeType: String, size: Number, archive: mongoose.Schema.Types.Mixed }],
  imported: { type: Boolean, default: false },
  queueId: String,
  target: { model: String, host: String },
  state: { type: String, enum: ['queued', 'claimed', 'running', 'completed', 'failed'], default: 'queued' },
  // One global plant-identification lane, protected across Core processes.
  workerSlot: String, dispatchId: String, processId: String,
  error: String, finishedAt: Date
}, { timestamps: true, collection: 'household_plant_imports', autoCreate: false, autoIndex: false });
schema.index({ hashes: 1 }, { unique: true });
schema.index({ workerSlot: 1 }, { unique: true, sparse: true });
let ready;
schema.statics.ensureImportIndexes = function () {
  if (!ready) ready = this.createIndexes().catch(error => { ready = null; throw error; });
  return ready;
};
module.exports = mongoose.models.HouseholdPlantImport || mongoose.model('HouseholdPlantImport', schema);
