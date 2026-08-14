'use strict';

const mongoose = require('mongoose');

const PsyXStateSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false,
    index: true
  },
  activeThreads: [{ type: String, trim: true }],
  patterns: [{ type: String, trim: true }],
  hypotheses: [{ type: String, trim: true }],
  relationships: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  openLoops: [{ type: String, trim: true }],
  experiments: [{
    hypothesis: String,
    action: String,
    expectedSignal: String,
    result: String,
    status: {
      type: String,
      enum: ['planned', 'active', 'completed', 'abandoned'],
      default: 'planned'
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  }],
  recentEmotionalState: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  importantEvents: [{
    summary: String,
    occurredAt: Date,
    recordedAt: { type: Date, default: Date.now }
  }],
  contradictions: [{ type: String, trim: true }],
  riskSignals: [{
    signal: String,
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'low'
    },
    observedAt: { type: Date, default: Date.now },
    resolvedAt: Date
  }],
  notes: [{
    text: { type: String, required: true },
    source: { type: String, default: 'user' },
    createdAt: { type: Date, default: Date.now }
  }],
  lastConversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    default: null
  },
  interactionCount: {
    type: Number,
    default: 0
  },
  lastInteractionAt: Date
}, {
  timestamps: true,
  minimize: false
});

PsyXStateSchema.index(
  { userId: 1, workspaceId: 1 },
  { unique: true }
);

module.exports = mongoose.model('PsyXState', PsyXStateSchema);
