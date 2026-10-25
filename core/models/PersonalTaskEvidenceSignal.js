'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  fingerprint: { type: String, required: true },
  threadId: { type: String, required: true, index: true }, messageId: String,
  sourceDate: Date, text: String, actor: String, sourceStatus: String,
  taskIds: [{ type: String }]
}, { timestamps: true, collection: 'personal_task_evidence_signals' });
schema.index({ taskIds: 1, sourceDate: -1 });
module.exports = mongoose.models.PersonalTaskEvidenceSignal || mongoose.model('PersonalTaskEvidenceSignal', schema);
