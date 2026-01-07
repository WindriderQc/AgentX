/**
 * Workspace Invitation Model
 *
 * Tracks email invitations to join workspaces with token-based acceptance
 */

const mongoose = require('mongoose');

const workspaceInvitationSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  },
  role: {
    type: String,
    required: true,
    enum: ['admin', 'member', 'viewer'],
    default: 'member'
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile',
    required: true
  },
  token: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'expired', 'revoked'],
    default: 'pending',
    index: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  acceptedAt: {
    type: Date
  },
  acceptedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile'
  },
  revokedAt: {
    type: Date
  },
  revokedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile'
  },
  metadata: {
    inviterName: String,
    workspaceName: String,
    personalMessage: String
  }
}, {
  timestamps: true
});

// Compound indexes for common queries
workspaceInvitationSchema.index({ workspaceId: 1, email: 1 });
workspaceInvitationSchema.index({ token: 1, status: 1 });
workspaceInvitationSchema.index({ email: 1, status: 1 });

// Virtual for checking if invitation is valid
workspaceInvitationSchema.virtual('isValid').get(function() {
  return this.status === 'pending' && this.expiresAt > new Date();
});

// Static method: Create invitation with auto-generated token
workspaceInvitationSchema.statics.createInvitation = async function(data) {
  const crypto = require('crypto');

  // Generate secure token
  const token = crypto.randomBytes(32).toString('hex');

  // Set expiration (7 days default)
  const expiryDays = data.expiryDays || parseInt(process.env.INVITATION_EXPIRY_DAYS || '7');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiryDays);

  const invitation = new this({
    workspaceId: data.workspaceId,
    email: data.email,
    role: data.role || 'member',
    invitedBy: data.invitedBy,
    token,
    expiresAt,
    metadata: data.metadata || {}
  });

  await invitation.save();
  return invitation;
};

// Static method: Find and validate invitation by token
workspaceInvitationSchema.statics.findByToken = async function(token) {
  const invitation = await this.findOne({ token }).populate('workspaceId invitedBy');

  if (!invitation) {
    return null;
  }

  // Auto-expire if past expiration date
  if (invitation.status === 'pending' && invitation.expiresAt < new Date()) {
    invitation.status = 'expired';
    await invitation.save();
  }

  return invitation;
};

// Instance method: Accept invitation
workspaceInvitationSchema.methods.accept = async function(userId) {
  if (this.status !== 'pending') {
    throw new Error(`Cannot accept invitation with status: ${this.status}`);
  }

  if (this.expiresAt < new Date()) {
    this.status = 'expired';
    await this.save();
    throw new Error('Invitation has expired');
  }

  this.status = 'accepted';
  this.acceptedAt = new Date();
  this.acceptedBy = userId;

  await this.save();
  return this;
};

// Instance method: Revoke invitation
workspaceInvitationSchema.methods.revoke = async function(userId) {
  if (this.status === 'accepted') {
    throw new Error('Cannot revoke an already accepted invitation');
  }

  this.status = 'revoked';
  this.revokedAt = new Date();
  this.revokedBy = userId;

  await this.save();
  return this;
};

// Instance method: Check if invitation can be resent
workspaceInvitationSchema.methods.canResend = function() {
  return this.status === 'pending' && this.expiresAt < new Date();
};

module.exports = mongoose.model('WorkspaceInvitation', workspaceInvitationSchema);
