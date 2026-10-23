'use strict';
const { Schema } = require('mongoose');
const states = ['proposed', 'needs_clarification', 'accepted', 'deferred', 'declined'];
const actor = new Schema({ declared: String, authenticated: { type: String, default: null }, channel: String }, { _id: false });
const decision = new Schema({
  revision: { type: Number, required: true }, requestId: String, intentHash: String,
  from: String, to: { type: String, enum: states, required: true },
  reason: { type: String, required: true }, scopeFingerprint: { type: String, required: true },
  evidenceRef: String,
  actor: { type: actor, required: true }, at: { type: Date, required: true },
}, { _id: false });
module.exports = new Schema({
  state: { type: String, enum: states, required: true },
  revision: { type: Number, min: 1, required: true },
  scopeFingerprint: { type: String, required: true },
  history: { type: [decision], required: true },
}, { _id: false });
