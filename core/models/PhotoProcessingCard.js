'use strict';
const mongoose = require('mongoose');
// One content identity across imports. Original facts, model proposals and
// owner review occupy separate fields; importing never overwrites review.
const schema = new mongoose.Schema({
  _id: String, assetId: String, libraryId: String, projection: mongoose.Schema.Types.Mixed,
  metadata: mongoose.Schema.Types.Mixed,
  analysis: mongoose.Schema.Types.Mixed,
  pendingDecision: String,
  review: { type: mongoose.Schema.Types.Mixed, default: () => ({ revision: 0, approved: false }) },
  frame: { type: mongoose.Schema.Types.Mixed, default: () => ({ revision: 0, selected: false }) },
}, { timestamps: true, collection: 'photo_processing_cards' });
module.exports = mongoose.models.PhotoProcessingCard || mongoose.model('PhotoProcessingCard', schema);
