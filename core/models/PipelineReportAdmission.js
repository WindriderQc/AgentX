'use strict';
const mongoose = require('mongoose');
// A native admission belongs to exactly one report call, including legacy mappings.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  requestId: { type: String, required: true, index: true },
  pipelineId: { type: String, required: true }, taskId: { type: String, required: true },
  claimSeq: { type: Number, required: true }, specSha256: { type: String, required: true },
  sourceCommit: { type: String, required: true },
  callId: { type: String, required: true }, prepareId: { type: String, required: true },
  native: { type: mongoose.Schema.Types.Mixed, required: true },
  mapping: { type: mongoose.Schema.Types.Mixed, default: undefined },
  releaseReceipt: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { collection: 'pipeline_report_admissions' });
module.exports = mongoose.models.PipelineReportAdmission || mongoose.model('PipelineReportAdmission', schema);
