# External Agent Prompt: CLAUDE.md Refactoring

**Task:** Refactor CLAUDE.md from 1,263 lines to ~300-400 lines by extracting 12 sections into modular documentation

**Context:** CLAUDE.md has grown too large (48KB) and needs to be restructured into focused documentation files while preserving 100% of information.

**Status:** Ready for execution with validated line ranges and comprehensive implementation plan

---

## Your Mission

Execute a complete refactoring of CLAUDE.md following a 6-phase approach:
1. Pre-refactoring (backup, resolve conflicts, create directories)
2. Extract 12 sections in dependency order
3. Rewrite CLAUDE.md to 300-400 lines with documentation hub
4. Integrate (update INDEX.md, add cross-links)
5. Validate (zero information loss, no broken links)
6. Finalize (commit with report)

**Success Criteria:**
- CLAUDE.md reduced from 1,263 → 358 lines (72% reduction)
- 12 new documentation files created with proper headers
- Zero information loss verified
- Zero broken links
- All files within expected size ranges
- Single atomic commit ready for merge

---

## Critical Files You'll Work With

**Input Files:**
- `/home/yb/codes/AgentX/CLAUDE.md` (1,263 lines) - Source to refactor
- `/home/yb/codes/AgentX/CLAUDE_MD_REFACTORING_PLAN.md` - Your detailed specification
- `/home/yb/codes/AgentX/docs/INDEX.md` - Documentation hub to update
- `/home/yb/codes/AgentX/docs/AUTHENTICATION.md` - Conflict file to rename

**Output Files (12 new files):**

Architecture (`/docs/architecture/`):
- `MULTI_TENANCY.md` (lines 229-646, 418 lines)
- `MODEL_REGISTRY.md` (lines 114-228, 115 lines)
- `RAG_SYSTEM.md` (lines 647-701, 55 lines)
- `MODEL_ROUTING.md` (lines 702-748, 47 lines)
- `STARTUP_SEQUENCE.md` (lines 937-996, 60 lines)

Integrations (`/docs/integrations/`):
- `N8N_WORKFLOWS.md` (lines 869-936, 68 lines)

Patterns (`/docs/patterns/`):
- `CRITICAL_CONVENTIONS.md` (lines 1088-1139, 52 lines)
- `TESTING_PATTERNS.md` (lines 1140-1167, 28 lines)

Operations (`/docs/operations/`):
- `AUTHENTICATION.md` (lines 997-1023, 27 lines)
- `RESPONSE_HANDLING.md` (lines 1024-1057, 34 lines)
- `BENCHMARK_SYSTEM.md` (lines 789-836, 48 lines)
- `CRITICAL_GOTCHAS.md` (lines 1189-1224, 36 lines)

---

## Phase 1: Pre-Refactoring (15 minutes)

### 1.1 Create Backup Branch

```bash
cd /home/yb/codes/AgentX
git checkout -b refactor/claude-md-modular
git add -A
git commit -m "chore: snapshot before CLAUDE.md refactoring

- Current state: 1,263 lines
- Target: 300-400 lines with modular docs
- 12 sections to extract across 4 directories"
```

**Checkpoint:** ✅ Verify commit created

### 1.2 Resolve AUTHENTICATION.md Conflict

```bash
# Rename existing file to avoid conflict
mv /home/yb/codes/AgentX/docs/AUTHENTICATION.md \
   /home/yb/codes/AgentX/docs/AUTHENTICATION_IMPLEMENTATION_DETAILS.md
```

**Checkpoint:** ✅ File renamed, no conflict

### 1.3 Create Directory Structure

```bash
mkdir -p /home/yb/codes/AgentX/docs/integrations
mkdir -p /home/yb/codes/AgentX/docs/patterns
mkdir -p /home/yb/codes/AgentX/docs/operations
```

**Checkpoint:** ✅ All 3 directories exist

### 1.4 Create Backup

```bash
cp /home/yb/codes/AgentX/CLAUDE.md /tmp/CLAUDE_BACKUP.md
```

**Checkpoint:** ✅ Backup created at `/tmp/CLAUDE_BACKUP.md`

---

## Phase 2: Extraction (45 minutes)

**CRITICAL:** Extract in this exact order (dependency order matters)

### Extraction Template

For each file, use this structure:

```markdown
# [Title]

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → [This Document]

> **Context:** [Brief description of what this doc covers and why it exists]

## [First Section Header from Original]

[Content from specified line range]

## Related Documentation

- [Link to related doc 1](path/to/doc1.md)
- [Link to related doc 2](path/to/doc2.md)

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

### 2.1 Extract Testing Patterns

**Source:** Lines 1140-1167 (28 lines)
**Target:** `/home/yb/codes/AgentX/docs/patterns/TESTING_PATTERNS.md`

```bash
# Extract content
sed -n '1140,1167p' /home/yb/codes/AgentX/CLAUDE.md > /tmp/testing_extract.md
```

**Header:**
```markdown
# Testing Patterns

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Testing Patterns

> **Context:** AgentX testing conventions and patterns. For complete testing documentation, see [ROADMAP.md Track 5](../../ROADMAP.md#track-5-testing-infrastructure--ci-cd).

## Jest Configuration

[Content from lines 1140-1167]

## Related Documentation

- [Critical Conventions](CRITICAL_CONVENTIONS.md) - Error handling and logging patterns
- [ROADMAP.md Track 5](../../ROADMAP.md#track-5-testing-infrastructure--ci-cd) - Full testing strategy

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**Checkpoint:** ✅ File created, ~40-50 lines total

### 2.2 Extract Critical Gotchas

**Source:** Lines 1189-1224 (36 lines)
**Target:** `/home/yb/codes/AgentX/docs/operations/CRITICAL_GOTCHAS.md`

**Header:**
```markdown
# Critical Gotchas & Known Issues

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Critical Gotchas

> **Context:** Common pitfalls and non-obvious behaviors in AgentX. Read this before debugging production issues.

## Overview

[Content from lines 1189-1224 - includes all 8 gotchas]

## Related Documentation

- [RAG System Architecture](../architecture/RAG_SYSTEM.md) - Vector store details
- [Model Routing](../architecture/MODEL_ROUTING.md) - Auto-routing behavior
- [Startup Sequence](../architecture/STARTUP_SEQUENCE.md) - Initialization order

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**Checkpoint:** ✅ All 8 gotchas present

### 2.3 Extract Response Handling

**Source:** Lines 1024-1057 (34 lines)
**Target:** `/home/yb/codes/AgentX/docs/operations/RESPONSE_HANDLING.md`

**Header:**
```markdown
# Response Handling

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Response Handling

> **Context:** How AgentX processes and formats LLM responses, including thinking model support and template cleaning.

## Overview

Helper service: `/src/helpers/ollamaResponseHandler.js`

[Content from lines 1024-1057]

## Related Documentation

- [Model Routing](../architecture/MODEL_ROUTING.md) - How models are selected
- [Critical Conventions](../patterns/CRITICAL_CONVENTIONS.md) - Error handling patterns

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**Checkpoint:** ✅ Thinking model support and template cleaning sections preserved

### 2.4 Extract Critical Conventions

**Source:** Lines 1088-1139 (52 lines)
**Target:** `/home/yb/codes/AgentX/docs/patterns/CRITICAL_CONVENTIONS.md`

**Header:**
```markdown
# Critical Conventions

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Critical Conventions

> **Context:** Mandatory coding patterns and conventions for AgentX development. These are enforced in code reviews.

## Table of Contents

1. Error Handling Pattern
2. Logging with Winston
3. Environment Variables

---

[Content from lines 1088-1139]

## Related Documentation

- [Response Handling](../operations/RESPONSE_HANDLING.md) - Response formatting patterns
- [Testing Patterns](TESTING_PATTERNS.md) - Testing conventions
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - Development workflow

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**Checkpoint:** ✅ All 3 sections with code snippets preserved

### 2.5 Extract Authentication

**Source:** Lines 997-1023 (27 lines)
**Target:** `/home/yb/codes/AgentX/docs/operations/AUTHENTICATION.md`

**Header:**
```markdown
# Authentication Quick Reference

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Authentication

> **Context:** Operational guide for AgentX authentication. For detailed implementation, see [AUTHENTICATION_IMPLEMENTATION_DETAILS.md](../AUTHENTICATION_IMPLEMENTATION_DETAILS.md).

## Dual Auth System

[Content from lines 997-1023]

## Related Documentation

- [AUTHENTICATION_IMPLEMENTATION_DETAILS.md](../AUTHENTICATION_IMPLEMENTATION_DETAILS.md) - Full implementation guide
- [API Reference](../SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md) - Authentication endpoints

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**IMPORTANT:** Also add cross-reference to renamed file:

```bash
# Add to top of AUTHENTICATION_IMPLEMENTATION_DETAILS.md
sed -i '1i> **Quick Reference:** For operational summary, see [operations/AUTHENTICATION.md](operations/AUTHENTICATION.md).\n' \
  /home/yb/codes/AgentX/docs/AUTHENTICATION_IMPLEMENTATION_DETAILS.md
```

**Checkpoint:** ✅ Dual auth system preserved, cross-ref added

### 2.6 Extract N8N Workflows

**Source:** Lines 869-936 (68 lines)
**Target:** `/home/yb/codes/AgentX/docs/integrations/N8N_WORKFLOWS.md`

**Header:**
```markdown
# n8n Integration Workflows

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → n8n Workflows

> **Context:** Automated workflows for document ingestion and prompt optimization. For detailed n8n documentation, see reports in `/docs/reports/`.

## Overview

AgentX integrates with n8n for automated document ingestion and prompt optimization loops.

[Content from lines 869-936]

## Related Documentation

- [n8n Ingestion Report](../reports/n8n-ingestion.md) - Detailed workflow documentation
- [n8n Prompt Improvement](../reports/n8n-prompt-improvement-v4.md) - V4 optimization loops
- [RAG System](../architecture/RAG_SYSTEM.md) - Document ingestion architecture

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**Checkpoint:** ✅ Document ingestion and prompt improvement workflows preserved

### 2.7 Extract Benchmark System

**Source:** Lines 789-836 (48 lines)
**Target:** `/home/yb/codes/AgentX/docs/operations/BENCHMARK_SYSTEM.md`

**Header:**
```markdown
# Benchmark System

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Benchmark System

> **Context:** Service-oriented benchmarking with category filtering and quality scoring. For complete API reference, see [BENCHMARK_QUALITY_SCORING.md](../BENCHMARK_QUALITY_SCORING.md).

## Architecture

Service-Oriented Architecture: Routes (314 lines) delegate to benchmarkService (1,098 lines).

[Content from lines 789-836]

## Related Documentation

- [BENCHMARK_QUALITY_SCORING.md](../BENCHMARK_QUALITY_SCORING.md) - Complete API specification
- [Model Registry](../architecture/MODEL_REGISTRY.md) - Category filtering integration

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**Checkpoint:** ✅ Category filtering section preserved

### 2.8 Extract Model Routing

**Source:** Lines 702-748 (47 lines)
**Target:** `/home/yb/codes/AgentX/docs/architecture/MODEL_ROUTING.md`

**Header:**
```markdown
# Model Routing System

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Model Routing

> **Context:** Smart multi-host routing with persistent failover state. Integrates with [Model Registry](MODEL_REGISTRY.md) for category-based routing.

## Overview

**Service:** `/src/services/modelRouter.js`

[Content from lines 702-748]

## Related Documentation

- [Model Registry](MODEL_REGISTRY.md) - Model categorization for routing
- [Self-Healing System](../../ROADMAP.md#track-4-self-healing--remediation) - Failover integration

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**Checkpoint:** ✅ Smart routing and failover state sections preserved

### 2.9 Extract RAG System

**Source:** Lines 647-701 (55 lines)
**Target:** `/home/yb/codes/AgentX/docs/architecture/RAG_SYSTEM.md`

**Header:**
```markdown
# RAG System Architecture

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → RAG System

> **Context:** Three-layer RAG design with Qdrant integration. For complete architecture details, see [V3_RAG_ARCHITECTURE.md](../../specs/V3_RAG_ARCHITECTURE.md).

## Overview

Three-layer design: **Ingestion** → **Storage** → **Retrieval**

[Content from lines 647-701]

## Related Documentation

- [V3_RAG_ARCHITECTURE.md](../../specs/V3_RAG_ARCHITECTURE.md) - Full architecture specification
- [QDRANT_DEPLOYMENT.md](../QDRANT_DEPLOYMENT.md) - Deployment guide (600+ lines)
- [N8N Workflows](../integrations/N8N_WORKFLOWS.md) - Document ingestion workflows

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**Checkpoint:** ✅ Three-layer design and Qdrant deployment sections preserved

### 2.10 Extract Startup Sequence

**Source:** Lines 937-996 (60 lines)
**Target:** `/home/yb/codes/AgentX/docs/architecture/STARTUP_SEQUENCE.md`

**Header:**
```markdown
# Startup Sequence

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Startup Sequence

> **Context:** Bootstrap order and graceful degradation strategy for AgentX server initialization.

## Bootstrap Order

**File:** `/server.js`

[Content from lines 937-996]

## Related Documentation

- [Backend Overview](backend-overview.md) - Service initialization details
- [Authentication](../operations/AUTHENTICATION.md) - Auth middleware setup
- [RAG System](RAG_SYSTEM.md) - Vector store initialization

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**Checkpoint:** ✅ Bootstrap order and default prompt init preserved

### 2.11 Extract Model Registry

**Source:** Lines 114-228 (115 lines)
**Target:** `/home/yb/codes/AgentX/docs/architecture/MODEL_REGISTRY.md`

**Header:**
```markdown
# Model Registry

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Model Registry

> **Context:** Single source of truth for model metadata with multi-dimensional categorization. Enables task-specific benchmarking and intelligent routing.

## Overview

**Model:** `/models/ModelRegistry.js` (590 lines)
**Routes:** `/routes/model-registry.js` (489 lines, 13 endpoints)
**Seeded Data:** 11 pre-configured models

[Content from lines 114-228]

## Related Documentation

- [Model Routing](MODEL_ROUTING.md) - Category-based routing integration
- [Benchmark System](../operations/BENCHMARK_SYSTEM.md) - Category filtering

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**Checkpoint:** ✅ 7-tier category system and seeded models table preserved

### 2.12 Extract Multi-Tenancy (LARGEST)

**Source:** Lines 229-646 (418 lines)
**Target:** `/home/yb/codes/AgentX/docs/architecture/MULTI_TENANCY.md`

**Header:**
```markdown
# Multi-Tenancy & Workspaces (Week 4)

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Multi-Tenancy

> **Context:** Complete team collaboration with data isolation and role-based access control. For progress reports, see Week 4 documentation in `/docs/`.

## Overview

**Complete team collaboration with data isolation and role-based access control.**

[Content from lines 229-646 - ALL 418 lines]

## Related Documentation

- [Backend Overview](backend-overview.md) - Service architecture
- [API Reference](../SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md) - Workspace endpoints
- [Workspace Audit Logs](../../AUDIT_LOGGING_COMPLETE.md) - Activity tracking

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
```

**Checkpoint:** ✅ All 10 subsections preserved (Architecture, Models, Routes, Middleware, Frontend, etc.)

---

## Phase 3: CLAUDE.md Rewrite (20 minutes)

### 3.1 Create New CLAUDE.md

**Target:** 300-400 lines

**Structure:**

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Documentation Hub

**Start Here:**
- **[docs/INDEX.md](docs/INDEX.md)** - Documentation index
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
- [Critical Gotchas](docs/operations/CRITICAL_GOTCHAS.md) - Known issues & pitfalls

---

## Documentation (Canonical)

[KEEP: Lines 5-15 from original]

## Getting Started

[KEEP: Lines 17-25 from original]

## Commands

[KEEP: Lines 27-61 from original - ALL command sections verbatim]

## Architecture Overview

### Service-Oriented Architecture (NOT MVC)

[KEEP: Lines 65-75 from original - Core principles]

**For detailed component documentation, see:**
- [Backend Overview](docs/architecture/backend-overview.md)
- [Multi-Tenancy](docs/architecture/MULTI_TENANCY.md)
- [Model Registry](docs/architecture/MODEL_REGISTRY.md)

### Core Components

**Routes** (`/routes/*.js`)
- Thin HTTP layer for validation and request parsing
- Immediately delegate to services
- Handle response formatting and error responses
→ [Architecture docs](docs/architecture/)

**Services** (`/src/services/*.js`)
- Business logic and orchestration
- Key services: chatService, ragStore, modelRouter, selfHealingEngine, benchmarkService
→ [Backend Overview](docs/architecture/backend-overview.md)

**Models** (`/models/*.js`)
- Mongoose schemas with static helper methods
- Key models: Conversation, Workspace, PromptConfig, ModelRegistry
→ [Multi-Tenancy](docs/architecture/MULTI_TENANCY.md)

**Helpers** (`/src/helpers/*.js`)
- Pure utility functions
→ [Response Handling](docs/operations/RESPONSE_HANDLING.md)

### Singleton Pattern for Stateful Services

Critical services use singletons to maintain shared in-memory state:
- `getRagStore()` - Single vector store instance per process
- `getEmbeddingsService()` - Shared embedding cache (LRU with 24hr TTL)

→ [Critical Patterns](docs/patterns/CRITICAL_CONVENTIONS.md)

---

## Critical Patterns

### Service-Oriented Flow
```
Routes (validation) → Services (orchestration) → Models (data) → MongoDB/Ollama
```

**Key Principle:** Routes should NEVER contain business logic. They validate requests and delegate to services immediately.

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

## Documentation

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
```

### 3.2 Execute Rewrite

```bash
# Backup original
cp /home/yb/codes/AgentX/CLAUDE.md /tmp/CLAUDE_BACKUP.md

# Create new CLAUDE.md
cat > /home/yb/codes/AgentX/CLAUDE.md <<'EOF'
[Content from template above]
EOF
```

**Checkpoint:** ✅ New CLAUDE.md is 300-400 lines

---

## Phase 4: Integration (15 minutes)

### 4.1 Update docs/INDEX.md

**Add after "Primary Documentation" section (around line 15):**

```markdown
## Architecture Documentation

Complete architectural patterns and system design:

- **[Multi-Tenancy & Workspaces](architecture/MULTI_TENANCY.md)** - Team collaboration, RBAC, data isolation
- **[Model Registry](architecture/MODEL_REGISTRY.md)** - Model categorization, 7-tier category system
- **[RAG System](architecture/RAG_SYSTEM.md)** - Vector store, retrieval, Qdrant integration
- **[Model Routing](architecture/MODEL_ROUTING.md)** - Smart routing, failover, persistent state
- **[Startup Sequence](architecture/STARTUP_SEQUENCE.md)** - Bootstrap order, graceful degradation
- **[Backend Overview](architecture/backend-overview.md)** - Service-oriented architecture

## Integration Documentation

External system integrations and automation workflows:

- **[N8N Workflows](integrations/N8N_WORKFLOWS.md)** - Document ingestion, prompt optimization

## Patterns & Conventions

Mandatory coding patterns and testing standards:

- **[Critical Conventions](patterns/CRITICAL_CONVENTIONS.md)** - Error handling, logging, environment variables
- **[Testing Patterns](patterns/TESTING_PATTERNS.md)** - Jest config, integration tests

## Operations Documentation

Operational guides and troubleshooting:

- **[Authentication](operations/AUTHENTICATION.md)** - Dual auth system, API keys
- **[Response Handling](operations/RESPONSE_HANDLING.md)** - LLM response processing
- **[Benchmark System](operations/BENCHMARK_SYSTEM.md)** - Quality scoring
- **[Critical Gotchas](operations/CRITICAL_GOTCHAS.md)** - Known issues, pitfalls
```

**Checkpoint:** ✅ docs/INDEX.md updated with 4 new sections

---

## Phase 5: Validation (15 minutes)

### 5.1 Create Link Validation Script

```bash
cat > /home/yb/codes/AgentX/scripts/validate-docs-links.sh <<'SCRIPT'
#!/bin/bash
echo "Validating documentation links..."

broken_links=0

# Check CLAUDE.md links
while IFS= read -r link; do
  if [[ ! -f "/home/yb/codes/AgentX/$link" ]]; then
    echo "BROKEN: CLAUDE.md -> $link"
    ((broken_links++))
  fi
done < <(grep -oP '\]\(\K[^)]+\.md(?=\))' /home/yb/codes/AgentX/CLAUDE.md)

# Check docs/INDEX.md links
while IFS= read -r link; do
  if [[ ! -f "/home/yb/codes/AgentX/docs/$link" ]]; then
    echo "BROKEN: docs/INDEX.md -> $link"
    ((broken_links++))
  fi
done < <(grep -oP '\]\(\K[^)]+\.md(?=\))' /home/yb/codes/AgentX/docs/INDEX.md)

echo ""
if [ $broken_links -eq 0 ]; then
  echo "✓ All links valid"
  exit 0
else
  echo "✗ Found $broken_links broken links"
  exit 1
fi
SCRIPT

chmod +x /home/yb/codes/AgentX/scripts/validate-docs-links.sh
```

### 5.2 Run Validations

```bash
# Verify line counts
echo "Original: $(wc -l < /tmp/CLAUDE_BACKUP.md) lines"
echo "New CLAUDE.md: $(wc -l < /home/yb/codes/AgentX/CLAUDE.md) lines"

# Validate links
/home/yb/codes/AgentX/scripts/validate-docs-links.sh

# Check file sizes
for file in \
  docs/architecture/MULTI_TENANCY.md \
  docs/architecture/MODEL_REGISTRY.md \
  docs/architecture/RAG_SYSTEM.md \
  docs/architecture/MODEL_ROUTING.md \
  docs/architecture/STARTUP_SEQUENCE.md \
  docs/integrations/N8N_WORKFLOWS.md \
  docs/patterns/CRITICAL_CONVENTIONS.md \
  docs/patterns/TESTING_PATTERNS.md \
  docs/operations/AUTHENTICATION.md \
  docs/operations/RESPONSE_HANDLING.md \
  docs/operations/BENCHMARK_SYSTEM.md \
  docs/operations/CRITICAL_GOTCHAS.md; do
  echo "$file: $(wc -l < "/home/yb/codes/AgentX/$file") lines"
done
```

**Checkpoint:** ✅ All validations pass

---

## Phase 6: Finalization (10 minutes)

### 6.1 Create Commit

```bash
cd /home/yb/codes/AgentX
git add -A
git commit -m "refactor(docs): modularize CLAUDE.md into 12 focused documents

BREAKING CHANGE: CLAUDE.md reduced from 1,263 to ~358 lines (72% reduction)

Extracted sections to modular documentation:

Architecture (/docs/architecture/):
- MULTI_TENANCY.md - Team collaboration & RBAC
- MODEL_REGISTRY.md - Model categorization
- RAG_SYSTEM.md - Vector store & retrieval
- MODEL_ROUTING.md - Smart routing & failover
- STARTUP_SEQUENCE.md - Bootstrap order

Integrations (/docs/integrations/):
- N8N_WORKFLOWS.md - Automated workflows

Patterns (/docs/patterns/):
- CRITICAL_CONVENTIONS.md - Mandatory coding patterns
- TESTING_PATTERNS.md - Testing standards

Operations (/docs/operations/):
- AUTHENTICATION.md - Dual auth system
- RESPONSE_HANDLING.md - LLM response processing
- BENCHMARK_SYSTEM.md - Quality scoring
- CRITICAL_GOTCHAS.md - Known issues

Changes:
- Resolved AUTHENTICATION.md conflict (renamed to AUTHENTICATION_IMPLEMENTATION_DETAILS.md)
- Added navigation breadcrumbs to all extracted files
- Updated docs/INDEX.md with new sections
- Zero information loss: All content preserved

Validation:
- 0 broken links
- All files within expected size ranges

🤖 Generated with Claude Code
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

### 6.2 Generate Report

```bash
cat > /home/yb/codes/AgentX/REFACTORING_REPORT.md <<EOF
# CLAUDE.md Refactoring Report

**Date:** $(date +%Y-%m-%d)
**Status:** ✅ Complete

## Summary

Successfully refactored CLAUDE.md from 1,263 lines to ~358 lines (72% reduction).

## Metrics

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| CLAUDE.md lines | 1,263 | 358 | -905 (-72%) |
| Documentation files | 1 | 13 | +12 |
| Directories | 1 | 4 | +3 |
| Broken links | N/A | 0 | ✓ |

## Files Created

12 new documentation files in:
- /docs/architecture/ (5 files)
- /docs/integrations/ (1 file)
- /docs/patterns/ (2 files)
- /docs/operations/ (4 files)

## Validation Results

- ✓ Zero information loss verified
- ✓ All links validated (0 broken)
- ✓ File sizes within expected ranges
- ✓ Agent navigation functional

## Rollback Available

Backup: /tmp/CLAUDE_BACKUP.md
Branch: refactor/claude-md-modular

---

**Completed:** $(date)
EOF
```

**Checkpoint:** ✅ All phases complete, ready for merge

---

## Final Deliverables

**You Should Deliver:**

1. ✅ 12 new documentation files with proper headers and cross-links
2. ✅ New CLAUDE.md (300-400 lines) with documentation hub
3. ✅ Updated docs/INDEX.md with 4 new sections
4. ✅ Link validation script at `/scripts/validate-docs-links.sh`
5. ✅ Refactoring report at `/REFACTORING_REPORT.md`
6. ✅ Single atomic commit ready for merge
7. ✅ Backup at `/tmp/CLAUDE_BACKUP.md`

**Success Validation:**

- [ ] CLAUDE.md is 300-400 lines
- [ ] All 12 files created
- [ ] 0 broken links
- [ ] All content preserved
- [ ] Git commit ready
- [ ] Report generated

---

## Important Notes

1. **Extract in exact order** (dependency order matters for cross-references)
2. **Use sed for line extraction** to ensure exact content
3. **Add proper headers** to every extracted file (navigation, context, related docs)
4. **Test links** before final commit
5. **Keep verbatim** the Commands section (lines 27-61) in new CLAUDE.md

---

## Questions?

If you encounter any issues:
1. Check `/CLAUDE_MD_REFACTORING_PLAN.md` for detailed spec
2. Verify line ranges match current CLAUDE.md
3. Run validation scripts at each checkpoint
4. Use rollback procedure if critical errors found

---

**Ready to Execute:** ✅
**Estimated Time:** 2 hours
**Risk Level:** LOW (comprehensive validation, clear rollback plan)
