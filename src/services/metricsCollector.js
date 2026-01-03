const MetricsSnapshot = require('../../models/MetricsSnapshot');
const logger = require('../../config/logger');

/**
 * MetricsCollector Service - Track 2: Historical Metrics & Analytics
 * 
 * Centralized service for collecting, storing, and querying time-series metrics
 * Supports health, performance, cost, and resource tracking with aggregation
 * 
 * Features:
 * - Multi-type metric recording (health, performance, cost, resource, quality, usage)
 * - Time-series queries with flexible granularity
 * - Trend analysis (period-over-period comparison)
 * - Automated aggregation and rollup
 * - Data retention management
 */
class MetricsCollector {
  constructor() {
    if (MetricsCollector.instance) {
      return MetricsCollector.instance;
    }

    this.config = {
      retentionDays: parseInt(process.env.METRICS_RETENTION_DAYS || '90'),
      aggregationIntervalMs: parseInt(process.env.METRICS_AGGREGATION_INTERVAL_MS || '3600000'), // 1 hour
      batchSize: parseInt(process.env.METRICS_BATCH_SIZE || '1000'),
      enableAutoAggregation: process.env.METRICS_AUTO_AGGREGATION !== 'false'
    };

    this.aggregationJob = null;

    MetricsCollector.instance = this;
    logger.info('MetricsCollector initialized', this.config);

    // Start auto-aggregation if enabled
    if (this.config.enableAutoAggregation) {
      this.startAggregationJob();
    }
  }

  /**
   * Record a health metric
   * @param {string} componentType - Type of component (agentx, ollama, etc.)
   * @param {string} componentId - Unique component identifier
   * @param {Object} healthData - Health data
   */
  async recordHealthMetric(componentType, componentId, healthData) {
    try {
      const metric = new MetricsSnapshot({
        componentType,
        componentId,
        metricType: 'health',
        metricName: 'health_status',
        value: healthData.status || 'unknown',
        health: {
          status: healthData.status || 'unknown',
          uptime: healthData.uptime,
          lastError: healthData.lastError,
          errorCount: healthData.errorCount || 0,
          checks: healthData.checks || {}
        },
        source: healthData.source || 'agentx',
        tags: healthData.tags || [],
        metadata: healthData.metadata || {},
        expiresAt: this._calculateExpiry('raw')
      });

      await metric.save();
      logger.debug('Health metric recorded', { componentType, componentId, status: healthData.status });
      
      return metric;
    } catch (error) {
      logger.error('Failed to record health metric', { 
        componentType, 
        componentId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Record a performance metric
   * @param {string} componentType - Type of component
   * @param {string} componentId - Unique component identifier
   * @param {Object} perfData - Performance data
   */
  async recordPerformanceMetric(componentType, componentId, perfData) {
    try {
      const metric = new MetricsSnapshot({
        componentType,
        componentId,
        metricType: 'performance',
        metricName: perfData.metricName || 'response_time',
        value: perfData.value,
        unit: perfData.unit || 'ms',
        performance: {
          responseTime: perfData.responseTime,
          throughput: perfData.throughput,
          latency: perfData.latency || {},
          requestRate: perfData.requestRate,
          errorRate: perfData.errorRate,
          concurrency: perfData.concurrency
        },
        source: perfData.source || 'agentx',
        tags: perfData.tags || [],
        metadata: perfData.metadata || {},
        expiresAt: this._calculateExpiry('raw')
      });

      await metric.save();
      logger.debug('Performance metric recorded', { 
        componentType, 
        componentId, 
        metricName: perfData.metricName,
        value: perfData.value 
      });
      
      return metric;
    } catch (error) {
      logger.error('Failed to record performance metric', { 
        componentType, 
        componentId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Record a cost metric
   * @param {string} model - Model name
   * @param {Object} costData - Cost data
   */
  async recordCostMetric(model, costData) {
    try {
      const metric = new MetricsSnapshot({
        componentType: 'ollama',
        componentId: costData.componentId || model,
        metricType: 'cost',
        metricName: 'model_cost',
        value: costData.amount,
        unit: costData.currency || 'USD',
        cost: {
          amount: costData.amount,
          currency: costData.currency || 'USD',
          model: model,
          provider: costData.provider || 'ollama',
          breakdown: costData.breakdown || {}
        },
        source: costData.source || 'agentx',
        tags: costData.tags || ['cost', model],
        metadata: costData.metadata || {},
        expiresAt: this._calculateExpiry('raw')
      });

      await metric.save();
      logger.debug('Cost metric recorded', { model, amount: costData.amount });
      
      return metric;
    } catch (error) {
      logger.error('Failed to record cost metric', { 
        model, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Record a resource metric
   * @param {string} componentId - Component identifier
   * @param {Object} resourceData - Resource data
   */
  async recordResourceMetric(componentId, resourceData) {
    try {
      const metric = new MetricsSnapshot({
        componentType: resourceData.componentType || 'system',
        componentId,
        metricType: 'resource',
        metricName: resourceData.metricName || 'resource_usage',
        value: resourceData.value,
        unit: resourceData.unit || '%',
        resource: {
          cpu: resourceData.cpu || {},
          memory: resourceData.memory || {},
          disk: resourceData.disk || {},
          network: resourceData.network || {}
        },
        source: resourceData.source || 'agentx',
        tags: resourceData.tags || [],
        metadata: resourceData.metadata || {},
        expiresAt: this._calculateExpiry('raw')
      });

      await metric.save();
      logger.debug('Resource metric recorded', { 
        componentId, 
        metricName: resourceData.metricName 
      });
      
      return metric;
    } catch (error) {
      logger.error('Failed to record resource metric', { 
        componentId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Record a quality metric
   * @param {string} componentId - Component identifier
   * @param {Object} qualityData - Quality data
   */
  async recordQualityMetric(componentId, qualityData) {
    try {
      const metric = new MetricsSnapshot({
        componentType: qualityData.componentType || 'agentx',
        componentId,
        metricType: 'quality',
        metricName: 'quality_score',
        value: qualityData.score,
        quality: {
          score: qualityData.score,
          positiveRate: qualityData.positiveRate,
          negativeRate: qualityData.negativeRate,
          averageRating: qualityData.averageRating,
          feedbackCount: qualityData.feedbackCount
        },
        source: qualityData.source || 'agentx',
        tags: qualityData.tags || [],
        metadata: qualityData.metadata || {},
        expiresAt: this._calculateExpiry('raw')
      });

      await metric.save();
      logger.debug('Quality metric recorded', { 
        componentId, 
        score: qualityData.score 
      });
      
      return metric;
    } catch (error) {
      logger.error('Failed to record quality metric', { 
        componentId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Record a usage metric
   * @param {string} componentId - Component identifier
   * @param {Object} usageData - Usage data
   */
  async recordUsageMetric(componentId, usageData) {
    try {
      const metric = new MetricsSnapshot({
        componentType: usageData.componentType || 'agentx',
        componentId,
        metricType: 'usage',
        metricName: usageData.metricName || 'usage_count',
        value: usageData.value,
        usage: {
          requestCount: usageData.requestCount,
          userCount: usageData.userCount,
          conversationCount: usageData.conversationCount,
          tokenCount: usageData.tokenCount
        },
        source: usageData.source || 'agentx',
        tags: usageData.tags || [],
        metadata: usageData.metadata || {},
        expiresAt: this._calculateExpiry('raw')
      });

      await metric.save();
      logger.debug('Usage metric recorded', { 
        componentId, 
        metricName: usageData.metricName,
        value: usageData.value 
      });
      
      return metric;
    } catch (error) {
      logger.error('Failed to record usage metric', { 
        componentId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Get time series data for a specific metric
   * @param {string} componentId - Component identifier
   * @param {string} metricName - Metric name
   * @param {Date|string} from - Start time
   * @param {Date|string} to - End time
   * @param {string} granularity - Time granularity (raw, 5m, 15m, 1h, etc.)
   */
  async getTimeSeries(componentId, metricName, from, to, granularity = 'raw') {
    try {
      const series = await MetricsSnapshot.getTimeSeries({
        componentId,
        metricName,
        from,
        to,
        granularity
      });

      logger.debug('Time series retrieved', { 
        componentId, 
        metricName, 
        dataPoints: series.length 
      });

      return series;
    } catch (error) {
      logger.error('Failed to get time series', { 
        componentId, 
        metricName, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Get trends for a metric (period-over-period comparison)
   * @param {string} componentId - Component identifier
   * @param {string} metricName - Metric name
   * @param {string} period - Time period (1h, 24h, 7d, 30d)
   */
  async getTrends(componentId, metricName, period = '24h') {
    try {
      const trends = await MetricsSnapshot.getTrends({
        componentId,
        metricName,
        period
      });

      logger.debug('Trends retrieved', { 
        componentId, 
        metricName, 
        period,
        trend: trends.trend 
      });

      return trends;
    } catch (error) {
      logger.error('Failed to get trends', { 
        componentId, 
        metricName, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Aggregate metrics into hourly rollups
   */
  async aggregateHourly() {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      // Get distinct component/metric combinations
      const combinations = await MetricsSnapshot.distinct('componentId', {
        granularity: 'raw',
        createdAt: { $gte: twoHoursAgo, $lt: oneHourAgo }
      });

      let aggregatedCount = 0;

      for (const componentId of combinations) {
        const metricNames = await MetricsSnapshot.distinct('metricName', {
          componentId,
          granularity: 'raw',
          createdAt: { $gte: twoHoursAgo, $lt: oneHourAgo }
        });

        for (const metricName of metricNames) {
          const aggregated = await MetricsSnapshot.aggregateMetrics({
            componentId,
            metricName,
            from: twoHoursAgo,
            to: oneHourAgo,
            groupBy: '1h',
            aggregation: 'avg'
          });

          // Save aggregated metrics
          for (const agg of aggregated) {
            const existingAgg = await MetricsSnapshot.findOne({
              componentId,
              metricName,
              granularity: '1h',
              createdAt: agg.timestamp
            });

            if (!existingAgg) {
              const rawMetric = await MetricsSnapshot.findOne({ componentId, metricName });
              
              const aggregatedMetric = new MetricsSnapshot({
                componentType: rawMetric?.componentType || 'agentx',
                componentId,
                metricType: rawMetric?.metricType || 'performance',
                metricName,
                value: agg.value,
                granularity: '1h',
                aggregation: {
                  method: 'avg',
                  sampleCount: agg.count,
                  statistics: {
                    mean: agg.value,
                    min: agg.min,
                    max: agg.max
                  }
                },
                createdAt: agg.timestamp,
                expiresAt: this._calculateExpiry('1h')
              });

              await aggregatedMetric.save();
              aggregatedCount++;
            }
          }
        }
      }

      logger.info('Hourly aggregation completed', { 
        aggregatedCount,
        timeRange: `${twoHoursAgo.toISOString()} to ${oneHourAgo.toISOString()}`
      });

      return { aggregatedCount };
    } catch (error) {
      logger.error('Hourly aggregation failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Purge old metrics based on retention policy
   * @param {number} retentionDays - Number of days to retain
   */
  async purgeOldMetrics(retentionDays = null) {
    try {
      const days = retentionDays || this.config.retentionDays;
      const result = await MetricsSnapshot.purgeOldMetrics(days);

      logger.info('Old metrics purged', result);

      return result;
    } catch (error) {
      logger.error('Failed to purge old metrics', { error: error.message });
      throw error;
    }
  }

  /**
   * Get latest value for a specific metric
   * @param {string} componentId - Component identifier
   * @param {string} metricName - Metric name
   */
  async getLatestMetric(componentId, metricName) {
    try {
      return await MetricsSnapshot.getLatest(componentId, metricName);
    } catch (error) {
      logger.error('Failed to get latest metric', { 
        componentId, 
        metricName, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Get metrics statistics
   * @param {Object} filters - Filter criteria
   */
  async getStatistics(filters = {}) {
    try {
      const stats = await MetricsSnapshot.aggregate([
        {
          $match: this._buildMatchQuery(filters)
        },
        {
          $group: {
            _id: {
              componentType: '$componentType',
              metricType: '$metricType'
            },
            count: { $sum: 1 },
            avgValue: { $avg: '$value' },
            minValue: { $min: '$value' },
            maxValue: { $max: '$value' }
          }
        }
      ]);

      return stats;
    } catch (error) {
      logger.error('Failed to get statistics', { error: error.message });
      throw error;
    }
  }

  /**
   * Start automated aggregation job
   */
  startAggregationJob() {
    if (this.aggregationJob) {
      logger.warn('Aggregation job already running');
      return;
    }

    logger.info('Starting aggregation job', { 
      intervalMs: this.config.aggregationIntervalMs 
    });

    this.aggregationJob = setInterval(async () => {
      try {
        await this.aggregateHourly();
      } catch (error) {
        logger.error('Aggregation job error', { error: error.message });
      }
    }, this.config.aggregationIntervalMs);
  }

  /**
   * Stop automated aggregation job
   */
  stopAggregationJob() {
    if (this.aggregationJob) {
      clearInterval(this.aggregationJob);
      this.aggregationJob = null;
      logger.info('Aggregation job stopped');
    }
  }

  /**
   * Calculate expiry date based on granularity
   * @private
   */
  _calculateExpiry(granularity) {
    const retentionMap = {
      'raw': 7,      // 7 days for raw data
      '5m': 30,      // 30 days for 5-minute aggregates
      '15m': 60,     // 60 days for 15-minute aggregates
      '1h': 90,      // 90 days for hourly aggregates
      '6h': 180,     // 180 days for 6-hour aggregates
      '1d': 365,     // 365 days for daily aggregates
      '7d': 730,     // 2 years for weekly aggregates
      '30d': 1825    // 5 years for monthly aggregates
    };

    const days = retentionMap[granularity] || 90;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  /**
   * Build MongoDB match query from filters
   * @private
   */
  _buildMatchQuery(filters) {
    const match = {};

    if (filters.componentType) match.componentType = filters.componentType;
    if (filters.componentId) match.componentId = filters.componentId;
    if (filters.metricType) match.metricType = filters.metricType;
    if (filters.metricName) match.metricName = filters.metricName;
    if (filters.granularity) match.granularity = filters.granularity;
    
    if (filters.from || filters.to) {
      match.createdAt = {};
      if (filters.from) match.createdAt.$gte = new Date(filters.from);
      if (filters.to) match.createdAt.$lte = new Date(filters.to);
    }

    return match;
  }
}

// Export singleton instance
module.exports = new MetricsCollector();
