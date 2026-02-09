const mongoose = require('mongoose');

const ArtifactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  kind: { type: String, enum: ['json', 'markdown', 'text', 'metric'], default: 'json' },
  content: { type: mongoose.Schema.Types.Mixed, default: null }
}, { _id: false });

const AutomationRunSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false,
    index: true
  },
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AutomationTask',
    required: true,
    index: true
  },
  specialXId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SpecialX',
    required: false,
    index: true
  },
  workerId: {
    type: String,
    required: true,
    index: true
  },
  attempt: {
    type: Number,
    default: 1
  },
  status: {
    type: String,
    enum: ['running', 'completed', 'failed'],
    default: 'running',
    index: true
  },
  execution: {
    localFirst: { type: Boolean, default: true },
    fallbackUsed: { type: Boolean, default: false },
    model: { type: String, default: null },
    target: { type: String, default: null },
    taskType: { type: String, default: null },
    routed: { type: Boolean, default: false }
  },
  summary: {
    type: String,
    default: ''
  },
  output: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  metrics: {
    localCalls: { type: Number, default: 0 },
    cloudCalls: { type: Number, default: 0 },
    retriesUsed: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 }
  },
  artifacts: {
    type: [ArtifactSchema],
    default: []
  },
  error: {
    message: { type: String, default: null },
    code: { type: String, default: null },
    stack: { type: String, default: null }
  },
  startedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  finishedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

AutomationRunSchema.index({ createdAt: -1 });
AutomationRunSchema.index({ taskId: 1, createdAt: -1 });
AutomationRunSchema.index({ workspaceId: 1, createdAt: -1 });
AutomationRunSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('AutomationRun', AutomationRunSchema);
