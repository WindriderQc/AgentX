# AgentX Service Decomposition Architecture

> Canonical reference for the 10-service logical decomposition of AgentX.
> Last updated: 2026-02-23

---

## Overview

AgentX is decomposed into **10 logical services** within a single Node.js process. Each service has a dedicated agent responsible for its code, tests, and documentation. Services communicate via **direct function imports** (no HTTP/RPC between services). The dependency graph is **acyclic**.

| Property | Value |
|:---|:---|
| Runtime | Single Node.js process (Express) |
| Communication | Direct function imports |
| Database | MongoDB (Mongoose ODM) |
| External deps | Ollama, Qdrant, n8n, DataAPI |
| Dependency topology | Directed Acyclic Graph (DAG) |

---

## The 10 Services

### 1. Chat Service (ChatAgent)

**Responsibility:** Core conversational AI -- chat requests, streaming, tool commands, image generation, conversation persistence/search, user profile/memory, voice I/O.

| Layer | Files |
|:---|:---|
| Services | `chatService.js`, `chat/chatPromptHelpers.js`, `chat/ragContextBuilder.js`, `chat/conversationPersistence.js`, `chat/imageGeneration.js`, `conversationSearchService.js`, `conversationJudge.js`, `toolService.js`, `toolExecutor.js`, `agentService.js`, `voiceService.js` |
| Routes | `api.js`, `history.js`, `profile.js`, `voice.js`, `tools.js`, `agents.js` |
| Models | `Conversation.js`, `UserProfile.js`, `AgentX.js`, `Feedback.js` |

**Consumes:**
- Model Management -- `routeRequest()` for LLM inference
- RAG & Knowledge -- `search()` for retrieval-augmented context
- Prompt & Config -- `getActivePrompt()` for system prompt resolution

---

### 2. Model Management Service (ModelAgent)

**Responsibility:** LLM model routing, aggregation, custom models, hardware profiles, Ollama hosts, VRAM tracking, n8n LLM gateway.

| Layer | Files |
|:---|:---|
| Services | `modelRouter.js`, `modelAggregator.js`, `customModelService.js`, `hardwareProfileService.js`, `n8nLLMProvider.js`, `ollamaVramService.js` |
| Routes | `models-unified.js`, `custom-models.js`, `model-registry.js`, `ollama-hosts.js`, `ollama-vram.js` |
| Models | `ModelRegistry.js`, `CustomModel.js`, `HardwareProfile.js`, `N8nLLMSource.js`, `ModelPricingConfig.js` |

**Consumes:**
- Ollama HTTP API (external)
- n8n API (external)

> Leaf service -- no downstream AgentX service dependencies.

---

### 3. RAG & Knowledge Service (RAGAgent)

**Responsibility:** Document ingestion, vector store management, embeddings, file watching, codebase sync, contextual compression.

| Layer | Files |
|:---|:---|
| Services | `ragStore.js`, `ragFileWatcher.js`, `ragCompression.js`, `ragCodebaseSyncService.js`, `embeddings.js`, `tokenCounter.js`, `vectorStore/*.js` |
| Routes | `rag.js` |
| Models | `RagManifest.js`, `EmbeddingCacheStats.js` |

**Consumes:**
- Ollama (embeddings, external)
- Qdrant HTTP API (external)

> Leaf service -- no downstream AgentX service dependencies.

---

### 4. Benchmark & Quality Service (BenchmarkAgent)

**Responsibility:** LLM benchmarking, scoring engines, judging, results analytics, leaderboard, batch management.

| Layer | Files |
|:---|:---|
| Services | `benchmark/*.js` (17 files), `scoring/*.js` (7 files), `qualityScorer.js`, `deterministicScorer.js`, `decomposedJudge.js`, `referenceScorer.js`, `judgeConfidence.js`, `judgeValidation.js`, `conversationJudge.js` |
| Routes | `benchmark/*.js` (7 files) |
| Models | `BenchmarkBatch.js`, `BenchmarkResult.js`, `BenchmarkPrompt.js`, `JudgeGroundTruth.js` |

**Consumes:**
- Model Management -- `routeRequest()`, `HOSTS` for inference during benchmarks

---

### 5. Analytics & Observability Service (AnalyticsAgent)

**Responsibility:** Usage analytics, metrics collection/cleanup, performance monitoring, dashboards, cost calculation, load testing, API telemetry.

| Layer | Files |
|:---|:---|
| Services | `metricsCollector.js`, `metricsCleanup.js`, `usageAnalyticsService.js`, `dashboardService.js`, `costCalculator.js`, `artilleryParser.js`, `performanceTracker.js` middleware |
| Routes | `analytics.js`, `performance.js`, `metrics.js`, `operations.js` |
| Models | `PerformanceSnapshot.js`, `PerformanceBaseline.js`, `PerformanceLoadTest.js`, `MetricsSnapshot.js`, `ApiTelemetry.js`, `ActivityLog.js` |

**Consumes:**
- Read-only access to `Conversation`, `Alert`, `PromptConfig` collections

---

### 6. Alerting & Notifications Service (AlertAgent)

**Responsibility:** Alert rule evaluation, lifecycle management, notification delivery (email, Slack, webhook).

| Layer | Files |
|:---|:---|
| Services | `alertService.js`, `notificationService.js`, `emailService.js`, `securityLogger.js` |
| Routes | `alerts.js` |
| Models | `Alert.js` |

**Consumes:**
- `MetricsSnapshot` (read-only)

> Leaf service -- no downstream AgentX service dependencies.

---

### 7. Self-Healing & Repo Ops Service (OpsAgent)

**Responsibility:** Automated remediation, repo scanning, doc janitor, feature alignment, validation scanning.

| Layer | Files |
|:---|:---|
| Services | `selfHealingEngine.js`, `repoWatcherService.js`, `docJanitorService.js`, `featureAlignmentScanner.js`, `validationScanner.js`, `scannerConfidence.js`, `featureAlignmentPriority.js` |
| Routes | `self-healing.js`, `repoWatcher.js`, `docJanitor.js`, `features.js` |
| Models | `RepoScan.js`, `DocJanitorScan.js`, `RemediationAction.js`, `FeatureInventory.js`, `FeatureFlag.js`, `FeatureUsage.js` |

**Consumes:**
- Alerting -- `createAlert()` for incident escalation
- Model Management -- failover triggers
- Prompt & Config -- rollback operations

---

### 8. Automation & SpecialX Service (SpecialXAgent)

**Responsibility:** SpecialX task queue, automation runner, task handlers, n8n workflow integration.

| Layer | Files |
|:---|:---|
| Services | `automationRunnerService.js`, `specialxTaskHandlers.js`, `workflowValidator.js`, `workflowDeployer.js`, `n8nWebhook.js` |
| Routes | `specialx.js`, `workflowGenerator.js`, `n8n.js` |
| Models | `AutomationTask.js`, `AutomationRun.js`, `SpecialX.js` |

**Consumes:**
- Chat -- `handleChatRequest()` for LLM-powered task execution
- Model Management -- `routeRequest()` for model selection
- Ops -- `repoWatcher` for repository context

---

### 9. Workspace & Access Service (WorkspaceAgent)

**Responsibility:** Multi-tenancy, workspace CRUD, RBAC, invitations, auth, API keys, audit logging.

| Layer | Files |
|:---|:---|
| Services | `workspace.js` middleware, `workspaceAudit.js`, `auth.js`, `n8nAuth.js`, `rateLimiter.js`, `auditLogger.js` |
| Routes | `workspaces.js`, `invitations.js`, `workspace-audit.js`, `auth.js`, `api-keys.js`, `audit-logs.js` |
| Models | `Workspace.js`, `WorkspaceMember.js`, `WorkspaceInvitation.js`, `WorkspaceAuditLog.js`, `APIKey.js`, `AuditLog.js` |

**Consumes:**
- Alerting -- email delivery for workspace invitations

---

### 10. Prompt & Config Service (PromptAgent)

**Responsibility:** System prompts, A/B testing, templates, config variants, data import/export, backup, cache.

| Layer | Files |
|:---|:---|
| Services | `cacheService.js`, `dataapiClient.js`, `promptAnalysis.js` |
| Routes | `prompts.js`, `prompt-templates.js`, `configVariant.js`, `dataset.js`, `export.js`, `gallery.js`, `backup.js`, `cache.js` |
| Models | `PromptConfig.js`, `PromptTemplate.js`, `ConfigVariant.js` |

**Consumes:**
- `Conversation` (read-only)
- DataAPI (external proxy)

> Leaf service -- no downstream AgentX service dependencies.

---

## Shared Infrastructure

Components not owned by any single agent. Shared code is maintained collectively and must remain minimal.

| Component | Files | Purpose |
|:---|:---|:---|
| Express Shell | `src/app.js`, `server.js` | HTTP server bootstrap, route mounting |
| DB Connection | `config/db-mongodb.js`, `config/db.js` | Mongoose connection pool |
| Logger | `config/logger.js`, `src/utils/logger.js` | Structured logging (Winston) |
| HTTP Agent | `src/helpers/httpAgent.js` | Shared HTTP client with keep-alive |
| Response Handler | `src/helpers/ollamaResponseHandler.js` | LLM response stream parsing |
| Validators | `objectIdValidator.js`, `responseHelpers.js` | Common input validation |
| Init DB | `src/helpers/initDb.js` | Bootstrap indexes and defaults |
| Logging Middleware | `src/middleware/logging.js` | Request/response logging |
| Frontend Utils | `public/js/utils/*`, `public/js/components/*` | Shared UI primitives |

---

## Orchestration Layer

### Communication Model

All inter-service communication uses **direct function imports** within the single Node.js process. There is no HTTP/RPC overhead between services.

```javascript
// Example: Chat Service consuming Model Management
const { routeRequest } = require('../services/modelRouter');
const response = await routeRequest(model, messages, options);
```

### Event Bus

A shared `systemEvents` EventEmitter provides **loose coupling** for cross-cutting notifications. Events are fire-and-forget; producers do not depend on consumer behavior.

| Event | Producer | Typical Consumers |
|:---|:---|:---|
| `rag:ingestion:complete` | RAG | Chat, Analytics |
| `model:failover` | Model Mgmt | Ops, Analytics |
| `benchmark:batch:complete` | Benchmark | Analytics, Alerting |
| `alert:fired` | Alerting | Ops, Analytics |
| `specialx:task:complete` | SpecialX | Analytics |

### Dependency Rules

- **Leaf services** (RAG, Model Mgmt, Alerting, Prompt & Config) have zero downstream AgentX service dependencies.
- **Mid-tier services** (Benchmark, Analytics, Workspace) consume 1-2 leaf services.
- **High-coupling services** (Chat, SpecialX, Ops) consume multiple services but never form cycles.
- **Write cross-access is prohibited.** To mutate data owned by another service, call the owning service's exported function.
- **Read-only cross-access is permitted** for DB queries (e.g., Analytics reading Conversation counts).

---

## Dependency Graph

```
                    ┌───────────┐
                    │  Prompt   │
                    │ & Config  │ (leaf)
                    └─────┬─────┘
                          │
   ┌──────────┐    ┌──────┴──────┐    ┌───────────┐
   │   RAG    │◄───│    Chat     │───►│   Model   │
   │ (leaf)   │    │   Service   │    │   Mgmt    │ (leaf)
   └──────────┘    └──────┬──────┘    └─────┬─────┘
                          │                  │
                    ┌─────┴─────┐     ┌─────┴─────┐
                    │ SpecialX  │     │ Benchmark │
                    └───────────┘     └───────────┘

   ┌──────────┐    ┌───────────┐    ┌───────────┐
   │ Alerting │◄───│ Self-Heal │    │ Analytics │
   │ (leaf)   │    │ & Repo Ops│    │(read-only)│
   └──────────┘    └───────────┘    └───────────┘

   ┌───────────┐
   │ Workspace │ (middleware consumed by all routes)
   └───────────┘
```

### Dependency Matrix

| Service | Depends On |
|:---|:---|
| Chat | Model Mgmt, RAG, Prompt & Config |
| Model Mgmt | _(external only: Ollama, n8n)_ |
| RAG | _(external only: Ollama, Qdrant)_ |
| Benchmark | Model Mgmt |
| Analytics | _(read-only DB access)_ |
| Alerting | _(read-only DB access)_ |
| Self-Healing | Alerting, Model Mgmt, Prompt & Config |
| SpecialX | Chat, Model Mgmt, Ops |
| Workspace | Alerting |
| Prompt & Config | _(read-only DB access, external DataAPI proxy)_ |

---

## Agent Operating Rules

1. **Exclusive file ownership** -- no agent modifies another agent's files.
2. **Exclusive model ownership** -- no agent changes another agent's Mongoose schemas.
3. **Read-only cross-access** is permitted for DB queries.
4. **Write cross-access is prohibited** -- call the owning service's exported function.
5. **Each agent owns its test suite** under the service boundary.
6. **Each agent maintains** its section in `docs/services/<name>/`.

---

## Migration Strategy

Extraction proceeds from leaves inward, minimizing breaking changes at each phase.

### Phase 1 -- Leaf Services (zero downstream deps)

| Order | Service | Risk | Notes |
|:---|:---|:---|:---|
| 1 | Prompt & Config | Low | Small surface, few consumers |
| 2 | RAG | Low | Isolated vector store logic |
| 3 | Alerting | Low | Self-contained notification pipeline |

### Phase 2 -- Mid-Tier Services (1-2 deps)

| Order | Service | Risk | Notes |
|:---|:---|:---|:---|
| 4 | Model Management | Medium | Central to inference, many consumers |
| 5 | Workspace | Medium | Middleware woven through routes |
| 6 | Analytics | Low | Read-only, no write coupling |

### Phase 3 -- High-Coupling Services

| Order | Service | Risk | Notes |
|:---|:---|:---|:---|
| 7 | Benchmark | Medium | Deep Model Mgmt integration |
| 8 | Self-Healing | Medium | Cross-service remediation logic |
| 9 | SpecialX | High | Orchestrates Chat + Model + Ops |
| 10 | Chat | High | Largest surface area, most consumers |

### Steps Per Service

1. **Document** -- Write/update `docs/services/<name>/` with API contract and file manifest.
2. **Annotate** -- Add `@service <name>` header comment to every owned file.
3. **Test baseline** -- Ensure existing tests pass; add coverage for cross-service boundaries.
4. **Create facade** -- Export a clean public API object from a single entry point.
5. **Validate imports** -- Confirm all external consumers use the facade, not internal files.
6. **Run tests** -- Full regression to confirm no breakage.

---

## Related Documents

- [Backend Overview](backend-overview.md) -- Feature-level implementation summary
- [Architecture Reality Check](ARCHITECTURE_REALITY.md) -- SOA topology (AgentX + DataAPI + Qdrant)
- [Model Routing](MODEL_ROUTING.md) -- Smart routing and failover
- [RAG System](RAG_SYSTEM.md) -- Vector store and retrieval pipeline
- [Multi-Tenancy](MULTI_TENANCY.md) -- Workspace and RBAC design
- [Startup Sequence](STARTUP_SEQUENCE.md) -- Bootstrap order
- [Self-Healing Architecture](SELF_HEALING_ARCHITECTURE.md) -- Automated remediation
