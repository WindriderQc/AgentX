# Agent Prompts for Parallel Implementation
**Generated:** January 2, 2026  
**Context:** Multi-Agent Enhancement Plan - Track 1, 2, 4 parallel development

---

## 🚀 High Priority Prompts

### Prompt 1: Enhance N1.1 Health Check with Alert Evaluation (T1.7)
```
I need you to enhance the existing N1.1 health check n8n workflow located at /home/yb/codes/AgentX/AgentC/N1.1.json.

Current State:
- N1.1 performs health checks for DataAPI, AgentX, and Ollama hosts every 5 minutes
- It currently only logs health status to console
- The workflow has 13 nodes checking various endpoints

Task:
Add alert evaluation integration after health checks complete. Specifically:

1. After the "Merge Health Results" node, add a new node "Evaluate Alert Rules" that:
   - POSTs to http://localhost:3080/api/alerts/evaluate
   - Sends event data with:
     * component: service name (e.g., "agentx", "dataapi", "ollama-main")
     * metric: "health_status"
     * value: 0 (healthy) or 1 (unhealthy)
     * metadata: { responseTime, statusCode, timestamp }
   - Uses x-api-key header authentication (from credentials)

2. Add conditional logic:
   - Only evaluate alerts if health status changed (not healthy → healthy or vice versa)
   - Include response time degradation detection (>2s response time)

3. Error handling:
   - Use continueOnFail: true
   - Log alert evaluation failures but don't fail the workflow

Reference Files:
- Current N1.1: /home/yb/codes/AgentX/AgentC/N1.1.json
- Alert API docs: /home/yb/codes/AgentX/docs/API_ROUTES_IMPLEMENTATION.md (lines 1-150)
- Alert evaluate endpoint spec at line 45-65

Node Configuration:
- Use HTTP Request node (v4.2)
- Method: POST
- URL: {{$json["agentx_url"]}}/api/alerts/evaluate
- Authentication: predefinedCredentialType: httpHeaderAuth
- Headers: { "Content-Type": "application/json" }
- Body: JSON with component, metric, value, metadata

Expected Output:
Updated N1.1.json with alert evaluation integrated, maintaining all existing health check functionality.
```

---

### Prompt 2: Enhance N1.1 Health Check with Metrics Recording (T2.6)
```
I need you to enhance the existing N1.1 health check n8n workflow to record metrics after each health check.

Current State:
- N1.1 workflow at /home/yb/codes/AgentX/AgentC/N1.1.json
- Performs health checks every 5 minutes
- Has 13 nodes checking DataAPI, AgentX, Ollama

Task:
Add metrics recording after health checks. For EACH component checked:

1. Add HTTP Request nodes after each health check (DataAPI, AgentX, Ollama) to record metrics:
   - POST to http://localhost:3080/api/metrics/health
   - Body structure:
     ```json
     {
       "component": "agentx" | "dataapi" | "ollama-main",
       "value": 1 (healthy) or 0 (unhealthy),
       "responseTime": <milliseconds>,
       "metadata": {
         "statusCode": 200,
         "endpoint": "/health",
         "checkedAt": "{{$now}}"
       },
       "tags": ["health-check", "automated"]
     }
     ```

2. Use Function nodes to transform health check results into metrics format

3. Add these nodes for each component:
   - "Transform to Metrics: DataAPI"
   - "Record Metrics: DataAPI"
   - "Transform to Metrics: AgentX"
   - "Record Metrics: AgentX"
   - (repeat for all Ollama hosts)

4. Error handling:
   - continueOnFail: true on all metrics recording nodes
   - Don't fail workflow if metrics recording fails

Reference Files:
- N1.1: /home/yb/codes/AgentX/AgentC/N1.1.json
- Metrics API: /home/yb/codes/AgentX/docs/API_ROUTES_IMPLEMENTATION.md (lines 150-250)
- POST /api/metrics/health endpoint specification

Node Types Needed:
- Function nodes for transformation
- HTTP Request nodes (v4.2) for API calls
- Use existing AgentX API Key credential

Expected Output:
Updated N1.1.json with metrics recording for all health checks, running every 5 minutes alongside alert evaluation.
```

---

### Prompt 3: Create N4.2 Metrics Aggregation Workflow (T2.7)
```
Create a new n8n workflow N4.2 for automated metrics aggregation.

Purpose:
Aggregate raw metrics data hourly to reduce storage and improve query performance.

Workflow Requirements:

1. **Trigger:** Schedule node
   - Run every hour at :05 minutes (e.g., 1:05, 2:05)
   - Cron expression: "5 * * * *"

2. **Aggregate Metrics Node:** HTTP Request
   - POST to http://localhost:3080/api/metrics/aggregate
   - Body: 
     ```json
     {
       "granularity": "hourly",
       "components": ["agentx", "dataapi", "ollama-main", "ollama-secondary"],
       "metricTypes": ["health", "performance", "cost", "resource", "quality", "usage"]
     }
     ```
   - Use x-api-key authentication

3. **Check Aggregation Success:** IF node
   - Condition: {{$json["status"]}} === "success"
   - True path: Log success
   - False path: Send alert

4. **Log Success:** Code node
   - Console log aggregation stats
   - Extract metrics: recordsAggregated, timeTaken

5. **Alert on Failure:** HTTP Request
   - POST to http://localhost:3080/api/alerts
   - Body:
     ```json
     {
       "ruleId": "metrics_aggregation_failure",
       "severity": "warning",
       "title": "Metrics Aggregation Failed",
       "message": "Hourly aggregation failed: {{$json["message"]}}",
       "component": "metricsCollector",
       "channels": ["slack"],
       "metadata": {
         "errorDetails": "{{$json["error"]}}",
         "timestamp": "{{$now}}"
       }
     }
     ```

6. **Data Quality Check:** Function node
   - Query last hour's metrics count
   - Alert if count < expected minimum (e.g., < 12 records per component)

Node Configuration:
- Use HTTP Request node v4.2
- All HTTP nodes: continueOnFail false (we want to know about failures)
- Timeout: 30000ms for aggregation (can be slow)
- Authentication: Use AgentX API Key credential

File Location:
Save as /home/yb/codes/AgentX/AgentC/N4.2.json

Expected Output:
Complete N4.2.json workflow file (400-500 lines) with schedule trigger, aggregation logic, success logging, and failure alerting.
```

---

### Prompt 4: Create SelfHealingEngine Test Suite (T4.4)
```
Create comprehensive test suite for the SelfHealingEngine service.

Context:
SelfHealingEngine is a new service at /home/yb/codes/AgentX/src/services/selfHealingEngine.js that:
- Loads self-healing rules from config/self-healing-rules.json
- Evaluates conditions for rule triggering
- Executes remediation actions (failover, restart, throttle, etc.)
- Tracks execution history
- Implements cooldown periods

Task:
Create /home/yb/codes/AgentX/tests/services/selfHealingEngine.test.js with these test cases:

**Test Structure:**
```javascript
describe('SelfHealingEngine', () => {
  
  describe('Rule Loading', () => {
    test('should load rules from configuration');
    test('should validate rule structure');
    test('should filter disabled rules');
    test('should throw error on invalid rule format');
  });

  describe('Condition Evaluation', () => {
    test('should evaluate metric-based conditions');
    test('should check cooldown periods');
    test('should respect minOccurrences threshold');
    test('should evaluate time-based conditions');
    test('should handle missing metrics gracefully');
  });

  describe('Remediation Actions', () => {
    test('should execute model_failover action');
    test('should execute prompt_rollback action');
    test('should execute service_restart action (with approval)');
    test('should execute alert_only action');
    test('should execute throttle_requests action');
    test('should skip actions requiring approval in automated mode');
  });

  describe('Action Execution', () => {
    test('should call ModelRouter.switchHost for model_failover');
    test('should update database for prompt_rollback');
    test('should send notifications on trigger/success/failure');
    test('should record execution in history');
    test('should implement cooldown correctly');
  });

  describe('Priority Handling', () => {
    test('should execute high-priority rules first');
    test('should queue low-priority rules');
    test('should handle concurrent rule triggers');
  });

  describe('Error Handling', () => {
    test('should continue on action failure');
    test('should send failure notifications');
    test('should not retry within cooldown period');
    test('should log errors comprehensively');
  });

});
```

**Mock Dependencies:**
- Alert model
- MetricsSnapshot model
- ModelRouter service
- AlertService
- fetch (for webhooks)

**Test Data:**
Use rules from config/self-healing-rules.json as test fixtures.

Reference Files:
- AlertService tests: /home/yb/codes/AgentX/tests/services/alertService.test.js
- Self-healing rules: /home/yb/codes/AgentX/config/self-healing-rules.json

Expected Output:
Complete test file with 25+ test cases, using Jest and Supertest, achieving >80% code coverage.
```

---

### Prompt 5: Build Alerts Dashboard Component (T1.10)
```
Create a real-time alerts dashboard web component for the AgentX UI.

Location: /home/yb/codes/AgentX/public/js/alerts-dashboard.js

Requirements:

1. **Real-time Alert Feed:**
   - Connect to /api/alerts endpoint
   - Auto-refresh every 30 seconds
   - Display alerts in descending chronological order
   - Support pagination (20 alerts per page)

2. **Alert Card UI (use MDBootstrap 5):**
   ```html
   <div class="alert alert-{severity} mb-2">
     <div class="d-flex justify-content-between">
       <h6 class="alert-heading">
         <i class="fas fa-{icon}"></i> {title}
       </h6>
       <small>{timeAgo}</small>
     </div>
     <p class="mb-1">{message}</p>
     <div class="d-flex justify-content-between align-items-center">
       <div>
         <span class="badge badge-secondary">{component}</span>
         <span class="badge badge-info">{ruleName}</span>
       </div>
       <div class="btn-group btn-group-sm">
         <button class="btn btn-outline-primary" onclick="acknowledgeAlert('{id}')">
           Acknowledge
         </button>
         <button class="btn btn-outline-success" onclick="resolveAlert('{id}')">
           Resolve
         </button>
       </div>
     </div>
   </div>
   ```

3. **Severity Mapping:**
   - critical: red, fa-exclamation-triangle
   - high: orange, fa-exclamation-circle
   - medium: yellow, fa-exclamation
   - low: blue, fa-info-circle
   - info: gray, fa-info

4. **Filters:**
   - Severity dropdown (all, critical, high, medium, low, info)
   - Status dropdown (all, new, acknowledged, resolved)
   - Component dropdown (populated dynamically)
   - Date range picker (last hour, today, last 7 days, custom)

5. **Actions:**
   - Acknowledge alert: PATCH /api/alerts/:id/acknowledge
   - Resolve alert: PATCH /api/alerts/:id/resolve
   - Bulk actions: acknowledge all, resolve all selected
   - Export to CSV

6. **Statistics Banner:**
   ```javascript
   {
     totalAlerts: 145,
     critical: 3,
     high: 12,
     medium: 45,
     unacknowledged: 23,
     avgResolutionTime: '15m'
   }
   ```

7. **Implementation Pattern:**
   - Use ES6 module pattern (import/export)
   - Fetch API for HTTP requests
   - MDBootstrap components (cards, badges, buttons)
   - Use existing /public/js/utils/api.js for API calls
   - Handle errors with toast notifications

Reference Files:
- API routes: /home/yb/codes/AgentX/docs/API_ROUTES_IMPLEMENTATION.md
- Existing UI patterns: /home/yb/codes/AgentX/public/js/*.js
- Utils: /home/yb/codes/AgentX/public/js/utils/

Expected Output:
Complete alerts-dashboard.js module with real-time updates, filtering, actions, and responsive UI.
```

---

### Prompt 6: Build Time-Series Chart Component (T2.8)
```
Create reusable time-series chart component for metrics visualization.

Location: /home/yb/codes/AgentX/public/js/metrics-charts.js

Requirements:

1. **Chart Library:** Chart.js (already loaded via CDN)

2. **Component API:**
   ```javascript
   import { TimeSeriesChart } from './metrics-charts.js';

   const chart = new TimeSeriesChart({
     containerId: 'chart-container',
     title: 'AgentX Response Time',
     metricType: 'performance',
     component: 'agentx',
     granularity: 'hourly',
     timeRange: '24h',
     refreshInterval: 60000 // 1 minute
   });

   chart.render();
   chart.startAutoRefresh();
   ```

3. **Features:**
   - Multiple metric overlays (up to 4 metrics)
   - Zoom/pan interactions
   - Hover tooltips with precise values
   - Toggle between line/bar/area charts
   - Export to PNG/CSV
   - Responsive resize

4. **Data Fetching:**
   - GET /api/metrics/{type}/timeseries?component={c}&granularity={g}&period={p}
   - Handle pagination for large datasets
   - Cache recent data (5 minutes)

5. **Chart Configuration:**
   ```javascript
   {
     type: 'line',
     data: {
       labels: timestamps,
       datasets: [{
         label: 'Response Time (ms)',
         data: values,
         borderColor: '#007bff',
         backgroundColor: 'rgba(0, 123, 255, 0.1)',
         tension: 0.4
       }]
     },
     options: {
       responsive: true,
       maintainAspectRatio: false,
       interaction: {
         mode: 'index',
         intersect: false
       },
       plugins: {
         legend: { position: 'top' },
         title: { display: true, text: title },
         tooltip: {
           callbacks: {
             label: (context) => `${context.parsed.y.toFixed(2)} ms`
           }
         },
         zoom: {
           pan: { enabled: true, mode: 'x' },
           zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }
         }
       },
       scales: {
         x: { type: 'time', time: { unit: 'hour' } },
         y: { beginAtZero: true }
       }
     }
   }
   ```

6. **Preset Views:**
   - Health Overview: All components, health metric, 24h
   - Performance Comparison: All components, response_time, 7d
   - Cost Trends: All components, cost, 30d
   - Quality Score: agentx, quality_score, 24h

7. **Error Handling:**
   - Display "No data available" message
   - Retry failed requests (3 attempts)
   - Show loading spinner during fetch

Reference Files:
- Metrics API: /home/yb/codes/AgentX/docs/API_ROUTES_IMPLEMENTATION.md (lines 150-400)
- Chart.js docs: https://www.chartjs.org/docs/latest/
- Utils: /home/yb/codes/AgentX/public/js/utils/

Expected Output:
Complete metrics-charts.js with TimeSeriesChart class, preset configurations, and comprehensive error handling.
```

---

### Prompt 7: Create N4.4 Self-Healing Orchestrator Workflow (T4.8)
```
Create n8n workflow N4.4 that orchestrates self-healing rule execution.

Purpose:
Trigger self-healing remediation actions based on detected issues.

Workflow Design:

1. **Trigger:** Webhook
   - Path: sbqc-n4-4-self-healing-trigger
   - Method: POST
   - Expected payload:
     ```json
     {
       "ruleName": "model_slow_response_failover",
       "component": "ollama-main",
       "detectedIssue": {
         "metric": "avg_response_time",
         "currentValue": 5200,
         "threshold": 5000
       },
       "remediationAction": "switch_to_backup_host",
       "requiresApproval": false
     }
     ```

2. **Extract & Validate:** Set node
   - Extract ruleName, action, requiresApproval
   - Validate required fields

3. **Check Approval Required:** IF node
   - If requiresApproval === true → Send approval request
   - If false → Execute immediately

4. **Send Approval Request:** (for manual actions)
   - POST to Slack with interactive buttons
   - Store pending approval in database
   - Wait for callback (webhook)

5. **Execute Remediation:** Switch node based on action type:
   - model_failover → Call /api/models/failover
   - prompt_rollback → Call /api/prompts/rollback
   - service_restart → Execute pm2 restart via SSH
   - throttle_requests → Update rate limit config
   - alert_only → Send alerts (skip execution)

6. **Model Failover Branch:**
   - POST /api/models/switch-host
   - Body: { currentHost, backupHost }
   - Verify new host responds < threshold

7. **Prompt Rollback Branch:**
   - GET /api/prompts/history
   - Find previous version with better metrics
   - POST /api/prompts/rollback
   - Body: { promptId, targetVersion }

8. **Service Restart Branch:**
   - HTTP Request to server admin API
   - Execute: pm2 restart agentx
   - Wait 10 seconds
   - Verify health check passes

9. **Update Execution Status:**
   - POST /api/self-healing/executions
   - Body:
     ```json
     {
       "ruleName": "{{$json.ruleName}}",
       "action": "{{$json.action}}",
       "status": "success" | "failed",
       "startTime": "{{$json.startTime}}",
       "endTime": "{{$now}}",
       "result": { ... }
     }
     ```

10. **Send Notifications:**
    - On success: Slack + DataAPI log
    - On failure: Slack + Email + PagerDuty (if critical)

11. **Respond to Webhook:**
    - Return execution result

Node Types:
- Webhook trigger (v2)
- Set (v3.4) for data extraction
- IF (v2.1) for conditionals
- Switch (v3) for action routing
- HTTP Request (v4.2) for API calls
- Function nodes for complex logic
- Merge (v3.2) for result aggregation
- Respond to Webhook (v1.1)

Credentials Needed:
- AgentX API Key
- SSH credentials (for service restart)
- Slack API token
- PagerDuty API key

File Location:
/home/yb/codes/AgentX/AgentC/N4.4.json

Expected Output:
Complete N4.4.json workflow (600-800 lines) with all remediation action branches, approval logic, and comprehensive error handling.
```

---

## 🎯 Medium Priority Prompts

### Prompt 8: Create Alert Analytics Dashboard (T1.11)
```
Build alert analytics dashboard showing trends, patterns, and insights.

Location: /home/yb/codes/AgentX/public/js/alert-analytics.js

Display:
1. Alert volume over time (line chart)
2. Alerts by severity (pie chart)
3. Top alerting components (bar chart)
4. Mean time to acknowledge (MTTA)
5. Mean time to resolution (MTTR)
6. Alert recurrence heatmap
7. Delivery success rate by channel

Use Chart.js for visualizations.
Fetch data from /api/alerts/statistics endpoint.

Reference: /home/yb/codes/AgentX/docs/API_ROUTES_IMPLEMENTATION.md
```

---

### Prompt 9: Implement Metrics Cleanup Service (T2.9)
```
Create automated metrics cleanup service to manage storage.

Location: /home/yb/codes/AgentX/src/services/metricsCleanup.js

Requirements:
- Delete raw metrics older than 90 days
- Delete hourly aggregates older than 180 days
- Delete daily aggregates older than 1 year
- Keep monthly aggregates indefinitely
- Run daily at 2 AM
- Log cleanup statistics

Reference existing service pattern from:
/home/yb/codes/AgentX/src/services/metricsCollector.js
```

---

### Prompt 10: Create Self-Healing Dashboard (T4.9)
```
Build self-healing rules dashboard for monitoring and management.

Location: /home/yb/codes/AgentX/public/js/self-healing-dashboard.js

Features:
1. List all rules with enable/disable toggles
2. Show rule execution history (last 50)
3. Display cooldown timers
4. Edit rule parameters (threshold, cooldown)
5. Test rule conditions manually
6. View rule effectiveness metrics

Integrate with SelfHealingEngine API endpoints.

Reference alert dashboard pattern:
/home/yb/codes/AgentX/public/js/alerts-dashboard.js (to be created in Prompt 5)
```

---

## 📋 Usage Instructions

**For Each Prompt:**
1. Copy the entire prompt text (including code blocks)
2. Start a new agent session
3. Paste the prompt
4. Agent will implement the feature independently
5. Review and test the output
6. Integrate into main codebase

**Priority Order:**
1. Prompts 1-2: N1.1 enhancements (critical for data pipeline)
2. Prompt 3: N4.2 metrics aggregation (storage management)
3. Prompt 4: Tests for SelfHealingEngine (quality assurance)
4. Prompts 5-6: Dashboard components (user visibility)
5. Prompt 7: N4.4 orchestrator (automation completion)
6. Prompts 8-10: Analytics and management UIs (optimization)

**Coordination:**
- Each prompt is independent and can be worked on in parallel
- No code conflicts expected (different files)
- All prompts reference existing documentation and patterns
- Final integration requires testing all components together

---

**Generated by:** GitHub Copilot  
**Session:** Multi-Agent Enhancement Plan - Parallel Development Phase
