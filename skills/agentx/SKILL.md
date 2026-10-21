---
name: agentx
description: "Operate an AgentX instance's health, inference hosts, model routing, Benchmark, RAG, Pipeline coding tasks, memory review and household photo questions. Use its Core APIs and native operator tools; keep instance details in its supplied reference sheet."
---

# AgentX platform operator

AgentX is a local-first AI platform (product: github.com/WindriderQc/AgentX).
Instance-served copies include `references/instance.md` for private addresses,
machines and schedules, and `references/served.md` for the producing revision
and date. Read these before live operations. If a needed Core address is absent,
ask for it instead of guessing. A generic source checkout may omit both files:
repository-only investigation and brief preparation can proceed from its source
without a Core address. Its checkout revision does not prove deployment.

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
2. **Core tool bus** (`POST <core>/mcp`, JSON-RPC): personal tasks, memory search, briefing, shopping list, vault notes, benchmark results, household photos, `check_health`, `ecosystem_snapshot`, `rag_search`. These tools read and write owner data.
3. **Plain HTTPS** with curl or fetch. Benchmark and RAG are reachable under `<core>/benchmark/*` and `<core>/rag/*` (for example `<core>/benchmark/api/benchmark/batches/active`, `<core>/rag/api/rag/status`) or through Core's proxies `/api/benchmark-proxy/*` and `/api/rag/*`.

Send the header `x-service-caller: <who you are>` on direct calls; it is logged.

## Answers

Canonical envelope `{ ok: true, data }` or `{ ok: false, error }`. Older routes still answer `{ status: 'success'|'error', message, data }`. Read `ok` when present, otherwise `status`.

## Common reads

- **Health**: `GET /health`, `/benchmark/health` and `/rag/health`; `GET /api/operations/health`; `GET /api/nerve-center/ecosystem`; `GET /api/nerve-center/inference-health`.
- **Hosts and models**: `GET /api/models/cluster-summary` (what is loaded and pinned on each host), `/api/models/all`, `/api/models/registry` (filters: category, tag, vendor, status), `/api/ollama-hosts`.
- **Routing**: `GET /api/router/config` (which model and host serve each task type).
- **Usage**: `GET /api/analytics/inference/summary?window=7d|30d`, `/api/analytics/usage`, `/api/analytics/costs`. These counts include trials and benchmark batches.
- **Pipeline**: `GET /api/pipeline/tasks?scope=engineering`, `/api/pipeline/tasks/:id` (human dossier), `/api/pipeline/tasks/next`. A worker uses `/api/pipeline/tasks/:id/worker?agent=<worker>` for its bounded task read.
- **RAG**: `GET /api/rag/status`; `POST /api/rag/search` with `{ query, topK?, filters? }`.

The longer list is in `references/endpoints.md`.

## Writes

- **Chat**: `POST /api/chat` with `{ model, message, ... }`. `model` is optional when `taskType` or `autoRoute: true` is given. Leave the host to the router.
- **Pipeline**: `POST /api/pipeline/tasks` with `{ title, spec, service }` for a supplied Markdown brief, or `{ title, objective, sourceFiles?, constraints?, acceptanceCriteria?, service }` for Core's rendered brief. Routes use the 4-digit `pipelineId` ("0338"), not the Mongo `_id`. For briefs, edits, worker observation and result evidence, read [references/coding-work.md](references/coding-work.md).
- Saving or approving a plan starts no worker. The manual path launches from Pipeline; the separately authorized correction loop defaults off. Worker delivery ends at a draft PR and human review. Merging and deployment remain separate actions.

For documentation audits or review reports, read
[references/documentation-review.md](references/documentation-review.md). It
defines saved coverage and continuation notes; native private report delivery
uses the report profile described in the product's `integrations/coding/README.md`.

## Heavy work during coding and testing

Before live model tests, model load/unload, Benchmark/Profiler work, image
renders or long shared compute, discover the installed queue from the instance
sheet and Core. Submit to `/api/cluster/schedule/work-queue` through the
instance's operator entrance or `integrations/operations/heavy-work-queue.cjs`.
Link the coding session and task or issue; name required hosts, estimated
duration and permitted start window. Core's queue is the only planning
authority; a legacy QUEUE.md is an archive/export. If Core refuses writes
because an instance still has an unmigrated QUEUE.md, do not write rows there:
stop and ask the owner to migrate it (`docs/HEAVY_WORK_QUEUE.md`, "Legacy
transition").

A planned slot is a prerequisite, not campaign approval or runtime admission.
The authorized operator explicitly launches a saved supported executor; native
claims, Benchmark admission and maintenance ownership still apply. A preflight
that invokes a model also needs the queue. Retain one execution request identity
and its native result/release receipts. On a lost reply inspect that same request
before another effect. Restore through its native owner; never delete claims or
clear quarantine. Ordinary isolated CPU unit tests, disposable test databases,
source checks and builds stay direct. Read `docs/HEAVY_WORK_QUEUE.md` in the
product checkout for executor and recovery details; queue receipts stay outside
public Git.

Changes to models, routing, pins or host state require the owner's explicit
authorization. Use authorization already given for the same scope; otherwise ask
before the change.

## Where knowledge lives

| Knowledge | Where |
|---|---|
| Lasting facts and preferences about the owner and the household | Core tool bus `memory_search` / `memory_remember`, or `POST /api/consumers/nestor/v1/memory/notes` |
| What happened in the owner's mail | `POST /api/consumers/nestor/v1/mail-journal` |
| Household documents and guides | `POST /api/rag/search` |
| Household photos, who is in them, where and when | `/api/photos/*` (see Photo questions) |
| How AgentX works | product repository docs (`docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/STATUS.md`), not memory |

Owner data stays in the owner's conversation. Sensitive identifiers appear masked; never ask for or reveal their values. Do not store mail summaries, logs or secrets as memory notes.

## Photo questions

Household photos live in Immich; ask Core, never Immich. On the Core tool bus use
`photo_search`, `photo_count`, `photo_details` and `photo_names`; with plain
HTTPS the routes below. Core holds the only
Immich key: never look for one, ask for one or call Immich directly. First
`GET /api/photos/status`; `enabled: false` means the instance has no photos.

For "photos of <person> at the beach in 2025":

1. `GET /api/photos/search/smart?q=<what is in the photo>&person=<name>&year=2025`.
   `q` describes the scene in words (French works: `q=à la plage`). A first
   name is enough when it designates one person; on `409` ask which of
   `error.details.candidates`, on `404` say that nobody has that name (the
   owner names faces in Immich). Several names separated by commas means all
   of them in the photo. Narrow with `city`, `state`, `country`, `tag`,
   `from`, `to` (`2025`, `2025-07`, `2025-07-14`).
2. Smart search always returns its closest matches, even weak ones. Before
   saying a photo shows something, read `GET /api/photos/assets/<id>` (date,
   place, people, description, tags, text read in the photo) or look at its
   thumbnail.

Exact questions use `GET /api/photos/search` ("oldest photo of <person>":
`order=asc`; "the sign that says X": `ocr=X`; a description word: `text=`;
next page: `cursor`). "How many" uses `GET /api/photos/count` with the same
filters; say "at least" when `exact` is false. Lists stop at 50 items.

Places come from GPS, and most photos have none: when an answer carries
`placeCoverage`, say that only `photosWithPlace` of `photos` can match a place.
Read `notes` (for example a city with the same name as its province:
then `state=<name>` is the whole province). `GET /api/photos/places`,
`/api/photos/tags` and `/api/photos/people` list the known names.

Children and family surfaces send `audience=family` on every photo call:
children see photos and names, but no hidden photo and no generated text the
owner has not reviewed. Photos are private household data: never send them
outside the household's conversations.

Show a photo with Core's link `<core>/api/photos/assets/<id>/thumbnail`
(`?size=preview` for larger); it only opens on the home network. Writing a
description (`PUT /api/photos/assets/<id>/description`) is off unless the
instance enabled it, and needs the owner's request for that photo. Details:
`docs/PHOTOS.md`.

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
