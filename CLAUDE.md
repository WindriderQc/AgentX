# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Documentation Hub

**Start Here:**
- **[docs/INDEX.md](docs/INDEX.md)** - Complete documentation index
- **[ROADMAP.md](ROADMAP.md)** - Project status and priorities
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Development workflow

**Architecture Documentation:**
- [Multi-Tenancy & Workspaces](docs/architecture/MULTI_TENANCY.md) - Team collaboration & RBAC
- [Model Registry](docs/architecture/MODEL_REGISTRY.md) - Model categorization & metadata
- [RAG System](docs/architecture/RAG_SYSTEM.md) - Vector store & retrieval
- [Model Routing](docs/architecture/MODEL_ROUTING.md) - Smart routing & failover
- [Startup Sequence](docs/architecture/STARTUP_SEQUENCE.md) - Bootstrap order
- [Backend Overview](docs/architecture/backend-overview.md) - Service-oriented architecture

**Integration Documentation:**
- [N8N Workflows](docs/integrations/N8N_WORKFLOWS.md) - Automated ingestion & optimization

**Patterns & Conventions:**
- [Critical Conventions](docs/patterns/CRITICAL_CONVENTIONS.md) - Mandatory coding patterns
- [Testing Patterns](docs/patterns/TESTING_PATTERNS.md) - Jest & integration tests

**Operations Documentation:**
- [Authentication](docs/operations/AUTHENTICATION.md) - Dual auth system
- [Response Handling](docs/operations/RESPONSE_HANDLING.md) - LLM response processing
- [Benchmark System](docs/operations/BENCHMARK_SYSTEM.md) - Quality scoring
- [Categorization Tests](docs/operations/CATEGORIZATION_TESTS.md) - Model category assignment
- [Benchmark Color Theme](docs/operations/BENCHMARK_COLOR_THEME.md) - Level-based color system
- [Critical Gotchas](docs/operations/CRITICAL_GOTCHAS.md) - Known issues & pitfalls

---

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
node scripts/seed-model-registry.js  # Seed model registry with 11 models
```

### Production Deployment (PM2)
```bash



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

**For detailed component documentation, see:**
- [Backend Overview](docs/architecture/backend-overview.md)
- [Multi-Tenancy](docs/architecture/MULTI_TENANCY.md)
- [Model Registry](docs/architecture/MODEL_REGISTRY.md)

### Core Components

**Routes** (`/routes/*.js`)
- Thin HTTP layer for validation and request parsing
- Immediately delegate to services
- Handle response formatting and error responses
- Routes mount: auth → API → static files (order matters)

→ [Architecture docs](docs/architecture/)

**Services** (`/src/services/*.js`)
- Business logic and orchestration
- `chatService.js` - Core chat orchestration with RAG/memory integration
- `ragStore.js` - Vector store singleton (in-memory or Qdrant)
- `embeddings.js` - Embedding generation with LRU cache
- `modelRouter.js` - Smart routing between multiple Ollama hosts with persistent failover state
- `selfHealingEngine.js` - Automated remediation system with 5 action strategies
- `toolService.js` - Slash command parser for /dataapi tools
- `dataapiClient.js` - Proxy client for DataAPI integration
- `customModelService.js` - Manages custom model registration and deployment

→ [Backend Overview](docs/architecture/backend-overview.md)

**Models** (`/models/*.js`)
- Mongoose schemas with static helper methods
- `Conversation.js` - Chat history with feedback and RAG sources
- `UserProfile.js` - User memory and preferences
- `PromptConfig.js` - Versioned system prompts with A/B testing
- `Workspace.js` - Team workspaces with settings and feature toggles
- `WorkspaceMember.js` - RBAC with 4 tiers: Owner, Admin, Member, Viewer

→ [Multi-Tenancy](docs/architecture/MULTI_TENANCY.md)

**Helpers** (`/src/helpers/*.js`)
- Pure utility functions
- `ollamaResponseHandler.js` - Response parsing, thinking model support, template tag cleaning

→ [Response Handling](docs/operations/RESPONSE_HANDLING.md)

### Singleton Pattern for Stateful Services

Critical services use singletons to maintain shared in-memory state:
- `getRagStore()` - Single vector store instance per process
- `getEmbeddingsService()` - Shared embedding cache (LRU with 24hr TTL)
- Cache hit rate: 50-80% reduction in embedding API calls

→ [Critical Conventions](docs/patterns/CRITICAL_CONVENTIONS.md)

---

## Critical Patterns

### Service-Oriented Flow
```
Routes (validation) → Services (orchestration) → Models (data) → MongoDB/Ollama
```

### Middleware Patterns

- `attachWorkspace` - Strict enforcement (mutations)
- `optionalWorkspaceContext` - Lenient loading (reads)
- `requireAuth` - Authentication required
- `apiKeyAuth` - API key validation

→ [Multi-Tenancy Documentation](docs/architecture/MULTI_TENANCY.md#workspace-middleware)

### Data Isolation Pattern

```javascript
const query = { userId };
if (req.workspace) {
  query.workspaceId = req.workspace._id;
}
const conversations = await Conversation.find(query);
```

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

→ [Critical Conventions](docs/patterns/CRITICAL_CONVENTIONS.md) for all patterns.

---

## Self-Healing System (Track 4)

Automated remediation system (`/src/services/selfHealingEngine.js` - 883 lines) with 5 strategies: model failover, prompt rollback, service restart, request throttling, and alert-only monitoring. Rules loaded from `/config/self-healing-rules.json` with cooldown enforcement and approval workflows for critical actions.

**Integration:** N4.4 Self-Healing Orchestrator (n8n) triggers remediation via webhook, scheduled evaluation every 5 minutes.

**Full documentation:** [docs/SELF_HEALING_QUICK_START.md](docs/SELF_HEALING_QUICK_START.md) and [ROADMAP.md](ROADMAP.md) (Track 4)

---

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

---

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

---

## MongoDB Schema Patterns

### Subdocument Arrays with IDs

```javascript
const MessageSchema = new mongoose.Schema({ ... });
messages: [MessageSchema]  // Each message auto-generates _id

conversation.messages.id(messageId)          // Find subdoc by _id
conversation.messages.push({ role, content }) // Add new
```

**Purpose:** Enables fine-grained feedback on individual messages

### Index Strategy

```javascript
{ createdAt: 1 }                          // Chronological queries
{ model: 1, createdAt: 1 }                // Model performance analysis
{ promptConfigId: 1 }                     // A/B testing queries
```

---

## Environment Variables

**Critical Variables:**
```bash
MONGODB_URI=mongodb://...
OLLAMA_HOST=http://...
OLLAMA_HOST_SECONDARY=http://...  # Optional
VECTOR_STORE_TYPE=memory|qdrant
AGENTX_API_KEY=...
DATAAPI_BASE_URL=http://...
BACKUP_DIR=/mnt/datalake/backups
PORT=3080
```

→ [Deployment Guide](docs/SBQC-Stack-Final/05-DEPLOYMENT.md) for complete list.

---

## Testing

**Quick Commands:**
```bash
npm test                    # Run Jest tests
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report
npm run test:e2e            # End-to-end tests
```

**Coverage Standards:**
- Services: >80%
- Routes: >70%
- Helpers: >90%

→ [Testing Patterns](docs/patterns/TESTING_PATTERNS.md) for conventions.

---

## Current Implementation Status

**Quick Stats:**
- 18 services, 21 route files, 15 data models
- All 6 development tracks complete and production-ready
- Full UI dashboards, n8n workflows (N1-N6), comprehensive test coverage

**For detailed status:** See [ROADMAP.md](ROADMAP.md)

---

## Critical Gotchas

**Top 5 Most Common Issues:**
1. **In-Memory Vector Store is NOT Persistent** → Use Qdrant for production
2. **Embedding Cache Cold Starts** → First queries after restart are slow
3. **Tool Commands Bypass LLM** → Slash commands execute BEFORE LLM processing
4. **RAG Context Injection Location** → Always appended to system prompt, not message history
5. **Model Auto-Routing Override** → When `autoRoute=true`, user's model selection is IGNORED

→ [Critical Gotchas](docs/operations/CRITICAL_GOTCHAS.md) for all 8 gotchas.

---

## Development Workflow

For detailed contribution guidelines including branching strategy, git conventions, testing standards, pull request process, code review checklists, and breaking changes protocol, see: [CONTRIBUTING.md](CONTRIBUTING.md)

**Quick Reference:**
- Use conventional commits (`feat:`, `fix:`, `docs:`, etc.)
- Test coverage: Services >80%, Routes >70%, Helpers >90%
- PR template available at `.github/PULL_REQUEST_TEMPLATE.md`
- Follow Service-Oriented Architecture (Routes → Services → Models)

---

## Documentation Reference

**For complete documentation map, see [docs/INDEX.md](docs/INDEX.md)**

**Primary Docs:**
- [ROADMAP.md](ROADMAP.md) - Project status and priorities
- [docs/INDEX.md](docs/INDEX.md) - Complete documentation index
- [docs/user-manual/README.md](docs/user-manual/README.md) - User guide
- [docs/SBQC-Stack-Final/](docs/SBQC-Stack-Final/) - Stack documentation

**API References:**
- [docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md](docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md) - All 40+ endpoints

**Architecture Deep Dives:**
- See `/docs/architecture/` for detailed component documentation
- See `/docs/patterns/` for development patterns and conventions
- See `/docs/operations/` for operational procedures and systems
