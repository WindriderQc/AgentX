'use strict';

const { Schema } = require('mongoose');

module.exports = new Schema({
  requestId: { type: String, required: true, maxlength: 36 },
  observationId: { type: String, required: true, maxlength: 36 },
  entryRevision: { type: Number, required: true },
  sourceIndex: { type: Number, required: true },
  basisHash: { type: String, required: true, maxlength: 64 },
  snapshot: { type: Schema.Types.Mixed, required: true },
  snapshotHash: { type: String, required: true, maxlength: 64 },
  preparedAt: { type: Date, required: true }
}, { _id: false });
