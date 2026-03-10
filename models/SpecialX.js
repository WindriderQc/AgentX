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
      'custom_prompt_analysis',
      'maintenance_snapshot',
      'maintenance_digest',
      'telemetry_aggregate',
      'schedule_reconcile'
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

// ── Maintenance profiles (system-managed, workspaceId: null) ──

const MAINTENANCE_PROFILES = [
  {
    name: 'specialx.maintenance-operator.v1',
    displayName: 'Maintenance Operator',
    purpose: 'Runs nightly repo scans and generates maintenance digests for all managed repos.',
    description: 'System-managed profile: drives maintenance_snapshot and maintenance_digest tasks.',
    promptProfile: {
      persona: 'default_chat',
      style: 'concise',
      systemHint: 'Return structured, action-first findings. Focus on high-severity issues.'
    },
    toolPolicy: { rag: false, n8n: false, dataapi: false, repoWatcher: true, codeActions: false },
    modelPolicy: { localFirst: true, allowCloudFallback: false, maxLocalAttempts: 2, preferredTaskType: 'analysis' },
    taskTypes: ['maintenance_snapshot', 'maintenance_digest'],
    schedule: { enabled: true, cron: '0 3 * * *', timezone: 'UTC' }
  },
  {
    name: 'specialx.telemetry-aggregator.v1',
    displayName: 'Telemetry Aggregator',
    purpose: 'Hourly aggregation of InferenceLog records into HostUsageLedger.',
    description: 'System-managed profile: drives telemetry_aggregate tasks every hour.',
    promptProfile: { persona: 'default_chat', style: 'concise', systemHint: '' },
    toolPolicy: { rag: false, n8n: false, dataapi: true, repoWatcher: false, codeActions: false },
    modelPolicy: { localFirst: true, allowCloudFallback: false, maxLocalAttempts: 1, preferredTaskType: 'analysis' },
    taskTypes: ['telemetry_aggregate'],
    schedule: { enabled: true, cron: '0 * * * *', timezone: 'UTC' }
  },
  {
    name: 'specialx.schedule-auditor.v1',
    displayName: 'Schedule Auditor',
    purpose: 'Daily ops digest and schedule reconciliation across all managed repos.',
    description: 'System-managed profile: drives daily_operations_digest and schedule_reconcile tasks.',
    promptProfile: {
      persona: 'default_chat',
      style: 'balanced',
      systemHint: 'Return a compact Telegram-ready digest. Bullet points, no prose.'
    },
    toolPolicy: { rag: false, n8n: true, dataapi: true, repoWatcher: true, codeActions: false },
    modelPolicy: { localFirst: true, allowCloudFallback: false, maxLocalAttempts: 2, preferredTaskType: 'analysis' },
    taskTypes: ['daily_operations_digest', 'schedule_reconcile'],
    schedule: { enabled: true, cron: '0 7 * * *', timezone: 'UTC' }
  }
];

SpecialXSchema.statics.ensureMaintenanceProfiles = async function() {
  const created = [];
  for (const profile of MAINTENANCE_PROFILES) {
    const existing = await this.findOne({ name: profile.name, workspaceId: null });
    if (!existing) {
      const doc = await this.create({ workspaceId: null, ...profile, isActive: true, isSystem: true });
      created.push(doc.name);
    }
  }
  return created;
};

module.exports = mongoose.model('SpecialX', SpecialXSchema);
