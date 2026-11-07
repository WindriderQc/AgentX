'use strict';

const mongoose = require('mongoose');

// A native measurement intent and its receipts, never a second work queue.
// Core owns reservations/dispatch. Unknown outcomes retain this slot without TTL.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  active: { type: Boolean, required: true, default: true },
  intent: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  queueId: String,
  dispatchId: String,
  nativePostAt: Date,
  nativeDispatchedAt: Date,
  nativeId: String,
  launchReceipt: mongoose.Schema.Types.Mixed,
  launchError: String,
  result: mongoose.Schema.Types.Mixed
}, { collection: 'coverage_attempts', timestamps: true });
schema.index({ active: 1 }, { unique: true, partialFilterExpression: { active: true } });

module.exports = mongoose.model('CoverageAttempt', schema);
