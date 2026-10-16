'use strict';
const mongoose = require('mongoose');
// Operator custody of original worker bytes, never a rewritten worker result.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  pipelineId: { type: String, required: true, index: true }, taskId: { type: String, required: true },
  claimSeq: { type: Number, required: true }, specSha256: { type: String, required: true },
  sourceCommit: { type: String, required: true }, reportName: { type: String, required: true },
  path: { type: String, required: true },
  sha256: { type: String, required: true }, deliverableId: { type: String, required: true },
  intentHash: { type: String, required: true }, archiveActor: { type: String, required: true },
  scopeEvidence: { type: mongoose.Schema.Types.Mixed, required: true },
  termination: { type: mongoose.Schema.Types.Mixed, required: true },
  nativeCosts: { type: [mongoose.Schema.Types.Mixed], required: true },
  originalOutcome: { type: mongoose.Schema.Types.Mixed, required: true },
}, { collection: 'pipeline_report_checkpoint_archives' });
module.exports = mongoose.model('PipelineReportCheckpointArchive', schema);
