'use strict';
/**
 * Workspace Admin Routes (transfer, stats, invitations)
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


/**
 * POST /api/workspaces/:slug/transfer
 * Transfer ownership to another member (owner only)
 */
router.post('/:slug/transfer', requireAuth, async (req, res) => {
  try {
    const { slug } = req.params;
    const { newOwnerId } = req.body;
    const userProfileId = await getUserProfileId(req.user.userId);

    if (!newOwnerId) {
      return res.status(400).json({
        status: 'error',
        message: 'New owner ID is required'
      });
    }

    // Get workspace
    const workspace = await Workspace.getBySlug(slug);

    // Check if requester is owner
    const requester = await WorkspaceMember.getMember(workspace._id, userProfileId);
    if (!requester || !requester.isOwner()) {
      return res.status(403).json({
        status: 'error',
        message: 'Only the workspace owner can transfer ownership'
      });
    }

    // Get old and new owner profiles for audit log
    const oldOwnerProfile = await UserProfile.findOne({ userId: req.user.userId });
    const newOwnerProfile = await UserProfile.findOne({ userId: newOwnerId });

    // Validate new owner exists
    if (!newOwnerProfile) {
      return res.status(404).json({
        status: 'error',
        message: 'New owner user not found'
      });
    }

    // Transfer ownership (use profile _id, not the raw userId string)
    await WorkspaceMember.transferOwnership(
      workspace._id,
      userProfileId,
      newOwnerProfile._id
    );

    // Audit log
    req.workspace = workspace;
    await logWorkspaceAction(req, 'ownership.transferred', 'workspace', workspace._id, {
      before: { ownerId: oldOwnerProfile?._id, ownerEmail: oldOwnerProfile?.email },
      after: { ownerId: newOwnerProfile?._id, ownerEmail: newOwnerProfile?.email }
    }, {
      fromUserId: userProfileId,
      toUserId: newOwnerId
    });

    logger.warn('Workspace ownership transferred', {
      workspaceId: workspace._id,
      fromUserId: userProfileId,
      toUserId: newOwnerId
    });

    res.json({
      status: 'success',
      message: 'Ownership transferred successfully'
    });
  } catch (error) {
    logger.error('Failed to transfer ownership', {
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
      message: error.message || 'Failed to transfer ownership'
    });
  }
});

// ============================================
// WORKSPACE STATISTICS
// ============================================

/**
 * GET /api/workspaces/:slug/stats
 * Get workspace statistics (admin only)
 */
router.get('/:slug/stats', requireAuth, async (req, res) => {
  try {
    const { slug } = req.params;
    const userProfileId = await getUserProfileId(req.user.userId);

    // Get workspace
    const workspace = await Workspace.getBySlug(slug);

    // Check if user is admin
    const member = await WorkspaceMember.getMember(workspace._id, userProfileId);
    if (!member || !member.isAdmin()) {
      return res.status(403).json({
        status: 'error',
        message: 'Admin access required'
      });
    }

    // Gather statistics
    const Conversation = require('../models/Conversation');
    const APIKey = require('../models/APIKey');
    const CustomModel = require('../models/CustomModel');
    const [
      memberCount,
      conversationCount,
      apiKeyCount,
      customModelCount,
      activeAlertCount
    ] = await Promise.all([
      WorkspaceMember.countDocuments({ workspaceId: workspace._id, status: 'active' }),
      Conversation.countDocuments({ workspaceId: workspace._id }),
      APIKey.countDocuments({ workspaceId: workspace._id, status: 'active' }),
      CustomModel.countDocuments({ workspaceId: workspace._id }),
      require('../models/Alert').countDocuments({ workspaceId: workspace._id, status: 'active' })
    ]);

    const stats = {
      members: memberCount,
      conversations: conversationCount,
      apiKeys: apiKeyCount,
      customModels: customModelCount,
      activeAlerts: activeAlertCount
    };

    res.json({
      status: 'success',
      data: stats
    });
  } catch (error) {
    logger.error('Failed to get workspace stats', {
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
      message: 'Failed to retrieve workspace statistics'
    });
  }
});

// ============================================
// WORKSPACE INVITATIONS
// ============================================

/**
 * POST /api/workspaces/:slug/invitations
 * Send email invitation to join workspace
 */
router.post('/:slug/invitations', requireAuth, attachWorkspace, requireAdmin, async (req, res) => {
  try {
    const { email, role, personalMessage } = req.body;
    const workspace = req.workspace;
    const inviter = req.user;

    // Validate inputs
    if (!email || !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      return res.status(400).json({
        status: 'error',
        message: 'Valid email address is required'
      });
    }

    if (role && !['admin', 'member', 'viewer'].includes(role)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid role. Must be: admin, member, or viewer'
      });
    }

    // Check if user already a member
    // Fix: WorkspaceMember doesn't have email field - need to find user by email first
    const existingUser = await UserProfile.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      const existingMember = await WorkspaceMember.findOne({
        workspaceId: workspace._id,
        userId: existingUser._id
      });

      if (existingMember) {
        return res.status(400).json({
          status: 'error',
          message: 'User is already a member of this workspace'
        });
      }
    }

    // Check for existing pending invitation
    const existingInvitation = await WorkspaceInvitation.findOne({
      workspaceId: workspace._id,
      email: email.toLowerCase(),
      status: 'pending',
      expiresAt: { $gt: new Date() }
    });

    if (existingInvitation) {
      return res.status(400).json({
        status: 'error',
        message: 'An active invitation already exists for this email'
      });
    }

    // Get inviter details
    const inviterProfile = await UserProfile.findOne({ userId: inviter.userId });

    // Create invitation
    const invitation = await WorkspaceInvitation.createInvitation({
      workspaceId: workspace._id,
      email: email.toLowerCase(),
      role: role || 'member',
      invitedBy: inviterProfile._id,
      metadata: {
        inviterName: inviterProfile.username || inviterProfile.email,
        workspaceName: workspace.name,
        personalMessage
      }
    });

    // Populate references for email
    await invitation.populate(['workspaceId', 'invitedBy']);

    // Send email
    const emailService = getEmailService();
    const emailResult = await emailService.sendInvitation(invitation);

    // Audit log
    await logInvitationAction(req, 'member.invited', invitation, {
      before: null,
      after: { email: invitation.email, role: invitation.role, status: 'pending' }
    });

    logger.info('Workspace invitation created', {
      invitationId: invitation._id,
      workspaceId: workspace._id,
      email: invitation.email,
      emailSent: emailResult.sent
    });

    res.status(201).json({
      status: 'success',
      message: 'Invitation sent successfully',
      data: {
        invitation: {
          _id: invitation._id,
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          emailSent: emailResult.sent
        }
      }
    });
  } catch (error) {
    logger.error('Failed to create invitation', {
      error: error.message,
      workspace: req.params.slug
    });

    res.status(500).json({
      status: 'error',
      message: 'Failed to create invitation'
    });
  }
});

/**
 * GET /api/workspaces/:slug/invitations
 * List invitations for workspace (admin only)
 */
router.get('/:slug/invitations', requireAuth, attachWorkspace, requireAdmin, async (req, res) => {
  try {
    const workspace = req.workspace;
    const { status } = req.query;

    const filter = { workspaceId: workspace._id };
    if (status) {
      filter.status = status;
    }

    const invitations = await WorkspaceInvitation.find(filter)
      .populate('invitedBy', 'username email')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({
      status: 'success',
      data: {
        invitations: invitations.map(inv => ({
          _id: inv._id,
          email: inv.email,
          role: inv.role,
          status: inv.status,
          invitedBy: inv.invitedBy,
          createdAt: inv.createdAt,
          expiresAt: inv.expiresAt,
          acceptedAt: inv.acceptedAt
        }))
      }
    });
  } catch (error) {
    logger.error('Failed to list invitations', {
      error: error.message,
      workspace: req.params.slug
    });

    res.status(500).json({
      status: 'error',
      message: 'Failed to list invitations'
    });
  }
});

/**
 * DELETE /api/workspaces/:slug/invitations/:invitationId
 * Revoke invitation (admin only)
 */
router.delete('/:slug/invitations/:invitationId', requireAuth, attachWorkspace, requireAdmin, async (req, res) => {
  try {
    const workspace = req.workspace;
    const { invitationId } = req.params;

    const invitation = await WorkspaceInvitation.findOne({
      _id: invitationId,
      workspaceId: workspace._id
    });

    if (!invitation) {
      return res.status(404).json({
        status: 'error',
        message: 'Invitation not found'
      });
    }

    // Get user profile for revocation tracking
    const userProfile = await UserProfile.findOne({ userId: req.user.userId });
    await invitation.revoke(userProfile._id);

    logger.info('Invitation revoked', {
      invitationId: invitation._id,
      revokedBy: userProfile._id
    });

    res.json({
      status: 'success',
      message: 'Invitation revoked successfully'
    });
  } catch (error) {
    logger.error('Failed to revoke invitation', {
      error: error.message,
      invitationId: req.params.invitationId
    });

    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to revoke invitation'
    });
  }
});


module.exports = router;
