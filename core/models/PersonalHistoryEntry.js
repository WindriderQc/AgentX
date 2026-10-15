'use strict';

const mongoose = require('mongoose');

// Source assertions for the owner's historical review. Selected memory, task
// commitments and provider records retain their existing owners.
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  scope: { type: String, enum: ['owner'], default: 'owner', required: true },
  sensitivity: { type: String, enum: ['private', 'highly_private'], default: 'private' },
  kind: { type: String, enum: ['action', 'fact', 'deliverable', 'invoice', 'calendar', 'contact'], required: true },
  text: { type: String, default: '', maxlength: 4000 },
  contentHash: { type: String, default: '', index: true },
  actor: { type: String, default: '', maxlength: 300 },
  sourceDate: { type: Date, required: true, index: true },
  eventDateAsWritten: { type: String, default: '', maxlength: 200 },
  eventDate: { type: String, default: '', maxlength: 40 },
  eventDatePrecision: { type: String, enum: ['unknown', 'day', 'instant'], default: 'unknown' },
  assertionState: { type: String, enum: ['unknown', 'reported', 'planned', 'confirmed', 'cancelled', 'disputed'], default: 'unknown' },
  sourceStatus: { type: String, default: '', maxlength: 1000 },
  reviewState: { type: String, enum: ['candidate', 'retained', 'resolved', 'dismissed', 'forgotten'], default: 'candidate', index: true },
  revision: { type: Number, default: 0 },
  source: {
    system: { type: String, enum: ['gmail', 'outlook-export'], required: true },
    threadId: { type: String, default: '', maxlength: 256 },
    messageId: { type: String, default: '', maxlength: 256 },
    sourceSha256: { type: String, required: true, maxlength: 64 },
    findingId: { type: String, required: true, maxlength: 64 },
    evidenceHash: { type: String, default: '', maxlength: 64 },
    reviewSha256: { type: String, default: '', maxlength: 64 },
    personalNoteId: { type: String, default: '', maxlength: 24 },
    direction: { type: String, enum: ['received', 'sent', 'draft', 'unknown'], default: 'unknown' }
  },
  decision: {
    reason: { type: String, default: '', maxlength: 2000 },
    at: { type: Date, default: null }
  },
  reviewHistory: [{
    revision: Number, state: String, assertionState: String, eventDate: String,
    eventDatePrecision: String, reason: String, at: Date
  }],
  forgottenAt: { type: Date, default: null }
}, { timestamps: true, collection: 'personal_history_entries' });

schema.index({ scope: 1, reviewState: 1, sourceDate: 1, _id: 1 });
schema.index({ 'source.system': 1, 'source.messageId': 1 });

module.exports = mongoose.models.PersonalHistoryEntry || mongoose.model('PersonalHistoryEntry', schema);
