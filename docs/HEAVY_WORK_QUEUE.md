# Heavy work from coding and operator sessions

Core owns heavy-work requests separately from personal/family/engineering tasks.
Each request links to its task, coding session or GitHub issue. Cluster Schedule
shows its estimated window beside recurring work. A slot does not acquire a GPU:
native Benchmark, Profiler and image admission/restoration remain authoritative.

## Operator entrance

Use the operator origin from the instance sheet. Core keeps its existing private
LAN human access and native caller attribution; a caller name is not authentication.
The browser-origin guard refuses cross-site writes. Native consumer credentials
and family boundaries remain separate; no maintenance tools are added to Nestor.

```bash
node integrations/operations/heavy-work-queue.cjs list --core <core-origin>
node integrations/operations/heavy-work-queue.cjs submit --core <core-origin> --actor codex --file /path/outside/git/request.json
node integrations/operations/heavy-work-queue.cjs reserve --core <core-origin> --actor operator --id <request-id> --revision <current-revision> --start <ISO-time-with-offset> --priority 5
node integrations/operations/heavy-work-queue.cjs run --core <core-origin> --actor operator --id <request-id> --revision <current-revision>
```

`run` explicitly launches the saved request. Three kinds start without a person
at the slot: an image already accepted by Core's image service, and a Profiler
or embedding reindex request whose reservation the owner marked
`autoStart: true` (see below). No
queued command is executed. Existing approval requirements still apply. Smaller
priority numbers appear first; the owner chooses the slot and launch. Benchmark
uses `<core-origin>/benchmark` unless `--benchmark` names a verified service origin.

A synthetic request (real manifests remain outside public Git):

```json
{
  "key": "stable-request-identity",
  "title": "Profile a selected local model",
  "kind": "profiler",
  "hosts": ["http://127.0.0.1:11434"],
  "estimatedMinutes": 30,
  "source": {"type": "coding", "ref": "coding-session-reference", "taskId": "0123"},
  "executor": {"hostId": "registered-profiler-host", "depth": "standard", "modelNames": ["installed-model"]}
}
```

Supported executors:

- **Benchmark**: `{plan, request}` names the exact existing prepared `bp-…`
  plan and its typed request, including its judge. The hosts cover both exact
  endpoints. The CLI verifies the local plan, uses its existing maintenance
  action/LEAD lease and rechecks the queue window after preflight, immediately
  before dispatch. Its external env/project/receipt configuration is required.
  Queue preparation itself as `{prepare: true, request}` with an explicit judge;
  its returned plan becomes a receipt, not an automatically launched campaign.
  Submit a second linked request with `{plan, request}` to run that plan.
- **Profiler**: `{hostId, depth?, skipRecentDays?, modelNames?}` runs the existing
  host queue. Core checks its registered endpoint; the native tracker carries
  the Core request identity for subsequent observation.
- **Image**: the existing image request with `actionKey`, `prompt`, profile,
  dimensions, seed and optional archived parent/recipe. Core checks configured
  GPU consumers. Use artifact references instead of large binary payloads.
- **Embedding reindex**: `{model, dimension}` rebuilds every RAG document into
  a new collection embedded with that model, then switches RAG to it (see
  [operations](OPERATIONS.md#switching-the-embedding-model)). The hosts are the
  model's embedding endpoints. Before the dispatch mark Core checks them and
  that RAG does not already serve the model; RAG accepts the build only for a
  request it reads as dispatching, under the request id as build id. The
  Nerve Center's Embeddings section submits and reserves it.
- **Diagnostic/other** requests may be planned without an executor or may use
  `{mode: "operator", receiptRef: "<out-of-Git receipt reference>"}` for custom
  coding checks. The explicit operator protocol below starts no command.

Normal isolated unit tests, source checks and builds remain direct. Tests that
invoke live inference, load/unload models, render images, run a Profiler or
benchmark campaign, or occupy shared compute for minutes go through the queue.
Preflight/preparation that invokes a model is itself heavy work.

## State, recovery and history

The shared [work lifecycle](WORK_LIFECYCLE.md) defines task/issue routing and
the read-only `presentation`/`summary` contract. Automatic queue, action required,
execution and uncertainty have complete separate phase counts; reserved slots
remain an independent dimension. Reads never grant permission or probe activity.

`requested → reserved → dispatching → running → completed/failed/cancelled`.
Ambiguous effects become `uncertain`. Intent is immutable. Submission keys replay
the same identity; changed content under a used key refuses. Edits need the
current revision. One Mongo CAS serializes all planned host/device windows using
Core's physical-resource aliases; unmapped endpoints remain independent.

The dispatch mark is durable before the effect. Concurrent sessions cannot both
begin a request. Early/expired manual/API starts refuse. `startBefore` bounds the durable dispatch time, not every subsequent inference. A dispatch recorded within its start window may continue only until its reservation end; it does not admit a late or replacement dispatch. Running/uncertain work
stays fenced after the estimated end. Topology changes require reconciliation.
The Core observer reads existing executor receipts every 15 seconds. It also
dispatches images explicitly accepted by the image service, once, within their
15-minute start window, and Profiler and embedding reindex requests reserved
with `autoStart: true` once their slot opens. It never starts Benchmark/operator requests, repeats
an uncertain dispatch or releases native authority. A completed result
does not settle the request while overlapping native workloads or inference
admissions remain held, including quarantined or uncertain outcomes.

### When: Core picks the slot

`POST /:id/place` with `{ expectedRevision, when, at?, priority?, autoStart? }`
reserves a slot Core chooses (`GET /:id/place?when=…` previews it, read-only):

- `asap`: the first free minute on the request's machines;
- `tonight`: the first free slot inside the night window that also ends in it
  (`HEAVY_WORK_NIGHT_WINDOW`, default `23:00-06:00`, in `PLANNING_TIME_ZONE`);
- `at`: exactly `at`.

Both operations return `HEAVY_QUEUE_CONFLICT` with the blocking requests while
related work is dispatching, running or uncertain. An estimated end does not
promise a reservable slot before that work records its native release. Once
released, the original waiting request can be placed with its current revision.

Placement treats a machine as one resource: work reserved on any of
its endpoints, or on the same physical device, pushes the slot after it. It
honours the request's `notBefore`/`startBefore`; when nothing fits it answers
`HEAVY_QUEUE_NO_SLOT` with the earliest possible start and books nothing. The
booking itself still goes through `reserve`'s overlap check. The same
placement (`shared/heavyWorkPlacement.js`) plans the Profiler's lane campaign.
Automations → Calendrier's slot dialog offers the three choices and shows the
slot before saving.

### Automatic start and Run now

Reserving a Profiler or embedding reindex request (`POST /:id/reserve`) accepts
`autoStart: true`. It is the owner's consent for that slot only and is refused
for every other kind; changing the slot replaces it. When the slot opens, the
Core observer launches the request through the same path as `run`: executor
host check, durable dispatch mark, window assertion, then the Profiler start or
the RAG build with the queue request identity. A refusal before the mark (host busy, executor changed)
retries on the next sweep while the window stays open. A launch whose answer is
lost becomes `uncertain`, is never retried, and waits for the owner; the
observer finds a build RAG did receive by that identity. `POST /:id/run` with
`expectedRevision` is the same launch for a reserved Profiler or embedding
reindex request inside its slot; Automations → Calendar shows it as **Run now** and
labels each reservation with who starts it.

The Profiler's **Measure lanes tonight** (and a lane card's **Measure tonight**)
records one request per lane and plans the slots itself: one lane at a time per
machine (two endpoints on one machine still share its memory bandwidth),
machines in parallel, after work already reserved there. A lane whose slot
would end after the window is recorded without a slot. The owner chooses the
automatic start in the preview; Core still refuses any overlapping slot.

Use `reconcile --id …` on demand. Cancel unstarted requests with `cancel --id …
--revision …`. Cancel running work in its native executor, then reconcile.
Profiler tracker loss after restart may require operator recovery; a missing
endpoint never proves termination. After independently verifying termination
and native release, an operator can record the external recovery receipt:

```bash
node integrations/operations/heavy-work-queue.cjs recover --core <core-origin> --actor operator --id <request-id> --revision <current-revision> --dispatch-id <dispatch-id> --receipt <verified-receipt-reference> --confirmation EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED
```

This records **operator reconciliation**, not an independently verified native
result. It refuses while overlapping native authority remains held and never
stops a process, deletes an admission or clears quarantine.

`archive` writes/verifies immutable terminal receipts before removing active
rows. Keys stay deduplicated and `show` still resolves archived identities.
The active singleton explicitly refuses new work beyond 400 requests or 8 MiB (with space reserved for terminal receipts) rather
than dropping history. Archives belong to the same Core database and backups.

## Legacy transition and API

When Core has no queue and `/instance/config/QUEUE.md` is mounted, writes refuse
until migration. `list` returns its digest; `migrate --sha256 …` confirms that
exact snapshot. Core retains the complete Markdown, notes/history included,
and imports waiting rows without guessing dates, durations or endpoints.
Reconcile legacy running rows first. Review each waiting row, submit an explicit
linked replacement and cancel its old imported row.

After migration, Core is the sole planning authority; the old file is an archive.
Cluster Schedule downloads a readable current Markdown snapshot, not a second
scheduler or lease. Migration/export never launches work.

The base API is `/api/cluster/schedule/work-queue`:

- `GET /`, `POST /`, `POST /migrate`: list, submit, confirm the legacy digest.
- `GET /:id`: read an active or archived request.
- `POST /:id/reserve`, `/begin`, `/assert-dispatch`, `/record`, `/cancel`,
  `/reconcile`, `/recover`, `/operator-finish`: bounded transitions.
- `GET /export`: download the current Markdown snapshot.
- `POST /archive`, `GET /archive?offset=0&limit=50`: preserve terminal receipts,
  then page their full records with an exact total.

Runtime manifests, private references and receipts remain outside public Git.
Synthetic/disposable Mongo tests do not prove installation, migration or live
GPU/device qualification.

## Nestor, LeadX and result follow-through

`POST /api/consumers/nestor/v1/work-queue` provides `list`, `show`, `request`,
`cancel`, `notifications` and `acknowledge`. List pages include full status
counts. Show resolves archived IDs too. Nestor submits planning requests, without
an executor, and cannot reserve or dispatch through this capability. Personal
errands remain personal tasks; implementation work remains Pipeline. A queue
completion never marks a linked task or GitHub issue done.

A Nestor proposal has no executor. To carry it into execution, the operator
submits a reviewed manifest with its supported executor and a stable new key,
copies the task/issue references and sets `source.ref` to
`queue-request:<proposal-id>`. After confirming that submission, cancel the
unstarted proposal using its current revision, then reserve/run the execution
request. Keep both IDs as intent and execution evidence. Do not attempt to run
the executor-free proposal or replace its immutable intent under the old key.
Both records belong to this same Core queue; no second queue is introduced.

The native `work_queue` tool uses the private owner session and native run/call
identity. Family and group sessions receive no tool. Configured morning jobs
receive read-only access. Main needs an explicit `work_queue` grant; this adds
no maintenance or command capability. The native personal briefing also reads
up to five pending outcomes without acknowledging or delivering them.

LeadX's existing maintenance tool queues model-probing preparation and approved
starts through `agentxUrl` and an absolute native `queueCommand`. Both hosts and
judge models must be explicit. Starts keep the native allow-once approval and
the exact prepared plan. Conflicts return the queue ID without starting work;
lost replies retain it for reconciliation. The immediate estimates are 10
minutes for preparation and 120 minutes for a batch. Operators can reserve a
different slot in Cluster Schedule before explicitly running it.

Core's image service enrolls every accepted render, including Household and
the workshop. Requests retain full references/recipes in their existing image
record; the queue stores its identity and hash. Waiting images survive restart.
After a dispatch fence has been crossed, startup marks an interrupted operation
unknown and never resubmits it. Multiple images wait in order; native worker
ownership is acquired only for the dispatch winner. The original image ID,
studio link and verified artifact remain the delivery contract.

Terminal and uncertain outcomes enter the existing Core alert inbox with stable
IDs. Archive writes the alert before removing the request. Acknowledgment survives
restart/re-observation; stale-incident cleanup does not expire these results.
An eventual terminal receipt resolves its earlier uncertain notice. The alert
and Nestor notification reads prove persistence, not external delivery. Existing
instance delivery adapters keep their own rules; this feature creates no new
Telegram/email routine.

## Custom coding work

For a custom GPU test, profiler script, model load or shared compute task that
has no native executor, submit the operator executor above and reserve it.
Then explicitly cross its dispatch fence:

```bash
node integrations/operations/heavy-work-queue.cjs begin-operator --core <core-origin> --actor <session> --id <request-id> --revision <current-revision>
```

Save its `dispatchId` before starting the separately authorized native work.
Keep native admission/claims/LEAD ownership throughout the check. If the begin
answer is lost, read the same ID before any effect. The queue CLI runs no shell.
After independently proving termination and native release, write a local JSON
receipt with contract `agentx.operator-heavy-work/v1`, `queueRequestId`,
`dispatchId`, `actor`, the originally planned `receiptRef`, terminal `state`
(`completed`, `failed` or `cancelled`) and `runtimeReleased: true`. Include the
actual test/restoration evidence in that private receipt. Finish with:

```bash
node integrations/operations/heavy-work-queue.cjs finish-operator --core <core-origin> --actor <session> --id <request-id> --revision <current-revision> --file /path/outside/git/receipt.json
```

The CLI validates the dispatch and hashes the exact file; Core keeps that hash
and labels the result **operator attestation**, distinct from a native executor
receipt. Core refuses while overlapping native workloads/inferences remain
held. This never releases their authority or clears their quarantine. An
uncertain custom check stays fenced until its operator can provide this evidence.
