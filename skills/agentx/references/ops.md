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

## Service directory

Start with the domain for the question. Owner and operator reads require
the [authorized instance entry](access.md). A working dependency route
attests reachability at its check time. Use the native functional receipt
for a claim that the service delivered.

| Service or question | Read first | Evidence |
|---|---|---|
| Core and its dependencies | `check_health {includeDetails: true}`, `GET /health`, `GET /api/operations/health` | Per-component verdict and check time. Record Core's revision separately from other services. |
| Benchmark and RAG availability | Gateway `/benchmark/health` and `/rag/health`, or the scoped [Living Source](sources.md) | Service revision and reachability. For stored scores, use [Benchmark](benchmark.md). For document results, use [RAG](assistant.md#memory-and-documents) and cite the returned sources. |
| Runtime, host placement or GPU | `ecosystem_snapshot`, `gpu_status`, Nerve Center | Compare declared service placement, native runtime observations and collector sample age. Use the exact host or service identity in the result. |
| Jobs, pause, backups and agent activity | `GET /api/automations` or **Automations** → Calendar/History. Agent Ops shows runtime evidence and obligations. | Each scheduler owns its job identity, freshness and run receipt. Review pause and incomplete sources before proposing a change. See `docs/OPERATIONS_JOBS.md` and `docs/RECOVERY_SETS.md`. |
| Data, DiskX, Janitor and sensor history | [Data Toolbox and DiskX](data.md). `/energy` reads the configured meter timeline. | Check collector times and data coverage. Keep measured meter readings and estimates distinct. |
| Home Assistant power | Owner `home_assistant_plug` with the configured device key, or Maison at `/dad/home-assistant` | The authorized page lists configured plugs and opens the chosen `?device=<key>`. Read report times for state, watts and optional cumulative kWh. See `docs/HOME_ASSISTANT.md`. |
| Speech, transcriptions or images | `GET /api/voix/health`, `/transcriptions` and its status read, or the image operation's studio link and native `local_image status` when installed | Open the exact transcript or artifact after the native result. Image readiness needs verified bytes and runtime restoration. See `docs/AGENTS_AND_VOICE.md`, `docs/LOCAL_TRANSCRIPTIONS.md`, `docs/LOCAL_IMAGES.md`. |
| World proposals in GraphysX | Owner `propose_world_change` and `world_proposal_status` when the installed Centre is linked | Keep the proposal ID. Verify the page's decision and revision before claiming a world change. See `docs/STATUS.md`. |
| Optional native apps or persona integrations | Nestor's **Pages et services** and the authorized instance inventory | A registered page or persona describes a destination. Read the app or capability's own evidence with its existing authentication. See `docs/NESTOR_WEB_GUIDE.md`. |

To find an unfamiliar service, check [tool discovery](access.md#discover-and-call-tools)
and the product's `docs/STATUS.md` and `docs/ARCHITECTURE.md` at the running
revision. The private instance inventory explains which optional services and
native runtimes are actually installed. If the service has no granted read,
report the missing integration or permission with the supported human entry.

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
- For authorized heavy cloud delegation, first read
  `get_escalation_recommendation` and honor the live budget verdict. If the
  budget read is unavailable, leave delegation pending.
- Never write a concrete model name into a client or script. Core's host pin
  owns the model and its context.

## Benchmark

- To stop a standalone judge calibration at the owner's request, use the owner
  tool `judge_calibration`: `list`, then `cancel` with its exact `id`
  (admissionId), `workloadId`, stable UUID `requestId` and `reason`; `show`
  observes the original admission and its native release. An accepted intent
  is not a stopped model. It leaves child quarantines and queue receipts to
  their native owners and restarts nothing. The HTTP equivalents are under
  `/api/nerve-center/judge-calibrations` (Core). Check the installed catalogue;
  older versions may not expose this control. See `docs/OPERATIONS.md`,
  "Cancelling a standalone judge calibration". Never substitute queue cancel
  for stopping an already-dispatched calibration.

- For results, coverage and Profiler evidence, see [Benchmark and Profiler](benchmark.md).
- `benchmark_request_measurement` records a request; it does not run one.
- A Benchmark or Profiler run is heavy work: queue it, one batch at a time, and
  wait for `/benchmark/api/benchmark/batches/active` to be empty before the next.

GPU driver rollout is host-specific. `docs/GPU_DRIVER_TRANSITION.md` describes
observation, preparation, atomic activation and native abandonment. Preparation freezes every native
qualified capability; new target proofs stay separate from current readiness.
It starts no measurement. Activation requires new compatible proof for the complete
frozen scope, an exclusive native workload and its existing authority journal,
then confirmed Core cache invalidation before release. Retry the same uncertain
operation; never delete its manifest or reopen it under another coordination ID.
Only an unactivated preparation with no unresolved activation may be abandoned
and prepared again through the native action. After activation, a known driver
change updates identity; missing telemetry keeps the identity value without
claiming a fresh measured driver. Prepared Profiler and tool
campaigns retain the heavy-work queue and their exact native claims. Never
rewrite or re-key historical proof to make it valid with a newly known driver.

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

## From free GPU to an open result

1. **Observe availability.** Read `gpu_status` or the Data Toolbox hardware
   read at `GET /api/data-toolbox/hardware/latest`. Compare the timestamp,
   topology, physical GPU and shared lanes with Core runtime inventory and
   Cluster Schedule claims (`GET /api/cluster/schedule/claims`). A free
   utilization sample alone does not grant admission. If telemetry or claims
   are unavailable, say which evidence is missing.
2. **Select useful, eligible work.** Start from the owner's accepted
   [Pipeline need](dev.md#pipeline-tasks), a named approved queue request or a
   [Benchmark coverage gap](benchmark.md) the operator actually wants filled.
   Correlate the task, queue ID and latest `presentation.nextAction`. Check
   pause, dependencies, authority, remaining budgets and start window. A paused
   native producer or unaccepted proposal stays waiting until its owner acts.
3. **Use a compatible executor.** Check the native capability, host/topology,
   model artifact and required profile. For Coding Team check the installed
   executor's supported profile, reachability and whether it accepts new work.
   A Nestor planning request lacks an executor. If authorized, the operator
   submits a reviewed supported manifest under a new stable key with the
   existing task/issue references and `source.ref: "queue-request:<proposal-id>"`.
   Verify the new request before withdrawing the old proposal. For a custom
   check, use the operator receipt path above. Otherwise report whose action
   is needed. Automatic start requires the executor's native eligibility and
   any applicable per-slot consent. Keep manual modes manual.
4. **Read proof of execution.** Follow the original queue and dispatch IDs,
   plus the task/campaign and native run or workload ID. Verify its observed
   start, terminal verdict and release/restoration. A lost reply or a missing
   terminal receipt means unverified or uncertain work. Follow the original
   executor and preserve its admission fences. See the
   [Profiler receipt reads](benchmark.md#inspect-a-profile-or-launch-receipt)
   for an existing measurement request.
5. **Open the result.** Read the linked Benchmark result or Profiler
   profile, Pipeline deliverable, image, transcript or operator receipt.
   Verify it belongs to the same execution, with its date, source and
   artifact identity when available. Report verified, partial, blocked or
   unavailable evidence. Task review, merge and deployment have their own
   receipts.

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
