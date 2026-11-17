'use strict';
const mongoose = require('mongoose');
// Derived, replaceable browsing aid; never an original or an analysis decision.
const schema = new mongoose.Schema({
  _id: String, version: Number, operationId: String, observedAt: Date,
  algorithm: String, sourceCount: Number, failedCount: Number,
  entries: [{ _id: false, sha256: String, assetId: String, groupId: String }],
}, { collection: 'photo_library_similarity' });
module.exports = mongoose.models.PhotoLibrarySimilarity || mongoose.model('PhotoLibrarySimilarity', schema);
