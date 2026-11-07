# Read routes of an AgentX instance

This is a product route reference, not an instance health receipt. Resolve the address from the private instance sheet and check the served revision and enabled capabilities before calling a route. A missing route in this list proves nothing; check its exact contract in the product source. `references/served.md` identifies the revision serving this skill.

Base: the Core entry given in `references/instance.md`.

## Read routes

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
`/api/analytics/usage` · `/stats` · `/costs` · `/feedback` · `/rag-stats` · `/api/analytics/inference/summary?window=7d` · `/api/analytics/inference/logs?pageSize=N` · `/api/alerts` · `/api/alerts/statistics` · `/api/budget/status` · `/api/budget/escalation-recommendation`

**Other services through Core**
`/api/rag/status` · `/api/rag/metrics` · `/api/data-toolbox/network/devices` · `/api/data-toolbox/storage/summary` · `/api/data-toolbox/hardware/latest` · `/api/voix/health` · `/api/llm/v1/models` (OpenAI-compatible list; needs a gateway client token)

**Benchmark** (under `/benchmark`): `/benchmark/health` · `/benchmark/api/benchmark/batches/active` · `/benchmark/api/profiler/hosts`
**RAG** (under `/rag`): `/rag/health`

## Photo reads verified in source

Defined in the product's `core/routes/photos.js` and tested against a mocked
Immich. `/api/photos/status` says whether the instance configured them.

`/api/photos/status` · `/api/photos/people` · `/api/photos/people/<id>/assets` · `/api/photos/places` · `/api/photos/tags` · `/api/photos/search/smart?q=` · `/api/photos/search` · `/api/photos/count` · `/api/photos/assets/<id>` · `/api/photos/assets/<id>/thumbnail`

## Pipeline reads verified in source

These paths are defined in the product's Pipeline and optional runtime-bridge
routes. Read the served revision and instance capability configuration before
relying on the optional
bridge. No live model call is needed to inspect them.

- `GET /api/pipeline/tasks?scope=engineering`: scoped counts, rows and coverage.
- `GET /api/pipeline/tasks/:id`: human dossier and its task-content `editToken`.
- `GET /api/pipeline/tasks/:id/worker?agent=<worker>`: bounded worker task and
  privacy-filtered Planning references; it does not claim or start the task.
- `GET /api/pipeline/tasks/:id/eligibility` and `/diagnosis`: read-only start
  conditions and next-step diagnosis.
- `GET /api/runtime-bridges/coding-dispatch/status?requestId=<uuid>`: optional
  native observation of the original local worker request.

Brief and evidence guidance: [coding-work.md](coding-work.md).

## Routes that exist and need a body

These POST routes require their documented request bodies; a transport response
alone does not verify the requested capability.
`POST /api/rag/search` · `POST /api/consumers/nestor/v1/memory/notes` · `POST /api/consumers/nestor/v1/mail-journal`

## Memory review

Read the memory-review state through:
`GET /api/memory-review/digest` · `GET /api/memory-review/runs?limit=N&status=…` · `GET /api/memory-review/runs/<runId>` · `GET /api/memory-review/insights` · `GET /api/memory-review/config`

`GET /api/memory-review/runs/<runId>/synthesis-input` answers only while the run is `synthesizing`. The `POST` routes (open, observations, finalize, candidates, fail) belong to the collectors.

## Tool buses

Both answer JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`) from the
private network without a token. Call `tools/list` for the current catalogue
rather than trusting a copied list.

- `POST /mcp`: the general bus. `POST /mcp/memory` is a narrower view of it
  (memory search/save and RAG search).
- `POST /api/consumers/nestor/v1/mcp`: the owner bus. Never for family runtimes.

## Earlier route names

Earlier notes refer to these bare paths; check an exact current route before using one: `/api/hosts*`, `/api/host-monitor`, `/api/host-capacity`, `/api/cluster`, `/api/ollama-vram`, `/api/metrics`, `/api/telemetry`, `/api/performance`, `/api/todos`, `/api/prompt-templates`, `/api/reports`, `/api/docs-steward`, `/api/nestor/memory`, `/api/openclaw`, `/api/panel`, `/api/buddy`, `/api/custom-models`, `/api/hermes`, `/api/voice`, `/api/voice-personas`, `/api/nerve-center/routing/config`, `/api/models/registry/export/openclaw`, `/api/data-toolbox/live-data`. A 404 on a bare prefix does not prove every sub-route is gone.

When commenting on Analytics, use the summary's exact window, `observedAt`,
`ttlMs`, scope and attribution coverage. Missing consumer contracts do not prove
an unknown runtime; runtime categories do not identify applications. Inspect
`/api/analytics/inference/logs?consumerContractMissing=true&from=ISO&to=ISO`
for the same window. Separate admission refusals, unrecorded error causes and
cancellations. No recorded cloud traffic does not establish no cloud usage.
A low attempt error rate alone is not a service reliability assessment.
