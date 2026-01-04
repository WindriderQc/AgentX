/**
 * ModelRegistry Model
 *
 * Single source of truth for model metadata, capabilities, and categorization.
 * Enables intelligent routing, benchmark filtering, and capability-based selection.
 *
 * @see /docs/planning/BENCHMARK_ENHANCEMENT_PLAN.md
 */

const mongoose = require('mongoose');

const CapabilitiesSchema = new mongoose.Schema({
  maxContext: {
    type: Number,
    default: 2048,
    min: 512
  },
  supportsThinking: {
    type: Boolean,
    default: false
  },
  supportsVision: {
    type: Boolean,
    default: false
  },
  avgLatencyMs: {
    type: Number,
    default: null
  },
  p95LatencyMs: {
    type: Number,
    default: null
  },
  targetUseCase: {
    type: String,
    default: ''
  },
  optimalBatchSize: {
    type: Number,
    default: 1,
    min: 1
  }
}, { _id: false });

const BenchmarkStatsSchema = new mongoose.Schema({
  avgCompositeScore: {
    type: Number,
    default: null,
    min: 0,
    max: 100
  },
  avgQualityScore: {
    type: Number,
    default: null,
    min: 0,
    max: 100
  },
  bestCategory: {
    type: String,
    default: null
  },
  worstCategory: {
    type: String,
    default: null
  },
  totalTests: {
    type: Number,
    default: 0,
    min: 0
  },
  lastBenchmarked: {
    type: Date,
    default: null
  }
}, { _id: false });

const RoutingRulesSchema = new mongoose.Schema({
  preferredFor: [{
    type: String
    // Allow any task type string for flexibility
  }],
  avoidFor: [{
    type: String
    // Allow any task type string for flexibility
  }],
  priority: {
    type: Number,
    default: 5,
    min: 1,
    max: 10
  }
}, { _id: false });

const ModelRegistrySchema = new mongoose.Schema({
  // Identity
  modelName: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  displayName: {
    type: String,
    required: true,
    trim: true
  },
  vendor: {
    type: String,
    trim: true,
    default: 'unknown',
    enum: ['meta', 'alibaba', 'deepseek', 'mistral', 'google', 'microsoft', 'anthropic', 'openai', 'community', 'unknown']
  },
  description: {
    type: String,
    default: ''
  },

  // Categorization (Multi-select)
  categories: [{
    type: String,
    enum: [
      'ops',           // Operations/glue logic
      'coding',        // Code generation
      'reasoning',     // Deep thinking
      'specialist',    // Fine-tuned for specific domain
      'generalist',    // General-purpose
      'embedding',     // Vector embeddings only
      'judge'          // Quality scoring
    ],
    index: true
  }],

  // Freeform tags
  tags: {
    type: [String],
    default: [],
    index: true
  },

  // Capabilities
  capabilities: {
    type: CapabilitiesSchema,
    default: () => ({})
  },

  // Deployment
  host: {
    type: String,
    default: process.env.OLLAMA_HOST || 'http://localhost:11434'
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  status: {
    type: String,
    enum: ['active', 'deprecated', 'experimental', 'retired'],
    default: 'active',
    index: true
  },

  // Performance Tracking (Auto-updated from benchmarks)
  benchmarkStats: {
    type: BenchmarkStatsSchema,
    default: () => ({})
  },

  // Routing Hints
  routingRules: {
    type: RoutingRulesSchema,
    default: () => ({})
  },

  // Metadata
  createdBy: {
    type: String,
    default: 'system'
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  notes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

// Compound indexes for common queries
ModelRegistrySchema.index({ categories: 1, isActive: 1 });
ModelRegistrySchema.index({ tags: 1, isActive: 1 });
ModelRegistrySchema.index({ status: 1, isActive: 1 });
ModelRegistrySchema.index({ vendor: 1, categories: 1 });
ModelRegistrySchema.index({ 'capabilities.maxContext': 1 });
ModelRegistrySchema.index({ 'benchmarkStats.avgCompositeScore': -1 });

// Virtual for full capability description
ModelRegistrySchema.virtual('fullDescription').get(function() {
  return `${this.displayName} (${this.vendor}) - ${this.description}`;
});

// Ensure virtuals are included in JSON
ModelRegistrySchema.set('toJSON', { virtuals: true });
ModelRegistrySchema.set('toObject', { virtuals: true });

/* ============================================================================
 * STATIC METHODS - Query Helpers
 * ========================================================================= */

/**
 * Get all active models
 */
ModelRegistrySchema.statics.getActive = function(filters = {}) {
  return this.find({
    isActive: true,
    status: 'active',
    ...filters
  })
  .sort({ displayName: 1 })
  .lean();
};

/**
 * Find models by category
 */
ModelRegistrySchema.statics.findByCategory = function(category) {
  return this.find({
    categories: category,
    isActive: true
  })
  .sort({ 'benchmarkStats.avgCompositeScore': -1 })
  .lean();
};

/**
 * Find models by tag
 */
ModelRegistrySchema.statics.findByTag = function(tag) {
  return this.find({
    tags: tag,
    isActive: true
  })
  .sort({ displayName: 1 })
  .lean();
};

/**
 * Find models with minimum context window
 */
ModelRegistrySchema.statics.findByMinContext = function(minContext) {
  return this.find({
    'capabilities.maxContext': { $gte: minContext },
    isActive: true
  })
  .sort({ 'capabilities.maxContext': -1 })
  .lean();
};

/**
 * Get best model for specific task type
 *
 * @param {string} taskType - Task type from routingRules.preferredFor
 * @param {object} constraints - Optional constraints { maxLatency, minContext }
 * @returns {Promise<Model>} Best matching model
 */
ModelRegistrySchema.statics.getBestForTask = async function(taskType, constraints = {}) {
  const query = {
    'routingRules.preferredFor': taskType,
    isActive: true,
    status: 'active'
  };

  // Apply constraints
  if (constraints.maxLatency) {
    query['capabilities.p95LatencyMs'] = { $lte: constraints.maxLatency };
  }
  if (constraints.minContext) {
    query['capabilities.maxContext'] = { $gte: constraints.minContext };
  }

  const models = await this.find(query)
    .sort({
      'routingRules.priority': -1,
      'benchmarkStats.avgCompositeScore': -1
    })
    .limit(1)
    .lean();

  return models[0] || null;
};

/**
 * Get models grouped by category
 */
ModelRegistrySchema.statics.getGroupedByCategory = async function() {
  const models = await this.find({ isActive: true }).lean();

  const grouped = {
    ops: [],
    coding: [],
    reasoning: [],
    specialist: [],
    generalist: [],
    embedding: [],
    judge: []
  };

  models.forEach(model => {
    model.categories.forEach(category => {
      if (grouped[category]) {
        grouped[category].push(model);
      }
    });
  });

  // Sort each group by composite score
  Object.keys(grouped).forEach(category => {
    grouped[category].sort((a, b) => {
      const scoreA = a.benchmarkStats?.avgCompositeScore || 0;
      const scoreB = b.benchmarkStats?.avgCompositeScore || 0;
      return scoreB - scoreA;
    });
  });

  return grouped;
};

/**
 * Get category statistics
 */
ModelRegistrySchema.statics.getCategoryStats = async function() {
  const models = await this.find({ isActive: true }).lean();

  const stats = {};

  models.forEach(model => {
    model.categories.forEach(category => {
      if (!stats[category]) {
        stats[category] = {
          count: 0,
          avgCompositeScore: 0,
          avgLatency: 0,
          models: []
        };
      }

      stats[category].count += 1;
      stats[category].models.push(model.modelName);

      if (model.benchmarkStats?.avgCompositeScore) {
        stats[category].avgCompositeScore += model.benchmarkStats.avgCompositeScore;
      }
      if (model.capabilities?.avgLatencyMs) {
        stats[category].avgLatency += model.capabilities.avgLatencyMs;
      }
    });
  });

  // Calculate averages
  Object.keys(stats).forEach(category => {
    if (stats[category].count > 0) {
      stats[category].avgCompositeScore /= stats[category].count;
      stats[category].avgLatency /= stats[category].count;
      stats[category].avgCompositeScore = Math.round(stats[category].avgCompositeScore * 10) / 10;
      stats[category].avgLatency = Math.round(stats[category].avgLatency);
    }
  });

  return stats;
};

/**
 * Sync benchmark statistics from BenchmarkResult collection
 *
 * @param {string} modelName - Model to update
 * @returns {Promise<Model>} Updated model
 */
ModelRegistrySchema.statics.syncBenchmarkStats = async function(modelName) {
  const BenchmarkResult = require('./BenchmarkResult');

  // Get aggregated stats from benchmark results
  const stats = await BenchmarkResult.aggregate([
    { $match: { model: modelName, success: true } },
    {
      $group: {
        _id: null,
        avgComposite: { $avg: '$composite_score' },
        avgQuality: { $avg: '$quality_score' },
        totalTests: { $sum: 1 },
        avgLatency: { $avg: '$latency' },
        categories: { $push: '$prompt_category' }
      }
    }
  ]);

  if (stats.length === 0) {
    return null;
  }

  const data = stats[0];

  // Find best and worst categories
  const categoryScores = await BenchmarkResult.aggregate([
    { $match: { model: modelName, success: true, quality_score: { $ne: null } } },
    {
      $group: {
        _id: '$prompt_category',
        avgQuality: { $avg: '$quality_score' }
      }
    },
    { $sort: { avgQuality: -1 } }
  ]);

  const bestCategory = categoryScores[0]?._id || null;
  const worstCategory = categoryScores[categoryScores.length - 1]?._id || null;

  // Calculate p95 latency
  const latencies = await BenchmarkResult.find(
    { model: modelName, success: true },
    { latency: 1 }
  ).sort({ latency: 1 }).lean();

  const p95Index = Math.floor(latencies.length * 0.95);
  const p95Latency = latencies[p95Index]?.latency || data.avgLatency;

  // Update model
  const updated = await this.findOneAndUpdate(
    { modelName },
    {
      $set: {
        'benchmarkStats.avgCompositeScore': Math.round(data.avgComposite * 10) / 10,
        'benchmarkStats.avgQualityScore': Math.round(data.avgQuality * 10) / 10,
        'benchmarkStats.bestCategory': bestCategory,
        'benchmarkStats.worstCategory': worstCategory,
        'benchmarkStats.totalTests': data.totalTests,
        'benchmarkStats.lastBenchmarked': new Date(),
        'capabilities.avgLatencyMs': Math.round(data.avgLatency),
        'capabilities.p95LatencyMs': Math.round(p95Latency),
        lastUpdated: new Date()
      }
    },
    { new: true }
  );

  return updated;
};

/* ============================================================================
 * INSTANCE METHODS
 * ========================================================================= */

/**
 * Add category to model
 */
ModelRegistrySchema.methods.addCategory = function(category) {
  if (!this.categories.includes(category)) {
    this.categories.push(category);
    this.lastUpdated = new Date();
  }
  return this.save();
};

/**
 * Remove category from model
 */
ModelRegistrySchema.methods.removeCategory = function(category) {
  this.categories = this.categories.filter(c => c !== category);
  this.lastUpdated = new Date();
  return this.save();
};

/**
 * Add tag to model
 */
ModelRegistrySchema.methods.addTag = function(tag) {
  if (!this.tags.includes(tag)) {
    this.tags.push(tag);
    this.lastUpdated = new Date();
  }
  return this.save();
};

/**
 * Remove tag from model
 */
ModelRegistrySchema.methods.removeTag = function(tag) {
  this.tags = this.tags.filter(t => t !== tag);
  this.lastUpdated = new Date();
  return this.save();
};

/**
 * Mark model as deprecated
 */
ModelRegistrySchema.methods.deprecate = function(reason) {
  this.status = 'deprecated';
  this.notes += `\n\nDeprecated: ${new Date().toISOString()} - ${reason}`;
  this.lastUpdated = new Date();
  return this.save();
};

/**
 * Mark model as retired
 */
ModelRegistrySchema.methods.retire = function(reason) {
  this.status = 'retired';
  this.isActive = false;
  this.notes += `\n\nRetired: ${new Date().toISOString()} - ${reason}`;
  this.lastUpdated = new Date();
  return this.save();
};

/**
 * Update capabilities from external source
 */
ModelRegistrySchema.methods.updateCapabilities = function(capabilities) {
  Object.assign(this.capabilities, capabilities);
  this.lastUpdated = new Date();
  return this.save();
};

/**
 * Check if model is suitable for task
 */
ModelRegistrySchema.methods.isSuitableFor = function(taskType, constraints = {}) {
  // Check if task is in avoid list
  if (this.routingRules.avoidFor.includes(taskType)) {
    return false;
  }

  // Check constraints
  if (constraints.maxLatency && this.capabilities.p95LatencyMs > constraints.maxLatency) {
    return false;
  }
  if (constraints.minContext && this.capabilities.maxContext < constraints.minContext) {
    return false;
  }

  // Preferred task?
  if (this.routingRules.preferredFor.includes(taskType)) {
    return true;
  }

  // Check category alignment
  const taskCategoryMap = {
    'code_generation': 'coding',
    'deep_reasoning': 'reasoning',
    'quick_chat': 'ops',
    'factual_qa': 'generalist'
  };

  const alignedCategory = taskCategoryMap[taskType];
  if (alignedCategory && this.categories.includes(alignedCategory)) {
    return true;
  }

  // Default: generalists can handle most tasks
  return this.categories.includes('generalist');
};

module.exports = mongoose.model('ModelRegistry', ModelRegistrySchema);
