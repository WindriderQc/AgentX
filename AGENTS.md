# AGENTS.md

AI workspace instructions for AgentX — a local-first LLM chat platform with RAG, multi-agent roundtables, benchmarking, and SpecialX task automation on an Ollama inference stack.

## Documentation

| Doc | Purpose |
|-----|---------|
| [docs/INDEX.md](docs/INDEX.md) | Complete documentation index |
| [ROADMAP.md](ROADMAP.md) | Project status & priorities |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branching, PR, commit conventions |
| [docs/patterns/CRITICAL_CONVENTIONS.md](docs/patterns/CRITICAL_CONVENTIONS.md) | **Read before implementing** — mandatory patterns |
| [docs/operations/CRITICAL_GOTCHAS.md](docs/operations/CRITICAL_GOTCHAS.md) | **Read before debugging** — known pitfalls |
| [.github/instructions/tests.instructions.md](.github/instructions/tests.instructions.md) | Jest conventions (auto-attached to `tests/**`) |
| [docs/architecture/backend-overview.md](docs/architecture/backend-overview.md) | Component map |
| [docs/user-manual/README.md](docs/user-manual/README.md) | UI pages & navigation |
| [docs/onboarding/quickstart.md](docs/onboarding/quickstart.md) | Setup & installation |

---

## Commands

### Development
```bash
npm start                    # Start server (default port 3080)
npm test                     # Run Jest tests (silent mode)
npm run test:watch           # Run tests in watch mode
npm run test:coverage        # Generate coverage report
npm run test:e2e             # Run end-to-end test suite (./test-all.sh)
```

### Testing
```bash
npm run test:unit            # Unit tests with coverage
npm run test:integration     # Integration tests (--runInBand)
npm run test:workflows       # Workflow tests
npm run test:ci              # Jest with --detectOpenHandles
npm run validate             # Comprehensive validation script

./test-v3-rag.sh                              # Test RAG endpoints
./test-v4-analytics.sh http://localhost:3080  # Test analytics endpoints
./test-mvp.sh && ./test-backend.sh
```

### Database & Seeding
```bash
npm run seed:ops                             # Seed SBQC operations data
node scripts/seed-model-registry.js          # Enrich model registry metadata
node scripts/seed-model-registry.js --force  # Force-update metadata
```

### Production Deployment (PM2)
```bash
pm2 start ecosystem.config.js --only agentx
pm2 restart agentx
pm2 logs agentx --lines 200
pm2 status
```

---

## Architecture

**Service-Oriented Architecture — NOT MVC.**

```
Routes (validate) → Services (orchestrate) → Models (data) → MongoDB / Ollama
```

Routes are **thin HTTP layers** — no business logic. Delegate to services immediately.

| Layer | Location | Role |
|-------|----------|------|
| Routes | `routes/*.js` | Request parsing, validation, response formatting |
| Services | `src/services/*.js` | All business logic and orchestration |
| Models | `models/*.js` | Mongoose schemas with static helper methods |
| Helpers | `src/helpers/*.js` | Pure utility functions (no side-effects) |
| Middleware | `src/middleware/*.js` | Auth, workspace context, audit logging |

**Middleware mount order (critical):** auth → workspace → API routes → static files

Key middleware:
- `requireAuth` / `apiKeyAuth` — authentication
- `attachWorkspace` — strict, for mutations
- `optionalWorkspaceContext` — lenient, for reads

### Key Entry Points

| Area | Key files |
|------|-----------|
| Chat & RAG | `src/services/chatService.js`, `ragStore.js`, `embeddings.js` |
| Model routing | `src/services/modelRouter.js` (failover across Ollama hosts) |
| Roundtable | `src/services/roundtable/` (orchestrator, qualityAnalyzer, notifier) |
| Benchmarking | `src/services/qualityScorer.js`, `decomposedJudge.js` |
| Auth & workspace | `src/middleware/auth.js`, `src/middleware/workspace.js` |
| Self-healing | `src/services/selfHealingEngine.js` |
| Repo Watcher | `src/services/repoWatcherService.js` |

**Singleton pattern** — stateful services expose a getter; never instantiate directly:
```javascript
// ✓ const store = getRagStore();
// ✗ const store = new RagStore();  // breaks shared state
```
Applies to: `getRagStore()`, `getEmbeddingsService()`, `getRepoWatcherService()`.

→ [Backend Overview](docs/architecture/backend-overview.md)

---

## Critical Conventions

### Multi-tenant data isolation
```javascript
const query = { userId };
if (req.workspace) query.workspaceId = req.workspace._id;
const docs = await Conversation.find(query).lean();
```
Every query touching user data **must** scope by `workspaceId` when a workspace is present.

### RAG & memory — system prompt only, never message history
```javascript
// ✓ Append to system prompt
systemPrompt += '\n\nRelevant context:\n' + ragContext;
systemPrompt += '\n\nUser Profile:\n' + userProfile.about;

// ✗ Never push as a message
messages.push({ role: 'user', content: 'Context: ...' }); // Wrong
```

### Tool slash commands bypass LLM
`/dataapi` commands are detected and executed **before** any LLM call in `chatService.js`.
Results are returned directly. Do not change this order.

### Lean reads, batched queries
```javascript
// ✓
const docs = await Model.find({ _id: { $in: ids } }).select('f1 f2').lean();

// ✗ N+1 queries
for (const id of ids) await Model.findById(id);
```

### Error handling
```javascript
try {
  const result = await operation();
  res.json({ status: 'success', data: result });
} catch (err) {
  logger.error('Operation failed', { error: err.message });
  res.status(500).json({ status: 'error', message: err.message });
}
```

### Subdocument access
```javascript
conversation.messages.id(messageId);           // find
conversation.messages.push({ role, content });  // add
conversation.messages.id(messageId).remove();   // delete
```

---

## Testing

- **Framework**: Jest, tests in `tests/**/*.test.js`
- **Timeout**: 60s (override with `JEST_TEST_TIMEOUT`)
- **Coverage targets**: Services >80% · Routes >70% · Helpers >90%
- **Mock modules before `require`** — see [tests.instructions.md](.github/instructions/tests.instructions.md)
- Integration tests require `--runInBand`; max heap 4 GB

---

## File Size Limits

| File type | Ideal | Max | Split signal |
|-----------|-------|-----|--------------|
| Services / helpers / models | 300–400 | 700 | Multiple unrelated concerns |
| Route files | 400–600 | 1000 | Separate resource domains |
| Frontend JS | 500–800 | 1200 | Distinct page sections |
| Orchestrators | 400–600 | 800 | Extractable sub-phases |

Files exceeding max are flagged by Repo Watcher (`GET /api/repowatcher/status`).

---

## Environment Variables

```bash
MONGODB_URI=mongodb://localhost:27017/agentx
OLLAMA_HOST=http://localhost:11434
OLLAMA_HOST_SECONDARY=http://secondary:11434   # optional failover
VECTOR_STORE_TYPE=memory|qdrant                # qdrant required for production persistence
QDRANT_URL=http://localhost:6333
AGENTX_API_KEY=<key>
DATAAPI_BASE_URL=http://127.0.0.1:3003
DATAAPI_API_KEY=<key>
PORT=3080
NODE_ENV=development|production
```

Full list: [docs/architecture/SBQC-Stack-Final/05-DEPLOYMENT.md](docs/architecture/SBQC-Stack-Final/05-DEPLOYMENT.md)

---

## Roundtable — Multi-Agent Discussion

3-agent blind-then-rebuttal debate followed by synthesizer verdict + LLM-as-Judge quality scores.

- **Backend**: `src/services/roundtable/` — orchestrator, qualityAnalyzer, notifier, formatters
- **API**: `routes/roundtable.js` — SSE streaming `GET /:id/stream`, polling fallback built in
- **GPU note**: Agent order is intentional — Visionary runs last, stays hot for Synthesizer
- **Quality scoring**: opt-out, enabled by default, runs after synthesis

---

## Self-Healing System

5-strategy automated remediation (`selfHealingEngine.js`): model failover, prompt rollback, service restart, request throttling, alert-only. Rules in `config/self-healing-rules.json`. N8n workflow triggers via webhook every 5 min.

→ [docs/guides/SELF_HEALING_QUICK_START.md](docs/guides/SELF_HEALING_QUICK_START.md)

---

## Conversation Memory & Prompts

Conversations **snapshot** prompt metadata (`promptName`, `promptVersion`) at creation — not by live reference — for stable A/B analytics.

User memory is **always appended to the system prompt**, never injected as a message:
```javascript
systemPrompt += '\n\nUser Profile:\n' + userProfile.about
             + '\n\nCustom Instructions:\n' + userProfile.preferences.customInstructions;
```

Prompt A/B selection: random weighted by `trafficWeight` across all active versions for a given `name`.

---

## DataAPI Proxy

All DataAPI calls are proxied server-side: `Frontend → AgentX /api/dataapi/* → DataAPI /api/v1/*`.
Service: `src/services/dataapiClient.js`.

**Critical:** `/dataapi` slash commands are parsed by `toolService.js` and executed **before** any LLM call. Results return directly — do not change this order.

---

## MongoDB Patterns

```javascript
// Subdocument access (messages auto-generate _id)
conversation.messages.id(messageId);           // find
conversation.messages.push({ role, content });  // add
conversation.messages.id(messageId).remove();   // delete

// Always .lean() for reads; omit only when calling .save()
const docs = await Model.find(query).select('f1 f2').lean();
const doc  = await Model.findById(id);  // non-lean for save()

// Batch queries — never N+1
const docs = await Model.find({ _id: { $in: ids } });
```

---

## Repo Watcher

Automated code-quality monitor — detects missing test coverage, code duplication, and architecture violations.

- **Dashboard**: `/repoWatcher.html`
- **API**: `GET /api/repowatcher/status` · `POST /api/repowatcher/scan`
- **Implementation**: `src/services/repoWatcherService.js` (singleton), `routes/repoWatcher.js`
- **Config**: `REPO_WATCHER_PATH=/path/to/repo` (default: `process.cwd()`)

---

## Critical Gotchas

1. **In-memory vector store is NOT persistent** — use `VECTOR_STORE_TYPE=qdrant` in production.
2. **`autoRoute=true` ignores the user's model selection** — model router takes over silently.
3. **RAG context goes in system prompt**, not message history.
4. **Tool commands (`/dataapi …`) execute before LLM** — results returned inline, not sent to model.
5. **PM2 cluster + singletons** — singleton state is per-process; shared-memory state across workers will break.
6. **Prompt A/B traffic weights** — verify `trafficWeight` totals; imbalance skews test results.
7. **Embedding cache cold start** — first queries after restart are slow; cache rebuilds organically.
8. **SpecialX runs are queue-driven and finite** — never implement infinite autonomous loops.

→ [docs/operations/CRITICAL_GOTCHAS.md](docs/operations/CRITICAL_GOTCHAS.md) for full list

---

## Development Workflow

Conventional commits (`feat:`, `fix:`, `docs:`, etc.), coverage targets above, PR template at `.github/PULL_REQUEST_TEMPLATE.md`.

→ [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Naming

- **AgentX Platform** — the application runtime / control plane
- **SpecialX** — specialist task agents managed by AgentX
- **Persona** — behavior/prompt profile only (not an autonomous runtime)
- **Run** — one bounded execution of one SpecialX on one task
