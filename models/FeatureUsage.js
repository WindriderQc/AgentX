const mongoose = require('mongoose');

const FeatureUsageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserProfile', index: true },
  feature: { type: String, required: true, index: true },
  page: String,
  action: {
    type: String,
    enum: ['viewed', 'clicked', 'completed', 'dismissed'],
    required: true
  },

  metadata: {
    sessionId: String,
    timestamp: { type: Date, default: Date.now, index: true },
    duration: Number,        // Time spent in milliseconds
    context: mongoose.Schema.Types.Mixed
  }
});

// Compound indexes for analytics queries
FeatureUsageSchema.index({ feature: 1, timestamp: -1 });
FeatureUsageSchema.index({ userId: 1, feature: 1 });

// Helper methods

/**
 * Returns: { totalUsers, activeUsers, adoptionRate, trend }
 */
FeatureUsageSchema.statics.getFeatureAdoption = async function(feature, daysBack = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const stats = await this.aggregate([
    {
      $match: {
        feature: feature,
        'metadata.timestamp': { $gte: cutoff }
      }
    },
    {
      $group: {
        _id: null,
        uniqueUsers: { $addToSet: "$userId" },
        totalInteractions: { $sum: 1 }
      }
    }
  ]);

  if (!stats.length) {
    return { totalUsers: 0, activeUsers: 0, adoptionRate: 0, trend: 'flat' };
  }

  const activeUsers = stats[0].uniqueUsers.length;
  
  // Note: To calculate actual "adoption rate", we need the total user base count, 
  // which is outside this model's scope usually. 
  // We'll return activeUsers count and let caller handle rate vs total users.
  
  return {
    feature,
    period: `${daysBack}d`,
    activeUsers,
    totalInteractions: stats[0].totalInteractions
  };
};

/**
 * Returns: User's feature usage patterns
 */
FeatureUsageSchema.statics.getUserFeatureProfile = async function(userId) {
  return this.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: "$feature",
        lastUsed: { $max: "$metadata.timestamp" },
        interactionCount: { $sum: 1 },
        actions: { $addToSet: "$action" }
      }
    },
    { $sort: { lastUsed: -1 } }
  ]);
};

module.exports = mongoose.model('FeatureUsage', FeatureUsageSchema);
