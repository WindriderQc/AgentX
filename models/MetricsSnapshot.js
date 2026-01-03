/**
 * MetricsSnapshot
 * ----------------
 * Stores fine-grained metrics emitted by AgentX components (and external systems)
 * at 5-10 minute intervals. The schema is optimized for MongoDB time-series
 * collections to support efficient storage and range queries over long periods
 * (e.g., 30-90 days).
 *
 * Design considerations:
 * - `timestamp` is the required time-series key.
 * - `metadata` acts as the metaField for coarse grouping and bucketing.
 * - Sub-documents (health, performance, cost, resources, model) are kept
 *   optional so producers can incrementally roll out metrics without schema
 *   updates.
 * - Indexes are added to accelerate common dashboard queries (by componentType
 *   or componentId, sorted by timestamp).
 */

const mongoose = require('mongoose');

const VALID_SOURCES = ['health_check', 'analytics_job', 'chat_completion', 'workflow_execution'];
const VALID_COMPONENT_TYPES = ['ollama', 'agentx', 'dataapi', 'qdrant', 'n8n', 'mongodb'];
const VALID_HEALTH_STATES = ['healthy', 'degraded', 'down'];

// Shared number field helper to avoid NaN/undefined issues when writing data
const NumberField = {
  type: Number,
  validate: {
    validator: (value) => value === undefined || value === null || Number.isFinite(value),
    message: 'Numeric metric fields must be finite numbers or undefined'
  }
};

const MetricsSnapshotSchema = new mongoose.Schema({
  /**
   * Time-series key. Required by MongoDB to bucket documents efficiently.
   * We expect producers to truncate to the desired interval (5-10 min) before
   * sending, but the DB will still accept arbitrary timestamps.
   */
  timestamp: { type: Date, required: true },

  /**
   * Metadata for bucketing and routing.
   * - source: originating workflow or trigger
   * - componentType: AgentX subsystem or external dependency
   * - componentId: concrete identifier (e.g., "ollama-99", "agentx-main")
   */
  metadata: {
    source: {
      type: String,
      enum: VALID_SOURCES,
      required: true
    },
    componentType: {
      type: String,
      enum: VALID_COMPONENT_TYPES,
      required: true
    },
    componentId: { type: String, required: true }
  },

  /**
   * Health metrics capture uptime and reliability signals.
   */
  health: {
    status: { type: String, enum: VALID_HEALTH_STATES },
    responseTime: NumberField, // milliseconds
    errorRate: NumberField // 0.0 - 1.0
  },

  /**
   * Performance metrics track throughput and latency for requests.
   */
  performance: {
    requestCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    avgDuration: NumberField, // ms
    p50Duration: NumberField,
    p95Duration: NumberField,
    p99Duration: NumberField
  },

  /**
   * Cost metrics capture LLM/token consumption and currency details.
   */
  cost: {
    totalCost: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' }
  },

  /**
   * Resource utilization for infra-level monitoring (CPU, memory, disk).
   */
  resources: {
    cpuPercent: NumberField,
    memoryMB: NumberField,
    diskUsagePercent: NumberField
  },

  /**
   * Model-specific metrics (primarily for Ollama-hosted models).
   */
  model: {
    modelName: { type: String },
    tokenThroughput: NumberField, // tokens/sec
    activeRequests: NumberField
  }
}, {
  timeseries: {
    timeField: 'timestamp',
    metaField: 'metadata',
    granularity: 'minutes' // MongoDB will auto-bucket by minute
  },
  expireAfterSeconds: 7776000, // 90 days retention
  // Avoid __v for leaner storage
  versionKey: false,
  // Be explicit about the collection name to align with time-series creation
  collection: 'metricssnapshots'
});

/**
 * Indexes
 * MongoDB auto-creates some time-series indexes, but we add explicit ones to
 * support dashboard queries that filter by componentType or componentId and
 * sort by time.
 */
MetricsSnapshotSchema.index({ timestamp: 1, 'metadata.componentType': 1 });
MetricsSnapshotSchema.index({ timestamp: 1, 'metadata.componentId': 1 });
MetricsSnapshotSchema.index({ timestamp: -1 });

/**
 * Helper: ensure timestamps are stored as Date objects (not strings) to avoid
 * query mismatches when producers send ISO strings.
 */
MetricsSnapshotSchema.pre('validate', function normalizeTimestamp() {
  if (this.timestamp && !(this.timestamp instanceof Date)) {
    this.timestamp = new Date(this.timestamp);
  }
});

/**
 * Helper: clamp errorRate to a valid range [0,1] if supplied. This prevents
 * out-of-bound values from polluting charts.
 */
MetricsSnapshotSchema.pre('save', function clampErrorRate() {
  if (this.health && typeof this.health.errorRate === 'number') {
    this.health.errorRate = Math.min(Math.max(this.health.errorRate, 0), 1);
  }
});

/**
 * Static: return time-series data for Chart.js-compatible datasets.
 * @param {string} componentId - component identifier
 * @param {string} metric - dot-notation path (e.g., 'health.responseTime')
 * @param {Date|string|number} from - inclusive lower bound
 * @param {Date|string|number} to - inclusive upper bound
 * @returns {Promise<Array<{ x: Date, y: number | null }>>}
 */
MetricsSnapshotSchema.statics.getTimeSeries = async function(componentId, metric, from, to) {
  const pipeline = [
    {
      $match: {
        'metadata.componentId': componentId,
        timestamp: { $gte: new Date(from), $lte: new Date(to) }
      }
    },
    {
      $project: {
        timestamp: 1,
        value: `$${metric}` // e.g., "$health.responseTime"
      }
    },
    { $sort: { timestamp: 1 } }
  ];

  const results = await this.aggregate(pipeline);
  return results.map((r) => ({ x: r.timestamp, y: r.value }));
};

/**
 * Static: fetch the most recent snapshot for a given component.
 * @param {string} componentId
 * @returns {Promise<Document|null>}
 */
MetricsSnapshotSchema.statics.getLatest = async function(componentId) {
  return this.findOne({ 'metadata.componentId': componentId })
    .sort({ timestamp: -1 });
};

/**
 * Static: convenience method to upsert a snapshot for idempotent workflows.
 * When n8n retries the same window, we overwrite the existing document for the
 * exact timestamp + component combo to avoid duplicates in charts.
 */
MetricsSnapshotSchema.statics.upsertSnapshot = async function(payload) {
  if (!payload || !payload.metadata || !payload.metadata.componentId || !payload.timestamp) {
    throw new Error('metadata.componentId and timestamp are required for upsertSnapshot');
  }

  const selector = {
    'metadata.componentId': payload.metadata.componentId,
    timestamp: new Date(payload.timestamp)
  };

  return this.findOneAndUpdate(selector, payload, { upsert: true, new: true, setDefaultsOnInsert: true });
};

module.exports = mongoose.model('MetricsSnapshot', MetricsSnapshotSchema);
