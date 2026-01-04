# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Documentation (Canonical)

- **AgentX docs index** (start here): [docs/INDEX.md](docs/INDEX.md)
- **User manual**: [docs/user-manual/README.md](docs/user-manual/README.md)
- **UI pages map** (URLs + what each page does): [docs/user-manual/README.md#2-the-ui-pages--navigation](docs/user-manual/README.md#2-the-ui-pages--navigation)
- **Project roadmap** (current status & priorities): [ROADMAP.md](ROADMAP.md)
- **Stack documentation hub**: [docs/SBQC-Stack-Final/](docs/SBQC-Stack-Final/)

AgentX is the SBQC stack system-of-record; DataAPI docs defer to AgentX for stack-level truth.

DataAPI has its own canonical docs index at: [../DataAPI/docs/INDEX.md](../DataAPI/docs/INDEX.md)

## Getting Started

For initial setup, installation, and development tools, see: [docs/onboarding/quickstart.md](docs/onboarding/quickstart.md)

**Quick Reference:**
- Clone, install, configure environment, start server
- Development tools: VS Code extensions, debugging, hot reload
- Git pre-commit hooks: `./scripts/setup-git-hooks.sh`

## Commands

### Development
```bash
npm start                    # Start server (default port 3080)
npm test                     # Run Jest tests (silent mode)
npm run test:watch           # Run tests in watch mode
npm run test:coverage        # Generate coverage report
npm run test:e2e             # Run end-to-end test suite (./test-all.sh)
```

### Testing Scripts
```bash
./test-v3-rag.sh                           # Test RAG endpoints
./test-v4-analytics.sh http://localhost:3080  # Test analytics endpoints
./test-mvp.sh                              # Test MVP endpoints
./test-backend.sh                          # Test backend functionality
npm run test:load                          # Load test with Artillery (all scenarios)
npm run test:load:basic                    # Basic load testing
npm run test:load:stress                   # Stress testing
```

### Database Operations
```bash
npm run seed:ops            # Seed SBQC operations data
```

### Production Deployment (PM2)
```bash
pm2 reload ecosystem.config.js --update-env  # Reload with new env vars
pm2 save                                     # Persist for reboot
pm2 status                                   # Check process status
pm2 logs agentx --lines 200                  # View AgentX logs
pm2 logs dataapi --lines 200                 # View DataAPI logs
```

## Architecture Overview

### Service-Oriented Architecture (NOT MVC)

AgentX uses a **Service-Oriented Architecture** where routes are thin HTTP layers that immediately delegate to services:

**Flow Pattern:**
```
Routes (validation) → Services (orchestration) → Models (data) → MongoDB/Ollama
```

**Key Principle:** Routes should NEVER contain business logic. They validate requests and delegate to services immediately.

### Core Components

**Routes** (`/routes/*.js`)
- Thin HTTP layer for validation and request parsing
- Immediately delegate to services
- Handle response formatting and error responses
- Routes mount: auth → API → static files (order matters)

**Services** (`/src/services/*.js`)
- Business logic and orchestration
- `chatService.js` - Core chat orchestration with RAG/memory integration
- `ragStore.js` - Vector store singleton (in-memory or Qdrant)
- `embeddings.js` - Embedding generation with LRU cache
- `modelRouter.js` - Smart routing between multiple Ollama hosts with persistent failover state
- `selfHealingEngine.js` - Automated remediation system with 5 action strategies
- `toolService.js` - Slash command parser for /dataapi tools
- `dataapiClient.js` - Proxy client for DataAPI integration
- `customModelService.js` - Manages custom model registration, Modelfile generation, and deployment with advanced tuning parameters (num_ctx, num_gpu, etc.)

**Models** (`/models/*.js`)
- Mongoose schemas with static helper methods
- `Conversation.js` - Chat history with feedback and RAG sources (subdocument arrays with _id)
- `UserProfile.js` - User memory and preferences (injected into system prompts)
- `PromptConfig.js` - Versioned system prompts with A/B testing (traffic weights)

**Helpers** (`/src/helpers/*.js`)
- Pure utility functions
- `ollamaResponseHandler.js` - Response parsing, thinking model support, template tag cleaning

### Singleton Pattern for Stateful Services

Critical services use singletons to maintain shared in-memory state:
- `getRagStore()` - Single vector store instance per process
- `getEmbeddingsService()` - Shared embedding cache (LRU with 24hr TTL)
- Cache hit rate: 50-80% reduction in embedding API calls

## RAG System Architecture

Three-layer design: **Ingestion** (Document → Chunks → Embeddings → Vector Store) → **Storage** (Qdrant/in-memory via factory pattern) → **Retrieval** (Semantic search → Context injection into system prompt).

**Configuration:**
- `VECTOR_STORE_TYPE=memory` (dev, non-persistent) or `qdrant` (production, persistent)
- In chatService: `useRag=true` triggers semantic search, appends top-K results to system prompt
- Migration: `node scripts/migrate-vector-store.js --from in-memory --to qdrant`

**Full architecture:** [specs/V3_RAG_ARCHITECTURE.md](specs/V3_RAG_ARCHITECTURE.md)

### Qdrant Deployment

**Complete Guide:** [docs/QDRANT_DEPLOYMENT.md](docs/QDRANT_DEPLOYMENT.md) (comprehensive 600+ line deployment guide)

**Quick Start:**
```bash
./qdrant --config-path qdrant_config.yaml  # Local binary
# OR
docker run -d --name qdrant -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant:latest
```

**Configuration:**
```bash
VECTOR_STORE_TYPE=qdrant
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=agentx_rag
```

**Migration:** `node scripts/migrate-vector-store.js --from in-memory --to qdrant`

## Model Routing System

### Smart Multi-Host Routing

**Service:** `/src/services/modelRouter.js`

**Two-Phase Routing:**
1. **Query Classification** - Small fast model (Qwen 7B) classifies intent into task types
2. **Model Selection** - Routes to appropriate host/model based on task type

**Task Types:**
- `quick_chat` → Primary host (lightweight models)
- `code_generation` → Secondary host (specialist models)
- `deep_reasoning` → Secondary host (reasoning models)

**Host Configuration:**
```javascript
HOSTS = {
  primary: process.env.OLLAMA_HOST,              // Default: http://localhost:11434
  secondary: process.env.OLLAMA_HOST_SECONDARY   // Heavy models
}
```

**Critical:** When `autoRoute=true` is passed to chat API, user's model selection is **OVERRIDDEN** by routing decision.

### Persistent Failover State

**Feature:** ModelRouter maintains in-memory failover state for self-healing integration

**State Tracking:**
```javascript
ACTIVE_HOST_STATE = {
  current: 'http://192.168.2.99:11434',  // Currently active host
  failedOver: false,                      // Whether failover is active
  failoverTimestamp: '2026-01-03T...',   // When failover occurred
  reason: 'self_healing_failover',        // Reason for failover
  failoverCount: 3                        // Total failovers this session
}
```

**API Methods:**
- `getActiveHost()` - Returns current host URL
- `getBackupHost()` - Returns alternate host URL
- `switchHost(url, reason)` - Performs failover with reason tracking
- `getFailoverStatus()` - Returns full state object
- `resetToPrimary(reason)` - Manually reset to primary host

## Self-Healing System (Track 4)

### Architecture Overview

**Service:** `/src/services/selfHealingEngine.js` (883 lines)

**Purpose:** Automatically detect operational issues via metrics and execute configurable remediation strategies to maintain system health without human intervention.

### Five Remediation Strategies

#### 1. Model Failover (`_executeModelFailover`)
**Trigger:** Primary Ollama host slow (>5s) or unhealthy
**Action:**
- Switches to backup Ollama host
- Verifies backup health before committing
- Rolls back if backup also unhealthy
- Updates ModelRouter persistent state

**Configuration:**
```json
{
  "name": "ollama_slow_response_failover",
  "detectionQuery": {
    "metric": "avg_response_time",
    "threshold": 5000,
    "comparison": "greater_than",
    "window": "5m"
  },
  "remediation": {
    "strategy": "model_failover",
    "cooldown": "15m",
    "requiresApproval": false
  }
}
```

#### 2. Prompt Rollback (`_executePromptRollback`)
**Trigger:** Prompt quality drops (positive rate < 60%)
**Action:**
- Finds previous active PromptConfig version
- Deactivates current, activates previous
- Updates traffic weights (0% → 100%)
- Returns rollback metadata

**Use Case:** Automatically revert bad prompt deployments

#### 3. Service Restart (`_executeServiceRestart`)
**Trigger:** Service health check failures
**Action:**
- Executes PM2 reload (graceful, zero-downtime)
- Maps component names to PM2 apps
- Verifies restart success via process list
- 5-second stabilization period

**Safety:** Requires approval by default (`requiresApproval: true`)

#### 4. Request Throttling (`_executeThrottle`)
**Trigger:** High error rate (>10%) or system overload
**Action:**
- Reduces rate limits by 50% for 15 minutes
- Stores state in `global._selfHealingThrottle`
- Auto-restores after timeout
- Returns adjusted limits

**Purpose:** Shed load during degraded conditions

#### 5. Alert-Only (`_executeAlertOnly`)
**Trigger:** Any configurable threshold
**Action:**
- Creates Alert in database
- Sends multi-channel notifications (Slack, email, webhook)
- No remediation executed
- Used for monitoring-only scenarios

### Rule Configuration

**File:** `/config/self-healing-rules.json` (12 rules)

**Rule Structure:**
```json
{
  "name": "unique_rule_id",
  "enabled": true,
  "description": "Human-readable description",
  "detectionQuery": {
    "metric": "metric_name",
    "aggregation": "avg|sum|count|max",
    "threshold": 100,
    "comparison": "greater_than|less_than|equal",
    "window": "5m|1h|24h",
    "componentType": "ollama|agentx|prompt|rag",
    "componentPattern": "component-*"
  },
  "conditions": {
    "minOccurrences": 3
  },
  "remediation": {
    "strategy": "model_failover|prompt_rollback|service_restart|throttle_requests|alert_only",
    "action": "Action description",
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

### Cooldown Enforcement

**Purpose:** Prevent remediation thrashing

**Mechanism:**
- Tracks execution history with timestamps
- Parses cooldown windows (e.g., "15m" → 900000ms)
- Blocks re-execution until cooldown expires
- Returns `cooldownRemaining` in evaluation

**Example:** Model failover has 15-minute cooldown to prevent rapid host switching

### Approval Workflow

**Critical Actions:** Service restart requires approval

**Flow:**
1. Rule triggers → Returns `status: 'pending_approval'`
2. Creates approval request in database
3. Waits for human approval via API
4. Executes if approved, cancels if rejected

**API:** `POST /api/self-healing/actions/:id/approve`

### Integration with n8n

**Workflow:** N4.4 Self-Healing Orchestrator

**Capabilities:**
- Webhook-triggered remediation execution
- Scheduled rule evaluation (every 5 minutes)
- Metrics collection and alert creation
- Integration with AgentX self-healing APIs

**Trigger:**
```bash
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n4-4-self-healing-trigger \
  -H "Content-Type: application/json" \
  -d '{
    "ruleName": "ollama_slow_response_failover",
    "component": "ollama-99",
    "remediationAction": "model_failover",
    "requiresApproval": false
  }'
```

### Key Features

- **Automatic Detection:** Queries MetricsSnapshot for threshold violations
- **Cooldown Period:** Prevents thrashing with configurable windows
- **Approval Required:** Critical actions require human confirmation
- **Multi-Channel Notifications:** Slack, email, webhook, DataAPI
- **Execution History:** Tracks all remediation attempts
- **Rule Management:** Enable/disable rules via API
- **Dry-Run Mode:** Simulate remediations without execution

## Conversation Memory & Prompt Versioning

### Snapshot Pattern

Conversation records **snapshot** prompt metadata (not reference) for historical analysis:
```javascript
{
  promptConfigId: ObjectId,    // Reference for real-time lookup
  promptName: String,          // Snapshot for analytics
  promptVersion: Number        // Snapshot for A/B testing
}
```

**Why:** Enables analysis even after original PromptConfig changes or is deleted.

### Prompt A/B Testing

**Selection Algorithm:**
1. Find all active prompts for given `name` (e.g., "default_chat")
2. Calculate total `trafficWeight` across all versions
3. Random selection proportional to weights (0-100)
4. Track performance: `impressions`, `positiveCount`, `negativeCount`

### User Profile Memory Injection

User memory is **always appended to system prompt**, not stored in message history:
```javascript
effectiveSystemPrompt = basePrompt
  + "\n\nUser Profile:\n" + userProfile.about
  + "\n\nCustom Instructions:\n" + userProfile.preferences.customInstructions
```

## Benchmark System

**Architecture:** Fully refactored to Service-Oriented Architecture (January 2026)
- **Routes:** Thin HTTP layer (314 lines) - validation and delegation only
- **Service:** Complete business logic in `benchmarkService.js` (1,098 lines)
- **Models:** Mongoose schemas with helper methods and indexes

### Service-Oriented Architecture

**Pattern:** Routes → Services → Models → MongoDB

**Core Components:**

**Models** (`/models/`):
- `BenchmarkPrompt.js` - Prompt library with static helpers (level grouping, seeding)
- `BenchmarkResult.js` - Individual test results with quality scoring fields
- `BenchmarkBatch.js` - Batch tracking with state management methods

**Service** (`/src/services/benchmarkService.js`):
- `seedPrompts()` - Auto-import from JSON
- `runTest()` - Single test execution
- `getResults()`, `getSummary()`, `getDashboard()` - Analytics
- `compareModels()` - Multi-model comparison
- `getQualityBreakdown()` - Category/level analysis
- `startBatch()` - Batch initialization with execution plan
- `executeBatch()` - Async batch execution with ConcurrencyQueue
- `stopBatch()`, `getBatch()`, `getBatches()` - Batch management

**Routes** (`/routes/benchmark.js`):
- 14 endpoints: `/test`, `/results`, `/summary`, `/dashboard`, `/compare`, `/prompts`, `/batch`, `/batches`, `/quality-breakdown`, etc.
- ALL routes delegate to `benchmarkService` - zero business logic in routes

### Five-Level Prompt Library

**Data Source:** `/data/benchmark-prompts.json`

**Levels:**
1. Simple - Greetings, basic facts
2. General - Explanations, how-to guides
3. Complex - Multi-step reasoning
4. Specialized - Code generation, math, analysis
5. Advanced - Long-form content, research synthesis

**Seeding:** `BenchmarkPrompt.seedFromArray()` called on first access

**Helper Methods:**
- `getByLevel(level)` - Get prompts for specific level
- `getByLevels([levels])` - Get prompts for multiple levels
- `getByCategory(category)` - Filter by category
- `getAllGroupedByLevel()` - Returns `{ prompts, byLevel }`

### Batch Test Architecture

**Flow:**
```
POST /api/benchmark/batch → {
  1. Validate inputs (host, models, levels)
  2. Load prompts via BenchmarkPrompt.getByLevels()
  3. Build execution plan (host routing, judge config)
  4. Create BenchmarkBatch record
  5. Start async execution via benchmarkService.executeBatch()
  6. Return batch_id immediately
  7. Background execution:
     - For each model × prompt combination
     - Call Ollama /api/generate
     - Create BenchmarkResult record
     - Update batch progress counters
     - Queue quality scoring tasks (ConcurrencyQueue)
  8. Mark batch as 'judging' when generation completes
  9. Drain judge queue
  10. Mark batch as 'completed'
}
```

**Monitoring:** Poll `GET /api/benchmark/batch/:id` for progress

**State Transitions** (via instance methods):
- `markAsRunning()` - Set status='running', timestamp started_at
- `markAsJudging()` - Set status='judging', timestamp generated_at
- `markAsCompleted()` - Set status='completed', timestamp completed_at
- `markAsStopped()` - User-triggered stop
- `markAsFailed(error)` - Execution failure

**Progress Tracking:**
- `completed` / `total_tests` - Generation progress
- `judge_completed` / `judge_total` - Quality scoring progress
- Virtuals: `progress`, `judge_progress`, `success_rate`

**Mongoose Models:**
- `BenchmarkPrompt` - Prompt library (indexed on level, category)
- `BenchmarkResult` - Individual test outcomes (indexed on model, batch_id, quality_score)
- `BenchmarkBatch` - Batch metadata (indexed on status, created_at)

**Key Improvements (Jan 2026 Refactor):**
1. **Zero Direct Collection Access** - All DB operations via Mongoose models
2. **Service Layer Completeness** - 100% of business logic extracted from routes
3. **Static Helper Methods** - `getByLevel()`, `getModelStats()`, `getQualityBreakdown()`
4. **Instance Methods** - State transitions (`markAsCompleted()`), progress updates
5. **Compound Indexes** - Optimized for analytics queries
6. **Integration Tests** - Full test coverage with mongodb-memory-server

## DataAPI Proxy Integration

### Server-Side Proxy Pattern

**Why Proxy?** Avoid CORS, centralize API keys, provide unified API surface

**Pattern:**
```
Frontend → AgentX /api/dataapi/* → DataAPI /api/v1/* (server-to-server)
```

**Service:** `/src/services/dataapiClient.js`

### Tool Command Integration

**Slash Command Parser in `/src/services/toolService.js`:**
```
User: "/dataapi files search myfile.txt"
  → Detects slash command prefix
  → Parses: domain=files, action=search, args="myfile.txt"
  → Executes: dataapi.files.search({ q: args })
  → Returns formatted response BEFORE LLM call
```

**Critical:** Tool commands **bypass normal chat flow** - handled BEFORE any LLM processing in chatService.

**Environment Configuration:**
```bash
DATAAPI_BASE_URL=http://127.0.0.1:3003
DATAAPI_API_KEY=<secure-key>
```

## n8n Integration Workflows

AgentX integrates with n8n for automated document ingestion and prompt optimization loops.

### Document Ingestion Workflows

**Documentation:** `/docs/reports/n8n-ingestion.md`

**Workflow 1: Scheduled Docs Folder → RAG**
- **Trigger:** Cron (default: every 60 minutes)
- **Flow:** Filesystem scan → PDF/HTML/Markdown extraction → SHA256 hash → POST `/api/rag/ingest`
- **Idempotency:** Backend deduplicates using hash
- **Environment Variables:**
  - `AGENTX_BASE_URL` - e.g., `http://localhost:3080`
  - `AGENTX_API_KEY` - API key for authentication
  - `DOCS_FOLDER_PATH` - Absolute path to docs directory

**Workflow 2: Manual/Ad-hoc Ingestion**
- **Trigger:** HTTP webhook (POST)
- **Accepts:** JSON with `text` or `url` plus optional `title`, `tags`, `path`
- **Flow:** Fetch/extract → Hash → POST `/api/rag/ingest` → Respond to webhook

### Prompt Improvement Workflows (V4)

**Documentation:** `/docs/reports/n8n-prompt-improvement-v4.md`

**Four Automated Workflows:**

1. **Prompt Health Check** (Daily Cron)
   - Polls `/api/analytics/feedback?sinceDays=7`
   - Flags prompts with low positive rates (< 70% threshold)
   - Sends alerts to monitoring channel

2. **Evaluate Negative Conversations** (Manual/Weekly)
   - Samples worst conversations via `/api/dataset/conversations?feedback=negative`
   - LLM analyzes failures and proposes prompt improvements
   - Creates proposal via `POST /api/prompt-configs`

3. **Prompt Rollout Controller** (Manual Approval)
   - Reviews proposed prompts
   - Human-in-the-loop approval (Slack/Email buttons)
   - Activates via `PATCH /api/prompt-configs/:id/activate`

4. **Dataset Export** (Weekly)
   - Exports conversations for fine-tuning
   - Generates JSONL with positive/negative examples
   - Stores in `/data/exports/`

**Environment Variables:**
- `POSITIVE_RATE_THRESHOLD` - Default: 0.7 (70%)
- `MIN_FEEDBACK_COUNT` - Default: 50 conversations
- `HEALTH_LOOKBACK_DAYS` - Default: 7 days
- `DATASET_EXPORT_LIMIT` - Default: 500 per batch

### Webhook Endpoints for n8n

**API Key Authentication Required:**
```bash
curl -H "x-api-key: ${AGENTX_API_KEY}" http://localhost:3080/api/rag/ingest
```

**Key Endpoints:**
- `POST /api/rag/ingest` - Document ingestion (V3 contract)
- `POST /api/rag/search` - RAG search testing
- `GET /api/analytics/feedback` - Prompt performance metrics
- `GET /api/dataset/conversations` - Conversation export
- `POST /api/prompt-configs` - Create new prompt versions

## Startup Sequence

**Bootstrap Order:**
1. Load environment variables from `.env`
2. Define global error handlers (unhandledRejection, uncaughtException)
3. `startServer()` async function:
   - Check MongoDB connection (mongoose.connection.readyState)
   - **Initialize default prompt** via `ensureDefaultPromptConfig()` (see below)
   - Check Ollama availability (fetch /api/tags)
   - Update `systemHealth` object (exported from app.js)
4. Initialize Express middleware:
   - Security headers (custom, not helmet for LAN compatibility)
   - CORS (origin whitelist or wildcard based on NODE_ENV)
   - Session store (MongoDB-backed with connect-mongodb-session)
   - Body parsers (50MB limit for large document ingestion)
   - Request logging middleware
5. Mount routes:
   - Auth routes first (`/api/auth`)
   - API routes (`/api/*`)
   - Static files AFTER API routes (precedence)
6. Start HTTP listener
7. Log startup banner + health status

**Graceful Degradation:** Server starts even if services are unavailable
- MongoDB down → Logs warning, continues (conversations not saved)
- Ollama down → Chat returns 503, health shows degraded
- Vector store down → RAG disabled, chat works without context

### Default Prompt Initialization

**Implementation:** `/config/db-mongodb.js` → `ensureDefaultPromptConfig()`

**Behavior on Startup:**
```javascript
// Checks if active 'default_chat' prompt exists
const activePrompt = await PromptConfig.findOne({ name: 'default_chat', status: 'active' });

if (!activePrompt) {
  // Creates default prompt if missing
  new PromptConfig({
    name: 'default_chat',
    version: 1,
    systemPrompt: 'You are AgentX, a concise and capable local assistant. Keep answers brief and actionable.',
    description: 'Initial default system prompt',
    status: 'active',
    author: 'system'
  });
}
```

**Chat Interface Usage:**

When user opens chat interface at `http://localhost:3080`:
1. `chatService.js` → `getActivePrompt('default_chat')`
2. Uses `PromptConfig.getActive()` which implements A/B testing with traffic weights
3. If multiple active versions exist, selects one proportionally to `trafficWeight`
4. Falls back to hardcoded default if database lookup fails

**Current Limitation:** No user guidance on setup or self-improvement. System prompt is hardcoded and basic.

## Authentication

### Dual Auth System

**Two Modes:**
1. **Session Auth** - Cookie-based for web users (MongoDB session store)
2. **API Key Auth** - Header-based for automation (n8n workflows)

**Middleware:** `/src/middleware/auth.js`

**Middleware Chain:**
```javascript
app.use(session(...));           // Session setup
app.use(attachUser);             // Extract user from session → res.locals.user
router.get('/protected', requireAuth, handler);  // Block if !user
router.post('/n8n', apiKeyAuth, handler);        // Require x-api-key header
```

**API Key Validation:**
```javascript
const apiKey = req.header('x-api-key');
if (apiKey === process.env.AGENTX_API_KEY) {
  req.authSource = 'api-key';
  res.locals.user = { userId: 'api-client' };
}
```

## Response Handling

### Thinking Model Support

**Helper:** `/src/helpers/ollamaResponseHandler.js`

**Thinking Models:** qwen, deepseek-r1, reasoning models
- Output separate `thinking` field (internal reasoning process)
- Standard `content` field (user-facing response)

**Critical Fields:**
- `data.message.content` - Standard response
- `data.message.thinking` - Reasoning process (thinking models only)
- `data.response` - Legacy format (generate API)

### Template Tag Cleaning

Some models leak template tags like `<|start_header_id|>`.

**Solution:** Regex-based cleaning in `cleanContent()` removes:
- `<|start_header_id|>...<|end_header_id|>`
- `<|eot_id|>`, `<|begin_of_text|>`, etc.

### Stats Collection (V4 Analytics)

When `data.done=true`:
```javascript
stats = {
  usage: { promptTokens, completionTokens, totalTokens },
  performance: { totalDuration, evalDuration, tokensPerSecond }
}
// Stored in message.stats for analytics
```

## MongoDB Schema Patterns

### Subdocument Arrays with IDs

**Pattern:**
```javascript
const MessageSchema = new mongoose.Schema({ ... });
messages: [MessageSchema]  // Each message auto-generates _id
```

**Usage:**
```javascript
conversation.messages.id(messageId)          // Find subdoc by _id
conversation.messages.push({ role, content }) // Add new
```

**Purpose:** Enables fine-grained feedback on individual messages

### Index Strategy

**Conversation Indexes:**
```javascript
{ createdAt: 1 }                          // Chronological queries
{ model: 1, createdAt: 1 }                // Model performance analysis
{ promptConfigId: 1 }                     // A/B testing queries
{ 'messages.feedback.rating': 1 }         // Feedback analytics
```

**Purpose:** Support V4 analytics queries without full collection scans

## Critical Conventions

### Error Handling Pattern

```javascript
try {
  await operation();
  res.json({ status: 'success', data: {...} });
} catch (err) {
  logger.error('Operation failed', { error: err.message, context: {...} });
  res.status(500).json({ status: 'error', message: err.message });
}
```

**Rule:** ALWAYS log errors with context, NEVER expose stack traces to client (except dev mode)

### Logging with Winston

**Logger:** `/config/logger.js`

**Levels:**
- `error` - Failures requiring immediate attention
- `warn` - Degraded behavior, fallbacks
- `info` - Significant events (startup, connections, completions)
- `debug` - Detailed traces (classification, routing, performance)

**Pattern:**
```javascript
logger.info('Operation completed', {
  context: 'value',
  metric: 123
});
```

### Environment Variables

**Critical Variables:**
- `MONGODB_URI` - Database connection string
- `OLLAMA_HOST` - Primary Ollama instance URL
- `OLLAMA_HOST_SECONDARY` - Secondary Ollama for heavy models (optional)
- `VECTOR_STORE_TYPE` - Switch between 'memory' and 'qdrant'
- `EMBEDDING_MODEL` - Model for generating embeddings (default: nomic-embed-text)
- `AGENTX_API_KEY` - API key for automation/n8n access
- `DATAAPI_BASE_URL` - DataAPI proxy base URL
- `DATAAPI_API_KEY` - DataAPI authentication key
- `PORT` - HTTP server port (default: 3080)

**Pattern:**
```javascript
const value = process.env.VAR_NAME || 'fallback';
```

## Testing

### Jest Configuration

**Config:** `jest.config.js`
- Test environment: Node.js
- Test pattern: `**/tests/**/*.test.js`
- Coverage: `src/`, `routes/`, `models/`
- Timeout: 10 seconds

### Integration Tests

**Location:** `/tests/integration/*.test.js`

**Pattern:** Uses `mongodb-memory-server` for isolated testing
```javascript
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
```

### Load Testing with Artillery

**Configs:**
- `/tests/load/basic-load.yml` - Normal traffic simulation
- `/tests/load/stress-test.yml` - High concurrent load

## Current Implementation Status

**Complete status and roadmap:** See [ROADMAP.md](ROADMAP.md) for detailed track status, immediate priorities, and backlog items.

**Quick Stats:**
- 18 services, 21 route files, 15 data models
- All 6 development tracks complete and production-ready
- Full UI dashboards, n8n workflows (N1-N6), comprehensive test coverage

For detailed metrics, validation reports, and implementation status, see [ROADMAP.md](ROADMAP.md) and [docs/VALIDATION_REPORT_2026-01-03.md](docs/VALIDATION_REPORT_2026-01-03.md).

### 📋 Development Workflow

For detailed contribution guidelines including branching strategy, git conventions, testing standards, pull request process, code review checklists, and breaking changes protocol, see: [CONTRIBUTING.md](CONTRIBUTING.md)

**Quick Reference:**
- Use conventional commits (`feat:`, `fix:`, `docs:`, etc.)
- Test coverage: Services >80%, Routes >70%, Helpers >90%
- PR template available at `.github/PULL_REQUEST_TEMPLATE.md`
- Follow Service-Oriented Architecture (Routes → Services → Models)

## Critical Gotchas

### 1. In-Memory Vector Store is NOT Persistent
**Problem:** Data lost on server restart
**Solution:** Use Qdrant (`VECTOR_STORE_TYPE=qdrant`) for production

### 2. Embedding Cache Cold Starts
**Problem:** First queries after restart are slow (no cache hits)
**Solution:** Cache rebuilds organically, no pre-warming mechanism exists

### 3. Tool Commands Bypass LLM
**Problem:** Slash commands (e.g., `/dataapi`) execute BEFORE any LLM processing
**Solution:** Understand that tool results are not passed through the model

### 4. RAG Context Injection Location
**Pattern:** RAG context is ALWAYS appended to system prompt, never injected as user message
**Why:** Maintains clean conversation history while providing grounding context

### 5. Model Auto-Routing Override
**Critical:** When `autoRoute=true`, user's model selection is IGNORED
**Why:** Routing decision takes precedence for optimal task-model matching

### 6. Prompt Data Snapshots
**Pattern:** Conversations snapshot prompt data (name, version) rather than reference
**Why:** Enables historical analysis even after original prompts change/delete

### 7. PM2 Cluster Mode
**Pattern:** `ecosystem.config.js` runs in cluster mode with `instances: 'max'`
**Implication:** In-memory state (cache, vector store) is NOT shared across workers
**Solution:** Each worker maintains its own cache/store, or use external services (Qdrant, Redis)

### 8. Session Store Persistence
**Pattern:** Sessions stored in MongoDB via `connect-mongodb-session`
**Implication:** Sessions persist across server restarts
**Config:** See `app.js` session middleware setup

## Documentation

**Start Here:**
- **[CLAUDE.md](CLAUDE.md)** (this file) - Unified canonical reference for agents and humans
  - Getting started, commands, architecture patterns, critical conventions
  - Development workflow, testing standards, code review checklist
  - "Current State & Development TODOs" section - Implementation status and priority tasks
- **[ROADMAP.md](ROADMAP.md)** - Project status and priorities
  - Six development tracks (Alerts, Analytics, Custom Models, Self-Healing, Testing/CI-CD, Backup/DR)
  - Current implementation status and immediate action items

**Primary Documentation:**
- `/docs/SBQC-Stack-Final/00-OVERVIEW.md` - System architecture overview
- `/docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md` - Complete API documentation (40+ endpoints)
- `/docs/SBQC-Stack-Final/05-DEPLOYMENT.md` - Environment variables & deployment guide (includes CI/CD)
- `/docs/architecture/backend-overview.md` - Implementation details
- `/specs/V3_RAG_ARCHITECTURE.md` - RAG system design
- `/specs/V4_ANALYTICS_ARCHITECTURE.md` - Analytics and improvement loops

**n8n Workflows:**
- `/docs/reports/n8n-ingestion.md` - Document ingestion workflows
- `/docs/reports/n8n-prompt-improvement-v4.md` - Prompt optimization loops
- `/AgentC/n8n.workflows_testing.md` - Workflow testing documentation

**Deployment & Operations:**
- `/docs/QDRANT_DEPLOYMENT.md` - Comprehensive Qdrant deployment guide (600+ lines)
- `/QDRANT_README.md` - Quick start for Qdrant
- `/DEPLOYMENT.md` - Deployment checklist and procedures
- `/ecosystem.config.js` - PM2 configuration
- `/docs/onboarding/quickstart.md` - Installation & setup guide

**API References:**
- `/docs/api/reference.md` - Complete endpoint documentation
- `/docs/api/contracts/v3-snapshot.md` - V3 RAG contract
- `/docs/api/contracts/v4-contract.md` - V4 analytics contract

**Change History:**
- `/CHANGELOG.md` - Version history and changes
- `/CHANGELOG_RAG_METRICS.md` - RAG-specific changes
