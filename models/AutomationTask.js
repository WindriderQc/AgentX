const mongoose = require('mongoose');

const AutomationTaskSchema = new mongoose.Schema({
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
  source: {
    type: String,
    enum: ['manual', 'schedule', 'system', 'n8n', 'ci', 'webhook'],
    default: 'manual',
    index: true
  },
  type: {
    type: String,
    enum: [
      'repo_summary',
      'ci_failure_triage',
      'model_health_digest',
      'daily_operations_digest',
      'custom_prompt_analysis'
    ],
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['queued', 'leased', 'running', 'completed', 'failed', 'dead_letter', 'cancelled'],
    default: 'queued',
    index: true
  },
  priority: {
    type: Number,
    min: 1,
    max: 10,
    default: 5,
    index: true
  },
  input: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  constraints: {
    noCloud: { type: Boolean, default: true },
    allowCloudFallback: { type: Boolean, default: false },
    maxLocalAttempts: { type: Number, default: 2, min: 1, max: 5 },
    timeoutMs: { type: Number, default: 120000, min: 5000 }
  },
  runAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  maxAttempts: {
    type: Number,
    default: 3,
    min: 1,
    max: 10
  },
  lease: {
    owner: { type: String, default: null },
    leasedAt: { type: Date, default: null },
    leaseExpiresAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null }
  },
  idempotencyKey: {
    type: String,
    trim: true,
    default: null
  },
  tags: {
    type: [String],
    default: []
  },
  requestedBy: {
    userId: { type: String, default: null },
    authSource: { type: String, default: 'session' }
  },
  resultRunId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AutomationRun',
    default: null
  },
  lastError: {
    type: String,
    default: null
  },
  startedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

AutomationTaskSchema.index({ status: 1, runAt: 1, priority: 1 });
AutomationTaskSchema.index({ workspaceId: 1, createdAt: -1 });
AutomationTaskSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

AutomationTaskSchema.statics.claimNext = async function(workerId, leaseMs = 45000, now = new Date()) {
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  const query = {
    $or: [
      { status: 'queued', runAt: { $lte: now } },
      { status: 'leased', 'lease.leaseExpiresAt': { $lte: now } }
    ]
  };

  const update = {
    $set: {
      status: 'leased',
      'lease.owner': workerId,
      'lease.leasedAt': now,
      'lease.leaseExpiresAt': leaseExpiresAt,
      'lease.heartbeatAt': now,
      startedAt: null,
      completedAt: null
    }
  };

  return this.findOneAndUpdate(query, update, {
    sort: { priority: 1, runAt: 1, createdAt: 1 },
    new: true
  });
};

AutomationTaskSchema.statics.heartbeat = async function(taskId, workerId, leaseMs = 45000) {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  return this.findOneAndUpdate(
    {
      _id: taskId,
      status: { $in: ['leased', 'running'] },
      'lease.owner': workerId
    },
    {
      $set: {
        'lease.heartbeatAt': now,
        'lease.leaseExpiresAt': leaseExpiresAt
      }
    },
    { new: true }
  );
};

module.exports = mongoose.model('AutomationTask', AutomationTaskSchema);
