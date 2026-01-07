/**
 * Audit Log Model
 *
 * Tracks sensitive operations for security and compliance
 */

const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema({
  // Week 4: Multi-tenancy support
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false, // Optional for backward compatibility
    index: true
  },

  // When
  timestamp: {
    type: Date,
    default: Date.now,
    required: true,
    index: true
  },

  // Who
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile',
    index: true,
    required: false // Can be null for anonymous/system actions
  },

  username: {
    type: String,
    required: false // Snapshot of username at time of action
  },

  authSource: {
    type: String,
    enum: ['session', 'api-key', 'api-key-v2', 'system'],
    default: 'session'
  },

  // What
  action: {
    type: String,
    required: true,
    index: true,
    enum: [
      // API Key Actions
      'api_key_created',
      'api_key_revoked',
      'api_key_rotated',

      // Prompt Actions
      'prompt_created',
      'prompt_activated',
      'prompt_deactivated',
      'prompt_deleted',

      // Model Actions
      'model_deployed',
      'model_deleted',
      'model_updated',

      // RAG Actions
      'rag_document_ingested',
      'rag_document_deleted',
      'rag_collection_cleared',

      // User Actions
      'user_created',
      'user_updated',
      'user_deleted',
      'user_login',
      'user_logout',

      // Self-Healing Actions
      'self_healing_triggered',
      'failover_executed',
      'service_restarted',

      // Admin Actions
      'settings_updated',
      'system_backup_created',
      'system_backup_restored',

      // Security Actions
      'unauthorized_access_attempt',
      'rate_limit_exceeded',
      'suspicious_activity_detected'
    ]
  },

  // Where (resource being acted upon)
  resource: {
    type: String,
    required: false,
    enum: ['api_key', 'prompt', 'model', 'rag_document', 'user', 'system', 'settings']
  },

  resourceId: {
    type: String, // Can be ObjectId, string ID, or identifier
    required: false,
    index: true
  },

  resourceName: {
    type: String, // Human-readable name (e.g., "Production API Key", "default_chat v2")
    required: false
  },

  // Context
  ipAddress: {
    type: String,
    required: false
  },

  userAgent: {
    type: String,
    required: false
  },

  // Additional details (flexible JSON)
  details: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  },

  // Severity classification
  severity: {
    type: String,
    required: true,
    default: 'info',
    enum: ['info', 'warning', 'critical'],
    index: true
  },

  // Status (success/failure)
  status: {
    type: String,
    required: true,
    default: 'success',
    enum: ['success', 'failure', 'partial']
  },

  // Error message if failed
  errorMessage: {
    type: String,
    required: false
  }
});

// Compound indexes for common queries
AuditLogSchema.index({ timestamp: -1, severity: 1 }); // Recent critical events
AuditLogSchema.index({ userId: 1, timestamp: -1 }); // User activity timeline
AuditLogSchema.index({ action: 1, timestamp: -1 }); // Action-specific queries
AuditLogSchema.index({ resourceId: 1, timestamp: -1 }); // Resource history

/**
 * Static method: Log an action
 * @param {Object} data - Log data
 * @returns {Promise<AuditLog>}
 */
AuditLogSchema.statics.log = async function(data) {
  try {
    return await this.create({
      timestamp: new Date(),
      userId: data.userId || null,
      username: data.username || 'Unknown',
      authSource: data.authSource || 'session',
      action: data.action,
      resource: data.resource || null,
      resourceId: data.resourceId || null,
      resourceName: data.resourceName || null,
      ipAddress: data.ipAddress || null,
      userAgent: data.userAgent || null,
      details: data.details || {},
      severity: data.severity || 'info',
      status: data.status || 'success',
      errorMessage: data.errorMessage || null
    });
  } catch (error) {
    // Don't fail requests if audit logging fails
    console.error('Failed to create audit log:', error.message);
    return null;
  }
};

/**
 * Static method: Query logs with filters
 * @param {Object} filters - Query filters
 * @param {Object} options - Pagination options
 * @returns {Promise<Array>}
 */
AuditLogSchema.statics.queryLogs = async function(filters = {}, options = {}) {
  const {
    userId,
    action,
    resource,
    severity,
    status,
    startDate,
    endDate,
    limit = 100,
    offset = 0,
    sort = '-timestamp'
  } = { ...filters, ...options };

  const query = {};

  if (userId) query.userId = userId;
  if (action) query.action = action;
  if (resource) query.resource = resource;
  if (severity) query.severity = severity;
  if (status) query.status = status;

  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);
  }

  return await this.find(query)
    .sort(sort)
    .limit(limit)
    .skip(offset)
    .lean();
};

/**
 * Static method: Get audit stats
 * @param {Object} filters - Query filters
 * @returns {Promise<Object>}
 */
AuditLogSchema.statics.getStats = async function(filters = {}) {
  const { startDate, endDate } = filters;

  const matchStage = {};
  if (startDate || endDate) {
    matchStage.timestamp = {};
    if (startDate) matchStage.timestamp.$gte = new Date(startDate);
    if (endDate) matchStage.timestamp.$lte = new Date(endDate);
  }

  const stats = await this.aggregate([
    ...(Object.keys(matchStage).length > 0 ? [{ $match: matchStage }] : []),
    {
      $facet: {
        totalCount: [{ $count: 'count' }],
        bySeverity: [
          { $group: { _id: '$severity', count: { $sum: 1 } } }
        ],
        byAction: [
          { $group: { _id: '$action', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 }
        ],
        byStatus: [
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ],
        recentCritical: [
          { $match: { severity: 'critical' } },
          { $sort: { timestamp: -1 } },
          { $limit: 5 }
        ]
      }
    }
  ]);

  return {
    totalCount: stats[0].totalCount[0]?.count || 0,
    bySeverity: stats[0].bySeverity.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {}),
    byAction: stats[0].byAction,
    byStatus: stats[0].byStatus.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {}),
    recentCritical: stats[0].recentCritical
  };
};

/**
 * Instance method: Format for display
 * @returns {Object}
 */
AuditLogSchema.methods.toDisplay = function() {
  return {
    id: this._id,
    timestamp: this.timestamp,
    username: this.username || 'System',
    authSource: this.authSource,
    action: this.action,
    resource: this.resource,
    resourceName: this.resourceName,
    severity: this.severity,
    status: this.status,
    ipAddress: this.ipAddress,
    details: this.details
  };
};

const AuditLog = mongoose.model('AuditLog', AuditLogSchema);

module.exports = AuditLog;
