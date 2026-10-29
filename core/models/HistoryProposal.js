'use strict';

const mongoose = require('mongoose');

// A correction Nestor proposes for a moment of the owner's history. It changes
// nothing until the owner accepts it; accepting applies it through the native
// context or souvenir edit, fenced by the revision Nestor saw.
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  scope: { type: String, enum: ['owner'], default: 'owner', required: true },
  entryId: { type: String, required: true, index: true, match: /^[a-f0-9]{24}$/ },
  target: { type: String, enum: ['context', 'souvenir'], required: true },
  souvenirNoteId: { type: String, default: '', maxlength: 24 },
  baseRevision: { type: Number, required: true, min: 0 },
  title: { type: String, default: '', maxlength: 500 },
  before: { type: mongoose.Schema.Types.Mixed, default: {} },
  changes: { type: mongoose.Schema.Types.Mixed, required: true },
  rationale: { type: String, required: true, maxlength: 2000 },
  evidence: [{ _id: false, quote: { type: String, maxlength: 500 }, source: { type: String, maxlength: 300 } }],
  proposedBy: { type: String, enum: ['nestor'], default: 'nestor' },
  conversationRef: { type: String, default: '', maxlength: 200 },
  state: { type: String, enum: ['pending', 'applying', 'accepted', 'refused', 'stale'], default: 'pending', index: true },
  decision: {
    reason: { type: String, default: '', maxlength: 2000 },
    at: { type: Date, default: null },
    appliedRevision: { type: Number, default: null }
  }
}, { timestamps: true, collection: 'history_proposals' });

schema.index({ scope: 1, state: 1, createdAt: -1 });

module.exports = mongoose.models.HistoryProposal || mongoose.model('HistoryProposal', schema);
