const MetricsSnapshot = require('../../models/MetricsSnapshot');
const logger = require('../../config/logger');

const METRIC_TYPES = new Set(['health', 'performance', 'cost', 'resource', 'quality', 'usage']);

class MetricsCollector {
  constructor() {
    if (MetricsCollector.instance) {
      return MetricsCollector.instance;
    }

    this.testMode = process.env.NODE_ENV === 'test';

    this.buffer = [];
    this.maxBufferSize = parseInt(process.env.METRICS_BUFFER_SIZE || '50', 10);
    this.flushIntervalMs = parseInt(process.env.METRICS_FLUSH_INTERVAL_MS || '5000', 10);

    this.flushTimer = null;
    if (!this.testMode) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => logger.error('Metrics buffer flush failed', { error: err.message }));
      }, this.flushIntervalMs);

      if (typeof this.flushTimer.unref === 'function') {
        this.flushTimer.unref();
      }
    }

    MetricsCollector.instance = this;
  }

  async record(type, componentId, value, meta = {}) {
    if (!METRIC_TYPES.has(type)) {
      throw new Error(`Invalid metric type: ${type}`);
    }
    if (!componentId) {
      throw new Error('componentId is required');
    }
    if (!Number.isFinite(value)) {
      throw new Error('value must be a finite number');
    }

    const { timestamp, ...metadata } = meta || {};
    const metric = new MetricsSnapshot({
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      type,
      componentId,
      value,
      metadata
    });

    if (this.testMode) {
      await metric.save();
      return metric;
    }

    this.buffer.push(metric);

    if (this.buffer.length >= this.maxBufferSize) {
      await this.flush();
    }

    return metric;
  }

  async query(filter = {}, range = {}) {
    const query = {};

    if (filter.type) query.type = filter.type;
    if (filter.componentId) query.componentId = filter.componentId;
    if (filter.metadata && typeof filter.metadata === 'object') {
      Object.entries(filter.metadata).forEach(([key, value]) => {
        query[`metadata.${key}`] = value;
      });
    }

    if (range.from || range.to) {
      query.timestamp = {};
      if (range.from) query.timestamp.$gte = new Date(range.from);
      if (range.to) query.timestamp.$lte = new Date(range.to);
    }

    const results = await MetricsSnapshot.find(query).sort({ timestamp: 1 }).lean();
    return { results, count: results.length };
  }

  async aggregate(period) {
    const windowMs = this._parsePeriod(period);
    if (!windowMs) {
      throw new Error('Invalid aggregation period');
    }

    const since = new Date(Date.now() - windowMs);
    const pipeline = [
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: { componentId: '$componentId', type: '$type' },
          avg: { $avg: '$value' },
          min: { $min: '$value' },
          max: { $max: '$value' },
          count: { $sum: 1 },
          latestTimestamp: { $max: '$timestamp' }
        }
      },
      {
        $project: {
          _id: 0,
          componentId: '$_id.componentId',
          type: '$_id.type',
          average: '$avg',
          min: '$min',
          max: '$max',
          count: 1,
          latestTimestamp: 1
        }
      },
      { $sort: { componentId: 1, type: 1 } }
    ];

    return MetricsSnapshot.aggregate(pipeline);
  }

  async getLatest(componentId, type = null) {
    if (!componentId) return null;

    const query = MetricsSnapshot.getLatest(componentId, type);
    if (!query) return null;

    return typeof query.lean === 'function' ? query.lean() : query;
  }

  async flush() {
    if (this.testMode) {
      return { inserted: 0 };
    }

    if (!this.buffer.length) {
      return { inserted: 0 };
    }

    const docs = this.buffer.splice(0, this.buffer.length);
    const payloads = docs.map((doc) => doc.toObject({ depopulate: true }));

    const insertedDocs = await MetricsSnapshot.insertMany(payloads, { ordered: false });
    const inserted = Array.isArray(insertedDocs) ? insertedDocs.length : 0;

    logger.debug('Flushed metrics buffer', { count: inserted });
    return { inserted };
  }

  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  _parsePeriod(period) {
    if (!period || typeof period !== 'string') return null;

    const match = period.match(/^(\d+)([smhd])$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    if (!Number.isFinite(value) || value <= 0) return null;

    switch (unit) {
      case 's':
        return value * 1000;
      case 'm':
        return value * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      default:
        return null;
    }
  }
}

module.exports = new MetricsCollector();
