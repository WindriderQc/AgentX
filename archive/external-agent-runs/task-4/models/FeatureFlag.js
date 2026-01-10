const mongoose = require('mongoose');
const crypto = require('crypto');

const FeatureFlagSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, index: true },
  enabled: { type: Boolean, default: false },
  description: { type: String, required: true },
  scope: {
    type: String,
    enum: ['global', 'user', 'admin'],
    default: 'global'
  },

  config: {
    rolloutPercentage: { type: Number, min: 0, max: 100, default: 100 },
    enabledFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    disabledFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    environment: {
      type: String,
      enum: ['development', 'staging', 'production', 'all'],
      default: 'all'
    }
  },

  metadata: {
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: String,
    reason: String,
    tags: [String]
  }
});

// Helper methods

/**
 * Check if feature is enabled for user
 * Considers: global enabled, rollout percentage, user-specific overrides
 */
FeatureFlagSchema.statics.isEnabled = async function(flagName, userId = null, environment = 'all') {
  const flag = await this.findOne({ name: flagName });
  if (!flag) return false;

  // 1. Global switch
  if (!flag.enabled) return false;

  // 2. Environment check
  if (flag.config.environment !== 'all' && flag.config.environment !== environment) {
    return false;
  }

  // If no user context, just return global enabled status (assuming 100% rollout if global is on, or handled elsewhere)
  // But strictly speaking, if rollout is < 100 and we have no user, we might default to false or true.
  // Standard pattern: if no user, standard global logic applies (return enabled).
  if (!userId) return flag.enabled;

  const userIdStr = userId.toString();

  // 3. Explicit User Overrides
  if (flag.config.disabledFor.some(id => id.toString() === userIdStr)) return false;
  if (flag.config.enabledFor.some(id => id.toString() === userIdStr)) return true;

  // 4. Rollout Percentage
  return flag.checkRollout(userIdStr);
};

/**
 * Deterministic rollout check based on userId hash
 * Same user always gets same result for consistency
 */
FeatureFlagSchema.methods.checkRollout = function(userId) {
  if (this.config.rolloutPercentage === 100) return true;
  if (this.config.rolloutPercentage === 0) return false;
  if (!userId) return false;

  // Create a hash of userId + flagName to ensure different flags roll out to different random subsets
  const hash = crypto.createHash('md5').update(`${userId}:${this.name}`).digest('hex');
  
  // Convert first 8 chars of hash to integer
  const val = parseInt(hash.substring(0, 8), 16);
  
  // Modulo 100 to get percentage bucket (0-99)
  const bucket = val % 100;

  return bucket < this.config.rolloutPercentage;
};

module.exports = mongoose.model('FeatureFlag', FeatureFlagSchema);
