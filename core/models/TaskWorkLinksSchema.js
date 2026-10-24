'use strict';
const { Schema } = require('mongoose');
const reference = new Schema({ kind: { type: String, enum: ['github_issue', 'conversation', 'pipeline_task'], required: true },
  repository: String, number: Number, runtime: String, id: String, pipelineId: String }, { _id: false });
const actor = new Schema({ declared: String, authenticated: { type: String, default: null }, channel: String }, { _id: false });
const entry = new Schema({ key: { type: String, required: true }, reference: { type: reference, required: true },
  relation: { type: String, enum: ['report', 'duplicate_report', 'related_work'], required: true },
  scopeFingerprint: { type: String, required: true }, actor, reason: String, at: Date }, { _id: false });
const event = new Schema({ revision: Number, requestId: String, intentHash: String,
  operation: { type: String, enum: ['add', 'review', 'remove'], required: true }, entry }, { _id: false });
module.exports = new Schema({ revision: { type: Number, min: 1, required: true }, entries: [entry], history: [event] }, { _id: false });
