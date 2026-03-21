# OpenClaw Platform — Architecture Reference

> **Purpose:** This document provides a complete architectural overview of the OpenClaw deployment for use by external agents performing ecosystem-level architectural review. It covers all subsystems, data flows, agent topology, infrastructure, and integration points.
>
> **Last updated:** 2026-03-20
> **Config root:** `/home/yb/.openclaw/`
> **AgentX production path:** `/home/yb/codes/AgentX/` (UGClawdX — 192.168.2.66:3080)

---

## 1. Executive Summary

OpenClaw is a **local-first, self-hosted AI personal assistant platform** that orchestrates multiple LLM-powered agents across a GPU cluster, a Telegram bot interface, a web-based AI operations platform (AgentX), and a project management dashboard (Mission Control). It is owned and operated by a single power-user ("Yanik") as a personal productivity and home-lab AI system.

### Ecosystem Plane Model

| Plane | System | Role |
|-------|--------|------|
| **Operator layer** | **OpenClaw** | Conversational gateway, agent dispatch, human-facing reports, cron orchestration, Telegram, approval routing |
| **Control plane** | **AgentX Platform** | AI-ops system-of-record: RAG, benchmarks, SpecialX tasks, cluster scheduling, host telemetry, analytics, dashboards |
| **Data plane** | **DataAPI** | Deterministic file scanning, metadata, exports, background ingestion substrate |

OpenClaw is the **operator shell and gateway** for the ecosystem. AgentX is the **primary AI-ops control plane and system-of-record** for maintenance, scheduling, telemetry, and bounded automation. OpenClaw can trigger, supervise, and report on AgentX workflows, but AgentX is not modeled as an OpenClaw SpecialX subagent. OpenClaw cron jobs are one upstream automation source; they are synced into AgentX's cluster schedule view every 15 minutes via `scripts/sync-openclaw-schedule.js`.

The system prioritizes:
- **Local inference first** — cloud APIs are fallback only
- **Multi-agent coordination** — 8 specialized agents with distinct roles, models, and tool policies
- **Autonomous operation** — 15+ recurring cron jobs for monitoring, reporting, maintenance, and development
- **Cost efficiency** — local Ollama GPU inference at $0/token, cloud only when quality demands it

---

## 2. System Topology

```
┌──────────────────────────────────────────────────────────────────┐
│                        User Interfaces                           │
│  ┌──────────┐   ┌─────────────────┐   ┌───────────────────────┐ │
│  │ Telegram  │   │ AgentX Web UI   │   │ Mission Control GUI   │ │
│  │  Bot DM   │   │ (port 3080)     │   │ (Next.js, port 3000)  │ │
│  └─────┬─────┘   └────────┬────────┘   └───────────┬───────────┘ │
└────────┼──────────────────┼─────────────────────────┼────────────┘
         │                  │                         │
         ▼                  ▼                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              OpenClaw Gateway (port 18789, loopback)             │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Agent   │ │ Session  │ │ Cron     │ │ Delivery Queue    │   │
│  │ Router  │ │ Manager  │ │ Scheduler│ │ (Telegram/etc)    │   │
│  └────┬────┘ └──────────┘ └──────────┘ └───────────────────┘   │
│       │       ┌───────────────────────────────────────────┐     │
│       │       │         Multi-Agent Orchestration          │     │
│       ▼       │  main · clawdx-coder · local-thinker      │     │
│               │  cloud-thinker · abliterated-thinker       │     │
│               │  roadmap-driver · strategist · terminal-ops│     │
│               └───────────────────────────────────────────┘     │
└───────────────────────────┬─────────────────────────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│  UGClawdX      │ │  UGBrutal      │ │  UGFrank       │
│  192.168.2.66  │ │  192.168.2.12  │ │  192.168.2.99  │
│  RTX 3090 24GB │ │  RTX 5070Ti    │ │  RTX 3080Ti    │
│  (gateway host)│ │  16GB          │ │  12GB          │
│  Ollama:11434  │ │  Ollama:11434  │ │  Ollama:11434  │
└────────────────┘ └────────────────┘ └────────────────┘
         │                  │                  │
         └──────────────────┼──────────────────┘
                            ▼
              ┌───────────────────────┐
              │ AgentX Platform       │
              │ (Express.js, port 3080│
              │  on UGClawdX)         │
              │ MongoDB · Qdrant      │
              │ RAG · Benchmarks      │
              │ Self-Healing Engine   │
              └───────────────────────┘
```

---

## 3. Core Components

### 3.1 OpenClaw Gateway

**Role:** Central orchestration daemon that manages agent lifecycles, routes messages, schedules cron jobs, and handles Telegram integration.

- **Port:** 18789 (loopback only)
- **Managed as:** systemd user service (`systemctl --user restart openclaw-gateway`)
- **Config:** `/home/yb/.openclaw/openclaw.json` (single JSON, ~925 lines)
- **Secrets:** `/home/yb/.openclaw/.env` (referenced via `${VAR}` interpolation in config)
- **Auth:** Token-based gateway auth (`GATEWAY_AUTH_TOKEN`)

**Key subsystems inside the gateway:**

| Subsystem | Description |
|-----------|-------------|
| Agent Router | Selects which agent handles a request based on agent ID, model chain, and subagent permissions |
| Session Manager | Per-channel-peer DM sessions with `session-archive/` for persistence |
| Cron Scheduler | `cron/jobs.json` — the source of truth for OpenClaw-owned recurring jobs |
| Delivery Queue | `delivery-queue/` — outbound message queue for Telegram and other channels |
| Device Pairing | `devices/paired.json` — paired operator devices (webchat, CLI) |
| Identity System | `identity/device-auth.json`, `identity/device.json` — device identity and auth |
| Exec Approvals | `exec-approvals.json` — runtime approval state for agent exec commands |
| Hooks | Internal hooks: `boot-md`, `command-logger`, `session-memory` |

**Gateway config structure (`openclaw.json`):**

```
openclaw.json
├── meta                    # Version tracking
├── auth.profiles           # Provider auth profiles (Anthropic, Ollama hosts, OpenAI, xAI)
├── models.providers        # Model provider definitions with baseUrl, models[], costs, context windows
├── agents.defaults         # Default model, workspace, memory search, context pruning, compaction
├── agents.list[]           # 8 agent definitions with model chains, subagent permissions, tool policies
├── tools                   # Tool profiles, media (audio transcription via Whisper)
├── messages                # TTS config (Edge), ack reaction scope
├── commands                # Native command handling
├── session                 # DM scope policy
├── hooks                   # Internal hook configuration
├── channels.telegram       # Telegram bot config (token, streaming, group policy)
├── gateway                 # Port, bind, auth, tailscale, HTTP endpoints, node deny-commands
├── skills                  # Installed skill config
└── plugins                 # Plugin registry (telegram)
```

### 3.2 AgentX Platform

**Role:** Full-stack AI operations platform — chat UI, RAG pipeline, benchmarking, analytics, model management, and automation task execution.

- **Repo:** [WindriderQc/AgentX](https://github.com/WindriderQc/AgentX) (v1.4.1)
- **Production location:** `/home/yb/codes/AgentX/` (on UGClawdX — the canonical production path)
- **Stack:** Express.js + MongoDB + Qdrant (vector store) + Ollama
- **Port:** 3080
- **Process manager:** PM2

**Architecture pattern:** Service-Oriented — Routes (validation) → Services (orchestration) → Models (Mongoose schemas) → MongoDB/Ollama.

#### 3.2.1 Route Layer (45 files)

API endpoints organized by domain. Key routes include:

| Route File | Domain |
|-----------|--------|
| `api.js` | Core API routing |
| `analytics.js` | Usage analytics & cost tracking |
| `benchmark/` | Multi-model benchmark system |
| `cluster-schedule.js` | GPU cluster scheduling (Gantt views) |
| `custom-models.js` | Custom model registration |
| `dashboard.js`, `dashboards.js` | Dashboard configuration |
| `host-monitor.js`, `host-test.js` | GPU host health monitoring |
| `model-registry.js` | Model registry CRUD |
| `models-unified.js` | Unified model listing |
| `ollama-hosts.js`, `ollama-vram.js` | Ollama host management, VRAM tracking |
| `rag.js` | RAG document ingestion, search, management |
| `roundtable.js` | Multi-model roundtable discussions |
| `self-healing.js` | Self-healing rule management |
| `specialx.js` | SpecialX automation task system |
| `tools.js` | Tool executor endpoints |
| `voice.js` | Voice/TTS integration |
| `workspaces.js` | Multi-tenant workspace management |

#### 3.2.2 Service Layer (60+ files)

Core business logic. Key services:

| Service | Purpose |
|---------|---------|
| `chatService.js` | Chat completion orchestration with model routing |
| `modelRouter.js` | Routes requests to appropriate Ollama host by model/task complexity |
| `ragStore.js` | RAG document store — semantic search, ingestion, citation tracking |
| `ragFileWatcher.js` | Watches `/mnt/datalake/RAG/` for new documents, auto-ingests |
| `ragCompression.js` | Contextual compression for RAG results |
| `embeddings.js` | Embedding generation via Ollama |
| `embeddingCache.js` | Embedding result caching |
| `vectorStore/` | Vector store abstraction (Qdrant / in-memory fallback) |
| `benchmarkService.js` (dir) | Multi-model benchmarking with batch execution |
| `conversationJudge.js` | LLM-as-judge for benchmark response quality |
| `decomposedJudge.js` | Multi-criteria decomposed judging |
| `deterministicScorer.js` | Rule-based deterministic scoring |
| `qualityScorer.js` | Quality scoring pipeline |
| `selfHealingEngine.js` | Automated remediation (rule eval → action execution) |
| `automationRunnerService.js` | SpecialX task runner (queue-driven, bounded execution) |
| `specialxTaskHandlers.js` | Task type handlers for SpecialX |
| `clusterScheduleService.js` | GPU cluster schedule management |
| `clusterLiveService.js` | Real-time cluster status |
| `hostMonitorService.js` | Stale host detection |
| `ollamaEnrichmentService.js` | Polls Ollama hosts for AI ops metadata |
| `ollamaVramService.js` | VRAM utilization tracking |
| `hardwareProfileService.js` | GPU hardware profiling with VRAM efficiency metrics |
| `contextProbe/` | Binary search for maximum 100% GPU context window |
| `usageAnalyticsService.js` | Usage patterns, token costs, trend analysis |
| `costCalculator.js` | Token cost calculation |
| `modelSync/` | Syncs model registry from Ollama hosts at startup |
| `modelAggregator.js` | Aggregates model data across hosts |
| `customModelService.js` | Custom model lifecycle (register, deploy, A/B test) |
| `docJanitorService.js` | Documentation quality maintenance |
| `repoWatcherService.js` | Git repository change monitoring |
| `roundtable/` | Multi-model roundtable orchestration |
| `toolService.js`, `toolExecutor.js` | Tool definition and execution |
| `webSearch.js` | Web search via SearXNG |
| `voiceService.js` | Voice/audio processing |
| `emailService.js` | Email notifications |
| `notificationService.js` | Alert notification routing |
| `alertService.js` | Alert management |
| `n8nLLMProvider.js` | n8n workflow LLM provider |

#### 3.2.3 Data Layer (48 Mongoose Models)

MongoDB schemas covering all platform data:

| Category | Models |
|----------|--------|
| **Chat** | `Conversation`, `UserProfile`, `PromptConfig`, `PromptTemplate` |
| **RAG** | `RagManifest`, `EmbeddingCacheStats` |
| **Benchmarks** | `BenchmarkBatch`, `BenchmarkPrompt`, `BenchmarkResult`, `JudgeGroundTruth` |
| **Models** | `ModelRegistry`, `CustomModel`, `ModelPricingConfig`, `ConfigVariant` |
| **Infrastructure** | `Host`, `HostMetricsSnapshot`, `HostVramOverride`, `HardwareProfile` |
| **Automation** | `AutomationTask`, `AutomationRun`, `SpecialX` |
| **Self-Healing** | `SelfHealingExecution`, `SelfHealingApproval`, `RemediationAction` |
| **Analytics** | `ActivityLog`, `MetricsSnapshot`, `PerformanceBaseline`, `PerformanceSnapshot`, `PerformanceLoadTest`, `ApiTelemetry` |
| **Multi-Tenancy** | `Workspace`, `WorkspaceMember`, `WorkspaceInvitation`, `WorkspaceAuditLog` |
| **Features** | `FeatureFlag`, `FeatureInventory`, `FeatureUsage` |
| **Other** | `Alert`, `AuditLog`, `APIKey`, `CustomDashboard`, `DocJanitorScan`, `Feedback`, `N8nLLMSource`, `Roundtable`, `RepoScan` |

#### 3.2.4 Frontend (38 pages)

Bootstrap/Chart.js HTML/JS pages served as static assets:

| Page | Purpose |
|------|---------|
| `index.html` | Chat interface with model selection and RAG toggle |
| `analytics.html` | Usage analytics dashboard |
| `benchmark.html` | Benchmark execution and comparison |
| `leaderboard.html` | Model leaderboard with human review queue and judge calibration |
| `cluster.html` | GPU cluster Gantt schedule (by-task/by-host views) |
| `dashboard.html` | System dashboard |
| `hosts.html` | GPU host management |
| `hardware-matrix.html` | Hardware capability matrix |
| `models.html` | Consolidated model catalog (categories, benchmarks, capabilities, detail drawer) |
| `rag.html` | RAG document management |
| `self-healing.html` | Self-healing rule management |
| `specialx.html` | SpecialX automation tasks |
| `roundtable.html` | Multi-model roundtable |
| `alerts.html`, `alert-analytics.html` | Alert system |
| `performance.html` | Performance metrics |
| `cost-tracking.html` | Cost analytics |
| `prompts.html` | Prompt template management |
| `docjanitor.html` | Documentation janitor |
| `repoWatcher.html` | Repository change monitor |
| `workspace-settings.html`, `workspace-audit.html` | Workspace management |
| `features-*.html` | Feature flag system (admin, adoption, inventory, telemetry) |
| `profile.html`, `login.html` | User auth |
| `courthouse.html`, `compare-insights.html`, `config-optimizer.html`, `results-explorer.html` | Advanced analytics |
| `gallery.html`, `imageGen.html` | Image generation |
| `backup.html` | Backup management |

#### 3.2.5 Middleware

| Middleware | Purpose |
|-----------|---------|
| `auth.js` | User authentication (session-based via MongoDB store) |
| `workspace.js` | Workspace context injection and RBAC |
| `workspaceAudit.js` | Audit logging for workspace operations |
| `performanceTracker.js` | Request performance metrics |
| `rateLimiter.js` | Rate limiting |
| `auditLogger.js` | General audit logging |
| `n8nAuth.js` | n8n webhook authentication |
| `logging.js` | Request/error logging (Winston) |

#### 3.2.6 Startup Services

On boot, AgentX initializes (in order):
1. MongoDB connection + default data seeding
2. Model registry sync from all Ollama hosts
3. Stale benchmark batch cleanup
4. Ollama health check
5. Qdrant health check (if configured)
6. Self-healing rules loading + scheduler start
7. RAG file watcher on `/mnt/datalake/RAG/`
8. SpecialX automation runner start
9. Host monitor service (stale host detection)
10. Ollama enrichment service (periodic polling)

### 3.3 Mission Control Dashboard

**Role:** Next.js-based GUI for managing OpenClaw agents, models, memory, and skills.

- **Package:** `@openclaw/dashboard` v0.4.0
- **Location:** `/home/yb/.openclaw/openclaw-mission-control/`
- **Stack:** Next.js 16 + React 19 + TypeScript + Tailwind + Radix UI + Recharts
- **Port:** 3000
- **Repo:** [robsannaa/openclaw-mission-control](https://github.com/robsannaa/openclaw-mission-control)

Key dependencies indicate: Monaco editor (code/config editing), XTerm.js (embedded terminal), XYFlow/React (agent graph visualization), Recharts (analytics charts), marked/react-markdown (markdown rendering).

### 3.4 SearXNG (Web Search)

- **Instance:** `http://192.168.2.199:8088/`
- **Engines:** Google, DuckDuckGo, Startpage, Brave (aggregated)
- **Categories:** general, images, news, science, IT, videos, music, files
- **Consumed by:** OpenClaw agents via skill scripts and AgentX `webSearch.js` service

### 3.5 Leantime (Project Management)

- **Instance:** `https://leantime.specialblend.icu`
- **Integration:** CLI script `~/.openclaw/workspace/bin/leantime.sh`, bidirectional sync with ROADMAP.md
- **Consumed by:** `roadmap-driver` agent for task sync, `main` agent for daily status reports

### 3.6 n8n (Workflow Automation)

- **Integration:** AgentX provides an n8n LLM provider (`n8nLLMProvider.js`) and webhook auth middleware
- **Use:** Document ingestion pipelines, prompt optimization, orchestration workflows
- **Templates:** `/home/yb/.openclaw/workspace-clawdx-coder/AgentX/n8n_workflows/`

### 3.7 DataAPI

- **Role:** Companion headless tool server for file scanning/search/exports
- **Stack:** MongoDB-based ([WindriderQc/DataAPI](https://github.com/WindriderQc/DataAPI))
- **Integration:** Optional — AgentX calls via `dataapiClient.js` service

---

## 4. Agent Architecture

OpenClaw runs **8 agents**, each with a dedicated model chain (primary + fallbacks), workspace, tool policy, and identity.

### 4.1 Agent Roster

| Agent ID | Name | Primary Model | Role | Workspace |
|----------|------|--------------|------|-----------|
| `main` | (Nestor) | `qwen3-coder:30b` @ UGClawdX | Orchestrator, reports, Telegram handler, cron owner | `/workspace/` |
| `clawdx-coder` | ClawdX-Coder | `qwen3-coder:30b` @ UGClawdX | Code generation, AgentX development, benchmarks | `/workspace-clawdx-coder/` |
| `local-thinker` | Local Thinker | `deepseek-r1:14b` @ UGBrutal | Reasoning, analysis (local, $0) | `/workspace-local-thinker/` |
| `abliterated-thinker` | Abliterated Thinker | `qwen3-abliterated-128k:30b` @ UGClawdX | Uncensored reasoning for edge cases | `/workspace-local-thinker/` |
| `cloud-thinker` | Cloud Thinker | `gpt-5.3-codex` (OpenAI) | Cloud escalation for quality-critical tasks | `/workspace-cloud-thinker/` |
| `roadmap-driver` | Roadmap Driver | `qwen3-coder:30b` @ UGClawdX | Autonomous dev cycles, Leantime sync | `/workspace-clawdx-coder/` |
| `strategist` | Strategist | `grok-4` (xAI) | Strategic planning, architecture decisions | `/workspace-strategist/` |
| `terminal-ops` | Terminal Ops | `qwen3-coder:30b` @ UGClawdX | Privileged host admin (90+ allowlisted binaries) | `/workspace/` |

### 4.2 Agent Delegation Graph

```
main (orchestrator)
├── clawdx-coder          — code/debugging ($0)
├── local-thinker         — reasoning ($0)
│   ├── clawdx-coder
│   └── roadmap-driver
├── abliterated-thinker   — uncensored reasoning
│   ├── clawdx-coder
│   ├── roadmap-driver
│   └── terminal-ops
├── cloud-thinker         — cloud escalation ($$)
│   ├── clawdx-coder
│   ├── roadmap-driver
│   └── local-thinker
├── roadmap-driver        — autonomous dev
├── strategist            — strategic planning
└── terminal-ops          — privileged host ops
```

### 4.3 Model Chain Design

Each agent has a primary model and ordered fallback chain. If the primary model is unavailable (host down, model not loaded), the gateway tries fallbacks in order. All local models cost $0. Cloud models (OpenAI, xAI) are used only by `cloud-thinker` and `strategist`.

### 4.4 Tool Policies

- **Default agents:** Messaging tools only (chat, file read/write, memory)
- **`main` + `terminal-ops`:** Additionally have `exec` tool with security allowlist
  - `main`: 37 safe binaries, 30s timeout
  - `terminal-ops`: 90+ binaries (full sysadmin), 300s timeout
- **`clawdx-coder` + `roadmap-driver`:** `coding` tool profile (file ops, git, etc.)

### 4.5 Workspace Files

Each agent workspace contains identity and operational files:

| File | Purpose |
|------|---------|
| `SOUL.md` | Personality, values, behavioral rules |
| `IDENTITY.md` | Name, emoji, role description |
| `USER.md` | User profile (Yanik) |
| `AGENTS.md` | Session bootstrap instructions, safety rules, tool usage |
| `TOOLS.md` | Infrastructure reference (hosts, commands, services) |
| `MEMORY.md` | Curated long-term memory |
| `HEARTBEAT.md` | Periodic check definitions |
| `MASTER_BRAIN_LOOP.md` | Recurring job classification and execution rules |
| `RECURRING_REPORTS.md` | Canonical recurring job inventory |
| `WORKFLOW_AUTO.md` | Automation behavioral constraints |
| `TERMINAL_OPS.md` | Privileged agent runbook |
| `memory/YYYY-MM-DD.md` | Daily raw memory logs |

---

## 5. GPU Cluster & Model Routing

### 5.1 GPU Hosts

| Host | IP | GPU | VRAM | Role |
|------|-----|-----|------|------|
| UGClawdX | 192.168.2.66 | RTX 3090 | 24 GB | Primary inference, gateway host |
| UGBrutal | 192.168.2.12 | RTX 5070 Ti | 16 GB | Secondary inference, coding models |
| UGFrank | 192.168.2.99 | RTX 3080 Ti | 12 GB | Fast inference, embeddings |

### 5.2 Model Inventory

| Provider | Model | Context | Host | Use |
|----------|-------|---------|------|-----|
| ugclawdx-ollama | qwen3-coder:30b | 49K | UGClawdX | Primary coding/chat |
| ugclawdx-ollama | qwen3.5:27b | 24K | UGClawdX | General reasoning |
| ugclawdx-ollama | qwen3.5:9b | 131K | UGClawdX | Long-context tasks |
| ugclawdx-ollama | qwen32b:perf | 8K | UGClawdX | Heavy inference (hardcapped) |
| ugclawdx-ollama | qwen3-abliterated:30b | 131K | UGClawdX | Uncensored reasoning |
| ugbrutal-ollama | qwen2.5:14b-instruct-q5_K_M | 32K | UGBrutal | Default local model |
| ugbrutal-ollama | qwen3:14b | 32K | UGBrutal | General |
| ugbrutal-ollama | deepseek-r1:14b | 32K | UGBrutal | Reasoning |
| ugbrutal-ollama | deepcoder:14b | 32K | UGBrutal | Code |
| ugbrutal-ollama | mistral-small3.1-24b | 32K | UGBrutal | Alternative |
| ugbrutal-ollama | openclaw-oss-20b | 32K | UGBrutal | Custom fine-tune |
| ugbrutal-ollama | qwen3-embedding:8b | 8K | UGBrutal | Embeddings |
| ugfrank-ollama | qwen3:8b | 32K | UGFrank | Fast fallback |
| ugfrank-ollama | nomic-embed-text | 8K | UGFrank | Embedding default |
| openai | gpt-5.3-codex | 192K | Cloud | Cloud escalation |
| xai | grok-4 | 131K | Cloud | Strategic reasoning |
| xai | grok-3 | 131K | Cloud | Strategic fallback |

### 5.3 VRAM Rules

- **100% GPU residency is mandatory** — any CPU spill destroys throughput
- Context window sizes in config are empirically verified, not theoretical
- Validation method: `ollama ps` + `nvidia-smi` after loading

### 5.4 Model Routing Flow

```
Request → Gateway Agent Router
          → Resolve agent's primary model
          → Check host health (AgentX modelRouter)
          → If healthy → route to host
          → If unhealthy → try fallback[0], fallback[1], ...
          → Cloud fallback requires: recorded local failure + explicit policy
```

### 5.5 Model Aliases

Models are aliased in the gateway config for easy reference in prompts and cron jobs:

`local`, `fast`, `big`, `main`, `small`, `coder`, `coder30`, `think`, `oss`, `mistral`, `sonnet`, `opus`, `codex`, `grok`, `grok3`, `ablit`

---

## 6. Cron & Automation System

### 6.1 Source of Truth

`/home/yb/.openclaw/cron/jobs.json` — single JSON file with all recurring jobs.

### 6.2 Job Classification

Every job is classified as one of:

| Category | Behavior |
|----------|----------|
| **User-Facing Report** | Delivers to Telegram, always |
| **Internal Report** | Writes durable artifact, silent at execution |
| **Watchdog** | Monitors thresholds, alerts only on problems |
| **Maintenance** | Cleans, syncs, compacts — fully silent |

Silent jobs are rolled up in the `morning-briefing` summary.

### 6.3 Active Job Inventory

| Job | Owner | Schedule | Type |
|-----|-------|----------|------|
| `morning-briefing` | main | Weekdays 08:00 ET | User report |
| `agentx:daily-analytics` | main | Daily 18:00 ET | User report |
| `agentx:weekly-benchmark` | clawdx-coder | Sat 14:00 ET | User report |
| `self-improve:weekly-report` | main | Mon 09:00 ET | User report |
| `leantime:daily-status` | main | Daily 08:30 ET | User report |
| `roadmap-driver:bisync` | roadmap-driver | Weekdays 07:00 ET | User report |
| `healthcheck:security-audit` | main | Mon 06:00 ET | Internal report |
| `agentx:rag-maintenance` | clawdx-coder | Wed 03:00 ET | Internal report |
| `roadmap-driver:work-cycle` | roadmap-driver | Weekdays 02:00 ET | Internal report |
| `infra-health-check` | main | Every 2 hours | Watchdog |
| `self-improve:model-quality-watch` | thinker | Daily 20:00 ET | Watchdog |
| `memory-maintenance` | main | Sun/Wed 22:00 ET | Maintenance |
| `session-cleanup` | main | Sun 04:00 ET | Maintenance |

### 6.4 Job Schema

Each job in `jobs.json` carries:

```json
{
  "id": "uuid",
  "agentId": "main",
  "ownerAgentId": "main",
  "name": "job-name",
  "description": "...",
  "enabled": true,
  "schedule": { "kind": "cron|every", "expr": "...", "tz": "..." },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": { "kind": "agentTurn", "message": "...", "model": "local", "thinking": "off" },
  "delivery": { "mode": "announce|none", "channel": "telegram|last" },
  "state": { "nextRunAtMs": ..., "lastStatus": "ok", "consecutiveErrors": 0 },
  "category": "watchdog|user-report|internal-report|maintenance",
  "alertPolicy": "alert-on-problem|always-deliver|silent",
  "visibilityMode": "direct-report|included-in-summary",
  "summaryJob": "morning-briefing"
}
```

---

## 7. Skills System

Skills are modular tool packages installed under `/home/yb/.openclaw/skills/`. Each provides shell scripts and a `SKILL.md` manifest.

| Skill | Purpose |
|-------|---------|
| `agentx-api` | Full AgentX platform API access (health, models, analytics, RAG, benchmarks, chat) |
| `web-search` | SearXNG web search aggregation |
| `health-status` | Infrastructure health checks |
| `leantime-api` | Leantime project management API |
| `roadmap-driver` | ROADMAP.md ↔ Leantime bidirectional sync |
| `tg-analytics` | Telegram analytics command |
| `tg-bench` | Telegram benchmark command |
| `tg-health` | Telegram health command |
| `tg-improve` | Telegram self-improvement command |
| `tg-leantime` | Telegram Leantime command |
| `tg-models` | Telegram model listing command |
| `tg-search` | Telegram web search command |
| `tg-status` | Telegram status command |

---

## 8. Data Stores & Persistence

| Store | Technology | Location / URI | Data |
|-------|-----------|----------------|------|
| Gateway config | JSON files | `/home/yb/.openclaw/` | Agent config, cron, sessions, devices, identity |
| Agent memory | Markdown files | `workspace/memory/`, `memory/` | Daily logs, curated memory, audit logs |
| RAG documents | Filesystem + vector index | `/mnt/datalake/RAG/Docs/` | Knowledge base documents |
| AgentX primary DB | MongoDB | `mongodb://localhost:27017/agentx` | 48 collections (all platform data) |
| Vector store | Qdrant (or in-memory fallback) | `http://localhost:6333` | RAG embeddings, semantic search index |
| Session store | MongoDB | Same DB | Express sessions |
| Cron state | JSON | `cron/jobs.json` + `cron/runs/` | Job definitions + execution history |
| Usage ledger | SQLite | Mission Control local DB | Token counts, cost calculations, provider billing snapshots |
| Delivery queue | Filesystem | `delivery-queue/` | Pending outbound messages |
| Telegram state | Filesystem | `telegram/` | Bot command hashes, update offsets |

---

## 9. Communication Channels

### 9.1 Telegram Bot

- **Bot:** `@sbqc_bot`
- **Policy:** DM pairing, allowlist for groups
- **Streaming:** Partial (progressive message updates)
- **TTS:** Edge TTS (`en-US-GuyNeural`, auto for inbound)
- **Audio transcription:** Whisper via local API at `http://192.168.2.99:8000` (Systran/faster-whisper-large-v3)

### 9.2 Paired Devices

- Win32 webchat (operator)
- Linux CLI (operator)

---

## 10. Security Model

| Layer | Mechanism |
|-------|-----------|
| Gateway auth | Token-based (`GATEWAY_AUTH_TOKEN`) |
| Gateway bind | Loopback only (127.0.0.1) |
| AgentX web | Session-based auth (bcrypt passwords, MongoDB sessions) |
| AgentX API | Rate limiting, helmet, mongo sanitization, CORS |
| Agent exec | Per-agent allowlists (binaries explicitly enumerated) |
| Credentials | `/credentials/` directory (file-based, not in config) |
| Secrets | `.env` files with `${VAR}` interpolation |
| Tailscale | Configured but currently `mode: off` |
| Node deny-commands | Blocked: camera, screen record, calendar/contacts/reminders add |

**Philosophy:** Private controlled environment. Working features first, security hardening later. No enterprise auth layers unless explicitly requested.

---

## 11. Self-Healing System

AgentX includes a self-healing engine that:

1. Loads rules from `config/self-healing-rules.json`
2. Evaluates rules on a configurable interval (default: 5 minutes)
3. Acquires a distributed lock before evaluation (multi-worker safe)
4. Executes remediation actions when triggers fire
5. Supports approval workflows for destructive actions
6. Persists execution history in MongoDB (`SelfHealingExecution`, `SelfHealingApproval`, `RemediationAction`)

---

## 12. SpecialX Automation System

SpecialX is AgentX's queue-driven task automation framework:

1. **Trigger** (manual/API/n8n/CI/schedule) creates an `AutomationTask`
2. **Runner** (`automationRunnerService.js`) leases the task with heartbeat + timeout
3. **Resolution** — resolves SpecialX profile (persona + tool policy + model policy)
4. **Execution** — task runs through AgentX services (chatService/modelRouter/tools)
5. **Persistence** — result stored as `AutomationRun` with metrics and summary
6. **Completion** — task marked completed/failed/dead-letter

Safety rules: bounded retries with backoff, lease ownership, heartbeat refresh, dead-letter after max attempts, deterministic output preference.

---

## 13. RAG Pipeline

```
/mnt/datalake/RAG/Docs/  ──(chokidar watcher)──▶  ragFileWatcher
                                                       │
                                                       ▼
                                              Embed (nomic-embed-text)
                                                       │
                                                       ▼
                                              Qdrant vector store
                                                       │
                                           ┌───────────┴───────────┐
                                           ▼                       ▼
                                    Semantic search          Hybrid search
                                           │                       │
                                           └───────────┬───────────┘
                                                       ▼
                                              ragCompression
                                                       │
                                                       ▼
                                              Chat context injection
```

- **642+ documents** indexed
- **Embedding models:** nomic-embed-text (UGFrank), qwen3-embedding:8b (UGBrutal)
- **Vector store:** Qdrant (with in-memory fallback)
- **Features:** Citation tracking, contextual compression, hybrid search, auto-ingestion

---

## 14. Benchmark & Leaderboard System

- **Batch execution:** Run standard prompts against multiple models in parallel
- **Judging:** LLM-as-judge (`conversationJudge.js`) + decomposed multi-criteria (`decomposedJudge.js`) + deterministic rules (`deterministicScorer.js`)
- **Human review:** `POST /results/:id/human-review` for calibration
- **Calibration:** `GET /api/benchmark/judge-calibration` compares judge accuracy vs humans
- **Leaderboard:** Frontend with sorting, filtering, and judge calibration panel
- **Weekly report:** Automated via cron, output to `/mnt/datalake/RAG/Docs/benchmark-weekly.md`

---

## 15. Integration Map

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  Telegram    │◄───▶│  OpenClaw    │◄───▶│  AgentX      │
│  Bot API     │     │  Gateway     │     │  Platform    │
└─────────────┘     └──────┬──────┘     └──────┬───────┘
                           │                    │
                    ┌──────┴──────┐      ┌──────┴───────┐
                    │             │      │              │
               ┌────▼────┐  ┌────▼───┐  │  ┌──────────┐│
               │ Ollama  │  │ Ollama ││  │  │ MongoDB  ││
               │ Cluster │  │ Cluster││  │  │ Qdrant   ││
               │ (3 GPUs)│  │        ││  │  │ Redis    ││
               └─────────┘  └────────┘│  │  └──────────┘│
                                      │  │              │
                    ┌─────────────────┘  │              │
                    │                    │              │
               ┌────▼────┐         ┌────▼────┐    ┌────▼────┐
               │ SearXNG │         │ Leantime│    │  n8n    │
               │ Search  │         │  PM     │    │ Workflow│
               └─────────┘         └─────────┘    └─────────┘
                                        │
                                   ┌────▼────┐
                                   │ DataAPI │
                                   │ MongoDB │
                                   └─────────┘
```

### External API Dependencies

| Provider | Models | Use Case | Cost |
|----------|--------|----------|------|
| Anthropic | claude-sonnet-4-6, claude-opus-4-6 | Available but not primary | $$$ |
| OpenAI | gpt-5.3-codex | Cloud Thinker primary | $0 (codex tier) |
| xAI | grok-4, grok-3 | Strategist primary | $$ |
| Ollama (3 hosts) | 15+ models | All local inference | $0 |

---

## 16. Operational Patterns

### 16.1 Context Pruning

Gateway manages LLM context with:
- **Mode:** `cache-ttl` (45 minute TTL)
- **Keep last:** 8 assistant messages
- **Soft trim:** at 75% context utilization
- **Hard clear:** at 90% context utilization
- **Compaction mode:** `safeguard`

### 16.2 Memory Architecture

```
Session memory (ephemeral)
    │
    ▼
Daily notes: workspace/memory/YYYY-MM-DD.md
    │
    ▼ (memory-maintenance cron)
Curated memory: workspace/MEMORY.md
    │
    ▼ (cross-agent RAG)
Shared docs: /mnt/datalake/RAG/Docs/
```

### 16.3 Agent Memory Search

- **Provider:** Ollama (nomic-embed-text v1.5 @ UGFrank)
- **Paths searched:** Agent workspace + `/mnt/datalake/RAG/Docs/`
- **Fallback:** none (disabled if embedding service unavailable)

### 16.4 Audio Pipeline

```
Voice message (Telegram)
    → Whisper API (Systran/faster-whisper-large-v3 @ 192.168.2.99:8000)
    → Text transcription
    → Agent processing
    → Response
    → Edge TTS (en-US-GuyNeural)
    → Audio message back
```

---

## 17. File System Layout

```
/home/yb/.openclaw/
├── openclaw.json                 # Master config (agents, models, providers, gateway)
├── .env                          # Secrets (API keys, tokens)
├── exec-approvals.json           # Runtime exec approval state
├── update-check.json             # Version update tracking
│
├── agents/                       # Agent session stores
│   ├── main/
│   ├── clawdx-coder/
│   ├── cloud-thinker/
│   ├── local-thinker/
│   ├── roadmap-driver/
│   ├── strategist/
│   └── terminal-ops/
│
├── workspace/                    # Main agent workspace (git repo)
│   ├── SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md
│   ├── MASTER_BRAIN_LOOP.md, RECURRING_REPORTS.md
│   ├── HEARTBEAT.md, WORKFLOW_AUTO.md, TERMINAL_OPS.md
│   ├── MEMORY.md, TASKS.md
│   ├── kanban.json
│   ├── bin/                      # Utility scripts
│   ├── memory/                   # Daily memory logs
│   ├── reference/                # Reference docs
│   └── skills/                   # Workspace-level skills
│
├── workspace-clawdx-coder/       # ClawdX-Coder workspace
│   ├── SOUL.md, IDENTITY.md, TOOLS.md, AGENTS.md
│   └── memory/
│
# AgentX production location (separate from openclaw workspace)
# /home/yb/codes/AgentX/         # ← Full AgentX platform (git repo, production)
│   ├── server.js                 # Express entry point
│       ├── src/app.js            # Express app setup
│       ├── src/services/ (60+)   # Business logic
│       ├── src/middleware/ (8)    # Auth, workspace, performance
│       ├── src/helpers/ (10)     # Pure utilities
│       ├── routes/ (45)          # API endpoints
│       ├── models/ (48)          # Mongoose schemas
│       ├── config/               # DB, logger, self-healing rules
│       ├── public/ (38 pages)    # Frontend
│       ├── scripts/              # Seeding, backups, migrations
│       ├── tests/                # Jest, Playwright, Artillery
│       ├── docs/                 # Full documentation suite
│       ├── personas/             # Chat persona configs
│       └── tools/                # Tool definitions
│
├── workspace-local-thinker/      # Local/Abliterated Thinker workspace
├── workspace-cloud-thinker/      # Cloud Thinker workspace
├── workspace-strategist/         # Strategist workspace
│
├── openclaw-mission-control/     # Next.js dashboard (git repo)
│
├── skills/                       # Installed skill packages (13)
│   ├── agentx-api/
│   ├── web-search/
│   ├── health-status/
│   ├── leantime-api/
│   ├── roadmap-driver/
│   └── tg-*/                     # Telegram command skills
│
├── cron/
│   ├── jobs.json                 # OpenClaw recurring job definitions (source of truth)
│   └── runs/                     # Job execution history
│
├── session-archive/              # Archived agent sessions
├── delivery-queue/               # Outbound message queue
├── telegram/                     # Telegram bot state
├── devices/                      # Paired device registry
├── identity/                     # Device identity and auth
├── credentials/                  # Service credentials
├── memory/                       # Root-level memory artifacts
├── media/                        # Media files
├── logs/                         # Gateway logs
├── canvas/                       # Canvas data
├── completions/                  # Completion data
├── subagents/                    # Subagent data
├── config-archive/               # Config backups
├── ui/                           # UI assets
└── mission-control/              # Mission control data
```

---

## 18. Key Architectural Decisions

1. **JSON-file gateway config over database** — Single `openclaw.json` is the source of truth for all agent/model/provider configuration. Enables version control and manual editing.

2. **Multi-agent with explicit model chains** — Each agent has a primary model and ordered fallback list. No magic routing — the chain is explicit in config.

3. **Local-first inference** — All default agents use Ollama models at $0/token. Cloud (OpenAI, xAI, Anthropic) is only used by explicitly cloud-designated agents.

4. **Cron as source of truth for OpenClaw automation** — OpenClaw recurring jobs are defined in `jobs.json` with rich metadata (category, alert policy, visibility mode, summary job). AgentX ingests them as one schedule source, not as the global owner of all automation state.

5. **Markdown-file memory** — Agent memory uses plain markdown files, not a database. Daily logs are distilled into curated summaries. Cross-agent knowledge goes to the shared RAG folder.

6. **Service-oriented AgentX** — Clean separation of routes/services/models. 48 Mongoose models, 60+ services, 45 route files. File size limits enforced by convention.

7. **Self-healing automation** — AgentX can detect and remediate issues autonomously based on configurable rules, with approval workflows for destructive actions.

8. **SpecialX queue-driven tasks** — All automation is finite and queue-driven. No infinite autonomous loops. Tasks have leases, heartbeats, timeouts, and dead-letter states.

9. **Exec security via allowlists** — No blanket shell access. Each agent has an explicit list of allowed binaries. `terminal-ops` has the broadest list (90+) but still uses allowlists, not unrestricted access.

10. **Shared RAG knowledge base** — `/mnt/datalake/RAG/Docs/` is the cross-agent shared knowledge surface, auto-indexed by the RAG file watcher.

---

## 19. Known Constraints & Technical Debt

- **No horizontal scaling** — Single-node gateway, single MongoDB instance, single Qdrant
- **Tailscale integration disabled** — Configured but `mode: off`
- **Inline scripts in frontend** — CSP has `unsafe-inline` TODO markers
- **No container orchestration** — Services run via PM2/systemd, not Kubernetes
- **VRAM-bound model loading** — Only one large model per GPU at a time (no model multiplexing)
- **Session memory is file-based** — No transactional guarantees across agent sessions
- **Single-operator system** — Multi-tenancy exists in AgentX but the gateway is single-user

---

## 20. Glossary

| Term | Definition |
|------|-----------|
| **OpenClaw** | The gateway/runtime platform that orchestrates agents and channels |
| **AgentX** | The AI operations web platform (chat, RAG, benchmarks, analytics) |
| **Mission Control** | Next.js dashboard GUI for OpenClaw management |
| **SpecialX** | Specialist task agents managed by AgentX (queue-driven) |
| **Persona** | Behavior/prompt profile only (not an autonomous runtime) |
| **Run** | One bounded execution of one SpecialX on one task |
| **SBQC** | The broader ecosystem brand (SpecialBlend QC) |
| **DataAPI** | Companion headless MongoDB tool server |
| **Nestor** | The main agent's identity/persona name |
