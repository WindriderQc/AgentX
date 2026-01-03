# Agent Persona Pattern for n8n Workflows

## Overview

AgentX uses **Agent Personas** - recurring n8n workflows with specific roles and responsibilities that maintain system health, data quality, and operational awareness. Each persona has a distinct purpose, schedule, and behavior pattern.

## Design Philosophy

**Core Principle:** Automated workflows should behave like specialized agents with clear personalities and responsibilities.

- **Persona-Driven:** Each workflow embodies a specific role (Janitor, Curator, Auditor, etc.)
- **Proactive:** Agents detect and respond to issues without human intervention
- **Observable:** All agents log metrics and trigger alerts through standardized APIs
- **Resilient:** Failures are graceful and logged, never blocking the workflow
- **Scheduled:** Run on predictable intervals with manual webhook overrides

## Standard Agent Architecture

Every agent workflow follows this pattern:

```
┌──────────────┐
│   TRIGGERS   │  → Schedule (cron) + Webhook (manual)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  COLLECTION  │  → Parallel HTTP health checks with continueOnFail
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  TRANSFORM   │  → Normalize to metrics format (component, value, metadata)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│    RECORD    │  → POST /api/metrics/{type} for each component
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  AGGREGATE   │  → Combine results, calculate overall status
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   EVALUATE   │  → POST /api/alerts/evaluate for state changes
└──────┬───────┘
       │
       ▼
┌──────────────┐
│    ALERT     │  → POST /api/alerts if degraded (IF condition)
└──────────────┘
```

## Persona Definitions

### 1. **Janitor** 🧹 (System Health Monitor)

**Role:** Maintains system hygiene by monitoring component health and cleaning up issues

**Responsibilities:**
- Check health of all system components (AgentX, DataAPI, Ollama instances)
- Record health metrics and response times
- Detect degraded states and trigger alerts
- Monitor for slow responses (>2s latency)

**Schedule:** Every 5 minutes
**Canonical Implementation:** `N1.1.json`
**Metrics Type:** `health`
**Components Monitored:**
- `agentx` - AgentX API health
- `dataapi` - DataAPI health
- `ollama_99` - Primary Ollama instance (192.168.2.99)
- `ollama_12` - Secondary Ollama instance (192.168.2.12)

**Alert Triggers:**
- Component returns error or non-2xx status
- Response time exceeds 2000ms
- State change from healthy → unhealthy (stateful)

**Example Payload:**
```json
{
  "component": "agentx",
  "metric": "health_status",
  "value": 1,
  "metadata": {
    "responseTime": 45,
    "statusCode": 200,
    "timestamp": "2026-01-03T10:00:00Z"
  }
}
```

---

### 2. **Curator** 📚 (Content & Data Manager)

**Role:** Manages RAG documents, embeddings, and knowledge base quality

**Responsibilities:**
- Scan NAS folders for new documents
- Trigger RAG ingestion for changed files
- Monitor vector store health and size
- Detect and clean duplicate/stale embeddings
- Track document freshness and coverage

**Schedule:** Hourly (quick scan), Daily (full scan)
**Planned Implementations:**
- `N2.1.json` - NAS Quick Scan
- `N2.2.json` - NAS Full Scan
- `N2.3.json` - RAG Ingest Orchestrator
**Metrics Type:** `quality`
**Components Monitored:**
- `vector_store` - Qdrant/in-memory health
- `rag_coverage` - Document ingestion rate
- `embedding_quality` - Chunk quality scores

---

### 3. **Auditor** 🔍 (Performance & Cost Tracker)

**Role:** Monitors performance metrics, costs, and resource utilization

**Responsibilities:**
- Track LLM inference latency and throughput
- Monitor token usage and cost metrics
- Detect performance regressions
- Alert on budget overruns or quota limits
- Generate usage reports

**Schedule:** Every 15 minutes (metrics), Daily (reports)
**Planned Implementations:**
- `N3.1.json` - Model Monitor (latency tracking)
- `N3.2.json` - AI Query Performance Auditor
**Metrics Type:** `performance`, `cost`
**Components Monitored:**
- `ollama_inference` - Model inference performance
- `token_usage` - Token consumption rates
- `cost_tracking` - Per-model cost metrics

---

### 4. **Guardian** 🛡️ (Security & Anomaly Detector)

**Role:** Protects system integrity and detects anomalous behavior

**Responsibilities:**
- Monitor authentication failures and rate limits
- Detect unusual API usage patterns
- Track security events (injection attempts, etc.)
- Alert on suspicious activities
- Enforce quotas and access controls

**Schedule:** Real-time (webhook-driven) + Every 10 minutes
**Planned Implementation:** `N4.1.json`
**Metrics Type:** `security`
**Components Monitored:**
- `auth_failures` - Failed login attempts
- `rate_limit_hits` - Rate limiter triggers
- `anomaly_detection` - ML-based anomaly scores

---

### 5. **Analyst** 📊 (Feedback & Improvement Loop)

**Role:** Analyzes user feedback and prompt performance for continuous improvement

**Responsibilities:**
- Aggregate feedback metrics (positive/negative rates)
- Identify low-performing prompts
- Sample failing conversations for analysis
- Generate improvement recommendations
- Track A/B test outcomes

**Schedule:** Daily (analysis), Weekly (reports)
**Current Implementation:** `N5.1.json` - Feedback Analysis
**Metrics Type:** `quality`, `usage`
**Components Monitored:**
- `prompt_performance` - Per-prompt success rates
- `feedback_trends` - User satisfaction over time
- `conversation_quality` - Interaction quality scores

---

## API Integration Standards

### Metrics Recording

All agents **MUST** record metrics using the standard format:

**Endpoint:** `POST /api/metrics/{type}`

**Payload:**
```json
{
  "componentId": "string",      // Component identifier (e.g., "agentx", "ollama_99")
  "value": 0.0,                 // Numeric metric value (0-1 for health, ms for latency, etc.)
  "metadata": {                 // Optional context
    "statusCode": 200,
    "responseTime": 45,
    "timestamp": "ISO-8601",
    "custom_field": "value"
  },
  "timestamp": "ISO-8601"       // Optional, defaults to now
}
```

**Metric Types:**
- `health` - Binary health status (1 = healthy, 0 = unhealthy)
- `performance` - Latency, throughput, resource usage
- `cost` - Token costs, API costs
- `quality` - Embedding quality, prompt performance
- `usage` - Request counts, user activity
- `resource` - CPU, memory, disk usage

### Alert Evaluation

Agents **SHOULD** evaluate alerts for state changes:

**Endpoint:** `POST /api/alerts/evaluate`

**Payload:**
```json
{
  "component": "string",        // Component identifier
  "metric": "string",           // Metric name (e.g., "health_status")
  "value": 0.0,                 // Current metric value
  "metadata": {                 // Event context
    "previousValue": 1.0,
    "threshold": 1.0,
    "timestamp": "ISO-8601"
  }
}
```

**Alert Service:** Automatically evaluates against rules in `config/alert-rules.yaml`

### Manual Alert Creation

For critical issues requiring immediate attention:

**Endpoint:** `POST /api/alerts`

**Payload:**
```json
{
  "severity": "critical",       // info | warning | critical
  "title": "string",
  "message": "string",
  "source": "n8n-monitor",
  "context": {
    "component": "string",
    "detail": {}
  },
  "channels": ["dataapi_log", "slack"]
}
```

---

## Node Best Practices

### 1. HTTP Request Nodes

**Always set:**
```json
{
  "continueOnFail": true,       // Never block workflow on failures
  "options": {
    "timeout": 5000             // 5 second timeout (adjust per use case)
  }
}
```

**Authentication:**
- Use credential reference: `"httpHeaderAuth": { "id": "PIrrA2wpOppzVodi" }`
- Never hardcode API keys in workflow JSON

### 2. Transform Nodes (Code)

**Pattern for safe node references:**
```javascript
// ❌ Don't use $node with merged inputs
const data = $node["NodeName"].json;

// ✅ Use $input instead
const data = $input.first().json;           // First input
const all = $input.all();                   // All inputs
const second = all[1]?.json || {};          // Second input with fallback
```

**Pattern for robust status checks:**
```javascript
function isHttpOk(obj) {
  if (!obj || typeof obj !== 'object') return false;
  // n8n HTTP Request node returns { error: {...} } on failure
  if (obj.error) return false;
  return true;
}

function safeGet(nodeName) {
  try {
    const items = $items(nodeName);
    return items && items[0] ? items[0].json : null;
  } catch (e) {
    return null;
  }
}
```

### 3. Stateful Detection

**Use workflow static data for state tracking:**
```javascript
const staticData = $getWorkflowStaticData('global');
const previous = staticData.lastStates || {};

// Detect state changes
const currentValue = isHealthy ? 1 : 0;
const previousValue = previous[componentId]?.value;
const changed = previousValue === undefined || previousValue !== currentValue;

// Only send alert if state changed
if (changed) {
  // Record event
}

// Update state
staticData.lastStates = {
  ...previous,
  [componentId]: { value: currentValue, timestamp: new Date().toISOString() }
};
```

### 4. Trigger Setup

**Dual triggers (schedule + webhook):**
```json
{
  "nodes": [
    {
      "name": "Schedule (Every 5 min)",
      "type": "n8n-nodes-base.scheduleTrigger",
      "parameters": {
        "rule": {
          "interval": [{ "field": "minutes", "minutesInterval": 5 }]
        }
      }
    },
    {
      "name": "Webhook (Manual)",
      "type": "n8n-nodes-base.webhook",
      "parameters": {
        "httpMethod": "POST",
        "path": "agent-persona-name",
        "responseMode": "lastNode"
      }
    },
    {
      "name": "Merge Triggers",
      "type": "n8n-nodes-base.merge"
    }
  ]
}
```

**Webhook URLs:** `https://n8n.specialblend.icu/webhook/{path}`

---

## Workflow Naming Convention

**Format:** `SBQC - N{category}.{number} {Persona Name} ({schedule})`

**Examples:**
- `SBQC - N1.1 System Health Check (5 min)` - Janitor
- `SBQC - N2.1 NAS Scan (hourly)` - Curator
- `SBQC - N3.1 Model Health & Latency Monitor (15 min)` - Auditor
- `SBQC - N4.1 Security Watcher (10 min)` - Guardian
- `SBQC - N5.1 Feedback Analysis (daily)` - Analyst

**Categories:**
- **N1.x** - Infrastructure health (Janitor)
- **N2.x** - Content/data management (Curator)
- **N3.x** - Performance/cost monitoring (Auditor)
- **N4.x** - Security/anomalies (Guardian)
- **N5.x** - Feedback/improvement (Analyst)

---

## File Organization

```
AgentC/
├── AGENT_PERSONAS.md          # This file
├── README.md                  # Quick start guide
├── WORKFLOW_TEMPLATE.json     # Template for new agents
├── N1.1.json                 # Janitor: System Health Check
├── N1.2.json                 # Janitor: Service Availability
├── N1.3.json                 # Janitor: Ops Diagnostic
├── N2.1.json                 # Curator: NAS Quick Scan
├── N2.2.json                 # Curator: NAS Full Scan
├── N2.3.json                 # Curator: RAG Ingest
├── N3.1.json                 # Auditor: Model Monitor
├── N3.2.json                 # Auditor: AI Query Performance
├── N4.1.json                 # Guardian: Security Monitor (planned)
├── N5.1.json                 # Analyst: Feedback Analysis
└── N5.2.json                 # Analyst: Prompt Improvement (planned)
```

---

## Development Workflow

### Creating a New Agent

1. **Define the persona:**
   - What role does it play?
   - What metrics does it collect?
   - What alerts does it trigger?
   - How often should it run?

2. **Copy the template:**
   ```bash
   cp AgentC/WORKFLOW_TEMPLATE.json AgentC/N{X}.{Y}.json
   ```

3. **Customize the workflow:**
   - Update workflow name and description
   - Configure schedule trigger (cron)
   - Add health check nodes (HTTP requests)
   - Add transform nodes (standardize to metrics format)
   - Add record nodes (POST to `/api/metrics/{type}`)
   - Add alert evaluation (POST to `/api/alerts/evaluate`)
   - Add conditional alert (IF → POST to `/api/alerts`)

4. **Test locally:**
   ```bash
   # Validate JSON
   jq empty AgentC/N{X}.{Y}.json

   # Deploy to n8n
   ./scripts/deploy-n8n-workflows.sh N{X}.{Y}.json

   # Trigger manually via webhook
   curl -X POST https://n8n.specialblend.icu/webhook/{webhook-path} \
     -H "Content-Type: application/json" \
     -d '{"test": true}'
   ```

5. **Configure alert rules:**
   - Add rules to `config/alert-rules.yaml`
   - Reload rules via `POST /api/alerts/rules/load`

6. **Monitor and iterate:**
   - Check metrics: `GET /api/metrics/query?componentId={id}`
   - Review alerts: `GET /api/alerts?severity=critical`
   - Adjust thresholds and schedules as needed

### Updating Existing Agents

1. Edit workflow JSON in `AgentC/`
2. Validate: `jq empty AgentC/N{X}.{Y}.json`
3. Commit: `git add AgentC/N{X}.{Y}.json && git commit -m "fix: Update N{X}.{Y} logic"`
4. Deploy: `./scripts/deploy-n8n-workflows.sh N{X}.{Y}.json`
5. Test via webhook or wait for next scheduled run

---

## Alert Rule Configuration

Agents work with the **AlertService** which evaluates events against rules defined in `config/alert-rules.yaml`.

### Example Rule for Janitor (Health Check)

```yaml
- id: "health_check_failed"
  name: "Component Health Check Failed"
  description: "Triggered when a system component becomes unhealthy"
  enabled: true
  conditions:
    component: "*"              # Match any component
    metric: "health_status"
    operator: "=="
    threshold: 0                # Unhealthy = 0
  severity: "critical"
  channels: ["dataapi_log", "slack"]
  cooldown: 900000             # 15 minutes
  maxOccurrences: 3            # Alert up to 3 times
  actions:
    - type: "dataapi_log"
      params:
        category: "system-health"
        priority: "high"
```

### Stateful Alerting

**Best Practice:** Use workflow static data to track state changes and only alert on transitions (healthy → unhealthy, not every unhealthy check).

**Benefits:**
- Reduces alert noise
- Captures meaningful state changes
- Integrates with cooldown mechanisms

---

## Monitoring Agent Health

### Check Agent Execution

**n8n UI:** http://192.168.2.199:5678
- View execution history
- Inspect node outputs
- Debug failures

### Query Metrics

```bash
# Get latest health metric for a component
curl "http://localhost:3080/api/metrics/latest?componentId=agentx&type=health"

# Query metrics over time
curl "http://localhost:3080/api/metrics/query?componentId=agentx&from=2026-01-01T00:00:00Z"
```

### Review Alerts

```bash
# List recent critical alerts
curl "http://localhost:3080/api/alerts?severity=critical&limit=10"

# Get alert statistics
curl "http://localhost:3080/api/alerts/statistics?from=2026-01-01T00:00:00Z"
```

---

## Troubleshooting

### Agent Not Running

**Check:**
1. Workflow is active in n8n UI
2. Schedule trigger is enabled
3. Webhook path is correct
4. No syntax errors in JSON (`jq empty AgentC/N{X}.{Y}.json`)

### Metrics Not Recording

**Check:**
1. AgentX is running (`curl http://localhost:3080/health`)
2. Payload matches API contract (componentId, value are required)
3. Node has `continueOnFail: true` so failures don't block
4. Check AgentX logs: `pm2 logs agentx --lines 100`

### Alerts Not Triggering

**Check:**
1. Alert rules are loaded: `GET /api/alerts/test/config`
2. Event matches rule conditions (component, metric, threshold)
3. Alert is not in cooldown period
4. MaxOccurrences not exceeded
5. Check alert logs: `pm2 logs agentx --lines 100 | grep alert`

---

## Future Enhancements

### Planned Personas

- **Optimizer** 🔧 - Auto-tunes prompts and model selection
- **Librarian** 📖 - Manages conversation history and exports
- **Scheduler** ⏰ - Coordinates multi-agent workflows
- **Reporter** 📰 - Generates automated status reports

### Advanced Patterns

- **Multi-agent coordination** - Agents trigger each other via webhooks
- **Adaptive scheduling** - Frequency adjusts based on system load
- **Self-healing** - Agents automatically remediate issues (restart services, clear caches)
- **Predictive alerting** - ML-based anomaly detection before failures

---

## References

- **Workflow Specs:** [../docs/SBQC-Stack-Final/04-N8N-WORKFLOWS.md](../docs/SBQC-Stack-Final/04-N8N-WORKFLOWS.md)
- **API Reference:** [../docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md](../docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md)
- **Metrics API:** [../routes/metrics.js](../routes/metrics.js)
- **Alerts API:** [../routes/alerts.js](../routes/alerts.js)
- **Alert Rules:** [../config/alert-rules.yaml](../config/alert-rules.yaml)
- **n8n Documentation:** https://docs.n8n.io/

---

**Version:** 1.0.0
**Last Updated:** 2026-01-03
**Maintained By:** AgentX Core Team
