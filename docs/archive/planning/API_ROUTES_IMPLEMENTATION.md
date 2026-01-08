# API Routes Implementation Summary
**Date:** 2026-01-02  
**Track:** T1.6 (Alert API Routes) & T2.5 (Metrics API Routes)  
**Status:** ✅ Complete

## Overview

Implemented comprehensive REST API endpoints for Alerts and Metrics, enabling:
- Alert creation, management, and rule evaluation
- Time-series metrics recording and querying
- Integration points for n8n workflows (N1.1, N4.1, N4.2)
- Real-time dashboard data feeds

## Alert API Routes (`/api/alerts`)

### Endpoints Implemented

#### 1. POST `/api/alerts`
**Purpose:** Create alert manually  
**Body:**
```json
{
  "title": "Alert Title",
  "message": "Alert description",
  "severity": "warning|critical|info",
  "source": "agentx|n8n|dataapi|external",
  "context": {},
  "channels": ["email", "slack", "webhook", "dataapi_log"]
}
```
**Response:** `201 Created` with alert ID

####2. POST `/api/alerts/evaluate`
**Purpose:** Evaluate event against configured rules  
**Body:**
```json
{
  "source": "component-id",
  "data": { "metric": value }
}
```
**Response:** `200 OK` with match status and triggered alert (if any)

#### 3. GET `/api/alerts`
**Purpose:** List/filter alerts  
**Query Params:**
- `status`: active|acknowledged|resolved
- `severity`: info|warning|critical
- `source`: agentx|n8n|dataapi|external
- `limit`: pagination (default: 50)
- `skip`: offset
- `sort`: createdAt|-createdAt (default: -severity)

#### 4. GET `/api/alerts/:id`
**Purpose:** Get specific alert by ID

#### 5. PUT `/api/alerts/:id/acknowledge`
**Purpose:** Acknowledge alert  
**Body:**
```json
{
  "acknowledgedBy": "user-id",
  "comment": "optional note"
}
```

#### 6. PUT `/api/alerts/:id/resolve`
**Purpose:** Resolve alert  
**Body:**
```json
{
  "resolvedBy": "user-id",
  "resolution": "How it was fixed",
  "method": "manual|auto|escalated"
}
```

#### 7. POST `/api/alerts/:id/delivery-status`
**Purpose:** Update delivery status (called by n8n workflows)  
**Body:**
```json
{
  "channel": "email|slack|webhook",
  "status": "sent|error",
  "timestamp": "ISO8601",
  "error": "optional error message"
}
```

#### 8. GET `/api/alerts/stats/summary`
**Purpose:** Get alert statistics  
**Returns:** Counts by status, severity, recent activity

#### 9. POST `/api/alerts/rules/load`
**Purpose:** Load/reload alert rules from configuration  
**Body (optional):**
```json
{
  "rules": [...]  // Custom rules array
}
```

#### 10. GET `/api/alerts/test/config`
**Purpose:** Debug endpoint - shows current alert configuration

---

## Metrics API Routes (`/api/metrics`)

### New Endpoints Implemented (Track 2)

#### 1. POST `/api/metrics/health`
**Purpose:** Record health metric  
**Body:**
```json
{
  "componentType": "model|workflow|service",
  "componentId": "claude-3-opus",
  "healthData": {
    "status": "healthy|degraded|down",
    "responseTime": 150,
    "errorRate": 0.01,
    "availability": 99.9
  }
}
```

#### 2. POST `/api/metrics/performance`
**Purpose:** Record performance metric  
**Body:**
```json
{
  "componentType": "workflow",
  "componentId": "N1.1-health-check",
  "perfData": {
    "executionTime": 250,
    "throughput": 100,
    "latency": 50,
    "queueDepth": 5
  }
}
```

#### 3. POST `/api/metrics/cost`
**Purpose:** Record cost metric  
**Body:**
```json
{
  "model": "gpt-4",
  "costData": {
    "inputTokens": 1000,
    "outputTokens": 500,
    "totalCost": 0.035
  }
}
```

#### 4. POST `/api/metrics/resource`
**Purpose:** Record resource usage  
**Body:**
```json
{
  "componentId": "agentx-server",
  "resourceData": {
    "cpuUsage": 45.2,
    "memoryUsage": 512,
    "diskUsage": 1024
  }
}
```

#### 5. POST `/api/metrics/quality`
**Purpose:** Record quality metric  
**Body:**
```json
{
  "componentId": "prompt-v2",
  "qualityData": {
    "accuracyScore": 0.92,
    "coherenceScore": 0.88
  }
}
```

#### 6. POST `/api/metrics/usage`
**Purpose:** Record usage statistics  
**Body:**
```json
{
  "componentId": "api-endpoint-chat",
  "usageData": {
    "requestCount": 150,
    "activeUsers": 25
  }
}
```

#### 7. GET `/api/metrics/timeseries`
**Purpose:** Query time-series data  
**Query Params:**
- `componentId`: Required
- `metricName`: Required (e.g., "responseTime")
- `from`: ISO8601 timestamp (required)
- `to`: ISO8601 timestamp (optional, defaults to now)
- `granularity`: raw|5m|1h|1d (optional, default: raw)

**Example:**
```
GET /api/metrics/timeseries?componentId=claude-3-opus&metricName=responseTime&from=2026-01-01T00:00:00Z&granularity=1h
```

#### 8. GET `/api/metrics/trends`
**Purpose:** Period-over-period comparison  
**Query Params:**
- `componentId`: Required
- `metricName`: Required
- `period`: 1h|24h|7d|30d (optional, default: 24h)

**Returns:** Current vs previous period statistics with % change

#### 9. POST `/api/metrics/aggregate`
**Purpose:** Trigger manual aggregation (normally runs hourly)

#### 10. GET `/api/metrics/latest`
**Purpose:** Get most recent value for a metric  
**Query Params:**
- `componentId`: Required
- `metricName`: Required

#### 11. GET `/api/metrics/statistics`
**Purpose:** Get aggregated statistics  
**Query Params:**
- `componentType`: Optional filter
- `metricType`: Optional filter (health|performance|cost|resource|quality|usage)
- `from`: Optional date range start
- `to`: Optional date range end

#### 12. DELETE `/api/metrics/purge`
**Purpose:** Remove old metrics (manual cleanup)  
**Query Params:**
- `retentionDays`: Optional (default: 90)

---

## Integration Points

### With n8n Workflows

#### N1.1 Health Check Workflow
```javascript
// Record health metrics
POST /api/metrics/health
{
  "componentType": "model",
  "componentId": "ollama-99",
  "healthData": {
    "status": "healthy",
    "responseTime": {{ $json.responseTime }},
    "errorRate": {{ $json.errorRate }}
  }
}

// Trigger alert evaluation
POST /api/alerts/evaluate
{
  "source": "N1.1-health-check",
  "data": {
    "componentId": "ollama-99",
    "responseTime": {{ $json.responseTime }}
  }
}
```

#### N4.1 Alert Dispatcher Workflow (To Be Implemented)
```javascript
// Webhook receives alert from AgentX
// Then updates delivery status
POST /api/alerts/{{ $json.alertId }}/delivery-status
{
  "channel": "slack",
  "status": "sent",
  "timestamp": "{{ $now }}"
}
```

#### N4.2 Metrics Aggregation Workflow (To Be Implemented)
```javascript
// Trigger aggregation
POST /api/metrics/aggregate

// Query aggregated data
GET /api/metrics/timeseries?componentId=system&metricName=totalCost&from={{ $yesterday }}&granularity=1h
```

### Authentication

All routes use `optionalAuth` middleware supporting:
1. **Session-based auth**: For web UI requests
2. **API key auth**: For n8n workflows via `x-api-key` header

```bash
# n8n request example
curl -X POST https://agentx.example.com/api/metrics/health \
  -H "x-api-key: ${AGENTX_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"componentType":"model","componentId":"ollama-99","healthData":{"status":"healthy"}}'
```

---

## Registration in server.js

Routes registered in `/home/yb/codes/AgentX/src/app.js`:

```javascript
// Line 138-144
const metricsRoutes = require('../routes/metrics');
app.use('/api/metrics', metricsRoutes);

const alertRoutes = require('../routes/alerts');
app.use('/api/alerts', alertRoutes);
```

---

## Testing

### Validation Tests Created
1. **`tests/routes/alerts.api.test.js`**: 24 test cases for alert endpoints
2. **`tests/routes/metrics.api.test.js`**: 25 test cases for metrics endpoints

### Manual Testing via curl

```bash
# Create alert
curl -X POST http://localhost:3080/api/alerts \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Alert","message":"Test","severity":"warning","source":"agentx"}'

# Record health metric
curl -X POST http://localhost:3080/api/metrics/health \
  -H "Content-Type: application/json" \
  -d '{"componentType":"model","componentId":"test","healthData":{"status":"healthy"}}'

# Query time-series
curl "http://localhost:3080/api/metrics/timeseries?componentId=test&metricName=status&from=2026-01-01T00:00:00Z"
```

---

## Dependencies

No new dependencies required. Uses existing:
- `alertService` (singleton from T1.1)
- `metricsCollector` (singleton from T2.3)
- `Alert` model (from T1.2)
- `MetricsSnapshot` model (from T2.2)
- `optionalAuth` middleware (existing)
- `logger` (winston)

---

## Error Handling

All endpoints include comprehensive error handling:
- 400 Bad Request: Missing/invalid parameters
- 404 Not Found: Alert/metric not found
- 500 Internal Server Error: Database or service errors

Error response format:
```json
{
  "status": "error",
  "message": "Human-readable error message",
  "error": "Technical error details (development only)"
}
```

---

## Next Steps

### T1.9: N4.1 Alert Dispatcher Workflow
Create n8n workflow to:
1. Receive webhook from AgentX when alert created
2. Send to Slack/email based on severity
3. Update delivery status via POST `/api/alerts/:id/delivery-status`

### T4.3: SelfHealingEngine Implementation
Integrate with alerts:
```javascript
// When alert resolved via self-healing
PUT /api/alerts/:id/resolve
{
  "resolvedBy": "self-healing-engine",
  "method": "auto",
  "resolution": "Executed remediation: restart_ollama_host"
}
```

### Dashboard Integration
Use time-series endpoints for:
- Real-time health charts
- Cost tracking dashboards
- Performance monitoring
- Alert feed widgets

---

## Files Modified

| File | Lines | Purpose |
|------|-------|---------|
| `/routes/alerts.js` | 524 | Alert management endpoints |
| `/routes/metrics.js` | 603 | Time-series metrics endpoints (extended) |
| `/src/app.js` | +4 | Route registration |
| `/tests/routes/alerts.api.test.js` | 532 | Alert API tests |
| `/tests/routes/metrics.api.test.js` | 509 | Metrics API tests |

---

## Validation Results

✅ Routes load successfully  
✅ alertService initialized (0 enabled channels in test mode)  
✅ metricsCollector initialized (90-day retention, hourly aggregation)  
✅ All 22 endpoints registered  
✅ Authentication middleware integrated  
✅ Error handling comprehensive  
✅ n8n integration patterns documented  

---

## API Documentation

### Swagger/OpenAPI (Future)
Consider generating OpenAPI specification for:
- Automatic client generation
- Interactive API explorer
- Contract testing

### Postman Collection (Future)
Create Postman collection with:
- All 22 endpoints
- Example requests/responses
- Environment variables
- Test assertions

---

**Implementation Complete:** 2026-01-02 23:45 UTC  
**Ready For:** n8n workflow development, dashboard integration, production deployment
