'use strict';
const mongoose = require('mongoose');
// A manual report's native call/result receipts; PipelineTask remains the owner.
// Report bytes belong to task deliverables, never to this execution journal.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  pipelineId: { type: String, required: true, index: true },
  taskId: { type: String, required: true },
  claimSeq: { type: Number, required: true, min: 1 },
  specSha256: { type: String, required: true },
  sourceCommit: { type: String, required: true },
  reportName: { type: String, required: true },
  model: { type: String, required: true },
  host: { type: String, required: true },
  deadlineAt: { type: Date, required: true },
  state: { type: String, enum: ['active', 'review', 'blocked'], default: 'active' },
  revision: { type: Number, default: 0 },
  finalKind: { type: String, enum: ['review', 'blocked'], default: undefined },
  finalHash: { type: String, default: undefined },
  pendingInferences: { type: [String], default: [] },
  modelReceipts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  result: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { collection: 'pipeline_report_runs' });
module.exports = mongoose.model('PipelineReportRun', schema);
