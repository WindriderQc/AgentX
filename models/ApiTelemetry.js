const mongoose = require('mongoose');

const ApiTelemetrySchema = new mongoose.Schema({
  endpoint: { type: String, required: true, index: true },
  method: {
    type: String,
    enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    required: true
  },

  metrics: {
    hitCount: { type: Number, default: 0 },
    totalDuration: { type: Number, default: 0 },  // Sum in milliseconds
    avgLatency: { type: Number, default: 0 },      // Calculated average
    minLatency: { type: Number, default: Infinity },
    maxLatency: { type: Number, default: 0 },
    p50Latency: Number,  // Median
    p95Latency: Number,  // 95th percentile
    p99Latency: Number,  // 99th percentile
    errorCount: { type: Number, default: 0 },
    lastCalled: Date
  },

  timestamp: { type: Date, default: Date.now },
  period: {
    type: String,
    enum: ['real-time', 'hourly', 'daily', 'weekly'],
    default: 'hourly'
  }
});

// Compound index for time-series queries
ApiTelemetrySchema.index({ endpoint: 1, timestamp: -1 });
ApiTelemetrySchema.index({ period: 1, timestamp: -1 });

// Helper methods

/**
 * Upsert telemetry record for current hour
 */
ApiTelemetrySchema.statics.recordCall = async function(endpoint, method, duration, statusCode) {
  const now = new Date();
  // Round down to current hour for aggregation
  const bucketTime = new Date(now.setMinutes(0, 0, 0));
  
  const query = {
    endpoint,
    method,
    period: 'hourly',
    timestamp: bucketTime
  };

  const isError = statusCode >= 400;

  // We optimize for write speed and simple aggregation.
  // Note: avgLatency usually needs to be calculated from hitCount and totalDuration, 
  // but doing it atomically in one update is tricky without pipelines.
  // For simplicity here, we update counts and we can calc avg on read or use a pipeline update.
  // Using findOneAndUpdate with pipeline (MongoDB 4.2+) allows calculating fields.
  
  // However, simpler is often better for Mongoose helpers unless we know version.
  // I will use $inc for accumulating values, and $min/$max. 
  // avgLatency will be calculated/approximated or we can leave it for a separate aggregation step.
  // But spec defines it as a field. Let's try to update it if possible, or leave it to be computed.
  // Storing avgLatency in the doc means we should update it.
  
  // Ideally, we fetch, update in memory, and save. But that's not atomic.
  // Atomic update:
  const update = {
    $inc: {
      'metrics.hitCount': 1,
      'metrics.totalDuration': duration,
      'metrics.errorCount': isError ? 1 : 0
    },
    $min: { 'metrics.minLatency': duration },
    $max: { 'metrics.maxLatency': duration },
    $set: { 'metrics.lastCalled': new Date() }
  };

  const doc = await this.findOneAndUpdate(query, update, { 
    upsert: true, 
    new: true, 
    setDefaultsOnInsert: true 
  });

  // Calculate Average after update - this is eventual consistency but fine for telemetry
  // Or use a second update to set average. 
  if (doc) {
    doc.metrics.avgLatency = doc.metrics.totalDuration / doc.metrics.hitCount;
    await doc.save();
  }
  
  return doc;
};

/**
 * Returns: [...endpoints sorted by metric]
 */
ApiTelemetrySchema.statics.getTopEndpoints = async function(limit = 10, sortBy = 'hitCount') {
  const sort = {};
  sort[`metrics.${sortBy}`] = -1;
  
  return this.aggregate([
    // Group by endpoint across periods if we strictly want top endpoints overall, 
    // or just return the hourly buckets? 
    // "Top Endpoints" usually implies aggregation over a timeframe or recent activity.
    // Let's assume we want to aggregate all time stats for the endpoints.
    {
      $group: {
        _id: "$endpoint",
        hitCount: { $sum: "$metrics.hitCount" },
        errorCount: { $sum: "$metrics.errorCount" },
        avgLatency: { $avg: "$metrics.avgLatency" }
      }
    },
    { $sort: { [sortBy]: -1 } },
    { $limit: limit }
  ]);
};

/**
 * Returns: Endpoints with 0 hits in period
 * Note: Telemetry only stores hits. If an endpoint isn't hit, it might not be in the DB.
 * This method likely implies checking against a known list of endpoints or finding those 
 * that haven't been hit RECENTLY (sinceDays).
 */
ApiTelemetrySchema.statics.getUnusedEndpoints = async function(sinceDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - sinceDays);

  return this.aggregate([
    {
      $group: {
        _id: "$endpoint",
        lastCalled: { $max: "$metrics.lastCalled" }
      }
    },
    {
      $match: {
        lastCalled: { $lt: cutoff }
      }
    },
    {
      $project: {
        endpoint: "$_id", 
        lastCalled: 1, 
        _id: 0
      }
    }
  ]);
};

module.exports = mongoose.model('ApiTelemetry', ApiTelemetrySchema);
