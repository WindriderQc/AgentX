# OpenClaw Maintenance Mesh — Implementation Plan v2

> **Status:** Approved
> **Date:** 2026-03-10
> **Supersedes:** `docs/archive/2026-03-21/root/openclawPlan.md` (Agent Mesh Foundation)

---

## Scope Decisions

| Decision | Answer |
|---|---|
| Repos in scope | AgentX + DataAPI only |
| UI target | AgentX HTML first, Mission Control later |
| First value | GPU inference telemetry |
| Notifications | Dashboard + Telegram (both) |

---

## Design Principles

| Original Plan | This Plan |
|---|---|
| Phase 1 is design/docs, zero features | Every sprint ships a working screen |
| Host telemetry is Phase 5 | Host telemetry is Sprint 1 |
| OpenClaw integration is Phase 3 | Telegram digest ships in Sprint 2 |
| 7 named Maintainer Capabilities | Map to existing scanners, formalize later |
| Generic RepoProfile contract | Hardcoded config for 2 repos |
| Findings are embedded subdocuments | Top-level model with lifecycle |
| Ignores 3 oversized services | Refactor debt addressed in Sprint 4 |
| Phases with no timeline | Sprints are 1 week each, ordered by value |

---

## Sprint 1 — Inference Telemetry (Week 1)

**Goal:** Know exactly what's running on your 3 GPUs — every model call, every host, every token.

**Why first:** `modelRouter.js` already touches every inference request. Telemetry is ~50 lines in the router + a new model + a dashboard.

### Deliverables

1. **`InferenceLog` model** (`models/InferenceLog.js`)
   - Fields: `host`, `model`, `caller` (agent/user/specialx/cron), `callerDetail` (agent ID, task ID, cron job name), `taskType` (chat/benchmark/roundtable/automation/embedding), `tokensIn`, `tokensOut`, `durationMs`, `fallbackUsed`, `fallbackReason`, `status` (success/error/timeout), `error`, `routingDecision`, `vramEstimate`, `timestamp`
   - TTL index: 30-day retention
   - Compound indexes: `{host, timestamp}`, `{model, timestamp}`, `{caller, timestamp}`

2. **`modelRouter.js` instrumentation**
   - Emit `InferenceLog` after every inference call (success or fail)
   - Non-blocking fire-and-forget writes
   - Instrument embedding calls through same path

3. **`routes/inference-telemetry.js`**
   - `GET /api/telemetry/recent` — last N calls with filters
   - `GET /api/telemetry/host-summary` — per-host aggregates
   - `GET /api/telemetry/model-summary` — per-model aggregates
   - `GET /api/telemetry/caller-summary` — per-caller aggregates
   - `GET /api/telemetry/timeline` — time-bucketed series for charts

4. **`public/inference-telemetry.html`** dashboard
   - Live feed: last 50 inference calls, auto-refreshing
   - Host cards: per-host metrics (calls/hour, tokens/hour, avg latency)
   - Model usage chart
   - Timeline chart: inference volume split by host
   - Fallback tracker

5. **Wire into `cluster.html`** — add "Actual Usage" tab

### Files Touched
- `models/InferenceLog.js` — new (~60 lines)
- `src/services/modelRouter.js` — add telemetry emit (~50 lines)
- `routes/inference-telemetry.js` — new (~200 lines)
- `public/inference-telemetry.html` — new (~500 lines)
- `src/app.js` — register route
- `public/cluster.html` — add nav link

---

## Sprint 2 — Unified Maintenance Snapshot + Telegram Digest (Week 2)

**Goal:** One ranked view of all repo health findings + daily Telegram summary.

### Deliverables

1. **`Finding` model** (`models/Finding.js`) — top-level, NOT embedded
   - Fields: `repo`, `scanId`, `scanner`, `category`, `severity`, `confidence`, `title`, `description`, `evidence`, `suggestedAction`, `status`, `statusChangedAt`, `firstSeenAt`, `lastSeenAt`, `occurrenceCount`
   - Lifecycle states: new → acknowledged → deferred → resolved → false_positive

2. **`maintenanceSnapshotService.js`** (<400 lines)
   - Orchestrates all 4 scanners against a repo
   - Normalizes output to Finding records
   - Deduplicates (same file + category = update existing)
   - Returns ranked summary

3. **Scanner adapters** (4 thin translation files, ~60 lines each)
   - `adapters/repoWatcherAdapter.js`
   - `adapters/docJanitorAdapter.js`
   - `adapters/featureAlignmentAdapter.js`
   - `adapters/validationScannerAdapter.js`

4. **`routes/maintenance.js`**
   - `POST /api/maintenance/scan/:repo` — trigger snapshot
   - `GET /api/maintenance/snapshot/:repo` — latest summary
   - `GET /api/maintenance/findings` — findings list with filters
   - `PATCH /api/maintenance/findings/:id` — update status
   - `GET /api/maintenance/digest` — Telegram-formatted summary

5. **`public/maintenance.html`** dashboard
   - Repo health cards with traffic-light indicators
   - Findings table: filterable by repo, severity, scanner, status
   - Trend sparklines
   - Quick actions: acknowledge, defer, false positive

6. **SpecialX task type: `maintenance_snapshot`**

7. **Telegram daily digest**
   - New cron job in OpenClaw `jobs.json`
   - Calls `/api/maintenance/digest` via `agentx-api` skill
   - Delivers to Telegram daily after morning-briefing

---

## Sprint 3 — Host Usage Ledger + Schedule Reconciliation (Week 3)

**Goal:** Actual vs planned. Does the schedule match reality?

### Deliverables

1. **`HostUsageLedger` model** — hourly aggregates per host
2. **Aggregation worker** — runs hourly, aggregates InferenceLog → HostUsageLedger
3. **Schedule reconciliation** in `clusterScheduleService.js`
   - `getActualVsPlanned(date, hostId)` — planned vs actual comparison
   - Flag overruns, starvation, model thrashing
4. **VRAM-aware conflict detection** — flag schedule conflicts by VRAM requirements
5. **Enhanced `cluster.html`** — actual vs planned timeline, utilization heatmap, conflict alerts

---

## Sprint 4 — Code Debt Paydown + Finding Trends (Week 4)

**Goal:** Split oversized services, add finding trend tracking.

### Deliverables

1. **Split `repoWatcherService.js`** (817 lines → 2 files, each <400)
   - `repoScannerService.js` — file system traversal + pattern detection
   - `repoAnalyzerService.js` — classification, severity, deduplication
   - `repoWatcherService.js` — thin orchestrator

2. **Split `featureAlignmentScanner.js`** (767 lines → 2 files)
   - `routeExtractor.js` — route parsing, path normalization
   - `featureAlignmentMatcher.js` — token matching, confidence scoring

3. **Split `selfHealingEngine.js`** (1410 lines → 3 files)
   - `selfHealingEvaluator.js`
   - `selfHealingExecutor.js`
   - `selfHealingScheduler.js`

4. **Finding trend tracking** — `FindingTrend` model, trend charts in maintenance.html

5. **Repo profile config** — `config/repo-profiles.json` (hardcoded for AgentX + DataAPI)
   - Fields: `repoId`, `repoPath`, `name`, `criticalPaths`, `protectedZones`, `testCommand`, `buildCommand`, `scanSchedule`

---

## Sprint 5 — SpecialX Maintenance Task Suite (Week 5)

**Goal:** Maintenance scanning as SpecialX-driven scheduled automation.

### Deliverables

1. **New SpecialX task types:**
   - `maintenance_scan_full`
   - `maintenance_scan_targeted`
   - `telemetry_aggregate`
   - `schedule_reconcile`
   - `finding_digest`

2. **SpecialX profiles** for maintenance (3 new profiles):
   - "Maintenance Operator" — daily 03:00
   - "Telemetry Aggregator" — hourly
   - "Schedule Auditor" — daily 06:00

3. **Scheduled maintenance pipeline** — fully automated daily/hourly cycle

---

## Sprint 6 — Patch Proposals + Approval Workflow (Week 6+)

**Goal:** System proposes fixes. You approve. No autonomous edits.

### Deliverables

1. **`PatchProposal` model** — findingId, diff, blastRadius, validationSteps, status, approvedBy
2. **Proposal generators** (safe categories only):
   - Docs fixes: stale references, broken links
   - Import fixes: unused imports
3. **Approval UI** in maintenance.html — diff viewer, blast radius, validation checklist
4. **Telegram approval flow** — inline keyboard Approve/Reject

---

## Value Delivery Timeline

| Sprint | Week | Primary Deliverable | Operator Experience |
|---|---|---|---|
| **1** | 1 | Inference telemetry | "I see every GPU inference call in real-time" |
| **2** | 2 | Unified repo health + Telegram digest | "Daily Telegram summary of repo health" |
| **3** | 3 | Host usage ledger + schedule reconciliation | "I know if my GPU schedule matches reality" |
| **4** | 4 | Code debt paydown + finding trends | "Codebase is cleaner, finding trends visible" |
| **5** | 5 | SpecialX maintenance automation | "Scans run automatically on schedule" |
| **6** | 6+ | Patch proposals + approval | "System proposes fixes, I approve" |

---

## What's Deferred / Cut

| Item | Reason |
|---|---|
| 7 named Maintainer Capabilities | Existing scanners cover this; formalize later |
| Generic RepoProfile CRUD system | Hardcoded config for 2 repos is sufficient |
| Phase 1 "define ownership model" | Already defined in architecture doc |
| DataAPI as repo intelligence substrate | AgentX does everything needed |
| Full AST graph platform | No near-term use case for 2 repos |
| Autonomous code edits (Stages 3-5) | Earn trust first with proposals |
| Data Contract Checker capability | Too niche for 2-repo scope |
| Mission Control maintenance dashboards | After AgentX version is proven |
