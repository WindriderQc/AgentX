# Performance API Testing Guide

Quick reference for testing the Performance Benchmarking Dashboard API.

## Quick Start

### 1. Run the automated test script

```bash
# Test all 8 endpoints
./scripts/test-performance-api.sh

# Test against different server
./scripts/test-performance-api.sh http://192.168.2.99:3080
```

### 2. Run Jest tests

```bash
# Test Artillery parser
npm test -- tests/services/artilleryParser.test.js

# Run all tests
npm test
```

## Manual Testing with curl

### Import Artillery Report

```bash
curl -X POST http://localhost:3080/api/performance/load-tests \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{
  "name": "basic-load-2026-01-03",
  "scenario": "basic-load",
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
EOF
```

### Using Sample Report

```bash
# Import from fixture file
curl -X POST http://localhost:3080/api/performance/load-tests \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"test-load-$(date +%Y%m%d-%H%M%S)\",
    \"scenario\": \"sample-test\",
    \"raw_report\": $(cat tests/fixtures/sample-artillery-report.json)
  }"
```

### Get Dashboard

```bash
curl -X GET http://localhost:3080/api/performance/dashboard | jq '.'
```

### List Load Tests

```bash
# Last 20 tests
curl -X GET http://localhost:3080/api/performance/load-tests | jq '.'

# Filter by scenario
curl -X GET "http://localhost:3080/api/performance/load-tests?scenario=basic-load&limit=10" | jq '.'
```

### Latency Trends

```bash
# System-wide for last 24 hours
curl -X GET http://localhost:3080/api/performance/latency-trends | jq '.'

# Endpoint-specific
curl -X GET "http://localhost:3080/api/performance/latency-trends?endpoint=/api/chat&hours=48" | jq '.'
```

### Throughput

```bash
curl -X GET "http://localhost:3080/api/performance/throughput?hours=24" | jq '.'
```

### Percentiles

```bash
curl -X GET http://localhost:3080/api/performance/percentiles | jq '.'
```

### Create Baseline

```bash
curl -X POST http://localhost:3080/api/performance/baselines \
  -H "Content-Type: application/json" \
  -d '{
    "name": "v1.0-baseline",
    "description": "Production baseline for v1.0",
    "metrics": {
      "avg_response_time": 250,
      "p95_latency": 800,
      "error_rate": 2.0,
      "throughput_rps": 5.0
    },
    "activate": true
  }' | jq '.'
```

### List Baselines

```bash
curl -X GET http://localhost:3080/api/performance/baselines | jq '.'
```

### Compare Against Baseline

```bash
# Against active baseline
curl -X GET http://localhost:3080/api/performance/baseline-compare | jq '.'

# Against specific baseline
curl -X GET "http://localhost:3080/api/performance/baseline-compare?baseline_id=abc123" | jq '.'
```

## Integration with Artillery

### Run Artillery and Auto-Import

```bash
#!/bin/bash
# save as: run-load-test.sh

SCENARIO="basic-load"
artillery run tests/load/${SCENARIO}.yml -o /tmp/report.json

curl -X POST http://localhost:3080/api/performance/load-tests \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"${SCENARIO}-$(date +%Y%m%d-%H%M%S)\",
    \"scenario\": \"${SCENARIO}\",
    \"raw_report\": $(cat /tmp/report.json)
  }" | jq '.'
```

### Sample Artillery Config

```yaml
# tests/load/basic-load.yml
config:
  target: "http://localhost:3080"
  phases:
    - duration: 60
      arrivalRate: 5
      name: "Warm up"
    - duration: 120
      arrivalRate: 10
      name: "Sustained load"

scenarios:
  - name: "Chat API Test"
    flow:
      - post:
          url: "/api/chat"
          json:
            message: "Hello, test"
            model: "llama3.2"
```

## Expected Responses

### Success Response

```json
{
  "status": "success",
  "data": { ... }
}
```

### Error Response

```json
{
  "status": "error",
  "message": "Error description"
}
```

## Troubleshooting

### Issue: "Invalid Artillery report"

Check that your Artillery JSON contains:
- `aggregate` field
- `aggregate.counters`
- `aggregate.summaries`

### Issue: "No baseline found"

Create a baseline first:
```bash
curl -X POST http://localhost:3080/api/performance/baselines \
  -H "Content-Type: application/json" \
  -d '{"name":"default","metrics":{...},"activate":true}'
```

### Issue: Empty trends/snapshots

`PerformanceSnapshot` data requires request middleware (not yet implemented).
Load test data will populate immediately, but real-time snapshots need middleware.

## Next Steps

1. **Build Frontend Dashboard**: Create `/public/performance.html` with Chart.js visualizations
2. **Add Request Middleware**: Implement performance tracking middleware to populate `PerformanceSnapshot`
3. **Set Up Alerting**: Integrate with n8n workflows for regression alerts
4. **CI/CD Integration**: Add performance tests to GitHub Actions workflow

## Related Files

- Models: `/models/Performance*.js`
- Routes: `/routes/performance.js`
- Parser: `/src/services/artilleryParser.js`
- Tests: `/tests/services/artilleryParser.test.js`
- API Docs: `/docs/api/PERFORMANCE_API.md`
