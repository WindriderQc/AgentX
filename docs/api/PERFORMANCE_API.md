# Performance API Documentation

Comprehensive API reference for the Performance Benchmarking Dashboard.

## Overview

The Performance API provides endpoints for:
- Importing and managing Artillery load test results
- Tracking real-time performance metrics
- Setting and comparing against performance baselines
- Analyzing latency trends and throughput
- Detecting performance regressions

## Base URL

```
http://localhost:3080/api/performance
```

## Endpoints

### 1. Dashboard Overview

Get system health and performance metrics overview.

**Endpoint:** `GET /api/performance/dashboard`

**Response:**
```json
{
  "status": "success",
  "data": {
    "system_health": "healthy",
    "metrics_24h": {
      "avg_latency": 250,
      "p95_latency": 800,
      "p99_latency": 1200,
      "error_rate": 1.5,
      "total_requests": 50000,
      "throughput_rps": 4.16,
      "uptime_percent": 98.5
    },
    "latest_load_test": {
      "name": "basic-load-2026-01-03",
      "scenario": "basic-load",
      "timestamp": "2026-01-03T14:30:00Z",
      "p95_latency": 850,
      "error_rate": 2.0
    },
    "active_baseline": {
      "name": "v1.0-baseline",
      "p95_latency": 1000,
      "error_rate": 3.0
    }
  }
}
```

**Example:**
```bash
curl -X GET http://localhost:3080/api/performance/dashboard
```

---

### 2. List Load Tests

Retrieve load test history with optional filtering.

**Endpoint:** `GET /api/performance/load-tests`

**Query Parameters:**
- `limit` (number, optional): Maximum results to return (default: 20)
- `scenario` (string, optional): Filter by scenario name

**Response:**
```json
{
  "status": "success",
  "data": {
    "tests": [
      {
        "_id": "abc123...",
        "name": "basic-load-2026-01-03",
        "scenario": "basic-load",
        "timestamp": "2026-01-03T14:30:00Z",
        "summary": {
          "duration": 120,
          "requests_completed": 500,
          "error_rate": 1.0,
          "rps_mean": 4.16
        },
        "latency": {
          "min": 10,
          "max": 1500,
          "median": 250,
          "p95": 800,
          "p99": 1200
        }
      }
    ],
    "count": 1
  }
}
```

**Examples:**
```bash
# Get last 20 tests
curl -X GET http://localhost:3080/api/performance/load-tests

# Get last 50 tests for specific scenario
curl -X GET "http://localhost:3080/api/performance/load-tests?limit=50&scenario=stress-test"
```

---

### 3. Import Artillery Report

Import Artillery JSON test results and create load test record.

**Endpoint:** `POST /api/performance/load-tests`

**Request Body:**
```json
{
  "name": "basic-load-2026-01-03",
  "scenario": "basic-load",
  "timestamp": "2026-01-03T14:30:00Z",
  "raw_report": {
    "aggregate": {
      "duration": 120000,
      "counters": {
        "vusers.created": 100,
        "vusers.completed": 95,
        "http.requests": 500,
        "errors.total": 5,
        "http.codes.200": 450,
        "http.codes.500": 5
      },
      "rates": {
        "http.request_rate": {
          "mean": 4.16,
          "max": 10.5
        }
      },
      "summaries": {
        "http.response_time": {
          "min": 10,
          "max": 1500,
          "median": 250,
          "p95": 800,
          "p99": 1200
        }
      }
    },
    "config": {
      "target": "http://localhost:3080",
      "phases": [
        { "duration": 60, "arrivalRate": 5 }
      ]
    }
  }
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "id": "abc123...",
    "name": "basic-load-2026-01-03",
    "scenario": "basic-load",
    "summary": {
      "duration": 120,
      "requests_completed": 500,
      "error_rate": 1.0,
      "rps_mean": 4.16
    },
    "latency": {
      "median": 250,
      "p95": 800,
      "p99": 1200
    }
  }
}
```

**Example:**
```bash
# Import from Artillery JSON file
curl -X POST http://localhost:3080/api/performance/load-tests \
  -H "Content-Type: application/json" \
  -d '{
    "name": "basic-load-2026-01-03",
    "scenario": "basic-load",
    "raw_report": <artillery-json-output>
  }'

# Or use jq to process Artillery output
artillery run tests/load/basic-load.yml -o report.json
curl -X POST http://localhost:3080/api/performance/load-tests \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"basic-load-$(date +%Y-%m-%d)\",
    \"scenario\": \"basic-load\",
    \"raw_report\": $(cat report.json)
  }"
```

---

### 4. Latency Trends

Get latency trends over time for system or specific endpoint.

**Endpoint:** `GET /api/performance/latency-trends`

**Query Parameters:**
- `hours` (number, optional): Lookback period in hours (default: 24)
- `endpoint` (string, optional): Filter by endpoint path (e.g., "/api/chat")

**Response:**
```json
{
  "status": "success",
  "data": {
    "trends": [
      {
        "timestamp": "2026-01-03T13:00:00Z",
        "p50": 250,
        "p95": 800,
        "p99": 1200
      },
      {
        "timestamp": "2026-01-03T14:00:00Z",
        "p50": 275,
        "p95": 850,
        "p99": 1300
      }
    ],
    "count": 2,
    "hours": 24,
    "endpoint": "all"
  }
}
```

**Examples:**
```bash
# System-wide latency trends for last 24 hours
curl -X GET http://localhost:3080/api/performance/latency-trends

# Endpoint-specific trends for last 48 hours
curl -X GET "http://localhost:3080/api/performance/latency-trends?hours=48&endpoint=/api/chat"
```

---

### 5. Throughput Trends

Get throughput trends (requests per second).

**Endpoint:** `GET /api/performance/throughput`

**Query Parameters:**
- `hours` (number, optional): Lookback period in hours (default: 24)

**Response:**
```json
{
  "status": "success",
  "data": {
    "throughput": [
      {
        "timestamp": "2026-01-03T13:00:00Z",
        "requests_total": 5000,
        "rps": "1.39"
      },
      {
        "timestamp": "2026-01-03T14:00:00Z",
        "requests_total": 6200,
        "rps": "1.72"
      }
    ],
    "count": 2,
    "hours": 24
  }
}
```

**Example:**
```bash
curl -X GET "http://localhost:3080/api/performance/throughput?hours=24"
```

---

### 6. Percentile Breakdown

Get detailed percentile breakdown with histogram data.

**Endpoint:** `GET /api/performance/percentiles`

**Query Parameters:**
- `hours` (number, optional): Lookback period in hours (default: 24)
- `endpoint` (string, optional): Filter by endpoint path

**Response:**
```json
{
  "status": "success",
  "data": {
    "percentiles": {
      "p50": 250,
      "p95": 800,
      "p99": 1200,
      "p999": 1450
    },
    "histogram": [
      { "label": "0-50ms", "count": 1000 },
      { "label": "50-100ms", "count": 2500 },
      { "label": "100-200ms", "count": 5000 },
      { "label": "200-500ms", "count": 3000 },
      { "label": "500-1000ms", "count": 500 },
      { "label": "1000-2000ms", "count": 100 },
      { "label": "2000ms+", "count": 50 }
    ],
    "sample_size": 12150,
    "endpoint": "all",
    "hours": 24
  }
}
```

**Examples:**
```bash
# System-wide percentiles
curl -X GET http://localhost:3080/api/performance/percentiles

# Endpoint-specific percentiles
curl -X GET "http://localhost:3080/api/performance/percentiles?endpoint=/api/chat&hours=48"
```

---

### 7. List Baselines

Get all performance baselines.

**Endpoint:** `GET /api/performance/baselines`

**Response:**
```json
{
  "status": "success",
  "data": {
    "baselines": [
      {
        "_id": "baseline123",
        "name": "v1.0-baseline",
        "description": "Production baseline for v1.0",
        "metrics": {
          "avg_response_time": 300,
          "p95_latency": 1000,
          "error_rate": 3.0,
          "throughput_rps": 5.0
        },
        "active": true,
        "created_at": "2026-01-01T00:00:00Z"
      }
    ],
    "count": 1
  }
}
```

**Example:**
```bash
curl -X GET http://localhost:3080/api/performance/baselines
```

---

### 8. Create Baseline

Create a new performance baseline.

**Endpoint:** `POST /api/performance/baselines`

**Request Body:**
```json
{
  "name": "v1.1-baseline",
  "description": "Production baseline for v1.1 release",
  "metrics": {
    "avg_response_time": 250,
    "p95_latency": 800,
    "error_rate": 2.0,
    "throughput_rps": 6.0
  },
  "endpoints": [
    {
      "path": "/api/chat",
      "method": "POST",
      "avg_latency": 300,
      "p95_latency": 900
    }
  ],
  "source": "manual",
  "activate": true
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "_id": "baseline456",
    "name": "v1.1-baseline",
    "description": "Production baseline for v1.1 release",
    "metrics": {
      "avg_response_time": 250,
      "p95_latency": 800,
      "error_rate": 2.0,
      "throughput_rps": 6.0
    },
    "active": true,
    "created_at": "2026-01-03T15:00:00Z"
  }
}
```

**Example:**
```bash
curl -X POST http://localhost:3080/api/performance/baselines \
  -H "Content-Type: application/json" \
  -d '{
    "name": "v1.1-baseline",
    "description": "Production baseline for v1.1",
    "metrics": {
      "avg_response_time": 250,
      "p95_latency": 800,
      "error_rate": 2.0,
      "throughput_rps": 6.0
    },
    "activate": true
  }'
```

---

### 9. Compare Against Baseline

Compare current metrics against a baseline to detect regressions.

**Endpoint:** `GET /api/performance/baseline-compare`

**Query Parameters:**
- `baseline_id` (string, optional): Baseline ID to compare against (uses active baseline if not specified)
- `hours` (number, optional): Lookback period for current metrics (default: 24)

**Response:**
```json
{
  "status": "success",
  "data": {
    "baseline": {
      "name": "v1.0-baseline",
      "metrics": {
        "avg_response_time": 300,
        "p95_latency": 1000,
        "error_rate": 3.0,
        "throughput_rps": 5.0
      }
    },
    "current": {
      "avg_response_time": 275,
      "p95_latency": 1250,
      "error_rate": 2.5,
      "throughput_rps": 5.5
    },
    "diff_percentage": {
      "avg_response_time": "-8.33",
      "p95_latency": "25.00",
      "error_rate": "-16.67",
      "throughput_rps": "10.00"
    },
    "regression_detected": true,
    "regressions": [
      {
        "metric": "p95_latency",
        "threshold": "20% increase",
        "current": 1250,
        "baseline": 1000
      }
    ]
  }
}
```

**Examples:**
```bash
# Compare against active baseline
curl -X GET http://localhost:3080/api/performance/baseline-compare

# Compare against specific baseline
curl -X GET "http://localhost:3080/api/performance/baseline-compare?baseline_id=baseline123&hours=48"
```

---

## Integration with Artillery

### Automated Load Test Import

You can automate Artillery test execution and import in a single script:

```bash
#!/bin/bash
# run-and-import-load-test.sh

SCENARIO="basic-load"
DATE=$(date +%Y-%m-%d)
TEST_NAME="${SCENARIO}-${DATE}"

echo "Running Artillery test: ${TEST_NAME}"
artillery run tests/load/${SCENARIO}.yml -o /tmp/artillery-report.json

echo "Importing results to AgentX..."
curl -X POST http://localhost:3080/api/performance/load-tests \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"${TEST_NAME}\",
    \"scenario\": \"${SCENARIO}\",
    \"raw_report\": $(cat /tmp/artillery-report.json)
  }"

echo "Load test imported successfully!"
```

### CI/CD Integration

Example GitHub Actions workflow:

```yaml
name: Performance Benchmark

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Install Artillery
        run: npm install -g artillery@latest

      - name: Run Load Test
        run: artillery run tests/load/basic-load.yml -o report.json

      - name: Import Results
        run: |
          curl -X POST ${{ secrets.AGENTX_URL }}/api/performance/load-tests \
            -H "Content-Type: application/json" \
            -d "{
              \"name\": \"ci-basic-load-$(date +%Y-%m-%d-%H%M)\",
              \"scenario\": \"basic-load\",
              \"raw_report\": $(cat report.json)
            }"

      - name: Check for Regressions
        run: |
          RESULT=$(curl -X GET ${{ secrets.AGENTX_URL }}/api/performance/baseline-compare)
          echo "$RESULT" | jq -e '.data.regression_detected == false' || exit 1
```

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "status": "error",
  "message": "Error description here"
}
```

**Common Error Codes:**
- `400` - Bad request (invalid input)
- `404` - Resource not found
- `500` - Internal server error

---

## Notes

1. **Artillery Report Format**: The API expects Artillery JSON output in standard format with `aggregate` field containing counters, rates, and summaries.

2. **Real-time Metrics**: `PerformanceSnapshot` data is collected by request middleware (not yet implemented). For now, this data will be empty until middleware is added.

3. **Baseline Management**: Only one baseline can be active at a time. Activating a new baseline automatically deactivates the previous one.

4. **Regression Thresholds**:
   - p95 latency: 20% increase over baseline triggers regression
   - Error rate: 2x increase over baseline triggers regression
   - Throughput: 20% decrease below baseline triggers regression

---

## Related Documentation

- [Artillery Documentation](https://www.artillery.io/docs)
- AgentX Load Testing Guide
- [MongoDB Schema Reference](../architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md)
