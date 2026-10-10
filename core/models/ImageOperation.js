'use strict';
const mongoose = require('mongoose');
const lineageSchema = new mongoose.Schema({
  version: { type: Number, enum: [1], required: true },
  parent: { operationId: String, sha256: String, width: Number, height: Number },
  references: [{ _id: false, sourceSha256: String, workerSha256: String, transform: String, parentOperationId: String }],
}, { _id: false });
const executionSchema = new mongoose.Schema({
  version: { type: Number, enum: [1], required: true },
  builder: { id: { type: String, required: true }, version: { type: Number, required: true } },
  graphSha256: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
  graph: { type: mongoose.Schema.Types.Mixed, required: true },
  parameters: { width: Number, height: Number, seed: Number, steps: Number },
}, { _id: false });
const referenceReceiptSchema = new mongoose.Schema({
  path: { type: String, required: true }, sha256: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
  mimeType: { type: String, required: true }, size: { type: Number, required: true },
  origin: { type: String, enum: ['uploaded', 'generated'], required: true }, archivedAt: { type: String, required: true },
  width: { type: Number, required: true }, height: { type: Number, required: true },
}, { _id: false });
const referenceStorageSchema = new mongoose.Schema({
  version: { type: Number, enum: [1], required: true },
  entries: [{ _id: false, source: { type: referenceReceiptSchema, required: true }, worker: { type: referenceReceiptSchema, required: true } }],
}, { _id: false });
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  actionKey: { type: String, required: true, unique: true },
  queueRequestId: { type: String },
  queueDispatchId: { type: String },
  requestHash: { type: String, required: true },
  conversation: { surface: String, sessionId: String, packId: String, scopeId: String },
  expert: { type: new mongoose.Schema({ sessionId: String, turnId: String, agent: String, harness: String,
    reportedModel: String, promptEdited: Boolean, settingsEdited: Boolean }, { _id: false }), default: undefined },
  workerSlot: { type: String },
  workerUrl: { type: String, select: false },
  state: { type: String, required: true, default: 'accepted' },
  request: { type: mongoose.Schema.Types.Mixed, required: true, select: false },
  references: { type: [Buffer], select: false, default: undefined },
  referenceStorage: { type: referenceStorageSchema, select: false },
  lineage: { type: lineageSchema },
  execution: { type: executionSchema, select: false },
  profile: { type: mongoose.Schema.Types.Mixed, required: true },
  jobId: { type: String },
  dispatchStarted: { type: Boolean, default: false },
  cancelRequested: { type: Boolean, default: false },
  admission: { type: mongoose.Schema.Types.Mixed, select: false },
  snapshot: { type: mongoose.Schema.Types.Mixed, select: false },
  output: { type: mongoose.Schema.Types.Mixed, select: false },
  artifact: { type: mongoose.Schema.Types.Mixed },
  runtimeRestored: { type: Boolean, default: false },
  error: { type: String },
  timings: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true, collection: 'image_operations', versionKey: false, autoCreate: false, autoIndex: false });
schema.index({ workerSlot: 1 }, { unique: true, sparse: true });
schema.index({ createdAt: -1 });
schema.index({ 'conversation.surface': 1, 'conversation.sessionId': 1, 'conversation.packId': 1, 'conversation.scopeId': 1, createdAt: -1 });
module.exports = mongoose.models.ImageOperation || mongoose.model('ImageOperation', schema);
