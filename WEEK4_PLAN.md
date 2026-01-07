# Week 4 Plan - Multi-Tenancy, Advanced Analytics & Reliability

**Date:** 2026-01-06
**Status:** � **IN PROGRESS** (Days 1-3 Complete. Day 4 Starting)
**Duration:** Days 1-14 (accelerated execution expected)

---

## 🎯 Mission

Week 4 builds on Week 3's foundation with **enterprise-grade capabilities** and **production reliability features**:

1. **Multi-Tenancy** - Workspace isolation, user permissions, team collaboration (✅ COMPLETE)
2. **Advanced Analytics** - Custom dashboards, query builder, data export
3. **Webhook Reliability** - Retry logic, exponential backoff, dead letter queue
4. **Alert End-to-End** - Workflow verification, automated testing
5. **Documentation Completion** - User guides, API references (from Week 3 Days 13-14)

---

## Week 4 Structure

### Days 1-3: Multi-Tenant Support (✅ COMPLETE)
- **Day 1:** User Workspaces (schema, isolation) ✅
- **Day 2:** Workspace Permissions (RBAC) ✅
- **Day 3:** Workspace API & UI ✅

### Days 4-6: Advanced Analytics
- **Day 4:** Custom Dashboard Builder
- **Day 5:** Advanced Query Builder
- **Day 6:** Data Export (CSV, JSON, Excel)

### Days 7-9: Webhook Reliability
- **Day 7:** Webhook Retry Logic
- **Day 8:** Exponential Backoff
- **Day 9:** Dead Letter Queue

### Days 10-11: Alert End-to-End Verification
- **Day 10:** Workflow Integration Tests
- **Day 11:** Automated Alert Testing

### Days 12-14: Documentation & Polish
- **Day 12:** User Manual Completion (Week 3 carryover)
- **Day 13:** API Documentation Updates
- **Day 14:** Docker Containerization (optional)

---

## Days 1-3: Multi-Tenant Support 🏢

### Goal
Enable multiple teams/organizations to use AgentX with isolated workspaces.

### Architecture Decision

**Data Isolation Strategy:** Row-Level Isolation (single database, `workspaceId` field)

**Why Not Separate Databases?**
- Simpler deployment (no dynamic database creation)
- Easier cross-workspace analytics
- Standard for SaaS applications (Slack, GitHub, etc.)

### Deliverables

#### Day 1: Workspace Schema & Isolation

**1. Workspace Model** (`/models/Workspace.js`)
```javascript
const WorkspaceSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  slug: { type: String, required: true, unique: true }, // URL-friendly
  description: String,

  // Ownership
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Settings
  settings: {
    allowedModels: [String], // Restrict which models workspace can use
    apiKeyEnabled: { type: Boolean, default: true },
    ragEnabled: { type: Boolean, default: true },
    customModelsEnabled: { type: Boolean, default: false }
  },

  // Billing (future)
  plan: { type: String, enum: ['free', 'team', 'enterprise'], default: 'free' },

  // Metadata
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

WorkspaceSchema.index({ slug: 1 });
WorkspaceSchema.index({ ownerId: 1 });
```

**2. Add `workspaceId` to Existing Models**

Update these models to include `workspaceId`:
- `Conversation` - Isolate chat history
- `UserProfile` - User profiles per workspace
- `PromptConfig` - Workspace-specific prompts
- `APIKey` - Scoped to workspace
- `BenchmarkResult` - Workspace-specific benchmarks
- `CustomModel` - Workspace custom models
- `Alert` - Workspace alerts
- `AuditLog` - Workspace audit trail

**Migration Script:** `/scripts/migrate-add-workspace.js`
```javascript
// Backfill existing data with default workspace
const defaultWorkspace = await Workspace.findOne({ slug: 'default' });

await Conversation.updateMany(
  { workspaceId: { $exists: false } },
  { $set: { workspaceId: defaultWorkspace._id } }
);
// ... repeat for all models
```

**3. Workspace Middleware** (`/src/middleware/workspace.js`)
```javascript
// Attach workspace to request context
async function attachWorkspace(req, res, next) {
  // Extract workspace from:
  // 1. URL param (/:workspaceSlug/...)
  // 2. Subdomain (workspace.agentx.local)
  // 3. User's default workspace

  const workspace = await Workspace.findOne({ slug: workspaceSlug });
  req.workspace = workspace;
  next();
}

// Ensure user has access to workspace
async function requireWorkspaceAccess(req, res, next) {
  const member = await WorkspaceMember.findOne({
    workspaceId: req.workspace._id,
    userId: req.user.userId
  });

  if (!member) {
    return res.status(403).json({ status: 'error', message: 'Access denied' });
  }

  req.workspaceMember = member;
  next();
}
```

**Testing:**
- Create 2 workspaces
- Add conversations to each
- Verify cross-workspace isolation
- Test default workspace fallback

---

#### Day 2: Workspace Permissions (RBAC)

**1. WorkspaceMember Model** (`/models/WorkspaceMember.js`)
```javascript
const WorkspaceMemberSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Role-Based Access Control
  role: {
    type: String,
    enum: ['owner', 'admin', 'member', 'viewer'],
    default: 'member'
  },

  // Permissions (granular)
  permissions: {
    chat: { type: Boolean, default: true },
    rag: { type: Boolean, default: true },
    models: { type: Boolean, default: false },
    benchmark: { type: Boolean, default: false },
    alerts: { type: Boolean, default: false },
    settings: { type: Boolean, default: false }
  },

  // Metadata
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  joinedAt: { type: Date, default: Date.now }
});

WorkspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
```

**2. Permission Check Middleware** (`/src/middleware/permissions.js`)
```javascript
function requirePermission(permission) {
  return (req, res, next) => {
    const member = req.workspaceMember;

    if (member.role === 'owner' || member.role === 'admin') {
      return next(); // Admins have all permissions
    }

    if (!member.permissions[permission]) {
      return res.status(403).json({
        status: 'error',
        message: `Permission denied: ${permission}`
      });
    }

    next();
  };
}

// Role helpers
const requireAdmin = (req, res, next) => {
  if (!['owner', 'admin'].includes(req.workspaceMember.role)) {
    return res.status(403).json({ status: 'error', message: 'Admin required' });
  }
  next();
};

const requireOwner = (req, res, next) => {
  if (req.workspaceMember.role !== 'owner') {
    return res.status(403).json({ status: 'error', message: 'Owner required' });
  }
  next();
};
```

**3. Update Routes with Permissions**
```javascript
// Example: Custom Models API
router.post('/deploy',
  attachWorkspace,
  requireWorkspaceAccess,
  requirePermission('models'),
  deployModel
);

router.delete('/:id',
  attachWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  deleteModel
);
```

**Testing:**
- Create workspace with owner, admin, member, viewer
- Test permission boundaries (member can't change settings)
- Verify role escalation not possible

---

#### Day 3: Workspace API & UI

**1. Workspace Management API** (`/routes/workspaces.js`)

**Endpoints:**
```javascript
// List user's workspaces
GET /api/workspaces

// Create workspace (user becomes owner)
POST /api/workspaces
{
  "name": "Acme Corp",
  "slug": "acme-corp",
  "description": "Company workspace"
}

// Get workspace details
GET /api/workspaces/:slug

// Update workspace settings
PATCH /api/workspaces/:slug

// Delete workspace (owner only)
DELETE /api/workspaces/:slug

// List workspace members
GET /api/workspaces/:slug/members

// Invite member (admin only)
POST /api/workspaces/:slug/members
{
  "email": "user@example.com",
  "role": "member"
}

// Update member role (admin only)
PATCH /api/workspaces/:slug/members/:userId

// Remove member (admin only)
DELETE /api/workspaces/:slug/members/:userId

// Leave workspace (self)
POST /api/workspaces/:slug/leave
```

**2. Workspace Switcher UI** (`/public/components/workspace-switcher.html`)
```html
<!-- Dropdown in navbar -->
<div class="workspace-switcher">
  <button id="current-workspace" class="btn-workspace">
    <span id="workspace-name">Default</span>
    <i class="icon-chevron-down"></i>
  </button>

  <div id="workspace-menu" class="dropdown-menu">
    <div class="workspace-list">
      <!-- Dynamic list of user's workspaces -->
    </div>
    <hr>
    <button id="create-workspace">+ Create Workspace</button>
  </div>
</div>
```

**3. Workspace Settings Page** (`/public/workspace-settings.html`)

**Tabs:**
- **General** - Name, slug, description
- **Members** - Invite, manage roles
- **Settings** - Feature toggles (RAG, custom models, etc.)
- **Billing** - Plan, usage (future)
- **Danger Zone** - Delete workspace

**Testing:**
- Create workspace via UI
- Invite member
- Switch between workspaces
- Verify data isolation

---

## Days 4-6: Advanced Analytics 📊

### Goal
Enable users to build custom dashboards and export data for external analysis.

### Deliverables

#### Day 4: Custom Dashboard Builder

**1. Dashboard Schema** (`/models/Dashboard.js`)
```javascript
const DashboardSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  name: { type: String, required: true },
  description: String,

  // Layout (grid system)
  layout: [{
    widgetId: String,
    x: Number, // Grid position
    y: Number,
    width: Number, // Grid units
    height: Number
  }],

  // Widgets (chart configurations)
  widgets: [{
    id: String,
    type: { type: String, enum: ['chart', 'metric', 'table', 'markdown'] },
    title: String,

    // Data source
    query: {
      collection: String, // 'conversations', 'benchmarkresults', etc.
      aggregation: Object, // MongoDB aggregation pipeline
      refreshInterval: Number // Seconds
    },

    // Visualization
    chartType: { type: String, enum: ['line', 'bar', 'pie', 'donut', 'area'] },
    options: Object // Chart.js options
  }],

  // Access
  isPublic: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
});
```

**2. Dashboard Builder UI** (`/public/dashboard-builder.html`)

**Features:**
- Drag-and-drop widget placement (grid layout)
- Widget type selector (chart, metric, table)
- Visual query builder (select collection → fields → aggregation)
- Live preview
- Save/load templates

**Example Widgets:**
- "Conversations per Day" (line chart)
- "Model Usage Distribution" (pie chart)
- "Average Response Time" (metric)
- "Recent Alerts" (table)

---

#### Day 5: Advanced Query Builder

**1. Query Builder Component** (`/public/components/query-builder.js`)

**Features:**
- **Collection Selector** - Choose data source (conversations, benchmarks, etc.)
- **Field Selector** - Pick fields to include
- **Filter Builder** - Visual filter conditions (field, operator, value)
  - Operators: equals, not equals, contains, greater than, less than, in, not in
  - AND/OR logic
- **Aggregation** - Group by, count, sum, avg, min, max
- **Sort** - Sort by field, direction
- **Limit** - Result limit

**2. Query Execution API** (`/routes/analytics.js`)
```javascript
// POST /api/analytics/query
router.post('/query', async (req, res) => {
  const { collection, filters, aggregation, sort, limit } = req.body;

  // Security: Validate collection whitelist
  const allowedCollections = ['conversations', 'benchmarkresults', 'alerts', 'auditlogs'];
  if (!allowedCollections.includes(collection)) {
    return res.status(400).json({ status: 'error', message: 'Invalid collection' });
  }

  // Build MongoDB query
  const query = buildMongoQuery(filters);
  const pipeline = buildAggregationPipeline(aggregation);

  // Execute
  const results = await mongoose.connection.collection(collection)
    .aggregate([
      { $match: { workspaceId: req.workspace._id, ...query } },
      ...pipeline,
      { $sort: sort },
      { $limit: limit }
    ]).toArray();

  res.json({ status: 'success', data: results });
});
```

**3. Saved Queries** (`/models/SavedQuery.js`)
```javascript
const SavedQuerySchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace' },
  name: String,
  description: String,
  query: Object, // Full query definition
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
});
```

---

#### Day 6: Data Export

**1. Export API** (`/routes/export.js`)
```javascript
// POST /api/export
router.post('/', async (req, res) => {
  const { collection, filters, format } = req.body;
  // format: 'csv', 'json', 'xlsx'

  // Execute query
  const data = await mongoose.connection.collection(collection)
    .find({ workspaceId: req.workspace._id, ...filters })
    .toArray();

  // Convert to format
  if (format === 'csv') {
    const csv = jsonToCsv(data);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${collection}.csv"`);
    return res.send(csv);
  }

  if (format === 'xlsx') {
    const xlsx = jsonToExcel(data);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${collection}.xlsx"`);
    return res.send(xlsx);
  }

  // JSON (default)
  res.json({ status: 'success', data });
});
```

**2. Export UI** (`/public/export.html`)
- Select collection
- Apply filters
- Choose format (CSV, JSON, Excel)
- Download

**3. Scheduled Exports** (future enhancement)
- Cron-based exports
- Email delivery
- S3/cloud storage

---

## Days 7-9: Webhook Reliability 🔄

### Goal
Make n8n webhook calls resilient to transient failures with retry logic and dead letter queue.

### Deliverables

#### Day 7: Webhook Retry Logic

**1. WebhookQueue Model** (`/models/WebhookQueue.js`)
```javascript
const WebhookQueueSchema = new mongoose.Schema({
  url: { type: String, required: true },
  method: { type: String, default: 'POST' },
  headers: Object,
  payload: Object,

  // Retry configuration
  maxRetries: { type: Number, default: 3 },
  retryCount: { type: Number, default: 0 },
  nextRetryAt: Date,

  // Backoff strategy
  backoffStrategy: {
    type: String,
    enum: ['exponential', 'linear', 'fixed'],
    default: 'exponential'
  },

  // Status
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'failed', 'dead_letter'],
    default: 'pending'
  },

  // Result tracking
  lastError: String,
  lastAttemptAt: Date,
  completedAt: Date,

  createdAt: { type: Date, default: Date.now }
});

WebhookQueueSchema.index({ status: 1, nextRetryAt: 1 });
```

**2. Webhook Queue Service** (`/src/services/webhookQueue.js`)
```javascript
class WebhookQueue {
  async enqueue(url, payload, options = {}) {
    const webhook = new WebhookQueueModel({
      url,
      payload,
      maxRetries: options.maxRetries || 3,
      backoffStrategy: options.backoffStrategy || 'exponential',
      nextRetryAt: new Date() // Immediate first attempt
    });

    await webhook.save();

    // Trigger immediate processing
    this.processQueue();

    return webhook;
  }

  async processQueue() {
    const pending = await WebhookQueueModel.find({
      status: 'pending',
      nextRetryAt: { $lte: new Date() }
    }).limit(10);

    for (const webhook of pending) {
      await this.processWebhook(webhook);
    }
  }

  async processWebhook(webhook) {
    webhook.status = 'in_progress';
    webhook.lastAttemptAt = new Date();
    await webhook.save();

    try {
      const response = await fetch(webhook.url, {
        method: webhook.method,
        headers: webhook.headers,
        body: JSON.stringify(webhook.payload),
        timeout: 30000
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Success
      webhook.status = 'completed';
      webhook.completedAt = new Date();
      await webhook.save();

      logger.info('Webhook delivered', { url: webhook.url });
    } catch (error) {
      webhook.retryCount++;
      webhook.lastError = error.message;

      if (webhook.retryCount >= webhook.maxRetries) {
        // Move to dead letter queue
        webhook.status = 'dead_letter';
        logger.error('Webhook failed permanently', {
          url: webhook.url,
          retries: webhook.retryCount
        });
      } else {
        // Schedule retry
        webhook.nextRetryAt = this.calculateNextRetry(webhook);
        webhook.status = 'pending';
      }

      await webhook.save();
    }
  }

  calculateNextRetry(webhook) {
    const baseDelay = 60000; // 1 minute

    if (webhook.backoffStrategy === 'exponential') {
      // 1min, 2min, 4min, 8min
      const delay = baseDelay * Math.pow(2, webhook.retryCount);
      return new Date(Date.now() + delay);
    }

    if (webhook.backoffStrategy === 'linear') {
      // 1min, 2min, 3min, 4min
      const delay = baseDelay * (webhook.retryCount + 1);
      return new Date(Date.now() + delay);
    }

    // Fixed: always 1min
    return new Date(Date.now() + baseDelay);
  }
}

module.exports = new WebhookQueue();
```

---

#### Day 8: Exponential Backoff Integration

**1. Update Existing Webhook Calls**

Replace direct fetch calls with webhook queue:

**Before:**
```javascript
// In alertService.js
await fetch(webhookUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(alert)
});
```

**After:**
```javascript
const webhookQueue = require('./webhookQueue');

await webhookQueue.enqueue(webhookUrl, alert, {
  maxRetries: 5,
  backoffStrategy: 'exponential'
});
```

**2. Background Processor**

**Cron Job:** (`/scripts/process-webhook-queue.js`)
```javascript
// Run every minute via PM2 cron or system cron
const webhookQueue = require('../src/services/webhookQueue');

async function processQueue() {
  await webhookQueue.processQueue();
}

processQueue().then(() => process.exit(0));
```

**PM2 Ecosystem Update:**
```javascript
{
  name: 'webhook-processor',
  script: 'scripts/process-webhook-queue.js',
  cron_restart: '* * * * *', // Every minute
  autorestart: false
}
```

---

#### Day 9: Dead Letter Queue

**1. Dead Letter Queue UI** (`/public/webhook-dlq.html`)

**Features:**
- List failed webhooks
- View error details
- Manual retry
- Delete permanently

**2. Dead Letter Queue API** (`/routes/webhooks.js`)
```javascript
// GET /api/webhooks/dead-letter
router.get('/dead-letter', async (req, res) => {
  const deadLetters = await WebhookQueueModel.find({
    status: 'dead_letter'
  }).sort({ createdAt: -1 });

  res.json({ status: 'success', data: deadLetters });
});

// POST /api/webhooks/:id/retry
router.post('/:id/retry', async (req, res) => {
  const webhook = await WebhookQueueModel.findById(req.params.id);

  // Reset for retry
  webhook.status = 'pending';
  webhook.retryCount = 0;
  webhook.nextRetryAt = new Date();
  await webhook.save();

  // Trigger processing
  webhookQueue.processQueue();

  res.json({ status: 'success', message: 'Webhook retry scheduled' });
});

// DELETE /api/webhooks/:id
router.delete('/:id', async (req, res) => {
  await WebhookQueueModel.findByIdAndDelete(req.params.id);
  res.json({ status: 'success', message: 'Webhook deleted' });
});
```

---

## Days 10-11: Alert End-to-End Verification 🔔

### Goal
Complete the alert workflow chain and add automated testing.

### Deliverables

#### Day 10: Workflow Integration Tests

**1. Verify N1.1 (Janitor) Calls `/api/alerts`**

**Task:** Update Janitor workflow to call AgentX alerts API when errors detected

**n8n Workflow Update:**
```
[Janitor Monitor] → [Error Detection] → [HTTP Request]
  URL: http://localhost:3080/api/alerts
  Method: POST
  Headers: { "x-api-key": "${AGENTX_API_KEY}" }
  Body: {
    "type": "external",
    "severity": "error",
    "source": "janitor",
    "title": "DataAPI Service Down",
    "message": "Health check failed for DataAPI",
    "metadata": { ... }
  }
```

**2. Verify N5.1 (Analyst) Calls `/api/alerts`**

**Task:** Update Analyst workflow to call AgentX when anomalies detected

**3. Smoke Test Script** (`/scripts/test-alert-workflow.sh`)
```bash
#!/bin/bash

# Test 1: Create alert via API
echo "Creating test alert..."
curl -X POST http://localhost:3080/api/alerts \
  -H "x-api-key: ${AGENTX_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "external",
    "severity": "warning",
    "source": "test",
    "title": "Test Alert",
    "message": "End-to-end alert test"
  }'

# Test 2: Verify alert appears in UI
echo "Checking UI..."
# ... (manual step or Playwright)

# Test 3: Verify notification delivery
echo "Checking notifications..."
# ... (check email, Slack, etc.)
```

---

#### Day 11: Automated Alert Testing

**1. Alert Integration Test** (`/tests/integration/alerts-e2e.test.js`)
```javascript
describe('Alert End-to-End Flow', () => {
  it('should create alert and deliver notifications', async () => {
    // Create alert via API
    const response = await request(app)
      .post('/api/alerts')
      .set('x-api-key', process.env.AGENTX_API_KEY)
      .send({
        type: 'external',
        severity: 'warning',
        source: 'test',
        title: 'E2E Test Alert',
        message: 'Testing alert delivery'
      });

    expect(response.status).toBe(201);
    const alert = response.body.data;

    // Wait for notifications to process
    await new Promise(r => setTimeout(r, 2000));

    // Verify alert stored in database
    const storedAlert = await Alert.findById(alert.id);
    expect(storedAlert).toBeTruthy();

    // Verify notification delivery attempts
    expect(storedAlert.deliveryStatus.email).toBe('sent');
    // ... check other channels
  });
});
```

---

## Days 12-14: Documentation & Polish 📚

### Goal
Complete user-facing documentation and optional Docker support (Week 3 carryover).

### Deliverables

#### Day 12: User Manual Completion

**1. Update User Manual** (`/docs/user-manual/README.md`)

**New Sections:**
- **Workspaces** - Creating, switching, managing members
- **Permissions** - Understanding roles (owner, admin, member, viewer)
- **Custom Dashboards** - Building visualizations, query builder
- **Data Export** - Exporting conversations, benchmarks, audit logs
- **Advanced RAG** - Query expansion, re-ranking, hybrid search
- **Streaming Chat** - Real-time responses, thinking models
- **API Keys** - Scoped permissions, rotation
- **Audit Logs** - Tracking sensitive operations

**2. Screenshots & GIFs**
- Workspace switcher
- Dashboard builder
- Query builder
- Export dialog

---

#### Day 13: API Documentation Updates

**1. API Reference Updates** (`/docs/api/reference.md`)

**New Endpoint Sections:**
- **Workspaces API** (8 endpoints)
- **Custom Dashboards API** (6 endpoints)
- **Analytics Query API** (4 endpoints)
- **Export API** (3 endpoints)
- **Webhook Queue API** (5 endpoints)

**2. OpenAPI Spec** (`/docs/api/openapi.yaml`) *(optional)*
- Generate from JSDoc comments
- Use Swagger UI for interactive docs

---

#### Day 14: Docker Containerization *(optional)*

**1. Dockerfile** (`/Dockerfile`)
```dockerfile
FROM node:20-alpine

WORKDIR /app

# Dependencies
COPY package*.json ./
RUN npm ci --production

# Application
COPY . .

EXPOSE 3080

CMD ["node", "server.js"]
```

**2. Docker Compose** (`/docker-compose.yml`)
```yaml
version: '3.8'

services:
  agentx:
    build: .
    ports:
      - "3080:3080"
    environment:
      - MONGODB_URI=mongodb://mongo:27017/agentx
      - REDIS_URL=redis://redis:6379
      - OLLAMA_HOST=http://ollama:11434
    depends_on:
      - mongo
      - redis
      - ollama
    restart: unless-stopped

  mongo:
    image: mongo:7
    volumes:
      - mongo-data:/data/db
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama-data:/root/.ollama
    restart: unless-stopped

  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
    volumes:
      - qdrant-data:/qdrant/storage
    restart: unless-stopped

volumes:
  mongo-data:
  ollama-data:
  qdrant-data:
```

**3. Docker Deployment Guide** (`/docs/deployment/DOCKER.md`)

---

## Success Criteria

### Week 4 Complete When:

1. **Multi-Tenancy** ✅
   - [ ] Users can create workspaces
   - [ ] Data isolated per workspace
   - [ ] Role-based permissions enforced
   - [ ] Workspace switcher in UI

2. **Advanced Analytics** ✅
   - [ ] Custom dashboard builder works
   - [ ] Query builder generates valid queries
   - [ ] Data export (CSV, JSON) functional

3. **Webhook Reliability** ✅
   - [ ] Failed webhooks retry automatically
   - [ ] Dead letter queue shows failed webhooks
   - [ ] Manual retry works

4. **Alert E2E** ✅
   - [ ] Janitor workflow triggers alerts
   - [ ] Analyst workflow triggers alerts
   - [ ] Notifications delivered reliably

5. **Documentation** ✅
   - [ ] User manual covers all Week 4 features
   - [ ] API documentation updated
   - [ ] Docker deployment tested (optional)

---

## Code Metrics Target

- **New Files:** ~18 files (workspaces, dashboards, webhooks, tests)
- **New Code:** ~4,500 lines
- **Modified Files:** ~12 files (auth, middleware, existing routes)
- **API Endpoints:** ~25 new endpoints
- **Tests:** Integration tests for workspaces, permissions, webhooks

---

## External Agent Parallel Work

While I work on Week 4 features, external agent continues with:

**Integration Test Completion (from Week 3):**
- `cache.integration.test.js` - Finish cache tests (fix mset/stats tests)
- `api-keys.integration.test.js` - Complete API key lifecycle tests
- `audit-logging.integration.test.js` - Complete audit trail tests

**New Test Coverage:**
- `workspace.integration.test.js` - Workspace isolation and RBAC
- `dashboard.integration.test.js` - Dashboard builder and query execution
- `webhook.integration.test.js` - Webhook retry and dead letter queue

**Target Coverage:** >85% integration coverage for Week 4 features

---

## Week 4 vs Week 3 Comparison

| Metric | Week 3 | Week 4 (Target) |
|--------|--------|-----------------|
| **Scope** | Real-time + RAG + Security | Multi-tenancy + Analytics + Reliability |
| **New Files** | 12 | ~18 |
| **Lines of Code** | ~3,000 | ~4,500 |
| **API Endpoints** | 8 | ~25 |
| **Features** | Streaming, Caching, Audit Logs | Workspaces, Dashboards, Webhook Queue |
| **Focus** | Enhancement | Enterprise Features |

---

## Risks & Mitigation

### Risk 1: Multi-Tenancy Complexity
**Risk:** Workspace isolation bugs could leak data between tenants
**Mitigation:**
- Comprehensive integration tests
- Manual pen-testing
- Database query auditing (ensure `workspaceId` in all queries)

### Risk 2: Query Builder Security
**Risk:** User-generated queries could enable NoSQL injection
**Mitigation:**
- Whitelist allowed collections
- Sanitize filter inputs
- Limit aggregation pipeline complexity
- Rate limiting on query endpoint

### Risk 3: Webhook Queue Scalability
**Risk:** Large webhook backlog could overwhelm system
**Mitigation:**
- Process queue in background (separate PM2 process)
- Limit concurrent webhook processing
- Dead letter queue prevents infinite retries

---

## Next Steps: Week 5 Preview

With Week 4 complete, Week 5 could focus on:

1. **Workflow Builder** - UI for creating n8n workflows without code
2. **Mobile App** - React Native chat interface
3. **Plugin System** - Extensibility framework for custom integrations
4. **Advanced Benchmarking** - LLM-as-judge improvements, category filtering
5. **Cost Optimization** - Budget alerts, model routing based on cost

---

**Status:** 🚀 **READY TO BEGIN**
**Start Date:** 2026-01-06
**Target Completion:** 2026-01-20 (accelerated execution expected)
