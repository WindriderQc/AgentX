/**
 * WorkspaceMember Model
 *
 * Manages workspace membership and role-based access control (RBAC).
 * Links users to workspaces with specific roles and permissions.
 *
 * Week 4 Day 1 - Multi-Tenancy Support
 */

const mongoose = require('mongoose');

const WorkspaceMemberSchema = new mongoose.Schema({
  // References
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true
  },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Role-Based Access Control
  role: {
    type: String,
    enum: ['owner', 'admin', 'member', 'viewer'],
    default: 'member',
    required: true
  },

  // Granular Permissions (can override role defaults)
  permissions: {
    // Chat permissions
    chat: {
      type: Boolean,
      default: true
    },

    // RAG permissions
    rag: {
      type: Boolean,
      default: true
    },

    // Model management
    models: {
      type: Boolean,
      default: false
    },

    // Benchmarking
    benchmark: {
      type: Boolean,
      default: false
    },

    // Alerts
    alerts: {
      type: Boolean,
      default: false
    },

    // Workspace settings (invite, configure)
    settings: {
      type: Boolean,
      default: false
    }
  },

  // Status
  status: {
    type: String,
    enum: ['active', 'suspended', 'pending'],
    default: 'active',
    index: true
  },

  // Invitation tracking
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  invitedAt: {
    type: Date,
    default: Date.now
  },

  // Acceptance tracking
  joinedAt: {
    type: Date,
    default: Date.now
  },

  // Metadata
  createdAt: {
    type: Date,
    default: Date.now
  },

  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound Indexes
WorkspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
WorkspaceMemberSchema.index({ userId: 1, status: 1 });
WorkspaceMemberSchema.index({ workspaceId: 1, role: 1 });

// Update timestamp on save
WorkspaceMemberSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Instance Methods

/**
 * Check if member has specific permission
 */
WorkspaceMemberSchema.methods.hasPermission = function(permission) {
  // Owners and admins have all permissions
  if (this.role === 'owner' || this.role === 'admin') {
    return true;
  }

  // Check granular permission
  return this.permissions[permission] === true;
};

/**
 * Check if member is admin or owner
 */
WorkspaceMemberSchema.methods.isAdmin = function() {
  return this.role === 'owner' || this.role === 'admin';
};

/**
 * Check if member is owner
 */
WorkspaceMemberSchema.methods.isOwner = function() {
  return this.role === 'owner';
};

/**
 * Set role and update default permissions
 */
WorkspaceMemberSchema.methods.setRole = async function(newRole) {
  this.role = newRole;

  // Update permissions based on role
  if (newRole === 'owner' || newRole === 'admin') {
    // Admins get all permissions
    this.permissions = {
      chat: true,
      rag: true,
      models: true,
      benchmark: true,
      alerts: true,
      settings: true
    };
  } else if (newRole === 'member') {
    // Members get standard permissions
    this.permissions = {
      chat: true,
      rag: true,
      models: false,
      benchmark: false,
      alerts: false,
      settings: false
    };
  } else if (newRole === 'viewer') {
    // Viewers are read-only
    this.permissions = {
      chat: false,
      rag: false,
      models: false,
      benchmark: false,
      alerts: false,
      settings: false
    };
  }

  await this.save();
};

// Static Methods

/**
 * Get member by workspace and user
 */
WorkspaceMemberSchema.statics.getMember = async function(workspaceId, userId) {
  return this.findOne({
    workspaceId,
    userId,
    status: 'active'
  });
};

/**
 * Check if user is member of workspace
 */
WorkspaceMemberSchema.statics.isMember = async function(workspaceId, userId) {
  const member = await this.getMember(workspaceId, userId);
  return !!member;
};

/**
 * Get all members of a workspace
 */
WorkspaceMemberSchema.statics.getWorkspaceMembers = async function(workspaceId) {
  return this.find({
    workspaceId,
    status: 'active'
  })
    .populate('userId', 'username email')
    .sort({ role: 1, joinedAt: -1 });
};

/**
 * Get user's workspaces
 */
WorkspaceMemberSchema.statics.getUserWorkspaces = async function(userId) {
  return this.find({
    userId,
    status: 'active'
  })
    .populate('workspaceId')
    .sort({ joinedAt: -1 });
};

/**
 * Invite user to workspace
 */
WorkspaceMemberSchema.statics.inviteMember = async function(workspaceId, userId, role, invitedBy) {
  // Check if already a member
  const existing = await this.findOne({ workspaceId, userId });

  if (existing) {
    if (existing.status === 'active') {
      const error = new Error('User is already a member');
      error.statusCode = 400;
      throw error;
    }

    // Reactivate suspended member
    existing.status = 'active';
    existing.role = role;
    existing.invitedBy = invitedBy;
    await existing.save();
    return existing;
  }

  // Create new membership
  const member = new this({
    workspaceId,
    userId,
    role,
    invitedBy,
    status: 'pending' // Will be activated when user accepts
  });

  await member.save();
  return member;
};

/**
 * Remove member from workspace
 */
WorkspaceMemberSchema.statics.removeMember = async function(workspaceId, userId) {
  const member = await this.getMember(workspaceId, userId);

  if (!member) {
    const error = new Error('Member not found');
    error.statusCode = 404;
    throw error;
  }

  if (member.role === 'owner') {
    const error = new Error('Cannot remove workspace owner');
    error.statusCode = 403;
    throw error;
  }

  await member.deleteOne();
};

/**
 * Transfer ownership
 */
WorkspaceMemberSchema.statics.transferOwnership = async function(workspaceId, fromUserId, toUserId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Demote current owner to admin
    await this.updateOne(
      { workspaceId, userId: fromUserId, role: 'owner' },
      { $set: { role: 'admin' } },
      { session }
    );

    // Promote new owner
    const newOwner = await this.findOne({ workspaceId, userId: toUserId }, null, { session });

    if (!newOwner) {
      throw new Error('New owner is not a member of this workspace');
    }

    newOwner.role = 'owner';
    await newOwner.save({ session });

    // Update workspace ownerId
    const Workspace = mongoose.model('Workspace');
    await Workspace.updateOne(
      { _id: workspaceId },
      { $set: { ownerId: toUserId } },
      { session }
    );

    await session.commitTransaction();
    return newOwner;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// Virtual: Display role name
WorkspaceMemberSchema.virtual('roleName').get(function() {
  const roleNames = {
    'owner': 'Owner',
    'admin': 'Administrator',
    'member': 'Member',
    'viewer': 'Viewer'
  };

  return roleNames[this.role] || this.role;
});

// Ensure virtuals are included in JSON
WorkspaceMemberSchema.set('toJSON', { virtuals: true });
WorkspaceMemberSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('WorkspaceMember', WorkspaceMemberSchema);
