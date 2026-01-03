/**
 * MetricsHourly
 * -------------
 * Stores pre-aggregated hourly metrics derived from MetricsSnapshot documents.
 * These rollups enable fast dashboard queries for long time ranges (e.g., 30+
 * days) without scanning every raw snapshot.
 */

const mongoose = require('mongoose');

const MetricsHourlySchema = new mongoose.Schema({
  // Hour bucket (truncated to the hour, e.g., 2024-05-01T13:00:00Z)
  hour: { type: Date, required: true },

  // Component identifier (e.g., "ollama-99", "agentx-main")
  componentId: { type: String, required: true },

  // Aggregated metrics for the hour bucket
  aggregates: {
    avgResponseTime: Number,
    totalRequests: Number,
    totalCost: Number,
    errorRate: Number
  }
}, {
  versionKey: false,
  collection: 'metricshourlies'
});

// Sort newest-first for dashboards; also supports component-level lookups.
MetricsHourlySchema.index({ hour: -1, componentId: 1 });

/**
 * Round a Date to the top of the hour (UTC) to ensure consistent buckets.
 * Useful for aggregation pipelines that emit hourly rollups.
 */
MetricsHourlySchema.statics.normalizeHour = function(date) {
  const target = new Date(date);
  target.setUTCMinutes(0, 0, 0);
  return target;
};

/**
 * Upsert a rollup document for a specific component/hour bucket.
 * This allows schedulers to re-run hourly aggregations without duplicating
 * records when data is reprocessed.
 * @param {Object} payload - hour, componentId, aggregates
 * @returns {Promise<Document>}
 */
MetricsHourlySchema.statics.upsertRollup = async function(payload) {
  if (!payload || !payload.hour || !payload.componentId) {
    throw new Error('hour and componentId are required for upsertRollup');
  }

  const hourBucket = this.normalizeHour(payload.hour);
  const selector = { hour: hourBucket, componentId: payload.componentId };

  return this.findOneAndUpdate(
    selector,
    { ...payload, hour: hourBucket },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model('MetricsHourly', MetricsHourlySchema);
