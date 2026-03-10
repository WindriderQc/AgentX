/**
 * Audit Logging Middleware
 *
 * Captures sensitive operations for security and compliance
 */

const AuditLog = require('../../models/AuditLog');
const logger = require('../../config/logger');

/**
 * Create audit log middleware for specific action
 * @param {string} action - Action type (e.g., 'api_key_created')
 * @param {string} severity - Severity level ('info', 'warning', 'critical')
 * @param {Object} options - Additional options
 * @returns {Function} Express middleware
 */
const auditLog = (action, severity = 'info', options = {}) => {
  return async (req, res, next) => {
    // Store original res.json to intercept response
    const originalJson = res.json.bind(res);

    res.json = function(data) {
      // Log after response is prepared (but before sending)
      setImmediate(async () => {
        try {
          // Determine status based on HTTP status code
          let status = 'success';
          if (res.statusCode >= 400 && res.statusCode < 500) {
            status = 'failure';
          } else if (res.statusCode >= 500) {
            status = 'failure';
          }

          // Extract user info
          const user = res.locals.user;
          const userId = user?._id || user?.userId || null;
          const username = user?.name || user?.email || 'Anonymous';
          const authSource = req.authSource || 'session';

          // Extract resource info from options or response
          const resource = options.resource || data?.data?.resource;
          const resourceId = options.resourceId
            || data?.data?.id
            || req.params?.id
            || null;
          const resourceName = options.resourceName
            || data?.data?.name
            || req.body?.name
            || null;

          // Collect details
          const details = {
            method: req.method,
            path: req.originalUrl || req.url,
            statusCode: res.statusCode,
            ...(options.includeBody ? { requestBody: sanitizeBody(req.body) } : {}),
            ...(options.includeQuery ? { queryParams: req.query } : {}),
            ...(options.customDetails ? options.customDetails(req, res, data) : {})
          };

          // Create audit log entry
          await AuditLog.log({
            userId,
            username,
            authSource,
            action,
            resource,
            resourceId,
            resourceName,
            ipAddress: req.ip || req.connection.remoteAddress,
            userAgent: req.get('user-agent'),
            details,
            severity,
            status,
            errorMessage: status === 'failure' ? data?.message : null
          });

          logger.debug('Audit log created', { action, userId, status, severity });
        } catch (error) {
          // Never fail request if audit logging fails
          logger.error('Failed to create audit log', {
            error: error.message,
            action
          });
        }
      });

      // Send original response
      return originalJson(data);
    };

    next();
  };
};

/**
 * Sanitize request body for logging (remove sensitive fields)
 * @param {Object} body - Request body
 * @returns {Object} Sanitized body
 */
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;

  const sensitiveFields = ['password', 'token', 'apiKey', 'secret', 'key'];
  const sanitized = { ...body };

  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  }

  return sanitized;
}

/**
 * Audit middleware for API key operations
 */
const auditApiKeyOps = {
  created: auditLog('api_key_created', 'warning', {
    resource: 'api_key',
    includeBody: true,
    customDetails: (req, res, data) => ({
      scopes: data?.data?.scopes || [],
      expiresAt: data?.data?.expiresAt
    })
  }),

  revoked: auditLog('api_key_revoked', 'warning', {
    resource: 'api_key',
    customDetails: (req, _res, _data) => ({
      reason: req.body?.reason || 'Manual revocation'
    })
  }),

  rotated: auditLog('api_key_rotated', 'warning', {
    resource: 'api_key',
    customDetails: (req, res, data) => ({
      oldKeyId: req.params?.id,
      newKeyId: data?.data?.id
    })
  })
};

/**
 * Audit middleware for prompt operations
 */
const auditPromptOps = {
  created: auditLog('prompt_created', 'info', {
    resource: 'prompt',
    includeBody: true
  }),

  activated: auditLog('prompt_activated', 'info', {
    resource: 'prompt',
    customDetails: (req, res, data) => ({
      version: data?.data?.version,
      trafficWeight: data?.data?.trafficWeight
    })
  }),

  deactivated: auditLog('prompt_deactivated', 'info', {
    resource: 'prompt'
  }),

  deleted: auditLog('prompt_deleted', 'warning', {
    resource: 'prompt'
  })
};

/**
 * Audit middleware for model operations
 */
const auditModelOps = {
  deployed: auditLog('model_deployed', 'critical', {
    resource: 'model',
    includeBody: true,
    customDetails: (req, res, data) => ({
      modelName: req.body?.modelName || data?.data?.modelName,
      host: req.body?.host
    })
  }),

  deleted: auditLog('model_deleted', 'warning', {
    resource: 'model'
  }),

  updated: auditLog('model_updated', 'info', {
    resource: 'model',
    includeBody: true
  })
};

/**
 * Audit middleware for RAG operations
 */
const auditRagOps = {
  ingested: auditLog('rag_document_ingested', 'info', {
    resource: 'rag_document',
    customDetails: (req, _res, _data) => ({
      title: req.body?.title,
      tags: req.body?.tags,
      source: req.body?.path || req.body?.url || 'text'
    })
  }),

  deleted: auditLog('rag_document_deleted', 'warning', {
    resource: 'rag_document'
  }),

  cleared: auditLog('rag_collection_cleared', 'critical', {
    resource: 'rag_document',
    customDetails: (req, res, data) => ({
      documentsDeleted: data?.data?.deletedCount || 0
    })
  })
};

/**
 * Audit middleware for user operations
 */
const auditUserOps = {
  login: auditLog('user_login', 'info', {
    resource: 'user',
    customDetails: (req, _res, _data) => ({
      loginMethod: req.body?.provider || 'password'
    })
  }),

  logout: auditLog('user_logout', 'info', {
    resource: 'user'
  }),

  created: auditLog('user_created', 'warning', {
    resource: 'user',
    includeBody: true
  }),

  updated: auditLog('user_updated', 'info', {
    resource: 'user',
    includeBody: true
  }),

  deleted: auditLog('user_deleted', 'critical', {
    resource: 'user'
  })
};

/**
 * Audit middleware for self-healing operations
 */
const auditSelfHealingOps = {
  triggered: auditLog('self_healing_triggered', 'critical', {
    resource: 'system',
    customDetails: (req, _res, _data) => ({
      alertId: req.body?.alertId,
      strategy: req.body?.strategy,
      rule: req.body?.rule
    })
  }),

  failover: auditLog('failover_executed', 'critical', {
    resource: 'system',
    customDetails: (req, _res, _data) => ({
      fromHost: req.body?.fromHost,
      toHost: req.body?.toHost,
      reason: req.body?.reason
    })
  }),

  restart: auditLog('service_restarted', 'warning', {
    resource: 'system',
    customDetails: (req, _res, _data) => ({
      service: req.body?.service,
      reason: req.body?.reason
    })
  })
};

/**
 * Audit middleware for admin operations
 */
const auditAdminOps = {
  settingsUpdated: auditLog('settings_updated', 'warning', {
    resource: 'settings',
    includeBody: true
  }),

  backupCreated: auditLog('system_backup_created', 'info', {
    resource: 'system',
    customDetails: (req, _res, data) => ({
      backupType: req.body?.type || 'full',
      backupSize: data?.data?.size
    })
  }),

  backupRestored: auditLog('system_backup_restored', 'critical', {
    resource: 'system',
    customDetails: (req, _res, _data) => ({
      backupId: req.body?.backupId,
      backupDate: req.body?.backupDate
    })
  })
};

/**
 * Audit middleware for security events
 */
const auditSecurityOps = {
  unauthorized: auditLog('unauthorized_access_attempt', 'warning', {
    resource: 'system',
    customDetails: (req, _res, _data) => ({
      attemptedPath: req.originalUrl,
      method: req.method
    })
  }),

  rateLimitExceeded: auditLog('rate_limit_exceeded', 'warning', {
    resource: 'system',
    customDetails: (req, _res, data) => ({
      endpoint: req.originalUrl,
      limit: data?.limit
    })
  }),

  suspicious: auditLog('suspicious_activity_detected', 'critical', {
    resource: 'system',
    customDetails: (_req, _res, data) => ({
      pattern: data?.pattern,
      confidence: data?.confidence
    })
  })
};

module.exports = {
  auditLog,
  auditApiKeyOps,
  auditPromptOps,
  auditModelOps,
  auditRagOps,
  auditUserOps,
  auditSelfHealingOps,
  auditAdminOps,
  auditSecurityOps
};
