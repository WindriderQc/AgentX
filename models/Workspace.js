/**
 * Workspace Model
 *
 * Multi-tenant workspace for team collaboration and data isolation.
 * Each workspace has its own conversations, prompts, models, and settings.
 *
 * Week 4 Day 1 - Multi-Tenancy Support
 */

const mongoose = require('mongoose');

const WorkspaceSchema = new mongoose.Schema({
  // Identity
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 100
  },

  slug: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    match: /^[a-z0-9-]+$/, // URL-friendly: alphanumeric and hyphens only
    minlength: 3,
    maxlength: 50
  },

  description: {
    type: String,
    maxlength: 500
  },

  // Ownership
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Feature Settings
  settings: {
    // Model Access
    allowedModels: {
      type: [String],
      default: [] // Empty = all models allowed
    },

    // Feature Toggles
    apiKeyEnabled: {
      type: Boolean,
      default: true
    },

    ragEnabled: {
      type: Boolean,
      default: true
    },

    customModelsEnabled: {
      type: Boolean,
      default: false
    },

    benchmarkingEnabled: {
      type: Boolean,
      default: true
    },

    alertsEnabled: {
      type: Boolean,
      default: true
    },

    // Limits (future: enforce based on plan)
    maxConversations: {
      type: Number,
      default: 0 // 0 = unlimited
    },

    maxApiKeys: {
      type: Number,
      default: 10
    },

    maxMembers: {
      type: Number,
      default: 0 // 0 = unlimited
    }
  },

  // Billing & Plan (future use)
  plan: {
    type: String,
    enum: ['free', 'team', 'enterprise'],
    default: 'free'
  },

  // Status
  status: {
    type: String,
    enum: ['active', 'suspended', 'deleted'],
    default: 'active',
    index: true
  },

  // Metadata
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },

  updatedAt: {
    type: Date,
    default: Date.now
  },

  deletedAt: {
    type: Date,
    index: true
  }
});

// Indexes
WorkspaceSchema.index({ status: 1, createdAt: -1 });

// Update timestamp on save
WorkspaceSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Instance Methods

/**
 * Check if workspace has specific feature enabled
 */
WorkspaceSchema.methods.hasFeature = function(feature) {
  const featureMap = {
    'apiKey': this.settings.apiKeyEnabled,
    'rag': this.settings.ragEnabled,
    'customModels': this.settings.customModelsEnabled,
    'benchmarking': this.settings.benchmarkingEnabled,
    'alerts': this.settings.alertsEnabled
  };

  return featureMap[feature] !== undefined ? featureMap[feature] : false;
};

/**
 * Check if model is allowed in this workspace
 */
WorkspaceSchema.methods.isModelAllowed = function(modelName) {
  // Empty array = all models allowed
  if (!this.settings.allowedModels || this.settings.allowedModels.length === 0) {
    return true;
  }

  return this.settings.allowedModels.includes(modelName);
};

/**
 * Soft delete workspace
 */
WorkspaceSchema.methods.softDelete = async function() {
  this.status = 'deleted';
  this.deletedAt = new Date();
  await this.save();
};

// Static Methods

/**
 * Find active workspaces for a user (where they are owner or member)
 */
WorkspaceSchema.statics.findForUser = async function(userId) {
  const WorkspaceMember = mongoose.model('WorkspaceMember');

  // Get workspaces where user is member
  const memberships = await WorkspaceMember.find({ userId, status: 'active' })
    .select('workspaceId')
    .lean();

  const workspaceIds = memberships.map(m => m.workspaceId);

  // Get workspace details
  return this.find({
    _id: { $in: workspaceIds },
    status: 'active'
  }).sort({ createdAt: -1 });
};

/**
 * Create default workspace for new user
 */
WorkspaceSchema.statics.createDefault = async function(userId, userName) {
  const slug = `${userName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-workspace`;

  const workspace = new this({
    name: `${userName}'s Workspace`,
    slug,
    description: 'Personal workspace',
    ownerId: userId
  });

  await workspace.save();

  // Create workspace membership (owner role)
  const WorkspaceMember = mongoose.model('WorkspaceMember');
  await WorkspaceMember.create({
    workspaceId: workspace._id,
    userId,
    role: 'owner'
  });

  return workspace;
};

/**
 * Get workspace by slug with error handling
 */
WorkspaceSchema.statics.getBySlug = async function(slug) {
  const workspace = await this.findOne({ slug, status: 'active' });

  if (!workspace) {
    const error = new Error('Workspace not found');
    error.statusCode = 404;
    throw error;
  }

  return workspace;
};

// Virtual: Member count
WorkspaceSchema.virtual('memberCount', {
  ref: 'WorkspaceMember',
  localField: '_id',
  foreignField: 'workspaceId',
  count: true
});

// Ensure virtuals are included in JSON
WorkspaceSchema.set('toJSON', { virtuals: true });
WorkspaceSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Workspace', WorkspaceSchema);
