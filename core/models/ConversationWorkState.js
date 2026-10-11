'use strict';

const mongoose = require('mongoose');
// References and execution metadata only. Complete request/result/receipt
// payloads stay with Core's existing transcript payload owner.
const schema = new mongoose.Schema({
  _id: String, owner: { type: String, required: true }, surface: String,
  conversationId: String, sessionId: String, turnId: String, exchangeId: String,
  requestSha256: String, mode: String, state: String, revision: Number,
  receivedAt: Date, updatedAt: Date, contextReady: Boolean,
  contextRef: mongoose.Schema.Types.Mixed, attempt: mongoose.Schema.Types.Mixed,
  guardian: mongoose.Schema.Types.Mixed, result: mongoose.Schema.Types.Mixed,
  tools: [mongoose.Schema.Types.Mixed], events: [mongoose.Schema.Types.Mixed],
  nativeAdmissions: [mongoose.Schema.Types.Mixed],
  sequence: Number, delivery: mongoose.Schema.Types.Mixed,
  erased: Boolean, reason: String, classification: String
}, { versionKey: false, collection: 'conversation_work_states', minimize: false,
  writeConcern: { w: 'majority', j: true } });
schema.index({ owner: 1, sessionId: 1, sequence: 1 });
schema.index({ owner: 1, state: 1, receivedAt: 1 });
schema.index({ 'attempt.sessionKey': 1 }, { unique: true, sparse: true });
module.exports = mongoose.models.ConversationWorkState || mongoose.model('ConversationWorkState', schema);
