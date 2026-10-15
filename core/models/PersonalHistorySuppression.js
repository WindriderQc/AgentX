'use strict';

const mongoose = require('mongoose');

// Durable opaque replay barriers. Forgotten selected notes have their own
// content-retention sweep; that sweep must not revive historical derivatives.
const schema = new mongoose.Schema({
  noteId: { type: String, required: true, unique: true },
  contentHash: { type: String, default: '', index: true },
  scope: { type: String, enum: ['owner'], default: 'owner' },
  forgottenAt: { type: Date, required: true }
}, { collection: 'personal_history_suppressions' });

module.exports = mongoose.models.PersonalHistorySuppression || mongoose.model('PersonalHistorySuppression', schema);
