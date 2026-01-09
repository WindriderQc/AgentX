/**
 * Public Invitation Routes
 *
 * Handles invitation acceptance flow (no workspace auth required)
 */

const express = require('express');
const router = express.Router();
const WorkspaceInvitation = require('../models/WorkspaceInvitation');
const WorkspaceMember = require('../models/WorkspaceMember');
const UserProfile = require('../models/UserProfile');
const { getEmailService } = require('../src/services/emailService');
const { logInvitationAction } = require('../src/middleware/workspaceAudit');
const logger = require('../config/logger');
const { requireAuth } = require('../src/middleware/auth');

/**
 * GET /api/invitations/validate/:token
 * Validate invitation token (public - no auth required)
 */
router.get('/validate/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const invitation = await WorkspaceInvitation.findByToken(token);

    if (!invitation) {
      return res.status(404).json({
        status: 'error',
        message: 'Invalid or expired invitation'
      });
    }

    // Don't expose sensitive data
    res.json({
      status: 'success',
      data: {
        valid: invitation.isValid,
        workspace: {
          name: invitation.workspaceId.name,
          description: invitation.workspaceId.description
        },
        role: invitation.role,
        invitedBy: {
          name: invitation.invitedBy.name || 'A team member'
        },
        expiresAt: invitation.expiresAt,
        invitationStatus: invitation.status
      }
    });
  } catch (error) {
    logger.error('Failed to validate invitation', {
      error: error.message,
      token: req.params.token
    });

    res.status(500).json({
      status: 'error',
      message: 'Failed to validate invitation'
    });
  }
});

/**
 * POST /api/invitations/accept
 * Accept invitation (requires auth - user must be logged in)
 */
router.post('/accept', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        status: 'error',
        message: 'Invitation token is required'
      });
    }

    // Find and validate invitation
    const invitation = await WorkspaceInvitation.findByToken(token);

    if (!invitation) {
      return res.status(404).json({
        status: 'error',
        message: 'Invalid or expired invitation'
      });
    }

    if (!invitation.isValid) {
      return res.status(400).json({
        status: 'error',
        message: `Cannot accept invitation: ${invitation.status}`
      });
    }

    // Get user profile
    const userProfile = await UserProfile.findOne({ userId: req.user.userId });

    if (!userProfile) {
      return res.status(404).json({
        status: 'error',
        message: 'User profile not found'
      });
    }

    // Check if email matches (optional enforcement)
    if (userProfile.email && userProfile.email.toLowerCase() !== invitation.email.toLowerCase()) {
      logger.warn('Invitation email mismatch', {
        invitationEmail: invitation.email,
        userEmail: userProfile.email
      });
      // Allow it but log warning - user might have multiple emails
    }

    // Check if already a member
    const existingMember = await WorkspaceMember.findOne({
      workspaceId: invitation.workspaceId,
      userId: userProfile._id
    });

    if (existingMember) {
      return res.status(400).json({
        status: 'error',
        message: 'You are already a member of this workspace'
      });
    }

    // Accept invitation (updates status)
    await invitation.accept(userProfile._id);

    // Create workspace membership
    const member = await WorkspaceMember.create({
      workspaceId: invitation.workspaceId,
      userId: userProfile._id,
      role: invitation.role,
      joinedAt: new Date()
    });

    // Audit log
    req.workspace = invitation.workspaceId; // Set workspace for audit logging
    await logInvitationAction(req, 'invitation.accepted', invitation, {
      before: { status: 'pending' },
      after: { status: 'accepted', acceptedBy: userProfile._id }
    });

    logger.info('Invitation accepted', {
      invitationId: invitation._id,
      workspaceId: invitation.workspaceId._id,
      userId: userProfile._id
    });

    // Send notification to inviter (non-blocking - don't fail request if email fails)
    try {
      const emailService = getEmailService();
      await emailService.sendAcceptedNotification(invitation, userProfile);
    } catch (emailError) {
      logger.warn('Failed to send invitation acceptance notification', {
        error: emailError.message,
        invitationId: invitation._id
      });
      // Continue - don't fail the request for email issues
    }

    res.json({
      status: 'success',
      message: 'Invitation accepted successfully',
      data: {
        workspace: {
          _id: invitation.workspaceId._id,
          name: invitation.workspaceId.name,
          slug: invitation.workspaceId.slug
        },
        member: {
          role: member.role,
          joinedAt: member.joinedAt
        }
      }
    });
  } catch (error) {
    logger.error('Failed to accept invitation', {
      error: error.message
    });

    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to accept invitation'
    });
  }
});

/**
 * GET /api/invitations/my-invitations
 * List pending invitations for current user's email
 */
router.get('/my-invitations', requireAuth, async (req, res) => {
  try {
    const userProfile = await UserProfile.findOne({ userId: req.user.userId });

    if (!userProfile || !userProfile.email) {
      return res.json({
        status: 'success',
        data: { invitations: [] }
      });
    }

    const invitations = await WorkspaceInvitation.find({
      email: userProfile.email.toLowerCase(),
      status: 'pending',
      expiresAt: { $gt: new Date() }
    })
      .populate('workspaceId', 'name description slug')
      .populate('invitedBy', 'username email')
      .sort({ createdAt: -1 });

    res.json({
      status: 'success',
      data: {
        invitations: invitations.map(inv => ({
          _id: inv._id,
          token: inv.token,
          workspace: {
            _id: inv.workspaceId._id,
            name: inv.workspaceId.name,
            description: inv.workspaceId.description,
            slug: inv.workspaceId.slug
          },
          role: inv.role,
          invitedBy: {
            username: inv.invitedBy.username || inv.invitedBy.email
          },
          createdAt: inv.createdAt,
          expiresAt: inv.expiresAt
        }))
      }
    });
  } catch (error) {
    logger.error('Failed to list user invitations', {
      error: error.message,
      userId: req.user.userId
    });

    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve invitations'
    });
  }
});

module.exports = router;
