/**
 * Workspace Audit Middleware
 *
 * Captures and logs workspace actions for compliance and debugging
 * Post-Week 4: Workspace activity audit logs (A2)
 */

const WorkspaceAuditLog = require('../../models/WorkspaceAuditLog');
const UserProfile = require('../../models/UserProfile');
const logger = require('../../config/logger');

/**
 * Helper: Get UserProfile ObjectId from session userId (which might be username string)
 */
async function getUserProfileId(sessionUserId) {
  const userProfile = await UserProfile.findOne({ userId: sessionUserId });
  if (!userProfile) {
    return null;
  }
  return userProfile._id;
}

/**
 * Log workspace action
 *
 * Usage in routes:
 * await logWorkspaceAction(req, 'member.added', 'member', memberId, {
 *   before: null,
 *   after: { role: 'member', email: 'user@example.com' }
 * });
 */
async function logWorkspaceAction(req, action, targetType, targetId, changes = {}, metadata = {}) {
  try {
    // Extract workspace context
    const workspaceId = req.workspace?._id || req.body.workspaceId || req.params.workspaceId;

    if (!workspaceId) {
      logger.warn('Audit log skipped: no workspaceId', { action });
      return null;
    }

    // Extract user context
    const sessionUserId = req.user?.userId || req.user?._id;

    if (!sessionUserId) {
      logger.warn('Audit log skipped: no userId', { action });
      return null;
    }

    // Convert username string to UserProfile ObjectId
    const userId = await getUserProfileId(sessionUserId);

    if (!userId) {
      logger.warn('Audit log skipped: UserProfile not found', {
        action,
        sessionUserId
      });
      return null;
    }

    // Extract request metadata
    const ipAddress = req.ip || req.connection?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    // Create audit log
    const log = await WorkspaceAuditLog.logAction({
      workspaceId,
      userId,
      action,
      targetType,
      targetId,
      changes,
      metadata,
      ipAddress,
      userAgent
    });

    logger.debug('Workspace action logged', {
      workspaceId,
      action,
      targetType,
      logId: log._id
    });

    return log;

  } catch (error) {
    // Don't fail the request if audit logging fails
    logger.error('Failed to log workspace action', {
      error: error.message,
      action,
      targetType
    });
    return null;
  }
}

/**
 * Express middleware: Auto-log successful route handlers
 *
 * Usage:
 * router.post('/:slug/members', requireAuth, attachWorkspace, requireAdmin,
 *   auditAction('member.added', 'member'),
 *   async (req, res) => { ... }
 * );
 */
function auditAction(action, targetType, options = {}) {
  return async (req, res, next) => {
    // Store original res.json to intercept successful responses
    const originalJson = res.json.bind(res);

    res.json = async function(body) {
      // Only log if response is successful (2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          // Extract targetId from response or request
          const targetId = options.getTargetId
            ? options.getTargetId(req, body)
            : body.data?._id || body.data?.id || req.params.id;

          // Extract changes
          const changes = options.getChanges
            ? options.getChanges(req, body)
            : { before: null, after: body.data };

          // Extract metadata
          const metadata = options.getMetadata
            ? options.getMetadata(req, body)
            : {};

          await logWorkspaceAction(req, action, targetType, targetId, changes, metadata);
        } catch (error) {
          logger.error('Audit middleware error', { error: error.message });
        }
      }

      return originalJson(body);
    };

    next();
  };
}

/**
 * Helper: Create audit log for member actions
 */
async function logMemberAction(req, action, member, changes = {}) {
  return logWorkspaceAction(
    req,
    action,
    'member',
    member._id,
    changes,
    {
      email: member.email || member.userId?.email,
      role: member.role
    }
  );
}

/**
 * Helper: Create audit log for invitation actions
 */
async function logInvitationAction(req, action, invitation, changes = {}) {
  return logWorkspaceAction(
    req,
    action,
    'invitation',
    invitation._id,
    changes,
    {
      email: invitation.email,
      role: invitation.role
    }
  );
}

/**
 * Helper: Create audit log for settings changes
 */
async function logSettingsChange(req, workspace, changes) {
  return logWorkspaceAction(
    req,
    'settings.changed',
    'settings',
    workspace._id,
    changes,
    {
      settingsModified: Object.keys(changes.after || {})
    }
  );
}

/**
 * Helper: Create audit log for model actions
 */
async function logModelAction(req, action, model, changes = {}) {
  return logWorkspaceAction(
    req,
    action,
    'model',
    model._id,
    changes,
    {
      modelId: model.modelId,
      displayName: model.displayName
    }
  );
}

/**
 * Helper: Create audit log for prompt actions
 */
async function logPromptAction(req, action, prompt, changes = {}) {
  return logWorkspaceAction(
    req,
    action,
    'prompt',
    prompt._id,
    changes,
    {
      name: prompt.name,
      version: prompt.version
    }
  );
}

module.exports = {
  logWorkspaceAction,
  auditAction,
  logMemberAction,
  logInvitationAction,
  logSettingsChange,
  logModelAction,
  logPromptAction
};
