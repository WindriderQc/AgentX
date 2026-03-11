const mongoose = require('mongoose');

const PatchProposalSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false,
    index: true
  },
  specialXId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SpecialX',
    required: false,
    index: true
  },
  sourceTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AutomationTask',
    required: true,
    index: true
  },
  docsDriftTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AutomationTask',
    required: false,
    default: null,
    index: true
  },
  applyTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AutomationTask',
    required: false,
    default: null,
    index: true
  },
  findingId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
    default: null
  },
  findingKey: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  findingSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  repoPath: {
    type: String,
    required: true,
    trim: true
  },
  targetFile: {
    type: String,
    required: true,
    trim: true
  },
  originalContent: {
    type: String,
    default: ''
  },
  proposedContent: {
    type: String,
    required: true
  },
  diffSummary: {
    type: String,
    default: ''
  },
  blastRadius: {
    type: String,
    enum: ['docs_only', 'code'],
    default: 'docs_only'
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'applied', 'expired'],
    default: 'pending',
    index: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  approvedBy: {
    type: String,
    enum: ['console', 'telegram', 'api'],
    default: null
  },
  approvedByUserId: {
    type: String,
    default: null
  },
  approvedAt: {
    type: Date,
    default: null
  },
  rejectedBy: {
    type: String,
    enum: ['console', 'telegram', 'api'],
    default: null
  },
  rejectedByUserId: {
    type: String,
    default: null
  },
  rejectedAt: {
    type: Date,
    default: null
  },
  appliedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

PatchProposalSchema.index({ status: 1, createdAt: -1 });
PatchProposalSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
PatchProposalSchema.index({ sourceTaskId: 1, targetFile: 1, findingKey: 1 }, { unique: true });

module.exports = mongoose.model('PatchProposal', PatchProposalSchema);
