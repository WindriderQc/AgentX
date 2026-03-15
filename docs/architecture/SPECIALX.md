# SpecialX Architecture

Last Updated: 2026-03-11

## Scope

This document describes the current SpecialX implementation in the main
`C:\Users\Yanik\codes\AgentX` repository tree.

It is an engineering reference for:

- profile definitions
- queue and run records
- runner behavior
- task handlers
- HTTP API surface
- operator UI

It does not describe future or speculative autonomous behavior.

## Terminology

The terminology below follows `CLAUDE.md`.

| Term | Meaning in this repository | What it is not |
|------|----------------------------|----------------|
| AgentX Platform | The application runtime and control plane | Not a single task agent |
| SpecialX | Specialist task agents managed by AgentX Platform | Not the whole platform |
| Persona | A behavior or prompt profile only | Not an autonomous runtime |
| Run | One bounded execution of one SpecialX on one task | Not an open-ended chat loop |
| Automation task | A queued unit of work in `AutomationTask` | Not a profile definition |

## What SpecialX Is

SpecialX is the queue-driven automation subsystem used by AgentX Platform to
run bounded specialist tasks.

At rest, a SpecialX is a profile document stored in `models/SpecialX.js`.

A profile carries:

- identity: `name`, `displayName`, `purpose`, `description`
- prompt profile: `persona`, `style`, `systemHint`
- tool policy: RAG, n8n, DataAPI, Repo Watcher, code-action toggles
- model policy: local-first, cloud fallback, max local attempts, preferred task type
- allowed task types
- optional schedule metadata
- run statistics

The profile is separate from execution.

Execution happens through queue entries in `AutomationTask`, run records in
`AutomationRun`, and handler dispatch in `specialxTaskHandlers`.

The default system profile is `specialx.operator.v1`.

It is created on demand by `SpecialX.ensureDefaultOperator()` and is used when
no explicit `specialXId` is resolved.

## Current Implementation Boundaries

The current main-tree implementation is finite and queue-driven:

1. A caller enqueues an automation task.
2. The runner leases one task.
3. The runner resolves the SpecialX profile.
4. A task-specific handler executes through existing AgentX services.
5. A run record is persisted.
6. The task is marked completed, re-queued, or dead-lettered.

There is no infinite autonomous loop in the current code path.

The SpecialX runner delegates to existing platform services such as:

- `repoWatcherService`
- `chatService`
- `modelRouter`

The handlers do not shell out to ad-hoc agent runtimes.

## Data Model

### `SpecialX`

`models/SpecialX.js` defines the profile document.

Relevant fields:

- `workspaceId`: optional workspace scoping
- `name`: stable identifier, unique per workspace
- `promptProfile`: persona + style + system hint
- `toolPolicy`: service/tool toggles
- `modelPolicy`: local-first and fallback policy
- `taskTypes`: allowed task types for that profile
- `schedule`: `enabled`, `cron`, `timezone`
- `isActive`, `isSystem`
- `stats`: run counters and average duration

Helper methods:

- `getActive(workspaceId)` returns active global + workspace-local profiles
- `ensureDefaultOperator(workspaceId)` guarantees `specialx.operator.v1`

### `AutomationTask`

`models/AutomationTask.js` defines the queue record.

Relevant fields:

- `type`: task type enum
- `status`: `queued`, `leased`, `running`, `completed`, `failed`, `dead_letter`, `cancelled`
- `source`: `manual`, `schedule`, `system`, `n8n`, `ci`, `webhook`
- `priority`: integer `1..10`
- `input`: task payload
- `constraints`: cloud policy, local attempts, timeout
- `runAt`: earliest execution time
- `attempts`, `maxAttempts`
- `lease`: owner, lease time, expiry, heartbeat
- `idempotencyKey`: optional unique dedupe key
- `resultRunId`: last run record for this task
- `lastError`, `startedAt`, `completedAt`

Queue helpers:

- `claimNext(workerId, leaseMs, now)`
- `heartbeat(taskId, workerId, leaseMs)`

### `AutomationRun`

`models/AutomationRun.js` defines the immutable execution record for one
attempt.

Relevant fields:

- `taskId`
- `specialXId`
- `workerId`
- `attempt`
- `status`: `running`, `completed`, `failed`
- `execution`: local-first and routing metadata
- `summary`
- `output`
- `metrics`: local calls, cloud calls, retries used, duration
- `artifacts`
- `error`
- `startedAt`, `finishedAt`

`AutomationRun` is the persisted artifact for audit and UI inspection.

## Task Lifecycle

### 1. Queue

Tasks enter the system through `automationRunnerService.enqueueTask()` or the
`POST /api/specialx/tasks` route.

At enqueue time the service:

- normalizes `idempotencyKey`
- deduplicates if the key already exists
- resolves the target SpecialX profile or default operator
- writes a new `AutomationTask` with `status: queued`
- records task constraints and request context

### 2. Claim

`AutomationRunnerService.tick()` calls `AutomationTask.claimNext()` to acquire
exactly one task.

Claim rules:

- eligible tasks are `queued` with `runAt <= now`
- expired `leased` tasks can be reclaimed
- the claim sets `status: leased`
- the worker stores `lease.owner`, `leasedAt`, `leaseExpiresAt`, `heartbeatAt`
- sort order is `priority`, then `runAt`, then `createdAt`

In this schema a lower numeric priority is taken first because the query sorts
ascending on `priority`.

### 3. Execute

`executeLeasedTask()` reloads the task, resolves the SpecialX profile, and
transitions the task to `running`.

It then:

- increments `attempts`
- creates an `AutomationRun` with `status: running`
- starts a heartbeat interval
- dispatches by `task.type` through `runTaskByType()`

Handler dispatch currently lives in `src/services/specialxTaskHandlers.js`.

### 4. Persist

On success the runner:

- updates `AutomationRun` to `completed`
- stores `summary`, `output`, `artifacts`, `metrics`, and execution routing info
- updates `AutomationTask` to `completed`
- clears lease ownership
- stores `resultRunId`
- updates SpecialX profile stats

### 5. Retry or Dead-Letter

On failure the runner:

- updates `AutomationRun` to `failed`
- stores error message, code, stack, and duration
- checks `attempt >= maxAttempts`

If attempts remain:

- task status goes back to `queued`
- `runAt` is moved forward with bounded backoff
- lease ownership is cleared

If the attempt limit is reached:

- task status becomes `dead_letter`
- `completedAt` is set
- lease ownership is cleared
- `lastError` remains on the task

This is the terminal failure state for the queue entry.

## Current Task Types

The current source of truth for task types in the main tree is the enum in
`models/AutomationTask.js`.

| Task type | Handler behavior | Notes |
|-----------|------------------|-------|
| `repo_summary` | Runs Repo Watcher scan for a repo path and stores scan output as JSON artifact | Local service call only |
| `ci_failure_triage` | Builds a CI-triage prompt, routes the model, and uses `chatService` for a structured diagnosis | Uses routed local inference |
| `model_health_digest` | Collects model routing and failover status and stores host health summary | Operational digest, no chat call |
| `daily_operations_digest` | Combines repo scan, routing status, and queue metrics into a compact daily digest artifact | Aggregates multiple local services |
| `custom_prompt_analysis` | Analyzes `input.prompt` via routed chat and stores markdown analysis artifact | Requires `input.prompt` |

Notes:

- unsupported task types throw `Unsupported task type`
- `custom_prompt_analysis` throws if `input.prompt` is missing
- the handler code currently records only local calls; cloud fallback is not used

## Runner Safety Rules

The current runner implements the core safety rules expected by `CLAUDE.md`.

### Bounded retries

- each task has `maxAttempts`
- each execution increments `attempts`
- failures are re-queued only while `attempt < maxAttempts`
- retry delay is `min(600000, 15000 * attempt)` milliseconds

### Lease ownership

- a worker instance gets a unique `instanceId`
- claims write `lease.owner`
- only the lease owner may refresh heartbeat
- success/failure paths clear the lease block

### Heartbeat

- a heartbeat timer refreshes the task lease while the task is running
- refresh cadence is `max(5000, floor(leaseMs / 3))`
- heartbeats extend `lease.leaseExpiresAt`

### Expired lease recovery

- `claimNext()` can reclaim tasks still marked `leased` if their lease expiry is in the past
- this keeps abandoned leased tasks from being stuck forever

### Dead-letter

- dead-letter is the terminal queue status after the final failed attempt
- the failed run is still stored in `AutomationRun`
- the queue record keeps `lastError`, timestamps, and `resultRunId`

### Finite execution

- one task maps to one run attempt
- handlers return structured result objects
- the runner always transitions to a terminal or retry state
- there is no autonomous recursive task spawning in the current code

## API Surface

The API surface below comes from `routes/specialx.js`.

### Dashboard and status

- `GET /api/specialx/status`
- `GET /api/specialx/dashboard`
- `GET /api/specialx/routing`

### Routing control

- `POST /api/specialx/routing/active-host`

### Runner control

- `POST /api/specialx/runner/start`
- `POST /api/specialx/runner/stop`
- `POST /api/specialx/runner/tick`

### SpecialX profile management

- `GET /api/specialx/agents`
- `POST /api/specialx/agents`

### Task queue

- `POST /api/specialx/tasks`
- `GET /api/specialx/tasks`
- `GET /api/specialx/tasks/:id`
- `POST /api/specialx/tasks/:id/cancel`

### Runs

- `GET /api/specialx/runs`
- `GET /api/specialx/runs/:id`

## Scheduling

### Current main-tree behavior

In the main repository tree, schedule metadata exists on `SpecialX` profiles
as:

- `schedule.enabled`
- `schedule.cron`
- `schedule.timezone`

However, the current runner does not read those fields directly.

In this checkout, tasks are actively enqueued through:

- `POST /api/specialx/tasks`
- direct service calls to `enqueueTask()`

### Maintenance scheduler discrepancy

The repository memory file and a separate worktree copy include a
`MaintenanceSchedulerService`, but that file is not present in the main tree at
`src/services/maintenanceSchedulerService.js`.

That out-of-tree scheduler enqueues maintenance tasks by:

- firing once on startup and then hourly
- generating idempotency keys by UTC hour or UTC date
- creating `AutomationTask` records with `source: schedule`
- using `AutomationTask` unique `idempotencyKey` to make duplicate enqueues safe

The referenced scheduler defines these maintenance task families:

- `telemetry_aggregate`
- `maintenance_snapshot`
- `maintenance_digest`

Those task types are not present in the current main-tree `AutomationTask`
enum, so they should be treated as out-of-tree or not yet merged in this
checkout.

For the current main tree, the engineering-safe statement is:

- SpecialX supports schedule metadata on profiles
- the queue supports scheduled execution via `runAt`
- maintenance auto-enqueue logic is not present in the main tree source

## File Reference Table

| Area | File | Role |
|------|------|------|
| Model | `models/SpecialX.js` | Profile definition, default operator bootstrap, run stats |
| Model | `models/AutomationTask.js` | Queue record, claim logic, heartbeat updates, idempotency key |
| Model | `models/AutomationRun.js` | Attempt record, metrics, artifacts, error persistence |
| Service | `src/services/automationRunnerService.js` | Polling runner, enqueue path, lease execution, retry/dead-letter behavior |
| Handler | `src/services/specialxTaskHandlers.js` | Task-type dispatch to Repo Watcher, chat, model routing, and queue metrics |
| Route | `routes/specialx.js` | HTTP API for dashboard, runner controls, profiles, tasks, and runs |
| UI | `public/specialx.html` | Operator console shell for queue and run visibility |
| UI | `public/js/specialx.js` | Dashboard polling, quick enqueue, runner controls, and run detail loading |

## Operational Notes

- Runner poll interval defaults to `SPECIALX_RUNNER_POLL_MS` or `5000`
- Lease duration defaults to `SPECIALX_TASK_LEASE_MS` or `45000`
- Runner enable flag is `SPECIALX_RUNNER_ENABLED=false` to disable
- Completed and terminally failed tasks can notify OpenClaw via `OPENCLAW_WEBHOOK_URL`
- Queue metrics aggregate task counts by status
- 24-hour run metrics compute success rate and local-first ratio

## Summary

SpecialX in the current main tree is a finite automation system built from:

- profile documents in `SpecialX`
- queue entries in `AutomationTask`
- run artifacts in `AutomationRun`
- a single-worker polling runner
- task-specific handlers that call existing AgentX services

The implementation is queue-first, lease-based, local-first, and bounded by
retry and dead-letter rules.
