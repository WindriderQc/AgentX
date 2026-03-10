/**
 * Workspace Middleware
 *
 * Attaches workspace context to requests and enforces workspace access control.
 *
 * Week 4 Day 1 - Multi-Tenancy Support
 */

const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
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
      // Get UserProfile ObjectId
      const userProfileId = await getUserProfileId(req.user.userId);

      if (userProfileId) {
        // Get user's first workspace (most recently joined)
        const membership = await WorkspaceMember.findOne({
          userId: userProfileId,
          status: 'active'
        })
          .sort({ joinedAt: -1 })
          .populate('workspaceId');

        if (membership && membership.workspaceId) {
          req.workspace = membership.workspaceId;
          req.workspaceSlug = membership.workspaceId.slug;
          return next();
        }
      }

      // No workspace found - create default
      const userProfile = await UserProfile.findOne({ userId: req.user.userId });

      if (userProfile) {
        const defaultWorkspace = await Workspace.createDefault(
          userProfile._id,
          userProfile.username || userProfile.email?.split('@')[0] || req.user.userId
        );

        req.workspace = defaultWorkspace;
        req.workspaceSlug = defaultWorkspace.slug;

        logger.info('Created default workspace for user', {
          userId: userProfile._id,
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
 * optionalWorkspaceContext middleware
 *
 * Loads workspace context if provided but doesn't reject request if workspace is invalid.
 * Use this for read-only routes that should gracefully handle missing workspace context.
 *
 * Behavior:
 * - If workspace slug not provided -> req.workspace = null (continue)
 * - If workspace slug provided and valid -> req.workspace = loaded workspace (continue)
 * - If workspace slug provided but invalid -> req.workspace = null (continue, don't reject)
 *
 * Route handler must handle null workspace appropriately.
 */
async function optionalWorkspaceContext(req, res, next) {
  try {
    // Extract workspace slug from query, header, or default
    // (same logic as attachWorkspace)
    let workspaceSlug = req.query.workspace || req.header('X-Workspace-Slug'); // Matching attachWorkspace which uses X-Workspace-Slug

    // If user exists, check for default workspace
    if (!workspaceSlug && res.locals.user) {
      // Future: Get user's default workspace from UserProfile
      // For now, just continue without workspace
      req.workspace = null;
      return next();
    }

    // If no workspace slug provided, continue without workspace
    if (!workspaceSlug) {
      req.workspace = null;
      return next();
    }

    // Try to load workspace
    try {
      const workspace = await Workspace.getBySlug(workspaceSlug);
      req.workspace = workspace;
    } catch (error) {
      // If workspace not found or any error, set null and continue
      // Route handler will decide if null workspace is acceptable
      req.workspace = null;
      logger.warn('Optional workspace context: workspace not found', {
        slug: workspaceSlug,
        error: error.message
      });
    }

    next();

  } catch (error) {
    // Unexpected error in middleware itself
    logger.error('optionalWorkspaceContext middleware error', {
      error: error.message,
      stack: error.stack
    });

    // Continue with null workspace rather than rejecting
    req.workspace = null;
    next();
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

    // Get UserProfile ObjectId
    const userProfileId = await getUserProfileId(req.user.userId);
    if (!userProfileId) {
      return res.status(404).json({
        status: 'error',
        message: 'User profile not found'
      });
    }

    // Check if user is a member of this workspace
    const member = await WorkspaceMember.getMember(
      req.workspace._id,
      userProfileId
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
    await attachWorkspace(req, res, (_err) => {
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
  optionalWorkspace,
  optionalWorkspaceContext
};
