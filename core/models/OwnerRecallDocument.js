'use strict';

const mongoose = require('mongoose');

// Provenance of each document in the owner's private recall corpus. The text
// and vectors live in RAG's owner collection; Core keeps where each came from
// and what the owner forgot, so a forgotten document is never indexed again.
const schema = new mongoose.Schema({
  documentId: { type: String, required: true, unique: true, maxlength: 200 },
  scope: { type: String, enum: ['owner'], default: 'owner', required: true },
  kind: { type: String, enum: ['mail', 'file', 'souvenir', 'person'], required: true },
  state: { type: String, enum: ['indexed', 'forgotten'], default: 'indexed' },
  contentHash: { type: String, default: '', maxlength: 64 },
  title: { type: String, default: '', maxlength: 300 },
  occurredAt: { type: Date, default: null },
  people: [{ type: String, maxlength: 200 }],
  source: {
    messageId: { type: String, default: '', maxlength: 256 },
    threadId: { type: String, default: '', maxlength: 256 },
    sourceSha256: { type: String, default: '', maxlength: 64 },
    filename: { type: String, default: '', maxlength: 300 }
  },
  noteId: { type: String, default: '', maxlength: 24 },
  personId: { type: String, default: '', maxlength: 24 },
  chunkCount: { type: Number, default: 0 },
  indexedAt: { type: Date, default: null }
}, { timestamps: true, collection: 'owner_recall_documents' });

schema.index({ scope: 1, kind: 1, state: 1 });

module.exports = mongoose.models.OwnerRecallDocument || mongoose.model('OwnerRecallDocument', schema);
