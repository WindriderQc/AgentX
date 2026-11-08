'use strict';

const { Schema } = require('mongoose');

// Native-source observations and explicit scope reviews belong to their
// historical assertion. They are neither task commitments nor mailbox grants.
module.exports = new Schema({
  requestId: { type: String, required: true, maxlength: 36 },
  entryRevision: { type: Number, required: true },
  basisHash: { type: String, required: true, maxlength: 64 },
  contextRevision: { type: Number, required: true },
  contextHash: { type: String, default: '', maxlength: 64 },
  snapshot: { type: Schema.Types.Mixed, required: true },
  snapshotHash: { type: String, required: true, maxlength: 64 },
  preparedAt: { type: Date, required: true },
  readRevision: { type: Number, default: 0 },
  coverage: { type: Schema.Types.Mixed, required: true },
  decisionIntent: { type: Schema.Types.Mixed, default: null },
  decision: { type: Schema.Types.Mixed, default: null }
}, { _id: false });
