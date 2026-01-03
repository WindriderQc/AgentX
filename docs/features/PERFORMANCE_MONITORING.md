# Performance Monitoring System

Complete guide to AgentX's performance monitoring, load testing, and regression detection infrastructure.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Components](#components)
4. [Getting Started](#getting-started)
5. [Load Testing](#load-testing)
6. [Baseline Management](#baseline-management)
7. [Regression Detection](#regression-detection)
8. [n8n Automation](#n8n-automation)
9. [CI/CD Integration](#cicd-integration)
10. [Dashboard Usage](#dashboard-usage)
11. [Troubleshooting](#troubleshooting)

---

## Overview

The AgentX Performance Monitoring System provides comprehensive visibility into system performance through:

- **Real-time Request Tracking** - Automatic tracking of all HTTP requests
- **Load Testing Integration** - Artillery test execution and result import
- **Performance Baselines** - Establish performance targets and compare against them
- **Regression Detection** - Automatically detect performance degradations
- **Automated Monitoring** - n8n workflows for continuous performance checks
- **Visual Dashboard** - Chart.js-powered performance visualization

### Key Features

- Non-blocking request tracking middleware
- Hourly aggregation of performance metrics
- Per-endpoint latency and error tracking
- Percentile calculations (p50, p95, p99)
- Artillery load test automation
- Baseline creation from live metrics or load tests
- Regression detection with configurable thresholds
- n8n workflow for scheduled testing
- CI/CD pipeline integration scripts

---

## Architecture

### Three-Layer Design

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: Request Tracking (Middleware)                 │
│  - Tracks every HTTP request in real-time               │
│  - Measures latency, status codes, endpoints            │
│  - Buffers data for aggregation                         │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 2: Aggregation & Storage (MongoDB)               │
│  - PerformanceSnapshot (hourly aggregates)              │
│  - PerformanceLoadTest (Artillery results)              │
│  - PerformanceBaseline (target metrics)                 │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Analysis & Visualization                      │
│  - Dashboard (Chart.js visualizations)                  │
│  - Regression detection API                             │
│  - n8n automated testing                                │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

```
HTTP Request → Middleware Tracking → In-Memory Buffer (60s)
                                           ↓
                                  MongoDB Aggregation
                                           ↓
                        ┌──────────────────┴──────────────────┐
                        ↓                                      ↓
              Performance Snapshots                   Load Test Results
              (hourly aggregates)                     (Artillery imports)
                        ↓                                      ↓
                        └──────────────────┬──────────────────┘
                                           ↓
                               Baseline Comparison API
                                           ↓
                               Regression Detection
```

---

## Components

### 1. Performance Tracking Middleware

**File:** `/src/middleware/performanceTracker.js`

Tracks every HTTP request with:
- Start/finish timestamps
- Response latency
- HTTP status codes
- Endpoint path and method

**Key Features:**
- Non-blocking (uses event listeners)
- In-memory buffering (flushes every 60 seconds)
- Automatic aggregation by hour
- Slow request warnings (>2s)

**Usage:**

Already integrated in `/src/app.js`:

```javascript
const performanceTracker = require('./middleware/performanceTracker');
app.use(performanceTracker.trackRequest);
```

### 2. MongoDB Models

#### PerformanceSnapshot

**File:** `/models/PerformanceSnapshot.js`

Stores hourly aggregated metrics:

```javascript
{
  hour: Date,                    // Truncated to hour
  requests_total: Number,        // Total requests
  requests_successful: Number,   // 2xx/3xx responses
  requests_failed: Number,       // 4xx/5xx responses
  latency: {
    min: Number,
    max: Number,
    avg: Number,
    p95: Number,
    p99: Number
  },
  by_endpoint: [{              // Per-endpoint breakdown
    path: String,
    method: String,
    count: Number,
    avg_latency: Number,
    error_count: Number
  }],
  by_status_code: Object       // { "200": 1234, "500": 5 }
}
```

**Static Methods:**
- `getTimeRange(startDate, endDate)` - Query time range
- `getLastHours(hours)` - Get recent snapshots
- `getAggregatedMetrics(startDate, endDate)` - Calculate summary stats
- `getThroughputTrend(hours)` - Requests per second over time
- `getLatencyTrend(hours, endpoint)` - Latency trends

#### PerformanceLoadTest

**File:** `/models/PerformanceLoadTest.js`

Stores Artillery test results:

```javascript
{
  name: String,
  scenario: String,
  timestamp: Date,
  config: Object,           // Test configuration
  summary: {
    requests_sent: Number,
    requests_completed: Number,
    error_rate: Number,
    rps_mean: Number,
    duration: Number
  },
  latency: {
    min: Number,
    max: Number,
    median: Number,
    p95: Number,
    p99: Number
  },
  codes: Object,           // Status code distribution
  errors: Array,           // Error details
  raw_report: Object       // Full Artillery JSON
}
```

#### PerformanceBaseline

**File:** `/models/PerformanceBaseline.js`

Defines performance targets:

```javascript
{
  name: String,
  description: String,
  active: Boolean,        // Only one active at a time
  metrics: {
    avg_response_time: Number,
    p95_latency: Number,
    error_rate: Number,
    throughput_rps: Number
  },
  endpoints: [{          // Optional per-endpoint baselines
    path: String,
    method: String,
    avg_latency: Number,
    p95_latency: Number
  }],
  source: String,        // 'manual', 'load_test', 'production_sample'
  source_test_id: ObjectId
}
```

**Static Methods:**
- `getActive()` - Get currently active baseline
- `setActive(baselineId)` - Activate baseline (deactivates others)
- `createFromLoadTest(name, loadTest, description)` - Create from test

### 3. API Routes

**File:** `/routes/performance.js`

8 comprehensive endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/performance/dashboard` | GET | Dashboard overview metrics |
| `/api/performance/load-tests` | GET | List load test history |
| `/api/performance/load-tests` | POST | Import Artillery results |
| `/api/performance/latency-trends` | GET | Latency over time |
| `/api/performance/throughput` | GET | Requests per second trends |
| `/api/performance/percentiles` | GET | Percentile breakdown |
| `/api/performance/baselines` | GET | List all baselines |
| `/api/performance/baselines` | POST | Create new baseline |
| `/api/performance/baseline-compare` | GET | Compare current vs baseline |

### 4. Automation Scripts

#### Import Artillery Results

**File:** `/scripts/import-artillery-results.sh`

Runs load test and imports to AgentX:

```bash
./scripts/import-artillery-results.sh basic-load
```

**Features:**
- Executes Artillery test from `/tests/load/*.yml`
- Saves JSON output to `/data/load-tests/`
- Posts results to `/api/performance/load-tests`
- Validates test completion
- CI/CD friendly exit codes

#### Create Performance Baseline

**File:** `/scripts/create-performance-baseline.sh`

Captures current metrics as baseline:

```bash
./scripts/create-performance-baseline.sh "v1.0-baseline" "Production baseline"
```

**Features:**
- Fetches current metrics from dashboard API
- Extracts avg_latency, p95, error_rate, throughput
- Creates baseline via API
- Automatically activates new baseline
- Interactive prompts if no data available

#### Check Performance Regression

**File:** `/scripts/check-performance-regression.sh`

Detects performance degradation:

```bash
./scripts/check-performance-regression.sh
# Exit code 0: No regression
# Exit code 1: Regression detected
```

**Features:**
- Compares current metrics vs active baseline
- Exits with non-zero if regression found
- Displays detailed comparison table
- CI/CD pipeline integration
- Colored output for visibility

---

## Getting Started

### Step 1: Verify Installation

Check that performance routes are mounted:

```bash
curl http://localhost:3080/api/performance/dashboard
```

Expected response:
```json
{
  "status": "success",
  "data": {
    "system_health": "healthy",
    "metrics_24h": { ... }
  }
}
```

### Step 2: Generate Initial Traffic

Use AgentX for a few hours to generate baseline metrics:

```bash
# Send some test requests
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen:7b", "message": "Hello"}'
```

### Step 3: Create Baseline

Once you have traffic data:

```bash
npm run perf:baseline -- "initial-baseline" "First baseline"
```

Or manually:

```bash
./scripts/create-performance-baseline.sh "initial-baseline" "First baseline"
```

### Step 4: View Dashboard

Navigate to: `http://localhost:3080/performance.html`

You should see:
- System health status
- Latency trends chart
- Throughput chart
- Endpoint breakdown table
- Load test history

---

## Load Testing

### Artillery Configuration

AgentX includes pre-configured load test scenarios:

**Basic Load** (`/tests/load/basic-load.yml`):
```yaml
config:
  target: http://localhost:3080
  phases:
    - duration: 60
      arrivalRate: 5      # 5 req/s
      name: "Warm up"
    - duration: 120
      arrivalRate: 10     # 10 req/s
      name: "Sustained load"

scenarios:
  - name: "Chat API"
    flow:
      - post:
          url: "/api/chat"
          json:
            model: "qwen:7b"
            message: "Test message"
```

**Stress Test** (`/tests/load/stress-test.yml`):
```yaml
phases:
  - duration: 60
    arrivalRate: 20      # 20 req/s
  - duration: 60
    arrivalRate: 50      # 50 req/s (stress)
```

### Running Load Tests

**Option 1: Direct Artillery**

```bash
npm run test:load:basic
```

**Option 2: Import to Dashboard**

```bash
npm run test:load:import
# Or with specific test:
./scripts/import-artillery-results.sh stress-test
```

**Option 3: Manual Import**

```bash
# Run test
artillery run tests/load/basic-load.yml --output results.json

# Import to AgentX
curl -X POST http://localhost:3080/api/performance/load-tests \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"my-test\", \"scenario\": \"basic-load\", \"raw_report\": $(cat results.json)}"
```

### Creating Custom Tests

1. Create YAML file in `/tests/load/`:

```yaml
config:
  target: http://localhost:3080
  phases:
    - duration: 300
      arrivalRate: 15
      name: "Custom load pattern"

scenarios:
  - name: "RAG Search"
    flow:
      - post:
          url: "/api/rag/search"
          json:
            query: "performance testing"
            top_k: 5
```

2. Run with import:

```bash
./scripts/import-artillery-results.sh my-custom-test
```

---

## Baseline Management

### Creating Baselines

**From Current Metrics:**

```bash
./scripts/create-performance-baseline.sh "2026-01-baseline" "January production"
```

**From Load Test:**

```javascript
// Via API after importing load test
const loadTest = await PerformanceLoadTest.getLatest();
const baseline = await PerformanceBaseline.createFromLoadTest(
  "load-test-baseline",
  loadTest,
  "Baseline from stress test"
);
await PerformanceBaseline.setActive(baseline._id);
```

**Manual via API:**

```bash
curl -X POST http://localhost:3080/api/performance/baselines \
  -H "Content-Type: application/json" \
  -d '{
    "name": "manual-baseline",
    "description": "Manually defined targets",
    "metrics": {
      "avg_response_time": 150,
      "p95_latency": 500,
      "error_rate": 1.0,
      "throughput_rps": 25
    },
    "activate": true
  }'
```

### Listing Baselines

```bash
curl http://localhost:3080/api/performance/baselines | jq '.data.baselines'
```

### Activating a Baseline

```bash
curl -X POST http://localhost:3080/api/performance/baselines/<baseline-id>/activate
```

---

## Regression Detection

### How It Works

Regression detection compares current metrics against the active baseline:

**Thresholds:**
- **P95 Latency:** Regression if >20% increase
- **Error Rate:** Regression if >2x increase

**Example:**

```
Baseline: p95_latency = 500ms, error_rate = 1%
Current:  p95_latency = 650ms, error_rate = 2.5%

Result: REGRESSION DETECTED
  - P95 latency increased 30% (threshold: 20%)
  - Error rate increased 150% (threshold: 100%)
```

### Manual Check

```bash
npm run perf:check
```

Output:

```
==========================================
Performance Regression Check
==========================================

Active Baseline: v1.0-baseline

Metrics Comparison:

  Avg Response Time  :   180ms   (baseline:   150ms  ) +20.0%
  P95 Latency        :   650ms   (baseline:   500ms  ) +30.0%
  Error Rate         :   2.5%    (baseline:   1.0%   ) +150.0%
  Throughput         :  22.5rps  (baseline:  25.0rps ) -10.0%

==========================================
❌ Performance Regression Detected!
==========================================

Regressions Found: 2

  • p95_latency: 650 (baseline: 500) - Threshold: 20% increase
  • error_rate: 2.5 (baseline: 1.0) - Threshold: 2x increase
```

### Programmatic Check

```javascript
const response = await fetch('http://localhost:3080/api/performance/baseline-compare');
const comparison = await response.json();

if (comparison.data.regression_detected) {
  console.error('Regression detected:', comparison.data.regressions);
  process.exit(1);
}
```

---

## n8n Automation

### N3.3 Performance Monitor Workflow

**File:** `/AgentC/N3.3-Performance-Monitor.json`

**Schedule:** Every 6 hours (configurable)

**Flow:**

```
Schedule Trigger (6h) ───┐
                         ├──→ Merge ──→ Run Artillery ──→ Check Baseline
Webhook (Manual) ────────┘                                      ↓
                                                        ┌───────┴───────┐
                                                        ↓               ↓
                                                   Regression?       Pass?
                                                        ↓               ↓
                                            ┌───────────┴──┐      Log Success
                                            ↓              ↓
                                    Create Alert   Log to DataAPI
                                            ↓              ↓
                                            └──────┬───────┘
                                                   ↓
                                            Record Metric
```

**Features:**
- Dual triggers (schedule + webhook)
- Runs load test via bash command
- Checks for regression automatically
- Creates alerts if regression detected
- Logs all events to DataAPI
- Records metrics for tracking

### Deployment

```bash
cd /home/yb/codes/AgentX
./scripts/deploy-n8n-workflows.sh
```

Or manually import via n8n UI:
1. Navigate to n8n at http://localhost:5678
2. Import `/AgentC/N3.3-Performance-Monitor.json`
3. Configure credentials (DataAPI, AgentX)
4. Activate workflow

### Manual Trigger

```bash
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n3-3-performance-monitor
```

---

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Performance Check

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  performance-test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Start AgentX
        run: |
          npm start &
          sleep 10

      - name: Create baseline (first run)
        run: |
          if ! ./scripts/check-performance-regression.sh; then
            echo "No baseline exists, creating one"
            ./scripts/create-performance-baseline.sh "ci-baseline"
          fi

      - name: Run load test
        run: npm run test:load:import

      - name: Check for regression
        run: npm run perf:check
```

### Jenkins Pipeline

```groovy
pipeline {
  agent any

  stages {
    stage('Load Test') {
      steps {
        sh 'npm run test:load:import'
      }
    }

    stage('Regression Check') {
      steps {
        script {
          def result = sh(
            script: 'npm run perf:check',
            returnStatus: true
          )

          if (result != 0) {
            error('Performance regression detected!')
          }
        }
      }
    }
  }

  post {
    failure {
      mail to: 'team@example.com',
           subject: "Performance Regression: ${env.JOB_NAME}",
           body: "Build ${env.BUILD_NUMBER} detected performance regression"
    }
  }
}
```

---

## Dashboard Usage

### Navigation

Access at: `http://localhost:3080/performance.html`

### Dashboard Components

#### 1. System Health Card

Shows overall health status:
- **Healthy** (green): All metrics within baseline
- **Degraded** (yellow): Some metrics elevated
- **Unhealthy** (red): Critical thresholds exceeded

#### 2. Latency Trends Chart

Line chart showing:
- P50 (median) latency
- P95 latency
- P99 latency

**Time Range:** Last 24 hours (configurable)

#### 3. Throughput Chart

Requests per second over time:
- Shows traffic patterns
- Identifies peak hours
- Detects anomalies

#### 4. Endpoint Breakdown Table

Per-endpoint metrics:
- Total requests
- Average latency
- Error count
- Status codes

Sortable by any column.

#### 5. Load Test History

Recent Artillery test results:
- Test name
- Timestamp
- P95 latency
- Error rate
- Regression status

#### 6. Active Baseline Card

Shows current baseline:
- Name
- Target metrics
- Activated date

**Actions:**
- Create new baseline
- Switch baseline
- View baseline history

### Filters and Controls

**Time Range Selector:**
```
[Last 6 hours] [Last 24 hours] [Last 7 days] [Custom]
```

**Refresh:**
```
[Auto-refresh: ON/OFF]  [Refresh Now]
```

**Export:**
```
[Export CSV] [Export JSON] [Generate Report]
```

---

## Troubleshooting

### No Metrics Showing

**Problem:** Dashboard shows "No data available"

**Solutions:**

1. Verify middleware is running:
```bash
# Check app.js includes:
grep "performanceTracker" src/app.js
```

2. Check MongoDB connection:
```bash
curl http://localhost:3080/api/performance/dashboard
```

3. Generate traffic:
```bash
# Send test requests
for i in {1..100}; do
  curl http://localhost:3080/api/health
done
```

4. Wait for aggregation (60 seconds)

### Artillery Import Fails

**Problem:** Import script returns error

**Solutions:**

1. Check Artillery is installed:
```bash
npm install -g artillery
```

2. Verify test file exists:
```bash
ls -la tests/load/basic-load.yml
```

3. Check AgentX is running:
```bash
curl http://localhost:3080/health
```

4. Review error message:
```bash
./scripts/import-artillery-results.sh basic-load 2>&1 | tail -20
```

### Baseline Comparison Error

**Problem:** "No baseline found" error

**Solutions:**

1. Create initial baseline:
```bash
npm run perf:baseline -- "initial" "First baseline"
```

2. Verify baseline exists:
```bash
curl http://localhost:3080/api/performance/baselines | jq '.data.baselines'
```

3. Check active baseline:
```bash
curl http://localhost:3080/api/performance/baselines | jq '.data.baselines[] | select(.active == true)'
```

### n8n Workflow Not Triggering

**Problem:** Scheduled workflow doesn't execute

**Solutions:**

1. Check workflow is active:
```bash
# In n8n UI, verify "Active" toggle is ON
```

2. Test manual trigger:
```bash
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n3-3-performance-monitor
```

3. Check n8n logs:
```bash
pm2 logs n8n
```

4. Verify credentials configured

### High Memory Usage

**Problem:** Performance middleware causes memory growth

**Solutions:**

1. Check buffer size:
```javascript
const { getBufferStatus } = require('./src/middleware/performanceTracker');
console.log(getBufferStatus());
```

2. Increase flush frequency:
```javascript
// In performanceTracker.js, reduce interval:
setInterval(flushToDatabase, 30000); // 30 seconds instead of 60
```

3. Limit tracked endpoints:
```javascript
// Add more SKIP_PATHS
const SKIP_PATHS = [
  '/static',
  '/public',
  '/health',
  '/assets'
];
```

---

## Advanced Topics

### Custom Regression Thresholds

Modify thresholds in `/routes/performance.js`:

```javascript
// Line 522: P95 latency threshold
if (currentMetrics.avg_p95 > baseline.metrics.p95_latency * 1.2) {
  // 1.2 = 20% increase, adjust as needed
}

// Line 531: Error rate threshold
if (currentMetrics.error_rate > baseline.metrics.error_rate * 2) {
  // 2 = 2x increase, adjust as needed
}
```

### Per-Endpoint Baselines

Create endpoint-specific targets:

```javascript
const baseline = new PerformanceBaseline({
  name: "endpoint-specific",
  metrics: { ... },
  endpoints: [
    {
      path: "/api/chat",
      method: "POST",
      avg_latency: 300,
      p95_latency: 800
    },
    {
      path: "/api/rag/search",
      method: "POST",
      avg_latency: 500,
      p95_latency: 1200
    }
  ]
});
```

### Integration with Alerting

Connect performance regression to alert system:

```javascript
// In n8n workflow or custom script
if (comparison.data.regression_detected) {
  await fetch('http://localhost:3080/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      alert_type: 'performance_regression',
      severity: 'high',
      component_type: 'agentx',
      message: 'Performance regression detected',
      metadata: comparison.data.regressions,
      channels: ['slack', 'email']
    })
  });
}
```

---

## API Reference Summary

### GET /api/performance/dashboard

Returns system overview.

**Response:**
```json
{
  "status": "success",
  "data": {
    "system_health": "healthy",
    "metrics_24h": {
      "avg_latency": 150,
      "p95_latency": 450,
      "error_rate": 0.5,
      "throughput_rps": 12.5
    },
    "latest_load_test": { ... },
    "active_baseline": { ... }
  }
}
```

### POST /api/performance/load-tests

Import Artillery results.

**Request:**
```json
{
  "name": "test-name",
  "scenario": "basic-load",
  "raw_report": { ... }
}
```

### GET /api/performance/baseline-compare

Compare current vs baseline.

**Response:**
```json
{
  "status": "success",
  "data": {
    "baseline": { "name": "...", "metrics": { ... } },
    "current": { ... },
    "diff_percentage": { ... },
    "regression_detected": true,
    "regressions": [
      {
        "metric": "p95_latency",
        "current": 650,
        "baseline": 500,
        "threshold": "20% increase"
      }
    ]
  }
}
```

---

## Contributing

### Adding New Metrics

1. Update `PerformanceSnapshot` schema
2. Modify aggregation in `performanceTracker.js`
3. Add API endpoint in `routes/performance.js`
4. Update dashboard charts
5. Document in this guide

### Testing

```bash
# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e:dashboard
```

---

## References

- [Artillery Documentation](https://www.artillery.io/docs)
- [Chart.js Documentation](https://www.chartjs.org/docs)
- [AgentX API Reference](/docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md)
- [MongoDB Performance Best Practices](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/)

---

**Last Updated:** 2026-01-03
**Version:** 1.0.0
**Maintainer:** AgentX Team
