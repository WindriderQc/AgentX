/**
 * MetricsCleanup Service - Usage Examples
 *
 * This file demonstrates how to use the MetricsCleanup service
 * for automated metrics storage management.
 */

const metricsCleanup = require('./metricsCleanup');

/**
 * Example 1: Basic Usage - Let it run automatically
 *
 * The service automatically starts scheduled cleanup when imported.
 * By default, it runs daily at 2 AM and deletes:
 * - Raw metrics older than 90 days
 * - Hourly aggregates older than 180 days
 * - Daily aggregates older than 1 year
 * - Monthly aggregates are kept indefinitely
 */

// Just require the service in your main app.js or server.js
// const metricsCleanup = require('./src/services/metricsCleanup');
// That's it! It will automatically schedule cleanup at 2 AM daily.


/**
 * Example 2: Manual Cleanup Trigger
 *
 * Force an immediate cleanup (useful for testing or manual maintenance)
 */
async function runManualCleanup() {
  try {
    console.log('Starting manual cleanup...');
    const stats = await metricsCleanup.forceCleanup();

    console.log('Cleanup completed:', {
      totalDeleted: stats.totalDeleted,
      executionTime: stats.executionTimeSeconds + 's',
      byGranularity: stats.granularityStats
    });
  } catch (error) {
    console.error('Cleanup failed:', error.message);
  }
}


/**
 * Example 3: Preview Cleanup
 *
 * See what will be deleted without actually deleting anything
 */
async function previewNextCleanup() {
  try {
    const preview = await metricsCleanup.previewCleanup();

    console.log('Cleanup preview:', {
      totalToDelete: preview.totalToDelete,
      breakdown: preview.byGranularity
    });

    // Example output:
    // {
    //   totalToDelete: 15234,
    //   breakdown: {
    //     raw: { toDelete: 10000, retentionDays: 90, cutoffDate: '...' },
    //     '1h': { toDelete: 5234, retentionDays: 180, cutoffDate: '...' }
    //   }
    // }
  } catch (error) {
    console.error('Preview failed:', error.message);
  }
}


/**
 * Example 4: Get Storage Statistics
 *
 * Monitor how much storage is being used by different metric types
 */
async function checkStorageUsage() {
  try {
    const stats = await metricsCleanup.getStorageStats();

    console.log('Storage Statistics:', {
      total: stats.total,
      byGranularity: stats.byGranularity
    });

    // Example output:
    // {
    //   total: 50000,
    //   byGranularity: {
    //     raw: {
    //       count: 30000,
    //       percentage: '60.00',
    //       oldestMetric: '2025-10-01T00:00:00.000Z',
    //       ageInDays: 92
    //     },
    //     '1h': { count: 15000, percentage: '30.00', ... }
    //   }
    // }
  } catch (error) {
    console.error('Failed to get storage stats:', error.message);
  }
}


/**
 * Example 5: Clean Up Specific Component
 *
 * Delete all metrics for a specific component (useful when removing a service)
 */
async function cleanupDeletedComponent(componentId) {
  try {
    const stats = await metricsCleanup.cleanupComponentMetrics(componentId, 0);

    console.log(`Deleted ${stats.deleted} metrics for component: ${componentId}`);
  } catch (error) {
    console.error('Component cleanup failed:', error.message);
  }
}


/**
 * Example 6: Clean Up by Metric Type
 *
 * Delete specific types of metrics older than specified days
 */
async function cleanupPerformanceMetrics() {
  try {
    // Delete performance metrics older than 30 days
    const stats = await metricsCleanup.cleanupMetricType('performance', 30);

    console.log(`Deleted ${stats.deleted} performance metrics`);
  } catch (error) {
    console.error('Metric type cleanup failed:', error.message);
  }
}


/**
 * Example 7: Update Retention Policies
 *
 * Dynamically change retention periods
 */
function updateRetentionSettings() {
  // Keep raw metrics for only 30 days instead of 90
  metricsCleanup.updateRetentionPolicy('raw', 30);

  // Keep hourly aggregates for 1 year instead of 180 days
  metricsCleanup.updateRetentionPolicy('1h', 365);

  // Keep daily aggregates indefinitely
  metricsCleanup.updateRetentionPolicy('1d', null);

  console.log('Retention policies updated');
}


/**
 * Example 8: Check Current Retention Policies
 */
function checkRetentionPolicies() {
  const policies = metricsCleanup.getRetentionPolicies();

  console.log('Current retention policies:', {
    raw: policies.raw + ' days',
    hourly: policies['1h'] + ' days',
    daily: policies['1d'] + ' days',
    monthly: policies['30d'] === null ? 'indefinite' : policies['30d'] + ' days',
    schedule: `${policies.cleanupSchedule.hour}:${policies.cleanupSchedule.minute.toString().padStart(2, '0')}`
  });
}


/**
 * Example 9: Integration with Express API
 *
 * Create admin endpoints for cleanup management
 */
function createCleanupRoutes(app) {
  // Trigger manual cleanup
  app.post('/api/admin/metrics/cleanup', async (req, res) => {
    try {
      const stats = await metricsCleanup.forceCleanup();
      res.json({ status: 'success', data: stats });
    } catch (error) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  // Get storage statistics
  app.get('/api/admin/metrics/storage-stats', async (req, res) => {
    try {
      const stats = await metricsCleanup.getStorageStats();
      res.json({ status: 'success', data: stats });
    } catch (error) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  // Preview cleanup
  app.get('/api/admin/metrics/cleanup-preview', async (req, res) => {
    try {
      const preview = await metricsCleanup.previewCleanup();
      res.json({ status: 'success', data: preview });
    } catch (error) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  // Update retention policy
  app.put('/api/admin/metrics/retention/:granularity', async (req, res) => {
    try {
      const { granularity } = req.params;
      const { retentionDays } = req.body;

      metricsCleanup.updateRetentionPolicy(granularity, retentionDays);

      res.json({
        status: 'success',
        message: 'Retention policy updated',
        granularity,
        retentionDays
      });
    } catch (error) {
      res.status(400).json({ status: 'error', message: error.message });
    }
  });
}


/**
 * Example 10: Environment Configuration
 *
 * Configure via environment variables in .env file:
 */
const envConfigExample = `
# Metrics Cleanup Configuration

# Retention periods (in days)
METRICS_RETENTION_RAW_DAYS=90
METRICS_RETENTION_5M_DAYS=90
METRICS_RETENTION_15M_DAYS=90
METRICS_RETENTION_1H_DAYS=180
METRICS_RETENTION_6H_DAYS=180
METRICS_RETENTION_1D_DAYS=365
METRICS_RETENTION_7D_DAYS=730

# Cleanup schedule (24-hour format)
METRICS_CLEANUP_HOUR=2
METRICS_CLEANUP_MINUTE=0

# Batch size for deletion operations
METRICS_CLEANUP_BATCH_SIZE=1000

# Enable/disable automatic cleanup (default: true)
METRICS_AUTO_CLEANUP=true
`;


/**
 * Example 11: Monitoring Cleanup Jobs
 *
 * Set up monitoring for cleanup operations
 */
async function monitorCleanupOperations() {
  // Schedule daily report
  setInterval(async () => {
    try {
      const stats = await metricsCleanup.getStorageStats();
      const preview = await metricsCleanup.previewCleanup();

      console.log('Daily Cleanup Report:', {
        timestamp: new Date().toISOString(),
        currentStorage: stats.total,
        pendingCleanup: preview.totalToDelete,
        storageGrowth: calculateStorageGrowth(stats)
      });

      // Send alert if storage is growing too fast
      if (preview.totalToDelete > 100000) {
        console.warn('⚠️ Large number of metrics pending cleanup:', preview.totalToDelete);
      }
    } catch (error) {
      console.error('Monitoring error:', error.message);
    }
  }, 24 * 60 * 60 * 1000); // Daily
}

function calculateStorageGrowth(stats) {
  // Implement your storage growth calculation logic
  return 'N/A';
}


/**
 * Example 12: Graceful Shutdown
 *
 * Stop cleanup service when shutting down
 */
function setupGracefulShutdown() {
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, stopping cleanup service...');
    metricsCleanup.stopScheduledCleanup();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received, stopping cleanup service...');
    metricsCleanup.stopScheduledCleanup();
    process.exit(0);
  });
}


// Export examples for testing or demonstration
module.exports = {
  runManualCleanup,
  previewNextCleanup,
  checkStorageUsage,
  cleanupDeletedComponent,
  cleanupPerformanceMetrics,
  updateRetentionSettings,
  checkRetentionPolicies,
  createCleanupRoutes,
  monitorCleanupOperations,
  setupGracefulShutdown,
  envConfigExample
};
