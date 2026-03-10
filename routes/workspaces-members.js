'use strict';
/**
 * Workspace Member Management Routes
 * Extracted from workspaces.js — mounted via router.use() in workspaces.js.
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
const { attachWorkspace, requireAdmin } = require('../src/middleware/workspace');

async function getUserProfileId(sessionUserId) {
  const userProfile = await UserProfile.findOne({ userId: sessionUserId });
  if (!userProfile) throw new Error('User profile not found');
  return userProfile._id;
}

// WORKSPACE MEMBER MANAGEMENT
// ============================================

/**
 * GET /api/workspaces/:slug/members
 * List workspace members
 */
router.get('/:slug/members', requireAuth, async (req, res) => {
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

    // Get all members
    const members = await WorkspaceMember.getWorkspaceMembers(workspace._id);

    res.json({
      status: 'success',
      data: members
    });
  } catch (error) {
    logger.error('Failed to list workspace members', {
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
      message: 'Failed to retrieve members'
    });
  }
});

/**
 * POST /api/workspaces/:slug/members
 * Invite member to workspace (admin only)
 */
router.post('/:slug/members', requireAuth, async (req, res) => {
  try {
    const { slug } = req.params;
    const { email, role } = req.body;
    const userProfileId = await getUserProfileId(req.user.userId);

    // Validation
    if (!email || !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      return res.status(400).json({
        status: 'error',
        message: 'Valid email address is required'
      });
    }

    if (!role) {
      return res.status(400).json({
        status: 'error',
        message: 'Role is required'
      });
    }

    if (!['admin', 'member', 'viewer'].includes(role)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid role. Must be: admin, member, or viewer'
      });
    }

    // Get workspace
    const workspace = await Workspace.getBySlug(slug);

    // Check if requester is admin
    const requester = await WorkspaceMember.getMember(workspace._id, userProfileId);
    if (!requester || !requester.isAdmin()) {
      return res.status(403).json({
        status: 'error',
        message: 'Admin access required to invite members'
      });
    }

    // Find user by email
    const invitedUser = await UserProfile.findOne({ email });
    if (!invitedUser) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found with that email'
      });
    }

    // Check if already a member
    const existing = await WorkspaceMember.findOne({
      workspaceId: workspace._id,
      userId: invitedUser._id
    });

    if (existing && existing.status === 'active') {
      return res.status(409).json({
        status: 'error',
        message: 'User is already a member of this workspace'
      });
    }

    // Invite member
    const member = await WorkspaceMember.inviteMember(
      workspace._id,
      invitedUser._id,
      role,
      userProfileId
    );

    // Activate immediately (future: send email invitation)
    member.status = 'active';
    await member.save();

    // Audit log
    req.workspace = workspace; // Set workspace for audit logging
    await logMemberAction(req, 'member.added', member, {
      before: null,
      after: { role: member.role, email: invitedUser.email, status: 'active' }
    });

    logger.info('Member invited to workspace', {
      workspaceId: workspace._id,
      invitedUserId: invitedUser._id,
      role,
      invitedBy: userProfileId
    });

    res.status(201).json({
      status: 'success',
      data: member,
      message: 'Member invited successfully'
    });
  } catch (error) {
    logger.error('Failed to invite member', {
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
      message: 'Failed to invite member'
    });
  }
});

/**
 * PATCH /api/workspaces/:slug/members/:memberId
 * Update member role or permissions (admin only)
 */
router.patch('/:slug/members/:memberId', requireAuth, async (req, res) => {
  try {
    const { slug, memberId } = req.params;
    const { role, permissions } = req.body;
    const userProfileId = await getUserProfileId(req.user.userId);

    // Get workspace
    const workspace = await Workspace.getBySlug(slug);

    // Check if requester is admin
    const requester = await WorkspaceMember.getMember(workspace._id, userProfileId);
    if (!requester || !requester.isAdmin()) {
      return res.status(403).json({
        status: 'error',
        message: 'Admin access required'
      });
    }

    // Get target member
    const member = await WorkspaceMember.findById(memberId);
    if (!member || member.workspaceId.toString() !== workspace._id.toString()) {
      return res.status(404).json({
        status: 'error',
        message: 'Member not found'
      });
    }

    // Prevent demoting owner (only owner can transfer ownership)
    if (member.role === 'owner') {
      return res.status(403).json({
        status: 'error',
        message: 'Cannot change owner role. Use transfer ownership instead.'
      });
    }

    // Capture before state for audit log
    const beforeState = {
      role: member.role,
      permissions: { ...member.permissions }
    };

    // Update role if provided
    if (role) {
      if (!['admin', 'member', 'viewer'].includes(role)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid role'
        });
      }

      await member.setRole(role);
    }

    // Update permissions if provided
    if (permissions) {
      Object.assign(member.permissions, permissions);
      await member.save();
    }

    // Audit log
    req.workspace = workspace;
    await logMemberAction(req, 'member.role_changed', member, {
      before: beforeState,
      after: { role: member.role, permissions: member.permissions }
    });

    logger.info('Member role/permissions updated', {
      workspaceId: workspace._id,
      memberId: member._id,
      role: member.role,
      updatedBy: userProfileId
    });

    res.json({
      status: 'success',
      data: member
    });
  } catch (error) {
    logger.error('Failed to update member', {
      error: error.message,
      slug: req.params.slug,
      memberId: req.params.memberId
    });

    if (error.message === 'User profile not found') {
      return res.status(404).json({
        status: 'error',
        message: 'User profile not found. Please create a profile first.'
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to update member'
    });
  }
});

/**
 * DELETE /api/workspaces/:slug/members/:memberId
 * Remove member from workspace (admin only)
 */
router.delete('/:slug/members/:memberId', requireAuth, async (req, res) => {
  try {
    const { slug, memberId } = req.params;
    const userProfileId = await getUserProfileId(req.user.userId);

    // Get workspace
    const workspace = await Workspace.getBySlug(slug);

    // Check if requester is admin
    const requester = await WorkspaceMember.getMember(workspace._id, userProfileId);
    if (!requester || !requester.isAdmin()) {
      return res.status(403).json({
        status: 'error',
        message: 'Admin access required'
      });
    }

    // Get target member
    const member = await WorkspaceMember.findById(memberId);
    if (!member || member.workspaceId.toString() !== workspace._id.toString()) {
      return res.status(404).json({
        status: 'error',
        message: 'Member not found'
      });
    }

    // Prevent removing owner
    if (member.role === 'owner') {
      return res.status(403).json({
        status: 'error',
        message: 'Cannot remove workspace owner'
      });
    }

    // Remove member
    await member.deleteOne();

    logger.info('Member removed from workspace', {
      workspaceId: workspace._id,
      removedUserId: member.userId,
      removedBy: userProfileId
    });

    res.json({
      status: 'success',
      message: 'Member removed successfully'
    });
  } catch (error) {
    logger.error('Failed to remove member', {
      error: error.message,
      slug: req.params.slug,
      memberId: req.params.memberId
    });

    if (error.message === 'User profile not found') {
      return res.status(404).json({
        status: 'error',
        message: 'User profile not found. Please create a profile first.'
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to remove member'
    });
  }
});

/**
 * POST /api/workspaces/:slug/leave
 * Leave workspace (self-removal)
 */
router.post('/:slug/leave', requireAuth, async (req, res) => {
  try {
    const { slug } = req.params;
    const userProfileId = await getUserProfileId(req.user.userId);

    // Get workspace
    const workspace = await Workspace.getBySlug(slug);

    // Get member
    const member = await WorkspaceMember.getMember(workspace._id, userProfileId);
    if (!member) {
      return res.status(404).json({
        status: 'error',
        message: 'You are not a member of this workspace'
      });
    }

    // Prevent owner from leaving (must transfer ownership first)
    if (member.role === 'owner') {
      return res.status(403).json({
        status: 'error',
        message: 'Workspace owner cannot leave. Transfer ownership first or delete the workspace.'
      });
    }

    // Remove membership
    await member.deleteOne();

    logger.info('User left workspace', {
      workspaceId: workspace._id,
      userId: userProfileId
    });

    res.json({
      status: 'success',
      message: 'You have left the workspace'
    });
  } catch (error) {
    logger.error('Failed to leave workspace', {
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
      message: 'Failed to leave workspace'
    });
  }
});

module.exports = router;
