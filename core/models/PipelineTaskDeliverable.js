'use strict';
const mongoose = require('mongoose');

// One immutable file a pipeline task produced. The task owns it: the record
// is keyed by pipelineId (never by a conversation), its scope is derived by
// Core from the task, and its bytes stay in this collection. A deliverable is
// not memory: nothing here is indexed for RAG or sent to a third party.
const schema = new mongoose.Schema({
  pipelineId: { type: String, required: true, index: true },
  // Worker attempt that produced the file, or null for an operator upload.
  attempt: { type: Number, min: 1, max: 10, default: null },
  name: { type: String, required: true, maxlength: 160 },
  mimeType: { type: String, required: true },
  kind: { type: String, enum: ['image', 'document'], required: true },
  size: { type: Number, required: true, min: 1 },
  sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  data: { type: Buffer, required: true, select: false },
  scope: {
    lane: { type: String, enum: ['engineering', 'private'], required: true },
    service: { type: String, default: '' },
  },
  producer: {
    declared: { type: String, required: true, maxlength: 160 },
    channel: { type: String, enum: ['worker_api', 'operator_api'], required: true },
    leaseRef: { type: String, default: null },
    permitSeq: { type: Number, min: 1, default: null },
  },
  retention: { type: String, enum: ['task_lifetime'], default: 'task_lifetime' },
  storedAt: { type: Date, required: true },
}, { collection: 'pipeline_task_deliverables' });

// A retried registration of the same name for the same attempt resolves to
// the stored row; a different content under that name is a conflict.
schema.index({ pipelineId: 1, attempt: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('PipelineTaskDeliverable', schema);
