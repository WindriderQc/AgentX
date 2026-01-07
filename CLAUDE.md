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
node scripts/seed-model-registry.js  # Seed model registry with 11 models
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
- `Workspace.js` - Team workspaces with settings and feature toggles (Week 4)
- `WorkspaceMember.js` - RBAC with 4 tiers: Owner, Admin, Member, Viewer (Week 4)

**Helpers** (`/src/helpers/*.js`)
- Pure utility functions
- `ollamaResponseHandler.js` - Response parsing, thinking model support, template tag cleaning

### Singleton Pattern for Stateful Services

Critical services use singletons to maintain shared in-memory state:
- `getRagStore()` - Single vector store instance per process
- `getEmbeddingsService()` - Shared embedding cache (LRU with 24hr TTL)
- Cache hit rate: 50-80% reduction in embedding API calls

## Model Registry

Single source of truth for model metadata with multi-dimensional categorization. Enables task-specific benchmarking, intelligent routing, and capability tracking.

**Model:** `/models/ModelRegistry.js` (590 lines)
**Routes:** `/routes/model-registry.js` (489 lines, 13 endpoints)
**Seeded Data:** 11 pre-configured models with proper categorization

### 7-Tier Category System

Models can have **multiple categories** (e.g., qwen2.5-coder is both `coding` and `specialist`):

- `ops` - Operations/glue logic (routing, classification, simple tasks)
- `coding` - Code generation, refactoring, debugging specialists
- `reasoning` - Deep thinking, problem-solving, complex analysis
- `specialist` - Fine-tuned for specific domain (code, embeddings, legal)
- `generalist` - General-purpose chat and broad task coverage
- `embedding` - Vector embeddings for RAG ingestion only
- `judge` - LLM-as-judge quality scoring

### Schema & Capabilities

```javascript
{
  modelName: String (unique, indexed),
  displayName: String,
  vendor: String,  // 'meta', 'alibaba', 'deepseek'
  categories: [String],  // Multi-select: ['coding', 'specialist']
  tags: [String],        // Freeform: ['production', 'fast', 'thinking-model']

  capabilities: {
    maxContext: Number,           // 2048, 8192, 128000
    supportsThinking: Boolean,    // Thinking models
    avgLatencyMs: Number,         // Calibrated average
    p95LatencyMs: Number,         // 95th percentile
    targetUseCase: String         // Description
  },

  benchmarkStats: {
    avgCompositeScore: Number,
    bestCategory: String,         // Where it excels
    worstCategory: String,        // Where it struggles
    totalTests: Number
  }
}
```

### Seeded Models (11)

```bash
node scripts/seed-model-registry.js  # Populate registry
```

| Model | Categories | Tags | Use Case |
|-------|-----------|------|----------|
| qwen2.5-coder:7b | coding, specialist | production, fast, code-generation | Code generation, refactoring |
| qwen2.5-coder:14b | coding, specialist, reasoning | production, high-quality | Complex code, architecture |
| deepseek-r1:7b | reasoning, specialist | experimental, thinking-model | Deep reasoning, problem-solving |
| qwen2.5:7b | reasoning, generalist | production, thinking-model | General reasoning |
| qwen2.5-7b-instruct-q4_0 | generalist, ops | production, fast, recommended | Front-door model, routing |
| llama3.3:70b | generalist, reasoning | production, high-quality, slow | High-quality responses |
| smollm2:1.7b | ops, specialist | experimental, ultra-fast | Query classification |
| gemma2:2b | ops, generalist | production, fast | Quick responses |
| nomic-embed-text | embedding | production, rag, embeddings | RAG embeddings |
| mxbai-embed-large | embedding | production, rag, high-quality | High-quality RAG |
| llama3.1:8b | judge, generalist | production, judge, balanced | LLM-as-judge scoring |

### API Endpoints (`/api/models/registry`)

**Query & List (13 endpoints total):**
```bash
# List all models with filtering
GET /api/models/registry?category=coding&tag=production&vendor=alibaba

# Get category statistics
GET /api/models/registry/stats

# Get models grouped by category
GET /api/models/registry/grouped

# Get models in specific category
GET /api/models/registry/category/coding

# Get models with specific tag
GET /api/models/registry/tag/production

# Get specific model
GET /api/models/registry/:name
```

**CRUD Operations (require auth):**
```bash
# Register new model
POST /api/models/registry
{
  "modelName": "new-model:7b",
  "categories": ["generalist"],
  "tags": ["experimental"],
  "capabilities": { "maxContext": 4096 }
}

# Update model
PATCH /api/models/registry/:name

# Retire model (soft delete)
DELETE /api/models/registry/:name?reason=deprecated

# Sync benchmark stats (auto-updates avgCompositeScore, bestCategory)
POST /api/models/registry/:name/sync

# Add/remove categories
POST /api/models/registry/:name/categories
DELETE /api/models/registry/:name/categories/:category
```

## Multi-Tenancy & Workspaces (Week 4)

**Complete team collaboration with data isolation and role-based access control.**

### Architecture

**Two-Model Design:**
- `Workspace` - Team workspace with settings, features, and metadata
- `WorkspaceMember` - Junction table for user-workspace relationships with RBAC

**Data Isolation Pattern:**
- All scoped models include `workspaceId` field (ObjectId, indexed)
- Queries filter by `workspaceId` for automatic isolation
- Backward compatible: `workspaceId` is optional for legacy data

**Isolated Resources:**
- Conversations (`/models/Conversation.js`)
- Prompts (`/models/PromptConfig.js`) - Independent versioning per workspace
- Custom Models (`/models/CustomModel.js`)
- API Keys (future)
- Alerts (future)

### Workspace Model

**File:** `/models/Workspace.js` (253 lines)

**Schema:**
```javascript
{
  // Identity
  name: String (required, 1-100 chars),
  slug: String (unique, URL-friendly, 3-50 chars, lowercase alphanumeric + hyphens),
  description: String (max 500 chars),

  // Ownership
  ownerId: ObjectId (ref: User, required, indexed),

  // Feature Settings
  settings: {
    allowedModels: [String],               // Empty = all allowed
    apiKeyEnabled: Boolean,                // API key access
    ragEnabled: Boolean,                   // RAG features
    customModelsEnabled: Boolean,          // Custom model creation
    benchmarkingEnabled: Boolean,          // Benchmarking
    alertsEnabled: Boolean,                // Alerts
    maxConversations: Number,              // 0 = unlimited
    maxApiKeys: Number,                    // Default: 10
    maxMembers: Number                     // 0 = unlimited
  },

  // Plan (future use)
  plan: String (enum: ['free', 'team', 'enterprise']),

  // Status
  status: String (enum: ['active', 'suspended', 'deleted'], indexed),

  // Timestamps
  createdAt: Date,
  updatedAt: Date,
  deletedAt: Date (for soft delete)
}
```

**Key Methods:**
- `hasFeature(feature)` - Check if feature is enabled
- `isModelAllowed(modelName)` - Check model restrictions
- `softDelete()` - Soft delete with status='deleted'
- **Static:** `findForUser(userId)` - Get user's workspaces
- **Static:** `createDefault(userId, userName)` - Create default workspace
- **Static:** `getBySlug(slug)` - Get workspace with error handling

### WorkspaceMember Model

**File:** `/models/WorkspaceMember.js` (355 lines)

**Schema:**
```javascript
{
  workspaceId: ObjectId (ref: Workspace, required, indexed),
  userId: ObjectId (ref: User, required, indexed),

  // Role-Based Access Control
  role: String (enum: ['owner', 'admin', 'member', 'viewer'], default: 'member'),

  // Granular Permissions (can override role defaults)
  permissions: {
    chat: Boolean (default: true),
    rag: Boolean (default: true),
    models: Boolean (default: false),
    benchmark: Boolean (default: false),
    alerts: Boolean (default: false),
    settings: Boolean (default: false)
  },

  // Status
  status: String (enum: ['active', 'suspended', 'pending']),

  // Invitation Tracking
  invitedBy: ObjectId (ref: User),
  invitedAt: Date,
  joinedAt: Date,

  // Timestamps
  createdAt: Date,
  updatedAt: Date
}
```

**Compound Index:** `{ workspaceId: 1, userId: 1 }` (unique)

**Role Hierarchy:**
- **Owner:** All permissions + ownership transfer + delete workspace
- **Admin:** All permissions except ownership transfer
- **Member:** Chat, RAG (no settings, models, benchmark, alerts)
- **Viewer:** Read-only (no permissions)

**Key Methods:**
- `hasPermission(permission)` - Check if member has specific permission
- `isAdmin()` - Returns true for owner or admin
- `isOwner()` - Returns true for owner only
- `setRole(newRole)` - Update role and default permissions
- **Static:** `getMember(workspaceId, userId)` - Get active member
- **Static:** `isMember(workspaceId, userId)` - Check membership
- **Static:** `getWorkspaceMembers(workspaceId)` - List all members
- **Static:** `getUserWorkspaces(userId)` - List user's workspaces
- **Static:** `inviteMember(workspaceId, userId, role, invitedBy)` - Invite new member
- **Static:** `removeMember(workspaceId, userId)` - Remove member (cannot remove owner)
- **Static:** `transferOwnership(workspaceId, fromUserId, toUserId)` - Transfer ownership (atomic transaction)

### Workspace API Routes

**File:** `/routes/workspaces.js` (786 lines, 11 endpoints)

**Workspace CRUD:**
```bash
GET    /api/workspaces           # List user's workspaces
POST   /api/workspaces           # Create workspace (becomes owner)
GET    /api/workspaces/:slug     # Get workspace details
PATCH  /api/workspaces/:slug     # Update workspace (admin only)
DELETE /api/workspaces/:slug     # Delete workspace (owner only, soft delete)
```

**Member Management:**
```bash
GET    /api/workspaces/:slug/members          # List members
POST   /api/workspaces/:slug/members          # Invite member (admin only)
PATCH  /api/workspaces/:slug/members/:id      # Update role/permissions (admin only)
DELETE /api/workspaces/:slug/members/:id      # Remove member (admin only)
POST   /api/workspaces/:slug/leave            # Leave workspace (self-removal)
POST   /api/workspaces/:slug/transfer         # Transfer ownership (owner only)
```

**Statistics:**
```bash
GET    /api/workspaces/:slug/stats            # Get workspace statistics (admin only)
```

**Returns:** Member count, conversation count, API key count, custom model count, active alert count

### Workspace Middleware

**File:** `/src/middleware/workspace.js` (4 functions)

**1. attachWorkspace** - Extract workspace context
```javascript
// Checks in order:
// 1. Query param: ?workspace=slug
// 2. Header: X-Workspace: slug
// 3. User's default workspace (future)

// Sets req.workspace to full workspace object
// Optional: Routes work without workspace context (backward compatible)
```

**2. requireWorkspaceAccess** - Verify membership
```javascript
// Requires attachWorkspace to run first
// Checks if user is member of req.workspace
// Returns 403 if not a member
```

**3. requireAdmin** - Admin-only routes
```javascript
// Checks if user is owner or admin
// Returns 403 if not admin
```

**4. requireOwner** - Owner-only routes
```javascript
// Checks if user is owner
// Returns 403 if not owner
```

### Frontend Integration

**Workspace Switcher** (`/public/js/workspace.js` - 233 lines)

**Core Features:**
- **Auto-initialization** - Loads on page load
- **localStorage persistence** - Key: `agentx_current_workspace`
- **Helper methods:**
  - `addWorkspaceParam(url)` - Add `?workspace=slug` to URLs
  - `addWorkspaceHeader(options)` - Add `X-Workspace: slug` header
- **Custom events** - Broadcasts `workspaceChanged` event
- **UI updates** - Updates dropdown button and menu

**Usage Pattern:**
```javascript
// GET requests: Add query param
const url = WorkspaceManager.addWorkspaceParam('/api/history');
const res = await fetch(url);

// POST requests: Add header
const fetchOptions = WorkspaceManager.addWorkspaceHeader({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
});
const res = await fetch('/api/chat', fetchOptions);
```

**Settings UI** (`/public/workspace-settings.html` - 1,119 lines)

**Sections:**
1. **Workspace List Sidebar** - All accessible workspaces with role badges
2. **Workspace Details** - View/edit name, slug, description (admin only)
3. **Feature Toggles** - Enable/disable RAG, custom models, benchmarking, alerts (admin only)
4. **Members Table** - Invite, change roles, remove members (admin only)
5. **Statistics Dashboard** - Member count, conversations, API keys, models, alerts (admin only)
6. **Danger Zone** - Delete workspace with confirmation (owner only)

**Modals:**
- Create Workspace (name, slug, description)
- Invite Member (email, role selection)
- Delete Workspace (must type slug to confirm)

### Route Integration

**4 Route Files Updated (19 routes total):**

**1. History Routes** (`/routes/history.js`)
- Added `attachWorkspace` middleware
- Filter conversations by workspaceId
- Verify workspace access for single conversation GET

**2. Prompt Routes** (`/routes/prompts.js`)
- **Workspace-scoped versioning** - Version numbers independent per workspace
- Create prompt: Finds highest version IN CURRENT WORKSPACE
- List prompts: Filtered by workspaceId
- Update/delete: Verify workspace access

**Critical Pattern:**
```javascript
// Version numbering scoped to workspace
const query = { name };
if (req.workspace) {
  query.workspaceId = req.workspace._id;
}
const existing = await PromptConfig.findOne(query).sort({ version: -1 });
const newVersion = existing ? existing.version + 1 : 1;
```

**Result:** Workspace A can have "default_chat" v1, v2, v3 while Workspace B has "default_chat" v1, v2 (different content)

**3. Benchmark Routes** (`/routes/benchmark.js`)
- Pass workspaceId to benchmarkService
- Tag benchmark results with workspace

**4. Custom Model Routes** (`/routes/custom-models.js`)
- Filter models by workspaceId
- Verify workspace access on get/update
- Create with workspace context

### Data Isolation Testing

**File:** `/tests/integration/workspace-isolation.test.js` (386 lines, 21 tests)

**Test Coverage:**
- ✅ Conversation isolation (4 tests)
- ✅ Prompt isolation with independent versioning (4 tests)
- ✅ Custom model isolation (3 tests)
- ✅ Cross-workspace access prevention (3 tests)
- ✅ Member permissions enforcement (3 tests)
- ✅ Statistics isolation (2 tests)
- ✅ Settings isolation (2 tests)

**Result:** 21/21 passing (100%)

**Key Test:** Multi-workspace membership
```javascript
// User is member of both Workspace A and B
// Creates conversation in each workspace
// Queries correctly filter by workspace
const conversationsA = await Conversation.find({
  userId,
  workspaceId: workspaceA._id
});
const conversationsB = await Conversation.find({
  userId,
  workspaceId: workspaceB._id
});
expect(conversationsA).toHaveLength(1);
expect(conversationsB).toHaveLength(1);
// Different conversations
expect(conversationsA[0]._id).not.toBe(conversationsB[0]._id);
```

### Workspace Activity Audit Logs (Post-Week 4)

**Status:** ✅ COMPLETE (Backend + UI)

Comprehensive activity tracking system for workspace operations with before/after state capture.

**Backend Files:**
- `/models/WorkspaceAuditLog.js` (234 lines) - Data model
- `/src/middleware/workspaceAudit.js` (175 lines) - Logging middleware
- `/routes/workspace-audit.js` (170 lines) - API endpoints

**UI:** `/public/workspace-audit.html` (550 lines)

**15 Tracked Actions:**
- **Member Management:** added, removed, role_changed, invited, invitation.revoked, invitation.accepted
- **Settings:** settings.changed, ownership.transferred
- **Models:** model.registered, model.deployed, model.deleted
- **Prompts:** prompt.created, prompt.activated, prompt.deleted

**Key Features:**
- Before/after state capture for all changes
- 90-day auto-expiration (TTL index)
- Graceful failure (never breaks main requests)
- Activity timeline UI with filtering
- CSV export (max 10,000 records)
- IP address tracking
- User attribution

**API Endpoints:**
```bash
GET /api/workspaces/:slug/audit-logs
  ?limit=20&skip=0&action=member.added&from=2026-01-01&to=2026-01-06

GET /api/workspaces/:slug/audit-logs/statistics
  ?from=2026-01-01&to=2026-01-06

GET /api/workspaces/:slug/audit-logs/export
  ?action=member.added&from=2026-01-01
```

**Integration Pattern:**
```javascript
// Capture before state
const beforeState = { field: entity.field };

// Perform operation
await entity.update(...);

// Log action (never throws)
req.workspace = workspace;
await logHelperFunction(req, 'action.name', entity, {
  before: beforeState,
  after: { field: entity.field }
});
```

**Documentation:**
- Backend guide: `/AUDIT_LOGGING_COMPLETE.md`
- UI guide: `/AUDIT_LOGS_UI_COMPLETE.md`

### Critical Patterns

**1. Optional Workspace Filtering**
```javascript
const query = { userId };
if (req.workspace) {
  query.workspaceId = req.workspace._id;
}
const conversations = await Conversation.find(query);
```

**Why:** Backward compatible - works with or without workspace context

**2. Dual API Context Pattern**
- **GET requests:** Query parameter (`?workspace=slug`)
- **POST/PUT/DELETE:** Header (`X-Workspace: slug`)

**Why:** Easier debugging for GETs, cleaner for mutations

**3. Workspace-Scoped Versioning**
```javascript
// Include workspaceId in version lookup
const query = { name };
if (req.workspace) {
  query.workspaceId = req.workspace._id;
}
const existing = await PromptConfig.findOne(query).sort({ version: -1 });
```

**Result:** Independent version numbers per workspace

**4. Role-Based UI Rendering**
```javascript
const isAdmin = member.role === 'owner' || member.role === 'admin';
const isOwner = member.role === 'owner';

element.style.display = isAdmin ? 'block' : 'none';
```

**Result:** Dynamic UI based on user's role in workspace

### Documentation

**Progress Reports:**
- `WEEK4_DAY1_PROGRESS.md` - Models and architecture (545 lines)
- `WEEK4_DAY2_PROGRESS.md` - API routes and middleware (580 lines)
- `WEEK4_DAY3_PROGRESS.md` - UI integration (990 lines)
- `WEEK4_DAY4_PROGRESS.md` - Settings UI and testing (630 lines)

**Total Implementation:** 4 days, 4,260+ lines, 28 files

## RAG System Architecture

Three-layer design: **Ingestion** (Document → Chunks → Embeddings → Vector Store) → **Storage** (Qdrant/in-memory via factory pattern) → **Retrieval** (Semantic search → Context injection into system prompt).

**Configuration:**
- `VECTOR_STORE_TYPE=memory` (dev, non-persistent) or `qdrant` (production, persistent)
- In chatService: `useRag=true` triggers semantic search, appends top-K results to system prompt
- Migration: `node scripts/migrate-vector-store.js --from in-memory --to qdrant`

**Full architecture:** [specs/V3_RAG_ARCHITECTURE.md](specs/V3_RAG_ARCHITECTURE.md)

### Qdrant Deployment

**Complete Guide:** [docs/QDRANT_DEPLOYMENT.md](docs/QDRANT_DEPLOYMENT.md) (comprehensive 600+ line deployment guide)

**Production Status:** ✅ **OPERATIONAL** (as of 2026-01-05)
- Running via PM2 (process ID 5, port 6333, 128MB RAM)
- Health check: `curl http://localhost:6333/healthz` → "healthz check passed"
- Auto-start on reboot: `pm2 save` (configured)
- Integrated with system health monitoring

**Quick Start:**
```bash
# Start via PM2 (recommended)
pm2 start ecosystem.config.js --only qdrant
pm2 save

# Or run directly
./qdrant --config-path qdrant_config.yaml  # Local binary

# Or via Docker
docker run -d --name qdrant -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant:latest
```

**Configuration:**
```bash
VECTOR_STORE_TYPE=qdrant                    # Enabled in production
QDRANT_URL=http://localhost:6333           # Local instance
QDRANT_COLLECTION=agentx_embeddings        # Collection name
```

**System Integration:**
- Health monitoring: Added to `systemHealth` object ([src/app.js:25](src/app.js#L25))
- Startup checks: Validates Qdrant connection ([server.js:144-168](server.js#L144-L168))
- API endpoint: `/health/detailed` includes Qdrant status
- UI monitoring: n8n Workflow Monitor shows Qdrant health card

**Backup & Recovery:**
- Backup script: `/home/yb/codes/DataAPI/scripts/backup-qdrant.sh`
- Backup location: `/home/yb/backups/qdrant/`
- Latest snapshot: `agentx_embeddings_20260104_232946.snapshot` (23MB)
- API endpoint: `POST /api/backup/qdrant`

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
  primary: process.env.OLLAMA_HOST,              // Required
  secondary: process.env.OLLAMA_HOST_SECONDARY   // Optional: Heavy models
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

Automated remediation system (`/src/services/selfHealingEngine.js` - 883 lines) with 5 strategies: model failover, prompt rollback, service restart, request throttling, and alert-only monitoring. Rules loaded from `/config/self-healing-rules.json` with cooldown enforcement and approval workflows for critical actions.

**Integration:** N4.4 Self-Healing Orchestrator (n8n) triggers remediation via webhook, scheduled evaluation every 5 minutes.

**Full documentation:** [docs/SELF_HEALING_QUICK_START.md](docs/SELF_HEALING_QUICK_START.md) and [ROADMAP.md](ROADMAP.md) (Track 4)

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

Service-Oriented Architecture: Routes (314 lines) delegate to benchmarkService (1,098 lines). Supports 5-level prompt library, batch testing with async execution, and quality scoring with LLM judges. Models: BenchmarkPrompt, BenchmarkResult, BenchmarkBatch with helper methods and state transitions.

**Full API specification:** [docs/BENCHMARK_QUALITY_SCORING.md](docs/BENCHMARK_QUALITY_SCORING.md)

### Category Filtering (Task-Segmented Leaderboards)

Benchmarks support filtering by model category, prompt category, and tags to enable "apples to apples" comparisons.

**Enhanced Dashboard Endpoint:**
```bash
GET /api/benchmark/dashboard?modelCategory=<category>&promptCategory=<category>&tag=<tag>&sort=<criteria>
```

**Filter Parameters:**
- `modelCategory` - Filter to models in category (ops, coding, reasoning, specialist, generalist, embedding, judge)
- `promptCategory` - Filter to prompts in category (coding, reasoning, factual, math, creative, general)
- `tag` - Filter to batches with specific tag (production, experimental, etc.)
- `sort` - Sort criteria (latency, quality, composite)

**Examples:**
```bash
# Get coding models only
curl "http://localhost:3080/api/benchmark/dashboard?modelCategory=coding"

# Get reasoning tasks only
curl "http://localhost:3080/api/benchmark/dashboard?promptCategory=reasoning"

# Get coding models on coding tasks (find best code generator)
curl "http://localhost:3080/api/benchmark/dashboard?modelCategory=coding&promptCategory=coding"

# Get production-tagged batches sorted by quality
curl "http://localhost:3080/api/benchmark/dashboard?tag=production&sort=quality"

# Combined filters
curl "http://localhost:3080/api/benchmark/dashboard?modelCategory=reasoning&promptCategory=reasoning&tag=production&sort=composite"
```

**How It Works:**
1. Frontend passes category/tag filters to dashboard endpoint
2. Backend queries ModelRegistry for models matching `modelCategory`
3. BenchmarkResult aggregation filters to matching models and `promptCategory`
4. Tag filter queries BenchmarkBatch for batches with tag, then filters results
5. Returns task-specific leaderboard (e.g., "Best Coding Models" vs "Best Reasoning Models")

**Critical Pattern:** Category filtering enables finding the right model for specific tasks, preventing fast-but-weak models from ranking artificially high on trivial tasks.

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
