# MetricsCleanup Service

Automated storage management service for time-series metrics with configurable retention policies.

## Overview

The MetricsCleanup service automatically manages storage by cleaning up old metrics based on configurable retention policies. It runs as a background service and executes scheduled cleanup operations daily at 2 AM (configurable).

## Features

- **Automated Cleanup**: Scheduled daily cleanup at configurable time
- **Granular Retention Policies**: Different retention periods for different metric granularities
- **Manual Control**: Force cleanup or preview what will be deleted
- **Storage Statistics**: Monitor storage usage and growth
- **Component-Specific Cleanup**: Clean up metrics for specific components
- **Type-Based Cleanup**: Delete specific metric types
- **Safe Operations**: Batch deletion with error handling and recovery
- **Detailed Logging**: Comprehensive cleanup statistics and error reporting

## Default Retention Policies

| Granularity | Retention Period | Description |
|-------------|------------------|-------------|
| `raw` | 90 days | Raw unprocessed metrics |
| `5m` | 90 days | 5-minute aggregates |
| `15m` | 90 days | 15-minute aggregates |
| `1h` | 180 days | Hourly aggregates |
| `6h` | 180 days | 6-hour aggregates |
| `1d` | 365 days | Daily aggregates (1 year) |
| `7d` | 730 days | Weekly aggregates (2 years) |
| `30d` | Indefinite | Monthly aggregates (kept forever) |

## Installation

The service is automatically initialized when required. Simply import it in your main application file:

```javascript
// In server.js or app.js
const metricsCleanup = require('./src/services/metricsCleanup');

// That's it! Cleanup is automatically scheduled at 2 AM daily
```

## Configuration

Configure via environment variables in your `.env` file:

```bash
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

# Enable/disable automatic cleanup
METRICS_AUTO_CLEANUP=true
```

## Usage

### Automatic Mode (Recommended)

The service automatically starts when imported and runs daily at the configured time:

```javascript
const metricsCleanup = require('./src/services/metricsCleanup');
// Cleanup scheduled automatically
```

### Manual Cleanup

Force an immediate cleanup operation:

```javascript
const metricsCleanup = require('./src/services/metricsCleanup');

async function runCleanup() {
  const stats = await metricsCleanup.forceCleanup();
  console.log('Cleanup completed:', stats);
}
```

### Preview Cleanup

See what will be deleted without actually deleting:

```javascript
const preview = await metricsCleanup.previewCleanup();
console.log('Will delete:', preview.totalToDelete, 'metrics');
console.log('Breakdown:', preview.byGranularity);
```

### Storage Statistics

Monitor current storage usage:

```javascript
const stats = await metricsCleanup.getStorageStats();
console.log('Total metrics:', stats.total);
console.log('By granularity:', stats.byGranularity);
```

### Component-Specific Cleanup

Delete all metrics for a specific component:

```javascript
// Delete all metrics for a component (useful when decommissioning)
const stats = await metricsCleanup.cleanupComponentMetrics('old-component-id', 0);
console.log('Deleted:', stats.deleted, 'metrics');
```

### Type-Based Cleanup

Clean up specific metric types:

```javascript
// Delete performance metrics older than 30 days
const stats = await metricsCleanup.cleanupMetricType('performance', 30);
console.log('Deleted:', stats.deleted, 'performance metrics');
```

### Update Retention Policies

Dynamically change retention periods:

```javascript
// Keep raw metrics for only 30 days
metricsCleanup.updateRetentionPolicy('raw', 30);

// Keep daily aggregates indefinitely
metricsCleanup.updateRetentionPolicy('1d', null);

// Check current policies
const policies = metricsCleanup.getRetentionPolicies();
console.log(policies);
```

### Control Scheduled Cleanup

Start or stop the scheduled cleanup:

```javascript
// Stop scheduled cleanup
metricsCleanup.stopScheduledCleanup();

// Restart scheduled cleanup
metricsCleanup.scheduleCleanup();
```

## API Integration

Add admin endpoints for cleanup management:

```javascript
const express = require('express');
const metricsCleanup = require('./src/services/metricsCleanup');

const router = express.Router();

// Trigger manual cleanup
router.post('/admin/metrics/cleanup', async (req, res) => {
  try {
    const stats = await metricsCleanup.forceCleanup();
    res.json({ status: 'success', data: stats });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get storage statistics
router.get('/admin/metrics/storage-stats', async (req, res) => {
  try {
    const stats = await metricsCleanup.getStorageStats();
    res.json({ status: 'success', data: stats });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Preview cleanup
router.get('/admin/metrics/cleanup-preview', async (req, res) => {
  try {
    const preview = await metricsCleanup.previewCleanup();
    res.json({ status: 'success', data: preview });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Update retention policy
router.put('/admin/metrics/retention/:granularity', async (req, res) => {
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

module.exports = router;
```

## Cleanup Statistics Output

Example cleanup statistics:

```json
{
  "startTime": "2026-01-02T02:00:00.000Z",
  "endTime": "2026-01-02T02:00:15.234Z",
  "totalDeleted": 15234,
  "executionTimeMs": 15234,
  "executionTimeSeconds": "15.23",
  "granularityStats": {
    "raw": {
      "deleted": 10000,
      "retentionDays": 90,
      "cutoffDate": "2025-10-04T02:00:00.000Z"
    },
    "1h": {
      "deleted": 5234,
      "retentionDays": 180,
      "cutoffDate": "2025-07-06T02:00:00.000Z"
    },
    "1d": {
      "deleted": 0,
      "retentionDays": 365,
      "cutoffDate": "2025-01-02T02:00:00.000Z"
    },
    "30d": {
      "deleted": 0,
      "retentionDays": "indefinite",
      "skipped": true
    }
  },
  "errors": []
}
```

## Monitoring

Set up monitoring for cleanup operations:

```javascript
// Daily monitoring report
setInterval(async () => {
  const stats = await metricsCleanup.getStorageStats();
  const preview = await metricsCleanup.previewCleanup();

  console.log('Metrics Storage Report:', {
    timestamp: new Date().toISOString(),
    totalMetrics: stats.total,
    pendingCleanup: preview.totalToDelete
  });

  // Alert if too many metrics are pending cleanup
  if (preview.totalToDelete > 100000) {
    console.warn('⚠️ Large number of metrics pending cleanup');
  }
}, 24 * 60 * 60 * 1000); // Daily
```

## Graceful Shutdown

Stop the cleanup service during application shutdown:

```javascript
process.on('SIGTERM', () => {
  console.log('Stopping metrics cleanup service...');
  metricsCleanup.stopScheduledCleanup();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Stopping metrics cleanup service...');
  metricsCleanup.stopScheduledCleanup();
  process.exit(0);
});
```

## Testing

Run the test suite:

```bash
# Run all tests
npm test tests/services/metricsCleanup.test.js

# Run with coverage
npm test -- --coverage tests/services/metricsCleanup.test.js
```

## Best Practices

1. **Start with conservative retention periods** - You can always decrease them later
2. **Monitor storage growth** - Use `getStorageStats()` to track storage usage
3. **Preview before cleanup** - Always preview cleanup operations in production
4. **Keep monthly aggregates** - Long-term trends are valuable for analysis
5. **Schedule during off-peak hours** - Default 2 AM is usually good
6. **Log cleanup statistics** - Monitor deletion counts for anomalies
7. **Test retention policies** - Verify policies match your compliance requirements

## Troubleshooting

### Cleanup not running

Check if auto-cleanup is enabled:
```javascript
const policies = metricsCleanup.getRetentionPolicies();
console.log('Auto-cleanup enabled:', policies.cleanupSchedule.enabled);
```

Manually start if needed:
```javascript
metricsCleanup.scheduleCleanup();
```

### Too many metrics deleted

Review retention policies:
```javascript
const policies = metricsCleanup.getRetentionPolicies();
console.log(policies);
```

Increase retention periods if needed:
```javascript
metricsCleanup.updateRetentionPolicy('raw', 180); // Double to 180 days
```

### Storage still growing

Check for metrics not being cleaned:
```javascript
const stats = await metricsCleanup.getStorageStats();
console.log(stats.byGranularity);

// Check what will be deleted
const preview = await metricsCleanup.previewCleanup();
console.log(preview);
```

### Cleanup taking too long

Adjust batch size:
```env
METRICS_CLEANUP_BATCH_SIZE=500  # Reduce from default 1000
```

## Related Services

- **MetricsCollector**: Records and aggregates metrics
- **MetricsSnapshot Model**: MongoDB schema for metrics storage
- **AlertService**: Can monitor cleanup statistics and alert on issues

## Support

For issues or questions:
1. Check the test file: `tests/services/metricsCleanup.test.js`
2. Review example usage: `src/services/metricsCleanup.example.js`
3. Check logs for error messages
4. Review MongoDB indexes for performance issues

## License

Part of the AgentX project.
