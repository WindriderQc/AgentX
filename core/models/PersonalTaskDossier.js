'use strict';

const mongoose = require('mongoose');

// Core evidence/review receipts for an existing personal task. This collection
// owns no task, calendar event, message or selected memory.
const schema = new mongoose.Schema({
  taskId: { type: String, required: true, index: true },
  taskRevision: { type: Number, required: true },
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  fingerprint: { type: String, required: true },
  proposal: { type: mongoose.Schema.Types.Mixed, default: null },
  proposalHash: { type: String, default: '' }
}, { timestamps: true, collection: 'personal_task_dossiers' });
schema.index({ taskId: 1, createdAt: -1 });
module.exports = mongoose.models.PersonalTaskDossier || mongoose.model('PersonalTaskDossier', schema);
