# Ops: health, models, Benchmark, queue, memory review

Reading the platform is free; changing it is not. Changes to models, routes,
pins or host state need the owner's explicit OK (already given for the same
scope, or asked first). Exact routes: [endpoints](endpoints.md).

## Health and hosts

- Tools: `check_health` (Core, RAG, Mongo, Ollama), `ecosystem_snapshot`,
  `gpu_status`, `storage_summary`, `network_devices`.
- HTTP: `GET /health`, `/benchmark/health`, `/rag/health`,
  `/api/operations/health`, `/api/nerve-center/ecosystem`,
  `/api/nerve-center/inference-health`.
- Keep timestamps, stale or partial states and unavailable components in the
  answer. A read is a moment: it does not prove a model is active now.

## Models, routing and usage

- What is loaded and pinned on each host: `GET /api/models/cluster-summary`.
  Catalogue: `/api/models/all`, `/api/models/registry` (filters: category,
  tag, vendor, status), `/api/ollama-hosts`.
  Cluster rows retain their existing fields: `online`, `status` and
  `loadedModel(s)` describe this read, with provenance and timestamps in
  `observation`. A fresh `/api/ps` read is `ready` when it lists residents,
  `idle` when empty; neither proves routing admission or full GPU residency.
  Parked endpoints are `inactive`, have no reported residents and are not
  probed; their `topology` carries the existing parking reason and observation
  time. A failed inventory is `unknown`, `online: false`, with no residents
  and an `unavailable` observation; it does not prove the runtime stopped.
  No previous successful inventory is reused. Pins remain declared intent.
  `persistedState` retains the saved status/model hints with unverified
  freshness and no observation time. `declaredMetadata` labels tags and
  `vramReservedMiB` as unverified operator notes, not live service placement,
  measured GPU use or queue reservations. Their declarer and declaration time
  are unknown; `recordUpdatedAt` dates the whole record, including unrelated
  changes. A default zero reservation does not measure zero use. The Nerve
  Center host-preference read exposes the same metadata, with current runtime
  evidence under `live`; its legacy top-level status/models remain persisted.
- Which model and host serve each task type: `GET /api/router/config`.
- Usage: `GET /api/analytics/inference/summary?window=7d|30d`,
  `/api/analytics/usage`, `/api/analytics/costs`. Counts include trials and
  Benchmark batches. Quote the exact window, `observedAt`, scope and
  attribution coverage; no recorded cloud traffic does not prove no cloud use.
- Chat through Core: `POST /api/chat` with `{ message, taskType }` or
  `autoRoute: true`; leave the model and host to the router. OpenAI-compatible
  clients use `<core>/api/llm/v1` (with their gateway client token) and model
  `agentx-primary`.
- Never write a concrete model name into a client or script. Core's host pin
  owns the model and its context.

## Benchmark

- Results and coverage: `benchmark_results`, `benchmark_coverage`; HTTP under
  `<core>/benchmark/api/benchmark/*` and `/benchmark/api/profiler/*`.
- `benchmark_request_measurement` records a request; it does not run one.
- A Benchmark or Profiler run is heavy work: queue it, one batch at a time, and
  wait for `/benchmark/api/benchmark/batches/active` to be empty before the next.

## Heavy-work queue

Core's heavy-work queue is the only planning authority for shared compute. A
legacy `QUEUE.md` is an archive: never add rows to it. If Core refuses writes
because an instance still has an unmigrated `QUEUE.md`, stop and ask the owner.
Product procedure: `docs/HEAVY_WORK_QUEUE.md`.

**Reading and planning.** `work_queue` (owner bus) or `GET /api/cluster/schedule/work-queue`.
Use `summary.counts` before pagination: it separates automatic queue, action
required, recorded dispatch or execution, and uncertainty. Reservations are
counted apart. Explain the actor and step in `presentation.nextAction`, not the
stored state alone. A planning proposal without an executor cannot start.
Qualify task, issue, queue and native execution references and keep their
original identities and observation times. A queue completion does not
close its task or issue.

`work_queue` also files a **planning request** (`action: "request"`): a
stable `key`, `title`, `kind`, `hosts`, `estimatedMinutes`, optional
`notBefore`/`startBefore`, and `source.type: "coding"` with your `taskId` or
`issueUrl` (or `"nestor"`). Resubmitting the same key returns the same
request. It carries no executor, so it cannot start; the owner or an
operator turns it into a run below. `action: "cancel"` with `id` and the
current `expectedRevision` withdraws a requested or reserved one.

**Submitting a custom check** (live model test, GPU test, a turn through an
agent) with the instance's operator entrance (`references/instance.md`; the
product CLI is `integrations/operations/heavy-work-queue.cjs`). Every write
takes `--actor <stable-id>` and the request's current `--revision`:

1. `submit --file request.json`: `kind: "diagnostic"`, `hosts`, `estimatedMinutes`,
   `notBefore`, `startBefore`, `source` (session, task or issue links) and
   `executor: { mode: "operator", receiptRef: "<private receipt path>" }`.
   A stable `key` makes it idempotent.
2. `reserve --id <id> --revision <n> --start <ISO with offset>`.
3. `begin-operator --id <id> --revision <n>` once the window opens. It returns
   a `dispatchId`. If the reply is lost, `show` the request: never begin twice.
4. Run the check, under its native admission or lease, once.
5. Write the receipt (`contract: "agentx.operator-heavy-work/v1"`) with the
   `queueRequestId`, `dispatchId`, the same `receiptRef`, an `actor` equal to
   your `--actor`, a terminal `state` and `runtimeReleased: true` after proving
   the work ended and released its resources, plus the evidence.
6. `finish-operator --id <id> --revision <n> --file <receipt>`.

A planned slot is a prerequisite, not campaign approval. Saved executors
(Benchmark, images, named jobs) run through `run` instead of steps 3 to 6.
Restore through the native owner; never delete claims or clear quarantine.

## Memory review

A scheduled pass reads what the owner said to the agents, has a local model
propose what is worth keeping, and leaves candidates for the owner on the
`/memory-review` page. In shadow mode it writes nothing to memory. Only the
owner's own turns count as evidence.

- Read: `GET /api/memory-review/digest`, `/runs?limit=N`, `/runs/<runId>`,
  `/insights`, `/config`.
- Failures: `HTTP 503` at synthesis means the model was not available then; the
  next pass resumes. `cut at max_tokens` needs a larger `--max-tokens`. A line
  ending in "wait for the next run" is a per-run bound, not a loss.
- Who spoke: turns of an agent passed as `--openclaw-member-agent` are a
  household member (often a child), never the owner; Core never applies a
  candidate resting on one without review.
- One run per UTC date (`memory-review-YYYYMMDD`, retries `-r2`…). A manual run
  uses `--run-key <key>-b` so it does not consume the next scheduled key;
  `collect --dry-run` submits nothing.
- Collectors are scripts in `integrations/memory-review`, never agents. A new
  machine runs `python3 -m memory_review run --runtime claude-code --runtime codex --mode shadow --submit-only --agentx-url <core>` shortly before the synthesis.
- Never accept, apply or reject a candidate for the owner, and never reset a
  watermark without asking.
