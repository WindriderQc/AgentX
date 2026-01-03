# Performance Benchmarking Dashboard

Comprehensive performance monitoring and regression detection system for AgentX.

## Overview

The Performance Dashboard provides automated load test tracking, baseline management, and regression detection capabilities. It integrates with Artillery load testing framework and provides real-time performance metrics.

## Features

### 1. Load Test Management

- **Import Artillery Reports**: Automatically parse and store Artillery JSON output
- **Historical Tracking**: View all past load test results with filtering
- **Metrics Extraction**: Capture latency percentiles, throughput, error rates
- **Scenario Grouping**: Organize tests by scenario type

### 2. Performance Baselines

- **Baseline Creation**: Define performance targets from load tests or manual input
- **Active Baseline**: One baseline active at a time for comparison
- **Per-Endpoint Baselines**: Set different targets for different API endpoints
- **Source Tracking**: Know if baseline came from load test or manual entry

### 3. Regression Detection

- **Automated Comparison**: Compare current metrics vs baseline
- **Threshold-Based Alerts**: Configurable thresholds for regression detection
- **Multiple Metrics**: Monitor latency, error rate, and throughput
- **Regression Reporting**: Detailed reports showing which metrics regressed

### 4. Real-Time Monitoring

- **Hourly Snapshots**: Track performance metrics aggregated by hour
- **Latency Trends**: Visualize p50, p95, p99 over time
- **Throughput Tracking**: Monitor requests per second
- **Endpoint Breakdown**: Per-endpoint performance analysis

### 5. Percentile Analysis

- **Detailed Percentiles**: p50, p95, p99, p999
- **Histogram Visualization**: Distribution of latency values
- **Bucket Analysis**: Group latencies into time ranges

## Architecture

### MongoDB Schemas

**PerformanceLoadTest** (238 lines)
- Stores Artillery test results
- Includes summary, latency, codes, errors
- Indexes for scenario and timestamp queries
- Static methods for aggregation and filtering

**PerformanceBaseline** (251 lines)
- Performance target definitions
- System-wide and per-endpoint metrics
- Active baseline management
- Comparison and validation methods

**PerformanceSnapshot** (315 lines)
- Hourly aggregated metrics
- Real-time performance tracking
- Per-endpoint breakdown
- Time-series data for trends

### Services

**artilleryParser.js** (313 lines)
- Parses Artillery JSON output
- Extracts metrics from aggregate data
- Validates report structure
- Generates human-readable summaries
- Handles edge cases (zero requests, 100% errors, etc.)

### API Routes

**performance.js** (641 lines)
- 8 RESTful endpoints
- Dashboard overview
- Load test CRUD operations
- Trend analysis endpoints
- Baseline management
- Regression comparison

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/performance/dashboard` | GET | System health overview |
| `/api/performance/load-tests` | GET | List load test history |
| `/api/performance/load-tests` | POST | Import Artillery report |
| `/api/performance/latency-trends` | GET | Time-series latency data |
| `/api/performance/throughput` | GET | Throughput trends |
| `/api/performance/percentiles` | GET | Percentile breakdown |
| `/api/performance/baselines` | GET | List all baselines |
| `/api/performance/baselines` | POST | Create new baseline |
| `/api/performance/baseline-compare` | GET | Regression detection |

## Regression Thresholds

| Metric | Threshold | Action |
|--------|-----------|--------|
| p95 Latency | >20% increase | Flag as regression |
| Error Rate | >2x increase | Flag as regression |
| Throughput | >20% decrease | Flag as regression |
| System Health | Error rate >5% | Mark as unhealthy |

## Usage Examples

### Import Load Test Results

```bash
# Run Artillery test
artillery run tests/load/basic-load.yml -o report.json

# Import to AgentX
curl -X POST http://localhost:3080/api/performance/load-tests \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"basic-load-$(date +%Y%m%d)\",
    \"scenario\": \"basic-load\",
    \"raw_report\": $(cat report.json)
  }"
```

### Create Baseline from Test

```javascript
// Via API
const loadTest = await PerformanceLoadTest.findById(testId);
const baseline = await PerformanceBaseline.createFromLoadTest(
  'v1.0-baseline',
  loadTest,
  'Production baseline for v1.0 release'
);
await PerformanceBaseline.setActive(baseline._id);
```

### Check for Regressions

```bash
curl -X GET http://localhost:3080/api/performance/baseline-compare | jq '.data.regression_detected'
```

## Testing

### Unit Tests

**artilleryParser.test.js** (508 lines)
- 37 test cases covering:
  - Valid report parsing
  - Edge cases (zero requests, 100% errors)
  - Validation logic
  - Percentile calculations
  - Error handling

All tests passing:
```bash
npm test -- tests/services/artilleryParser.test.js
# ✓ 37 passed
```

### Integration Testing

```bash
# Run automated API test script
./scripts/test-performance-api.sh

# Tests all 8 endpoints with sample data
# Creates test artifacts in database
```

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Run Load Test
  run: artillery run tests/load/basic-load.yml -o report.json

- name: Import Results
  run: |
    curl -X POST $AGENTX_URL/api/performance/load-tests \
      -d "{\"name\":\"ci-$(date)\",\"raw_report\":$(cat report.json)}"

- name: Check Regression
  run: |
    curl $AGENTX_URL/api/performance/baseline-compare | \
      jq -e '.data.regression_detected == false' || exit 1
```

### n8n Integration

Create workflow to:
1. Poll `/api/performance/load-tests` for new tests
2. Compare against baseline
3. Send Slack alert if regression detected
4. Update DataAPI with performance metrics

## File Locations

```
/models/
  PerformanceLoadTest.js      (238 lines)
  PerformanceBaseline.js       (251 lines)
  PerformanceSnapshot.js       (315 lines)

/routes/
  performance.js               (641 lines)

/src/services/
  artilleryParser.js           (313 lines)

/tests/
  services/artilleryParser.test.js  (508 lines)
  fixtures/sample-artillery-report.json

/scripts/
  test-performance-api.sh

/docs/
  api/PERFORMANCE_API.md
  testing/PERFORMANCE_API_TESTING.md
  features/PERFORMANCE_DASHBOARD.md (this file)

Total: 2,266 lines of backend code + documentation
```

## Limitations & Future Work

### Current Limitations

1. **No Request Middleware**: `PerformanceSnapshot` data collection requires request middleware (not yet implemented)
2. **No Frontend Dashboard**: API is complete, but UI needs to be built
3. **Manual Baseline Creation**: Baselines require manual API calls
4. **No Alerting**: Regression detection is passive (requires polling)

### Planned Enhancements

1. **Request Tracking Middleware**
   - Capture every request with latency
   - Aggregate into hourly snapshots
   - Populate `PerformanceSnapshot` collection

2. **Frontend Dashboard**
   - Chart.js visualizations
   - Real-time latency graphs
   - Baseline comparison UI
   - Load test history table

3. **Automated Baseline Updates**
   - Auto-create baseline from successful load test
   - Baseline versioning and history
   - A/B testing between baselines

4. **Alert Integration**
   - n8n workflow for regression alerts
   - Slack/email notifications
   - Integration with Alert system (Track 1)

5. **Advanced Analytics**
   - Trend prediction (ML-based)
   - Anomaly detection
   - Performance forecasting

## Integration Points

### With Existing AgentX Systems

- **Alert System (Track 1)**: Send alerts when regressions detected
- **Metrics System (Track 2)**: Store performance data in MetricsSnapshot
- **Self-Healing (Track 4)**: Trigger remediation on performance degradation
- **n8n Workflows**: Automate load testing and reporting

### With External Tools

- **Artillery**: Primary load testing framework
- **GitHub Actions**: CI/CD performance testing
- **Slack**: Regression notifications
- **Grafana** (future): Visual dashboards

## Getting Started

1. **Run Tests**: `npm test -- tests/services/artilleryParser.test.js`
2. **Test API**: `./scripts/test-performance-api.sh`
3. **Import Load Test**: See `/docs/testing/PERFORMANCE_API_TESTING.md`
4. **Create Baseline**: Use POST `/api/performance/baselines`
5. **Monitor**: Poll `/api/performance/dashboard`

## API Documentation

See comprehensive API reference: `/docs/api/PERFORMANCE_API.md`

## Support

- Questions: See `/docs/testing/PERFORMANCE_API_TESTING.md`
- Issues: Check Artillery report structure and validation errors
- Examples: Use `/tests/fixtures/sample-artillery-report.json` as template
