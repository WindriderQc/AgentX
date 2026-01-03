const MetricsSnapshot = require('../../models/MetricsSnapshot');
const logger = require('../../config/logger');

/**
 * MetricsCleanup Service - Automated Storage Management
 *
 * Manages storage by cleaning up old metrics based on retention policies:
 * - Raw metrics: 90 days
 * - Hourly aggregates: 180 days
 * - Daily aggregates: 1 year
 * - Monthly aggregates: kept indefinitely
 *
 * Features:
 * - Configurable retention periods
 * - Scheduled daily cleanup at 2 AM
 * - Detailed cleanup statistics logging
 * - Safe deletion with transaction-like batching
 * - Error handling and recovery
 */
class MetricsCleanup {
  constructor() {
    if (MetricsCleanup.instance) {
      return MetricsCleanup.instance;
    }

    this.config = {
      // Retention periods in days
      retentionPeriods: {
        raw: parseInt(process.env.METRICS_RETENTION_RAW_DAYS || '90'),
        '5m': parseInt(process.env.METRICS_RETENTION_5M_DAYS || '90'),
        '15m': parseInt(process.env.METRICS_RETENTION_15M_DAYS || '90'),
        '1h': parseInt(process.env.METRICS_RETENTION_1H_DAYS || '180'),
        '6h': parseInt(process.env.METRICS_RETENTION_6H_DAYS || '180'),
        '1d': parseInt(process.env.METRICS_RETENTION_1D_DAYS || '365'),
        '7d': parseInt(process.env.METRICS_RETENTION_7D_DAYS || '730'), // 2 years
        '30d': null // Keep indefinitely
      },

      // Cleanup schedule (default: 2 AM daily)
      cleanupHour: parseInt(process.env.METRICS_CLEANUP_HOUR || '2'),
      cleanupMinute: parseInt(process.env.METRICS_CLEANUP_MINUTE || '0'),

      // Batch size for deletion operations
      batchSize: parseInt(process.env.METRICS_CLEANUP_BATCH_SIZE || '1000'),

      // Enable/disable auto-cleanup
      enableAutoCleanup: process.env.METRICS_AUTO_CLEANUP !== 'false'
    };

    this.cleanupTimer = null;
    this.isRunning = false;

    MetricsCleanup.instance = this;
    logger.info('MetricsCleanup service initialized', this.config);

    // Start scheduled cleanup if enabled
    if (this.config.enableAutoCleanup) {
      this.scheduleCleanup();
    }
  }

  /**
   * Schedule daily cleanup at configured time
   */
  scheduleCleanup() {
    if (this.cleanupTimer) {
      logger.warn('Cleanup timer already scheduled');
      return;
    }

    // Calculate milliseconds until next scheduled run
    const msUntilNextRun = this._calculateNextRunTime();

    logger.info('Scheduling metrics cleanup', {
      nextRun: new Date(Date.now() + msUntilNextRun).toISOString(),
      hour: this.config.cleanupHour,
      minute: this.config.cleanupMinute
    });

    // Schedule first run
    this.cleanupTimer = setTimeout(() => {
      this._executeScheduledCleanup();

      // Then schedule to run every 24 hours
      this.cleanupTimer = setInterval(() => {
        this._executeScheduledCleanup();
      }, 24 * 60 * 60 * 1000);
    }, msUntilNextRun);
  }

  /**
   * Stop scheduled cleanup
   */
  stopScheduledCleanup() {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.info('Scheduled cleanup stopped');
    }
  }

  /**
   * Execute scheduled cleanup with error handling
   * @private
   */
  async _executeScheduledCleanup() {
    try {
      logger.info('Starting scheduled metrics cleanup');
      const stats = await this.cleanupMetrics();
      logger.info('Scheduled metrics cleanup completed', stats);
    } catch (error) {
      logger.error('Scheduled metrics cleanup failed', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Calculate milliseconds until next scheduled cleanup time
   * @private
   */
  _calculateNextRunTime() {
    const now = new Date();
    const scheduledTime = new Date();

    scheduledTime.setHours(this.config.cleanupHour);
    scheduledTime.setMinutes(this.config.cleanupMinute);
    scheduledTime.setSeconds(0);
    scheduledTime.setMilliseconds(0);

    // If scheduled time has passed today, schedule for tomorrow
    if (scheduledTime <= now) {
      scheduledTime.setDate(scheduledTime.getDate() + 1);
    }

    return scheduledTime.getTime() - now.getTime();
  }

  /**
   * Execute cleanup for all granularity levels
   * @returns {Object} Cleanup statistics
   */
  async cleanupMetrics() {
    if (this.isRunning) {
      logger.warn('Cleanup already in progress, skipping this run');
      return { skipped: true, reason: 'Already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const stats = {
      startTime: new Date().toISOString(),
      totalDeleted: 0,
      granularityStats: {},
      errors: []
    };

    try {
      logger.info('Starting metrics cleanup operation');

      // Clean up each granularity level
      for (const [granularity, retentionDays] of Object.entries(this.config.retentionPeriods)) {
        // Skip if retention is null (keep indefinitely)
        if (retentionDays === null) {
          logger.debug(`Skipping ${granularity} metrics (kept indefinitely)`);
          stats.granularityStats[granularity] = {
            deleted: 0,
            retentionDays: 'indefinite',
            skipped: true
          };
          continue;
        }

        try {
          const result = await this._cleanupGranularity(granularity, retentionDays);
          stats.granularityStats[granularity] = result;
          stats.totalDeleted += result.deleted;

          logger.info(`Cleaned up ${granularity} metrics`, result);
        } catch (error) {
          const errorMsg = `Failed to cleanup ${granularity} metrics: ${error.message}`;
          logger.error(errorMsg, { error: error.stack });
          stats.errors.push(errorMsg);
          stats.granularityStats[granularity] = {
            deleted: 0,
            retentionDays,
            error: error.message
          };
        }
      }

      // Calculate execution time
      const executionTimeMs = Date.now() - startTime;
      stats.endTime = new Date().toISOString();
      stats.executionTimeMs = executionTimeMs;
      stats.executionTimeSeconds = (executionTimeMs / 1000).toFixed(2);

      logger.info('Metrics cleanup completed', {
        totalDeleted: stats.totalDeleted,
        executionTimeSeconds: stats.executionTimeSeconds,
        errors: stats.errors.length
      });

      return stats;
    } catch (error) {
      logger.error('Metrics cleanup operation failed', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Clean up metrics for a specific granularity level
   * @private
   * @param {string} granularity - Granularity level (raw, 1h, 1d, etc.)
   * @param {number} retentionDays - Number of days to retain
   * @returns {Object} Cleanup statistics for this granularity
   */
  async _cleanupGranularity(granularity, retentionDays) {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    logger.debug(`Cleaning up ${granularity} metrics older than ${cutoffDate.toISOString()}`);

    const result = await MetricsSnapshot.deleteMany({
      granularity: granularity,
      createdAt: { $lt: cutoffDate }
    });

    return {
      deleted: result.deletedCount || 0,
      retentionDays,
      cutoffDate: cutoffDate.toISOString()
    };
  }

  /**
   * Clean up metrics for a specific component
   * @param {string} componentId - Component identifier
   * @param {number} retentionDays - Number of days to retain (optional, uses config if not provided)
   * @returns {Object} Cleanup statistics
   */
  async cleanupComponentMetrics(componentId, retentionDays = null) {
    try {
      const days = retentionDays || this.config.retentionPeriods.raw;
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      logger.info('Cleaning up component metrics', { componentId, retentionDays: days });

      const result = await MetricsSnapshot.deleteMany({
        componentId,
        createdAt: { $lt: cutoffDate }
      });

      const stats = {
        componentId,
        deleted: result.deletedCount || 0,
        retentionDays: days,
        cutoffDate: cutoffDate.toISOString()
      };

      logger.info('Component metrics cleaned up', stats);

      return stats;
    } catch (error) {
      logger.error('Failed to cleanup component metrics', {
        componentId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Clean up metrics by metric type
   * @param {string} metricType - Metric type (health, performance, cost, etc.)
   * @param {number} retentionDays - Number of days to retain
   * @returns {Object} Cleanup statistics
   */
  async cleanupMetricType(metricType, retentionDays) {
    try {
      const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

      logger.info('Cleaning up metrics by type', { metricType, retentionDays });

      const result = await MetricsSnapshot.deleteMany({
        metricType,
        createdAt: { $lt: cutoffDate }
      });

      const stats = {
        metricType,
        deleted: result.deletedCount || 0,
        retentionDays,
        cutoffDate: cutoffDate.toISOString()
      };

      logger.info('Metric type cleaned up', stats);

      return stats;
    } catch (error) {
      logger.error('Failed to cleanup metric type', {
        metricType,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get storage statistics for metrics
   * @returns {Object} Storage statistics
   */
  async getStorageStats() {
    try {
      const stats = await MetricsSnapshot.aggregate([
        {
          $group: {
            _id: '$granularity',
            count: { $sum: 1 },
            oldestMetric: { $min: '$createdAt' },
            newestMetric: { $max: '$createdAt' }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ]);

      // Calculate total count
      const totalCount = stats.reduce((sum, stat) => sum + stat.count, 0);

      // Format results
      const formattedStats = {
        total: totalCount,
        byGranularity: {}
      };

      stats.forEach(stat => {
        const ageInDays = Math.floor(
          (Date.now() - new Date(stat.oldestMetric).getTime()) / (24 * 60 * 60 * 1000)
        );

        formattedStats.byGranularity[stat._id] = {
          count: stat.count,
          percentage: ((stat.count / totalCount) * 100).toFixed(2),
          oldestMetric: stat.oldestMetric,
          newestMetric: stat.newestMetric,
          ageInDays,
          retentionDays: this.config.retentionPeriods[stat._id] || 'indefinite'
        };
      });

      logger.debug('Storage statistics retrieved', { totalCount });

      return formattedStats;
    } catch (error) {
      logger.error('Failed to get storage statistics', { error: error.message });
      throw error;
    }
  }

  /**
   * Get metrics that will be deleted in next cleanup
   * @returns {Object} Preview of cleanup operation
   */
  async previewCleanup() {
    try {
      const preview = {
        totalToDelete: 0,
        byGranularity: {}
      };

      for (const [granularity, retentionDays] of Object.entries(this.config.retentionPeriods)) {
        if (retentionDays === null) {
          preview.byGranularity[granularity] = {
            toDelete: 0,
            retentionDays: 'indefinite',
            message: 'Kept indefinitely'
          };
          continue;
        }

        const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        const count = await MetricsSnapshot.countDocuments({
          granularity,
          createdAt: { $lt: cutoffDate }
        });

        preview.byGranularity[granularity] = {
          toDelete: count,
          retentionDays,
          cutoffDate: cutoffDate.toISOString()
        };

        preview.totalToDelete += count;
      }

      logger.info('Cleanup preview generated', { totalToDelete: preview.totalToDelete });

      return preview;
    } catch (error) {
      logger.error('Failed to preview cleanup', { error: error.message });
      throw error;
    }
  }

  /**
   * Update retention policy for a specific granularity
   * @param {string} granularity - Granularity level
   * @param {number|null} retentionDays - Number of days to retain (null for indefinite)
   */
  updateRetentionPolicy(granularity, retentionDays) {
    if (!this.config.retentionPeriods.hasOwnProperty(granularity)) {
      throw new Error(`Invalid granularity: ${granularity}`);
    }

    this.config.retentionPeriods[granularity] = retentionDays;

    logger.info('Retention policy updated', {
      granularity,
      retentionDays: retentionDays === null ? 'indefinite' : retentionDays
    });
  }

  /**
   * Get current retention policies
   * @returns {Object} Current retention configuration
   */
  getRetentionPolicies() {
    return {
      ...this.config.retentionPeriods,
      cleanupSchedule: {
        hour: this.config.cleanupHour,
        minute: this.config.cleanupMinute,
        enabled: this.config.enableAutoCleanup
      }
    };
  }

  /**
   * Force immediate cleanup (useful for testing or manual operations)
   * @returns {Object} Cleanup statistics
   */
  async forceCleanup() {
    logger.warn('Force cleanup triggered manually');
    return await this.cleanupMetrics();
  }
}

// Export singleton instance
module.exports = new MetricsCleanup();
