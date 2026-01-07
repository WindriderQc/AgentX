/**
 * Workspace Audit Log Model
 *
 * Tracks all significant actions within workspaces for compliance and debugging
 * Post-Week 4: Workspace activity audit logs (A2)
 */

const mongoose = require('mongoose');

const workspaceAuditLogSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile',
    required: true,
    index: true
  },
  action: {
    type: String,
    required: true,
    index: true,
    // Action format: 'resource.operation' (e.g., 'member.added', 'settings.changed')
    enum: [
      // Member actions
      'member.added',
      'member.removed',
      'member.role_changed',
      'member.invited',
      'invitation.revoked',
      'invitation.accepted',

      // Workspace settings
      'settings.changed',
      'settings.feature_toggled',
      'settings.model_restrictions_updated',

      // Ownership
      'ownership.transferred',

      // Custom models
      'model.registered',
      'model.deployed',
      'model.undeployed',
      'model.deleted',

      // Prompts
      'prompt.created',
      'prompt.activated',
      'prompt.deactivated',
      'prompt.deleted',

      // Workspace lifecycle
      'workspace.created',
      'workspace.deleted',
      'workspace.suspended',
      'workspace.reactivated',

      // Security
      'api_key.created',
      'api_key.revoked'
    ]
  },
  targetType: {
    type: String,
    required: true,
    enum: ['workspace', 'member', 'invitation', 'settings', 'model', 'prompt', 'api_key']
  },
  targetId: {
    type: mongoose.Schema.Types.Mixed, // Could be ObjectId or string
    index: true
  },
  changes: {
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: false // Using custom timestamp field
});

// Compound indexes for common queries
workspaceAuditLogSchema.index({ workspaceId: 1, timestamp: -1 });
workspaceAuditLogSchema.index({ workspaceId: 1, action: 1, timestamp: -1 });
workspaceAuditLogSchema.index({ workspaceId: 1, userId: 1, timestamp: -1 });
workspaceAuditLogSchema.index({ workspaceId: 1, targetType: 1, timestamp: -1 });

// TTL index (auto-delete logs older than 90 days)
workspaceAuditLogSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 } // 90 days
);

// Static method: Log an action
workspaceAuditLogSchema.statics.logAction = async function(data) {
  const {
    workspaceId,
    userId,
    action,
    targetType,
    targetId,
    changes,
    metadata = {},
    ipAddress,
    userAgent
  } = data;

  const log = new this({
    workspaceId,
    userId,
    action,
    targetType,
    targetId,
    changes,
    metadata,
    ipAddress,
    userAgent,
    timestamp: new Date()
  });

  await log.save();
  return log;
};

// Static method: Get recent activity for workspace
workspaceAuditLogSchema.statics.getRecentActivity = async function(workspaceId, options = {}) {
  const {
    limit = 50,
    skip = 0,
    action,
    targetType,
    userId,
    from,
    to
  } = options;

  const filter = { workspaceId };

  if (action) filter.action = action;
  if (targetType) filter.targetType = targetType;
  if (userId) filter.userId = userId;

  if (from || to) {
    filter.timestamp = {};
    if (from) filter.timestamp.$gte = new Date(from);
    if (to) filter.timestamp.$lte = new Date(to);
  }

  const logs = await this.find(filter)
    .populate('userId', 'username email')
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(limit);

  const total = await this.countDocuments(filter);

  return {
    logs,
    total,
    limit,
    skip
  };
};

// Static method: Get activity statistics
workspaceAuditLogSchema.statics.getStatistics = async function(workspaceId, options = {}) {
  const { from, to } = options;

  const matchStage = { workspaceId };

  if (from || to) {
    matchStage.timestamp = {};
    if (from) matchStage.timestamp.$gte = new Date(from);
    if (to) matchStage.timestamp.$lte = new Date(to);
  }

  const results = await this.aggregate([
    { $match: matchStage },
    {
      $facet: {
        // Actions by type
        byAction: [
          { $group: { _id: '$action', count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ],

        // Actions by user
        byUser: [
          { $group: { _id: '$userId', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 }
        ],

        // Timeline (hourly buckets)
        timeline: [
          {
            $group: {
              _id: {
                year: { $year: '$timestamp' },
                month: { $month: '$timestamp' },
                day: { $dayOfMonth: '$timestamp' },
                hour: { $hour: '$timestamp' }
              },
              count: { $sum: 1 }
            }
          },
          { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } }
        ],

        // Total count
        total: [
          { $count: 'count' }
        ]
      }
    }
  ]);

  return {
    byAction: results[0].byAction,
    byUser: results[0].byUser,
    timeline: results[0].timeline,
    total: results[0].total[0]?.count || 0
  };
};

// Virtual: Human-readable action description
workspaceAuditLogSchema.virtual('description').get(function() {
  const actionMap = {
    'member.added': `added a member`,
    'member.removed': `removed a member`,
    'member.role_changed': `changed member role`,
    'member.invited': `sent an invitation`,
    'invitation.revoked': `revoked an invitation`,
    'invitation.accepted': `accepted an invitation`,
    'settings.changed': `updated workspace settings`,
    'settings.feature_toggled': `toggled a feature`,
    'settings.model_restrictions_updated': `updated model restrictions`,
    'ownership.transferred': `transferred ownership`,
    'model.registered': `registered a custom model`,
    'model.deployed': `deployed a custom model`,
    'model.undeployed': `undeployed a custom model`,
    'model.deleted': `deleted a custom model`,
    'prompt.created': `created a prompt`,
    'prompt.activated': `activated a prompt`,
    'prompt.deactivated': `deactivated a prompt`,
    'prompt.deleted': `deleted a prompt`,
    'workspace.created': `created the workspace`,
    'workspace.deleted': `deleted the workspace`,
    'workspace.suspended': `suspended the workspace`,
    'workspace.reactivated': `reactivated the workspace`,
    'api_key.created': `created an API key`,
    'api_key.revoked': `revoked an API key`
  };

  return actionMap[this.action] || this.action;
});

// Ensure virtuals are included in JSON
workspaceAuditLogSchema.set('toJSON', { virtuals: true });
workspaceAuditLogSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('WorkspaceAuditLog', workspaceAuditLogSchema);
