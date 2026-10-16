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
  // Owner policy for escalating a failed report step to a cloud model (#835).
  // Off by default; each task must also allow it on its explicit grant.
  escalation: {
    enabled: { type: Boolean, default: false },
    models: { type: [String], default: ['openai/gpt-5.6-sol', 'openrouter/nvidia/nemotron-3-super-120b-a12b:free'] },
    maxCostUsdPerTask: { type: Number, default: 10, min: 0, max: 1000 },
    revision: { type: Number, default: 0 },
  },
}, { timestamps: true }));
