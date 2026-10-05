'use strict';
const { Schema } = require('mongoose');

// User-confirmed continuity belongs to the canonical conversation, not a persona.
module.exports = new Schema({
  revision: { type: Number, required: true, min: 1 },
  summary: { type: String, required: true, maxlength: 2000 },
  takeaway: { type: String, default: '', maxlength: 1000 },
  nextStep: { type: String, default: '', maxlength: 1000 },
  sourceHash: { type: String, required: true },
  sourceMessageCount: { type: Number, required: true },
  updatedAt: { type: Date, required: true }
}, { _id: false });
