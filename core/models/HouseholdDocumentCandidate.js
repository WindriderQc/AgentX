'use strict';
const mongoose = require('mongoose');
// Review snapshots are private Core records, excluded from every recall path.
// RAG owns the approved derivative; the configured archive owns the original.
const schema = new mongoose.Schema({
  _id: String,
  sourceId: { type: String, required: true },
  revision: { type: String, required: true },
  origin: { type: mongoose.Schema.Types.Mixed, required: true },
  text: { type: String, required: true },
  state: { type: String, enum: ['staged', 'selected', 'dismissed', 'dispatching', 'uncertain', 'promoted'], default: 'staged' },
  selection: mongoose.Schema.Types.Mixed,
  requestId: String,
  target: mongoose.Schema.Types.Mixed,
  receipt: mongoose.Schema.Types.Mixed,
  failure: String,
}, { timestamps: true, collection: 'household_document_candidates', autoIndex: false });
schema.index({ requestId: 1 }, { unique: true, sparse: true });
module.exports = mongoose.models.HouseholdDocumentCandidate || mongoose.model('HouseholdDocumentCandidate', schema);
