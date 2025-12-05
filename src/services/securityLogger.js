/**
 * Security Event Logger
 * 
 * Logs security-related events for auditing and monitoring.
 * Integrates with existing Winston logger with security-specific formatting.
 */

const logger = require('../../config/logger');

/**
 * Security event types
 */
const SecurityEventType = {
  // Authentication events
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout',
  REGISTER: 'auth.register',
  PASSWORD_CHANGE: 'auth.password_change',
  
  // Authorization events
  ACCESS_DENIED: 'authz.access_denied',
  ADMIN_ACTION: 'authz.admin_action',
  
  // Rate limiting events
  RATE_LIMIT_EXCEEDED: 'security.rate_limit_exceeded',
  
  // Session events
  SESSION_CREATED: 'session.created',
  SESSION_EXPIRED: 'session.expired',
  SESSION_DESTROYED: 'session.destroyed',
  
  // Suspicious activity
  BRUTE_FORCE_ATTEMPT: 'security.brute_force',
  INVALID_TOKEN: 'security.invalid_token',
  SUSPICIOUS_ACTIVITY: 'security.suspicious'
};

/**
 * Security event severity levels
 */
const SecuritySeverity = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical'
};

/**
 * Log a security event
 * @param {string} eventType - Type of security event (use SecurityEventType constants)
 * @param {Object} details - Event details
 * @param {string} details.userId - User ID involved (if applicable)
 * @param {string} details.email - User email (if applicable)
 * @param {string} details.ip - IP address
 * @param {string} details.userAgent - User agent string
 * @param {string} details.reason - Reason for event (failures, denials)
 * @param {Object} details.metadata - Additional metadata
 * @param {string} severity - Event severity (default: INFO)
 */
function logSecurityEvent(eventType, details = {}, severity = SecuritySeverity.INFO) {
  const event = {
    type: eventType,
    timestamp: new Date().toISOString(),
    severity,
    ...details
  };

  // Remove sensitive data before logging
  if (event.password) delete event.password;
  if (event.token) delete event.token;

  // Log with appropriate level
  switch (severity) {
    case SecuritySeverity.CRITICAL:
      logger.error('SECURITY EVENT', event);
      break;
    case SecuritySeverity.WARNING:
      logger.warn('SECURITY EVENT', event);
      break;
    default:
      logger.info('SECURITY EVENT', event);
  }

  // In production, could also send to external monitoring service
  // e.g., Sentry, Datadog, CloudWatch, etc.
}

/**
 * Express middleware to extract request context for security logging
 * @param {Object} req - Express request object
 * @returns {Object} Context object with IP, user agent, etc.
 */
function getRequestContext(req) {
  return {
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('user-agent'),
    path: req.path,
    method: req.method
  };
}

/**
 * Log successful login
 */
function logLoginSuccess(req, user) {
  logSecurityEvent(SecurityEventType.LOGIN_SUCCESS, {
    userId: user.userId,
    email: user.email,
    ...getRequestContext(req)
  }, SecuritySeverity.INFO);
}

/**
 * Log failed login attempt
 */
function logLoginFailed(req, email, reason = 'Invalid credentials') {
  logSecurityEvent(SecurityEventType.LOGIN_FAILED, {
    email,
    reason,
    ...getRequestContext(req)
  }, SecuritySeverity.WARNING);
}

/**
 * Log user logout
 */
function logLogout(req, user) {
  logSecurityEvent(SecurityEventType.LOGOUT, {
    userId: user.userId,
    email: user.email,
    ...getRequestContext(req)
  }, SecuritySeverity.INFO);
}

/**
 * Log user registration
 */
function logRegistration(req, user) {
  logSecurityEvent(SecurityEventType.REGISTER, {
    userId: user.userId,
    email: user.email,
    ...getRequestContext(req)
  }, SecuritySeverity.INFO);
}

/**
 * Log password change
 */
function logPasswordChange(req, user) {
  logSecurityEvent(SecurityEventType.PASSWORD_CHANGE, {
    userId: user.userId,
    email: user.email,
    ...getRequestContext(req)
  }, SecuritySeverity.INFO);
}

/**
 * Log access denied (authorization failure)
 */
function logAccessDenied(req, user, resource, reason = 'Insufficient permissions') {
  logSecurityEvent(SecurityEventType.ACCESS_DENIED, {
    userId: user?.userId,
    email: user?.email,
    resource,
    reason,
    ...getRequestContext(req)
  }, SecuritySeverity.WARNING);
}

/**
 * Log admin action
 */
function logAdminAction(req, user, action, target) {
  logSecurityEvent(SecurityEventType.ADMIN_ACTION, {
    userId: user.userId,
    email: user.email,
    action,
    target,
    ...getRequestContext(req)
  }, SecuritySeverity.INFO);
}

/**
 * Log rate limit exceeded
 */
function logRateLimitExceeded(req, limit, windowMs) {
  logSecurityEvent(SecurityEventType.RATE_LIMIT_EXCEEDED, {
    limit,
    windowMs,
    ...getRequestContext(req)
  }, SecuritySeverity.WARNING);
}

/**
 * Log suspicious activity
 */
function logSuspiciousActivity(req, description, metadata = {}) {
  logSecurityEvent(SecurityEventType.SUSPICIOUS_ACTIVITY, {
    description,
    metadata,
    ...getRequestContext(req)
  }, SecuritySeverity.CRITICAL);
}

/**
 * Get security event statistics (last N events)
 * @param {number} limit - Number of recent events to retrieve
 * @returns {Array} Recent security events
 */
function getRecentSecurityEvents(limit = 100) {
  // This is a simple in-memory implementation
  // In production, you'd query from a database or log aggregation service
  // For now, return empty array as logs are in Winston transport
  return [];
}

module.exports = {
  SecurityEventType,
  SecuritySeverity,
  logSecurityEvent,
  getRequestContext,
  
  // Convenience functions
  logLoginSuccess,
  logLoginFailed,
  logLogout,
  logRegistration,
  logPasswordChange,
  logAccessDenied,
  logAdminAction,
  logRateLimitExceeded,
  logSuspiciousActivity,
  
  getRecentSecurityEvents
};
