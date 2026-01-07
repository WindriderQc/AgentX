# AgentX Feature Consolidation & Alignment
## Implementation Plan

**Date:** 2026-01-06
**Status:** Planning Phase
**Scope:** 4 Major Initiatives + System-Wide Feature Alignment

---

## Executive Summary

This plan consolidates AgentX features, eliminates redundancy, and creates a unified feature alignment system. Based on comprehensive codebase exploration revealing:
- **18 HTML pages** with 100+ features
- **150+ API endpoints** across 23 route files
- **Significant overlaps** in Operations/Monitoring pages
- **Scattered model management** across 3 pages
- **No feature usage tracking** or alignment visibility

### Four Core Initiatives

1. **Unified Model Catalog** - Consolidate Ollama + n8n webhook LLMs + custom models + registry into models.html
2. **Operations Center** - Merge dashboard.html + n8n-monitor.html with clear separation of concerns
3. **Feature Alignment Dashboard** - NEW page tracking API usage, feature inventory, adoption metrics, admin controls
4. **n8n LLM Integration** - Add webhook-based LLM sources (n8n flows as model providers)

### Success Criteria
- Single source of truth for models (all sources in one UI)
- Unified operations monitoring (no duplicate health checks)
- Real-time feature alignment tracking (docs ↔ frontend ↔ backend)
- n8n LLMs seamlessly integrated with Ollama models
- Zero feature loss during consolidation

---

## Current State Analysis

### Exploration Findings

**Frontend Inventory (18 HTML Pages)**:
- `index.html` - Chat interface (main user entry point)
- `models.html` - Custom model registration/deployment (311 lines)
- `dashboard.html` - Operations center with health checks
- `n8n-monitor.html` - n8n workflow monitoring and testing
- `benchmark.html` - Model performance testing (6,373 lines, largest page)
- `analytics.html` - Product metrics with cost tracking (FULLY IMPLEMENTED)
- `performance.html` - System performance monitoring
- `prompts.html` - Persona management
- `profile.html` - User memory/preferences
- `rag.html` - Document management
- `alerts.html` + `alert-analytics.html` - Alert monitoring
- `self-healing.html` - Automated remediation dashboard
- `backup.html` - Backup & recovery management
- `login.html` - Authentication
- 3 test pages (onboarding, template tester)

**Backend Inventory (23 Route Files, 150+ Endpoints)**:
- Well-documented: RAG, Benchmark, Alerts, Model Registry, Analytics
- Orphan endpoints: Cost tracking (no UI consumer - INCORRECT CLAIM, UI exists)
- Scattered functionality: Model listing across 4 endpoints
- Health checks: 3 different endpoints for similar data

**Key Finding: Cost Tracking Status**
- Previous review claimed "no dashboard" - **THIS IS FALSE**
- Cost tracking is **100% complete**: backend (370 lines), API (148 lines), UI (4 components), docs (9 files)
- Shows $0.00 because local Ollama models are free by default (by design)
- **No code needed**, only pricing configuration

### Current Overlaps

1. **Model Management** (3 pages doing related things):
   - `models.html` - Custom model registration/deployment to Ollama
   - `benchmark.html` - Model performance testing and leaderboards
   - Model Registry API - Model metadata and categorization
   - **Issue**: No unified view of "all available models from all sources"

2. **Operations/Monitoring** (2 pages, significant duplication):
   - `dashboard.html` - System health (AgentX, MongoDB, Ollama, DataAPI, n8n, Qdrant), metrics, triggers
   - `n8n-monitor.html` - n8n health, workflow deployment, webhook testing
   - **Overlap**: Both show n8n health, both have webhook triggers
   - **Different**: dashboard.html has broader system metrics, n8n-monitor has workflow-specific features

3. **Analytics Split** (well-separated, but could share components):
   - `analytics.html` - Product metrics (conversations, feedback, RAG, cost)
   - `performance.html` - System metrics (latency, throughput, load tests)
   - **Status**: Good separation, no consolidation needed

---

## Initiative 1: Unified Model Catalog

### Vision
Transform `models.html` into a comprehensive model directory showing ALL available models from all sources:
- Ollama models (from primary/secondary hosts)
- n8n webhook LLMs (cloud providers via n8n flows)
- Custom models (user-created Modelfiles)
- Model Registry (metadata, categorization, benchmarks)

### Current State: models.html
**File**: `/home/yb/codes/AgentX/public/models.html` (311 lines)
**Features**:
- Model registry grid with filtering (status, base model, search)
- Register new custom model modal (Modelfile editor, advanced tuning)
- Deploy model modal (select Ollama host)
- Model comparison UI (Ollama host comparison tool)
- Model statistics modal

**Limitation**: Only shows custom models from database. Doesn't list Ollama models directly or n8n LLMs.

### Proposed Architecture

#### Data Model: Unified Model Schema

```javascript
// Unified model object structure
{
  id: String,              // Unique identifier
  name: String,            // Display name
  provider: String,        // 'ollama', 'n8n-webhook', 'custom', 'registry'
  source: {
    type: String,          // 'ollama-host', 'n8n-webhook', 'custom-modelfile', 'registry'
    url: String,           // Ollama host URL or n8n webhook URL
    metadata: Object       // Source-specific data
  },
  capabilities: {
    maxContext: Number,
    supportsStreaming: Boolean,
    supportsThinking: Boolean,
    avgLatencyMs: Number
  },
  categories: [String],    // From Model Registry (coding, reasoning, ops, etc.)
  tags: [String],          // From Model Registry (production, experimental, etc.)
  benchmarkStats: {        // From benchmark results
    avgCompositeScore: Number,
    latency: Number,
    quality: Number
  },
  deployment: {
    status: String,        // 'available', 'deployed', 'training', 'failed'
    deployedAt: Date,
    ollamaHost: String     // If deployed to Ollama
  },
  cost: {                  // From ModelPricingConfig
    promptCostPer1M: Number,
    completionCostPer1M: Number,
    currency: String
  }
}
```

#### Backend: Model Aggregation Service

**New File**: `/home/yb/codes/AgentX/src/services/modelAggregator.js` (~400 lines)

**Responsibilities**:
- Fetch models from multiple sources (Ollama hosts, n8n webhooks, database)
- Merge with Model Registry metadata
- Enrich with benchmark stats
- Deduplicate models
- Cache aggregated results (5 min TTL)

**Key Functions**:
```javascript
async function getAllModels(options = {}) {
  // options: { includeOllama: true, includeN8n: true, includeCustom: true, includeRegistry: true, filters: {...} }
  // Returns: Array<UnifiedModelObject>
}

async function getModelByName(name, provider) {
  // Returns: UnifiedModelObject or null
}

async function getModelSources() {
  // Returns: { ollama: [...hosts], n8n: [...webhooks], custom: count, registry: count }
}

async function refreshModelCache() {
  // Forces cache refresh, returns: { modelsFound: number, sources: {...} }
}
```

**Data Flow**:
1. Call Ollama `/api/tags` on each configured host
2. Query `CustomModel` collection for custom models
3. Query `ModelRegistry` collection for registry entries
4. Query `N8nLLMSource` collection for webhook LLMs (new model)
5. Merge results, deduplicate by name
6. Enrich with benchmark stats from `BenchmarkResult`
7. Cache for 5 minutes

#### Backend: n8n LLM Source Management

**New Model**: `/home/yb/codes/AgentX/models/N8nLLMSource.js` (~150 lines)

**Schema**:
```javascript
{
  name: String,              // Display name (e.g., "GPT-4 via n8n")
  provider: String,          // 'openai', 'anthropic', 'google', 'custom'
  webhookUrl: String,        // n8n webhook URL
  authentication: {
    type: String,            // 'none', 'api-key', 'bearer'
    keyName: String,         // Header name (e.g., 'x-api-key')
    encryptedKey: String     // Encrypted API key (if needed)
  },
  capabilities: {
    maxContext: Number,
    supportsStreaming: Boolean,
    estimatedLatencyMs: Number
  },
  requestFormat: {
    method: String,          // 'POST', 'GET'
    bodyTemplate: String,    // JSON template with {{prompt}} variable
    responseExtractor: String // JSON path to response (e.g., 'data.completion')
  },
  isActive: Boolean,
  createdBy: ObjectId,
  createdAt: Date,
  lastUsed: Date,
  usageCount: Number
}
```

**New Service**: `/home/yb/codes/AgentX/src/services/n8nLLMService.js` (~300 lines)

**Responsibilities**:
- Send prompts to n8n webhook LLMs
- Handle authentication
- Parse responses based on responseExtractor
- Track usage stats
- Error handling and retries

**Key Functions**:
```javascript
async function callN8nLLM(sourceId, prompt, options = {}) {
  // Returns: { completion: String, usage: Object, latencyMs: Number }
}

async function testN8nLLM(sourceId) {
  // Test connection, returns: { success: Boolean, latency: Number, error: String }
}
```

#### API Endpoints

**New Routes**: `/home/yb/codes/AgentX/routes/models-unified.js` (~400 lines)

**Endpoints**:

1. **GET** `/api/models/all` - Get all models from all sources
   - Query params: `?provider=ollama&category=coding&tag=production&search=qwen`
   - Response: `{ status: 'success', data: { models: [...], sources: {...}, total: number } }`

2. **GET** `/api/models/sources` - List all model sources
   - Response: `{ ollama: [...hosts], n8n: [...webhooks], custom: count, registry: count }`

3. **POST** `/api/models/sources/n8n` - Register n8n webhook LLM (auth required)
   - Body: `{ name, provider, webhookUrl, authentication, capabilities, requestFormat }`
   - Response: `{ status: 'success', data: { id, name } }`

4. **PUT** `/api/models/sources/n8n/:id` - Update n8n LLM source (auth required)
   - Body: Partial update
   - Response: Updated source

5. **DELETE** `/api/models/sources/n8n/:id` - Remove n8n LLM source (auth required)
   - Response: `{ status: 'success' }`

6. **POST** `/api/models/sources/n8n/:id/test` - Test n8n LLM connection
   - Response: `{ success: Boolean, latency: Number, error: String }`

7. **GET** `/api/models/:name/detail` - Get unified model detail
   - Query params: `?provider=ollama` (optional)
   - Response: Unified model object with full metadata

8. **POST** `/api/models/refresh-cache` - Force cache refresh
   - Response: `{ modelsFound: number, sources: {...} }`

#### Frontend: models.html Redesign

**Target**: Transform into 4-section layout with excellent UX

**Section 1: Model Sources Header** (top bar)
- Quick stats: Total models, Sources (Ollama: 2 hosts, n8n: 3 webhooks, Custom: 5, Registry: 11)
- Add Source button → Modal with tabs:
  - "Add Ollama Host" (if not already configured)
  - "Add n8n Webhook LLM" (form for webhook config)
  - "Register Custom Model" (existing Modelfile creator)
- Refresh All button (force cache refresh)

**Section 2: Filters & Search** (sticky toolbar)
- Search box (fuzzy search on name)
- Provider filter: All | Ollama | n8n Webhook | Custom | Registry
- Category filter: All | ops | coding | reasoning | specialist | generalist | embedding | judge
- Tag filter: All | production | experimental | fast | high-quality | slow
- Sort by: Name | Latency | Quality Score | Context Size | Recently Used
- View mode: Grid | List | Comparison

**Section 3: Model Cards Grid** (main content)
- Card design (responsive grid, 3 cols desktop, 2 tablet, 1 mobile):
  ```
  ┌─────────────────────────────────────┐
  │ [Provider Icon] Model Name          │
  │ Source: Ollama (192.168.2.99:11434) │
  │                                     │
  │ 📊 Context: 128K | Latency: 234ms  │
  │ 🏆 Categories: coding, specialist   │
  │ 🏷️ Tags: production, fast          │
  │                                     │
  │ Benchmark: ⭐⭐⭐⭐☆ (8.2/10)       │
  │ Cost: $0.50/$1.50 per 1M tokens    │
  │                                     │
  │ [Use in Chat] [Deploy] [Compare]   │
  └─────────────────────────────────────┘
  ```

- Provider icons:
  - Ollama: 🦙 (llama emoji)
  - n8n Webhook: 🔗⚡ (chain + lightning)
  - Custom: ⚙️ (gear)
  - Registry: 📚 (books)

- Card interactions:
  - Click card → Model detail modal (full stats, benchmarks, deployment history)
  - "Use in Chat" → Opens chat interface with model pre-selected
  - "Deploy" → Deploy to Ollama host (if custom model) or test webhook (if n8n)
  - "Compare" → Add to comparison view (up to 4 models side-by-side)

**Section 4: Model Comparison View** (bottom drawer, expandable)
- Shows 2-4 models side-by-side in table format
- Columns: Name, Provider, Context, Latency, Quality, Cost, Categories, Actions
- Highlight differences (e.g., best latency in green)
- "Clear Comparison" button

**Wireframe (ASCII)**:
```
┌────────────────────────────────────────────────────────────────────┐
│  Model Catalog                                [Add Source] [Refresh]│
│  Total: 18 models | Ollama: 2 hosts | n8n: 3 webhooks | Custom: 5 │
├────────────────────────────────────────────────────────────────────┤
│  [Search models...] Provider:[All▼] Category:[All▼] Tag:[All▼]    │
│  Sort:[Name▼] View:[Grid][List][Compare]                           │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐                              │
│  │ 🦙 Qwen  │ │🔗⚡GPT-4│ │⚙️ Custom│                              │
│  │  2.5:7b │ │ via n8n │ │  Model  │  ...                         │
│  │         │ │         │ │         │                              │
│  │[Chat]   │ │[Chat]   │ │[Deploy] │                              │
│  └─────────┘ └─────────┘ └─────────┘                              │
│                                                                     │
├────────────────────────────────────────────────────────────────────┤
│  📊 Comparing 2 models:                              [Clear] [▼]   │
│  ├─ qwen2.5:7b     | Ollama | 128K | 234ms | 8.2/10 | Free        │
│  └─ GPT-4 via n8n  | n8n    | 128K | 450ms | 9.1/10 | $30/$60     │
└────────────────────────────────────────────────────────────────────┘
```

**UX Guidance**:

1. **Discovery Flow**:
   - User opens models.html
   - See all models at a glance (grid view default)
   - Use filters to narrow down (e.g., "production coding models")
   - Click model card → See full detail (benchmarks, cost, deployment history)

2. **Selection Flow**:
   - User wants best coding model
   - Filter: Category = coding, Tag = production
   - Sort by: Quality Score
   - Compare top 3 models side-by-side
   - Click "Use in Chat" → Redirects to index.html with model pre-selected

3. **Registration Flow (n8n Webhook)**:
   - Click "Add Source" → "Add n8n Webhook LLM" tab
   - Fill form:
     - Name: "GPT-4 Turbo via n8n"
     - Provider: openai
     - Webhook URL: https://n8n.specialblend.icu/webhook/llm-gpt4
     - Authentication: API Key (optional)
     - Request template: `{"prompt": "{{prompt}}", "max_tokens": {{maxTokens}}}`
     - Response path: `data.completion`
   - Click "Test Connection" → Shows latency and sample response
   - Click "Save" → Model appears in grid

4. **Deployment Flow (Custom Model)**:
   - User creates custom model (existing flow)
   - Click "Deploy" → Select Ollama host
   - Deployment progress modal → Shows Ollama build logs
   - Success → Model status changes to "deployed", appears in Ollama filter

**JavaScript Architecture**:
- `/public/js/models-unified.js` (new file, ~800 lines)
- Components:
  - `ModelGrid` - Renders model cards
  - `ModelCard` - Individual model display
  - `ModelDetailModal` - Full model info
  - `ComparisonView` - Side-by-side comparison
  - `AddSourceModal` - Register n8n webhooks / custom models
  - `FilterBar` - Search and filter controls
- State management: Plain objects, no framework needed
- API calls: Fetch `/api/models/all` with query params

**Migration Strategy**:
- Keep existing custom model features (Modelfile editor, deployment)
- Add new sections for unified catalog
- Existing bookmarks/URLs continue to work
- Progressive enhancement: Works without n8n webhooks configured

---

## Initiative 2: Operations Center Consolidation

### Vision
Merge `dashboard.html` and `n8n-monitor.html` into single Operations Center with clear separation of concerns. No feature loss, better organization, single pane of glass for all operations.

### Current State Analysis

**dashboard.html Features** (386 lines):
- System health strip (AgentX, MongoDB, DataAPI, Ollama, n8n, Qdrant)
- Uptime display
- Cache hit rate metrics
- Database document counts
- Connection pool monitoring
- Memory usage
- Collections list
- DataAPI scans list with refresh
- n8n webhook trigger interface (basic)
- RAG ingestion controls
- System events log

**n8n-monitor.html Features** (detailed):
- System health dashboard (AgentX, DataAPI, Ollama, n8n, Qdrant)
- Health percentage circle chart
- Component status cards with detailed checks
- Workflow list (N0.0-N5.1 with descriptions)
- Workflow deployment controls (deploy selected/all)
- Deploy log viewer
- Workflow test interface with payload editor
- Event history from DataAPI
- Webhook trigger with GET/POST support

**Overlaps**:
- Both show system health (identical checks)
- Both have n8n webhook triggers (different implementations)
- Both display health status of same components

**Unique to dashboard.html**:
- Cache stats, DB collections, memory usage
- DataAPI scans management
- RAG ingestion controls
- Broader system metrics

**Unique to n8n-monitor.html**:
- Workflow deployment (deploy selected/all)
- Workflow test interface with payload editor
- Deploy logs viewer
- Event history from DataAPI
- Detailed health checks per component

### Proposed Architecture

#### Consolidation Strategy: Section-Based Layout

**New dashboard.html** (Operations Center)
**Sections** (6 total, collapsible):

1. **System Health** (top, always visible)
   - Health strip (same as current)
   - Health percentage circle (from n8n-monitor)
   - Component cards with detailed status (from n8n-monitor)

2. **System Metrics** (collapsible)
   - Cache hit rate, DB collections, memory (from dashboard)
   - Connection pool (from dashboard)
   - Uptime (from dashboard)

3. **n8n Workflows** (collapsible)
   - Workflow list with deploy controls (from n8n-monitor)
   - Deploy selected/all buttons (from n8n-monitor)
   - Deploy log viewer (from n8n-monitor)

4. **Webhook Testing** (collapsible)
   - Workflow test interface with payload editor (from n8n-monitor)
   - Webhook trigger controls (enhanced from both)
   - Event history (from n8n-monitor)

5. **DataAPI Integration** (collapsible)
   - Scans list with refresh (from dashboard)
   - Scan controls (from dashboard)
   - RAG ingestion (from dashboard)

6. **System Events** (collapsible)
   - Events log (from dashboard)
   - Recent actions log (new)

**Wireframe (ASCII)**:
```
┌──────────────────────────────────────────────────────────────────┐
│  Operations Center                              [Auto-refresh: 30s]│
├──────────────────────────────────────────────────────────────────┤
│  SYSTEM HEALTH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 95% UP  │
│  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌────────┐  │
│  │AgentX │ │MongoDB│ │DataAPI│ │Ollama │ │  n8n  │ │Qdrant  │  │
│  │  ✓    │ │  ✓    │ │  ✓    │ │  ✓    │ │  ⚠   │ │   ✓    │  │
│  │ OK    │ │ OK    │ │ OK    │ │ OK    │ │ WARN  │ │  OK    │  │
│  └───────┘ └───────┘ └───────┘ └───────┘ └───────┘ └────────┘  │
├──────────────────────────────────────────────────────────────────┤
│  SYSTEM METRICS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ [▼]  │
│  Cache: 73.2% hit rate | DB: 1,234 docs | Memory: 234 MB         │
│  Connection Pool: 5/10 active | Uptime: 5d 12h 34m               │
├──────────────────────────────────────────────────────────────────┤
│  N8N WORKFLOWS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ [▼]  │
│  [Deploy Selected] [Deploy All] [Refresh]                        │
│  ☐ N1.1 Document Ingestion Scheduler                   [Deploy]  │
│  ☑ N4.4 Self-Healing Orchestrator                     [Deployed] │
│  ☐ N5.1 Backup Automation                                [Deploy] │
│                                                                   │
│  📋 Deploy Logs:                                                 │
│  [2026-01-06 10:23] N4.4 deployed successfully                   │
├──────────────────────────────────────────────────────────────────┤
│  WEBHOOK TESTING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ [▼]  │
│  Workflow: [N1.1 Doc Ingestion ▼]  Method: [POST ▼]  [Test]     │
│  Payload Editor:                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ {                                                          │ │
│  │   "text": "Test document",                                 │ │
│  │   "title": "Test",                                         │ │
│  │   "tags": ["test"]                                         │ │
│  │ }                                                          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  📊 Event History: Last 10 webhook calls                         │
│  [2026-01-06 10:30] N1.1 → Success (234ms)                       │
├──────────────────────────────────────────────────────────────────┤
│  DATAAPI INTEGRATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ [▼]  │
│  Scans: 3 active | [Refresh] | RAG Ingestion: [Trigger]         │
└──────────────────────────────────────────────────────────────────┘
```

#### Backend Changes

**Minimal** - Most APIs already exist, just need better aggregation.

**New Endpoint**: `GET /api/ops/dashboard` (consolidate multiple calls)
- Returns: `{ health, metrics, workflows, scans, events }`
- Reduces frontend chattiness (1 call instead of 5)

**Enhanced Endpoint**: `GET /api/dashboard/summary` (expand existing)
- Add workflow deployment status
- Add recent webhook events
- Add RAG ingestion status

#### Frontend Changes

**File**: `/home/yb/codes/AgentX/public/dashboard.html`
**Changes**:
- Add collapsible sections (bootstrap collapse or custom)
- Merge n8n-monitor.html features into sections
- Keep all existing features (no deletions)
- Improve layout (6-section design)

**New File**: `/public/js/ops-center.js` (~600 lines)
- Extract dashboard logic from inline JS
- Add section state management (collapsed/expanded)
- Add unified refresh logic
- Add auto-refresh toggle (30s default)

**Migration**: `/public/n8n-monitor.html`
- Add redirect: `window.location.href = '/dashboard.html#n8n'`
- Keep file for backwards compatibility (bookmarks)
- Show deprecation notice: "This page has moved to Operations Center"

---

## Initiative 3: Feature Alignment Dashboard

### Vision
NEW page that tracks feature alignment across docs/frontend/backend/roadmap, provides API telemetry, user adoption metrics, and admin controls. Enables data-driven decision making and auto-improvement guidance.

### Current State: No Equivalent
This is a completely new feature. No existing page tracks:
- Feature inventory (what exists where)
- API endpoint usage metrics
- User feature adoption
- Feature flags / toggles

### Use Cases

1. **Developer Use Case**:
   - "Is the cost tracking feature complete?"
   - Opens Feature Alignment Dashboard
   - Sees: ✅ Backend, ✅ API, ✅ Frontend, ✅ Docs, ⚠️ Roadmap (needs update)
   - Clicks "View Details" → Shows files, endpoints, pages involved

2. **Ops Use Case**:
   - "Which API endpoints are slow or unused?"
   - Opens dashboard
   - Sees: `/api/analytics/costs` - 234 calls, 45ms avg, 0 errors
   - Sees: `/api/janitor/*` - 0 calls (unused, candidate for removal)

3. **Product Use Case**:
   - "Are users adopting the RAG feature?"
   - Opens dashboard
   - Sees: RAG adoption chart - 45% of users, 78% satisfaction
   - Sees: RAG ingestion - 12 docs uploaded this week

4. **Admin Use Case**:
   - "Disable experimental voice feature for now"
   - Opens dashboard → Feature Flags section
   - Toggles "Voice Input" → OFF
   - Frontend stops showing voice button

### Proposed Architecture

#### Database Models

**1. FeatureInventory Model** (~150 lines)
```javascript
{
  name: String,              // Feature name (e.g., "Cost Tracking")
  category: String,          // 'core', 'analytics', 'operations', 'experimental'
  status: String,            // 'complete', 'partial', 'planned', 'deprecated'

  frontend: {
    exists: Boolean,
    pages: [String],         // HTML pages that use this feature
    components: [String],    // JS files involved
    lastVerified: Date
  },

  backend: {
    exists: Boolean,
    services: [String],      // Service files
    models: [String],        // Database models
    routes: [String],        // Route files
    endpoints: [String],     // API endpoints
    lastVerified: Date
  },

  documentation: {
    exists: Boolean,
    files: [String],         // Docs that cover this feature
    completeness: Number,    // 0-100%
    lastVerified: Date
  },

  roadmap: {
    status: String,          // 'complete', 'in-progress', 'planned', 'backlog'
    priority: String,        // 'critical', 'high', 'medium', 'low'
    lastUpdated: Date
  },

  metadata: {
    description: String,
    addedDate: Date,
    addedBy: String,
    tags: [String]
  }
}
```

**2. ApiTelemetry Model** (~120 lines)
```javascript
{
  endpoint: String,          // e.g., '/api/analytics/costs'
  method: String,            // 'GET', 'POST', etc.

  metrics: {
    hitCount: Number,
    totalDuration: Number,   // Sum of all request durations
    avgLatency: Number,      // Calculated average
    minLatency: Number,
    maxLatency: Number,
    p95Latency: Number,
    errorCount: Number,
    lastCalled: Date
  },

  timestamp: Date,           // Hourly rollup timestamp
  period: String             // 'hourly', 'daily', 'weekly'
}
```

**3. FeatureUsage Model** (~100 lines)
```javascript
{
  userId: ObjectId,
  feature: String,           // Feature name from FeatureInventory
  page: String,              // HTML page where feature was used
  action: String,            // 'viewed', 'clicked', 'completed'

  metadata: {
    sessionId: String,
    timestamp: Date,
    duration: Number,        // Time spent
    context: Object          // Feature-specific data
  }
}
```

**4. FeatureFlag Model** (~80 lines)
```javascript
{
  name: String,              // Unique flag name
  enabled: Boolean,
  description: String,
  scope: String,             // 'global', 'user', 'admin'

  config: {
    rolloutPercentage: Number, // 0-100 for gradual rollout
    enabledFor: [ObjectId],    // Specific user IDs (if scope='user')
    disabledFor: [ObjectId]
  },

  metadata: {
    createdAt: Date,
    updatedAt: Date,
    updatedBy: String,
    reason: String           // Why flag was changed
  }
}
```

#### Backend Services

**1. featureInventoryService.js** (~400 lines)

**Responsibilities**:
- Scan codebase to detect features (read HTML, JS, route files)
- Cross-reference with documentation
- Update FeatureInventory collection
- Calculate completeness scores
- Generate alignment reports

**Key Functions**:
```javascript
async function scanFrontend() {
  // Scans public/*.html for features
  // Returns: { features: [...], pages: [...] }
}

async function scanBackend() {
  // Scans routes/*.js, src/services/*.js, models/*.js
  // Returns: { services: [...], endpoints: [...], models: [...] }
}

async function scanDocumentation() {
  // Scans docs/**/*.md, CLAUDE.md, ROADMAP.md
  // Returns: { files: [...], coverage: {...} }
}

async function generateAlignmentReport() {
  // Compares frontend/backend/docs
  // Returns: { complete: [...], partial: [...], missing: [...] }
}

async function updateInventory() {
  // Runs all scans, updates FeatureInventory
  // Returns: { updated: number, added: number, deprecated: number }
}
```

**2. apiTelemetryService.js** (~300 lines)

**Responsibilities**:
- Track API endpoint calls (middleware)
- Record latency, errors, response times
- Aggregate metrics (hourly/daily rollups)
- Provide query interface

**Middleware**:
```javascript
function apiTelemetryMiddleware(req, res, next) {
  // Wraps API calls, records metrics
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    recordApiCall(req.path, req.method, duration, res.statusCode);
  });
  next();
}
```

**Key Functions**:
```javascript
async function recordApiCall(endpoint, method, duration, statusCode) {
  // Records single API call
}

async function getEndpointStats(endpoint, timeRange = '7d') {
  // Returns: { hitCount, avgLatency, errorRate, ... }
}

async function getTopEndpoints(limit = 10, sortBy = 'hitCount') {
  // Returns: [...endpoints sorted by metric]
}

async function getUnusedEndpoints(sinceDays = 30) {
  // Returns: [...endpoints with 0 calls in period]
}
```

**3. featureUsageService.js** (~250 lines)

**Responsibilities**:
- Track feature usage by users
- Record feature interactions
- Generate adoption metrics
- Provide cohort analysis

**Key Functions**:
```javascript
async function trackFeatureUsage(userId, feature, action, metadata) {
  // Records feature usage event
}

async function getFeatureAdoption(feature, timeRange = '30d') {
  // Returns: { totalUsers, activeUsers, adoptionRate, trend }
}

async function getUserFeatureProfile(userId) {
  // Returns: { features: [...used features], lastActive: {...} }
}

async function getUnusedFeatures(threshold = 5) {
  // Returns: Features used by <threshold% of users
}
```

**4. featureFlagService.js** (~200 lines)

**Responsibilities**:
- Check feature flag status
- Evaluate rollout rules
- Provide middleware for route gating
- Admin controls

**Key Functions**:
```javascript
async function isFeatureEnabled(flagName, userId = null) {
  // Returns: Boolean
}

async function setFeatureFlag(flagName, enabled, reason) {
  // Updates flag, records audit trail
}

function featureFlagMiddleware(flagName) {
  // Returns middleware that checks flag before allowing access
  return (req, res, next) => {
    if (!isFeatureEnabled(flagName, req.user?.id)) {
      return res.status(403).json({ error: 'Feature disabled' });
    }
    next();
  };
}
```

#### API Endpoints

**New Routes**: `/home/yb/codes/AgentX/routes/features.js` (~600 lines)

**Feature Inventory Endpoints**:

1. **GET** `/api/features/inventory` - Get all features
   - Query params: `?category=analytics&status=complete`
   - Response: `{ features: [...], stats: { complete: 15, partial: 8, planned: 5 } }`

2. **GET** `/api/features/inventory/:name` - Get feature detail
   - Response: Full FeatureInventory object

3. **POST** `/api/features/inventory/scan` - Trigger codebase scan (auth required)
   - Response: `{ updated: 23, added: 2, deprecated: 1, duration: 1234 }`

4. **GET** `/api/features/alignment-report` - Get alignment report
   - Response: `{ complete: [...], partial: [...], missing: [...] }`

**API Telemetry Endpoints**:

5. **GET** `/api/features/telemetry` - Get all endpoint stats
   - Query params: `?timeRange=7d&sortBy=hitCount&limit=50`
   - Response: `{ endpoints: [...], summary: { totalCalls: 12345, avgLatency: 123 } }`

6. **GET** `/api/features/telemetry/:endpoint` - Get specific endpoint stats
   - Response: `{ endpoint, hitCount, avgLatency, errors, ... }`

7. **GET** `/api/features/telemetry/unused` - Get unused endpoints
   - Query params: `?sinceDays=30`
   - Response: `{ endpoints: [...never called], count: 5 }`

**Feature Usage Endpoints**:

8. **POST** `/api/features/usage/track` - Track feature usage
   - Body: `{ feature, action, metadata }`
   - Response: `{ status: 'success' }`

9. **GET** `/api/features/usage/adoption` - Get adoption metrics
   - Query params: `?feature=rag&timeRange=30d`
   - Response: `{ totalUsers, activeUsers, adoptionRate, trend }`

10. **GET** `/api/features/usage/top` - Get most-used features
    - Response: `{ features: [...sorted by usage] }`

**Feature Flag Endpoints**:

11. **GET** `/api/features/flags` - List all feature flags
    - Response: `{ flags: [...] }`

12. **GET** `/api/features/flags/:name` - Get flag status
    - Response: `{ name, enabled, config, ... }`

13. **PUT** `/api/features/flags/:name` - Update flag (auth required)
    - Body: `{ enabled: Boolean, reason: String }`
    - Response: Updated flag

14. **POST** `/api/features/flags` - Create flag (auth required)
    - Body: `{ name, enabled, description, scope, config }`
    - Response: Created flag

15. **DELETE** `/api/features/flags/:name` - Delete flag (auth required)
    - Response: `{ status: 'success' }`

#### Frontend: features.html

**New Page**: `/home/yb/codes/AgentX/public/features.html` (~800 lines)

**4-Tab Layout**:

**Tab 1: Feature Inventory** (matrix view)
- Table with columns: Feature | Frontend | Backend | Docs | Roadmap | Status | Actions
- Color coding:
  - ✅ Green = Exists and complete
  - ⚠️ Yellow = Partial (some files missing)
  - ❌ Red = Missing
  - 🔵 Blue = Planned (roadmap only)
- Filters: Category, Status
- Search box
- Actions: "Scan Codebase" button, "Export Report" button

**Example Row**:
```
Cost Tracking | ✅ analytics.html (4 components) | ✅ costCalculator.js, routes/analytics.js | ✅ 9 docs files | ⚠️ Roadmap (needs update) | Complete | [View Details]
```

**Tab 2: API Telemetry** (endpoint stats)
- Table with columns: Endpoint | Method | Hits | Avg Latency | P95 | Errors | Last Called | Status
- Color coding:
  - 🟢 Green = < 100ms latency
  - 🟡 Yellow = 100-500ms latency
  - 🔴 Red = > 500ms latency OR > 1% error rate
  - ⚫ Gray = 0 hits (unused)
- Filters: Time range, Status, Sort by
- Charts:
  - Top 10 endpoints (bar chart)
  - Latency distribution (histogram)
  - Error rate trends (line chart)
- "Unused Endpoints" section (candidates for deprecation)

**Tab 3: Feature Adoption** (user engagement)
- Cards showing adoption metrics:
  - Total features: 45
  - Adopted features (>50% users): 32
  - Underutilized features (<10% users): 8
  - Deprecated features: 5
- Chart: Feature adoption over time (line chart)
- Table: Feature | Users | Adoption Rate | Trend | Category
- Filters: Time range, Category, Min adoption rate

**Tab 4: Admin Controls** (feature flags + actions)
- Feature flags table:
  - Name | Enabled | Scope | Rollout % | Updated | Actions
- Toggle switches for each flag
- "Add Feature Flag" button
- Actions section:
  - "Scan Codebase" → Triggers feature inventory scan
  - "Clear Telemetry" → Resets API stats
  - "Export Alignment Report" → Downloads CSV/JSON

**Wireframe (ASCII)**:
```
┌────────────────────────────────────────────────────────────────────┐
│  Feature Alignment Dashboard                      [Scan] [Export]  │
│                                                                     │
│  [Feature Inventory] [API Telemetry] [Adoption] [Admin Controls]  │
├────────────────────────────────────────────────────────────────────┤
│  Feature Inventory                                                 │
│  [Search...] Category:[All▼] Status:[All▼]                         │
│                                                                     │
│  Feature        │Frontend│Backend│Docs│Roadmap│Status  │Actions   │
│  ─────────────────────────────────────────────────────────────────│
│  Cost Tracking  │   ✅   │  ✅   │ ✅ │  ⚠️   │Complete│[Details] │
│  Voice Input    │   ⚠️   │  ✅   │ ❌ │  ❌   │Partial │[Details] │
│  Janitor Proxy  │   ❌   │  ✅   │ ❌ │  ❌   │Orphaned│[Details] │
│  ...            │        │       │    │       │        │          │
│                                                                     │
│  Stats: ✅ 32 complete | ⚠️ 8 partial | ❌ 5 missing | 🔵 3 planned│
└────────────────────────────────────────────────────────────────────┘
```

**JavaScript**:
- `/public/js/features-dashboard.js` (~600 lines)
- Components: InventoryTable, TelemetryTable, AdoptionChart, FlagControls
- Auto-refresh: Every 60 seconds for telemetry
- Manual refresh: "Scan Codebase" button

#### Integration Points

**1. Telemetry Middleware (Global)**:
Add to `/src/app.js`:
```javascript
const { apiTelemetryMiddleware } = require('./services/apiTelemetryService');
app.use('/api', apiTelemetryMiddleware);
```

**2. Feature Usage Tracking (Frontend)**:
Add to all HTML pages (via `/public/js/components/feature-tracker.js`):
```javascript
// Track page view
trackFeatureUsage(getCurrentUser(), getCurrentPage(), 'viewed');

// Track button clicks
document.querySelectorAll('[data-feature]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    trackFeatureUsage(getCurrentUser(), e.target.dataset.feature, 'clicked');
  });
});
```

**3. Feature Flags Check (Frontend)**:
Add to all HTML pages:
```javascript
async function checkFeatureFlags() {
  const flags = await fetch('/api/features/flags').then(r => r.json());
  flags.forEach(flag => {
    if (!flag.enabled) {
      document.querySelectorAll(`[data-feature="${flag.name}"]`).forEach(el => {
        el.style.display = 'none';
      });
    }
  });
}
```

**4. Roadmap Sync (Automated)**:
- featureInventoryService reads `ROADMAP.md`
- Parses track status (complete, in-progress, planned)
- Updates FeatureInventory.roadmap field
- Detects drift: "Feature marked complete in roadmap but missing docs"

---

## Initiative 4: n8n LLM Webhook Integration

### Vision
Allow users to register n8n workflows as LLM providers, treating them as "model sources" alongside Ollama. Enables using cloud LLM accounts (OpenAI, Anthropic, Google) via n8n flows without managing API keys in AgentX.

### Current State: Gap
- AgentX only calls Ollama models directly
- No way to use external LLMs (OpenAI, Anthropic) unless added to Ollama
- n8n has LLM capabilities but not exposed to AgentX UI

### Use Case Example

**Scenario**: User has OpenAI account with GPT-4 access via n8n workflow

**n8n Workflow** (simple example):
1. Webhook trigger (receives `{ prompt, max_tokens }`)
2. OpenAI node (calls GPT-4 API)
3. Respond to Webhook (returns `{ completion, usage }`)

**AgentX Integration**:
1. User registers n8n webhook as LLM source
2. Webhook appears in unified model catalog
3. User selects "GPT-4 via n8n" in chat interface
4. AgentX sends prompt to n8n webhook
5. n8n calls OpenAI, returns completion
6. Chat displays response

### Architecture (Covered in Initiative 1)

**Database Model**: `N8nLLMSource` (see Initiative 1)
**Backend Service**: `n8nLLMService.js` (see Initiative 1)
**API Endpoints**: `/api/models/sources/n8n/*` (see Initiative 1)

### Additional Integration: Chat Service

**File**: `/home/yb/codes/AgentX/src/services/chatService.js`

**Changes**:
1. Detect n8n webhook models (check provider field)
2. Route to `n8nLLMService.callN8nLLM()` instead of Ollama
3. Handle response format differences
4. Track usage stats (update N8nLLMSource.usageCount)

**Code Example**:
```javascript
// In chatService.js
async function sendChatRequest(model, messages, options) {
  const modelSource = await getModelSource(model);

  if (modelSource.provider === 'n8n-webhook') {
    // Route to n8n webhook
    const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const result = await n8nLLMService.callN8nLLM(modelSource.id, prompt, options);
    return {
      message: { role: 'assistant', content: result.completion },
      usage: result.usage,
      latency: result.latencyMs
    };
  } else {
    // Route to Ollama (existing logic)
    return callOllamaModel(model, messages, options);
  }
}
```

### n8n Workflow Template

**File**: `/AgentC/n8n.workflows/N6.0-LLM-Gateway.json` (new workflow)

**Purpose**: Template workflow for users to create LLM gateways

**Nodes**:
1. Webhook (POST, JSON body: `{ prompt, max_tokens, temperature }`)
2. Function: Extract prompt
3. OpenAI node (or Anthropic/Google node)
4. Function: Format response `{ completion, usage: { promptTokens, completionTokens } }`
5. Respond to Webhook

**Documentation**: Add to `/docs/n8n-llm-gateway.md` with setup instructions

---

## Implementation Phases

### Phase 0: Truth Pass - Validation Only (1-2 hours) 🔍
**Priority**: CRITICAL - Turn "UNCERTAIN" into "CONFIRMED" before any refactoring

**Goal**: Produce EVIDENCE, not assumptions. No code changes, only validation.

**Validation Checklist**:

**1. Cost Tracking Reality Check** (30 min):
- [ ] Pick 1 conversation with known token usage from MongoDB
- [ ] Check if `Conversation.messages[].cost` fields are populated (non-zero)
- [ ] Check if `Conversation.totalCost.sum` exists and is calculated
- [ ] Verify `/api/analytics/costs` returns actual cost data from DB
- [ ] Open analytics.html and verify cost charts render with real data
- **Evidence needed**: Screenshot of cost data OR confirmation costs are all $0.00 (which is valid for free local Ollama)

**2. Feedback Model Truth** (15 min):
- [ ] Grep `routes/analytics.js` for `Feedback` model imports/queries
- [ ] Run `db.feedbacks.count()` in MongoDB (compare to `db.conversations.count()`)
- [ ] Check if analytics uses `Conversation.messages[].feedback` OR standalone `Feedback` collection
- **Evidence needed**: Which collection(s) analytics actually queries

**3. models.html Current State** (15 min):
- [ ] Open models.html in browser, note exact error/empty state message
- [ ] Check network tab: which API endpoint does it call?
- [ ] Verify if it queries CustomModel DB only OR also calls Ollama `/api/tags`
- [ ] Confirm whether live Ollama models appear anywhere in UI
- **Evidence needed**: Screenshot + API endpoint path

**4. Headless Features Audit** (20 min):
- [ ] Check if n8n workflows call `/api/workflow/generate` (grep AgentC folder)
- [ ] Check if any UI calls `/api/voice/*` endpoints (grep public/js/)
- [ ] Check if `/api/janitor/*` proxy is used by dashboard or n8n
- **Evidence needed**: List of endpoints with 0 UI consumers but valid n8n/automation use

**5. chatService.js Test Coverage** (10 min):
- [ ] Check if `tests/unit/chatService.test.js` exists
- [ ] If exists, count test cases and coverage %
- [ ] List critical untested paths (RAG, routing, error handling)
- **Evidence needed**: Test file status + coverage report

**Deliverables**:
- Truth table document: `VALIDATION_RESULTS.md` with evidence for each claim
- Risk-ranked list: "These 5 things need fixing before features"
- Green light to proceed OR "stop, fix X first"

**Success Criteria**:
- Every "UNCERTAIN" from validation report becomes "CONFIRMED TRUE/FALSE"
- Zero assumptions in Phase 1+ planning
- chatService.js test gap quantified (if it exists)

---

### Phase 1: Unified Model Catalog + chatService Hardening (2-3 weeks)
**Priority**: CRITICAL - Highest user-facing value + highest technical risk

**Week 1: Foundation + Testing (PARALLEL TRACKS)**

**Track A: chatService.js Test Suite** (Priority #1 - Toxic debt elimination):
- [ ] Create `tests/unit/chatService.test.js` with mocked dependencies
- [ ] Test routing logic (primary/secondary host selection)
- [ ] Test RAG integration (with/without vector store)
- [ ] Test cost calculation (message-level + conversation-level)
- [ ] Test error handling (Ollama down, timeout, malformed response)
- [ ] Test tool execution flow (DataAPI slash commands)
- [ ] Target: 80% line coverage minimum
- **Why first**: Unlocks safe refactoring for everything else

**Track B: Model Aggregation Backend**:
- [ ] Create N8nLLMSource model (webhook LLM configs)
- [ ] Implement n8nLLMService (call webhook LLMs)
- [ ] Implement modelAggregator service (merge Ollama + custom + n8n + registry)
- [ ] Create API endpoints:
  - `GET /api/models/all` (unified catalog)
  - `GET /api/models/sources` (list sources)
  - `POST /api/models/sources/n8n` (register webhook LLM)

**Week 2: Frontend Redesign**:
- [ ] Redesign models.html (4-section layout per wireframe)
- [ ] Build models-unified.js (model cards, filters, comparison view)
- [ ] Implement n8n LLM registration modal (webhook URL, auth config)
- [ ] Add model comparison drawer (2-4 models side-by-side)
- [ ] Wire to new `/api/models/all` endpoint

**Week 3: Integration + Documentation**:
- [ ] Integrate chatService with n8nLLMService (route to webhooks)
- [ ] Update chat UI model selector (show all sources)
- [ ] Create n8n workflow template (N6.0 LLM Gateway)
- [ ] Write docs: `docs/n8n-llm-gateway.md`, update CLAUDE.md
- [ ] End-to-end test: Register n8n webhook → Select in chat → Get response

**Deliverables**:
- ✅ chatService.js test suite (80%+ coverage) - BLOCKS all future work if skipped
- ✅ models.html unified catalog (Ollama + n8n + custom + registry)
- ✅ n8n webhook LLMs usable in chat
- ✅ Model comparison view functional

**Success Metrics**:
- chatService tests prevent regressions (run in CI)
- All Ollama models (11+) visible in catalog
- 2+ n8n webhook LLMs registered and working
- Model comparison shows 4 models side-by-side with highlighted differences
- Chat interface routes to n8n webhooks correctly

---

### Phase 2: Feature Alignment Dashboard (2-3 weeks)
**Priority**: HIGH - Enables data-driven decisions for all future work

**Dependencies**: Phase 0 complete (validation results guide what to track)

**Week 1: Backend Infrastructure**:
- [ ] Create database models:
  - FeatureInventory (feature × frontend × backend × docs × roadmap)
  - ApiTelemetry (endpoint × hits × latency × errors)
  - FeatureUsage (userId × feature × action × timestamp)
  - FeatureFlag (name × enabled × rollout config)
- [ ] Implement apiTelemetryMiddleware (global, all `/api/*` routes)
- [ ] Implement featureFlagService (check flags, evaluate rollout rules)
- [ ] Test middleware overhead (must be < 5ms per request)

**Week 2: Feature Scanning + APIs**:
- [ ] Implement featureInventoryService:
  - `scanFrontend()` - Parse public/*.html for features
  - `scanBackend()` - Parse routes/*.js, services/*.js for APIs
  - `scanDocumentation()` - Parse docs/**/*.md, CLAUDE.md, ROADMAP.md
  - `generateAlignmentReport()` - Cross-reference all sources
- [ ] Implement featureUsageService (track usage events)
- [ ] Create API endpoints (`/api/features/*`, 15 total)
- [ ] Run initial scan, seed FeatureInventory with ~45 features

**Week 3: Frontend Dashboard**:
- [ ] Create features.html (4-tab layout)
  - Tab 1: Feature Inventory (matrix view, frontend × backend × docs × roadmap)
  - Tab 2: API Telemetry (endpoint stats, latency charts, unused endpoints)
  - Tab 3: Feature Adoption (user engagement, adoption rates)
  - Tab 4: Admin Controls (feature flags toggles, scan triggers)
- [ ] Build features-dashboard.js (~600 lines)
- [ ] Integrate feature tracking into existing pages (add `data-feature` attributes)
- [ ] Test alignment report accuracy (compare to manual audit)

**Deliverables**:
- ✅ Feature Alignment Dashboard live at `/features.html`
- ✅ API telemetry tracking 150+ endpoints in real-time
- ✅ Feature inventory showing 45+ features with alignment status
- ✅ Admin controls for feature flags (5+ flags created)
- ✅ Roadmap sync (auto-detect drift between ROADMAP.md and reality)

**Success Metrics**:
- Telemetry middleware adds < 5ms overhead
- Feature matrix shows "complete/partial/missing" for all features
- Unused endpoints identified (candidates for deprecation)
- Feature adoption tracked (e.g., "RAG used by 45% of users")
- Alignment report used to update CLAUDE.md and ROADMAP.md

---

### Phase 3: Operations Center Consolidation (1-2 weeks)
**Priority**: MEDIUM - Improves UX, no critical blockers

**Week 1**:
- Redesign dashboard.html (6-section layout)
- Extract ops-center.js from inline JS
- Merge n8n-monitor features into sections
- Add collapsible section controls

**Week 2**:
- Create aggregated dashboard API (/api/ops/dashboard)
- Add redirect from n8n-monitor.html
- Test all features (ensure no loss)
- Update documentation

**Deliverables**:
- Single Operations Center page
- All dashboard + n8n-monitor features preserved
- Cleaner, more organized UI
- n8n-monitor.html redirects with notice

**Success Metrics**:
- All 15+ operations features accessible
- Health checks consolidated (no duplication)
- Workflow deployment works
- Webhook testing works
- Users can complete all tasks from single page

---

### Phase 4: n8n LLM Integration (1 week)
**Priority**: LOW - Depends on Phase 2, incremental improvement

**Covered in Phase 2** (bundled with Unified Model Catalog)

---

## Migration & Deprecation Strategy

### Quarantine First, Delete Never (Unless Proven Unused)

**Philosophy**: Per validation report, avoid "oops, that was used by automation" pain.

### Files to Quarantine (NOT delete)

**Move to `/src/experimental/` or `/docs/legacy/` with README explaining status:**

1. **Voice Routes** (`routes/voice.js`):
   - Status: UNCERTAIN - might be called by n8n/AgentC
   - Action: Move to `/src/experimental/voice.js` with note: "Future feature, not wired to UI yet"
   - Evidence needed: Grep AgentC workflows for `/api/voice/*` calls

2. **Workflow Generator Routes** (`routes/workflowGenerator.js`):
   - Status: Headless API (intentional, used by automation)
   - Action: Keep but add comment: "Headless API for n8n automation, no UI needed"
   - Evidence: n8n workflows call these endpoints

3. **Example Files** (`src/services/metricsCleanup.example.js`):
   - Action: Move to `/docs/examples/metrics-cleanup.md` (convert to documentation)

### Files to Deprecate (with redirects, keep for 30 days)

1. **n8n-monitor.html**:
   - Add redirect to `/dashboard.html#n8n`
   - Show deprecation notice: "This page has moved to Operations Center"
   - Keep file for bookmark compatibility
   - Remove after 30 days if no usage logged

### Files to Keep (but modify)

1. **models.html**: Complete redesign (keep filename, replace content)
2. **dashboard.html**: Expand (merge n8n-monitor features)
3. **analytics.html**: Keep as-is (cost tracking already exists, just validate)

### Safe to Archive (proven unused in Phase 0)

**ONLY after Phase 0 validation proves these have 0 consumers:**

1. **api.routes.js** (if just a wrapper with no imports)
2. **AgentPrompt.js model** (if 0 imports in codebase)
3. **MetricsHourly.js model** (if rollup system never wired)

**Action**: Move to `/archive/2026-01-06/` with manifest explaining why

### Backward Compatibility

- All existing API endpoints remain functional (no breaking changes)
- Bookmarks to old pages redirect automatically with notice
- Session data preserved across changes
- No breaking changes to external integrations (n8n workflows, DataAPI)
- Headless APIs stay headless (document as such, don't force-add UI)

---

## Acknowledged Uncertainties (Resolved in Phase 0)

**Per Architecture Validation Report, these claims are UNCERTAIN until proven with runtime evidence:**

### 1. Cost Tracking Completeness
**Claim**: "100% complete, previous review FALSE"
**Reality**: UNCERTAIN - UI and backend exist, but needs proof that:
- chatService computes costs at runtime (not just defaults to $0)
- Costs persist to `Conversation.messages[].cost` fields
- Analytics aggregates from actual populated DB fields (not just empty schema)
- UI displays real data (not just placeholder em-dashes)

**Phase 0 Action**: Query 1 conversation, verify cost fields populated OR confirm $0 is correct (free local Ollama)

### 2. Feedback Model Duality
**Claim**: "Standalone Feedback model is zombie code"
**Reality**: UNCERTAIN - Might be intentionally dual:
- Embedded: `Conversation.messages[].feedback` (per-message thumbs up/down)
- Standalone: `Feedback` collection (might be for aggregated analytics)

**Phase 0 Action**: Grep `routes/analytics.js` for Feedback imports, check DB counts

### 3. models.html Empty State
**Claim**: "Shows 'No models found' because it only queries CustomModel DB"
**Reality**: UNCERTAIN - Needs confirmation:
- Which API endpoint does it actually call?
- Does it attempt to fetch live Ollama models?
- Where do live Ollama models appear in UI (if anywhere)?

**Phase 0 Action**: Open models.html in browser, check network tab, verify API calls

### 4. Headless Features Status
**Claim**: "Voice and workflow generator are unused orphans"
**Reality**: UNCERTAIN - Might be intentionally headless:
- Workflow generator: Used by n8n/AgentC automation (no UI needed)
- Voice: Future feature stub (roadmap item, not active)

**Phase 0 Action**: Grep AgentC workflows for endpoint usage, check n8n health monitor logs

**Principle**: Phase 0 turns all "UNCERTAIN" into "CONFIRMED TRUE/FALSE" before any refactoring begins.

---

## Risk Assessment

### High-Risk Areas

1. **Feature Inventory Scanning**:
   - Risk: False positives/negatives in feature detection
   - Mitigation: Manual review first scan, iterative improvement

2. **API Telemetry Performance**:
   - Risk: Middleware adds latency to every request
   - Mitigation: Async recording, batched inserts, hourly rollups

3. **n8n Webhook Security**:
   - Risk: Exposed webhooks could be abused
   - Mitigation: API key authentication, rate limiting, IP whitelist

4. **Model Catalog Complexity**:
   - Risk: Too many sources create confusion
   - Mitigation: Clear filtering, default view shows "recommended" models

### Medium-Risk Areas

1. **Feature Flag Rollout**:
   - Risk: Buggy feature affects all users if flag misconfigured
   - Mitigation: Gradual rollout percentage, admin override

2. **Operations Center Merge**:
   - Risk: Feature loss during consolidation
   - Mitigation: Comprehensive testing checklist, feature audit

### Low-Risk Areas

1. **Cost Tracking** (already complete, no changes needed)
2. **Documentation updates** (no code risk)

---

## Testing Strategy

### Unit Tests (New)
- `modelAggregator.test.js` - Model merging logic
- `n8nLLMService.test.js` - Webhook calling
- `featureInventoryService.test.js` - Scanning logic
- `apiTelemetryService.test.js` - Metrics recording
- `featureFlagService.test.js` - Flag evaluation

### Integration Tests (New)
- `/tests/integration/features-api.test.js` - Feature API endpoints
- `/tests/integration/models-unified.test.js` - Unified model catalog API
- `/tests/integration/ops-dashboard.test.js` - Operations Center API

### End-to-End Tests (Manual)
- Register n8n webhook LLM → Use in chat → Verify response
- Scan codebase → Verify feature inventory accurate
- Toggle feature flag → Verify feature disabled in UI
- Deploy n8n workflow → Trigger webhook → Verify event logged

### Load Tests (Telemetry)
- Run Artillery load test (test-load.yml)
- Verify telemetry records all calls
- Check middleware overhead (< 5ms)

---

## Success Criteria (Overall)

### Technical Metrics
- ✅ 45+ features inventoried with alignment status
- ✅ 150+ API endpoints tracked with telemetry
- ✅ 0 features lost during consolidation
- ✅ < 5ms telemetry middleware overhead
- ✅ n8n LLMs callable from chat interface with < 1s latency
- ✅ Model catalog shows 15+ models from all sources

### User Metrics
- ✅ Single source of truth for models (no "where do I find X?" confusion)
- ✅ Single Operations Center (no duplicate pages)
- ✅ Feature alignment dashboard used weekly
- ✅ 2+ n8n webhook LLMs registered and actively used

### Documentation Metrics
- ✅ CLAUDE.md updated with new architecture
- ✅ ROADMAP.md updated with completed initiatives
- ✅ New docs: n8n-llm-gateway.md, features-dashboard.md, ops-center.md
- ✅ All claims validated (no "comprehensive test coverage" lies)

---

## Next Steps

1. **User Review & Approval**:
   - Review this plan
   - Clarify any ambiguities
   - Prioritize phases (confirm order)
   - Approve to proceed

2. **Phase 1 Kickoff** (Feature Alignment Dashboard):
   - Create database models
   - Implement telemetry middleware
   - Build codebase scanning service
   - Create features.html page

3. **Phase 2 Planning** (Model Catalog):
   - Detailed UX wireframes for models.html
   - API contract finalization
   - n8n workflow template design

4. **Ongoing**:
   - Update ROADMAP.md with progress
   - Track implementation in feature dashboard (dogfooding!)
   - Weekly status updates

---

## Appendix: External Agent Prompts

If you want to delegate specific tasks to external agents:

### Prompt 1: UX Design for Unified Model Catalog

```
Design a comprehensive UX for a unified model catalog page that displays models from multiple sources (Ollama hosts, n8n webhooks, custom models, model registry).

Requirements:
- Show 15+ models in a responsive grid
- Filter by provider, category, tags
- Compare up to 4 models side-by-side
- Display model stats: context size, latency, quality score, cost
- Actions: "Use in Chat", "Deploy", "Compare"
- Registration flow for n8n webhook LLMs (form with webhook URL, auth, request template)

Provide:
1. Detailed wireframes (ASCII art or Figma links)
2. Component hierarchy
3. User flow diagrams (discovery → selection → usage)
4. Color scheme and typography recommendations
5. Responsive breakpoints (mobile, tablet, desktop)
6. Accessibility considerations

Output: Markdown document with wireframes, flows, and design system
```

### Prompt 2: Feature Alignment Matrix Algorithm

```
Design an algorithm to scan a Node.js/Express codebase and generate a feature alignment matrix showing which features exist in frontend (HTML), backend (routes/services), and documentation (markdown files).

Requirements:
- Scan public/*.html for feature indicators (sections, buttons, forms)
- Scan routes/*.js for API endpoints
- Scan src/services/*.js for business logic
- Scan models/*.js for database schemas
- Scan docs/**/*.md for feature documentation
- Cross-reference to find: complete features, partial features, orphaned code, undocumented features

Provide:
1. Pseudocode or implementation in JavaScript
2. Data structures for feature representation
3. Matching algorithm (how to link frontend → backend → docs)
4. Edge case handling (false positives, ambiguous names)
5. Example output (feature matrix)

Output: JavaScript implementation with tests
```

---

**End of Implementation Plan**
