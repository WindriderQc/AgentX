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

**Analytics & Metrics (V4) - BARELY STARTED:**
- **Status:** Basic feedback collection exists, but analytics endpoints need expansion
- **Need:** Architecture definition, feature implementation, comprehensive metrics dashboard
- **Files:** `/routes/analytics.js` (exists but minimal)
- **n8n Integration:** Prompt improvement workflows documented but need backend expansion

**Security & Rate Limiting - NOT IMPLEMENTED:**
- **Dependencies:** Installed (helmet, express-rate-limit, express-mongo-sanitize)
- **Status:** Need architecture, configuration, and testing
- **Critical:**
  - Rate limiting per user/IP
  - API key validation beyond basic header check
  - Request sanitization
  - CORS policy refinement
- **Files:** Security middleware not yet configured in `/src/app.js`

**AgentC Directory - PLANNING PHASE:**
- **Location:** `/AgentC/` with N1.1, N2.1, N3.1, N5.1 JSON files
- **Status:** Documentation and n8n workflow JSON repository
- **Plan Evolution Needed:**
  - Integration with MCP tools
  - Cloud AI LLM specific use cases on top of Ollama
  - Minor automated workflow implementations
  - Global architecture review
- **Current:** Some AI agent tests done but JSONs not in main codebase
- **Priority:** TODO when requirements solidify

### 🔴 Critical Architecture Review Needed

**Prompt/Profile User Guidance System - HIGH PRIORITY:**

**Problem Statement:**
- Chat interface uses `default_chat` prompt with basic hardcoded message
- No user guidance on setup or customization
- No self-improvement loop via feedback metrics
- Multiple use cases not properly analyzed:
  - Prompts for n8n workflows
  - Prompts for direct AgentX + Ollama use
  - User profiles vs system prompts (unclear separation)
  - Feedback-driven improvement flow

**What Needs to Happen:**
1. **Architecture Analysis:**
   - Step back and reflect on current prompt/profile architecture
   - Define clear separation: user profiles vs system prompts vs personas
   - Map use cases: n8n automation, direct chat, specialized agents
   - Design user guidance flow (onboarding, setup wizard?)

2. **Enforcement of Capabilities:**
   - Proper initialization sequence with user guidance
   - UI for prompt selection/customization
   - Profile setup wizard for new users
   - Integration with feedback system

3. **Feedback-Driven Improvement:**
   - Connect existing feedback collection to prompt optimization
   - Visualize prompt performance metrics in UI
   - Guide users on when/how to improve prompts
   - Implement n8n prompt improvement workflows

4. **Implementation Tasks:**
   - Design UI for prompt management (currently no frontend exists)
   - Create user onboarding flow
   - Integrate analytics dashboard
   - Test n8n workflows in production
   - Document best practices for prompt engineering

**Current Files to Review:**
- `/config/db-mongodb.js` - Default prompt initialization
- `/src/services/chatService.js` - Prompt selection logic
- `/routes/prompts.js` - CRUD API (backend complete)
- `/models/PromptConfig.js` - A/B testing logic
- `/docs/reports/n8n-prompt-improvement-v4.md` - Workflow specs
- Frontend prompt management UI - **DOES NOT EXIST**

**Recommendation:** Use EnterPlanMode when starting work on this to properly architect the solution before implementation.

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
