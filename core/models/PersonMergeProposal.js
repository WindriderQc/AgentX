'use strict';

const mongoose = require('mongoose');

// A proposed merge of two people. Only the owner accepts it; an accepted merge
// remembers the observations it moved so it can be undone exactly.
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, maxlength: 64 },
  scope: { type: String, enum: ['owner'], default: 'owner', required: true },
  a: { type: String, required: true, maxlength: 24 },
  b: { type: String, required: true, maxlength: 24 },
  reason: { type: String, enum: ['shared-email', 'shared-phone', 'same-name'], required: true },
  evidence: { type: String, default: '', maxlength: 320 },
  state: { type: String, enum: ['proposed', 'accepted', 'dismissed', 'undone'], default: 'proposed' },
  moved: [{ type: String, maxlength: 24 }],
  revision: { type: Number, default: 0 },
  decidedAt: { type: Date, default: null }
}, { timestamps: true, collection: 'person_merge_proposals' });

schema.index({ scope: 1, state: 1, reason: 1, createdAt: 1 });
schema.index({ scope: 1, a: 1 });
schema.index({ scope: 1, b: 1 });

module.exports = mongoose.models.PersonMergeProposal || mongoose.model('PersonMergeProposal', schema);
