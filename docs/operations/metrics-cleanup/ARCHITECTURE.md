# MetricsCleanup Service Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AgentX Application                            │
│                                                                       │
│  ┌────────────────┐                                                  │
│  │   server.js    │                                                  │
│  │                │                                                  │
│  │ ┌────────────┐ │                                                  │
│  │ │ require()  │ │──────────────┐                                  │
│  │ └────────────┘ │               │                                  │
│  └────────────────┘               │                                  │
│                                    ▼                                  │
│                    ┌───────────────────────────────┐                 │
│                    │   MetricsCleanup Service      │                 │
│                    │   (Singleton Pattern)         │                 │
│                    │                               │                 │
│                    │  ┌─────────────────────────┐  │                 │
│                    │  │  Scheduled Cleanup      │  │                 │
│                    │  │  (Daily at 2 AM)        │  │                 │
│                    │  └──────────┬──────────────┘  │                 │
│                    │             │                 │                 │
│                    │  ┌──────────▼──────────────┐  │                 │
│                    │  │  Retention Policies     │  │                 │
│                    │  │  - raw: 90 days         │  │                 │
│                    │  │  - 1h: 180 days         │  │                 │
│                    │  │  - 1d: 365 days         │  │                 │
│                    │  │  - 30d: indefinite      │  │                 │
│                    │  └──────────┬──────────────┘  │                 │
│                    │             │                 │                 │
│                    │  ┌──────────▼──────────────┐  │                 │
│                    │  │  Cleanup Operations     │  │                 │
│                    │  │  - Calculate cutoff     │  │                 │
│                    │  │  - Delete by granular.  │  │                 │
│                    │  │  - Log statistics       │  │                 │
│                    │  └──────────┬──────────────┘  │                 │
│                    └─────────────┼─────────────────┘                 │
│                                  │                                    │
│                                  ▼                                    │
│                    ┌─────────────────────────────┐                   │
│                    │   MongoDB Database          │                   │
│                    │                             │                   │
│                    │  ┌───────────────────────┐  │                   │
│                    │  │ MetricsSnapshot       │  │                   │
│                    │  │ Collection            │  │                   │
│                    │  │                       │  │                   │
│                    │  │ • granularity index   │  │                   │
│                    │  │ • createdAt index     │  │                   │
│                    │  │ • componentId index   │  │                   │
│                    │  └───────────────────────┘  │                   │
│                    └─────────────────────────────┘                   │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## Component Interaction Flow

```
┌─────────────┐
│   Server    │
│   Startup   │
└──────┬──────┘
       │
       │ 1. require('./src/services/metricsCleanup')
       │
       ▼
┌──────────────────────┐
│ MetricsCleanup       │
│ Constructor          │
│                      │
│ • Load config        │
│ • Initialize timer   │
│ • Schedule cleanup   │
└──────┬───────────────┘
       │
       │ 2. Calculate next run time
       │
       ▼
┌──────────────────────┐
│ setTimeout()         │
│                      │
│ Wait until 2 AM      │
└──────┬───────────────┘
       │
       │ 3. Time reached (2 AM)
       │
       ▼
┌──────────────────────┐
│ _executeScheduled    │
│ Cleanup()            │
└──────┬───────────────┘
       │
       │ 4. Start cleanup
       │
       ▼
┌──────────────────────┐
│ cleanupMetrics()     │
│                      │
│ For each granularity:│
│ • raw                │
│ • 5m, 15m            │
│ • 1h, 6h             │
│ • 1d, 7d             │
│ • 30d (skip)         │
└──────┬───────────────┘
       │
       │ 5. Delete old metrics
       │
       ▼
┌──────────────────────┐
│ _cleanupGranularity()│
│                      │
│ deleteMany({         │
│   granularity,       │
│   createdAt: {       │
│     $lt: cutoffDate  │
│   }                  │
│ })                   │
└──────┬───────────────┘
       │
       │ 6. Log statistics
       │
       ▼
┌──────────────────────┐
│ Logger               │
│                      │
│ • Total deleted      │
│ • By granularity     │
│ • Execution time     │
│ • Any errors         │
└──────┬───────────────┘
       │
       │ 7. Schedule next run
       │
       ▼
┌──────────────────────┐
│ setInterval()        │
│                      │
│ Run every 24 hours   │
└──────────────────────┘
```

## Data Flow - Cleanup Operation

```
Input:                Processing:              Output:
┌─────────────┐      ┌──────────────────┐    ┌──────────────────┐
│ Retention   │      │ Calculate        │    │ Cleanup Stats    │
│ Policies    │─────▶│ Cutoff Dates     │    │                  │
│             │      └────────┬─────────┘    │ • totalDeleted   │
│ • raw: 90d  │               │              │ • executionTime  │
│ • 1h: 180d  │               ▼              │ • granularity    │
│ • 1d: 365d  │      ┌──────────────────┐    │   breakdown      │
│ • 30d: ∞    │      │ Query Metrics    │    │ • errors[]       │
└─────────────┘      │                  │    └──────────────────┘
                     │ Find old metrics │              │
                     │ by granularity   │              │
                     └────────┬─────────┘              │
                              │                        │
                              ▼                        │
                     ┌──────────────────┐              │
                     │ Delete Metrics   │              │
                     │                  │              │
                     │ deleteMany()     │              │
                     └────────┬─────────┘              │
                              │                        │
                              ▼                        │
                     ┌──────────────────┐              │
                     │ Collect Stats    │─────────────▶│
                     │                  │              │
                     │ • Count deleted  │              │
                     │ • Record time    │              │
                     └──────────────────┘              │
                                                       │
                                                       ▼
                                              ┌──────────────────┐
                                              │ Logger           │
                                              │                  │
                                              │ Write to logs    │
                                              └──────────────────┘
```

## Class Structure

```
MetricsCleanup (Singleton)
│
├── Constructor
│   ├── Initialize config
│   ├── Set up retention policies
│   ├── Start scheduled cleanup (if enabled)
│   └── Return singleton instance
│
├── Public Methods
│   ├── cleanupMetrics()           - Full cleanup operation
│   ├── forceCleanup()             - Manual immediate cleanup
│   ├── previewCleanup()           - Preview without deleting
│   ├── getStorageStats()          - Current storage statistics
│   ├── cleanupComponentMetrics()  - Component-specific cleanup
│   ├── cleanupMetricType()        - Type-specific cleanup
│   ├── updateRetentionPolicy()    - Update retention period
│   ├── getRetentionPolicies()     - Get current policies
│   ├── scheduleCleanup()          - Start scheduled cleanup
│   └── stopScheduledCleanup()     - Stop scheduled cleanup
│
├── Private Methods
│   ├── _executeScheduledCleanup() - Execute scheduled operation
│   ├── _calculateNextRunTime()    - Calculate next run time
│   └── _cleanupGranularity()      - Cleanup specific granularity
│
└── Properties
    ├── config                      - Service configuration
    ├── cleanupTimer                - Scheduled timer reference
    └── isRunning                   - Cleanup operation flag
```

## Configuration Flow

```
Environment Variables (.env)
│
├── METRICS_RETENTION_RAW_DAYS ──────┐
├── METRICS_RETENTION_1H_DAYS ───────┤
├── METRICS_RETENTION_1D_DAYS ───────┤
├── METRICS_RETENTION_7D_DAYS ───────┼──▶ config.retentionPeriods
├── METRICS_CLEANUP_HOUR ────────────┤
├── METRICS_CLEANUP_MINUTE ──────────┼──▶ config.cleanupSchedule
├── METRICS_CLEANUP_BATCH_SIZE ──────┼──▶ config.batchSize
└── METRICS_AUTO_CLEANUP ────────────┴──▶ config.enableAutoCleanup
                                          │
                                          ▼
                                    ┌──────────────────┐
                                    │ Service Config   │
                                    │                  │
                                    │ Applied at       │
                                    │ initialization   │
                                    └──────────────────┘
```

## API Integration Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         Express App                                 │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Admin Routes (/api/admin/metrics)                            │  │
│  │                                                              │  │
│  │  GET  /storage-stats          ──┐                           │  │
│  │  GET  /cleanup-preview         ─┼─┐                         │  │
│  │  POST /cleanup                  ─┼─┼─┐                      │  │
│  │  GET  /retention-policies       ─┼─┼─┼─┐                    │  │
│  │  PUT  /retention-policies/:id   ─┼─┼─┼─┼─┐                  │  │
│  └──────────────────────────────────┼─┼─┼─┼─┼──────────────────┘  │
│                                     │ │ │ │ │                     │
│                                     ▼ ▼ ▼ ▼ ▼                     │
│                        ┌─────────────────────────────┐            │
│                        │   MetricsCleanup Service    │            │
│                        │                             │            │
│                        │  • getStorageStats()        │            │
│                        │  • previewCleanup()         │            │
│                        │  • forceCleanup()           │            │
│                        │  • getRetentionPolicies()   │            │
│                        │  • updateRetentionPolicy()  │            │
│                        └─────────────────────────────┘            │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Storage Lifecycle

```
Metric Created
     │
     ▼
┌─────────────────┐
│ MetricsSnapshot │  ◀── Raw metric (granularity: 'raw')
│ Collection      │
└────────┬────────┘
         │
         │ Age: 0-90 days
         │ Status: Active
         │
         ▼
    [Time Passes]
         │
         │ Age: 90 days
         │ Status: Eligible for cleanup
         │
         ▼
┌─────────────────┐
│ Cleanup Check   │  ◀── Daily at 2 AM
│                 │
│ createdAt < 90d │
└────────┬────────┘
         │
         │ Match found
         │
         ▼
┌─────────────────┐
│ Delete Metric   │  ◀── deleteMany() operation
│                 │
│ Count deleted   │
└────────┬────────┘
         │
         │ Metric removed
         │
         ▼
    [Storage freed]
```

## Error Handling Flow

```
┌─────────────────┐
│ Cleanup Start   │
└────────┬────────┘
         │
         ▼
    ┌────────┐
    │ Try    │
    └───┬────┘
        │
        ├─▶ Process granularity: raw
        │   ├─ Success ──▶ Log stats
        │   └─ Error ────▶ Catch & log, continue
        │
        ├─▶ Process granularity: 1h
        │   ├─ Success ──▶ Log stats
        │   └─ Error ────▶ Catch & log, continue
        │
        ├─▶ Process granularity: 1d
        │   ├─ Success ──▶ Log stats
        │   └─ Error ────▶ Catch & log, continue
        │
        └─▶ All done ────▶ Return aggregated stats
                          │
                          ▼
                    ┌──────────────┐
                    │ Final Stats  │
                    │              │
                    │ • Successes  │
                    │ • Errors[]   │
                    │ • Total time │
                    └──────────────┘
```

## Monitoring Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    Monitoring Layer                         │
│                                                            │
│  ┌──────────────────┐       ┌──────────────────┐         │
│  │ Storage Monitor  │       │ Cleanup Monitor  │         │
│  │                  │       │                  │         │
│  │ • Total metrics  │       │ • Execution time │         │
│  │ • Growth rate    │       │ • Deleted count  │         │
│  │ • By granularity │       │ • Error count    │         │
│  └────────┬─────────┘       └────────┬─────────┘         │
│           │                          │                    │
│           └──────────┬───────────────┘                    │
│                      │                                    │
│                      ▼                                    │
│           ┌──────────────────┐                           │
│           │ Alert Thresholds │                           │
│           │                  │                           │
│           │ • Storage > 1M   │                           │
│           │ • Pending > 100K │                           │
│           │ • Errors > 0     │                           │
│           └────────┬─────────┘                           │
│                    │                                     │
│                    ▼                                     │
│           ┌──────────────────┐                          │
│           │ Logger & Alerts  │                          │
│           └──────────────────┘                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Dependencies

```
MetricsCleanup Service
│
├── MetricsSnapshot (Model)
│   ├── mongoose
│   └── MongoDB
│
├── logger (Winston)
│   ├── Console transport
│   ├── File transport (error.log)
│   └── File transport (combined.log)
│
└── Environment (dotenv)
    └── Configuration variables
```

## Performance Considerations

```
Metric Volume:  10,000 metrics/day
Retention:      90 days for raw
Expected Size:  900,000 raw metrics at steady state

Cleanup Impact:
├── Time: ~15 seconds for 10,000 deletions
├── I/O: Batch deletes (1000 per batch)
├── CPU: Low (simple date comparison)
└── Memory: Minimal (streaming deletes)

Optimization:
├── Indexes on createdAt and granularity
├── Off-peak scheduling (2 AM)
├── Batch deletion to reduce lock time
└── Error recovery without rollback
```

This architecture provides a robust, scalable solution for automated metrics cleanup with comprehensive monitoring and error handling.
