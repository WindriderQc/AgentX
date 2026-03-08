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
