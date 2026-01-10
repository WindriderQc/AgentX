# 🚀 Quick Start Guide: SelfHealingEngine

**Status:** ✅ Operational (11 rules loaded)  
**API Base:** `http://localhost:3080/api/self-healing`  
**Version:** 1.0 (January 2, 2026)

---

## 📋 Quick Commands

### Check Status
```bash
curl http://localhost:3080/api/self-healing/status | jq
```

### List All Rules
```bash
curl http://localhost:3080/api/self-healing/rules | jq '.data.rules[] | {name, strategy: .remediation.strategy, priority: .remediation.priority}'
```

### Get Specific Rule
```bash
curl http://localhost:3080/api/self-healing/rules/model_slow_response_failover | jq
```

### Evaluate All Rules
```bash
curl -X POST http://localhost:3080/api/self-healing/evaluate | jq
```

### Execute Specific Rule (Manual Trigger)
```bash
curl -X POST http://localhost:3080/api/self-healing/execute \
  -H "Content-Type: application/json" \
  -d '{
    "ruleName": "model_slow_response_failover",
    "context": {
      "component": "ollama-main",
      "triggeredBy": "manual"
    }
  }' | jq
```

### Get Execution History
```bash
curl http://localhost:3080/api/self-healing/history | jq
```

### Reload Rules from Config
```bash
curl -X POST http://localhost:3080/api/self-healing/rules/load | jq
```

---

## 📊 Available Rules (11 Total)

| Rule Name | Priority | Strategy | Auto | Approval |
|-----------|----------|----------|------|----------|
| model_slow_response_failover | P1 | model_failover | ✅ | ❌ |
| agentx_down_restart | P1 | service_restart | ❌ | ✅ |
| prompt_low_quality_rollback | P2 | prompt_rollback | ✅ | ❌ |
| cost_spike_throttle | P2 | throttle_requests | ❌ | ✅ |
| mongodb_connection_degraded | P2 | alert_only | ✅ | ❌ |
| ollama_token_throughput_low | P2 | model_failover | ❌ | ✅ |
| high_error_rate_alert | P3 | alert_only | ✅ | ❌ |
| n8n_workflow_execution_failure | P3 | alert_only | ✅ | ❌ |
| system_disk_usage_high | P3 | alert_only | ✅ | ❌ |
| rag_ingestion_failure_alert | P4 | alert_only | ✅ | ❌ |
| conversation_quality_degrading | P4 | alert_only | ✅ | ❌ |

**Disabled:** ollama_memory_high_scale_up (P3, requires approval)

---

## 🔧 Remediation Strategies

### 1. model_failover
**What it does:** Switches Ollama host from primary to backup  
**Use case:** When primary Ollama host is slow or unresponsive  
**Example rules:** model_slow_response_failover, ollama_token_throughput_low

### 2. prompt_rollback
**What it does:** Reverts to previous prompt version  
**Use case:** When prompt quality metrics drop significantly  
**Example rules:** prompt_low_quality_rollback

### 3. service_restart
**What it does:** Restarts AgentX service via PM2  
**Use case:** When service health checks fail  
**Example rules:** agentx_down_restart  
**⚠️ Requires approval**

### 4. throttle_requests
**What it does:** Enables aggressive rate limiting  
**Use case:** When daily costs exceed budget  
**Example rules:** cost_spike_throttle  
**⚠️ Requires approval**

### 5. alert_only
**What it does:** Sends notifications without taking action  
**Use case:** Issues requiring manual investigation  
**Example rules:** high_error_rate_alert, rag_ingestion_failure_alert

---

## ⚙️ Environment Variables

```bash
# Enable/disable automation
SELF_HEALING_ENABLED=true

# Require approval for critical actions
REQUIRE_APPROVAL=true

# Max concurrent remediation actions
MAX_CONCURRENT_ACTIONS=3
```

---

## 🎯 Integration Points

### With AlertService
```javascript
// SelfHealingEngine uses AlertService for notifications
const alertService = new AlertService();
await alertService.createAlert({
  ruleId: rule.name,
  severity: 'high',
  title: rule.description,
  channels: ['slack', 'email']
});
```

### With MetricsCollector
```javascript
// SelfHealingEngine queries MetricsSnapshot for condition evaluation
const metrics = await MetricsSnapshot.find({
  timestamp: { $gte: startTime },
  metricType: 'performance',
  component: /ollama-.*/
});
```

### With ModelRouter
```javascript
// SelfHealingEngine uses ModelRouter for failover
const ModelRouter = require('./modelRouter');
const currentHost = ModelRouter.getActiveHost();
const backupHost = ModelRouter.getBackupHost();
ModelRouter.switchHost(backupHost);
```

---

## 🧪 Testing

### Test Rule Evaluation (Dry Run)
```javascript
// In Node.js REPL or script
const SelfHealingEngine = require('./src/services/selfHealingEngine');

// Load rules
await SelfHealingEngine.loadRules();

// Evaluate without executing
const results = await SelfHealingEngine.evaluateAndExecute();
console.log(results);
```

### Simulate Metric Breach
```javascript
// Trigger rule by posting breaching metric
curl -X POST http://localhost:3080/api/metrics/performance \
  -H "Content-Type: application/json" \
  -d '{
    "component": "ollama-main",
    "value": 6000,
    "metadata": {
      "metric": "avg_response_time",
      "threshold": 5000
    }
  }'

// Then evaluate rules
curl -X POST http://localhost:3080/api/self-healing/evaluate
```

---

## 📈 Monitoring

### Check Engine Health
```bash
# Status endpoint shows:
# - Enabled/disabled state
# - Rule counts by strategy
# - Rule counts by priority
# - Recent execution statistics
curl http://localhost:3080/api/self-healing/status | jq '.data'
```

### Monitor Execution History
```bash
# Shows last execution time and cooldown remaining
curl http://localhost:3080/api/self-healing/history | jq '.data.history[] | {rule: .ruleName, lastExecuted, cooldownRemaining}'
```

### PM2 Logs
```bash
# Watch for self-healing events
pm2 logs agentx | grep -i "self-healing\|remediation"
```

---

## 🔥 Common Scenarios

### Scenario 1: Ollama Host Failover
```bash
# 1. Primary Ollama becomes slow
# 2. SelfHealingEngine detects avg_response_time > 5000ms
# 3. Triggers model_slow_response_failover rule
# 4. Switches to backup host (192.168.2.12)
# 5. Verifies backup is healthy
# 6. Sends success notification to Slack
```

### Scenario 2: High Error Rate Alert
```bash
# 1. Error rate exceeds 5%
# 2. SelfHealingEngine detects error_rate > 0.05
# 3. Triggers high_error_rate_alert rule
# 4. Sends alert to Slack + Email (no action taken)
# 5. Operations team investigates manually
```

### Scenario 3: Cost Budget Exceeded
```bash
# 1. Daily cost exceeds $50
# 2. SelfHealingEngine detects daily_cost > 50
# 3. Triggers cost_spike_throttle rule
# 4. ⚠️ Waits for manual approval (requires approval)
# 5. If approved: enables rate limiting
# 6. Sends notifications on trigger and completion
```

---

## 🛠️ Customization

### Add New Rule
1. Edit `/home/yb/codes/AgentX/config/self-healing-rules.json`
2. Add rule following schema
3. Validate with `npm run validate:rules`
4. Reload rules via API: `POST /api/self-healing/rules/load`

### Modify Cooldown
```json
{
  "name": "my_rule",
  "remediation": {
    "cooldown": "30m"  // Change to 5m, 1h, 24h, etc.
  }
}
```

### Disable Rule Temporarily
```json
{
  "name": "my_rule",
  "enabled": false  // Set to false
}
```

---

## 📚 Further Reading

- **Full Documentation:** `/docs/IMPLEMENTATION_SUMMARY_2026-01-02.md`
- **API Routes:** `/docs/API_ROUTES_IMPLEMENTATION.md`
- **Self-Healing Rules:** `/config/self-healing-rules.json`
- **Rule Schema:** `/config/schemas/self-healing-rule.schema.json`
- **Agent Prompts:** `/docs/AGENT_PROMPTS_PARALLEL_WORK.md`

---

**Need Help?**
- Check PM2 logs: `pm2 logs agentx --lines 50`
- Verify status: `curl http://localhost:3080/api/self-healing/status | jq`
- Test rule: `curl -X POST http://localhost:3080/api/self-healing/execute -d '{"ruleName": "..."}'`
