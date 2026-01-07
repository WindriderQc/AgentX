# CLAUDE.md Refactoring Plan

**Date:** 2026-01-07
**Issue:** CLAUDE.md has grown to 1,263 lines (48KB), becoming difficult to maintain and navigate
**Goal:** Restructure into modular documentation with CLAUDE.md as a concise high-level guide

---

## Current State Analysis

**File:** `/CLAUDE.md`
- **Size:** 1,263 lines, 48KB
- **Sections:** 23 major sections
- **Issue:** Monolithic file with mix of quick reference and deep technical details
- **Impact:** Difficult for agents to parse, hard to maintain, slow to load

**Section Breakdown:**
```
## Documentation (Canonical)           ~10 lines
## Getting Started                     ~10 lines
## Commands                            ~35 lines
## Architecture Overview               ~50 lines
## Model Registry                      ~115 lines ← LARGE
## Multi-Tenancy & Workspaces          ~418 lines ← VERY LARGE
## RAG System Architecture             ~55 lines
## Model Routing System                ~47 lines
## Self-Healing System                 ~8 lines
## Conversation Memory & Versioning    ~32 lines
## Benchmark System                    ~48 lines
## DataAPI Proxy Integration           ~32 lines
## n8n Integration Workflows           ~68 lines
## Startup Sequence                    ~60 lines
## Authentication                      ~27 lines
## Response Handling                   ~34 lines
## MongoDB Schema Patterns             ~30 lines
## Critical Conventions                ~52 lines
## Testing                             ~28 lines
## Current Implementation Status       ~21 lines
## Critical Gotchas                    ~36 lines
## Documentation                       ~38 lines
```

**Top 3 Bloat Offenders:**
1. Multi-Tenancy & Workspaces: 418 lines (33%)
2. Model Registry: 115 lines (9%)
3. n8n Integration Workflows: 68 lines (5%)

---

## Refactoring Strategy

### Phase 1: Extract Large Sections (Priority 1)

**Target:** Reduce CLAUDE.md to ~400 lines (~70% reduction)

**Extract to `/docs/architecture/MULTI_TENANCY.md`** (418 lines)
- Two-model design (Workspace + WorkspaceMember)
- Workspace model schema and methods
- WorkspaceMember RBAC (4 tiers)
- Workspace API routes (11 endpoints)
- Workspace middleware (4 functions)
- Frontend integration (workspace switcher, settings UI)
- Route integration (4 route files)
- Data isolation testing
- Workspace activity audit logs
- Critical patterns

**Extract to `/docs/architecture/MODEL_REGISTRY.md`** (115 lines)
- 7-tier category system
- Schema & capabilities
- Seeded models (11 models table)
- API endpoints (13 endpoints)

**Extract to `/docs/integrations/N8N_WORKFLOWS.md`** (68 lines)
- Document ingestion workflows (2 workflows)
- Prompt improvement workflows (4 workflows)
- Webhook endpoints for n8n

### Phase 2: Extract Medium Sections (Priority 2)

**Extract to `/docs/architecture/STARTUP_SEQUENCE.md`** (60 lines)
- Bootstrap order
- Graceful degradation
- Default prompt initialization

**Extract to `/docs/architecture/RAG_SYSTEM.md`** (55 lines)
- Three-layer design
- Qdrant deployment
- Configuration

**Extract to `/docs/architecture/MODEL_ROUTING.md`** (47 lines)
- Smart multi-host routing
- Persistent failover state

**Extract to `/docs/patterns/CRITICAL_CONVENTIONS.md`** (52 lines)
- Error handling pattern
- Logging with Winston
- Environment variables

**Extract to `/docs/operations/BENCHMARK_SYSTEM.md`** (48 lines)
- Service-Oriented Architecture
- Category filtering
- Task-segmented leaderboards

### Phase 3: Keep in CLAUDE.md (High-Level Guide)

**Retain (~300-400 lines):**

1. **Documentation Index** (~20 lines)
   - Links to all primary docs
   - Quick navigation

2. **Quick Start** (~50 lines)
   - Essential commands (dev, test, deploy)
   - Database operations
   - PM2 deployment

3. **Architecture Principles** (~50 lines)
   - Service-Oriented Architecture (NOT MVC)
   - Flow pattern: Routes → Services → Models
   - Core principle: Routes are thin layers
   - Links to detailed architecture docs

4. **Core Components (Summary)** (~80 lines)
   - Routes: Purpose and responsibility
   - Services: Key services with one-line descriptions + links
   - Models: Key models with one-line descriptions + links
   - Helpers: Purpose

5. **Critical Patterns** (~50 lines)
   - Singleton pattern for stateful services
   - Subdocument arrays with IDs
   - Middleware patterns (brief overview + link)

6. **Quick Reference** (~80 lines)
   - Authentication modes (session + API key)
   - Response handling (thinking models, template cleaning)
   - MongoDB schema patterns (indexes)
   - Critical gotchas (top 5 only + link to full list)

7. **Development Workflow** (~50 lines)
   - Testing approach
   - Current implementation status (summary + link to ROADMAP.md)
   - Documentation structure

---

## File Structure After Refactoring

```
/CLAUDE.md                                    (~300-400 lines)
/docs/
  /architecture/
    ARCHITECTURE_DEEP_DIVE.md                (~200 lines)
    MULTI_TENANCY.md                         (~418 lines)
    MODEL_REGISTRY.md                        (~115 lines)
    RAG_SYSTEM.md                            (~60 lines)
    MODEL_ROUTING.md                         (~50 lines)
    STARTUP_SEQUENCE.md                      (~60 lines)
  /integrations/
    N8N_WORKFLOWS.md                         (~68 lines)
    DATAAPI_PROXY.md                         (~35 lines)
  /patterns/
    CRITICAL_CONVENTIONS.md                  (~80 lines)
    ERROR_HANDLING.md                        (~30 lines)
    TESTING_PATTERNS.md                      (~40 lines)
  /operations/
    BENCHMARK_SYSTEM.md                      (~50 lines)
    SELF_HEALING.md                          (~10 lines + link to existing)
    AUTHENTICATION.md                        (~30 lines)
    RESPONSE_HANDLING.md                     (~35 lines)
    CRITICAL_GOTCHAS.md                      (~50 lines)
```

---

## New CLAUDE.md Structure (Target: 300-400 lines)

```markdown
# CLAUDE.md

This file provides high-level guidance to Claude Code when working with this repository.
For detailed technical documentation, see the links below.

## Documentation Index

**Start Here:**
- Project roadmap: [ROADMAP.md](ROADMAP.md)
- Documentation hub: [docs/INDEX.md](docs/INDEX.md)
- User manual: [docs/user-manual/README.md](docs/user-manual/README.md)

**Architecture:**
- [Multi-Tenancy & Workspaces](docs/architecture/MULTI_TENANCY.md)
- [Model Registry](docs/architecture/MODEL_REGISTRY.md)
- [RAG System](docs/architecture/RAG_SYSTEM.md)
- [Model Routing](docs/architecture/MODEL_ROUTING.md)
- [Startup Sequence](docs/architecture/STARTUP_SEQUENCE.md)

**Integrations:**
- [n8n Workflows](docs/integrations/N8N_WORKFLOWS.md)
- [DataAPI Proxy](docs/integrations/DATAAPI_PROXY.md)

**Patterns & Conventions:**
- [Critical Conventions](docs/patterns/CRITICAL_CONVENTIONS.md)
- [Testing Patterns](docs/patterns/TESTING_PATTERNS.md)
- [Error Handling](docs/patterns/ERROR_HANDLING.md)

**Operations:**
- [Benchmark System](docs/operations/BENCHMARK_SYSTEM.md)
- [Authentication](docs/operations/AUTHENTICATION.md)
- [Critical Gotchas](docs/operations/CRITICAL_GOTCHAS.md)

## Quick Start

### Essential Commands
```bash
# Development
npm start                    # Start server (port 3080)
npm test                     # Run tests
npm run test:coverage        # Coverage report

# Database
npm run seed:ops             # Seed operations data
node scripts/seed-model-registry.js

# Production (PM2)
pm2 reload ecosystem.config.js --update-env
pm2 save
pm2 status
```

## Architecture Principles

**Service-Oriented Architecture (NOT MVC)**

AgentX follows a strict service-oriented pattern:

```
Routes (validation) → Services (orchestration) → Models (data) → MongoDB/Ollama
```

**Key Principle:** Routes are thin HTTP layers. ALL business logic lives in services.

**Core Components:**
- **Routes** (`/routes/*.js`) - Request validation, response formatting → [Details](docs/architecture/ARCHITECTURE_DEEP_DIVE.md#routes)
- **Services** (`/src/services/*.js`) - Business logic and orchestration → [Details](docs/architecture/ARCHITECTURE_DEEP_DIVE.md#services)
- **Models** (`/models/*.js`) - Mongoose schemas with static helpers → [Details](docs/architecture/ARCHITECTURE_DEEP_DIVE.md#models)

### Key Services

- `chatService.js` - Chat orchestration with RAG/memory integration
- `ragStore.js` - Vector store singleton (in-memory or Qdrant)
- `modelRouter.js` - Smart routing between Ollama hosts
- `selfHealingEngine.js` - Automated remediation system → [Details](docs/SELF_HEALING_QUICK_START.md)
- `benchmarkService.js` - Task-specific model benchmarking → [Details](docs/operations/BENCHMARK_SYSTEM.md)

### Key Models

- `Conversation.js` - Chat history with feedback and RAG sources
- `Workspace.js` - Team workspaces with RBAC → [Details](docs/architecture/MULTI_TENANCY.md)
- `PromptConfig.js` - Versioned prompts with A/B testing
- `ModelRegistry.js` - Model metadata with 7-tier categories → [Details](docs/architecture/MODEL_REGISTRY.md)

## Critical Patterns

### Singleton Pattern
Services like `getRagStore()` and `getEmbeddingsService()` use singletons to maintain shared state across requests.

### Middleware Patterns
- `attachWorkspace` - Strict enforcement (mutations)
- `optionalWorkspaceContext` - Lenient loading (reads)
- `requireAuth` - Authentication required
- `apiKeyAuth` - API key validation

→ [Full middleware guide](docs/architecture/MULTI_TENANCY.md#workspace-middleware)

### Subdocument Arrays with IDs
```javascript
messages: [MessageSchema]  // Auto-generates _id for each message
conversation.messages.id(messageId)  // Find by subdoc _id
```

## Quick Reference

### Authentication Modes
1. **Session Auth** - Cookie-based for web users
2. **API Key Auth** - Header-based for n8n workflows (`x-api-key`)

### Response Handling
- Thinking models: Separate `thinking` and `content` fields
- Template tag cleaning: Auto-removes model artifacts
- Stats collection: Token counts, latency, throughput

### Critical Gotchas

**Top 5 Most Common Issues:**
1. In-memory vector store is NOT persistent → Use Qdrant for production
2. Tool commands (`/dataapi`) bypass LLM → Executed before chat
3. RAG context injected into system prompt, not message history
4. Model auto-routing (`autoRoute=true`) overrides user model selection
5. PM2 cluster mode: In-memory state NOT shared across workers

→ [Full gotchas list](docs/operations/CRITICAL_GOTCHAS.md)

## Testing

```bash
npm test                     # Unit tests
npm run test:coverage        # Coverage report
npm run test:e2e             # End-to-end tests
npm run test:load            # Artillery load tests
```

**Coverage Standards:**
- Services: >80%
- Routes: >70%
- Helpers: >90%

→ [Testing patterns guide](docs/patterns/TESTING_PATTERNS.md)

## Current Status

**All 6 development tracks complete:**
- Track 1: Alert System ✅
- Track 2: Analytics & Improvement Loops ✅
- Track 3: Custom Models ✅
- Track 4: Self-Healing Engine ✅
- Track 5: Testing & CI/CD ✅
- Track 6: Backup & Disaster Recovery ✅
- Track 7: Benchmarking Quality Scoring ✅
- Track 8: Feature Alignment Dashboard ✅

→ [Detailed roadmap](ROADMAP.md)

## Documentation Structure

**Primary Docs:**
- [ROADMAP.md](ROADMAP.md) - Project status and priorities
- [docs/INDEX.md](docs/INDEX.md) - Complete documentation index
- [docs/user-manual/README.md](docs/user-manual/README.md) - User guide
- [docs/SBQC-Stack-Final/](docs/SBQC-Stack-Final/) - Stack documentation

**API References:**
- [docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md](docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md) - All 40+ endpoints
- [docs/api/reference.md](docs/api/reference.md) - Complete API docs

**Architecture Deep Dives:**
- See `/docs/architecture/` for detailed component documentation
- See `/docs/patterns/` for development patterns and conventions
- See `/docs/operations/` for operational procedures and systems
```

---

## Migration Plan

### Step 1: Create New Directory Structure
```bash
mkdir -p docs/architecture
mkdir -p docs/integrations
mkdir -p docs/patterns
mkdir -p docs/operations
```

### Step 2: Extract Sections (Order Matters)

**Extract in this order to avoid content dependencies:**

1. `/docs/architecture/MULTI_TENANCY.md` - Extract lines 229-646 (418 lines)
2. `/docs/architecture/MODEL_REGISTRY.md` - Extract lines 114-228 (115 lines)
3. `/docs/integrations/N8N_WORKFLOWS.md` - Extract lines 869-936 (68 lines)
4. `/docs/architecture/STARTUP_SEQUENCE.md` - Extract lines 937-996 (60 lines)
5. `/docs/architecture/RAG_SYSTEM.md` - Extract lines 647-701 (55 lines)
6. `/docs/architecture/MODEL_ROUTING.md` - Extract lines 702-748 (47 lines)
7. `/docs/operations/BENCHMARK_SYSTEM.md` - Extract lines 789-836 (48 lines)
8. `/docs/patterns/CRITICAL_CONVENTIONS.md` - Extract lines 1088-1139 (52 lines)
9. `/docs/operations/AUTHENTICATION.md` - Extract lines 997-1023 (27 lines)
10. `/docs/operations/RESPONSE_HANDLING.md` - Extract lines 1024-1057 (34 lines)
11. `/docs/patterns/TESTING_PATTERNS.md` - Extract lines 1140-1167 (28 lines)
12. `/docs/operations/CRITICAL_GOTCHAS.md` - Extract lines 1189-1224 (36 lines)

### Step 3: Rewrite CLAUDE.md

**Replace existing CLAUDE.md with new structure:**
- Documentation index with links to extracted files
- Essential commands (keep as-is)
- Architecture principles (condense to 1-2 paragraphs + links)
- Core components summary (1-2 lines per component + links)
- Critical patterns (brief overview + links)
- Quick reference (top 5 gotchas only + link)
- Testing summary + link
- Current status summary + link to ROADMAP.md

### Step 4: Update Documentation Index

**Update `/docs/INDEX.md`:**
- Add "Architecture" section with links to new docs
- Add "Patterns & Conventions" section
- Add "Operations" section
- Update CLAUDE.md description: "High-level guide with links to detailed docs"

### Step 5: Validation

**Checklist:**
- [ ] All extracted sections have proper markdown formatting
- [ ] All internal links in extracted files updated (if any)
- [ ] CLAUDE.md links to all extracted files
- [ ] No broken links in new structure
- [ ] docs/INDEX.md updated
- [ ] File sizes verified (<200 lines ideal, <500 max)
- [ ] Test agent can navigate to detailed docs via CLAUDE.md links

---

## Success Criteria

**Quantitative:**
- CLAUDE.md reduced to <400 lines (<70% reduction from 1,263)
- All extracted files <500 lines
- No broken links
- Zero information loss

**Qualitative:**
- CLAUDE.md provides clear navigation to detailed docs
- Agents can quickly find relevant information
- Easier to maintain (clear file boundaries)
- Faster to load for agents

**User Experience:**
- "Where is X documented?" → Clear path via CLAUDE.md index
- Updating specific area → Edit single focused file, not monolithic CLAUDE.md
- New contributor onboarding → Start with CLAUDE.md, drill down as needed

---

## Risks & Mitigation

**Risk 1: Broken Links**
- **Mitigation:** Use relative links, validate all links after migration
- **Validation:** `grep -r "docs/" CLAUDE.md` to find all doc links

**Risk 2: Information Loss**
- **Mitigation:** Verify line counts match before/after extraction
- **Validation:** `wc -l` on old CLAUDE.md vs sum of new files

**Risk 3: Agent Confusion**
- **Mitigation:** Clear "See [link]" references in CLAUDE.md
- **Validation:** Test with agent: "Where is multi-tenancy documented?"

**Risk 4: Duplicate Content**
- **Mitigation:** Move content entirely, don't duplicate
- **Validation:** Search for duplicate headings across files

---

## Timeline

**Estimated Effort:** 2-3 hours

**Phase 1:** Create directories + extract 3 largest sections (1 hour)
**Phase 2:** Extract remaining sections (1 hour)
**Phase 3:** Rewrite CLAUDE.md + update docs/INDEX.md (30 min)
**Phase 4:** Validation + link checking (30 min)

**Total:** ~3 hours for complete refactoring

---

## Approval Required

**Before proceeding with refactoring:**
- [ ] User approves this plan
- [ ] User confirms priority (refactor now vs. defer)
- [ ] User confirms file structure (docs/architecture/, docs/patterns/, etc.)

**Alternative: Defer refactoring**
If user has higher priority work, this refactoring can be deferred. CLAUDE.md is functional, just large.

---

**Plan Created:** 2026-01-07
**Status:** Awaiting user approval
**Next Step:** Create directory structure and begin extraction (if approved)
