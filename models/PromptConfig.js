const mongoose = require('mongoose');

const PromptConfigSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  systemPrompt: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: false
  },
  version: {
    type: Number,
    default: 1
  },
  description: {
    type: String,
    default: ''
  },
  // A/B Testing support
  trafficWeight: {
    type: Number,
    default: 100,  // 0-100, percentage of traffic for this version
    min: 0,
    max: 100
  },
  abTestGroup: {
    type: String,
    default: null  // Group ID if this is part of an A/B test
  },
  // Performance tracking
  stats: {
    impressions: { type: Number, default: 0 },
    positiveCount: { type: Number, default: 0 },
    negativeCount: { type: Number, default: 0 }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index for name + version (unique combination)
PromptConfigSchema.index({ name: 1, version: 1 }, { unique: true });

PromptConfigSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  if (typeof next === 'function') {
    next();
  }
});

// Static method to get active prompt by name (random selection for A/B)
PromptConfigSchema.statics.getActive = async function(name = 'default_chat') {
  // Find all active versions for this persona
  const activePrompts = await this.find({ name, isActive: true }).sort({ version: -1 });
  
  if (activePrompts.length === 0) return null;
  if (activePrompts.length === 1) return activePrompts[0];
  
  // Weighted random selection for A/B testing
  const totalWeight = activePrompts.reduce((sum, p) => sum + (p.trafficWeight || 100), 0);
  let random = Math.random() * totalWeight;
  
  for (const prompt of activePrompts) {
    random -= prompt.trafficWeight || 100;
    if (random <= 0) return prompt;
  }
  
  return activePrompts[0];  // Fallback
};

// Static method to get all versions for A/B comparison
PromptConfigSchema.statics.getVersions = async function(name) {
  return this.find({ name }).sort({ version: -1 });
};

// Instance method to increment stats
PromptConfigSchema.methods.recordImpression = async function() {
  this.stats.impressions = (this.stats.impressions || 0) + 1;
  await this.save();
};

PromptConfigSchema.methods.recordFeedback = async function(isPositive) {
  if (isPositive) {
    this.stats.positiveCount = (this.stats.positiveCount || 0) + 1;
  } else {
    this.stats.negativeCount = (this.stats.negativeCount || 0) + 1;
  }
  await this.save();
};

module.exports = mongoose.model('PromptConfig', PromptConfigSchema);
