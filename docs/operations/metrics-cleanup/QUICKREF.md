# MetricsCleanup Service - Quick Reference Card

## One-Line Integration
```javascript
const metricsCleanup = require('./src/services/metricsCleanup');
```

## Common Operations

### Get Storage Stats
```javascript
const stats = await metricsCleanup.getStorageStats();
console.log(`Total metrics: ${stats.total}`);
```

### Preview Cleanup
```javascript
const preview = await metricsCleanup.previewCleanup();
console.log(`Will delete: ${preview.totalToDelete} metrics`);
```

### Force Manual Cleanup
```javascript
const result = await metricsCleanup.forceCleanup();
console.log(`Deleted: ${result.totalDeleted} metrics`);
```

### Update Retention Policy
```javascript
// Keep raw metrics for 60 days instead of 90
metricsCleanup.updateRetentionPolicy('raw', 60);

// Keep daily aggregates indefinitely
metricsCleanup.updateRetentionPolicy('1d', null);
```

### Check Current Policies
```javascript
const policies = metricsCleanup.getRetentionPolicies();
console.log(policies);
```

## Default Retention Periods

| Type | Period | Description |
|------|--------|-------------|
| raw | 90d | Raw metrics |
| 1h | 180d | Hourly aggregates |
| 1d | 365d | Daily aggregates |
| 30d | ∞ | Monthly (kept forever) |

## Environment Variables

```bash
# Retention periods (days)
METRICS_RETENTION_RAW_DAYS=90
METRICS_RETENTION_1H_DAYS=180
METRICS_RETENTION_1D_DAYS=365

# Schedule (24-hour format)
METRICS_CLEANUP_HOUR=2      # 2 AM
METRICS_CLEANUP_MINUTE=0

# Control
METRICS_AUTO_CLEANUP=true
METRICS_CLEANUP_BATCH_SIZE=1000
```

## API Routes (Optional)

```javascript
// Add to your Express app
const metricsCleanup = require('./src/services/metricsCleanup');

// Storage stats
app.get('/api/admin/metrics/storage-stats', async (req, res) => {
  const stats = await metricsCleanup.getStorageStats();
  res.json({ status: 'success', data: stats });
});

// Preview
app.get('/api/admin/metrics/cleanup-preview', async (req, res) => {
  const preview = await metricsCleanup.previewCleanup();
  res.json({ status: 'success', data: preview });
});

// Trigger cleanup
app.post('/api/admin/metrics/cleanup', async (req, res) => {
  const result = await metricsCleanup.forceCleanup();
  res.json({ status: 'success', data: result });
});
```

## Monitoring

```javascript
// Daily monitoring
setInterval(async () => {
  const stats = await metricsCleanup.getStorageStats();
  const preview = await metricsCleanup.previewCleanup();

  console.log('Metrics Storage:', {
    total: stats.total,
    pendingCleanup: preview.totalToDelete
  });

  // Alert if needed
  if (preview.totalToDelete > 100000) {
    console.warn('Large cleanup pending!');
  }
}, 24 * 60 * 60 * 1000);
```

## Graceful Shutdown

```javascript
process.on('SIGTERM', () => {
  metricsCleanup.stopScheduledCleanup();
  process.exit(0);
});
```

## Methods Reference

| Method | Purpose | Returns |
|--------|---------|---------|
| `cleanupMetrics()` | Execute full cleanup | Stats object |
| `forceCleanup()` | Manual immediate cleanup | Stats object |
| `previewCleanup()` | Preview without deleting | Preview object |
| `getStorageStats()` | Current storage usage | Stats object |
| `cleanupComponentMetrics(id, days)` | Component cleanup | Stats object |
| `cleanupMetricType(type, days)` | Type-based cleanup | Stats object |
| `updateRetentionPolicy(gran, days)` | Update policy | void |
| `getRetentionPolicies()` | Get current policies | Policies object |
| `scheduleCleanup()` | Start scheduler | void |
| `stopScheduledCleanup()` | Stop scheduler | void |

## Troubleshooting

### Cleanup not running?
```javascript
// Check if enabled
const policies = metricsCleanup.getRetentionPolicies();
console.log('Enabled:', policies.cleanupSchedule.enabled);

// Manually start
metricsCleanup.scheduleCleanup();
```

### Too many deletions?
```javascript
// Increase retention
metricsCleanup.updateRetentionPolicy('raw', 180);
metricsCleanup.updateRetentionPolicy('1h', 365);
```

### Check logs
```bash
tail -f logs/combined.log | grep -i "cleanup"
tail -f logs/error.log | grep -i "cleanup"
```

## Test Command

```bash
npm test tests/services/metricsCleanup.test.js
```

## Documentation Files

- `metricsCleanup.README.md` - Full documentation
- `INTEGRATION_GUIDE.md` - Integration steps
- `metricsCleanup.example.js` - Usage examples
- `metricsCleanup.ARCHITECTURE.md` - Architecture
- `metricsCleanup.DELIVERABLES.md` - Deliverables

## Quick Start Checklist

- [ ] Add `require()` to server.js
- [ ] Add env vars (optional)
- [ ] Restart application
- [ ] Verify in logs
- [ ] Check storage stats
- [ ] Preview cleanup
- [ ] Monitor operations

## Support

Questions? Check:
1. README.md for detailed docs
2. example.js for usage patterns
3. test.js for behavior examples
4. INTEGRATION_GUIDE.md for setup help

---

**Service Status**: Production Ready
**Pattern**: Singleton
**Dependencies**: MetricsSnapshot, Logger
**Auto-Start**: Yes (at 2 AM daily)
