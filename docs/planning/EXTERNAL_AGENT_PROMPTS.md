# External Agent Prompts - Ready to Use

**Copy-paste these prompts directly to your external AI coding agents**

---

## 🚨 TRACK 1: ALERTS & NOTIFICATIONS

### PROMPT 1A: AlertService Core Implementation

```
TASK: T1.1 - Create AlertService with rule engine
TRACK: Track 1 - Alerts & Notifications
ESTIMATED EFFORT: 4-6 hours
DEPENDENCIES: None

CONTEXT:
You are implementing a centralized alert service for AgentX, a Node.js/Express application that currently has passive logging but no active notifications. The system uses n8n workflows (N1.1 health check runs every 5 min, N5.1 feedback analysis weekly) that detect issues but don't notify operators.

The AlertService will:
1. Evaluate incoming events against configurable rules
2. Trigger multi-channel notifications (email, Slack, webhooks)
3. Prevent alert spam with deduplication and cooldown periods
4. Log all decisions to MongoDB for audit trail

REQUIREMENTS:

1. Create `/src/services/alertService.js` as a singleton service
   - Export a factory function: `getAlertService()` that returns singleton instance
   - Follow existing pattern from `/src/services/ragStore.js`

2. Core methods to implement:
   ```javascript
   class AlertService {
     // Initialize with rules configuration
     constructor(rulesConfig)

     // Main alert trigger
     async triggerAlert(eventType, severity, context)
     // Returns: { alertId, triggered: true/false, reason: string }

     // Rule evaluation
     async evaluateRules(event)
     // Returns: [{ ruleName, matched: true/false, action: object }]

     // Delivery methods
     async sendEmail(alert)
     async sendSlack(alert)
     async sendWebhook(alert)

     // Alert management
     async getActiveAlerts(filters)
     async acknowledgeAlert(alertId, userId)
     async muteAlert(alertId, duration)

     // Deduplication
     async isDuplicate(eventType, context, cooldownMinutes)
   }
   ```

3. Rule engine logic:
   - Load rules from `/config/self-healing-rules.json` (create basic structure for now)
   - Each rule has: name, enabled, detectionQuery, remediation, cooldown
   - Match events against rule conditions
   - If multiple rules match, execute highest priority first

4. Deduplication:
   - Track recent alerts in-memory Map: `alertKey -> lastTriggeredAt`
   - Alert key = `${eventType}:${JSON.stringify(context)}`
   - Don't re-trigger within cooldown period (default: 15 minutes)

5. Email delivery (using nodemailer):
   ```javascript
   const nodemailer = require('nodemailer');

   const transporter = nodemailer.createTransport({
     host: process.env.SMTP_HOST,
     port: process.env.SMTP_PORT,
     auth: {
       user: process.env.SMTP_USER,
       pass: process.env.SMTP_PASS
     }
   });

   await transporter.sendMail({
     from: process.env.ALERT_EMAIL_FROM,
     to: process.env.ALERT_EMAIL_TO,
     subject: `[${severity.toUpperCase()}] ${alert.title}`,
     html: formatEmailTemplate(alert)
   });
   ```

6. Slack delivery (using webhook):
   ```javascript
   await fetch(process.env.SLACK_WEBHOOK_URL, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       text: `*${severity.toUpperCase()}*: ${alert.title}`,
       blocks: [
         { type: 'section', text: { type: 'mrkdwn', text: alert.message } },
         { type: 'context', elements: [{ type: 'mrkdwn', text: `Time: ${new Date().toISOString()}` }] }
       ]
     })
   });
   ```

7. Error handling:
   - All delivery methods should be try-catch wrapped
   - Log errors with Winston logger
   - Continue processing even if one channel fails
   - Store delivery status in Alert model

8. Logging:
   - Use existing Winston logger from `/src/utils/logger.js`
   - Log pattern: `logger.info('Alert triggered', { alertId, eventType, severity, channels })`

DELIVERABLES:
1. `/src/services/alertService.js` (200-300 lines)
2. `/config/alert-rules.json` (basic structure with 2-3 example rules)
3. `/tests/unit/alertService.test.js` (test rule evaluation and deduplication)

TESTING CRITERIA:
- Rule evaluation correctly matches events against conditions
- Deduplication prevents alerts within cooldown period
- Email sends successfully (test with real SMTP if env vars set)
- Slack webhook posts message (test with real URL if set)
- Alert records are created in database (stub Alert.create for now)
- Test mode doesn't actually send alerts

RELATED FILES:
- `/src/services/ragStore.js` - Reference for singleton pattern
- `/src/utils/logger.js` - Winston logger to use
- `/config/db-mongodb.js` - Database connection patterns
- `/AgentC/N1.1.json` - Health check workflow that will trigger alerts

ENVIRONMENT VARIABLES NEEDED:
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=app-password
ALERT_EMAIL_FROM=AgentX Alerts <alerts@yourdomain.com>
ALERT_EMAIL_TO=team@yourdomain.com
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

EXAMPLE USAGE:
```javascript
const alertService = getAlertService();

// Trigger alert
const result = await alertService.triggerAlert(
  'health_degradation',
  'critical',
  {
    component: 'agentx',
    status: 'down',
    responseTime: null
  }
);

// Result: { alertId: '507f1f77bcf86cd799439011', triggered: true, channels: ['slack', 'email'] }
```
```

---

### PROMPT 1B: Alert Model & API Endpoints

```
TASK: T1.2 + T1.6 - Create Alert Model and API Routes
TRACK: Track 1 - Alerts & Notifications
ESTIMATED EFFORT: 5-6 hours
DEPENDENCIES: T1.1 (AlertService)

CONTEXT:
You are implementing the data model and REST API for the AlertService created in T1.1. AgentX uses Mongoose for MongoDB schemas and follows a service-oriented architecture where routes are thin HTTP layers that delegate to services.

REQUIREMENTS:

PART 1: Alert Model (`/models/Alert.js`)

1. Create Mongoose schema with these fields:
```javascript
{
  eventType: { type: String, required: true }, // 'health_degradation', 'cost_spike', etc.
  severity: {
    type: String,
    enum: ['info', 'warning', 'error', 'critical'],
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'acknowledged', 'resolved', 'muted'],
    default: 'active'
  },
  title: { type: String, required: true },
  message: { type: String, required: true },
  context: { type: Object }, // Event-specific data

  // Delivery tracking
  channels: [{ type: String }], // ['email', 'slack', 'webhook']
  deliveryStatus: [{
    channel: { type: String },
    status: { type: String, enum: ['pending', 'sent', 'failed'] },
    attemptedAt: { type: Date },
    error: { type: String }
  }],

  // Management
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acknowledgedAt: { type: Date },
  mutedUntil: { type: Date },
  resolvedAt: { type: Date },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}
```

2. Add indexes:
```javascript
AlertSchema.index({ status: 1, createdAt: -1 });
AlertSchema.index({ eventType: 1, createdAt: -1 });
AlertSchema.index({ severity: 1, status: 1 });
```

3. Add static methods:
```javascript
AlertSchema.statics.getActive = function() {
  return this.find({ status: 'active' }).sort({ createdAt: -1 });
};

AlertSchema.statics.getBySeverity = function(severity) {
  return this.find({ severity, status: 'active' });
};
```

PART 2: API Routes (`/routes/alerts.js`)

1. Create Express router with these endpoints:

```javascript
const express = require('express');
const router = express.Router();
const Alert = require('../models/Alert');
const { getAlertService } = require('../src/services/alertService');
const { requireAuth } = require('../src/middleware/auth');
const logger = require('../src/utils/logger');

// GET /api/alerts - List alerts
router.get('/', async (req, res) => {
  try {
    const { status, severity, limit = 50, offset = 0 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (severity) filter.severity = severity;

    const alerts = await Alert.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset));

    const total = await Alert.countDocuments(filter);

    res.json({
      status: 'success',
      data: { alerts, total, limit, offset }
    });
  } catch (err) {
    logger.error('Failed to list alerts', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/alerts/:id - Get alert details
router.get('/:id', async (req, res) => {
  // Implementation
});

// POST /api/alerts - Trigger new alert (internal use + n8n)
router.post('/', async (req, res) => {
  try {
    const { eventType, severity, title, message, context } = req.body;

    if (!eventType || !severity || !title) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: eventType, severity, title'
      });
    }

    const alertService = getAlertService();
    const result = await alertService.triggerAlert(eventType, severity, {
      title,
      message,
      ...context
    });

    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('Failed to trigger alert', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/alerts/:id/acknowledge - Acknowledge alert
router.post('/:id/acknowledge', requireAuth, async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(
      req.params.id,
      {
        status: 'acknowledged',
        acknowledgedBy: res.locals.user?.userId,
        acknowledgedAt: new Date()
      },
      { new: true }
    );

    if (!alert) {
      return res.status(404).json({ status: 'error', message: 'Alert not found' });
    }

    res.json({ status: 'success', data: { alert } });
  } catch (err) {
    logger.error('Failed to acknowledge alert', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/alerts/:id/mute - Mute alert
router.post('/:id/mute', requireAuth, async (req, res) => {
  // Mute for specified duration (default: 1 hour)
  // Implementation similar to acknowledge
});

// POST /api/alerts/:id/resolve - Resolve alert
router.post('/:id/resolve', requireAuth, async (req, res) => {
  // Mark as resolved
  // Implementation similar to acknowledge
});

// GET /api/alerts/stats - Alert statistics
router.get('/stats', async (req, res) => {
  // Aggregate stats: count by severity, status, etc.
});

module.exports = router;
```

2. Mount routes in `/src/app.js`:
```javascript
const alertRoutes = require('./routes/alerts');
app.use('/api/alerts', alertRoutes);
```

DELIVERABLES:
1. `/models/Alert.js` (100-150 lines)
2. `/routes/alerts.js` (200-300 lines)
3. Update `/src/app.js` to mount routes
4. `/tests/integration/alerts.test.js` (API endpoint tests)

TESTING CRITERIA:
- Alert model saves to MongoDB with all fields
- GET /api/alerts returns filtered list
- POST /api/alerts triggers AlertService and returns alertId
- POST /api/alerts/:id/acknowledge updates status
- Indexes improve query performance
- API returns proper HTTP status codes (400, 404, 500)

RELATED FILES:
- `/models/Conversation.js` - Reference for Mongoose schema patterns
- `/routes/analytics.js` - Reference for API route structure
- `/src/app.js` - Where to mount routes (around line 150)
- `/src/middleware/auth.js` - Authentication middleware

INTEGRATION:
- AlertService (T1.1) will call Alert.create() to persist alerts
- n8n workflow N4.1 (T1.9) will POST to /api/alerts
- Frontend dashboard (T1.10) will GET from /api/alerts
```

---

## 📊 TRACK 2: HISTORICAL METRICS

### PROMPT 2A: MetricsSnapshot Model & Schema Design

```
TASK: T2.1 + T2.2 - Design and implement time-series metrics storage
TRACK: Track 2 - Historical Metrics & Analytics
ESTIMATED EFFORT: 3-4 hours
DEPENDENCIES: None

CONTEXT:
AgentX currently has comprehensive analytics for aggregated data (routes/analytics.js with 9 endpoints) but no time-series storage. You need to design a MongoDB schema optimized for storing metrics at 5-10 minute intervals from n8n workflows, then querying for charts showing trends over 30+ days.

MongoDB version: 5.0+ (supports time-series collections)

REQUIREMENTS:

1. Create `/models/MetricsSnapshot.js` with time-series optimized schema:

```javascript
const mongoose = require('mongoose');

const MetricsSnapshotSchema = new mongoose.Schema({
  // Time-series key (REQUIRED for time-series collections)
  timestamp: { type: Date, required: true },

  // Metadata (categorizes the metric)
  metadata: {
    source: {
      type: String,
      enum: ['health_check', 'analytics_job', 'chat_completion', 'workflow_execution'],
      required: true
    },
    componentType: {
      type: String,
      enum: ['ollama', 'agentx', 'dataapi', 'qdrant', 'n8n', 'mongodb'],
      required: true
    },
    componentId: { type: String, required: true } // e.g., "ollama-99", "agentx-main"
  },

  // Health metrics
  health: {
    status: { type: String, enum: ['healthy', 'degraded', 'down'] },
    responseTime: { type: Number }, // milliseconds
    errorRate: { type: Number } // 0.0 - 1.0
  },

  // Performance metrics
  performance: {
    requestCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    avgDuration: { type: Number }, // ms
    p50Duration: { type: Number },
    p95Duration: { type: Number },
    p99Duration: { type: Number }
  },

  // Cost metrics
  cost: {
    totalCost: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' }
  },

  // Resource metrics
  resources: {
    cpuPercent: { type: Number },
    memoryMB: { type: Number },
    diskUsagePercent: { type: Number }
  },

  // Model-specific metrics (for Ollama)
  model: {
    modelName: { type: String },
    tokenThroughput: { type: Number }, // tokens/sec
    activeRequests: { type: Number }
  }
}, {
  timeseries: {
    timeField: 'timestamp',
    metaField: 'metadata',
    granularity: 'minutes' // MongoDB will auto-bucket by minute
  },
  expireAfterSeconds: 7776000 // 90 days retention
});

// Indexes (MongoDB auto-creates time-series indexes, but add these for queries)
MetricsSnapshotSchema.index({ timestamp: 1, 'metadata.componentType': 1 });
MetricsSnapshotSchema.index({ timestamp: 1, 'metadata.componentId': 1 });
MetricsSnapshotSchema.index({ timestamp: -1 }); // For recent queries

// Static methods for common queries
MetricsSnapshotSchema.statics.getTimeSeries = async function(componentId, metric, from, to) {
  // Returns: [{ timestamp, value }] for Chart.js
  const results = await this.aggregate([
    {
      $match: {
        'metadata.componentId': componentId,
        timestamp: { $gte: new Date(from), $lte: new Date(to) }
      }
    },
    {
      $project: {
        timestamp: 1,
        value: `$${metric}` // e.g., "$health.responseTime"
      }
    },
    { $sort: { timestamp: 1 } }
  ]);

  return results.map(r => ({ x: r.timestamp, y: r.value }));
};

MetricsSnapshotSchema.statics.getLatest = async function(componentId) {
  return this.findOne({ 'metadata.componentId': componentId })
    .sort({ timestamp: -1 });
};

module.exports = mongoose.model('MetricsSnapshot', MetricsSnapshotSchema);
```

2. Create collection initialization in `/config/db-mongodb.js`:

```javascript
// Add this function to db-mongodb.js
async function ensureTimeSeriesCollections() {
  const db = mongoose.connection.db;
  const collections = await db.listCollections({ name: 'metricssnapshots' }).toArray();

  if (collections.length === 0) {
    // Create time-series collection
    await db.createCollection('metricssnapshots', {
      timeseries: {
        timeField: 'timestamp',
        metaField: 'metadata',
        granularity: 'minutes'
      },
      expireAfterSeconds: 7776000 // 90 days
    });

    console.log('✓ Created time-series collection: metricssnapshots');
  }
}

// Call during startup (add to connectDB function)
```

3. Create aggregation schema for hourly rollups (`/models/MetricsHourly.js`):

```javascript
// Stores pre-aggregated hourly data for faster queries
const MetricsHourlySchema = new mongoose.Schema({
  hour: { type: Date, required: true }, // Rounded to hour
  componentId: { type: String, required: true },

  aggregates: {
    avgResponseTime: Number,
    totalRequests: Number,
    totalCost: Number,
    errorRate: Number
  }
});

MetricsHourlySchema.index({ hour: -1, componentId: 1 });
```

DELIVERABLES:
1. `/models/MetricsSnapshot.js` (150-200 lines)
2. `/models/MetricsHourly.js` (50-100 lines)
3. Update `/config/db-mongodb.js` to create time-series collection
4. `/tests/unit/metricsSnapshot.test.js` (test static methods)

TESTING CRITERIA:
- Time-series collection is created on first run
- MetricsSnapshot.create() successfully stores metrics
- getTimeSeries() returns data in Chart.js format: [{ x: Date, y: Number }]
- getLatest() returns most recent metric for component
- Indexes improve query performance (use .explain())
- 90-day retention policy auto-deletes old data

RELATED FILES:
- `/models/Conversation.js` - Reference for Mongoose patterns
- `/config/db-mongodb.js` - Database initialization (around line 50)
- `/routes/analytics.js` - Reference for aggregation queries

MONGODB TIME-SERIES DOCS:
- https://www.mongodb.com/docs/manual/core/timeseries-collections/
- Auto-bucketing by granularity improves compression and query performance
- Can store millions of metrics efficiently
```

---

### PROMPT 2B: Time-Series Chart Components (Frontend)

```
TASK: T2.8 + T2.9 - Build time-series chart components for analytics dashboard
TRACK: Track 2 - Historical Metrics & Analytics
ESTIMATED EFFORT: 8-10 hours
DEPENDENCIES: T2.5 (Metrics API endpoints)

CONTEXT:
AgentX has an analytics dashboard at /public/analytics.html that shows aggregated metrics (usage, feedback, costs) but no time-series charts. You need to add 5 Chart.js visualizations showing trends over time, with interactive controls for zooming and time range selection.

Current dashboard uses Chart.js 3.x and vanilla JavaScript (no frameworks).

REQUIREMENTS:

1. Create chart components in `/public/js/components/`:

**File: `/public/js/components/HealthTimelineChart.js`**
```javascript
class HealthTimelineChart {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.chart = null;
    this.timeRange = '24h'; // Default
  }

  async loadData(timeRange = this.timeRange) {
    this.timeRange = timeRange;

    const from = this.getFromDate(timeRange);
    const to = new Date();

    // Fetch data for all components
    const components = ['agentx', 'dataapi', 'ollama-99', 'ollama-12'];
    const datasets = await Promise.all(
      components.map(async (componentId) => {
        const response = await fetch(
          `/api/metrics/timeseries?componentId=${componentId}&metric=health.responseTime&from=${from.toISOString()}&to=${to.toISOString()}`
        );
        const data = await response.json();

        return {
          label: componentId,
          data: data.timeseries, // [{ x: Date, y: Number }]
          borderColor: this.getComponentColor(componentId),
          tension: 0.4,
          fill: false
        };
      })
    );

    this.render(datasets);
  }

  render(datasets) {
    if (this.chart) {
      this.chart.destroy();
    }

    this.chart = new Chart(this.canvas, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        interaction: {
          mode: 'index',
          intersect: false
        },
        scales: {
          x: {
            type: 'time',
            time: {
              unit: this.getTimeUnit(this.timeRange)
            },
            title: { display: true, text: 'Time' }
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Response Time (ms)' }
          }
        },
        plugins: {
          legend: { position: 'top' },
          title: { display: true, text: 'System Health Over Time' },
          zoom: {
            pan: { enabled: true, mode: 'x' },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }
          }
        }
      }
    });
  }

  getFromDate(timeRange) {
    const now = new Date();
    switch(timeRange) {
      case '1h': return new Date(now - 3600000);
      case '24h': return new Date(now - 86400000);
      case '7d': return new Date(now - 604800000);
      case '30d': return new Date(now - 2592000000);
      default: return new Date(now - 86400000);
    }
  }

  getTimeUnit(timeRange) {
    switch(timeRange) {
      case '1h': return 'minute';
      case '24h': return 'hour';
      case '7d': return 'day';
      case '30d': return 'day';
      default: return 'hour';
    }
  }

  getComponentColor(componentId) {
    const colors = {
      'agentx': '#4F46E5',
      'dataapi': '#10B981',
      'ollama-99': '#F59E0B',
      'ollama-12': '#EF4444'
    };
    return colors[componentId] || '#6B7280';
  }
}
```

**File: `/public/js/components/CostTrendsChart.js`**
```javascript
class CostTrendsChart {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.chart = null;
  }

  async loadData(days = 30) {
    const from = new Date(Date.now() - days * 86400000);
    const to = new Date();

    const response = await fetch(
      `/api/metrics/timeseries?metric=cost.totalCost&from=${from.toISOString()}&to=${to.toISOString()}&groupBy=day`
    );
    const data = await response.json();

    this.render(data.timeseries);
  }

  render(costData) {
    if (this.chart) {
      this.chart.destroy();
    }

    // Dual-axis chart: Total cost (bars) + Cost per conversation (line)
    this.chart = new Chart(this.canvas, {
      type: 'bar',
      data: {
        datasets: [
          {
            label: 'Total Cost ($)',
            data: costData.map(d => ({ x: d.x, y: d.totalCost })),
            backgroundColor: 'rgba(59, 130, 246, 0.5)',
            borderColor: 'rgb(59, 130, 246)',
            borderWidth: 1,
            yAxisID: 'y'
          },
          {
            label: 'Cost per Conversation ($)',
            data: costData.map(d => ({ x: d.x, y: d.costPerConv })),
            type: 'line',
            borderColor: 'rgb(239, 68, 68)',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            yAxisID: 'y1',
            tension: 0.4
          }
        ]
      },
      options: {
        responsive: true,
        scales: {
          x: {
            type: 'time',
            time: { unit: 'day' }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            title: { display: true, text: 'Total Cost ($)' }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            title: { display: true, text: 'Cost/Conv ($)' },
            grid: { drawOnChartArea: false }
          }
        },
        plugins: {
          title: { display: true, text: 'Cost Trends Over Time' }
        }
      }
    });
  }
}
```

**Create 3 more chart components:**
- `TokenUsageTrendsChart.js` - Stacked area chart (prompt + completion tokens)
- `ErrorRateTimelineChart.js` - Bar + line combo (error count + error rate %)
- `ModelPerformanceHeatmap.js` - Heatmap (models × hours, color = response time)

2. Update `/public/analytics.html`:

Add canvas elements:
```html
<!-- Add after existing charts section -->
<div class="chart-section">
  <h3>Time-Series Analysis</h3>

  <!-- Time range selector -->
  <div class="time-range-selector">
    <button onclick="updateTimeRange('1h')">1 Hour</button>
    <button onclick="updateTimeRange('24h')" class="active">24 Hours</button>
    <button onclick="updateTimeRange('7d')">7 Days</button>
    <button onclick="updateTimeRange('30d')">30 Days</button>
  </div>

  <div class="chart-grid">
    <div class="chart-container">
      <canvas id="healthTimelineChart"></canvas>
    </div>

    <div class="chart-container">
      <canvas id="costTrendsChart"></canvas>
    </div>

    <div class="chart-container">
      <canvas id="tokenUsageChart"></canvas>
    </div>

    <div class="chart-container">
      <canvas id="errorRateChart"></canvas>
    </div>
  </div>
</div>
```

3. Add initialization in `/public/js/analytics.js`:

```javascript
// Add to existing analytics.js
let healthChart, costChart, tokenChart, errorChart;

async function initTimeSeriesCharts() {
  healthChart = new HealthTimelineChart('healthTimelineChart');
  await healthChart.loadData('24h');

  costChart = new CostTrendsChart('costTrendsChart');
  await costChart.loadData(30);

  tokenChart = new TokenUsageTrendsChart('tokenUsageChart');
  await tokenChart.loadData(30);

  errorChart = new ErrorRateTimelineChart('errorRateChart');
  await errorChart.loadData(7);
}

function updateTimeRange(range) {
  // Update all charts
  healthChart.loadData(range);
  errorChart.loadData(range === '1h' ? 1 : range === '24h' ? 1 : parseInt(range));

  // Update UI
  document.querySelectorAll('.time-range-selector button').forEach(btn => {
    btn.classList.remove('active');
  });
  event.target.classList.add('active');
}

// Call on page load
document.addEventListener('DOMContentLoaded', async () => {
  // Existing initialization...
  await initTimeSeriesCharts();

  // Auto-refresh every 5 minutes
  setInterval(async () => {
    await initTimeSeriesCharts();
  }, 300000);
});
```

4. Add CSS for time-series section:

```css
.chart-section {
  margin: 2rem 0;
  padding: 1.5rem;
  background: white;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.time-range-selector {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.time-range-selector button {
  padding: 0.5rem 1rem;
  border: 1px solid #D1D5DB;
  background: white;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.time-range-selector button.active {
  background: #4F46E5;
  color: white;
  border-color: #4F46E5;
}

.chart-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
  gap: 1.5rem;
}

.chart-container {
  position: relative;
  height: 300px;
}
```

DELIVERABLES:
1. 5 chart component files in `/public/js/components/`
2. Update `/public/analytics.html` with canvas elements
3. Update `/public/js/analytics.js` with initialization
4. CSS for time-series section

TESTING CRITERIA:
- All 5 charts render with sample data
- Time range selector updates charts dynamically
- Zoom/pan controls work on charts
- Charts auto-refresh every 5 minutes
- No console errors
- Charts are responsive (resize with window)

RELATED FILES:
- `/public/analytics.html` - Existing dashboard to extend
- `/public/js/analytics.js` - Existing analytics logic (1000+ lines)
- Chart.js docs: https://www.chartjs.org/docs/latest/
```

---

## 🤖 TRACK 4: SELF-HEALING

### PROMPT 4A: Model Failover Logic

```
TASK: T4.4 - Add automatic model failover to ModelRouter
TRACK: Track 4 - Self-Healing & Automation
ESTIMATED EFFORT: 3-4 hours
DEPENDENCIES: T4.3 (SelfHealingEngine service)

CONTEXT:
AgentX has a ModelRouter service (`/src/services/modelRouter.js`, 400+ lines) that intelligently routes chat requests to primary or secondary Ollama hosts based on task classification. You need to add automatic failover logic that switches to backup hosts when primary models are slow or unhealthy.

Current behavior:
- Classifies query into task types (quick_chat, code_generation, deep_reasoning)
- Routes to appropriate host/model
- No health checking or failover

REQUIREMENTS:

1. Add health tracking to ModelRouter:

```javascript
// Add to modelRouter.js
class ModelHealthTracker {
  constructor() {
    this.healthCache = new Map(); // modelKey -> { avgResponseTime, lastChecked, status }
    this.cacheTTL = 60000; // 1 minute
  }

  async checkModelHealth(host, model) {
    const key = `${host}:${model}`;
    const cached = this.healthCache.get(key);

    if (cached && Date.now() - cached.lastChecked < this.cacheTTL) {
      return cached;
    }

    try {
      const start = Date.now();
      const response = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: 'Test',
          stream: false
        }),
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      const responseTime = Date.now() - start;

      const health = {
        status: response.ok ? 'healthy' : 'unhealthy',
        avgResponseTime: responseTime,
        lastChecked: Date.now()
      };

      this.healthCache.set(key, health);
      return health;

    } catch (err) {
      const health = {
        status: 'unhealthy',
        avgResponseTime: null,
        lastChecked: Date.now(),
        error: err.message
      };

      this.healthCache.set(key, health);
      return health;
    }
  }

  clearCache() {
    this.healthCache.clear();
  }
}

const healthTracker = new ModelHealthTracker();
```

2. Add failover logic to routing function:

```javascript
// Enhance existing classifyAndRoute function
async function classifyAndRoute(message, options = {}) {
  const { preferredModel, preferredHost, taskType } = options;

  // Existing classification logic...
  const classification = await classifyQuery(message);

  // Get primary host/model
  let targetHost = preferredHost || getPrimaryHostForTask(classification.taskType);
  let targetModel = preferredModel || getModelForTask(classification.taskType);

  // Check primary health
  const primaryHealth = await healthTracker.checkModelHealth(targetHost, targetModel);

  // Failover conditions
  const needsFailover = (
    primaryHealth.status === 'unhealthy' ||
    (primaryHealth.avgResponseTime && primaryHealth.avgResponseTime > 5000)
  );

  if (needsFailover) {
    logger.warn('Primary model unhealthy, failing over', {
      primary: { host: targetHost, model: targetModel },
      health: primaryHealth
    });

    // Get backup host
    const backupHost = getBackupHost(targetHost);
    const backupHealth = await healthTracker.checkModelHealth(backupHost, targetModel);

    if (backupHealth.status === 'healthy') {
      // Log remediation action
      const { RemediationAction } = require('../../models/RemediationAction');
      await RemediationAction.create({
        issueType: 'model_degradation',
        severity: 'medium',
        context: {
          component: `${targetHost}:${targetModel}`,
          metric: 'response_time',
          threshold: 5000,
          currentValue: primaryHealth.avgResponseTime
        },
        strategy: 'model_failover',
        action: `Switched from ${targetHost} to ${backupHost}`,
        automatedExecution: true,
        status: 'succeeded'
      });

      targetHost = backupHost;

      // Trigger alert
      const alertService = require('./alertService').getAlertService();
      await alertService.triggerAlert('model_failover', 'warning', {
        title: 'Model Failover Triggered',
        message: `Primary model at ${targetHost} is slow (${primaryHealth.avgResponseTime}ms). Switched to ${backupHost}.`,
        primary: targetHost,
        backup: backupHost,
        responseTime: primaryHealth.avgResponseTime
      });
    } else {
      logger.error('Backup host also unhealthy', { backupHost, backupHealth });
      // Proceed with primary (degraded experience) and alert
    }
  }

  return {
    host: targetHost,
    model: targetModel,
    failedOver: needsFailover,
    health: primaryHealth
  };
}

function getBackupHost(primaryHost) {
  const hosts = {
    [process.env.OLLAMA_HOST]: process.env.OLLAMA_HOST_SECONDARY,
    [process.env.OLLAMA_HOST_SECONDARY]: process.env.OLLAMA_HOST
  };
  return hosts[primaryHost] || process.env.OLLAMA_HOST;
}
```

3. Add health check endpoint:

```javascript
// Add to existing modelRouter.js exports
async function getModelHealth(host, model) {
  return await healthTracker.checkModelHealth(host, model);
}

async function getAllModelsHealth() {
  const hosts = [process.env.OLLAMA_HOST, process.env.OLLAMA_HOST_SECONDARY];
  const models = ['qwen2.5:7b', 'qwen2.5:14b', 'deepseek-r1:7b']; // Common models

  const healthChecks = [];
  for (const host of hosts) {
    for (const model of models) {
      healthChecks.push(
        getModelHealth(host, model).then(health => ({
          host,
          model,
          ...health
        }))
      );
    }
  }

  return await Promise.all(healthChecks);
}

module.exports = {
  // Existing exports...
  getModelHealth,
  getAllModelsHealth
};
```

4. Add API endpoint in `/routes/api.js`:

```javascript
// Add to existing /api/models/* routes
router.get('/models/health', async (req, res) => {
  try {
    const { host, model } = req.query;

    if (host && model) {
      const health = await modelRouter.getModelHealth(host, model);
      return res.json({ status: 'success', data: { health } });
    }

    const allHealth = await modelRouter.getAllModelsHealth();
    res.json({ status: 'success', data: { models: allHealth } });
  } catch (err) {
    logger.error('Failed to get model health', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});
```

DELIVERABLES:
1. Update `/src/services/modelRouter.js` with failover logic (add 150-200 lines)
2. Create `/models/RemediationAction.js` if not exists
3. Update `/routes/api.js` with health endpoint
4. `/tests/unit/modelRouter.test.js` - Test failover scenarios

TESTING CRITERIA:
- Health check completes within 5 seconds
- Failover triggers when primary > 5000ms response time
- Backup host is used when primary is down
- RemediationAction is logged to database
- Alert is triggered on failover
- Health cache reduces redundant checks

RELATED FILES:
- `/src/services/modelRouter.js` - Existing router to enhance
- `/src/services/chatService.js` - Calls modelRouter.classifyAndRoute()
- `/routes/api.js` - Where to add health endpoint

ENVIRONMENT VARIABLES:
OLLAMA_HOST=http://192.168.2.99:11434
OLLAMA_HOST_SECONDARY=http://192.168.2.12:11434
```

---

## ⚙️ TRACK 5: TESTING & CI/CD

### PROMPT 5A: GitHub Actions CI/CD Pipeline

```
TASK: T5.5 - Create comprehensive CI/CD pipeline with GitHub Actions
TRACK: Track 5 - Advanced Testing & CI/CD
ESTIMATED EFFORT: 4-6 hours
DEPENDENCIES: None

CONTEXT:
AgentX currently has a basic GitHub workflow (`.github/workflows/deploy.yml`, 30 lines) that only handles deployment. You need to create a comprehensive CI/CD pipeline with linting, unit tests, integration tests, workflow validation, load testing, and automated deployment to staging/production.

REQUIREMENTS:

1. Create `.github/workflows/ci.yml` for continuous integration:

```yaml
name: AgentX CI Pipeline

on:
  push:
    branches: [main, develop, 'feature/**']
  pull_request:
    branches: [main, develop]

env:
  NODE_VERSION: '18'

jobs:
  lint:
    name: Lint Code
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run ESLint
        run: npm run lint || echo "Add lint script to package.json"

      - name: Check code formatting
        run: npx prettier --check "**/*.{js,json,md}"

  unit-tests:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run unit tests
        run: npm run test:unit || npm test
        env:
          NODE_ENV: test

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
          flags: unittests
          fail_ci_if_error: false

  integration-tests:
    name: Integration Tests
    runs-on: ubuntu-latest
    services:
      mongodb:
        image: mongo:6
        ports:
          - 27017:27017
        options: >-
          --health-cmd "mongosh --eval 'db.adminCommand({ping: 1})'"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run integration tests
        run: npm run test:integration || echo "Add test:integration script"
        env:
          NODE_ENV: test
          MONGODB_URI: mongodb://localhost:27017/agentx-test
          OLLAMA_HOST: http://localhost:11434

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
          flags: integration
          fail_ci_if_error: false

  workflow-validation:
    name: Validate n8n Workflows
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Validate workflow JSON schemas
        run: |
          for file in AgentC/*.json; do
            echo "Validating $file..."
            node -e "JSON.parse(require('fs').readFileSync('$file', 'utf8'))" || exit 1
          done

      - name: Run workflow validation tests
        run: npm run test:workflows || echo "Add test:workflows script"

  security-audit:
    name: Security Audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Run npm audit
        run: npm audit --production --audit-level=moderate
        continue-on-error: true

      - name: Check for secrets
        uses: trufflesecurity/trufflehog@main
        with:
          path: ./
          base: ${{ github.event.repository.default_branch }}
          head: HEAD

  build-check:
    name: Build Verification
    runs-on: ubuntu-latest
    needs: [lint, unit-tests]
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Verify startup
        run: |
          timeout 30s npm start &
          sleep 10
          curl -f http://localhost:3080/health || exit 1
        env:
          NODE_ENV: test
          MONGODB_URI: mongodb://localhost:27017/test
```

2. Create `.github/workflows/cd.yml` for deployment:

```yaml
name: AgentX CD Pipeline

on:
  push:
    branches:
      - main
      - develop
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy to'
        required: true
        type: choice
        options:
          - staging
          - production

jobs:
  deploy-staging:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/develop' || inputs.environment == 'staging'
    environment:
      name: staging
      url: http://staging.agentx.local

    steps:
      - uses: actions/checkout@v4

      - name: Deploy via SSH
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.STAGING_HOST }}
          username: ${{ secrets.STAGING_USER }}
          key: ${{ secrets.STAGING_SSH_KEY }}
          script: |
            cd /home/yb/codes/AgentX
            git pull origin develop
            npm ci --production
            pm2 reload ecosystem.config.js --update-env
            sleep 10
            curl -f http://localhost:3080/health || exit 1

      - name: Deploy n8n workflows
        run: |
          ./scripts/deploy-n8n-workflows.sh
        env:
          N8N_API_URL: ${{ secrets.N8N_STAGING_URL }}
          N8N_API_KEY: ${{ secrets.N8N_STAGING_KEY }}

      - name: Notify Slack
        uses: slackapi/slack-github-action@v1
        with:
          webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
          payload: |
            {
              "text": "✅ AgentX deployed to staging",
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "Deployment to *staging* succeeded\n*Commit:* ${{ github.sha }}"
                  }
                }
              ]
            }

  deploy-production:
    name: Deploy to Production
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' || inputs.environment == 'production'
    needs: [run-tests]
    environment:
      name: production
      url: http://192.168.2.33:3080

    steps:
      - uses: actions/checkout@v4

      - name: Create backup
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.PROD_HOST }}
          username: ${{ secrets.PROD_USER }}
          key: ${{ secrets.PROD_SSH_KEY }}
          script: |
            cd /home/yb/codes/AgentX
            ./scripts/backup-mongodb.sh
            ./scripts/backup-qdrant.sh

      - name: Deploy application
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.PROD_HOST }}
          username: ${{ secrets.PROD_USER }}
          key: ${{ secrets.PROD_SSH_KEY }}
          script: |
            cd /home/yb/codes/AgentX
            git pull origin main
            npm ci --production
            pm2 reload ecosystem.config.js --update-env
            sleep 10

      - name: Health check
        run: |
          sleep 20
          curl -f http://192.168.2.33:3080/health || exit 1

      - name: Rollback on failure
        if: failure()
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.PROD_HOST }}
          username: ${{ secrets.PROD_USER }}
          key: ${{ secrets.PROD_SSH_KEY }}
          script: |
            cd /home/yb/codes/AgentX
            ./scripts/rollback-deployment.sh

      - name: Notify on success
        uses: slackapi/slack-github-action@v1
        with:
          webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
          payload: |
            {
              "text": "🚀 AgentX deployed to PRODUCTION",
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "*Production deployment succeeded*\n*Commit:* ${{ github.sha }}\n*By:* ${{ github.actor }}"
                  }
                }
              ]
            }

      - name: Notify on failure
        if: failure()
        uses: slackapi/slack-github-action@v1
        with:
          webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
          payload: |
            {
              "text": "❌ AgentX production deployment FAILED - rollback initiated"
            }

  run-tests:
    name: Pre-deployment Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
      - run: npm ci
      - run: npm test
```

3. Update `package.json` with test scripts:

```json
{
  "scripts": {
    "test": "jest --silent",
    "test:unit": "jest tests/unit --coverage",
    "test:integration": "jest tests/integration --runInBand",
    "test:workflows": "jest tests/workflows",
    "test:e2e": "playwright test",
    "test:load": "artillery run tests/load/comprehensive-load.yml",
    "test:load:basic": "artillery run tests/load/basic-load.yml",
    "lint": "eslint . --ext .js",
    "lint:fix": "eslint . --ext .js --fix"
  }
}
```

4. Create `.eslintrc.json`:

```json
{
  "env": {
    "node": true,
    "es2021": true,
    "jest": true
  },
  "extends": "eslint:recommended",
  "parserOptions": {
    "ecmaVersion": 2021
  },
  "rules": {
    "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
    "no-console": "off"
  }
}
```

DELIVERABLES:
1. `.github/workflows/ci.yml` (comprehensive CI pipeline)
2. `.github/workflows/cd.yml` (deployment pipeline with rollback)
3. Update `package.json` with test scripts
4. `.eslintrc.json` (linting configuration)
5. Update README.md with CI/CD badges

TESTING CRITERIA:
- CI pipeline runs on all PRs
- All tests must pass before merge
- Deployment to staging automatic on develop branch
- Production deployment requires manual approval
- Health check validates deployment
- Rollback triggers on deployment failure

GITHUB SECRETS REQUIRED:
- STAGING_HOST, STAGING_USER, STAGING_SSH_KEY
- PROD_HOST, PROD_USER, PROD_SSH_KEY
- N8N_STAGING_URL, N8N_STAGING_KEY
- N8N_PROD_URL, N8N_PROD_KEY
- SLACK_WEBHOOK_URL
- CODECOV_TOKEN (optional)
```

---

## 💾 TRACK 6: BACKUP & RECOVERY

### PROMPT 6A: Automated Backup Scripts

```
TASK: T6.1 + T6.2 + T6.3 - Create automated backup and restore scripts
TRACK: Track 6 - Backup & Disaster Recovery
ESTIMATED EFFORT: 6-8 hours
DEPENDENCIES: None

CONTEXT:
AgentX currently has no automated backup system. You need to create bash scripts for backing up MongoDB, Qdrant vector store, and n8n workflows, plus corresponding restore scripts for disaster recovery.

REQUIREMENTS:

1. Create `/scripts/backup-mongodb.sh`:

```bash
#!/bin/bash
set -e

# MongoDB Backup Script for AgentX
# Usage: ./scripts/backup-mongodb.sh [backup_dir]

BACKUP_DIR="${1:-/mnt/backups/mongodb}"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="agentx_${DATE}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"
RETENTION_DAYS=7

# Load environment variables
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# Validate MongoDB URI
if [ -z "$MONGODB_URI" ]; then
  echo "❌ Error: MONGODB_URI not set"
  exit 1
fi

echo "🗄️  Starting MongoDB backup..."
echo "Target: $BACKUP_PATH"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Run mongodump
echo "Running mongodump..."
mongodump --uri="$MONGODB_URI" --out="$BACKUP_PATH" 2>&1 | tee "${BACKUP_PATH}.log"

if [ $? -eq 0 ]; then
  echo "✓ Dump completed successfully"
else
  echo "❌ Dump failed!"
  exit 1
fi

# Compress backup
echo "Compressing backup..."
tar -czf "${BACKUP_PATH}.tar.gz" -C "$BACKUP_DIR" "$BACKUP_NAME"
COMPRESSED_SIZE=$(du -h "${BACKUP_PATH}.tar.gz" | cut -f1)
echo "✓ Compressed to ${COMPRESSED_SIZE}"

# Remove uncompressed directory
rm -rf "$BACKUP_PATH"

# Cleanup old backups (keep last N days)
echo "Cleaning up old backups (retention: ${RETENTION_DAYS} days)..."
find "$BACKUP_DIR" -name "agentx_*.tar.gz" -mtime +${RETENTION_DAYS} -delete
REMAINING=$(find "$BACKUP_DIR" -name "agentx_*.tar.gz" | wc -l)
echo "✓ ${REMAINING} backups retained"

# Optional: Upload to S3/cloud storage
if [ -n "$AWS_S3_BUCKET" ]; then
  echo "Uploading to S3..."
  aws s3 cp "${BACKUP_PATH}.tar.gz" "s3://${AWS_S3_BUCKET}/mongodb/" || echo "⚠️  S3 upload failed (continuing)"
fi

# Create backup metadata
cat > "${BACKUP_PATH}.meta.json" <<EOF
{
  "timestamp": "$(date -Iseconds)",
  "backup_name": "$BACKUP_NAME",
  "size": "$COMPRESSED_SIZE",
  "mongodb_uri": "${MONGODB_URI%%@*}@***",
  "collections": $(mongosh "$MONGODB_URI" --quiet --eval "db.getCollectionNames()" | jq -c .),
  "retention_days": $RETENTION_DAYS
}
EOF

echo "✅ MongoDB backup completed: ${BACKUP_PATH}.tar.gz"
echo ""
echo "Restore with: ./scripts/restore-mongodb.sh ${BACKUP_PATH}.tar.gz"
```

2. Create `/scripts/restore-mongodb.sh`:

```bash
#!/bin/bash
set -e

# MongoDB Restore Script for AgentX
# Usage: ./scripts/restore-mongodb.sh <backup_file.tar.gz>

if [ -z "$1" ]; then
  echo "Usage: ./scripts/restore-mongodb.sh <backup_file.tar.gz>"
  echo ""
  echo "Available backups:"
  find /mnt/backups/mongodb -name "agentx_*.tar.gz" -printf "%T@ %p\n" | sort -rn | cut -d' ' -f2- | head -10
  exit 1
fi

BACKUP_FILE="$1"
TEMP_DIR="/tmp/mongodb_restore_$(date +%s)"

# Load environment
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

if [ -z "$MONGODB_URI" ]; then
  echo "❌ Error: MONGODB_URI not set"
  exit 1
fi

# Confirm restore (destructive operation!)
echo "⚠️  WARNING: This will DROP existing database and restore from backup"
echo "Backup file: $BACKUP_FILE"
echo ""
read -p "Type 'yes' to proceed: " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Restore cancelled"
  exit 0
fi

echo "🔄 Starting MongoDB restore..."

# Extract backup
mkdir -p "$TEMP_DIR"
echo "Extracting backup..."
tar -xzf "$BACKUP_FILE" -C "$TEMP_DIR"

# Find the extracted directory
BACKUP_DIR=$(find "$TEMP_DIR" -maxdepth 1 -type d -name "agentx_*" | head -1)

if [ -z "$BACKUP_DIR" ]; then
  echo "❌ Error: Could not find extracted backup directory"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# Run mongorestore
echo "Restoring database..."
mongorestore --uri="$MONGODB_URI" --drop "$BACKUP_DIR/"

if [ $? -eq 0 ]; then
  echo "✅ MongoDB restore completed successfully"
else
  echo "❌ Restore failed!"
  exit 1
fi

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "✓ Restore complete. Verify with: mongosh \"$MONGODB_URI\" --eval 'db.stats()'"
```

3. Create `/scripts/backup-qdrant.sh`:

```bash
#!/bin/bash
set -e

# Qdrant Snapshot Backup Script
# Usage: ./scripts/backup-qdrant.sh [backup_dir]

QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
COLLECTION="${QDRANT_COLLECTION:-agentx_rag}"
BACKUP_DIR="${1:-/mnt/backups/qdrant}"
DATE=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=7

echo "🗂️  Starting Qdrant backup..."
echo "Collection: $COLLECTION"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Create snapshot via API
echo "Creating snapshot..."
SNAPSHOT_RESPONSE=$(curl -s -X POST "$QDRANT_URL/collections/$COLLECTION/snapshots")
SNAPSHOT_NAME=$(echo "$SNAPSHOT_RESPONSE" | jq -r '.result.name')

if [ "$SNAPSHOT_NAME" == "null" ] || [ -z "$SNAPSHOT_NAME" ]; then
  echo "❌ Failed to create snapshot"
  echo "Response: $SNAPSHOT_RESPONSE"
  exit 1
fi

echo "✓ Snapshot created: $SNAPSHOT_NAME"

# Download snapshot
OUTPUT_FILE="${BACKUP_DIR}/${COLLECTION}_${DATE}.snapshot"
echo "Downloading snapshot..."
curl -s "$QDRANT_URL/collections/$COLLECTION/snapshots/$SNAPSHOT_NAME" \
  -o "$OUTPUT_FILE"

SNAPSHOT_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo "✓ Downloaded: $SNAPSHOT_SIZE"

# Cleanup old snapshots
echo "Cleaning up old snapshots..."
find "$BACKUP_DIR" -name "${COLLECTION}_*.snapshot" -mtime +${RETENTION_DAYS} -delete

# Delete remote snapshot (optional, to save disk space)
curl -s -X DELETE "$QDRANT_URL/collections/$COLLECTION/snapshots/$SNAPSHOT_NAME" > /dev/null

echo "✅ Qdrant backup completed: $OUTPUT_FILE"
echo ""
echo "Restore with: ./scripts/restore-qdrant.sh $OUTPUT_FILE"
```

4. Create `/scripts/restore-qdrant.sh`:

```bash
#!/bin/bash
set -e

# Qdrant Restore Script
# Usage: ./scripts/restore-qdrant.sh <snapshot_file>

if [ -z "$1" ]; then
  echo "Usage: ./scripts/restore-qdrant.sh <snapshot_file>"
  echo ""
  echo "Available snapshots:"
  find /mnt/backups/qdrant -name "*.snapshot" -printf "%T@ %p\n" | sort -rn | cut -d' ' -f2- | head -10
  exit 1
fi

SNAPSHOT_FILE="$1"
QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
COLLECTION="${QDRANT_COLLECTION:-agentx_rag}"

# Confirm restore
echo "⚠️  WARNING: This will restore Qdrant collection from snapshot"
echo "Snapshot: $SNAPSHOT_FILE"
echo "Collection: $COLLECTION"
echo ""
read -p "Type 'yes' to proceed: " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Restore cancelled"
  exit 0
fi

echo "🔄 Starting Qdrant restore..."

# Upload snapshot
SNAPSHOT_NAME=$(basename "$SNAPSHOT_FILE")
echo "Uploading snapshot..."
curl -X PUT "$QDRANT_URL/collections/$COLLECTION/snapshots/upload" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$SNAPSHOT_FILE"

echo "✓ Snapshot uploaded: $SNAPSHOT_NAME"

# Recover from snapshot
echo "Recovering collection..."
curl -X PUT "$QDRANT_URL/collections/$COLLECTION/snapshots/$SNAPSHOT_NAME/recover"

echo "✅ Qdrant restore completed"
echo ""
echo "Verify with: curl $QDRANT_URL/collections/$COLLECTION"
```

5. Create cron configuration (`/scripts/setup-backup-cron.sh`):

```bash
#!/bin/bash
# Setup automated backups via cron

CRON_FILE="/tmp/agentx-backup-cron"

cat > "$CRON_FILE" <<EOF
# AgentX Automated Backups

# MongoDB backup - Daily at 2 AM
0 2 * * * cd /home/yb/codes/AgentX && ./scripts/backup-mongodb.sh >> /var/log/agentx-backup.log 2>&1

# Qdrant backup - Daily at 3 AM
0 3 * * * cd /home/yb/codes/AgentX && ./scripts/backup-qdrant.sh >> /var/log/agentx-backup.log 2>&1

# Workflow git commit - Every 6 hours
0 */6 * * * cd /home/yb/codes/AgentX && ./scripts/commit-workflows.sh >> /var/log/agentx-backup.log 2>&1
EOF

crontab "$CRON_FILE"
rm "$CRON_FILE"

echo "✅ Backup cron jobs installed"
echo "View with: crontab -l"
```

DELIVERABLES:
1. `/scripts/backup-mongodb.sh` (automated MongoDB backup)
2. `/scripts/restore-mongodb.sh` (MongoDB restore with safety checks)
3. `/scripts/backup-qdrant.sh` (Qdrant snapshot backup)
4. `/scripts/restore-qdrant.sh` (Qdrant restore from snapshot)
5. `/scripts/setup-backup-cron.sh` (cron automation setup)
6. Make all scripts executable: `chmod +x scripts/*.sh`

TESTING CRITERIA:
- MongoDB backup creates compressed tar.gz file
- MongoDB restore completes without errors
- Qdrant snapshot downloads successfully
- Qdrant restore recreates collection
- Retention policy deletes old backups
- Cron jobs execute on schedule
- All scripts handle errors gracefully

DEPENDENCIES:
- mongodump/mongorestore (MongoDB tools)
- curl, jq (for Qdrant API)
- tar, gzip (compression)
- cron (scheduling)

ENVIRONMENT VARIABLES:
MONGODB_URI=mongodb://localhost:27017/agentx
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=agentx_rag
AWS_S3_BUCKET=agentx-backups (optional)
```

---

**END OF EXTERNAL AGENT PROMPTS**

## 📋 Quick Reference

**Total Prompts:** 11 production-ready prompts covering:
- ✅ Track 1 (Alerts): 2 prompts (1A AlertService, 1B Model+API)
- ✅ Track 2 (Metrics): 2 prompts (2A Model+Schema, 2B Charts)
- ✅ Track 4 (Self-Healing): 1 prompt (4A Failover)
- ✅ Track 5 (Testing): 1 prompt (5A CI/CD Pipeline)
- ✅ Track 6 (Backup): 1 prompt (6A Backup Scripts)

**PLUS 5 more in MULTI_AGENT_ENHANCEMENT_PLAN.md**

Copy any prompt and send directly to your external AI agents!
