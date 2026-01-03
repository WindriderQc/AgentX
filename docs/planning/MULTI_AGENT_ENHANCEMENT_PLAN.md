# Multi-Agent Enhancement Plan: AgentX/AgentC System
**Date:** 2026-01-02
**Status:** Planning Phase
**Execution Model:** Parallel Multi-Agent Implementation

---

## Executive Summary

This document outlines a comprehensive enhancement plan for the AgentX/AgentC monitoring and automation stack. The plan implements **ALL 6 enhancement options in parallel** using multiple specialized AI agents working concurrently. Each option is broken down into independent implementation tracks that can be executed simultaneously.

**Enhancement Options:**
1. **Alerts & Notifications** - Proactive monitoring with email/Slack/webhook alerts
2. **Historical Metrics & Analytics** - Time-series tracking with dashboards
3. **Custom Model Management** - Fine-tuned model lifecycle management
4. **Self-Healing & Automation** - Auto-optimization and failover systems
5. **Advanced Testing & CI/CD** - Production-grade QA pipeline
6. **Backup & Disaster Recovery** - Workflow versioning and rollback

**Total Estimated Effort:** 32 agent-tasks across 6 tracks
**Parallel Execution:** Yes - minimal dependencies between tracks
**Target Completion:** 2-3 development cycles (assumes 8-12 agents working in parallel)

---

## Architecture Analysis Summary

### Current System State

**AgentX Backend (Node.js/Express):**
- Service-oriented architecture (Routes → Services → Models → DB)
- 15 route files with 50+ API endpoints
- 12 core services (chatService, ragStore, embeddings, modelRouter, etc.)
- 6 MongoDB models (Conversation, PromptConfig, Feedback, ModelPricingConfig, etc.)
- PM2 cluster mode deployment with CI/CD pipeline
- Comprehensive analytics system (V5 with cost tracking)

**AgentC n8n Workflows:**
- 14 workflow files (9 production, 2 test, 3 docs/variants)
- Monitoring: System health (N1.1 - 5min), Model health (N3.1 - 10min)
- Automation: RAG ingestion (N2.3), Feedback analysis (N5.1), Workflow generation (N6.1)
- Integration: DataAPI, AgentX, Ollama (2 hosts), n8n
- Event logging to DataAPI integration sink

**Key Strengths:**
- ✅ Comprehensive monitoring (4 core services tracked)
- ✅ Analytics dashboard with cost tracking
- ✅ Prompt A/B testing and improvement loops
- ✅ RAG system with vector store abstraction
- ✅ Multi-host Ollama routing
- ✅ n8n workflow automation framework

**Critical Gaps:**
- ❌ No active alerting (passive logging only)
- ❌ No time-series metrics storage
- ❌ No custom model lifecycle management
- ❌ Limited self-healing (detection but no remediation)
- ❌ Basic testing (needs expansion)
- ❌ No backup/rollback mechanisms for workflows

---

## Track 1: Alerts & Notifications 🚨

**Goal:** Implement proactive real-time alerting system with multiple delivery channels

### Architecture Design

#### 1.1 Alert Engine Service
**New Service:** `/src/services/alertService.js`

```javascript
class AlertService {
  // Core alert logic
  async triggerAlert(event, severity, context)
  async evaluateRules(event) // Returns alert decisions

  // Delivery channels
  async sendEmail(alert)
  async sendSlack(alert)
  async sendWebhook(alert)
  async sendSMS(alert) // Optional: Twilio integration

  // Alert management
  async getActiveAlerts()
  async acknowledgeAlert(alertId)
  async muteAlert(alertId, duration)
}
```

**Alert Rule Engine:**
```javascript
rules = [
  { name: 'health_degradation', condition: 'status === degraded', severity: 'critical', channels: ['slack', 'email'] },
  { name: 'high_error_rate', condition: 'errorRate > 0.05', severity: 'warning', channels: ['slack'] },
  { name: 'prompt_performance_drop', condition: 'positiveRate < 0.7', severity: 'warning', channels: ['email'] },
  { name: 'cost_spike', condition: 'dailyCost > threshold', severity: 'warning', channels: ['email', 'webhook'] },
  { name: 'rag_ingestion_failure', condition: 'ragIngestFailed === true', severity: 'error', channels: ['slack'] }
]
```

#### 1.2 Alert Model
**New Model:** `/models/Alert.js`

```javascript
{
  eventType: String, // health_degradation, cost_spike, etc.
  severity: ['info', 'warning', 'error', 'critical'],
  status: ['active', 'acknowledged', 'resolved', 'muted'],
  title: String,
  message: String,
  context: Object, // Event-specific data
  channels: [String], // ['email', 'slack', 'webhook']
  deliveryStatus: [{
    channel: String,
    status: ['pending', 'sent', 'failed'],
    attemptedAt: Date,
    error: String
  }],
  acknowledgedBy: ObjectId,
  acknowledgedAt: Date,
  mutedUntil: Date,
  createdAt: Date,
  resolvedAt: Date
}
```

#### 1.3 API Endpoints
**New Route:** `/routes/alerts.js`

- `GET /api/alerts` - List active alerts (filter by status, severity)
- `GET /api/alerts/:id` - Get alert details
- `POST /api/alerts/:id/acknowledge` - Acknowledge alert
- `POST /api/alerts/:id/mute` - Mute alert for duration
- `POST /api/alerts/:id/resolve` - Mark alert as resolved
- `GET /api/alerts/rules` - List alert rules
- `POST /api/alerts/rules` - Create/update alert rule
- `POST /api/alerts/test` - Test alert delivery (dev/admin only)

#### 1.4 n8n Integration
**Modified Workflows:**
- **N1.1 (Health Check)** - Add Alert Service integration node
  - If degraded → POST /api/alerts with event data
  - Alert Service evaluates rules and triggers channels

- **N5.1 (Feedback Analysis)** - Add low performer alerting
  - If prompts < 70% positive → Create alert

- **New: N4.1 (Alert Dispatcher)** - Webhook triggered by Alert Service
  - Receives alert object
  - Dispatches to configured channels (Slack, Email, SMS)
  - Logs delivery status back to AgentX

#### 1.5 Configuration
**Environment Variables (.env):**
```bash
# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=alerts@yourdomain.com
SMTP_PASS=<app-password>
ALERT_EMAIL_FROM=AgentX Alerts <alerts@yourdomain.com>
ALERT_EMAIL_TO=team@yourdomain.com

# Slack
SLACK_WEBHOOK_URL=<your_slack_webhook_url>
SLACK_CHANNEL=#agentx-alerts

# Webhooks (PagerDuty, custom)
ALERT_WEBHOOK_URL=https://events.pagerduty.com/v2/enqueue
PAGERDUTY_INTEGRATION_KEY=<key>

# Alert thresholds
ALERT_ERROR_RATE_THRESHOLD=0.05
ALERT_PROMPT_PERFORMANCE_THRESHOLD=0.7
ALERT_DAILY_COST_THRESHOLD=10.00
```

#### 1.6 Frontend Dashboard
**New Page:** `/public/alerts.html`

Components:
- Active alerts table (severity badges, acknowledge buttons)
- Alert history timeline
- Alert rules configuration panel
- Test alert form (admin)
- Mute/unmute controls

---

### Implementation Tasks - Track 1

| Task ID | Description | Estimated Effort | Dependencies | Agent Type |
|---------|-------------|------------------|--------------|------------|
| **T1.1** | Create AlertService with rule engine | 4-6 hours | None | Backend Specialist |
| **T1.2** | Create Alert Mongoose model with indexes | 2 hours | None | Backend Specialist |
| **T1.3** | Implement email delivery (nodemailer) | 2-3 hours | T1.1 | Backend Specialist |
| **T1.4** | Implement Slack delivery (webhook) | 2 hours | T1.1 | Backend Specialist |
| **T1.5** | Implement generic webhook delivery | 1-2 hours | T1.1 | Backend Specialist |
| **T1.6** | Create /api/alerts routes (CRUD) | 3-4 hours | T1.1, T1.2 | Backend Specialist |
| **T1.7** | Modify N1.1 workflow (add alert integration) | 1-2 hours | T1.6 | n8n Specialist |
| **T1.8** | Modify N5.1 workflow (prompt performance alerts) | 1-2 hours | T1.6 | n8n Specialist |
| **T1.9** | Create N4.1 Alert Dispatcher workflow | 2-3 hours | T1.6 | n8n Specialist |
| **T1.10** | Build alerts.html dashboard | 4-6 hours | T1.6 | Frontend Specialist |
| **T1.11** | Write integration tests for alert delivery | 2-3 hours | T1.6 | QA Specialist |
| **T1.12** | Document alert configuration and usage | 1-2 hours | ALL | Documentation Specialist |

**Total Effort:** ~25-35 hours
**Parallel Tracks:** 3 (Backend, n8n, Frontend can work simultaneously after T1.1/T1.2 complete)

---

## Track 2: Historical Metrics & Analytics 📊

**Goal:** Store time-series metrics for trend analysis and performance tracking over time

### Architecture Design

#### 2.1 Time-Series Data Storage Strategy

**Option A: MongoDB Time-Series Collections** (Recommended - MongoDB 5.0+)
```javascript
// Create time-series collection
db.createCollection("metrics_timeseries", {
  timeseries: {
    timeField: "timestamp",
    metaField: "metadata",
    granularity: "minutes" // or "hours" for long-term storage
  }
})
```

**Option B: Separate aggregated documents** (More flexible, works with older MongoDB)
```javascript
// Store hourly/daily aggregates in separate collection
{
  _id: ObjectId,
  metric: "model_performance",
  period: "hourly|daily|weekly",
  timestamp: ISODate,
  modelName: String,
  aggregates: {
    totalConversations: Number,
    totalTokens: Number,
    avgResponseTime: Number,
    positiveRate: Number,
    totalCost: Number
  }
}
```

#### 2.2 Metrics Model
**New Model:** `/models/MetricsSnapshot.js`

```javascript
{
  timestamp: Date, // Required: time-series key
  metadata: {
    source: String, // "health_check", "analytics_job", "chat_completion"
    componentType: String, // "ollama", "agentx", "dataapi", "qdrant"
    componentId: String // "ollama-99", "agentx-main"
  },

  // Health metrics
  health: {
    status: String, // "healthy", "degraded", "down"
    responseTime: Number, // milliseconds
    errorRate: Number // 0.0 - 1.0
  },

  // Performance metrics
  performance: {
    requestCount: Number,
    successCount: Number,
    failureCount: Number,
    avgDuration: Number,
    p50Duration: Number,
    p95Duration: Number,
    p99Duration: Number
  },

  // Cost metrics
  cost: {
    totalCost: Number,
    promptTokens: Number,
    completionTokens: Number,
    currency: String
  },

  // Resource metrics
  resources: {
    cpuPercent: Number,
    memoryMB: Number,
    diskUsagePercent: Number
  },

  // Model-specific metrics
  model: {
    modelName: String,
    tokenThroughput: Number, // tokens/sec
    activeRequests: Number
  }
}
```

**Indexes:**
```javascript
{ timestamp: 1, "metadata.componentType": 1 }
{ timestamp: 1, "metadata.componentId": 1 }
{ timestamp: 1, "model.modelName": 1 }
{ timestamp: -1 } // For recent queries
```

#### 2.3 Metrics Collection Service
**New Service:** `/src/services/metricsCollector.js`

```javascript
class MetricsCollector {
  // Collection methods
  async recordHealthMetric(componentType, componentId, healthData)
  async recordPerformanceMetric(componentType, componentId, perfData)
  async recordCostMetric(model, costData)
  async recordResourceMetric(componentId, resourceData)

  // Aggregation methods
  async aggregateHourly(fromTimestamp, toTimestamp)
  async aggregateDaily(fromTimestamp, toTimestamp)

  // Query methods
  async getTimeSeries(componentId, metric, from, to, granularity)
  async getTrends(metric, period) // Returns period-over-period comparison

  // Cleanup
  async purgeOldMetrics(retentionDays) // Default: 90 days
}
```

#### 2.4 Background Aggregation Jobs
**New Scheduled Tasks (PM2 cron or n8n):**

```javascript
// Hourly aggregation job
async function aggregateHourlyMetrics() {
  const lastHour = new Date(Date.now() - 3600000);

  // Aggregate raw metrics into hourly rollups
  await MetricsSnapshot.aggregate([
    { $match: { timestamp: { $gte: lastHour } } },
    { $group: {
      _id: {
        hour: { $dateTrunc: { date: "$timestamp", unit: "hour" } },
        component: "$metadata.componentId"
      },
      avgResponseTime: { $avg: "$health.responseTime" },
      totalRequests: { $sum: "$performance.requestCount" },
      totalCost: { $sum: "$cost.totalCost" }
      // ... more aggregates
    }},
    { $merge: { into: "metrics_hourly", whenMatched: "replace" } }
  ]);
}
```

#### 2.5 API Endpoints
**New Route:** `/routes/metrics-history.js`

- `GET /api/metrics/timeseries` - Get time-series data for charting
  - Query: `component`, `metric`, `from`, `to`, `granularity` (5min|hour|day)
  - Returns: `[{timestamp, value}]` array for Chart.js

- `GET /api/metrics/trends` - Get trend analysis
  - Query: `metric`, `period` (7d|30d|90d)
  - Returns: Current vs previous period with delta %

- `GET /api/metrics/dashboard` - Get dashboard summary
  - Returns: Latest health, 24h summary, 7d trends

- `GET /api/metrics/export` - Export raw metrics
  - Query: `from`, `to`, `format` (json|csv)
  - Returns: Bulk export for external analysis

#### 2.6 Frontend Dashboard Enhancement
**Modified Page:** `/public/analytics.html` - Add time-series charts

**New Chart Components:**
1. **Health Over Time (Line Chart)**
   - Multi-line: AgentX, DataAPI, Ollama99, Ollama12
   - Y-axis: Response time (ms)
   - X-axis: Time (24h, 7d, 30d toggle)

2. **Token Usage Trends (Area Chart)**
   - Stacked area: Prompt tokens, Completion tokens
   - Shows growth over time

3. **Cost Trends (Dual-Axis Line Chart)**
   - Left Y-axis: Total cost ($)
   - Right Y-axis: Cost per conversation ($)
   - X-axis: Daily buckets

4. **Model Performance Heatmap**
   - Rows: Models
   - Columns: Time buckets (hours)
   - Color: Response time or quality score

5. **Error Rate Timeline (Bar + Line Chart)**
   - Bars: Error count per hour
   - Line: Error rate %

**Chart.js Configuration:**
```javascript
{
  type: 'line',
  data: {
    datasets: [
      { label: 'AgentX Response Time', data: timeseries, borderColor: '#4F46E5' },
      { label: 'Ollama99 Response Time', data: timeseries2, borderColor: '#10B981' }
    ]
  },
  options: {
    scales: {
      x: { type: 'time', time: { unit: 'hour' } },
      y: { beginAtZero: true, title: { text: 'Response Time (ms)' } }
    },
    plugins: {
      zoom: { pan: { enabled: true }, zoom: { wheel: { enabled: true } } }
    }
  }
}
```

#### 2.7 n8n Integration
**Modified Workflows:**
- **N1.1 (Health Check)** - Record metrics after each health check
  - POST /api/metrics/record with health data

- **New: N4.2 (Metrics Aggregation)** - Scheduled hourly
  - Trigger: Cron (every hour at :05)
  - Call aggregation endpoint
  - Purge old raw metrics (> 7 days)

---

### Implementation Tasks - Track 2

| Task ID | Description | Estimated Effort | Dependencies | Agent Type |
|---------|-------------|------------------|--------------|------------|
| **T2.1** | Design metrics schema and storage strategy | 2-3 hours | None | Database Architect |
| **T2.2** | Create MetricsSnapshot model with indexes | 2 hours | T2.1 | Backend Specialist |
| **T2.3** | Implement MetricsCollector service | 4-6 hours | T2.2 | Backend Specialist |
| **T2.4** | Create aggregation jobs (hourly/daily) | 3-4 hours | T2.3 | Backend Specialist |
| **T2.5** | Create /api/metrics/timeseries endpoints | 3-4 hours | T2.3 | Backend Specialist |
| **T2.6** | Modify N1.1 to record metrics | 1-2 hours | T2.5 | n8n Specialist |
| **T2.7** | Create N4.2 aggregation workflow | 1-2 hours | T2.5 | n8n Specialist |
| **T2.8** | Build time-series chart components | 6-8 hours | T2.5 | Frontend Specialist |
| **T2.9** | Integrate charts into analytics dashboard | 2-3 hours | T2.8 | Frontend Specialist |
| **T2.10** | Add zoom/pan/time range controls | 2-3 hours | T2.9 | Frontend Specialist |
| **T2.11** | Write aggregation tests | 2-3 hours | T2.4 | QA Specialist |
| **T2.12** | Performance test with 1M+ metrics | 3-4 hours | T2.3 | QA Specialist |
| **T2.13** | Document metrics collection and retention | 1-2 hours | ALL | Documentation Specialist |

**Total Effort:** ~30-40 hours
**Parallel Tracks:** 3 (Backend, n8n, Frontend)

---

## Track 3: Custom Model Management 🧠

**Goal:** Manage custom fine-tuned models with versioning, deployment, and performance tracking

### Architecture Design

#### 3.1 Custom Model Registry
**New Model:** `/models/CustomModel.js`

```javascript
{
  modelId: String, // Unique identifier (e.g., "custom-qwen-finance-v2")
  baseModel: String, // Base model used for fine-tuning (e.g., "qwen2.5:7b")
  displayName: String,
  description: String,

  // Version tracking
  version: String, // Semantic version (e.g., "2.1.0")
  previousVersion: ObjectId, // Link to previous version

  // Training info
  trainingData: {
    source: String, // "conversations_export", "external_dataset"
    datasetId: ObjectId,
    recordCount: Number,
    trainedAt: Date,
    trainingConfig: Object // Hyperparameters, epochs, etc.
  },

  // Deployment
  status: ['training', 'ready', 'deployed', 'deprecated', 'failed'],
  deployedAt: Date,
  ollamaHost: String, // Where model is deployed
  modelfileHash: String, // SHA256 of Modelfile

  // Performance tracking
  stats: {
    totalInferences: Number,
    avgResponseTime: Number,
    avgTokensPerSecond: Number,
    positiveRate: Number,
    costPer1kTokens: Number
  },

  // Metadata
  createdBy: ObjectId,
  tags: [String],
  notes: String,
  isActive: Boolean,

  timestamps: { createdAt, updatedAt }
}
```

#### 3.2 Model Lifecycle Service
**New Service:** `/src/services/customModelService.js`

```javascript
class CustomModelService {
  // Registration
  async registerModel(modelData) // Create new model entry
  async updateModelStatus(modelId, status, metadata)

  // Deployment
  async deployToOllama(modelId, ollamaHost) // Creates Ollama model
  async validateModelfile(modelfileContent)
  async rollbackToVersion(modelId, version)

  // Performance tracking
  async recordInference(modelId, responseTime, tokens)
  async getModelStats(modelId, period)
  async compareVersions(modelId1, modelId2)

  // Lifecycle
  async archiveModel(modelId) // Soft delete
  async deprecateVersion(modelId, reason)
}
```

#### 3.3 API Endpoints
**New Route:** `/routes/custom-models.js`

- `GET /api/custom-models` - List all custom models (filter by status, tag)
- `GET /api/custom-models/:id` - Get model details
- `POST /api/custom-models` - Register new custom model
- `PUT /api/custom-models/:id` - Update model metadata
- `DELETE /api/custom-models/:id` - Archive model
- `POST /api/custom-models/:id/deploy` - Deploy to Ollama host
- `POST /api/custom-models/:id/rollback` - Rollback to previous version
- `GET /api/custom-models/:id/stats` - Get performance statistics
- `GET /api/custom-models/compare` - Compare two model versions
- `POST /api/custom-models/:id/validate` - Validate Modelfile syntax

#### 3.4 Model Training Pipeline Integration

**Option A: n8n workflow for fine-tuning**
**New Workflow: N4.3 (Model Fine-Tuning)**
```
1. Trigger: Manual webhook or scheduled
2. Export training dataset: GET /api/dataset/conversations?format=jsonl&limit=5000
3. Upload to fine-tuning service (OpenAI, Anthropic, or local)
4. Poll training status
5. Download fine-tuned weights
6. Convert to Ollama Modelfile format
7. POST /api/custom-models (register)
8. Deploy via POST /api/custom-models/:id/deploy
9. Notify team of new model availability
```

**Option B: Local fine-tuning (Ollama + LoRA)**
```bash
# Script: scripts/fine-tune-model.sh
ollama create custom-qwen-finance-v2 -f ./Modelfile
# Modelfile contains:
FROM qwen2.5:7b
ADAPTER ./lora-weights.bin
SYSTEM "You are a financial analysis assistant..."
```

#### 3.5 Frontend Dashboard
**New Page:** `/public/models.html`

Components:
1. **Model Registry Table**
   - Columns: Name, Version, Base Model, Status, Performance, Actions
   - Actions: Deploy, Rollback, Archive, View Stats

2. **Model Version Timeline**
   - Visual timeline showing version history
   - Performance comparison overlays

3. **Deployment Panel**
   - Select Ollama host
   - Preview Modelfile
   - Deploy button with validation

4. **Performance Comparison Chart**
   - Side-by-side metrics for model versions
   - A/B test results if available

---

### Implementation Tasks - Track 3

| Task ID | Description | Estimated Effort | Dependencies | Agent Type |
|---------|-------------|------------------|--------------|------------|
| **T3.1** | Design CustomModel schema | 2 hours | None | Database Architect |
| **T3.2** | Create CustomModel Mongoose model | 2 hours | T3.1 | Backend Specialist |
| **T3.3** | Implement CustomModelService | 5-7 hours | T3.2 | Backend Specialist |
| **T3.4** | Create /api/custom-models routes | 4-6 hours | T3.3 | Backend Specialist |
| **T3.5** | Implement Ollama deployment logic | 3-4 hours | T3.3 | Backend Specialist |
| **T3.6** | Create N4.3 fine-tuning workflow | 4-6 hours | T3.4 | n8n Specialist |
| **T3.7** | Build models.html dashboard | 6-8 hours | T3.4 | Frontend Specialist |
| **T3.8** | Add model version comparison UI | 3-4 hours | T3.7 | Frontend Specialist |
| **T3.9** | Write Modelfile validation tests | 2-3 hours | T3.5 | QA Specialist |
| **T3.10** | Test deployment to Ollama hosts | 2-3 hours | T3.5 | QA Specialist |
| **T3.11** | Document model lifecycle and fine-tuning | 2-3 hours | ALL | Documentation Specialist |

**Total Effort:** ~35-48 hours
**Parallel Tracks:** 3 (Backend, n8n, Frontend)

---

## Track 4: Self-Healing & Automation 🤖

**Goal:** Automatically detect and remediate issues without human intervention

### Architecture Design

#### 4.1 Self-Healing Engine
**New Service:** `/src/services/selfHealingService.js`

```javascript
class SelfHealingEngine {
  // Detection
  async detectIssues() // Scans health metrics, analytics for problems
  async classifyIssue(issueData) // Categorizes issue type

  // Decision making
  async selectRemediationStrategy(issue)
  async canAutoRemediate(issue) // Safety check

  // Remediation actions
  async restartService(serviceName)
  async switchToBackupModel(currentModel, reason)
  async optimizePrompt(promptName, feedbackData)
  async scalOllamaInstance(host, action) // scale up/down
  async rollbackDeployment(deploymentId)

  // Audit trail
  async logRemediationAction(action, result)
  async getRemediationHistory(filters)
}
```

#### 4.2 Remediation Strategies Model
**New Model:** `/models/RemediationAction.js`

```javascript
{
  issueType: String, // "model_degradation", "prompt_underperforming", "service_down"
  detectedAt: Date,
  severity: ['low', 'medium', 'high', 'critical'],

  // Issue context
  context: {
    component: String, // "ollama-99", "prompt:default_chat:v3"
    metric: String, // "response_time", "positive_rate", "availability"
    threshold: Number,
    currentValue: Number,
    baseline: Number
  },

  // Remediation
  strategy: String, // "model_failover", "prompt_rollback", "service_restart"
  action: String, // Human-readable description
  automatedExecution: Boolean,
  executedAt: Date,

  // Outcome
  status: ['pending', 'in_progress', 'succeeded', 'failed', 'manual_intervention_required'],
  result: {
    success: Boolean,
    message: String,
    newValue: Number, // Post-remediation metric
    verifiedAt: Date
  },

  // Approval (for critical actions)
  requiresApproval: Boolean,
  approvedBy: ObjectId,
  approvedAt: Date,

  timestamps: { createdAt, updatedAt }
}
```

#### 4.3 Self-Healing Rules Configuration

**Configuration File:** `/config/self-healing-rules.json`

```json
[
  {
    "name": "model_slow_response_failover",
    "enabled": true,
    "detectionQuery": {
      "metric": "avg_response_time",
      "threshold": 5000,
      "window": "5m",
      "component": "ollama-*"
    },
    "remediation": {
      "strategy": "model_failover",
      "action": "switch_to_backup_host",
      "automated": true,
      "requiresApproval": false,
      "cooldown": "15m"
    }
  },
  {
    "name": "prompt_low_quality_rollback",
    "enabled": true,
    "detectionQuery": {
      "metric": "positive_rate",
      "threshold": 0.6,
      "window": "1h",
      "component": "prompt:*"
    },
    "remediation": {
      "strategy": "prompt_rollback",
      "action": "rollback_to_previous_version",
      "automated": true,
      "requiresApproval": false,
      "cooldown": "1h"
    }
  },
  {
    "name": "agentx_down_restart",
    "enabled": true,
    "detectionQuery": {
      "metric": "health_status",
      "threshold": "down",
      "window": "2m",
      "component": "agentx"
    },
    "remediation": {
      "strategy": "service_restart",
      "action": "pm2_restart_agentx",
      "automated": false,
      "requiresApproval": true,
      "cooldown": "10m"
    }
  }
]
```

#### 4.4 Prompt Auto-Optimization
**Integration with existing N5.1 (Feedback Analysis):**

```javascript
// Enhanced workflow logic
async function autoOptimizePrompt(promptName) {
  // 1. Fetch negative conversations
  const failures = await GET('/api/dataset/conversations?feedback=negative&promptName=' + promptName);

  // 2. Analyze with LLM (already implemented in /api/prompts/:name/analyze-failures)
  const analysis = await POST(`/api/prompts/${promptName}/analyze-failures`, { limit: 50 });

  // 3. Generate improved prompt
  const improved = await POST('/api/chat', {
    system: "You are a prompt optimization expert...",
    message: `Improve this prompt based on failure analysis:\n${analysis.llmAnalysis}`,
    model: "qwen2.5:14b"
  });

  // 4. Create new prompt version (AUTOMATED)
  const newVersion = await POST('/api/prompts', {
    name: promptName,
    systemPrompt: improved.response,
    description: `Auto-optimized based on ${failures.length} failure samples`,
    isActive: false, // Start inactive for A/B testing
    trafficWeight: 10 // 10% traffic for testing
  });

  // 5. Schedule A/B test evaluation (24 hours)
  await POST('/api/remediations', {
    action: 'schedule_ab_test_evaluation',
    targetDate: new Date(Date.now() + 86400000),
    context: { promptName, newVersion: newVersion.version }
  });

  // 6. Alert team of auto-optimization
  await triggerAlert({
    type: 'prompt_auto_optimized',
    severity: 'info',
    message: `Prompt ${promptName} auto-optimized to v${newVersion.version}`,
    channels: ['slack']
  });
}
```

#### 4.5 Model Failover Logic
**Enhanced ModelRouter Service:**

```javascript
// src/services/modelRouter.js - Add failover capability
async function routeWithFailover(message, preferredModel, taskType) {
  const primaryHost = HOSTS.primary;
  const secondaryHost = HOSTS.secondary;

  // Check primary model health
  const primaryHealth = await checkModelHealth(primaryHost, preferredModel);

  if (primaryHealth.avgResponseTime > 5000 || primaryHealth.status === 'unhealthy') {
    // Automatic failover to secondary
    logger.warn(`Failing over from ${primaryHost} to ${secondaryHost}`, {
      reason: 'performance_degradation',
      metric: primaryHealth.avgResponseTime
    });

    // Log remediation action
    await RemediationAction.create({
      issueType: 'model_degradation',
      context: { component: preferredModel, metric: 'response_time', currentValue: primaryHealth.avgResponseTime },
      strategy: 'model_failover',
      action: `Switch from ${primaryHost} to ${secondaryHost}`,
      automatedExecution: true,
      status: 'in_progress'
    });

    return { host: secondaryHost, model: preferredModel, failedOver: true };
  }

  return { host: primaryHost, model: preferredModel, failedOver: false };
}
```

#### 4.6 API Endpoints
**New Route:** `/routes/self-healing.js`

- `GET /api/self-healing/status` - Get self-healing system status
- `GET /api/self-healing/actions` - List recent remediation actions
- `GET /api/self-healing/rules` - List configured rules
- `PUT /api/self-healing/rules/:name` - Enable/disable rule
- `POST /api/self-healing/actions/:id/approve` - Approve pending action (for critical changes)
- `POST /api/self-healing/simulate` - Dry-run a remediation strategy (testing)

#### 4.7 n8n Integration
**New Workflow: N4.4 (Self-Healing Orchestrator)**
```
Trigger: Scheduled (every 5 minutes)

1. Query latest health metrics and analytics
2. Evaluate self-healing rules
3. For each detected issue:
   a. Check if automated remediation is enabled
   b. If enabled: Execute remediation action
   c. If requires approval: Create pending action + alert
4. Verify remediation success (poll metrics after 2 min)
5. Log outcome to DataAPI
6. Alert on failures
```

---

### Implementation Tasks - Track 4

| Task ID | Description | Estimated Effort | Dependencies | Agent Type |
|---------|-------------|------------------|--------------|------------|
| **T4.1** | Design self-healing architecture | 3-4 hours | None | System Architect |
| **T4.2** | Create RemediationAction model | 2 hours | T4.1 | Backend Specialist |
| **T4.3** | Implement SelfHealingEngine service | 6-8 hours | T4.2 | Backend Specialist |
| **T4.4** | Add failover logic to ModelRouter | 3-4 hours | T4.3 | Backend Specialist |
| **T4.5** | Implement prompt auto-optimization | 4-6 hours | T4.3 | Backend Specialist |
| **T4.6** | Create self-healing rules config | 2-3 hours | T4.3 | Backend Specialist |
| **T4.7** | Create /api/self-healing routes | 3-4 hours | T4.3 | Backend Specialist |
| **T4.8** | Create N4.4 orchestrator workflow | 4-6 hours | T4.7 | n8n Specialist |
| **T4.9** | Build self-healing dashboard UI | 5-7 hours | T4.7 | Frontend Specialist |
| **T4.10** | Add approval workflow UI for critical actions | 3-4 hours | T4.9 | Frontend Specialist |
| **T4.11** | Write remediation simulation tests | 3-4 hours | T4.3 | QA Specialist |
| **T4.12** | Test failover scenarios | 3-4 hours | T4.4 | QA Specialist |
| **T4.13** | Document self-healing rules and safety | 2-3 hours | ALL | Documentation Specialist |

**Total Effort:** ~43-60 hours
**Parallel Tracks:** 3 (Backend, n8n, Frontend)

---

## Track 5: Advanced Testing & CI/CD ⚙️

**Goal:** Production-grade automated testing and deployment pipeline

### Architecture Design

#### 5.1 Testing Strategy

**Test Pyramid:**
```
     ╱╲
    ╱E2E╲ (5-10 tests, critical user flows)
   ╱──────╲
  ╱ Integration ╲ (20-30 tests, API + workflow validation)
 ╱────────────────╲
╱  Unit Tests     ╲ (100+ tests, service/model/util coverage)
╲────────────────╱
```

#### 5.2 Workflow Testing Framework

**New Utility:** `/tests/helpers/n8nWorkflowTester.js`

```javascript
class N8nWorkflowTester {
  async loadWorkflow(jsonPath) // Parse workflow JSON
  async validateSchema(workflow) // Check required fields, node structure
  async validateConnections(workflow) // Ensure all nodes are connected
  async validateNodes(workflow) // Check node configurations

  async simulateExecution(workflow, input) // Dry-run without deploying
  async deployToTestInstance(workflow) // Deploy to test n8n
  async triggerWebhook(webhookPath, payload) // Test webhook endpoints
  async pollExecution(executionId, timeout) // Wait for completion

  async assertExecutionSuccess(executionId)
  async getExecutionOutput(executionId, nodeName)
}
```

**Test Example:**
```javascript
// tests/workflows/N1.1-health-check.test.js
describe('N1.1 Health Check Workflow', () => {
  let tester;

  beforeAll(async () => {
    tester = new N8nWorkflowTester();
    await tester.loadWorkflow('./AgentC/N1.1.json');
  });

  test('validates workflow schema', async () => {
    const validation = await tester.validateSchema();
    expect(validation.valid).toBe(true);
  });

  test('probes all 4 services', async () => {
    const execution = await tester.simulateExecution({ trigger: 'manual' });

    expect(execution.nodes).toContain('Probe DataAPI');
    expect(execution.nodes).toContain('Probe AgentX');
    expect(execution.nodes).toContain('Probe Ollama99');
    expect(execution.nodes).toContain('Probe Ollama12');
  });

  test('aggregates status correctly', async () => {
    const result = await tester.getExecutionOutput('Aggregate Status');

    expect(result).toHaveProperty('overall');
    expect(['healthy', 'degraded']).toContain(result.overall);
  });

  test('alerts on degradation', async () => {
    // Mock degraded response
    const execution = await tester.simulateExecution({
      mocks: { 'Probe AgentX': { status: 'down' } }
    });

    const alertNode = await tester.getExecutionOutput('Log to DataAPI Sink');
    expect(alertNode.event_type).toBe('health_alert');
  });
});
```

#### 5.3 Load Testing Enhancement

**Expanded Artillery Scenarios:**

**File:** `/tests/load/comprehensive-load.yml`
```yaml
config:
  target: "http://localhost:3080"
  phases:
    - duration: 300
      arrivalRate: 10
      name: "Sustained load"
    - duration: 120
      arrivalRate: 50
      name: "Spike load"
    - duration: 600
      arrivalRate: 5
      name: "Soak test"
  plugins:
    expect: {}
  processor: "./tests/load/test-helpers.js"

scenarios:
  - name: "Chat with RAG"
    weight: 40
    flow:
      - post:
          url: "/api/chat"
          json:
            message: "Explain vector embeddings"
            useRag: true
            model: "qwen2.5:7b"
          capture:
            - json: "$.conversationId"
              as: "convId"
          expect:
            - statusCode: 200
            - contentType: json
            - hasProperty: "response"

  - name: "Prompt retrieval"
    weight: 20
    flow:
      - get:
          url: "/api/prompts"
          expect:
            - statusCode: 200

  - name: "Analytics dashboard"
    weight: 15
    flow:
      - get:
          url: "/api/analytics/usage"
          qs:
            groupBy: "model"
          expect:
            - statusCode: 200

  - name: "RAG search"
    weight: 10
    flow:
      - post:
          url: "/api/rag/search"
          json:
            q: "system architecture"
            topK: 5
          expect:
            - statusCode: 200
            - hasProperty: "results"

  - name: "Workflow validation"
    weight: 10
    flow:
      - get:
          url: "/api/dashboard/health"
          expect:
            - statusCode: 200
            - hasProperty: "overall"

  - name: "Model routing decision"
    weight: 5
    flow:
      - post:
          url: "/api/models/classify"
          json:
            message: "Write a Python function to sort a list"
          expect:
            - statusCode: 200
            - hasProperty: "taskType"
```

**Load Test Scenarios:**
1. **Basic Load** - 10 req/sec sustained, 5 min
2. **Stress Test** - 50 req/sec spike, 2 min
3. **Soak Test** - 5 req/sec for 10 hours (overnight)
4. **Spike Recovery** - Sudden 0 → 100 req/sec → 0
5. **Workflow-Specific** - n8n webhook load (100 concurrent health checks)

#### 5.4 GitHub Actions CI/CD Pipeline

**File:** `.github/workflows/ci-cd.yml`

```yaml
name: AgentX CI/CD Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run lint

  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run test:unit
      - uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json

  integration-tests:
    runs-on: ubuntu-latest
    services:
      mongodb:
        image: mongo:6
        ports:
          - 27017:27017
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run test:integration
        env:
          MONGODB_URI: mongodb://localhost:27017/agentx-test

  workflow-validation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run test:workflows
        # Validates all JSON files in AgentC/

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run test:e2e
        env:
          BASE_URL: http://localhost:3080

  load-tests:
    runs-on: ubuntu-latest
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run test:load:basic
      - uses: actions/upload-artifact@v3
        with:
          name: artillery-report
          path: ./artillery-report.json

  deploy-staging:
    needs: [lint, unit-tests, integration-tests, workflow-validation]
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/develop'
    steps:
      - uses: actions/checkout@v3
      - name: Deploy to Staging
        run: |
          # SSH deploy script
          ./scripts/deploy-staging.sh
        env:
          SSH_PRIVATE_KEY: ${{ secrets.STAGING_SSH_KEY }}

  deploy-production:
    needs: [lint, unit-tests, integration-tests, workflow-validation, e2e-tests, load-tests]
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v3
      - name: Deploy to Production
        run: |
          ./scripts/deploy-production.sh
        env:
          SSH_PRIVATE_KEY: ${{ secrets.PRODUCTION_SSH_KEY }}
      - name: Deploy n8n Workflows
        run: |
          ./scripts/deploy-n8n-workflows.sh
        env:
          N8N_API_KEY: ${{ secrets.N8N_API_KEY }}
      - name: Health Check
        run: |
          sleep 30
          curl -f http://192.168.2.33:3080/health || exit 1
      - name: Rollback on Failure
        if: failure()
        run: |
          ./scripts/rollback-deployment.sh
```

#### 5.5 Pre-Deployment Checks

**Script:** `/scripts/pre-deploy-checks.sh`

```bash
#!/bin/bash
set -e

echo "🔍 Running pre-deployment checks..."

# 1. Environment validation
echo "✅ Checking environment variables..."
node scripts/validate-env.js

# 2. Database migration check
echo "✅ Checking for pending migrations..."
node scripts/check-migrations.js

# 3. Workflow validation
echo "✅ Validating n8n workflows..."
npm run test:workflows

# 4. API endpoint smoke tests
echo "✅ Smoke testing critical endpoints..."
./test-backend.sh

# 5. Dependency audit
echo "✅ Auditing dependencies for vulnerabilities..."
npm audit --production --audit-level=high

# 6. Build check
echo "✅ Verifying build integrity..."
npm run build # If applicable

# 7. Backup check
echo "✅ Verifying backup system..."
./scripts/verify-backups.sh

echo "✅ All pre-deployment checks passed!"
```

#### 5.6 Automated Rollback

**Script:** `/scripts/rollback-deployment.sh`

```bash
#!/bin/bash
set -e

echo "🔄 Initiating rollback..."

# Get previous Git commit
PREVIOUS_COMMIT=$(git rev-parse HEAD~1)

# Rollback code
git checkout $PREVIOUS_COMMIT

# Restart services
pm2 reload ecosystem.config.js

# Verify health
sleep 10
if curl -f http://localhost:3080/health; then
  echo "✅ Rollback successful"
else
  echo "❌ Rollback failed - manual intervention required"
  exit 1
fi

# Notify team
curl -X POST $SLACK_WEBHOOK_URL \
  -H 'Content-Type: application/json' \
  -d "{\"text\": \"⚠️ AgentX rolled back to $PREVIOUS_COMMIT due to deployment failure\"}"
```

---

### Implementation Tasks - Track 5

| Task ID | Description | Estimated Effort | Dependencies | Agent Type |
|---------|-------------|------------------|--------------|------------|
| **T5.1** | Create N8nWorkflowTester utility class | 4-6 hours | None | QA Specialist |
| **T5.2** | Write workflow validation tests (all 9 workflows) | 6-8 hours | T5.1 | QA Specialist |
| **T5.3** | Expand Artillery load test scenarios | 3-4 hours | None | QA Specialist |
| **T5.4** | Add workflow-specific load tests | 2-3 hours | T5.3 | QA Specialist |
| **T5.5** | Create GitHub Actions CI/CD pipeline | 4-6 hours | None | DevOps Specialist |
| **T5.6** | Write pre-deploy-checks.sh script | 2-3 hours | None | DevOps Specialist |
| **T5.7** | Implement rollback-deployment.sh | 2-3 hours | None | DevOps Specialist |
| **T5.8** | Add code coverage reporting | 2 hours | T5.5 | DevOps Specialist |
| **T5.9** | Create deploy-staging.sh script | 2-3 hours | T5.5 | DevOps Specialist |
| **T5.10** | Create deploy-production.sh script | 2-3 hours | T5.5 | DevOps Specialist |
| **T5.11** | Add Slack notifications for pipeline events | 1-2 hours | T5.5 | DevOps Specialist |
| **T5.12** | Write CI/CD documentation and runbooks | 2-3 hours | ALL | Documentation Specialist |

**Total Effort:** ~32-46 hours
**Parallel Tracks:** 2 (QA, DevOps)

---

## Track 6: Backup & Disaster Recovery 💾

**Goal:** Protect workflows, data, and configuration with automated backups and rollback capabilities

### Architecture Design

#### 6.1 Backup Strategy

**What to Backup:**
1. **n8n Workflows** - Version-controlled JSON files
2. **MongoDB Data** - Conversations, prompts, analytics
3. **Vector Store (Qdrant)** - RAG documents and embeddings
4. **Configuration Files** - .env, ecosystem.config.js, prompt configs
5. **Custom Models** - Modelfiles, fine-tuned weights

**Backup Schedule:**
- **Continuous:** Git commits for workflows (every change)
- **Hourly:** Incremental MongoDB backups (changed docs only)
- **Daily:** Full MongoDB dump + Qdrant snapshot
- **Weekly:** Full system backup including logs and models

#### 6.2 Workflow Version Control

**Git Integration for Workflows:**

**Script:** `/scripts/commit-workflows.sh`
```bash
#!/bin/bash
# Auto-commit n8n workflows to Git

cd /home/yb/codes/AgentX/AgentC

# Check for changes
if git diff --quiet *.json; then
  echo "No workflow changes detected"
  exit 0
fi

# Commit changes
git add *.json
git commit -m "feat(workflows): auto-backup $(date +%Y-%m-%d_%H:%M:%S)

Changes detected in n8n workflows. Automatic backup commit.
"

git push origin main

echo "✅ Workflows backed up to Git"
```

**Trigger:** n8n webhook on workflow save
- **Workflow: N4.5 (Workflow Backup)**
- Trigger: Webhook called after workflow update
- Action: Execute `/scripts/commit-workflows.sh`

#### 6.3 MongoDB Backup

**Automated Backup Script:** `/scripts/backup-mongodb.sh`

```bash
#!/bin/bash
set -e

BACKUP_DIR="/mnt/backups/mongodb"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="$BACKUP_DIR/agentx_$DATE"

mkdir -p $BACKUP_PATH

# Full dump
mongodump --uri="$MONGODB_URI" --out="$BACKUP_PATH"

# Compress
tar -czf "$BACKUP_PATH.tar.gz" -C $BACKUP_DIR "agentx_$DATE"
rm -rf "$BACKUP_PATH"

# Retention: Keep last 7 daily backups
find $BACKUP_DIR -name "agentx_*.tar.gz" -mtime +7 -delete

echo "✅ MongoDB backup completed: $BACKUP_PATH.tar.gz"

# Upload to remote storage (optional)
# aws s3 cp "$BACKUP_PATH.tar.gz" s3://agentx-backups/mongodb/
```

**Cron Schedule:**
```cron
0 2 * * * /home/yb/codes/AgentX/scripts/backup-mongodb.sh >> /var/log/agentx-backup.log 2>&1
```

#### 6.4 Qdrant Snapshot Backup

**Script:** `/scripts/backup-qdrant.sh`

```bash
#!/bin/bash
set -e

QDRANT_URL="http://localhost:6333"
COLLECTION="agentx_rag"
BACKUP_DIR="/mnt/backups/qdrant"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Create snapshot via API
SNAPSHOT=$(curl -X POST "$QDRANT_URL/collections/$COLLECTION/snapshots" | jq -r '.result.name')

echo "Created snapshot: $SNAPSHOT"

# Download snapshot
curl "$QDRANT_URL/collections/$COLLECTION/snapshots/$SNAPSHOT" \
  -o "$BACKUP_DIR/${COLLECTION}_${DATE}.snapshot"

# Retention: Keep last 7 snapshots
find $BACKUP_DIR -name "${COLLECTION}_*.snapshot" -mtime +7 -delete

echo "✅ Qdrant snapshot completed: ${COLLECTION}_${DATE}.snapshot"
```

#### 6.5 Restore Procedures

**MongoDB Restore:** `/scripts/restore-mongodb.sh`

```bash
#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: ./restore-mongodb.sh <backup_file.tar.gz>"
  exit 1
fi

BACKUP_FILE=$1
TEMP_DIR="/tmp/mongodb_restore"

# Extract backup
mkdir -p $TEMP_DIR
tar -xzf "$BACKUP_FILE" -C $TEMP_DIR

# Restore
mongorestore --uri="$MONGODB_URI" --drop "$TEMP_DIR/agentx_*/"

# Cleanup
rm -rf $TEMP_DIR

echo "✅ MongoDB restored from $BACKUP_FILE"
```

**Qdrant Restore:** `/scripts/restore-qdrant.sh`

```bash
#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: ./restore-qdrant.sh <snapshot_file>"
  exit 1
fi

SNAPSHOT_FILE=$1
QDRANT_URL="http://localhost:6333"
COLLECTION="agentx_rag"

# Upload snapshot
curl -X PUT "$QDRANT_URL/collections/$COLLECTION/snapshots/upload" \
  --data-binary "@$SNAPSHOT_FILE"

# Restore from snapshot
SNAPSHOT_NAME=$(basename "$SNAPSHOT_FILE")
curl -X PUT "$QDRANT_URL/collections/$COLLECTION/snapshots/$SNAPSHOT_NAME/recover"

echo "✅ Qdrant restored from $SNAPSHOT_FILE"
```

#### 6.6 Workflow Rollback System

**New Utility:** `/src/utils/workflowRollback.js`

```javascript
class WorkflowRollbackManager {
  async getWorkflowHistory(workflowName) {
    // Query Git history for workflow file
    const commits = execSync(
      `git log --oneline --all -- AgentC/${workflowName}.json`
    ).toString().split('\n');

    return commits.map(commit => {
      const [hash, ...messageParts] = commit.split(' ');
      return {
        hash,
        message: messageParts.join(' '),
        date: this.getCommitDate(hash)
      };
    });
  }

  async rollbackToCommit(workflowName, commitHash) {
    // Checkout specific version
    execSync(`git checkout ${commitHash} -- AgentC/${workflowName}.json`);

    // Re-deploy to n8n
    const workflowJSON = fs.readFileSync(`./AgentC/${workflowName}.json`);
    await this.deployToN8n(JSON.parse(workflowJSON));

    // Log rollback action
    await RemediationAction.create({
      issueType: 'workflow_rollback',
      action: `Rolled back ${workflowName} to commit ${commitHash}`,
      automatedExecution: false,
      status: 'succeeded'
    });
  }

  async deployToN8n(workflow) {
    // Import workflow via n8n API
    const response = await fetch(`${N8N_BASE_URL}/api/v1/workflows`, {
      method: 'POST',
      headers: {
        'X-N8N-API-KEY': process.env.N8N_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(workflow)
    });

    if (!response.ok) {
      throw new Error(`n8n deployment failed: ${response.statusText}`);
    }

    return await response.json();
  }
}
```

#### 6.7 API Endpoints
**New Route:** `/routes/backups.js`

- `GET /api/backups` - List available backups (MongoDB, Qdrant, workflows)
- `POST /api/backups/trigger` - Manually trigger backup
- `GET /api/backups/status` - Get last backup status and schedule
- `POST /api/backups/restore` - Restore from backup (requires admin approval)
- `GET /api/backups/workflows/:name/history` - Get workflow Git history
- `POST /api/backups/workflows/:name/rollback` - Rollback workflow to commit

#### 6.8 Frontend Dashboard
**New Page:** `/public/backups.html`

Components:
1. **Backup Status Panel**
   - Last backup timestamp
   - Next scheduled backup
   - Backup size and retention info

2. **Restore Interface**
   - Browse available backups
   - Preview backup contents
   - Restore button with confirmation dialog

3. **Workflow Version History**
   - Timeline of workflow changes (Git commits)
   - Diff viewer (compare versions)
   - One-click rollback

4. **Backup Configuration**
   - Edit backup schedule
   - Configure retention policy
   - Set remote storage destination

---

### Implementation Tasks - Track 6

| Task ID | Description | Estimated Effort | Dependencies | Agent Type |
|---------|-------------|------------------|--------------|------------|
| **T6.1** | Create backup-mongodb.sh script | 2 hours | None | DevOps Specialist |
| **T6.2** | Create backup-qdrant.sh script | 2 hours | None | DevOps Specialist |
| **T6.3** | Create restore scripts (MongoDB + Qdrant) | 2-3 hours | T6.1, T6.2 | DevOps Specialist |
| **T6.4** | Implement WorkflowRollbackManager utility | 3-4 hours | None | Backend Specialist |
| **T6.5** | Create commit-workflows.sh script | 1-2 hours | None | DevOps Specialist |
| **T6.6** | Create N4.5 workflow backup n8n workflow | 1-2 hours | T6.5 | n8n Specialist |
| **T6.7** | Create /api/backups routes | 3-4 hours | T6.4 | Backend Specialist |
| **T6.8** | Build backups.html dashboard | 5-7 hours | T6.7 | Frontend Specialist |
| **T6.9** | Add workflow diff viewer to UI | 3-4 hours | T6.8 | Frontend Specialist |
| **T6.10** | Set up cron jobs for automated backups | 1 hour | T6.1, T6.2 | DevOps Specialist |
| **T6.11** | Test backup and restore procedures | 3-4 hours | T6.3 | QA Specialist |
| **T6.12** | Document disaster recovery runbook | 2-3 hours | ALL | Documentation Specialist |

**Total Effort:** ~28-39 hours
**Parallel Tracks:** 3 (Backend, DevOps, Frontend)

---

## Multi-Agent Orchestration Plan

### Agent Assignment Matrix

| Agent ID | Specialization | Assigned Tracks | Total Tasks | Est. Hours |
|----------|---------------|-----------------|-------------|------------|
| **Agent-BE-1** | Backend (Node.js/Express) | T1, T2, T4 | 15 tasks | 40-60h |
| **Agent-BE-2** | Backend (Node.js/Express) | T3, T6 | 7 tasks | 25-35h |
| **Agent-FE-1** | Frontend (HTML/JS/Chart.js) | T1, T2 | 7 tasks | 18-26h |
| **Agent-FE-2** | Frontend (HTML/JS) | T3, T4, T6 | 6 tasks | 17-25h |
| **Agent-N8N-1** | n8n Workflows | T1, T2, T4, T6 | 7 tasks | 12-18h |
| **Agent-QA-1** | Testing (Jest/Playwright) | T1, T2, T5 | 7 tasks | 16-23h |
| **Agent-QA-2** | Testing (Artillery/Integration) | T3, T5, T6 | 6 tasks | 16-22h |
| **Agent-OPS-1** | DevOps (CI/CD/Scripts) | T5, T6 | 11 tasks | 22-33h |
| **Agent-DOC-1** | Documentation | T1-T6 (all) | 7 tasks | 12-18h |
| **Agent-ARCH-1** | Architecture/Planning | T1, T2, T4 | 3 tasks | 7-11h |

**Total Agent-Hours:** ~185-271 hours
**With 10 agents in parallel:** Estimated 2-3 weeks calendar time

### Dependency Graph

```
Track 1 (Alerts):
  T1.1 → T1.3, T1.4, T1.5, T1.6
  T1.2 → T1.6
  T1.6 → T1.7, T1.8, T1.9, T1.10, T1.11
  T1.10 → T1.12

Track 2 (Metrics):
  T2.1 → T2.2 → T2.3 → T2.4, T2.5
  T2.5 → T2.6, T2.7, T2.8
  T2.8 → T2.9 → T2.10
  T2.3 → T2.11, T2.12

Track 3 (Custom Models):
  T3.1 → T3.2 → T3.3 → T3.4, T3.5
  T3.4 → T3.6, T3.7
  T3.5 → T3.9, T3.10
  T3.7 → T3.8

Track 4 (Self-Healing):
  T4.1 → T4.2 → T4.3
  T4.3 → T4.4, T4.5, T4.6, T4.7
  T4.7 → T4.8, T4.9
  T4.9 → T4.10
  T4.3 → T4.11, T4.12

Track 5 (Testing/CI):
  T5.1 → T5.2
  T5.3 → T5.4
  T5.5 → T5.8, T5.9, T5.10, T5.11
  Independent: T5.6, T5.7

Track 6 (Backup):
  T6.1, T6.2 → T6.3, T6.10
  T6.4 → T6.7
  T6.5 → T6.6
  T6.7 → T6.8 → T6.9
  T6.3 → T6.11
```

### Execution Phases

**Phase 1 (Foundation) - Week 1:**
- All T*.1 tasks (architecture, design, schemas)
- All T*.2 tasks (models, utilities)
- Start T*.3 tasks (core services)
- **Deliverable:** Foundational services and models ready

**Phase 2 (Implementation) - Week 2:**
- Complete T*.3-T*.7 tasks (services, APIs, workflows)
- **Deliverable:** Backend APIs functional, n8n workflows deployed

**Phase 3 (UI & Testing) - Week 3:**
- Complete T*.8-T*.12 tasks (frontends, tests, docs)
- **Deliverable:** Full system with UI, tests, and documentation

---

## External AI Agent Prompts

**FOR YOUR EXTERNAL AI CODING AGENTS** - Use these prompts to delegate tasks:

### Prompt Template Format
```
TASK: [Task ID] - [Description]
TRACK: [Track Number and Name]
ESTIMATED EFFORT: [Hours]
DEPENDENCIES: [Comma-separated task IDs or "None"]

CONTEXT:
[Background information from architecture analysis]

REQUIREMENTS:
[Specific implementation requirements]

DELIVERABLES:
1. [File/artifact 1]
2. [File/artifact 2]
...

TESTING CRITERIA:
[How to verify the implementation]

RELATED FILES:
[List of existing files to reference or modify]
```

---

### Example External Agent Prompts (Ready to Use)

#### **PROMPT 1: AlertService Implementation**
```
TASK: T1.1 - Create AlertService with rule engine
TRACK: Track 1 - Alerts & Notifications
ESTIMATED EFFORT: 4-6 hours
DEPENDENCIES: None

CONTEXT:
AgentX currently has passive logging to DataAPI but no active alerting. The system uses n8n workflows (N1.1, N5.1) that detect issues but don't notify operators. We need a centralized AlertService that evaluates rules and triggers multi-channel notifications.

REQUIREMENTS:
1. Create `/src/services/alertService.js` as a singleton service
2. Implement rule engine that evaluates incoming events against configured rules
3. Support multiple delivery channels: email (nodemailer), Slack (webhook), generic webhooks
4. Include alert deduplication (don't spam same alert within cooldown period)
5. Implement severity levels: info, warning, error, critical
6. Log all alert decisions to MongoDB Alert model
7. Support test mode for validating alert configurations

DELIVERABLES:
1. `/src/services/alertService.js` (150-250 lines)
2. Rule configuration JSON schema definition
3. Unit tests for rule evaluation logic

TESTING CRITERIA:
- Rule evaluation correctly matches events
- Cooldown period prevents duplicate alerts
- All delivery channels (email, Slack, webhook) successfully send
- Alert history is logged to database
- Test mode doesn't actually send alerts

RELATED FILES:
- `/src/services/chatService.js` (reference for singleton pattern)
- `/src/utils/logger.js` (use for logging)
- `/config/db-mongodb.js` (reference for DB connection)
- `/AgentC/N1.1.json` (health check workflow that will trigger alerts)

INTEGRATION POINTS:
- Will be called by n8n workflows via API endpoints (created in T1.6)
- Depends on Alert model (T1.2) but can stub for now
- Environment variables: SMTP_*, SLACK_WEBHOOK_URL, ALERT_*
```

---

#### **PROMPT 2: Time-Series Metrics Collection**
```
TASK: T2.3 - Implement MetricsCollector service
TRACK: Track 2 - Historical Metrics & Analytics
ESTIMATED EFFORT: 4-6 hours
DEPENDENCIES: T2.2 (MetricsSnapshot model)

CONTEXT:
AgentX has comprehensive analytics for aggregated data but no time-series storage. We need to capture health, performance, cost, and resource metrics at regular intervals (every 5-10 minutes from n8n workflows) and store them for trend analysis.

REQUIREMENTS:
1. Create `/src/services/metricsCollector.js` as a singleton
2. Implement these core methods:
   - recordHealthMetric(componentType, componentId, healthData)
   - recordPerformanceMetric(componentType, componentId, perfData)
   - recordCostMetric(model, costData)
   - recordResourceMetric(componentId, resourceData)
3. Add query methods:
   - getTimeSeries(componentId, metric, from, to, granularity)
   - getTrends(metric, period) // Period-over-period comparison
4. Implement hourly aggregation job (aggregateHourly)
5. Add data retention cleanup (purgeOldMetrics with 90-day default)
6. All writes should be async and non-blocking

DELIVERABLES:
1. `/src/services/metricsCollector.js` (200-300 lines)
2. Aggregation pipeline logic for hourly rollups
3. Unit tests for metric recording and querying

TESTING CRITERIA:
- Metrics are written to MetricsSnapshot collection
- getTimeSeries returns data in Chart.js compatible format: [{timestamp, value}]
- Aggregation correctly calculates avg/sum/p95 for hour buckets
- purgeOldMetrics deletes metrics older than retention period
- No performance degradation when querying 100K+ metrics

RELATED FILES:
- `/models/MetricsSnapshot.js` (created in T2.2, defines schema)
- `/routes/analytics.js` (reference for aggregation patterns)
- `/src/services/ragStore.js` (reference for singleton pattern)
- `/AgentC/N1.1.json` (will call this service to log health data)

INTEGRATION POINTS:
- Called by new API endpoints in T2.5
- Used by n8n workflow N4.2 for aggregation (T2.7)
- Frontend charts (T2.8) will query via API
```

---

#### **PROMPT 3: n8n Alert Dispatcher Workflow**
```
TASK: T1.9 - Create N4.1 Alert Dispatcher workflow
TRACK: Track 1 - Alerts & Notifications
ESTIMATED EFFORT: 2-3 hours
DEPENDENCIES: T1.6 (Alert API endpoints)

CONTEXT:
AgentX's AlertService (T1.1) evaluates rules and creates Alert records, but we need an n8n workflow to handle the actual delivery to Slack, email, and webhooks. This separates alerting logic (backend) from delivery mechanisms (n8n).

REQUIREMENTS:
1. Create `/AgentC/N4.1.json` n8n workflow file
2. Trigger: Webhook (POST /webhook/sbqc-n4-1-alert-dispatch)
3. Input payload:
   {
     "alertId": "mongodb-objectid",
     "severity": "critical",
     "title": "Health Degradation Detected",
     "message": "AgentX responded with status: down",
     "channels": ["slack", "email"],
     "context": { ... }
   }
4. Workflow logic:
   - Parse webhook payload
   - For each channel in channels array:
     - If "email": Send via SMTP (nodemailer or native n8n email node)
     - If "slack": POST to Slack webhook URL
     - If "webhook": POST to generic webhook endpoint
   - Update Alert record delivery status: POST /api/alerts/:id/delivery-status
   - Log delivery outcome to DataAPI
5. Error handling: Continue on fail for each channel (don't stop if email fails)

DELIVERABLES:
1. `/AgentC/N4.1.json` (n8n workflow JSON, ~200-300 lines)
2. Example webhook test payload in `/AgentC/test-payloads/N4.1-example.json`

TESTING CRITERIA:
- Webhook accepts valid alert payload
- Email is sent to ALERT_EMAIL_TO address
- Slack message appears in configured channel
- Alert delivery status is updated in database
- Workflow continues even if one channel fails
- Execution completes within 5 seconds

RELATED FILES:
- `/AgentC/N1.1.json` (reference for n8n workflow structure)
- `/AgentC/N5.1.json` (reference for API integration patterns)
- `/routes/alerts.js` (created in T1.6, provides API endpoints)

ENVIRONMENT VARIABLES REQUIRED:
- SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL_FROM, ALERT_EMAIL_TO
- SLACK_WEBHOOK_URL
- AGENTX_BASE_URL (for API calls back to AgentX)
- AGENTX_API_KEY (for authentication)

DEPLOYMENT:
- Deploy using: ./scripts/deploy-n8n-workflows.sh AgentC/N4.1.json
- Test webhook: curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n4-1-alert-dispatch -d @test-payloads/N4.1-example.json
```

---

#### **PROMPT 4: Workflow Validation Test Suite**
```
TASK: T5.2 - Write workflow validation tests (all 9 workflows)
TRACK: Track 5 - Advanced Testing & CI/CD
ESTIMATED EFFORT: 6-8 hours
DEPENDENCIES: T5.1 (N8nWorkflowTester utility)

CONTEXT:
AgentC has 9 production n8n workflows that need automated validation before deployment. We need a test suite that validates JSON schema, node connections, configurations, and simulates execution without hitting live services.

REQUIREMENTS:
1. Create test files in `/tests/workflows/` for each workflow:
   - N1.1-health-check.test.js
   - N1.3-ops-diagnostic.test.js
   - N2.1-nas-scan.test.js
   - N2.2-nas-full-scan.test.js
   - N2.3-rag-ingest.test.js
   - N3.1-model-monitor.test.js
   - N3.2-ai-query.test.js
   - N5.1-feedback-analysis.test.js
   - N6.1-workflow-architect.test.js

2. Each test file should validate:
   - JSON schema validity (all required n8n fields present)
   - Node connections (no orphaned nodes)
   - Webhook paths follow SBQC convention (sbqc-n##-description)
   - Required credentials are referenced
   - HTTP nodes have valid URLs and methods
   - Simulated execution (mocked responses, verify flow logic)

3. Use N8nWorkflowTester utility (created in T5.1) for all operations

DELIVERABLES:
1. 9 test files in `/tests/workflows/` (50-100 lines each)
2. Shared test fixtures in `/tests/workflows/fixtures/`
3. Update `package.json` with `test:workflows` script

TESTING CRITERIA:
- All 9 test suites pass
- Schema validation catches missing required fields
- Connection validation detects broken links
- Mocked execution tests verify node logic (e.g., "if degraded, route to alert node")
- Tests run in < 30 seconds total

RELATED FILES:
- `/tests/helpers/n8nWorkflowTester.js` (created in T5.1, provides test utilities)
- `/AgentC/*.json` (all workflow files to test)
- `/tests/integration/workflowDeployer.test.js` (reference for test structure)

EXAMPLE TEST STRUCTURE:
```javascript
describe('N1.1 Health Check Workflow', () => {
  let tester;

  beforeAll(async () => {
    tester = new N8nWorkflowTester();
    await tester.loadWorkflow('./AgentC/N1.1.json');
  });

  test('validates workflow schema', async () => {
    const validation = await tester.validateSchema();
    expect(validation.valid).toBe(true);
  });

  test('all nodes are connected', async () => {
    const orphans = await tester.findOrphanedNodes();
    expect(orphans).toHaveLength(0);
  });

  test('webhook path follows convention', async () => {
    const webhook = tester.getWebhookPath();
    expect(webhook).toMatch(/^sbqc-n\d+-/);
  });

  test('simulates healthy execution', async () => {
    const result = await tester.simulateExecution({
      mocks: {
        'Probe AgentX': { status: 'ok' },
        'Probe DataAPI': { status: 'ok' },
        'Probe Ollama99': { status: 'ok' },
        'Probe Ollama12': { status: 'ok' }
      }
    });

    expect(result.finalNode).toBe('No-op'); // Healthy path
  });

  test('routes to alert on degradation', async () => {
    const result = await tester.simulateExecution({
      mocks: {
        'Probe AgentX': { status: 'down' }
      }
    });

    expect(result.finalNode).toBe('Log to DataAPI Sink');
    expect(result.output.event_type).toBe('health_alert');
  });
});
```
```

---

#### **PROMPT 5: Self-Healing Rules Configuration**
```
TASK: T4.6 - Create self-healing rules config
TRACK: Track 4 - Self-Healing & Automation
ESTIMATED EFFORT: 2-3 hours
DEPENDENCIES: T4.3 (SelfHealingEngine service)

CONTEXT:
AgentX needs a declarative configuration for self-healing rules that define: (1) what to monitor, (2) when to trigger remediation, (3) what action to take, and (4) safety constraints. This config will be loaded by the SelfHealingEngine service.

REQUIREMENTS:
1. Create `/config/self-healing-rules.json` with 8-12 rules covering:
   - Model performance degradation (slow response → failover)
   - Prompt quality drops (low positive rate → rollback)
   - Service unavailability (health check fails → restart or alert)
   - Cost spikes (daily spend exceeds threshold → alert + throttle)
   - RAG ingestion failures (alert)
   - High error rates (alert + investigate)

2. Each rule must include:
   - name: Unique identifier
   - enabled: Boolean (allows disabling without deleting)
   - detectionQuery: What metric to monitor, threshold, time window
   - remediation: Strategy, action description, automated flag, approval requirement
   - cooldown: Minimum time between executions (prevent thrashing)
   - priority: For conflict resolution

3. Create JSON schema definition in `/config/schemas/self-healing-rule.schema.json`

4. Add validation utility in `/src/utils/validateRules.js` that checks:
   - All required fields present
   - Thresholds are valid numbers
   - Referenced components exist
   - No conflicting rules (same trigger, different actions)

DELIVERABLES:
1. `/config/self-healing-rules.json` (500-800 lines, 8-12 rules)
2. `/config/schemas/self-healing-rule.schema.json` (JSON Schema definition)
3. `/src/utils/validateRules.js` (validation utility, ~100 lines)
4. Unit tests for rule validation

TESTING CRITERIA:
- JSON is valid and loads without errors
- Schema validation catches missing required fields
- Validation utility detects conflicting rules
- All component references (models, prompts, services) exist in system
- Rules cover critical failure scenarios

RELATED FILES:
- `/src/services/selfHealingService.js` (created in T4.3, consumes these rules)
- `/config/db-mongodb.js` (reference for config loading patterns)
- `/routes/self-healing.js` (will expose rules via API)

EXAMPLE RULE STRUCTURE:
```json
{
  "name": "model_slow_response_failover",
  "enabled": true,
  "description": "Failover to backup Ollama host when primary response time exceeds threshold",
  "detectionQuery": {
    "metric": "avg_response_time",
    "aggregation": "avg",
    "threshold": 5000,
    "comparison": "greater_than",
    "window": "5m",
    "componentType": "ollama",
    "componentPattern": "ollama-*"
  },
  "remediation": {
    "strategy": "model_failover",
    "action": "switch_to_backup_host",
    "description": "Route traffic to secondary Ollama host",
    "automated": true,
    "requiresApproval": false,
    "cooldown": "15m",
    "priority": 1
  },
  "notifications": {
    "onTrigger": ["slack"],
    "onSuccess": ["dataapi_log"],
    "onFailure": ["slack", "email"]
  }
}
```
```

---

## Recommended Next Steps

1. **Review This Plan** - Validate approach, priorities, and effort estimates
2. **Select Execution Model:**
   - **Option A:** Full parallel execution (all 6 tracks simultaneously with 10 agents)
   - **Option B:** Phased rollout (implement Tracks 1-2 first, then 3-6)
   - **Option C:** Priority-based (implement only critical tracks: 1, 4, 5)

3. **Provision Resources:**
   - Assign internal agents (your AI coding assistants)
   - Set up development branches in Git
   - Configure test environments (staging n8n instance, test MongoDB)

4. **Execute Phase 1** (Foundation tasks: T*.1, T*.2, T*.3)
5. **Review & Iterate** after Phase 1 completion
6. **Execute Phases 2-3** with continuous integration

---

## Success Criteria

**Track 1 (Alerts):**
- [ ] Team receives Slack alerts within 60 seconds of degradation
- [ ] Email notifications working for critical issues
- [ ] Alert dashboard shows active/resolved alerts
- [ ] Zero missed critical alerts in 7-day test period

**Track 2 (Metrics):**
- [ ] Time-series charts display 30 days of historical data
- [ ] Trend analysis shows period-over-period changes
- [ ] Metrics collection has < 1% overhead on system performance
- [ ] Dashboard loads in < 2 seconds

**Track 3 (Custom Models):**
- [ ] Custom model successfully deployed to Ollama
- [ ] Performance comparison shows improvement vs base model
- [ ] Version rollback completes in < 5 minutes
- [ ] Model registry tracks all custom models

**Track 4 (Self-Healing):**
- [ ] Automatic model failover triggers within 2 minutes of degradation
- [ ] Prompt rollback prevents quality drops
- [ ] 80% of issues resolved without human intervention
- [ ] Zero false-positive remediations in test period

**Track 5 (Testing):**
- [ ] All workflows pass validation tests
- [ ] Load tests sustain 50 req/sec without errors
- [ ] CI/CD pipeline deploys to staging automatically
- [ ] Code coverage > 70% for new code

**Track 6 (Backup):**
- [ ] Daily MongoDB backups complete successfully
- [ ] Workflow version history shows all changes
- [ ] Restore test completes in < 15 minutes
- [ ] Backup retention policy enforced automatically

---

**END OF MULTI-AGENT ENHANCEMENT PLAN**
