'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ _id: String, sha256: String, kind: String, inputHash: String,
  value: mongoose.Schema.Types.Mixed, expectedRevision: Number, scope: String,
  state: { type: String, default: 'accepted' }, response: mongoose.Schema.Types.Mixed,
}, { timestamps: true, collection: 'photo_processing_decisions' });
module.exports = mongoose.models.PhotoProcessingDecision || mongoose.model('PhotoProcessingDecision', schema);
