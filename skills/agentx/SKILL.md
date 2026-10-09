---
name: agentx
description: "Operate an AgentX instance: Core, Benchmark, RAG and Data. Use for its health, inference hosts, model registry, routing, benchmark or leaderboard, RAG search, pipeline tasks, the nightly memory review, or its agents."
---

# AgentX platform operator

AgentX is a local-first AI platform (product: github.com/WindriderQc/AgentX). This skill is served by the instance it describes: `references/instance.md` holds that instance's addresses, machines and schedules, and `references/served.md` says which revision produced this copy and when. Read both first. When `instance.md` is missing, ask for the Core address instead of guessing one.

| Service | Role |
|---|---|
| Core | Personal and family pages, Pipeline, Nerve Center, model registry, inference routing |
| Benchmark | Model scoring, leaderboard, profiler |
| RAG | Documents, embeddings, hybrid search |
| Data | Through Core, `/api/data-toolbox/*` and the `/data-toolbox` page; no entry of its own |

The application ports are bound to loopback on the host. From any other machine use the address listed in `instance.md`, never a raw service port. Core, Benchmark and RAG share that one address: Benchmark answers under `/benchmark` and RAG under `/rag` (pages, APIs and `/health`), everything else is Core.

## Access

The private network needs no account and no code, and nothing is reachable from the Internet. Never send a parental code and never look for a code file: that mechanism is retired. Consumer routes keep their own tokens. Never print, log, store or paste a token.

## How to reach it

1. **A connector**, when `instance.md` names one: prefer its tools.
2. **Core tool bus** (`POST <core>/mcp`, JSON-RPC): personal tasks, memory search, briefing, shopping list, vault notes, benchmark results, `check_health`, `ecosystem_snapshot`, `rag_search`. These tools read and write owner data.
3. **Plain HTTPS** with curl or fetch. Benchmark and RAG are reachable under `<core>/benchmark/*` and `<core>/rag/*` (for example `<core>/benchmark/api/benchmark/batches/active`, `<core>/rag/api/rag/status`) or through Core's proxies `/api/benchmark-proxy/*` and `/api/rag/*`.

Send the header `x-service-caller: <who you are>` on direct calls; it is logged.

## Answers

Canonical envelope `{ ok: true, data }` or `{ ok: false, error }`. Older routes still answer `{ status: 'success'|'error', message, data }`. Read `ok` when present, otherwise `status`.

## Common reads

- **Health**: `GET /health`, `/benchmark/health` and `/rag/health`; `GET /api/operations/health`; `GET /api/nerve-center/ecosystem`; `GET /api/nerve-center/inference-health`.
- **Hosts and models**: `GET /api/models/cluster-summary` (what is loaded and pinned on each host), `/api/models/all`, `/api/models/registry` (filters: category, tag, vendor, status), `/api/ollama-hosts`.
- **Routing**: `GET /api/router/config` (which model and host serve each task type).
- **Usage**: `GET /api/analytics/inference/summary?window=7d|30d`, `/api/analytics/usage`, `/api/analytics/costs`. These counts include trials and benchmark batches.
- **Pipeline**: `GET /api/pipeline/tasks`, `/api/pipeline/tasks/next`.
- **RAG**: `GET /api/rag/status`; `POST /api/rag/search` with `{ query, topK?, filters? }`.

The longer list is in `references/endpoints.md`.

## Writes

- **Chat**: `POST /api/chat` with `{ model, message, ... }`. `model` is optional when `taskType` or `autoRoute: true` is given. Leave the host to the router.
- **Pipeline**: `POST /api/pipeline/tasks` with `{ title, objective, service }`; `POST /api/pipeline/tasks/:id/feedback` with `{ by, text, status? }`; `POST /api/pipeline/tasks/:id/status`. Routes use the 4-digit `pipelineId` ("0338"), not the Mongo `_id`. There is no `GET /tasks/:id`: filter the list.
- A task is worked by the local coding worker only when the owner starts it from the Pipeline page. Nothing merges or deploys by itself.

Ask the owner before any write that changes models, routing, pins or host state.

## Where knowledge lives

| Knowledge | Where |
|---|---|
| Lasting facts and preferences about the owner and the household | Core tool bus `memory_search` / `memory_remember`, or `POST /api/consumers/nestor/v1/memory/notes` |
| What happened in the owner's mail | `POST /api/consumers/nestor/v1/mail-journal` |
| Household documents and guides | `POST /api/rag/search` |
| How AgentX works | product repository docs (`docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/STATUS.md`), not memory |

Owner data stays in the owner's conversation. Sensitive identifiers appear masked; never ask for or reveal their values. Do not store mail summaries, logs or secrets as memory notes.

## Memory review

A scheduled pass reads what the owner said to the agents, has a local model propose what is worth keeping, and leaves the candidates for the owner to accept one by one on the `/memory-review` page. In shadow mode the pass writes nothing to memory. Only the owner's own turns count as evidence, never what an assistant says about the owner.

Collectors are scripts, never agents (`integrations/memory-review` in the product repository). Each machine that holds transcripts submits its observations; one host then finalizes and runs the synthesis. `instance.md` says which machines, when, and where their logs are. One run per UTC date, `memory-review-YYYYMMDD`; a retry the same day ends in `-r2`, `-r3`.

- **Read**: `GET /api/memory-review/digest` (the briefing text), `/api/memory-review/runs?limit=N`, `/api/memory-review/runs/<runId>` (collectors, rejection counts, failure, candidates), `/api/memory-review/insights`, `/api/memory-review/config`.
- **Reading a failure**: `HTTP 503` at synthesis means the model was not available at that moment; the run stays retryable and the next pass resumes it. `cut at max_tokens` means the answer needs a larger `--max-tokens`. A line ending in `wait for the next run` is a per-run bound, not a loss. `candidate bound ... reached` counts the weaker candidates left out.
- **Who spoke**: OpenClaw marks each turn. On a messaging channel that is the sender's verified id. A turn Core injects only proves the page it came from. Turns of an agent passed as `--openclaw-member-agent` are `household_member_statement`: someone of the household, often a child, never the owner; Core never applies a candidate resting on one without review.
- **Manual pass**: the run key is the UTC date, so a manual run can use up the key of the next scheduled pass, which then answers `synthesis already finished` and collects nothing. Pass `--run-key <key>-b` for a manual check. `collect --dry-run` never submits or moves a mark.
- **Adding a machine**: a wrapper that runs `python3 -m memory_review run --runtime claude-code --runtime codex --mode shadow --submit-only --agentx-url <core>`, on a timer shortly before the synthesis host's pass.

Never accept, apply or reject a candidate for the owner, and never reset a watermark without asking.

## Repository work

Read `AGENTS.md`, `README.md` and `docs/STATUS.md` of the product repository first. `instance.md` says where the checkouts are and where the deployed revision is recorded.
