const mongoose = require('mongoose');

const SpecialXSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  displayName: {
    type: String,
    required: true,
    trim: true
  },
  purpose: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  promptProfile: {
    persona: {
      type: String,
      default: 'default_chat'
    },
    style: {
      type: String,
      enum: ['concise', 'balanced', 'detailed'],
      default: 'concise'
    },
    systemHint: {
      type: String,
      default: ''
    }
  },
  toolPolicy: {
    rag: { type: Boolean, default: true },
    n8n: { type: Boolean, default: true },
    dataapi: { type: Boolean, default: true },
    repoWatcher: { type: Boolean, default: true },
    codeActions: { type: Boolean, default: false }
  },
  modelPolicy: {
    localFirst: { type: Boolean, default: true },
    allowCloudFallback: { type: Boolean, default: false },
    maxLocalAttempts: { type: Number, default: 2, min: 1, max: 5 },
    preferredTaskType: { type: String, default: 'analysis' }
  },
  taskTypes: [{
    type: String,
    enum: [
      'repo_summary',
      'ci_failure_triage',
      'model_health_digest',
      'daily_operations_digest',
      'custom_prompt_analysis'
    ]
  }],
  schedule: {
    enabled: { type: Boolean, default: false },
    cron: { type: String, default: '' },
    timezone: { type: String, default: 'UTC' }
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  isSystem: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile',
    required: false
  },
  stats: {
    totalRuns: { type: Number, default: 0 },
    successRuns: { type: Number, default: 0 },
    failedRuns: { type: Number, default: 0 },
    avgDurationMs: { type: Number, default: 0 },
    lastRunAt: { type: Date, default: null }
  }
}, {
  timestamps: true
});

SpecialXSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
SpecialXSchema.index({ workspaceId: 1, isActive: 1, updatedAt: -1 });

SpecialXSchema.statics.getActive = async function(workspaceId = null) {
  const query = { isActive: true };
  if (workspaceId) {
    query.$or = [
      { workspaceId },
      { workspaceId: null },
      { workspaceId: { $exists: false } }
    ];
  }
  return this.find(query).sort({ isSystem: -1, updatedAt: -1 });
};

SpecialXSchema.statics.ensureDefaultOperator = async function(workspaceId = null) {
  const name = 'specialx.operator.v1';
  const existing = await this.findOne({ name, workspaceId: workspaceId || null });
  if (existing) {
    return existing;
  }

  return this.create({
    workspaceId: workspaceId || null,
    name,
    displayName: 'SpecialX Operator',
    purpose: 'Dispatches queue jobs and generates compact operational summaries.',
    description: 'System-managed default SpecialX profile for autonomous ops automation.',
    promptProfile: {
      persona: 'default_chat',
      style: 'concise',
      systemHint: 'Return structured outputs with action-first summaries.'
    },
    toolPolicy: {
      rag: true,
      n8n: true,
      dataapi: true,
      repoWatcher: true,
      codeActions: false
    },
    modelPolicy: {
      localFirst: true,
      allowCloudFallback: false,
      maxLocalAttempts: 2,
      preferredTaskType: 'analysis'
    },
    taskTypes: [
      'repo_summary',
      'ci_failure_triage',
      'model_health_digest',
      'daily_operations_digest',
      'custom_prompt_analysis'
    ],
    isActive: true,
    isSystem: true
  });
};

module.exports = mongoose.model('SpecialX', SpecialXSchema);
