'use strict';
const mongoose = require('mongoose');

// Observations and request identities only. HostProfile/Core retain ownership
// of runtime mutation, restoration, admission and release journals.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  hostId: { type: String, required: true },
  hostUrl: { type: String, required: true },
  model: { type: String, required: true },
  pinIndex: { type: Number, required: true },
  pins: { type: mongoose.Schema.Types.Mixed, required: true },
  artifact: { type: mongoose.Schema.Types.Mixed, required: true },
  contextProfileId: String,
  measuredVersion: String,
  numCtx: { type: Number, required: true },
  queueRequest: { type: mongoose.Schema.Types.Mixed, required: true },
  queueRequestId: { type: String, default: null },
  queueDispatchId: { type: String, default: null },
  operationId: { type: String, required: true },
  state: { type: String, enum: ['requested', 'dispatching', 'completed', 'failed', 'cancelled', 'unknown'], default: 'requested' },
  blocksReplacement: { type: Boolean, default: true },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  runtimeReleased: { type: Boolean, default: false },
  checkedAt: Date,
  startedAt: Date,
  finishedAt: Date,
  durationMs: Number,
  reason: String
}, { collection: 'pinnedcontextfitchecks', timestamps: true });
schema.index({ hostUrl: 1 }, { unique: true, partialFilterExpression: { blocksReplacement: true }, name: 'one_unresolved_fit_per_host' });
schema.index({ hostId: 1, model: 1, createdAt: -1 });
module.exports = mongoose.model('PinnedContextFitCheck', schema);
