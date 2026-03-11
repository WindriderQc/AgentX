/**
 * Workspace Management API
 *
 * CRUD operations for workspaces and membership management.
 *
 * Week 4 Day 2 - Workspace API
 */

const express = require('express');
const router = express.Router();
const Workspace = require('../models/Workspace');
const WorkspaceMember = require('../models/WorkspaceMember');
const WorkspaceInvitation = require('../models/WorkspaceInvitation');
const UserProfile = require('../models/UserProfile');
const { getEmailService } = require('../src/services/emailService');
const { logMemberAction, logInvitationAction, logSettingsChange, logWorkspaceAction } = require('../src/middleware/workspaceAudit');
const logger = require('../config/logger');
const { requireAuth } = require('../src/middleware/auth');
const {
  attachWorkspace,
  requireAdmin
} = require('../src/middleware/workspace');

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get UserProfile ObjectId from session userId (which might be username string)
 */
async function getUserProfileId(sessionUserId) {
  const userProfile = await UserProfile.findOne({ userId: sessionUserId });
  if (!userProfile) {
    throw new Error('User profile not found');
  }
  return userProfile._id;
}

// ============================================
// WORKSPACE CRUD OPERATIONS
// ============================================

/**
 * GET /api/workspaces
 * List all workspaces user has access to
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const userProfileId = await getUserProfileId(req.user.userId);

    // Get user's workspace memberships
    const memberships = await WorkspaceMember.find({
      userId: userProfileId,
      status: 'active'
    })
      .populate('workspaceId')
      .sort({ joinedAt: -1 });

    // Filter out deleted/invalid workspaces
    const workspaces = memberships
      .filter(m => m.workspaceId && m.workspaceId.status === 'active')
      .map(m => ({
        ...m.workspaceId.toObject(),
        role: m.role,
        permissions: m.permissions,
        joinedAt: m.joinedAt
      }));

    res.json({
      status: 'success',
      data: workspaces
    });
  } catch (error) {
    logger.error('Failed to list workspaces', {
      error: error.message,
      userId: req.user?.userId
    });

    if (error.message === 'User profile not found') {
      return res.status(404).json({
        status: 'error',
        message: 'User profile not found. Please create a profile first.'
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve workspaces'
    });
  }
});

/**
 * POST /api/workspaces
 * Create a new workspace (user becomes owner)
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, slug, description } = req.body;
    const userProfileId = await getUserProfileId(req.user.userId);

    // Validation
    if (!name || !slug) {
      return res.status(400).json({
        status: 'error',
        message: 'Name and slug are required'
      });
    }

    // Validate slug format (lowercase alphanumeric + hyphens)
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({
        status: 'error',
        message: 'Slug must contain only lowercase letters, numbers, and hyphens'
      });
    }

    // Check if slug already exists
    const existing = await Workspace.findOne({ slug });
    if (existing) {
      return res.status(409).json({
        status: 'error',
        message: 'Workspace slug already exists'
      });
    }

    // Create workspace
    const workspace = await Workspace.create({
      name,
      slug,
      description: description || '',
      ownerId: userProfileId
    });

    // Create owner membership
    await WorkspaceMember.create({
      workspaceId: workspace._id,
      userId: userProfileId,
      role: 'owner',
      permissions: {
        chat: true,
        rag: true,
        models: true,
        benchmark: true,
        alerts: true,
        settings: true
      }
    });

    logger.info('Workspace created', {
      workspaceId: workspace._id,
      slug: workspace.slug,
      ownerId: userProfileId
    });

    res.status(201).json({
      status: 'success',
      data: workspace
    });
  } catch (error) {
    logger.error('Failed to create workspace', {
      error: error.message,
      userId: req.user?.userId
    });

    if (error.message === 'User profile not found') {
      return res.status(404).json({
        status: 'error',
        message: 'User profile not found. Please create a profile first.'
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to create workspace'
    });
  }
});

/**
 * GET /api/workspaces/:slug
 * Get workspace details
 */
router.get('/:slug', requireAuth, async (req, res) => {
  try {
    const { slug } = req.params;
    const userProfileId = await getUserProfileId(req.user.userId);

    // Get workspace
    const workspace = await Workspace.getBySlug(slug);

    // Check workspace exists
    if (!workspace) {
      return res.status(404).json({
        status: 'error',
        message: 'Workspace not found'
      });
    }

    // Check if user is a member
    const member = await WorkspaceMember.getMember(workspace._id, userProfileId);

    if (!member) {
      return res.status(403).json({
        status: 'error',
        message: 'You do not have access to this workspace'
      });
    }

    // Add member info to response
    const workspaceData = {
      ...workspace.toObject(),
      role: member.role,
      permissions: member.permissions
    };

    res.json({
      status: 'success',
      data: workspaceData
    });
  } catch (error) {
    logger.error('Failed to get workspace', {
      error: error.message,
      slug: req.params.slug
    });

    if (error.message === 'User profile not found') {
      return res.status(404).json({
        status: 'error',
        message: 'User profile not found. Please create a profile first.'
      });
    }

    if (error.statusCode === 404) {
      return res.status(404).json({
        status: 'error',
        message: 'Workspace not found'
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve workspace'
    });
  }
});

/**
 * PATCH /api/workspaces/:slug
 * Update workspace settings (admin only)
 */
router.patch('/:slug', requireAuth, async (req, res) => {
  try {
    const { slug } = req.params;
    const userProfileId = await getUserProfileId(req.user.userId);

    // Get workspace and member
    const workspace = await Workspace.getBySlug(slug);
    const member = await WorkspaceMember.getMember(workspace._id, userProfileId);

    if (!member || !member.isAdmin()) {
      return res.status(403).json({
        status: 'error',
        message: 'Admin access required'
      });
    }

    // Allowed fields to update
    const allowedFields = ['name', 'description', 'settings'];
    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Prevent slug changes (security)
    if (req.body.slug) {
      return res.status(400).json({
        status: 'error',
        message: 'Workspace slug cannot be changed'
      });
    }

    // Capture before state for audit log
    const beforeState = {};
    for (const field of Object.keys(updates)) {
      beforeState[field] = workspace[field];
    }

    // Apply updates
    Object.assign(workspace, updates);
    await workspace.save();

    // Audit log
    req.workspace = workspace;
    await logSettingsChange(req, workspace, {
      before: beforeState,
      after: updates
    });

    logger.info('Workspace updated', {
      workspaceId: workspace._id,
      slug: workspace.slug,
      updatedBy: userProfileId
    });

    res.json({
      status: 'success',
      data: workspace
    });
  } catch (error) {
    logger.error('Failed to update workspace', {
      error: error.message,
      slug: req.params.slug
    });

    if (error.message === 'User profile not found') {
      return res.status(404).json({
        status: 'error',
        message: 'User profile not found. Please create a profile first.'
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to update workspace'
    });
  }
});

/**
 * DELETE /api/workspaces/:slug
 * Delete workspace (owner only, soft delete)
 */
router.delete('/:slug', requireAuth, async (req, res) => {
  try {
    const { slug } = req.params;
    const userProfileId = await getUserProfileId(req.user.userId);

    // Get workspace and member
    const workspace = await Workspace.getBySlug(slug);
    const member = await WorkspaceMember.getMember(workspace._id, userProfileId);

    if (!member || !member.isOwner()) {
      return res.status(403).json({
        status: 'error',
        message: 'Only the workspace owner can delete the workspace'
      });
    }

    // Soft delete
    await workspace.softDelete();

    logger.warn('Workspace deleted', {
      workspaceId: workspace._id,
      slug: workspace.slug,
      deletedBy: userProfileId
    });

    res.json({
      status: 'success',
      message: 'Workspace deleted successfully'
    });
  } catch (error) {
    logger.error('Failed to delete workspace', {
      error: error.message,
      slug: req.params.slug
    });

    if (error.message === 'User profile not found') {
      return res.status(404).json({
        status: 'error',
        message: 'User profile not found. Please create a profile first.'
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to delete workspace'
    });
  }
});

// ============================================

// Member management and admin routes mounted as sub-routers
router.use('/', require('./workspaces-members'));
router.use('/', require('./workspaces-admin'));

module.exports = router;
