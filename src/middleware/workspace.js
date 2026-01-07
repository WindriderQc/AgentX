/**
 * Workspace Middleware
 *
 * Attaches workspace context to requests and enforces workspace access control.
 *
 * Week 4 Day 1 - Multi-Tenancy Support
 */

const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
const logger = require('../../config/logger');

/**
 * Extract workspace from request context
 *
 * Workspace can be specified via:
 * 1. URL parameter: /:workspaceSlug/...
 * 2. Query parameter: ?workspace=slug
 * 3. Header: X-Workspace-Slug
 * 4. User's default workspace (if none specified)
 *
 * Sets: req.workspace
 */
async function attachWorkspace(req, res, next) {
  try {
    let workspaceSlug;

    // Priority 1: URL parameter
    if (req.params.workspaceSlug) {
      workspaceSlug = req.params.workspaceSlug;
    }

    // Priority 2: Query parameter
    else if (req.query.workspace) {
      workspaceSlug = req.query.workspace;
    }

    // Priority 3: Header
    else if (req.headers['x-workspace-slug']) {
      workspaceSlug = req.headers['x-workspace-slug'];
    }

    // Priority 4: User's default workspace
    else if (req.user) {
      // Get user's first workspace (most recently joined)
      const membership = await WorkspaceMember.findOne({
        userId: req.user.userId,
        status: 'active'
      })
        .sort({ joinedAt: -1 })
        .populate('workspaceId');

      if (membership && membership.workspaceId) {
        req.workspace = membership.workspaceId;
        req.workspaceSlug = membership.workspaceId.slug;
        return next();
      }

      // No workspace found - create default
      const User = require('../../models/User');
      const user = await User.findById(req.user.userId);

      if (user) {
        const defaultWorkspace = await Workspace.createDefault(
          user._id,
          user.username || user.email.split('@')[0]
        );

        req.workspace = defaultWorkspace;
        req.workspaceSlug = defaultWorkspace.slug;

        logger.info('Created default workspace for user', {
          userId: user._id,
          workspaceSlug: defaultWorkspace.slug
        });

        return next();
      }
    }

    // No workspace context available
    if (!workspaceSlug) {
      return res.status(400).json({
        status: 'error',
        message: 'Workspace context required. Specify via URL, query param, or header.'
      });
    }

    // Load workspace
    const workspace = await Workspace.getBySlug(workspaceSlug);

    req.workspace = workspace;
    req.workspaceSlug = workspace.slug;

    next();
  } catch (error) {
    logger.error('Workspace attachment failed', {
      error: error.message,
      path: req.path
    });

    if (error.statusCode === 404) {
      return res.status(404).json({
        status: 'error',
        message: 'Workspace not found'
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to load workspace context'
    });
  }
}

/**
 * Ensure user has access to the workspace
 *
 * Requires: req.user, req.workspace
 * Sets: req.workspaceMember
 */
async function requireWorkspaceAccess(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({
        status: 'error',
        message: 'Authentication required'
      });
    }

    if (!req.workspace) {
      return res.status(400).json({
        status: 'error',
        message: 'Workspace context required'
      });
    }

    // Check if user is a member of this workspace
    const member = await WorkspaceMember.getMember(
      req.workspace._id,
      req.user.userId
    );

    if (!member) {
      logger.warn('Workspace access denied', {
        userId: req.user.userId,
        workspaceId: req.workspace._id,
        workspaceSlug: req.workspace.slug
      });

      return res.status(403).json({
        status: 'error',
        message: 'You do not have access to this workspace',
        code: 'WORKSPACE_ACCESS_DENIED'
      });
    }

    // Attach member to request
    req.workspaceMember = member;

    next();
  } catch (error) {
    logger.error('Workspace access check failed', {
      error: error.message,
      userId: req.user?.userId,
      workspaceId: req.workspace?._id
    });

    res.status(500).json({
      status: 'error',
      message: 'Failed to verify workspace access'
    });
  }
}

/**
 * Require specific permission within workspace
 *
 * Requires: req.workspaceMember
 *
 * @param {string} permission - Permission name (chat, rag, models, benchmark, alerts, settings)
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.workspaceMember) {
      return res.status(403).json({
        status: 'error',
        message: 'Workspace membership required'
      });
    }

    if (!req.workspaceMember.hasPermission(permission)) {
      logger.warn('Permission denied', {
        userId: req.user?.userId,
        workspaceId: req.workspace?._id,
        permission,
        role: req.workspaceMember.role
      });

      return res.status(403).json({
        status: 'error',
        message: `Permission denied: ${permission}`,
        code: 'PERMISSION_DENIED',
        requiredPermission: permission
      });
    }

    next();
  };
}

/**
 * Require admin role (owner or admin)
 *
 * Requires: req.workspaceMember
 */
function requireAdmin(req, res, next) {
  if (!req.workspaceMember) {
    return res.status(403).json({
      status: 'error',
      message: 'Workspace membership required'
    });
  }

  if (!req.workspaceMember.isAdmin()) {
    logger.warn('Admin access denied', {
      userId: req.user?.userId,
      workspaceId: req.workspace?._id,
      role: req.workspaceMember.role
    });

    return res.status(403).json({
      status: 'error',
      message: 'Administrator access required',
      code: 'ADMIN_REQUIRED'
    });
  }

  next();
}

/**
 * Require owner role
 *
 * Requires: req.workspaceMember
 */
function requireOwner(req, res, next) {
  if (!req.workspaceMember) {
    return res.status(403).json({
      status: 'error',
      message: 'Workspace membership required'
    });
  }

  if (!req.workspaceMember.isOwner()) {
    logger.warn('Owner access denied', {
      userId: req.user?.userId,
      workspaceId: req.workspace?._id,
      role: req.workspaceMember.role
    });

    return res.status(403).json({
      status: 'error',
      message: 'Workspace owner access required',
      code: 'OWNER_REQUIRED'
    });
  }

  next();
}

/**
 * Optional workspace context (doesn't fail if workspace not found)
 *
 * Useful for endpoints that work with or without workspace context
 */
async function optionalWorkspace(req, res, next) {
  try {
    await attachWorkspace(req, res, (err) => {
      // Ignore errors, continue without workspace
      next();
    });
  } catch (error) {
    // Continue without workspace
    next();
  }
}

module.exports = {
  attachWorkspace,
  requireWorkspaceAccess,
  requirePermission,
  requireAdmin,
  requireOwner,
  optionalWorkspace
};
