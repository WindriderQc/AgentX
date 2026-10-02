'use strict';

const mongoose = require('mongoose');

/**
 * The operator's answer to one pin context proposal. A proposal is identified
 * by the profile write that produced it, so a newer profile starts undecided.
 * "keep_current" keeps the proposal visible until the pin matches it.
 */
const ContextProposalDecisionSchema = new mongoose.Schema({
  modelName: { type: String, required: true },
  hostId: { type: String, required: true },
  hostUrl: { type: String, required: true },
  proposalId: { type: String, required: true },
  decision: { type: String, enum: ['keep_current', 'applied', 'apply_failed', 'apply_outcome_unknown'], required: true },
  currentContext: { type: Number, required: true },
  proposedContext: { type: Number, required: true },
  decidedAt: { type: Date, default: Date.now },
  // Core's outcome for an apply attempt: code, message, rollback, speed.
  // apply_outcome_unknown: Core gave no HTTP answer; the pin may have changed.
  outcome: { type: mongoose.Schema.Types.Mixed, default: null }
}, { collection: 'contextproposaldecisions', timestamps: true });

ContextProposalDecisionSchema.index({ modelName: 1, hostId: 1, decidedAt: -1 });

module.exports = mongoose.model('ContextProposalDecision', ContextProposalDecisionSchema);
