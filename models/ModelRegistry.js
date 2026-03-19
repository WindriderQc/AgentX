/**
 * ModelRegistry Model
 *
 * Single source of truth for model metadata, capabilities, and categorization.
 * Enables intelligent routing, benchmark filtering, and capability-based selection.
 *
 * @see /docs/planning/BENCHMARK_ENHANCEMENT_PLAN.md
 */

const mongoose = require('mongoose');
const { TASK_CATEGORY_MAP } = require('../config/categories');

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
  avgTokensPerSec: {
    type: Number,
    default: null,
    min: 0
  },
  targetUseCase: {
    type: String,
    default: ''
  },
  optimalBatchSize: {
    type: Number,
    default: 1,
    min: 1
  },

  // Legacy compatibility tier. Existing courthouse flows still edit this field.
  // New curation should prefer curatedJudgeTier so manual edits stay distinct
  // from calibration output.
  judgeTier: {
    type: String,
    enum: ['basic', 'standard', 'advanced', 'premium', null],
    default: null
  },

  // Canonical human-curated tier.
  curatedJudgeTier: {
    type: String,
    enum: ['basic', 'standard', 'advanced', 'premium', null],
    default: null
  },

  // Raw machine calibration output.
  calibratedJudgeTier: {
    type: String,
    enum: ['basic', 'standard', 'advanced', 'premium', null],
    default: null
  },

  // Machine-recommended tier derived from calibration.
  recommendedJudgeTier: {
    type: String,
    enum: ['basic', 'standard', 'advanced', 'premium', null],
    default: null
  },

  calibratedAt: {
    type: Date,
    default: null
  },

  // Judge reliability score (0-1), populated by judge validation tests.
  // Tracks JSON reliability and scoring consistency.
  judgeReliability: {
    type: Number,
    default: null,
    min: 0,
    max: 1
  },

  // Average judge latency in ms (from validation or live benchmarks)
  avgJudgeLatencyMs: {
    type: Number,
    default: null,
    min: 0
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

const BenchmarkEligibilitySchema = new mongoose.Schema({
  eligible: {
    type: Boolean,
    default: null
  },
  blockedReason: {
    type: String,
    default: null
  },
  reviewedAt: {
    type: Date,
    default: null
  },
  reviewedBy: {
    type: String,
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

const ExecutionConfigSchema = new mongoose.Schema({
  num_ctx: { type: Number, default: null, min: 512, max: 131072 },
  temperature: { type: Number, default: null, min: 0, max: 2 },
  _source: { type: String, enum: ['auto', 'user', 'system'], default: 'system' },
  _reason: { type: String, default: null },
  _detectedAt: { type: Date, default: null }
}, { _id: false });

const ExecutionOverridesSchema = new mongoose.Schema({
  num_ctx: { type: Number, default: null, min: 512, max: 131072 },
  temperature: { type: Number, default: null, min: 0, max: 2 },
  _overriddenAt: { type: Date, default: null }
}, { _id: false });

const HostPerformanceStepSchema = new mongoose.Schema({
  hostUrl: { type: String, required: true },
  hostId: { type: String },
  tokensPerSec: { type: Number, required: true },
  promptEvalTokensPerSec: { type: Number, default: null },
  latencyMs: { type: Number, required: true },
  timeToFirstTokenMs: { type: Number, default: null },
  promptTokens: { type: Number, default: null },
  completionTokens: { type: Number, default: null },
  vramUsedMiB: { type: Number, default: null },
  vramTotalMiB: { type: Number, default: null },
  numCtx: { type: Number, default: null },
  testedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['pass', 'fail', 'timeout', 'error'], default: 'pass' },
  error: { type: String, default: null }
}, { _id: false });

const ContextTestStepSchema = new mongoose.Schema({
  numCtx: Number,
  tokensPerSec: Number,
  promptTokens: Number,
  completionTokens: Number,
  vramUsedMiB: Number,
  vramTotalMiB: Number,
  latencyMs: Number,
  passed: Boolean,
  reason: String
}, { _id: false });

const ContextTestSchema = new mongoose.Schema({
  testedNumCtx: { type: Number, default: null },
  baselineTokensPerSec: { type: Number, default: null },
  atLimitTokensPerSec: { type: Number, default: null },
  degradationPct: { type: Number, default: null },
  vramAtLimitMiB: { type: Number, default: null },
  modelTheoreticalMax: { type: Number, default: null },
  degradationThreshold: { type: Number, default: null },
  testedAt: { type: Date, default: null },
  testDurationMs: { type: Number, default: null },
  hostUrl: { type: String, default: null },
  status: { type: String, enum: ['pending', 'running', 'completed', 'failed'], default: null },
  error: { type: String, default: null },
  steps: [ContextTestStepSchema]
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

  // User comments/notes
  userNote: {
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

  // Source tracking (populated by auto-sync)
  sourceType: {
    type: String,
    enum: ['ollama', 'n8n', 'manual'],
    default: 'manual',
    index: true
  },
  sourceHost: { type: String, default: null },
  ollamaDigest: { type: String, default: null },
  lastSeenAt: { type: Date, default: null },
  modelSizeBytes: { type: Number, default: null },
  parameterSize: { type: String, default: null },
  quantization: { type: String, default: null },
  family: { type: String, default: null },

  // Per-model execution config (auto-detected or system defaults)
  executionDefaults: {
    type: ExecutionConfigSchema,
    default: () => ({})
  },
  // User overrides (separate so original defaults always visible)
  executionOverrides: {
    type: ExecutionOverridesSchema,
    default: () => ({})
  },
  // Empirical context window test results
  contextTest: {
    type: ContextTestSchema,
    default: () => ({})
  },

  // Per-host performance test snapshots (capped at 50, pruned on write)
  hostPerformance: {
    type: [HostPerformanceStepSchema],
    default: []
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

  benchmarkEligibility: {
    type: BenchmarkEligibilitySchema,
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
ModelRegistrySchema.index({ sourceType: 1, isActive: 1 });

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

  // Build dynamically from schema enum so new categories are never silently dropped
  const categoryEnum = ModelRegistrySchema.path('categories').caster.enumValues || [];
  const grouped = Object.fromEntries(categoryEnum.map(c => [c, []]));

  models.forEach(model => {
    model.categories.forEach(category => {
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push(model);
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
          benchmarkedCount: 0,
          latencyCount: 0,
          avgCompositeScore: 0,
          avgLatency: 0,
          models: []
        };
      }

      stats[category].count += 1;
      stats[category].models.push(model.modelName);

      if (model.benchmarkStats?.avgCompositeScore) {
        stats[category].avgCompositeScore += model.benchmarkStats.avgCompositeScore;
        stats[category].benchmarkedCount += 1;
      }
      if (model.capabilities?.avgLatencyMs) {
        stats[category].avgLatency += model.capabilities.avgLatencyMs;
        stats[category].latencyCount += 1;
      }
    });
  });

  // Calculate averages using only models that have data
  Object.keys(stats).forEach(category => {
    if (stats[category].benchmarkedCount > 0) {
      stats[category].avgCompositeScore /= stats[category].benchmarkedCount;
      stats[category].avgCompositeScore = Math.round(stats[category].avgCompositeScore * 10) / 10;
    }
    if (stats[category].latencyCount > 0) {
      stats[category].avgLatency /= stats[category].latencyCount;
      stats[category].avgLatency = Math.round(stats[category].avgLatency);
    }
    // Clean up internal counters
    delete stats[category].benchmarkedCount;
    delete stats[category].latencyCount;
  });

  return stats;
};

/**
 * Persist a host performance snapshot and recalculate capabilities.
 * Keeps max 50 snapshots (latest per host, FIFO for old entries).
 * Recalculates: avgTokensPerSec, avgLatencyMs, p95LatencyMs from stored snapshots.
 *
 * @param {string} modelName
 * @param {object} snapshot - HostPerformanceStepSchema-compatible object
 * @returns {Promise<Model>} Updated model
 */
ModelRegistrySchema.statics.updateHostPerformance = async function(modelName, snapshot) {
  // Atomic push + prune: avoids read-modify-write race when concurrent tests finish
  const pushResult = await this.findOneAndUpdate(
    { modelName },
    {
      $push: {
        hostPerformance: {
          $each: [snapshot],
          $sort: { testedAt: -1 },
          $slice: 50
        }
      },
      $set: { lastUpdated: new Date() }
    },
    { new: true }
  );
  if (!pushResult) return null;

  // Recalculate capabilities from passing snapshots
  const passing = pushResult.hostPerformance.filter(s => s.status === 'pass');
  if (passing.length > 0) {
    const avgTps = passing.reduce((sum, s) => sum + s.tokensPerSec, 0) / passing.length;
    const avgLat = passing.reduce((sum, s) => sum + s.latencyMs, 0) / passing.length;
    const sortedLat = passing.map(s => s.latencyMs).sort((a, b) => a - b);
    const p95Idx = Math.min(Math.ceil(sortedLat.length * 0.95) - 1, sortedLat.length - 1);

    await this.updateOne({ modelName }, {
      $set: {
        'capabilities.avgTokensPerSec': Number(avgTps.toFixed(2)),
        'capabilities.avgLatencyMs': Math.round(avgLat),
        'capabilities.p95LatencyMs': Math.round(sortedLat[p95Idx])
      }
    });
  }

  return this.findOne({ modelName });
};

ModelRegistrySchema.statics.summarizeHostPerformance = function(modelDoc) {
  const snapshots = Array.isArray(modelDoc?.hostPerformance) ? modelDoc.hostPerformance : [];
  const byHost = {};
  let latestAny = null;
  let latestPass = null;

  for (const snapshot of snapshots) {
    if (!latestAny) latestAny = snapshot;
    if (!latestPass && snapshot?.status === 'pass') latestPass = snapshot;

    const hostKey = snapshot?.hostUrl || snapshot?.hostId;
    if (!hostKey) continue;

    if (!byHost[hostKey]) {
      byHost[hostKey] = {
        latest: snapshot,
        latestPass: snapshot?.status === 'pass' ? snapshot : null
      };
      continue;
    }

    if (!byHost[hostKey].latestPass && snapshot?.status === 'pass') {
      byHost[hostKey].latestPass = snapshot;
    }
  }

  return { latestAny, latestPass, byHost };
};

ModelRegistrySchema.statics.getLatestHostPerformanceForModels = async function(modelNames = []) {
  if (!Array.isArray(modelNames) || modelNames.length === 0) {
    return {};
  }

  const models = await this.find(
    { modelName: { $in: modelNames } },
    { modelName: 1, hostPerformance: 1 }
  ).lean();

  return models.reduce((acc, modelDoc) => {
    acc[modelDoc.modelName] = this.summarizeHostPerformance(modelDoc);
    return acc;
  }, {});
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

  // Fix: Use correct percentile calculation (nearest rank method)
  // For array of length N, P95 index = ceil(0.95 * N) - 1
  // This ensures we get the 95th percentile, not the 96th
  const p95Index = latencies.length > 0
    ? Math.min(Math.ceil(latencies.length * 0.95) - 1, latencies.length - 1)
    : 0;
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
  const alignedCategory = TASK_CATEGORY_MAP[taskType];
  if (alignedCategory && this.categories.includes(alignedCategory)) {
    return true;
  }

  // Default: generalists can handle most tasks
  return this.categories.includes('generalist');
};

/**
 * Get effective execution config merging defaults → overrides
 * Returns object with { value, source } for each config key
 */
ModelRegistrySchema.methods.getEffectiveConfig = function() {
  const SYSTEM_DEFAULTS = { num_ctx: 8192, temperature: 0.7 };
  const defaults = this.executionDefaults || {};
  const overrides = this.executionOverrides || {};
  const contextTest = this.contextTest || {};

  const result = {};
  for (const key of ['num_ctx', 'temperature']) {
    if (overrides[key] != null) {
      result[key] = { value: overrides[key], source: 'user' };
    } else if (key === 'num_ctx' && contextTest.testedNumCtx != null && contextTest.status === 'completed') {
      result[key] = { value: contextTest.testedNumCtx, source: 'tested' };
    } else if (defaults[key] != null) {
      result[key] = { value: defaults[key], source: defaults._source || 'auto' };
    } else {
      result[key] = { value: SYSTEM_DEFAULTS[key], source: 'system' };
    }
  }
  result._reason = defaults._reason || null;
  return result;
};

module.exports = mongoose.model('ModelRegistry', ModelRegistrySchema);
