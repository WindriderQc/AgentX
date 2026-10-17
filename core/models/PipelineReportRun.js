'use strict';
const mongoose = require('mongoose');
// A manual report's native call/result receipts; PipelineTask remains the owner.
// Report bytes belong to task deliverables, never to this execution journal.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  executionVersion: { type: Number, immutable: true, default: undefined },
  pipelineId: { type: String, required: true, index: true },
  taskId: { type: String, required: true },
  claimSeq: { type: Number, required: true, min: 1 },
  specSha256: { type: String, required: true },
  sourceCommit: { type: String, required: true },
  parentRequestId: { type: String, default: null, immutable: true },
  parentSha256: { type: String, default: null, immutable: true },
  reportName: { type: String, required: true },
  model: { type: String, required: true },
  modelCallLimit: { type: Number, default: 128, min: 128, max: 256, immutable: true, validate: Number.isSafeInteger },
  host: { type: String, required: true },
  authority: { type: mongoose.Schema.Types.Mixed, default: undefined, immutable: true },
  workSeconds: { type: Number, default: 0 },
  startedAt: { type: Date, default: undefined, immutable: true },
  runnerStartedAt: { type: String, default: undefined, immutable: true },
  finishedAt: { type: Date, default: undefined },
  terminalAt: { type: Date, default: undefined },
  inventory: { type: mongoose.Schema.Types.Mixed, default: undefined, immutable: true },
  inventorySha256: { type: String, default: undefined, immutable: true },
  coverage: { type: mongoose.Schema.Types.Mixed, default: undefined },
  deadlineAt: { type: Date, required: true },
  state: { type: String, enum: ['active', 'review', 'blocked'], default: 'active' },
  revision: { type: Number, default: 0 },
  finalKind: { type: String, enum: ['review', 'blocked'], default: undefined },
  finalHash: { type: String, default: undefined },
  pendingInferences: { type: [String], default: [] },
  modelReceipts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  result: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Cloud escalation allowed for this execution (#835): ordered models and the
  // task's remaining cost cap at start, fixed for the execution.
  escalation: { type: mongoose.Schema.Types.Mixed, default: undefined, immutable: true },
  escalationCalls: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { collection: 'pipeline_report_runs' });
// Preserve historical journals; new executions enforce one immutable identity per task claim.
schema.index({ taskId: 1, claimSeq: 1 }, { unique: true, partialFilterExpression: { executionVersion: 1 } });
module.exports = mongoose.model('PipelineReportRun', schema);
