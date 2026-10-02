const mongoose = require('mongoose');

// One human decision about one exact plan revision. It is stored inside that
// revision, so a newer revision starts undecided and never inherits it. The
// decision names the scope fingerprint and task basis it was made against.
const PlanDecisionSchema = new mongoose.Schema({
  outcome: { type: String, enum: ['approved', 'changes_requested'], required: true },
  planFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  scopeFingerprint: { type: String, default: null },
  basisRef: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  actor: {
    declared: { type: String, required: true },
    authenticated: { type: String, default: null },
    channel: { type: String, required: true },
  },
  reason: { type: String, default: null },
  at: { type: Date, required: true },
}, { _id: false });

// One recorded plan revision (see pipelineTaskPlans.js). A plan is inert data:
// its presence, text or decision never starts work or changes automation.
const PlanRevisionSchema = new mongoose.Schema({
  schema: { type: String, required: true },
  revision: { type: Number, required: true, min: 1 },
  mode: { type: String, enum: ['plan', 'research'], required: true },
  at: { type: Date, required: true },
  actor: {
    declared: { type: String, default: null },
    authenticated: { type: String, default: null },
    channel: { type: String, required: true },
  },
  text: { type: String, required: true },
  steps: { type: [String], default: undefined },
  truncated: { type: Boolean, default: false },
  originalLength: { type: Number, min: 0, required: true },
  scope: { type: [String], default: undefined },
  scopeFingerprint: { type: String, default: null },
  basisRef: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  fingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  decision: { type: PlanDecisionSchema, default: undefined },
}, { _id: false });

module.exports = { PlanRevisionSchema, PlanDecisionSchema };
