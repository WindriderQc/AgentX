const mongoose = require('mongoose');

const SelfHealingApprovalSchema = new mongoose.Schema({
  ruleName: {
    type: String,
    required: true,
    index: true
  },
  strategy: {
    type: String,
    required: true
  },
  action: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'executed', 'failed'],
    default: 'pending',
    index: true
  },
  reason: {
    type: String,
    default: ''
  },
  ruleSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  context: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  requestedBy: {
    type: String,
    default: 'system'
  },
  requestedAt: {
    type: Date,
    default: Date.now
  },
  decidedBy: {
    type: String,
    default: null
  },
  decisionComment: {
    type: String,
    default: ''
  },
  decidedAt: {
    type: Date,
    default: null
  },
  executionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SelfHealingExecution',
    default: null
  }
}, {
  timestamps: true
});

SelfHealingApprovalSchema.index({ status: 1, requestedAt: -1 });
SelfHealingApprovalSchema.index({ ruleName: 1, status: 1, requestedAt: -1 });

module.exports = mongoose.model('SelfHealingApproval', SelfHealingApprovalSchema);
