# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- `modelRouter.js` - Smart routing between multiple Ollama hosts
- `toolService.js` - Slash command parser for /dataapi tools
- `dataapiClient.js` - Proxy client for DataAPI integration

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

### Three-Layer Design

**Layer 1: Document Ingestion**
```
Document → Chunks (800 chars, 100 overlap) → Embeddings → Vector Store
```

**Layer 2: Vector Store (Factory Pattern)**
- `/src/services/vectorStore/factory.js` creates appropriate implementation
- In-Memory: `Map<documentId, chunks>` + cosine similarity (dev/testing, **NOT persistent**)
- Qdrant: REST API client with HNSW indexing (production, persistent)
- Both implement `VectorStoreAdapter.js` interface

**Layer 3: Search & Retrieval**
```
Query → Embedding → Vector Search → Top-K Chunks → Context Injection (into system prompt)
```

### RAG Integration in Chat Flow

In `chatService.js`:
1. If `useRag=true`, perform semantic search with query
2. Build context string from top-K results
3. **Append to system prompt** (NOT injected as user message)
4. Store `ragSources` in conversation for UI display

### Vector Store Configuration

**Switch via environment:**
```bash
VECTOR_STORE_TYPE=memory    # Fast, non-persistent (dev/testing)
VECTOR_STORE_TYPE=qdrant    # Production-grade, persistent
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=agentx_rag
```

**Migration:** Use `/scripts/migrate-vector-store.js` (manual process, no auto-migration)

### Qdrant Deployment

**Complete Guide:** `/docs/QDRANT_DEPLOYMENT.md` (comprehensive 600+ line guide)

**Quick Start:**
```bash
# Using included binary
./qdrant --config-path qdrant_config.yaml

# Or with Docker
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 \
  -v qdrant_storage:/qdrant/storage qdrant/qdrant:latest

# Verify
curl http://localhost:6333/healthz
```

**Configuration Files:**
- `qdrant_config.yaml` - Local binary configuration
- `qdrant.tar.gz` - Pre-packaged binary (78MB)
- `qdrant_data/` - Persistent storage directory
- `.qdrant-initialized` - Marker file for init status

**Migration Process:**
```bash
# Export from in-memory, import to Qdrant
node scripts/migrate-vector-store.js --from in-memory --to qdrant

# Validates migration (compares counts)
# Creates backup of in-memory data
```

**Collection Schema:**
- **Dimension:** 768 (nomic-embed-text)
- **Distance:** Cosine similarity
- **Indexing:** HNSW (automatic after 10K vectors)

**Backup Strategy (documented):**
- Snapshot API: `POST /collections/{name}/snapshots`
- Automated script: `backup-qdrant.sh` (cron schedule provided)
- Retention: 7 days default

**Performance:**
- Search latency: <50ms for 1M vectors
- Persistent across restarts
- Scales to millions of vectors

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

### Five-Level Prompt Library

**Data Source:** `/data/benchmark-prompts.json`

**Levels:**
1. Simple - Greetings, basic facts
2. General - Explanations, how-to guides
3. Complex - Multi-step reasoning
4. Specialized - Code generation, math, analysis
5. Advanced - Long-form content, research synthesis

**Seeding:** Auto-imported to MongoDB on first `/api/benchmark/prompts` call

### Batch Test Architecture

**Flow:**
```
POST /api/benchmark/batch → {
  1. Create batch record in benchmark_batches
  2. Start async execution (executeBatch)
  3. Return batch_id immediately
  4. Sequential test execution:
     - For each model × prompt combination
     - Call Ollama /api/generate
     - Store result in benchmark_results
     - Update batch progress
  5. Mark batch complete
}
```

**Monitoring:** Poll `GET /api/benchmark/batch/:id` for progress

**Collections:**
- `benchmark_results` - Individual test outcomes
- `benchmark_batches` - Batch metadata + progress
- `benchmark_prompts` - Prompt library

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

## Current State & Development TODOs

This section tracks the current implementation status and areas requiring development attention.

### 📊 Codebase Metrics (as of 2026-01-01)

**Implementation Status:**
- ✅ **Core Services:** 11 services (chatService, ragStore, embeddings, modelRouter, toolService, etc.)
- ✅ **API Routes:** 14 route files covering 40+ endpoints
- ✅ **Data Models:** 5 Mongoose schemas (Conversation, PromptConfig, UserProfile, etc.)
- ✅ **Frontend:** 10 HTML pages, 33+ JavaScript modules (12 components)
- ✅ **Test Coverage:** 17 test files (2,684 lines) including Phase 3 E2E tests
- ✅ **Documentation:** 86+ markdown files (35,791+ lines in /docs)
- ✅ **n8n Workflows:** 10 workflow JSONs (9 functional + 1 empty backup)

**Architecture Verified:**
- Service-Oriented Architecture (Routes → Services → Models → DB/Ollama)
- Singleton pattern for stateful services (RAG store, embedding cache)
- Factory pattern for vector stores (in-memory + Qdrant)
- Dual authentication (Session + API Key)
- PM2 cluster mode deployment with CI/CD

### ✅ Implemented & Production-Ready

**Core Chat System:**
- Service-oriented architecture with proper separation of concerns
- Multi-host Ollama routing with smart task classification
- Thinking model support (DeepSeek, Qwen, etc.)
- Tool command system with /dataapi integration
- Conversation memory with MongoDB persistence
- User profile memory injection

**RAG System (V3):**
- Document ingestion with chunking and embedding
- Vector store abstraction (in-memory & Qdrant)
- Semantic search with cosine similarity
- Context injection into system prompts
- n8n workflows for automated ingestion (documented)

**Prompt Management (V4):**
- PromptConfig model with versioning
- A/B testing with traffic weights
- Default prompt initialization on startup
- CRUD API for prompt management (`/api/prompts`)
- Template rendering with Handlebars-like syntax

**Benchmark System:**
- Five-level prompt library (Simple → Advanced)
- Batch testing across model × prompt combinations
- Async execution with progress tracking
- Results storage in MongoDB

**Deployment:**
- PM2 ecosystem configuration (cluster mode)
- Qdrant deployment guide (comprehensive)
- Vector store migration scripts
- Health checks and graceful degradation
- Winston structured logging

### 🚧 Partially Implemented / Needs Work

**Analytics & Metrics (V4) - FUNCTIONAL BUT NEEDS EXPANSION:**
- **Status:** 5 analytics endpoints implemented (563 lines in `/routes/analytics.js`)
- **Implemented:**
  - `GET /api/analytics/usage` - Conversation/message counts with grouping
  - `GET /api/analytics/feedback` - Positive/negative rates with breakdown
  - `GET /api/analytics/rag-stats` - RAG usage vs non-RAG performance
  - `GET /api/analytics/stats` - Token usage, performance metrics
  - `GET /api/analytics/feedback/summary` - A/B comparison, low performers
  - Frontend: `/public/analytics.html` (18,779 bytes) - Basic visualization
- **Need:** Real-time monitoring, advanced visualizations, cost tracking, expanded dashboard
- **n8n Integration:** Prompt improvement workflows documented but need production testing

**Security & Rate Limiting - LARGELY IMPLEMENTED (Phase 3 Complete):**
- **Dependencies:** Installed (helmet, express-rate-limit, express-mongo-sanitize)
- **Status:**
  - ✅ **express-mongo-sanitize**: ACTIVE at `/src/app.js:48-57` (replaces malicious chars, logs events)
  - ⚠️ **helmet**: INSTALLED but DISABLED (intentional for local network compatibility)
  - ✅ **express-rate-limit**: FULLY CONFIGURED with 4-tier system
    - `/src/middleware/rateLimiter.js` (135 lines)
    - Four rate limiters: apiLimiter (100 req/15min), chatLimiter (20 req/min), strictLimiter (10 req/min), authLimiter (5 attempts/15min)
    - Active in `/src/app.js:111-183` on all API routes
    - Integration test: `tests/integration/rate-limiting.test.js`
  - ✅ Custom security headers set manually (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection)
- **Remaining Gaps:**
  - API key validation beyond basic header check
  - Helmet re-evaluation for production deployment
- **Files:** `/src/app.js`, `/src/middleware/auth.js` (129 lines), `/src/middleware/rateLimiter.js` (135 lines)

**AgentC Directory - PLANNING PHASE:**
- **Location:** `/AgentC/` with 9 n8n workflow JSON files
- **Status:** n8n workflows version-controlled and deployment-ready
- **Workflows:**
  - N1.1.json (12.6KB) - System Health Check
  - N1.3.json (10.7KB) - Ops Diagnostic
  - N2.1.json (4.1KB) - NAS Scan
  - N2.2.json (4.2KB) - NAS Full Scan
  - N2.3.json (11.5KB) - RAG Ingest
  - N3.1.json (5.0KB) - Model Monitor (Fixed)
  - N3.2.json (7.6KB) - AI Query
  - N5.1.json (13.7KB) - Feedback Analysis
  - testpack.json (11.9KB) - Test workflow pack
- **Documentation:** `/AgentC/README.md` (315 lines), deployment script at `/scripts/deploy-n8n-workflows.sh`
- **n8n Instance:** http://192.168.2.199:5678 (public: https://n8n.specialblend.icu)
- **Plan Evolution Needed:**
  - Integration with MCP tools
  - Cloud AI LLM specific use cases on top of Ollama
  - Minor automated workflow implementations
  - Global architecture review
- **Priority:** TODO when requirements solidify

### 🔴 Critical Architecture Review Needed

**✅ Prompt Management System - PRODUCTION READY (Phase 3 Complete):**

**Status:** Fully implemented with 10,082 lines of UI code across 10 sophisticated components

**Features Implemented:**
- **Full CRUD Interface** - `/public/prompts.html` (8.8KB) with sophisticated component architecture
- **Monaco Editor Integration** - `PromptEditorModal.js` (537 lines) - Professional code editor for prompt editing
- **A/B Testing Panel** - `ABTestConfigPanel.js` (549 lines) - Traffic weight configuration and test management
- **Version Comparison** - `PromptVersionCompare.js` (604 lines) - Side-by-side diff visualization with syntax highlighting
- **Performance Metrics Dashboard** - `PerformanceMetricsDashboard.js` (1,037 lines) - Chart.js visualizations of prompt effectiveness
- **Health Monitoring** - `PromptHealthMonitor.js` (264 lines) - Real-time alert banners for low performers (<70% threshold)
- **Improvement Wizard** - `PromptImprovementWizard.js` (628 lines) - 5-step guided optimization flow with LLM analysis
- **Conversation Review** - `ConversationReviewModal.js` (514 lines) - Review negative feedback conversations for specific prompts
- **Onboarding Tutorial** - `OnboardingWizard.js` (1,032 lines) - 7-step first-time user guide with profile setup integration
- **Template Testing** - `TemplateTester.js` (513 lines) - Live variable substitution and preview with Handlebars syntax
- **Import/Export** - JSON-based prompt library management for sharing and backup

**Backend API Support:**
- `/routes/prompts.js` (432 lines) - 7 comprehensive endpoints:
  - `GET /api/prompts` - List all prompts grouped by name with versions
  - `GET /api/prompts/:name` - Get specific prompt versions
  - `POST /api/prompts` - Create new prompt/version
  - `PUT /api/prompts/:id` - Update prompt metadata
  - `DELETE /api/prompts/:id` - Delete inactive prompts
  - `POST /api/prompts/render` - Render templates with Handlebars syntax
  - `POST /api/prompts/:name/analyze-failures` - LLM-powered failure analysis

**Self-Improvement Loop (Complete):**
- Analytics dashboard tracks positive/negative rates per prompt
- Health monitor flags low performers in real-time
- Conversation review shows failing interactions with context
- Improvement wizard analyzes patterns and suggests changes
- A/B testing validates improvements before full rollout
- n8n workflows automate prompt optimization (documented in `/docs/reports/n8n-prompt-improvement-v4.md`)

**Architecture:**
- Service-Oriented pattern: Routes → Services → Models → DB
- Prompt versioning with traffic-weighted A/B selection
- Snapshot pattern: Conversations store prompt metadata for historical analysis
- MongoDB indexes optimize analytics queries

**Current Gap:** Onboarding wizard exists only on prompts page, not on main chat interface (index.html) - See next section

**✅ Chat Interface First-Run Experience - COMPLETE (Janitor Project):**

**Status:** Fully implemented with onboarding wizard and navigation improvements

**Implemented Features:**
- ✅ **ChatOnboardingWizard.js** (738 lines) - 5-step wizard for first-time users
  - Step 1: Welcome screen explaining AgentX features (RAG, memory, multi-model)
  - Step 2: Profile setup with API integration (about you + custom instructions)
  - Step 3: Prompt/model selection with dropdown (fetches from `/api/prompts`)
  - Step 4: RAG introduction and toggle configuration
  - Step 5: Completion with "don't show again" checkbox
- ✅ **Auto-trigger logic** - Shows on first visit when no conversation history exists
- ✅ **Manual trigger** - Tutorial button in header (graduation cap icon)
- ✅ **Profile prompt alert** - Blue banner prompts empty profile setup
- ✅ **Gamified setup checklist** - 4-item progress tracker (profile, first chat, RAG usage, account)
- ✅ **localStorage tracking** - Completion flags and preference persistence
- ✅ **Integration hooks** - Profile save, message send, RAG toggle trigger progress updates
- ✅ **Responsive design** - Mobile-friendly CSS (183 lines added)

**Files Created/Modified:**
- New: `/public/js/components/ChatOnboardingWizard.js` (738 lines)
- Modified: `/public/index.html` (+392 lines - wizard integration, alerts, checklist)
- Modified: `/public/js/chat.js` (+17 lines - integration hooks)
- Docs: Test plan, completion report, automated tests (6/6 passed)

**Testing Status:**
- ✅ Automated integration tests: 6/6 passed
- ⏳ Manual browser testing: Pending user verification
- 📋 Test plan: 16 test cases documented in `/docs/testing/CHAT_ONBOARDING_TEST_PLAN.md`

**Current Gap:** Manual QA in browser needed to verify end-to-end flow

### 📋 Development Workflow Conventions (Not Yet Established)

**Current State:** No formal conventions

**Needs:**
- Testing conventions (when to run which tests)
- Documentation update process during multi-agent work
- Plan revision and progress tracking standards
- Code review checklist
- Breaking change communication protocol

**Minimum:** Always run `npm test` before commits

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

**Start Here (this file):**
- **"Current State & Development TODOs"** section above - Implementation status and priority tasks

**Primary Documentation:**
- `/docs/SBQC-Stack-Final/00-OVERVIEW.md` - System architecture overview
- `/docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md` - Complete API documentation (40+ endpoints)
- `/docs/SBQC-Stack-Final/05-DEPLOYMENT.md` - Environment variables & deployment guide
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
