'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// Only personalHistoryContextContract produces these bounded, checked data.
// They enrich a source assertion, never its human decision or selected memory.
module.exports = new Schema({
  importId: { type: String, required: true, maxlength: 256 },
  revision: { type: Number, required: true, min: 1 },
  inputHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  reviewAuthority: { type: String, enum: ['imported-source-metadata'], required: true },
  timeline: { type: Schema.Types.Mixed, required: true },
  overrides: { type: Schema.Types.Mixed, default: {} },
  ownerEditedAt: { type: Date, default: null },
  ownerEdits: { type: [Schema.Types.Mixed], default: [] },
  sources: { type: [Schema.Types.Mixed], default: [] },
  relations: { type: [Schema.Types.Mixed], default: [] },
  media: { type: [Schema.Types.Mixed], default: [] }
}, { _id: false });
