# Read routes of an AgentX instance

Checked on 2026-10-07 against Core revision `bfc824e7`, from the private network, without any access code. Only read routes were called. A route missing from this file is not known to exist: check it before relying on it. `references/served.md` gives the revision that served this copy; when it is newer, a route may have moved.

Base: the Core entry given in `references/instance.md`.

## Read routes that answer 200

**Health and operations**
`/health` · `/api/operations/health` · `/api/operations/activity` · `/api/operations/events`

**Nerve Center**
`/api/nerve-center/ecosystem` · `/intelligence` · `/inference-health` · `/inference-stats` · `/inference/routing-config` · `/routing/log` · `/routing/analytics` · `/health/feed`

**Models and hosts**
`/api/models/all` · `/api/models/catalog` · `/api/models/sources` · `/api/models/cluster-summary` · `/api/models/health` · `/api/models/routing` · `/api/models/registry` · `/api/models/registry/stats` · `/api/models/registry/grouped` · `/api/ollama/models` · `/api/ollama-hosts` · `/api/ollama-watchdog`

**Routing**
`/api/router/config` · `/api/router/config/defaults` · `/api/router/gate-stats`

**Pipeline, prompts, conversations**
`/api/pipeline/tasks` · `/api/pipeline/tasks/next` · `/api/prompts` · `/api/history` · `/api/history/conversations` · `/api/conversations` · `/api/roundtable` · `/api/roundtable/defaults` · `/api/roundtable/active`

**Analytics, alerts, budget**
`/api/analytics/usage` · `/stats` · `/costs` · `/feedback` · `/rag-stats` · `/api/analytics/inference/summary?window=7d` · `/api/analytics/inference/logs?limit=N` · `/api/alerts` · `/api/alerts/statistics` · `/api/budget/status` · `/api/budget/escalation-recommendation`

**Other services through Core**
`/api/rag/status` · `/api/rag/metrics` · `/api/data-toolbox/network/devices` · `/api/data-toolbox/storage/summary` · `/api/data-toolbox/hardware/latest` · `/api/voix/health` · `/api/hermes-openai/v1/models` (OpenAI-compatible list)

**Benchmark** (its own entry): `/health` · `/api/benchmark/batches/active` · `/api/profiler/hosts`
**RAG** (its own entry): `/health`

## Routes that exist and need a body

These answer 400 to an empty body, so the route is there; their payloads were not exercised.
`POST /api/rag/search` · `POST /api/consumers/nestor/v1/memory/notes` · `POST /api/consumers/nestor/v1/mail-journal`

## Memory review

Answered 200 from the private network on 2026-10-08, without a token:
`GET /api/memory-review/digest` · `GET /api/memory-review/runs?limit=N&status=…` · `GET /api/memory-review/runs/<runId>` · `GET /api/memory-review/insights` · `GET /api/memory-review/config`

`GET /api/memory-review/runs/<runId>/synthesis-input` answers only while the run is `synthesizing`. The `POST` routes (open, observations, finalize, candidates, fail) belong to the collectors.

## Core tool bus

`POST /mcp`, JSON-RPC 2.0. On 2026-10-07 it listed 21 tools and accepted `check_health` from the private network without a token:
`add_email_action` · `add_idea` · `add_personal_task` · `benchmark_coverage` · `benchmark_request_measurement` · `benchmark_results` · `check_health` · `complete_personal_task` · `create_todo` · `ecosystem_snapshot` · `get_escalation_recommendation` · `get_sound` · `list_personal_tasks` · `memory_remember` · `memory_search` · `network_devices` · `personal_briefing` · `rag_search` · `shopping_list` · `update_personal_task` · `write_vault_note`

## Gone since the July notes

These paths answered 404 and were removed from the skill: `/api/hosts*`, `/api/host-monitor`, `/api/host-capacity`, `/api/cluster`, `/api/ollama-vram`, `/api/metrics`, `/api/telemetry`, `/api/performance`, `/api/todos`, `/api/prompt-templates`, `/api/reports`, `/api/docs-steward`, `/api/nestor/memory`, `/api/openclaw`, `/api/panel`, `/api/buddy`, `/api/custom-models`, `/api/hermes`, `/api/voice`, `/api/voice-personas`, `/api/nerve-center/routing/config`, `/api/models/registry/export/openclaw`, `/api/data-toolbox/live-data`. A 404 on a bare prefix does not prove every sub-route is gone.
