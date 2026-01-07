/**
 * API Key Model
 *
 * Fine-grained API key management with scopes and rotation
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const APIKeySchema = new mongoose.Schema({
  // Hashed key (never store plaintext)
  keyHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Display prefix (last 8 chars for identification)
  keyPrefix: {
    type: String,
    required: true,
    index: true
  },

  // Owner
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },

  // Week 4: Multi-tenancy support
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false, // Optional for backward compatibility
    index: true
  },

  // Human-readable name
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },

  // Scopes (permissions)
  scopes: [{
    type: String,
    enum: [
      'chat:read',
      'chat:write',
      'rag:read',
      'rag:write',
      'models:read',
      'models:write',
      'admin:read',
      'admin:write',
      'admin:*',
      '*:*' // Full access
    ]
  }],

  // Revocation
  revokedAt: {
    type: Date,
    default: null,
    index: true
  },

  revokedReason: {
    type: String,
    maxlength: 500
  },

  // Expiration
  expiresAt: {
    type: Date,
    default: null,
    index: true
  },

  // Usage tracking
  lastUsedAt: {
    type: Date,
    default: null
  },

  usageCount: {
    type: Number,
    default: 0
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
  }
});

// Update timestamp on save
APIKeySchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Generate a new API key
 * @returns {string} - Raw API key (show to user once)
 */
APIKeySchema.statics.generateKey = function() {
  // Format: agx_[32 random hex chars]
  const randomBytes = crypto.randomBytes(24);
  return `agx_${randomBytes.toString('hex')}`;
};

/**
 * Hash an API key
 * @param {string} key - Raw API key
 * @returns {string} - Hashed key
 */
APIKeySchema.statics.hashKey = function(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
};

/**
 * Get key prefix (last 8 chars for display)
 * @param {string} key - Raw API key
 * @returns {string} - Key prefix
 */
APIKeySchema.statics.getPrefix = function(key) {
  return key.slice(-8);
};

/**
 * Verify a raw key against this hashed key
 * @param {string} rawKey - Raw API key to verify
 * @returns {boolean} - True if matches
 */
APIKeySchema.methods.verifyKey = function(rawKey) {
  const hash = APIKey.hashKey(rawKey);
  return hash === this.keyHash;
};

/**
 * Check if key is valid (not revoked, not expired)
 * @returns {boolean} - True if valid
 */
APIKeySchema.methods.isValid = function() {
  if (this.revokedAt) return false;
  if (this.expiresAt && this.expiresAt < new Date()) return false;
  return true;
};

/**
 * Check if key has a specific scope
 * @param {string} requiredScope - Scope to check (e.g., 'chat:write')
 * @returns {boolean} - True if has scope
 */
APIKeySchema.methods.hasScope = function(requiredScope) {
  // Check for wildcard scopes
  if (this.scopes.includes('*:*')) return true;
  if (this.scopes.includes('admin:*') && requiredScope.startsWith('admin:')) return true;

  // Check exact scope
  if (this.scopes.includes(requiredScope)) return true;

  // Check wildcard within resource (e.g., 'chat:*' covers 'chat:read')
  const [resource] = requiredScope.split(':');
  if (this.scopes.includes(`${resource}:*`)) return true;

  return false;
};

/**
 * Record usage of this key
 */
APIKeySchema.methods.recordUsage = async function() {
  this.lastUsedAt = new Date();
  this.usageCount += 1;
  await this.save();
};

/**
 * Revoke this key
 * @param {string} reason - Reason for revocation
 */
APIKeySchema.methods.revoke = async function(reason = null) {
  this.revokedAt = new Date();
  this.revokedReason = reason;
  await this.save();
};

/**
 * Find valid key by raw key string
 * @param {string} rawKey - Raw API key
 * @returns {Promise<APIKey|null>} - API key document or null
 */
APIKeySchema.statics.findByKey = async function(rawKey) {
  const hash = this.hashKey(rawKey);
  const key = await this.findOne({ keyHash: hash });

  if (!key) return null;
  if (!key.isValid()) return null;

  return key;
};

/**
 * Create a new API key
 * @param {Object} data - Key data (userId, name, scopes, expiresAt)
 * @returns {Promise<{key: string, doc: APIKey}>} - Raw key and document
 */
APIKeySchema.statics.createKey = async function(data) {
  const rawKey = this.generateKey();
  const keyHash = this.hashKey(rawKey);
  const keyPrefix = this.getPrefix(rawKey);

  const doc = await this.create({
    keyHash,
    keyPrefix,
    userId: data.userId,
    name: data.name,
    scopes: data.scopes || [],
    expiresAt: data.expiresAt || null
  });

  return { key: rawKey, doc };
};

/**
 * Rotate a key (revoke old, create new)
 * @param {string} oldKeyId - Old key ID to revoke
 * @param {string} userId - User ID (for verification)
 * @returns {Promise<{key: string, doc: APIKey}>} - New key and document
 */
APIKeySchema.statics.rotateKey = async function(oldKeyId, userId) {
  const oldKey = await this.findOne({ _id: oldKeyId, userId });

  if (!oldKey) {
    throw new Error('API key not found or unauthorized');
  }

  // Revoke old key
  await oldKey.revoke('Rotated');

  // Create new key with same scopes
  return await this.createKey({
    userId,
    name: oldKey.name,
    scopes: oldKey.scopes,
    expiresAt: oldKey.expiresAt
  });
};

const APIKey = mongoose.model('APIKey', APIKeySchema);

module.exports = APIKey;
