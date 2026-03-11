# SpecialX — Bounded Automation Agents

**Status:** Production-ready
**Last Updated:** 2026-03-10

---

## Overview

SpecialX is AgentX's queue-driven, bounded automation system. It provides a runtime for **specialist task agents** — autonomous workers that execute discrete, time-bounded jobs using local LLMs, scanners, and data services.

Unlike conversational agents (chat, roundtable), SpecialX agents are **non-interactive**. They pick up queued tasks, execute them within a lease window, persist structured results with artifacts, and stop. No infinite loops, no open-ended chat — every run is bounded and auditable.

### Core Concepts

| Term | Definition |
|------|------------|
| **SpecialX Profile** | A named agent configuration: persona, tool policy, model policy, assigned task types |
| **AutomationTask** | A work queue item bound to a SpecialX profile — status-tracked from `queued` to `completed` or `dead_letter` |
| **AutomationRun** | A single execution attempt of a task — stores result, artifacts, metrics, and timing |
| **Runner** | The singleton worker service that polls the queue, claims tasks via lease, and dispatches execution |

### Design Principles

1. **Queue-driven** — Tasks are enqueued via API or scheduler; never spawned ad-hoc
2. **Bounded execution** — Every task has a lease timeout (default 45s); overruns are reclaimed
3. **Local-first** — All profiles default to local Ollama inference; cloud fallback requires explicit opt-in
4. **Idempotent** — Tasks can declare an `idempotencyKey` to prevent duplicate execution
5. **Auditable** — Every run persists its result, artifacts, metrics, and execution metadata

---

## Architecture

### Execution Flow

```
1. Trigger (API / Scheduler / n8n / UI)
   ↓
2. POST /api/specialx/tasks → AutomationTask.create({ status: 'queued' })
   ↓
3. AutomationRunnerService.tick() (polls every 5s)
   → AutomationTask.claimNext(workerId, leaseMs)
   → Atomic update: status='leased', lease.owner set, lease.expiresAt set
   ↓
4. Resolve SpecialX profile → persona + tool policy + model policy
   ↓
5. Create AutomationRun({ status: 'running' })
   → Start heartbeat timer (refreshes lease every 5s)
   ↓
6. specialxTaskHandlers.runTaskByType(task, profile, queueMetrics)
   → Dispatches to type-specific handler
   → Returns { summary, output, artifacts, metrics, execution }
   ↓
7. Persist results:
   → AutomationRun: status='completed', summary, output, artifacts, metrics
   → AutomationTask: status='completed', resultRunId, completedAt
   → SpecialX profile: stats updated (totalRuns, successRuns, avgDurationMs)
   ↓
8. On failure:
   → task.attempts += 1
   → If attempts < maxAttempts → re-queue with backoff (15s × attempt)
   → Else → status='dead_letter' (terminal, requires manual intervention)
```

### Component Map

```
routes/specialx.js              ← 15 API endpoints (dashboard, runner, agents, tasks, runs)
  ↓ delegates to
src/services/automationRunnerService.js   ← Singleton queue worker (lease/heartbeat/poll)
src/services/specialxTaskHandlers.js      ← 9 task type handlers (dispatch switch)
  ↓ uses
models/SpecialX.js              ← Profile schema (persona + policies + schedule)
models/AutomationTask.js        ← Work queue item (status/lease/constraints)
models/AutomationRun.js         ← Execution record (result/artifacts/metrics)
  ↓ renders
public/specialx.html            ← Console dashboard UI
public/js/specialx.js           ← Frontend controller (polling, task enqueue, run detail)
```

---

## SpecialX Profiles

A profile defines **who** the agent is and **what** it can do.

### Schema

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Unique identifier (e.g. `specialx.maintenance-operator.v1`) |
| `displayName` | String | Human-readable name |
| `purpose` | String | One-line description of the agent's role |
| `promptProfile.persona` | String | Prompt config persona reference |
| `promptProfile.style` | Enum | `concise` / `balanced` / `detailed` |
| `promptProfile.systemHint` | String | Additional system prompt injection |
| `toolPolicy` | Object | Which tools this agent can use |
| `modelPolicy` | Object | Inference routing rules |
| `taskTypes` | String[] | Which task types this profile can execute |
| `schedule.enabled` | Boolean | Whether cron scheduling is active |
| `schedule.cron` | String | Cron expression (e.g. `0 3 * * *`) |
| `isSystem` | Boolean | System-managed (not user-editable) |
| `isActive` | Boolean | Whether the profile is available for task assignment |
| `stats` | Object | Accumulated run statistics |

### Tool Policy

Controls which AgentX subsystems the agent can invoke:

```javascript
toolPolicy: {
  rag: true,           // Vector store search
  n8n: true,           // n8n workflow triggers
  dataapi: true,       // DataAPI proxy calls
  repoWatcher: true,   // Repository scanning
  codeActions: false    // Code modification (disabled by default)
}
```

### Model Policy

Controls inference routing:

```javascript
modelPolicy: {
  localFirst: true,           // Always try local Ollama first
  allowCloudFallback: false,  // Never fall back to cloud APIs
  maxLocalAttempts: 2,        // Retry local twice before giving up
  preferredTaskType: 'analysis'
}
```

### System Profiles (Pre-Seeded)

Run `node scripts/seed-specialx-profiles.js` to install:

| Profile | Task Types | Schedule | Tools | Purpose |
|---------|-----------|----------|-------|---------|
| `specialx.maintenance-operator.v1` | `maintenance_snapshot`, `maintenance_digest` | Daily 3AM UTC | repoWatcher | Nightly repo health scans |
| `specialx.telemetry-aggregator.v1` | `telemetry_aggregate` | Hourly | DataAPI | Roll up InferenceLog → HostUsageLedger |
| `specialx.schedule-auditor.v1` | `daily_operations_digest`, `schedule_reconcile` | Daily 7AM UTC | n8n, DataAPI, repoWatcher | Daily ops digest + missed task detection |

---

## Task Types

### Current Task Types (9)

| Type | Handler | Input | Output |
|------|---------|-------|--------|
| `repo_summary` | RepoWatcher scan | `{ repoPath }` | JSON scan result + finding counts |
| `ci_failure_triage` | LLM triage | `{ logs, context }` | Markdown root-cause analysis |
| `model_health_digest` | ModelRouter status | `{}` | JSON host/model health + failover state |
| `daily_operations_digest` | Multi-source aggregation | `{}` | Telegram-format ops summary |
| `custom_prompt_analysis` | LLM evaluation | `{ prompt, criteria }` | Markdown prompt feedback |
| `maintenance_snapshot` | Scanner adapters | `{ repoId, scanners[] }` | Finding upserts + severity summary |
| `maintenance_digest` | Digest generator | `{ repoId }` | Telegram-format maintenance digest |
| `telemetry_aggregate` | InferenceLog rollup | `{ hour? }` | HostUsageLedger records created |
| `schedule_reconcile` | Schedule auditor | `{ windowHours? }` | JSON report of missed/late tasks |

### Handler Return Structure

Every handler returns a standardized result:

```javascript
{
  summary: "3 findings resolved, 2 new warnings",
  output: { /* full structured result */ },
  artifacts: [
    { name: "scan-report.json", kind: "json", content: "..." },
    { name: "digest.md", kind: "markdown", content: "..." }
  ],
  metrics: {
    localCalls: 2,       // Local Ollama API calls made
    cloudCalls: 0,       // Cloud fallback calls made
    durationMs: 12340    // Wall-clock execution time
  },
  execution: {
    model: "qwen2.5:14b",
    target: "http://ugbrutal:11434",
    taskType: "maintenance_snapshot",
    routed: true,
    fallbackUsed: false
  }
}
```

---

## AutomationTask — Work Queue

### Status Lifecycle

```
queued → leased → running → completed
                          → failed → queued (retry with backoff)
                                   → dead_letter (max attempts exceeded)
queued → cancelled (manual cancel)
```

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | String (enum) | One of the 9 task types |
| `status` | String | `queued` / `leased` / `running` / `completed` / `failed` / `dead_letter` / `cancelled` |
| `specialXId` | ObjectId | Reference to SpecialX profile |
| `input` | Mixed | Task-specific input payload |
| `constraints` | Object | `{ noCloud, allowCloudFallback, maxLocalAttempts }` |
| `idempotencyKey` | String | Optional dedup key — prevents duplicate enqueue |
| `priority` | Number | Queue ordering (default: 0, higher = sooner) |
| `attempts` | Number | Current attempt count |
| `maxAttempts` | Number | Retry budget (default: 3) |
| `lease.owner` | String | Worker ID holding the lease |
| `lease.leasedAt` | Date | When lease was acquired |
| `lease.leaseExpiresAt` | Date | Lease deadline |
| `lease.heartbeatAt` | Date | Last heartbeat timestamp |
| `resultRunId` | ObjectId | Reference to completed AutomationRun |

### Retry & Backoff

- **Max attempts:** 3 (configurable per task)
- **Backoff formula:** `15,000ms × attemptNumber`
- **Dead-letter:** After max attempts, task moves to `dead_letter` — requires manual review
- **Lease timeout:** 45s default (configurable via `SPECIALX_TASK_LEASE_MS`)

---

## AutomationRun — Execution Record

Each task execution creates one run record. A task that retries twice will have up to 3 run records.

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | ObjectId | Parent AutomationTask reference |
| `specialXId` | ObjectId | Profile used for this run |
| `status` | String | `running` / `completed` / `failed` |
| `summary` | String | One-line result description |
| `output` | Mixed | Full structured output (JSON) |
| `artifacts` | Array | `[{ name, kind, content }]` — downloadable outputs |
| `metrics` | Object | `{ localCalls, cloudCalls, retriesUsed, durationMs }` |
| `execution` | Object | `{ model, target, taskType, routed, fallbackUsed }` |
| `startedAt` / `finishedAt` | Date | Execution window timestamps |
| `error` | String | Error message (on failure) |

---

## Runner Service

`automationRunnerService.js` is a **singleton** that runs as part of the AgentX process.

### Behavior

- **Poll interval:** 5s (configurable via `SPECIALX_RUNNER_POLL_MS`)
- **Lease duration:** 45s (configurable via `SPECIALX_TASK_LEASE_MS`)
- **Heartbeat interval:** 5s (keeps lease alive during execution)
- **Concurrency:** Single-task — claims one task at a time per worker
- **Work-stealing prevention:** Lease is atomic (MongoDB `findOneAndUpdate` with status check)

### Runner Lifecycle

```
Server starts → automationRunnerService.start()
  → Generates unique workerId
  → Starts tick() interval (every 5s)
  → Each tick: claimNext() → execute → persist → clear lease

Server stops → automationRunnerService.stop()
  → Clears interval
  → Any in-flight task lease will expire naturally (45s)
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SPECIALX_RUNNER_POLL_MS` | `5000` | Queue poll interval in milliseconds |
| `SPECIALX_TASK_LEASE_MS` | `45000` | Task lease duration in milliseconds |

---

## API Reference

All endpoints are mounted at `/api/specialx/`.

### Dashboard & Status

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/status` | Session | Runner health: online/offline, instance ID, processed count |
| `GET` | `/dashboard` | Session | Aggregated view: runner status + queue metrics + recent tasks/runs |

### Runner Control

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/runner/start` | Session | Start the queue worker |
| `POST` | `/runner/stop` | Session | Stop the queue worker |
| `POST` | `/runner/tick` | Session | Trigger one manual poll cycle |

### Agent (Profile) Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/agents` | Session | List active SpecialX profiles |
| `POST` | `/agents` | Session | Create a new SpecialX profile |

### Task Queue

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/tasks` | Session or API Key | Enqueue a new task |
| `GET` | `/tasks` | Session | List tasks (paginated, filterable by status) |
| `GET` | `/tasks/:id` | Session | Get task details |
| `POST` | `/tasks/:id/cancel` | Session | Cancel a queued/leased task |

### Run History

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/runs` | Session | List runs (paginated) |
| `GET` | `/runs/:id` | Session | Get run details including artifacts |

### Host Routing

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/routing` | Session | Current model routing state for SpecialX tasks |
| `POST` | `/routing/active-host` | Session | Override active Ollama host for SpecialX |

### Enqueue Example

```bash
curl -X POST http://localhost:3080/api/specialx/tasks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENTX_API_KEY" \
  -d '{
    "type": "maintenance_snapshot",
    "input": { "repoId": "agentx", "scanners": ["repoWatcher", "docJanitor"] },
    "idempotencyKey": "maint-snap-2026-03-10",
    "priority": 5
  }'
```

---

## Console Dashboard

**URL:** `/specialx.html`

The SpecialX Console is a live dashboard showing:

- **Runner status** — green/yellow dot indicating online/offline, instance ID, last tick time
- **Queue metrics** — queued count, running count, success rate, local-first ratio
- **Task table** — filterable list of tasks with status, type, priority, timestamps
- **Run detail modal** — click a run to see full output, artifacts, metrics, execution info
- **Host failover** — dropdown to override active Ollama host for SpecialX execution
- **Manual enqueue** — form to create tasks directly from the UI

Auto-refreshes every 15 seconds via polling.

---

## Scheduling

The `maintenanceSchedulerService.js` runs on a timer and idempotently enqueues tasks based on SpecialX profile schedules:

- **Hourly tasks** (e.g. telemetry aggregation) — checked every poll cycle
- **Daily tasks** (e.g. maintenance snapshot, ops digest) — checked at schedule time
- **Idempotency** — uses date-based keys to prevent duplicate enqueues within the same period

### How Schedule Works

1. `maintenanceSchedulerService` evaluates all active profiles with `schedule.enabled: true`
2. For each due schedule, creates an `AutomationTask` with an idempotency key like `telemetry-agg-2026-03-10T14`
3. The runner picks up the task via normal queue processing
4. If the task already exists for that period (same idempotency key), creation is silently skipped

---

## Integration with Maintenance Mesh

SpecialX is the automation backbone for AgentX's maintenance system (OpenClaw Sprints 1-5):

```
SpecialX Profile: maintenance-operator
  → task type: maintenance_snapshot
    → maintenanceSnapshotService.runSnapshot()
      → 4 scanner adapters (repoWatcher, docJanitor, featureAlignment, validationScanner)
      → Findings upserted to Finding model
      → Artifacts: scan report JSON + severity summary markdown

  → task type: maintenance_digest
    → Reads recent Findings
    → Generates Telegram-format digest
    → Artifacts: digest.md

SpecialX Profile: telemetry-aggregator
  → task type: telemetry_aggregate
    → hostUsageAggregator.aggregateHour()
    → Rolls up InferenceLog → HostUsageLedger hourly records

SpecialX Profile: schedule-auditor
  → task type: schedule_reconcile
    → clusterScheduleService.reconcile()
    → Compares planned schedule vs actual execution within 25h window
    → Reports: missed tasks, late starts, overruns
```

---

## File Reference

### Services
| File | Lines | Purpose |
|------|-------|---------|
| `src/services/automationRunnerService.js` | ~466 | Queue worker: poll, claim, execute, persist |
| `src/services/specialxTaskHandlers.js` | ~450 | 9 task type handlers with dispatch |
| `src/services/maintenanceSchedulerService.js` | ~200 | Idempotent cron-based task enqueuer |

### Models
| File | Lines | Purpose |
|------|-------|---------|
| `models/SpecialX.js` | ~160 | Profile schema: persona + tool/model policies |
| `models/AutomationTask.js` | ~95 | Work queue item: status, lease, constraints |
| `models/AutomationRun.js` | ~95 | Execution record: result, artifacts, metrics |

### Routes
| File | Lines | Purpose |
|------|-------|---------|
| `routes/specialx.js` | ~620 | 15 REST endpoints for dashboard, agents, tasks, runs |

### Frontend
| File | Lines | Purpose |
|------|-------|---------|
| `public/specialx.html` | ~1200 | Console dashboard HTML |
| `public/js/specialx.js` | ~600 | Frontend controller: polling, task enqueue, run detail |

### Config & Seeds
| File | Purpose |
|------|---------|
| `scripts/seed-specialx-profiles.js` | Seeds 3 system profiles (idempotent) |
| `personas/specialx_console.json` | Control-plane persona definition |

### Tests
| File | Purpose |
|------|---------|
| `tests/unit/specialx-automation.test.js` | Profile creation, idempotency, lease claiming, metrics |

---

## Safety Rules

Per CLAUDE.md architecture contract:

1. **No infinite loops** — every task has a lease timeout and retry budget
2. **Idempotency** — optional dedup key prevents repeated execution
3. **Bounded retries** — exponential backoff, dead-letter after max attempts
4. **Lease ownership** — heartbeat refresh prevents stale claims; expired leases are reclaimable
5. **Deterministic output** — handlers run at low temperature (0.1) with structured output expectations
6. **Local-first** — cloud fallback requires explicit profile opt-in and is audit-logged
