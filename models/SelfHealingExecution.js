const mongoose = require('mongoose');

const SelfHealingExecutionSchema = new mongoose.Schema({
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
    enum: ['success', 'failed', 'skipped', 'pending_approval'],
    required: true,
    index: true
  },
  duration: {
    type: Number,
    default: 0
  },
  error: {
    type: String,
    default: null
  },
  cooldownMs: {
    type: Number,
    default: 0
  },
  cooldownExpiresAt: {
    type: Date,
    default: null
  },
  approvalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SelfHealingApproval',
    default: null
  },
  triggerSource: {
    type: String,
    default: 'auto'
  },
  context: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  executedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

SelfHealingExecutionSchema.index({ ruleName: 1, executedAt: -1 });
SelfHealingExecutionSchema.index({ status: 1, executedAt: -1 });

module.exports = mongoose.model('SelfHealingExecution', SelfHealingExecutionSchema);
