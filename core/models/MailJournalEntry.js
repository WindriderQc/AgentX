'use strict';

const mongoose = require('mongoose');

// What happened in the owner's mail, one entry per thread (or per message when
// a thread carries several events). Owner-only by construction: there is no
// household reader. Durable facts drawn from an entry go to memory notes.
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  threadId: { type: String, required: true, index: true },
  messageId: { type: String, default: '' },
  occurredAt: { type: Date, required: true, index: true },
  subject: { type: String, default: '' },
  counterpart: { type: String, default: '' },
  summary: { type: String, required: true },
  tags: { type: [String], default: [] },
  sourceRef: { type: String, default: '' },
  source: { type: String, default: 'secretary' },
  scope: { type: String, default: 'owner', enum: ['owner'] },
  sensitivity: { type: String, default: 'private', enum: ['private', 'highly_private'] },
  expiresAt: { type: Date, default: null }
}, { timestamps: true, collection: 'mail_journal_entries' });

// Retention: Mongo removes an entry once expiresAt has passed.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.MailJournalEntry || mongoose.model('MailJournalEntry', schema);
