# Analytics & Observability Service

**Agent:** AnalyticsAgent
**Status:** Active

## Responsibility
Usage analytics, metrics collection and cleanup, performance monitoring, custom dashboards, cost calculation, load testing (Artillery), API telemetry. Read-only consumer of other services' data.

## File Inventory

### Services (src/services/)
| File | Lines | Purpose |
|------|-------|---------|
| metricsCollector.js | - | Metrics collection and aggregation |
| metricsCleanup.js | 468 | Metrics aggregation and cleanup |
| usageAnalyticsService.js | - | Usage pattern analysis |
| dashboardService.js | - | Dashboard data aggregation |
| costCalculator.js | 394 | Token cost calculations |
| artilleryParser.js | 314 | Artillery load test result parsing |

### Middleware (src/middleware/)
| File | Lines | Purpose |
|------|-------|---------|
| performanceTracker.js | 345 | Request performance tracking |

### Routes (routes/)
| File | Lines | Purpose |
|------|-------|---------|
| analytics.js | 1,774 | Analytics queries and reporting |
| performance.js | 1,059 | Performance metrics and monitoring |
| metrics.js | - | Metrics endpoints |
| operations.js | 533 | System operations and config |

### Models (models/)
| File | Lines | Purpose |
|------|-------|---------|
| PerformanceSnapshot.js | 321 | Performance metrics snapshots |
| PerformanceBaseline.js | 250 | Performance baseline comparisons |
| PerformanceLoadTest.js | 238 | Load test metrics |
| MetricsSnapshot.js | 108 | Metrics data snapshots |
| ApiTelemetry.js | 162 | API call metrics |
| ActivityLog.js | 101 | User activity tracking |

### Frontend
- analytics.js (49K), dashboard.js (32K), performance.html (93K)

## APIs Exposed
- `GET /api/analytics/usage` — Usage statistics
- `GET /api/analytics/feedback` — Feedback analytics
- `GET /api/analytics/models` — Model usage analytics
- `GET /api/analytics/trends` — Trend analysis
- `GET /api/performance/*` — Performance dashboards
- `GET /api/metrics/*` — Raw metrics
- `GET /api/operations/*` — System operations

## Dependencies (Consumed)
| Service | Interface | What |
|---------|-----------|------|
| Chat Service | Conversation model (read-only) | Usage aggregation queries |
| Alerting | Alert model (read-only) | Dashboard counts |
| Prompt & Config | PromptConfig model (read-only) | A/B test analytics |

**Important:** This service has READ-ONLY access to other services' models. It NEVER writes to Conversation, Alert, or PromptConfig.

## Data Ownership
Exclusive write: PerformanceSnapshot, PerformanceBaseline, PerformanceLoadTest, MetricsSnapshot, ApiTelemetry, ActivityLog.

## Key Patterns
- performanceTracker middleware collects per-request metrics automatically
- Hourly aggregation with percentile calculations (p50, p95, p99)
- Cost efficiency analysis (cost per conversation, cost per 1K tokens)
- Read-only cross-domain access via shared MongoDB
