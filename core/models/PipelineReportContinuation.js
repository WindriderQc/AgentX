'use strict';
const mongoose = require('mongoose');

// Owner switch for automatic report continuation (#835) and the single active
// continuation, serialized across Core processes. Per-task runs stay on the
// PipelineTask (reportContinuation).
module.exports = mongoose.model('PipelineReportContinuation', new mongoose.Schema({
  _id: { type: String, default: 'report-continuation' },
  enabled: { type: Boolean, default: false },
  revision: { type: Number, default: 0 },
  actor: String,
  active: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true }));
