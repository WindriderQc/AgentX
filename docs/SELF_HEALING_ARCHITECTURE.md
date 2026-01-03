# Self-Healing System Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         AgentX System                            │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
        ┌───────────────────────────────────────────┐
        │      Self-Healing Dashboard (UI)          │
        │   /public/self-healing.html                │
        │   /public/js/self-healing-dashboard.js     │
        └───────────────────────────────────────────┘
                                │
                    HTTP REST API Calls
                                │
                                ▼
        ┌───────────────────────────────────────────┐
        │      Self-Healing API Routes               │
        │   /routes/self-healing.js                  │
        │                                            │
        │   GET  /api/self-healing/status            │
        │   GET  /api/self-healing/rules             │
        │   GET  /api/self-healing/history           │
        │   POST /api/self-healing/evaluate          │
        │   POST /api/self-healing/execute           │
        │   POST /api/self-healing/rules/load        │
        └───────────────────────────────────────────┘
                                │
                                ▼
        ┌───────────────────────────────────────────┐
        │      SelfHealingEngine Service             │
        │   /src/services/selfHealingEngine.js       │
        │                                            │
        │   • Rule evaluation                        │
        │   • Remediation execution                  │
        │   • Cooldown management                    │
        │   • History tracking                       │
        └───────────────────────────────────────────┘
                    │               │
                    │               │
        ┌───────────▼──┐    ┌──────▼──────────┐
        │   Config      │    │   Services      │
        │   Files       │    │                 │
        │               │    │  • ModelRouter  │
        │  rules.json   │    │  • AlertService │
        │               │    │  • MetricsSnap  │
        └───────────────┘    └─────────────────┘
                                    │
                                    ▼
                        ┌────────────────────────┐
                        │     MongoDB            │
                        │                        │
                        │  • Alerts              │
                        │  • Metrics             │
                        │  • Execution Logs      │
                        └────────────────────────┘
```

## Component Interactions

### 1. Dashboard → API Layer

```javascript
// Dashboard makes API calls
const dashboard = new SelfHealingDashboard();

// Load rules
const rules = await apiClient.get('/self-healing/rules');

// Test rule
const result = await apiClient.post('/self-healing/evaluate', {
  ruleName: 'model_slow_response_failover'
});

// Execute remediation
const execution = await apiClient.post('/self-healing/execute', {
  ruleName: 'high_error_rate_alert',
  context: { manual: true }
});
```

### 2. API Routes → Engine

```javascript
// API route handlers
router.get('/rules', async (req, res) => {
  const rules = SelfHealingEngine.getRules();
  res.json({ status: 'success', data: { rules } });
});

router.post('/execute', async (req, res) => {
  const { ruleName, context } = req.body;
  const result = await SelfHealingEngine.executeRemediation(rule, context);
  res.json({ status: 'success', data: result });
});
```

### 3. Engine → Services

```javascript
// Engine executes remediation
class SelfHealingEngine {
  async executeRemediation(rule, context) {
    switch (rule.remediation.strategy) {
      case 'model_failover':
        return await this._executeModelFailover(rule, context);

      case 'alert_only':
        const alertService = new AlertService();
        return await alertService.createAlert({...});
    }
  }
}
```

## Data Flow

### Rule Evaluation Flow

```
1. Dashboard → POST /api/self-healing/evaluate
                    ↓
2. API Route → SelfHealingEngine.evaluateRule()
                    ↓
3. Engine → Fetch metrics from MongoDB
                    ↓
4. Engine → Check threshold conditions
                    ↓
5. Engine → Check cooldown period
                    ↓
6. Engine → Return evaluation result
                    ↓
7. API Route → Return JSON response
                    ↓
8. Dashboard → Display results in modal
```

### Remediation Execution Flow

```
1. Dashboard → POST /api/self-healing/execute
                    ↓
2. API Route → SelfHealingEngine.executeRemediation()
                    ↓
3. Engine → Check approval requirements
                    ↓
4. Engine → Send trigger notifications
                    ↓
5. Engine → Execute strategy-specific action
                    ↓
6. Engine → Record execution in history
                    ↓
7. Engine → Send success/failure notifications
                    ↓
8. API Route → Return execution result
                    ↓
9. Dashboard → Update UI, show toast
```

## File Structure

```
/home/yb/codes/AgentX/
│
├── config/
│   └── self-healing-rules.json          # Rule definitions
│
├── src/services/
│   ├── selfHealingEngine.js             # Core engine logic
│   ├── alertService.js                  # Alert creation
│   └── modelRouter.js                   # Failover logic
│
├── routes/
│   └── self-healing.js                  # API endpoints
│
├── public/
│   ├── self-healing.html                # Dashboard UI page
│   └── js/
│       ├── self-healing-dashboard.js    # Dashboard logic
│       ├── utils/api-client.js          # HTTP client
│       └── toast.js                     # Notifications
│
├── models/
│   ├── Alert.js                         # Alert schema
│   └── MetricsSnapshot.js               # Metrics schema
│
└── docs/
    ├── SELF_HEALING_DASHBOARD.md        # Full documentation
    ├── SELF_HEALING_DASHBOARD_SUMMARY.md # Implementation summary
    ├── SELF_HEALING_QUICK_START.md      # Quick start guide
    └── SELF_HEALING_ARCHITECTURE.md     # This file
```

## Rule Configuration Schema

```json
{
  "name": "rule_identifier",
  "enabled": true,
  "description": "Human readable description",
  "detectionQuery": {
    "metric": "metric_name",
    "aggregation": "avg|sum|max|min|count",
    "threshold": 100,
    "comparison": "greater_than|less_than|equal",
    "window": "5m|1h|24h",
    "componentType": "ollama|agentx|qdrant",
    "componentPattern": "pattern-*"
  },
  "remediation": {
    "strategy": "model_failover|prompt_rollback|service_restart|...",
    "action": "action_description",
    "automated": true,
    "requiresApproval": false,
    "cooldown": "15m|1h|24h",
    "priority": 1
  },
  "notifications": {
    "onTrigger": ["slack", "email"],
    "onSuccess": ["slack"],
    "onFailure": ["slack", "email"]
  },
  "conditions": {
    "minOccurrences": 3,
    "timeOfDay": {
      "start": "00:00",
      "end": "23:59"
    }
  },
  "tags": ["category", "type"]
}
```

## State Management

### Dashboard State

```javascript
{
  // Configuration
  containerId: 'self-healing-container',
  statsContainerId: 'self-healing-stats',
  historyContainerId: 'self-healing-history',
  refreshInterval: 30000,

  // Data
  rules: Array<Rule>,
  executionHistory: Array<Execution>,
  engineStatus: {
    enabled: boolean,
    rules: { total, enabled, byStrategy, byPriority },
    executions: { total, recentlyExecuted, availableNow }
  },

  // Timers
  autoRefreshTimer: NodeJS.Timer,
  cooldownTimers: Map<string, Timer>
}
```

### Engine State

```javascript
{
  rules: Array<Rule>,
  executionHistory: Map<ruleName, timestamp>,
  actionQueue: Array<Action>,
  isProcessing: boolean,
  config: {
    enableAutomation: boolean,
    requireApprovalForCritical: boolean,
    maxConcurrentActions: number,
    defaultCooldownMs: number
  }
}
```

## API Response Formats

### Success Response
```json
{
  "status": "success",
  "message": "Optional message",
  "data": {
    // Response-specific data
  }
}
```

### Error Response
```json
{
  "status": "error",
  "message": "Error description",
  "error": "Detailed error message"
}
```

## Dashboard Actions

### User Actions → API Calls

| User Action | API Endpoint | Method | Result |
|-------------|-------------|--------|--------|
| Load Dashboard | `/status`, `/rules`, `/history` | GET | Display data |
| Toggle Rule | N/A (UI only) | - | Update UI |
| Test Rule | `/evaluate` | POST | Show results modal |
| Execute Rule | `/execute` | POST | Execute remediation |
| Edit Rule | N/A (planned) | PUT | Update rule |
| View History | `/history/:name` | GET | Show history modal |
| View Details | `/rules/:name` | GET | Show details modal |
| Reload Rules | `/rules/load` | POST | Reload config |
| Evaluate All | `/evaluate` | POST | Evaluate all rules |

## Security Flow

```
1. User accesses /self-healing.html
        ↓
2. Browser checks authentication cookie
        ↓
3. If not authenticated → Redirect to login
        ↓
4. Dashboard makes API calls with credentials
        ↓
5. Express middleware validates session
        ↓
6. API executes action with audit logging
        ↓
7. Response returned to dashboard
```

## Notification Flow

```
Rule Triggered
     ↓
Engine determines notification channels
     ↓
     ├─→ Slack → AlertService → Slack API
     │
     ├─→ Email → AlertService → Email Service
     │
     └─→ DataAPI Log → Logger → Console/File
```

## Metrics Integration

```
External Systems → MetricsSnapshot → MongoDB
                                          ↓
                          SelfHealingEngine.evaluateRule()
                                          ↓
                              Query metrics by:
                              • Time window
                              • Component pattern
                              • Metric type
                                          ↓
                          Apply aggregation (avg, sum, max, etc.)
                                          ↓
                          Compare to threshold
                                          ↓
                          Return evaluation result
```

## Cooldown Management

```
Rule Executed
     ↓
Record timestamp in executionHistory Map
     ↓
Dashboard refreshes and checks cooldown
     ↓
Calculate: cooldownMs - (now - lastExecution)
     ↓
If > 0: Show countdown, disable buttons
If ≤ 0: Show "Ready", enable buttons
```

## Auto-Refresh Cycle

```
Timer Tick (30s)
     ↓
Parallel API Calls:
     ├─→ GET /status
     ├─→ GET /rules
     └─→ GET /history
     ↓
Update Dashboard State
     ↓
Re-render Components:
     ├─→ Stats banner
     ├─→ Rules list
     └─→ History panel
     ↓
Wait 30s → Repeat
```

## Error Handling Strategy

```
API Call
    ↓
Try {
    ↓
    Fetch data
    ↓
    Success → Update UI
}
Catch {
    ↓
    Log error to console
    ↓
    Show toast notification
    ↓
    Graceful degradation:
    • Show cached data
    • Show placeholder
    • Disable actions
    ↓
    Retry on next refresh
}
```

## Performance Optimizations

1. **Lazy Loading**
   - Modals created on-demand
   - History limited to 50 entries
   - Pagination for large rule sets

2. **Debouncing**
   - Action buttons debounced
   - Auto-refresh staggered
   - Cooldown updates batched

3. **Caching**
   - Rules cached client-side
   - History cached between refreshes
   - Status cached temporarily

4. **Efficient Updates**
   - Only re-render changed sections
   - Use documentFragment for batch inserts
   - Minimize DOM manipulations

## Monitoring Points

Track these metrics:

- **Dashboard Load Time**: Initial render performance
- **API Response Times**: Endpoint latency
- **Refresh Cycle Duration**: Auto-refresh overhead
- **Error Rate**: Failed API calls / total calls
- **User Actions**: Test, execute, edit frequency
- **Rule Effectiveness**: Success rate by rule

## Integration Points

### With Alert System
```
Self-Healing Rule → Creates Alert via AlertService
                          ↓
                    Alert Dashboard displays
                          ↓
                    User acknowledges/resolves
```

### With Metrics System
```
External Systems → MetricsSnapshot Collection
                          ↓
                    Self-Healing Engine queries
                          ↓
                    Evaluates rules against metrics
```

### With Model Router
```
Self-Healing Rule triggers → ModelRouter.switchHost()
                                    ↓
                              Traffic rerouted to backup
                                    ↓
                              Health check performed
```

## Deployment Considerations

1. **Static Assets**: Dashboard JS/CSS served by Express
2. **API Endpoints**: Mounted at `/api/self-healing/*`
3. **Authentication**: Session-based via Express middleware
4. **Environment Variables**:
   - `SELF_HEALING_ENABLED`
   - `REQUIRE_APPROVAL`
   - `MAX_CONCURRENT_ACTIONS`

## Testing Strategy

### Unit Tests
- Dashboard methods (test, execute, edit)
- Utility functions (format, escape, calculate)
- State management

### Integration Tests
- API endpoint responses
- Engine rule evaluation
- Remediation execution

### E2E Tests
- Dashboard load and display
- User workflows (test → execute)
- Error handling

---

**Last Updated**: 2026-01-03
**Version**: 1.0
