'use strict';
const mongoose = require('mongoose');
const hash = { type: String, match: /^[a-f0-9]{64}$/ };
const resource = new mongoose.Schema({
  kind: { type: String, enum: ['original', 'attachment', 'analysis', 'compound_member'], required: true },
  key: { type: String, required: true, maxlength: 128 },
  sha256: { ...hash, required: true }, bytes: { type: Number, required: true, min: 0, max: 16777216 },
  nextOffset: { type: Number, required: true, min: 0, default: 0 }, served: { type: Boolean, required: true, default: false }
}, { _id: false, strict: 'throw' });
// No text, source references, private paths or caller-supplied actor claims.
// This separate witness ledger cannot invalidate its own Entry/MemoryNote proof.
const schema = new mongoose.Schema({
  _id: { ...hash, required: true }, inputSha256: { ...hash, required: true }, bindingSha256: hash,
  state: { type: String, required: true, enum: ['preparing', 'prepared', 'deciding', 'accepted', 'held', 'blocked'] },
  sources: { type: [new mongoose.Schema({ resources: [resource] }, { _id: false, strict: 'throw' })], default: [] },
  preparedAt: Date, decidedAt: Date,
  decision: { type: String, enum: ['accepted_selected_semantics', 'held_ambiguous'] },
  blockedCode: { type: String, enum: ['evidence_changed', 'evidence_unavailable', 'evidence_capacity'] },
  version: { type: Number, required: true, default: 0 }
}, { collection: 'personal_history_semantic_reviews', timestamps: true, strict: 'throw' });
module.exports = mongoose.models.PersonalHistorySemanticReview || mongoose.model('PersonalHistorySemanticReview', schema);
