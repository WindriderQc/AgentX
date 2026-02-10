# MetricsCleanup Service - Integration Guide

This guide shows how to integrate the MetricsCleanup service into your AgentX application.

## Quick Start (2 Minutes)

### Step 1: Add to Server Initialization

Edit `/home/yb/codes/AgentX/server.js` and add the cleanup service:

```javascript
// Add this line near the top with other service imports
const metricsCleanup = require('./src/services/metricsCleanup');

// The service automatically schedules cleanup at 2 AM daily
// No additional code needed!
```

**Complete example:**

```javascript
require('dotenv').config();
const path = require('path');
const connectDB = require('./config/db-mongodb');
const logger = require('./config/logger');
const { app, systemHealth } = require('./src/app');
const SelfHealingEngine = require('./src/services/selfHealingEngine');

// ADD THIS LINE - Metrics Cleanup Service
const metricsCleanup = require('./src/services/metricsCleanup');

const PORT = process.env.PORT || 3080;
// ... rest of server.js
```

### Step 2: Add Environment Variables (Optional)

Add to your `.env` file if you want to customize retention periods:

```bash
# Metrics Cleanup Configuration (Optional - defaults shown)
METRICS_RETENTION_RAW_DAYS=90
METRICS_RETENTION_1H_DAYS=180
METRICS_RETENTION_1D_DAYS=365
METRICS_CLEANUP_HOUR=2
METRICS_CLEANUP_MINUTE=0
METRICS_AUTO_CLEANUP=true
```

### Step 3: Done!

That's it! The service will:
- Automatically schedule cleanup at 2 AM daily
- Delete raw metrics older than 90 days
- Delete hourly aggregates older than 180 days
- Delete daily aggregates older than 1 year
- Keep monthly aggregates indefinitely
- Log detailed cleanup statistics

## Advanced Integration

### Add Admin API Endpoints

Create a new route file `/home/yb/codes/AgentX/routes/metricsAdmin.js`:

```javascript
const express = require('express');
const router = express.Router();
const metricsCleanup = require('../src/services/metricsCleanup');
const { adminAuth } = require('../src/middleware/auth'); // Your auth middleware

// Storage statistics
router.get('/storage-stats', adminAuth, async (req, res) => {
  try {
    const stats = await metricsCleanup.getStorageStats();
    res.json({ status: 'success', data: stats });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Preview cleanup
router.get('/cleanup-preview', adminAuth, async (req, res) => {
  try {
    const preview = await metricsCleanup.previewCleanup();
    res.json({ status: 'success', data: preview });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Trigger manual cleanup
router.post('/cleanup', adminAuth, async (req, res) => {
  try {
    const stats = await metricsCleanup.forceCleanup();
    res.json({
      status: 'success',
      message: `Cleanup completed. Deleted ${stats.totalDeleted} metrics.`,
      data: stats
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get retention policies
router.get('/retention-policies', adminAuth, async (req, res) => {
  try {
    const policies = metricsCleanup.getRetentionPolicies();
    res.json({ status: 'success', data: policies });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Update retention policy
router.put('/retention-policies/:granularity', adminAuth, async (req, res) => {
  try {
    const { granularity } = req.params;
    const { retentionDays } = req.body;

    // Validate input
    if (retentionDays !== null && (typeof retentionDays !== 'number' || retentionDays < 0)) {
      return res.status(400).json({
        status: 'error',
        message: 'retentionDays must be a positive number or null'
      });
    }

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

Then add to your main app (`/home/yb/codes/AgentX/src/app.js`):

```javascript
// Add admin metrics routes
const metricsAdminRoutes = require('../routes/metricsAdmin');
app.use('/api/admin/metrics', metricsAdminRoutes);
```

### Add Graceful Shutdown

In `/home/yb/codes/AgentX/server.js`, add graceful shutdown:

```javascript
// Graceful shutdown
const gracefulShutdown = () => {
  logger.info('Received shutdown signal, closing gracefully...');

  // Stop metrics cleanup
  metricsCleanup.stopScheduledCleanup();

  // Close server
  server.close(() => {
    logger.info('Server closed');

    // Close database connection
    mongoose.connection.close(false, () => {
      logger.info('MongoDB connection closed');
      process.exit(0);
    });
  });

  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
```

### Add Monitoring Dashboard

Create a monitoring endpoint in your existing metrics routes:

```javascript
// In /routes/metrics.js or create new endpoint
router.get('/cleanup/dashboard', optionalAuth, async (req, res) => {
  try {
    const [storageStats, cleanupPreview, policies] = await Promise.all([
      metricsCleanup.getStorageStats(),
      metricsCleanup.previewCleanup(),
      Promise.resolve(metricsCleanup.getRetentionPolicies())
    ]);

    res.json({
      status: 'success',
      data: {
        storage: storageStats,
        nextCleanup: cleanupPreview,
        policies: policies,
        lastCleanupTime: '2 AM daily' // You could store actual last run time
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});
```

## Testing the Integration

### 1. Manual Test

After starting your server, test the service in Node REPL or a test script:

```javascript
const metricsCleanup = require('./src/services/metricsCleanup');

async function test() {
  // Check storage stats
  const stats = await metricsCleanup.getStorageStats();
  console.log('Storage Stats:', stats);

  // Preview cleanup
  const preview = await metricsCleanup.previewCleanup();
  console.log('Cleanup Preview:', preview);

  // Check policies
  const policies = metricsCleanup.getRetentionPolicies();
  console.log('Retention Policies:', policies);
}

test().catch(console.error);
```

### 2. API Test

Test the admin endpoints:

```bash
# Get storage statistics
curl http://localhost:3080/api/admin/metrics/storage-stats

# Preview cleanup
curl http://localhost:3080/api/admin/metrics/cleanup-preview

# Get retention policies
curl http://localhost:3080/api/admin/metrics/retention-policies

# Trigger manual cleanup (be careful!)
curl -X POST http://localhost:3080/api/admin/metrics/cleanup

# Update retention policy
curl -X PUT http://localhost:3080/api/admin/metrics/retention-policies/raw \
  -H "Content-Type: application/json" \
  -d '{"retentionDays": 60}'
```

### 3. Run Unit Tests

```bash
npm test tests/services/metricsCleanup.test.js
```

## Monitoring in Production

### Check Logs

The service logs important events:

```bash
# Watch logs for cleanup operations
tail -f logs/combined.log | grep -i "metrics cleanup"

# Check for errors
tail -f logs/error.log | grep -i "cleanup"
```

### Set Up Alerts

Monitor these metrics:
- Number of metrics deleted per cleanup
- Execution time of cleanup operations
- Storage growth rate
- Failed cleanup operations

Example monitoring script:

```javascript
// scripts/monitor-cleanup.js
const metricsCleanup = require('../src/services/metricsCleanup');
const logger = require('../config/logger');

async function monitorCleanup() {
  try {
    const stats = await metricsCleanup.getStorageStats();
    const preview = await metricsCleanup.previewCleanup();

    logger.info('Metrics Cleanup Monitor', {
      totalMetrics: stats.total,
      pendingCleanup: preview.totalToDelete,
      storagePercentage: {
        raw: stats.byGranularity.raw?.percentage || 0,
        hourly: stats.byGranularity['1h']?.percentage || 0,
        daily: stats.byGranularity['1d']?.percentage || 0
      }
    });

    // Alert if too many metrics pending cleanup
    if (preview.totalToDelete > 100000) {
      logger.warn('High number of metrics pending cleanup', {
        count: preview.totalToDelete
      });
    }

    // Alert if storage is too large
    if (stats.total > 1000000) {
      logger.warn('Metrics storage is very large', {
        total: stats.total
      });
    }
  } catch (error) {
    logger.error('Cleanup monitoring failed', { error: error.message });
  }
}

// Run every hour
setInterval(monitorCleanup, 60 * 60 * 1000);
monitorCleanup(); // Run immediately

module.exports = monitorCleanup;
```

## Troubleshooting

### Issue: Cleanup not running

**Check:**
1. Is `METRICS_AUTO_CLEANUP` set to `true` or undefined?
2. Is the service imported in server.js?
3. Check logs for errors

**Solution:**
```javascript
// Manually start
metricsCleanup.scheduleCleanup();
```

### Issue: Too many metrics deleted

**Check retention policies:**
```javascript
const policies = metricsCleanup.getRetentionPolicies();
console.log(policies);
```

**Increase retention:**
```javascript
metricsCleanup.updateRetentionPolicy('raw', 180);
metricsCleanup.updateRetentionPolicy('1h', 365);
```

### Issue: Performance degradation

**Check execution time in logs**

**Reduce batch size:**
```bash
# In .env
METRICS_CLEANUP_BATCH_SIZE=500
```

**Run cleanup during off-peak hours:**
```bash
# In .env
METRICS_CLEANUP_HOUR=3  # 3 AM instead of 2 AM
```

## Rollback

If you need to disable the service:

1. Set `METRICS_AUTO_CLEANUP=false` in `.env`
2. Remove the import from `server.js`
3. Restart the application

Or stop it programmatically:
```javascript
metricsCleanup.stopScheduledCleanup();
```

## Next Steps

1. Review and adjust retention policies for your needs
2. Set up monitoring and alerts
3. Add admin UI for cleanup management
4. Schedule regular storage audits
5. Document your specific retention requirements

## Support

- Main service: `/home/yb/codes/AgentX/src/services/metricsCleanup.js`
- Tests: `/home/yb/codes/AgentX/tests/services/metricsCleanup.test.js`
- Examples: `/home/yb/codes/AgentX/src/services/metricsCleanup.example.js`
- Documentation: `/home/yb/codes/AgentX/src/services/metricsCleanup.README.md`
