# AgentX Backend Overview

## Overview

AgentX is a service-oriented Node.js/Express platform for local-first LLM operations. The current codebase exposes:

- 55 route modules
- 71 top-level services
- 52 Mongoose models
- 42 public HTML pages

The backend is not organized around the earlier V1/V2/V3/V4 rollout phases anymore. The live system now combines chat, RAG, benchmarking, roundtable debates, self-healing, workspace isolation, SpecialX automation, feature alignment, repo health tooling, and model/host operations in one runtime.

## Platform Boundaries

The current ecosystem works best as a three-plane model:

- **OpenClaw**: operator shell, notifications, conversational gateway, and higher-level orchestration
- **AgentX**: application control plane and system-of-record for chat, automation, telemetry, findings, and dashboards
- **DataAPI**: deterministic tool/data substrate used through AgentX server-side proxying and tool execution

## Architecture Pattern

The required backend pattern is:

`Routes -> Services -> Models -> MongoDB / Ollama / external systems`

Rules that matter in practice:

- routes stay thin and delegate business logic immediately,
- stateful services are consumed through singleton getters,
- RAG context and user memory are appended to the system prompt, not inserted into chat history,
- tool slash commands are executed before any LLM call,
- workspace-aware queries must scope to `workspaceId` when workspace context exists.

## Runtime Shape

### Main layers

| Layer | Location | Responsibility |
|------|----------|----------------|
| Routes | `routes/*.js` | HTTP parsing, validation, response formatting |
| Services | `src/services/*.js` | Business logic, orchestration, integrations |
| Models | `models/*.js` | Persistence schemas and collection helpers |
| Middleware | `src/middleware/*.js` | Auth, workspace context, logging, rate limiting, performance tracking |
| Frontend | `public/` | Multi-page HTML/JS/CSS UI |

### Key service domains

- chat and conversation persistence
- RAG and embeddings
- model routing and host management
- benchmark execution and scoring
- roundtable orchestration
- self-healing and notification delivery
- feature alignment, repo watcher, and doc janitor
- workspaces, invitations, and audit logging
- SpecialX queue-driven automation

## Middleware Order

The current app bootstrap in [`src/app.js`](/home/yb/codes/AgentX/src/app.js) applies middleware in this general order:

1. security headers and CORS
2. cookies and compression
3. janitor proxy route
4. body parsing and Mongo sanitize
5. session store
6. authenticated user attachment
7. request logging
8. performance tracking
9. API rate limiters
10. mounted API routes
11. static assets
12. health/config/system endpoints
13. error handlers

That ordering matters, especially for:

- auth before workspace-sensitive routes,
- API routes before static assets,
- slash/tool processing before chat inference,
- session middleware before request handlers that rely on `req.user`.

## Mounted API Families

The live backend mounts route families for:

- auth, API keys, audit logs, cache, workspaces, invitations, workspace audit
- gallery, RAG, analytics, dataset, metrics, config variants
- alerts, self-healing, n8n, profile, history, voice
- prompts, prompt templates, agents, tools, benchmark, roundtable
- Ollama hosts, Ollama VRAM, host test, host monitoring, cluster schedule
- workflow generation, backup, features, custom models, model registry, unified models
- performance, dashboard, operations, export, repo watcher, doc janitor
- SpecialX and SpecialX proposals
- chat and base API endpoints

## Key Models And Services

Representative components:

- `src/services/chatService.js` and `src/services/chat/`
- `src/services/ragStore.js`, `src/services/embeddings.js`
- `src/services/modelRouter.js`
- `src/services/roundtable/`
- `src/services/selfHealingEngine.js`
- `src/services/repoWatcherService.js`
- `src/services/docJanitorService.js`
- `src/services/automationRunnerService.js`

Representative models:

- `Conversation`, `UserProfile`, `PromptConfig`
- `Workspace`, `WorkspaceMember`, `WorkspaceInvitation`, `WorkspaceAuditLog`
- `ModelRegistry`, `CustomModel`, `InferenceLog`
- `BenchmarkBatch`, `BenchmarkPrompt`, `BenchmarkResult`, `JudgeGroundTruth`
- `SpecialX`, `AutomationTask`, `AutomationRun`
- `Finding`, `RepoScan`, `DocJanitorScan`, `FeatureInventory`

## Operational Realities

- Qdrant is required for persistent production RAG; the in-memory vector store is not durable.
- PM2 cluster mode means in-memory singleton state is process-local.
- `autoRoute=true` overrides the user-selected model.
- Tool commands bypass the model path entirely.
- Session persistence is Mongo-backed through `connect-mongodb-session`.

## Related Docs

- [Database Architecture](./database.md)
- [Startup Sequence](./STARTUP_SEQUENCE.md)
- [Model Routing](./MODEL_ROUTING.md)
- [RAG System](./RAG_SYSTEM.md)
- [Multi-Tenancy](./MULTI_TENANCY.md)
