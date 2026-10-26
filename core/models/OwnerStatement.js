'use strict';

const mongoose = require('mongoose');

// The owner's own words, kept as a source: an answer given in a conversation
// or a questionnaire. History entries cite it by the SHA-256 of its text, the
// way mail is cited by its preserved original. An optional chapter keeps the
// order the owner told things in.
const schema = new mongoose.Schema({
  sha256: { type: String, required: true, unique: true, match: /^[a-f0-9]{64}$/ },
  scope: { type: String, enum: ['owner'], default: 'owner', required: true },
  label: { type: String, default: '', maxlength: 200 },
  text: { type: String, required: true, maxlength: 20000 },
  receivedOn: { type: String, default: '', maxlength: 10 },
  chapter: { type: mongoose.Schema.Types.Mixed, default: null },
  status: { type: String, enum: ['active', 'forgotten'], default: 'active', index: true }
}, { timestamps: true, collection: 'owner_statements' });

module.exports = mongoose.models.OwnerStatement || mongoose.model('OwnerStatement', schema);
