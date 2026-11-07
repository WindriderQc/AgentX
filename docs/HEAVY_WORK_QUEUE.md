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

`run` explicitly launches the saved request. Some kinds start without a person
at the slot: an image already accepted by Core's image service, and a Profiler,
embedding reindex, topology or local transcription request whose reservation the owner marked
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
  An explicit preparation refusal is a failed outcome, not an unknown launch.
  The CLI records the verdict and its exact dispatch identity through the same
  `POST /:id/prepared` receipt route (`refusal: {code, reason}` instead of `plan`).
  Core persists the operator preparation receipt before checking native release;
  its observer can reconcile it after a lost reply or restart. Both host/device
  fences are released only after a complete runtime snapshot shows no
  overlapping inference or workload. A held admission or quarantine keeps its
  native owner, and missing release evidence stays fenced. CLI exit 4 reports
  the confirmed refusal; lost preflight replies and unverified outcomes retain
  exit 3 and are never retried. Expiration alone never releases a fence.
- **Profiler**: `{hostId, depth?, skipRecentDays?, modelNames?}` runs the existing
  host queue. Core checks its registered endpoint; the native tracker carries
  the Core request identity for subsequent observation. Exact identity lookup
  includes retained terminal trackers, so a queue that finishes before its launch
  reply is read still reconciles. Inventory reservations remain unconfirmed until
  native claim acquisition; observing one does not overwrite the dispatch fence.
  Terminal trackers remain for 24 hours after
  finishing; a Benchmark restart loses these in-memory trackers and requires
  native journal/operator evidence if Core has not already settled the request.
- **Image**: the existing image request with `actionKey`, `prompt`, profile,
  dimensions, seed and optional archived parent/recipe. Core checks configured
  GPU consumers. Use artifact references instead of large binary payloads.
  A manual `run` stays bound to its reserved worker hosts. While acceptance
  enrolls a still-queued image, receipt observation leaves the dispatch fence
  untouched; only native dispatch ownership supplies a running receipt. A
  concurrent dispatcher observing the same dispatch and operation yields to
  its owner without relaunching or overwriting that image. Other identities
  and expired unclaimed dispatches still refuse.
- **Embedding reindex**: `{model, dimension}` rebuilds every RAG document into
  a new collection embedded with that model, then switches RAG to it (see
  [operations](OPERATIONS.md#switching-the-embedding-model)). The hosts are the
  model's embedding endpoints. Before the dispatch mark Core checks them and
  that RAG does not already serve the model; RAG accepts the build only for a
  request it reads as dispatching, under the request id as build id. The
  Nerve Center's Embeddings section submits and reserves it.
- **Topology**: `{groupId, targetMode, returnTo?, holdMinutes?}` switches a GPU
  host group to a declared mode for the slot, then back to `returnTo` (see
  [runtime topology modes](OPERATIONS.md#runtime-topology-modes)). The hosts are
  every endpoint of the group, in all its modes. `estimatedMinutes` covers the
  switch in (about 5 to 15 minutes), the hold and the switch back. Core runs
  each switch through its own switch workload; the queue only times them. See
  "Topology windows" below.
- **Island run**: kind `other` with `{mode: "island", receiptRef, agent?, minutes,
  memory?, world?}` runs one Clawblox island session (see [Île](ISLAND.md)).
  The hosts are the principal endpoint; `estimatedMinutes` covers `minutes + 10`.
  The CLI's `run` (or `island-watch`, which waits for Core's placement) checks
  its configured runner and the principal before the dispatch mark, starts the
  run once under the request id, and finishes with a hashed
  `agentx.operator-heavy-work/v1` receipt after proving release.
  `island-settle` follows an already dispatched run and never starts one. Core
  never auto-starts it.
- **Transcription**: `{transcriptionId}` names the immutable Core personal-library
  request. Core checks the speech origin's physical GPU mapping, acquires native
  workload admission and starts the same speech service under the queue identity.
  The service's SQLite receipt proves completion and cancellation; no lost
  HTTP response authorizes a replacement. See [local transcriptions](LOCAL_TRANSCRIPTIONS.md).
- **Imported plant identification**: `other` with `{mode: "plant-identify", importId}`
  names a parent-created photo group. The native import observer reserves and
  dispatches one plant at a time; lost outcomes remain fenced. Routing and
  native runtime admission retain their existing owners. See
  [plant folder import](PLANT_IMPORT.md).
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

### Topology windows

A topology request is a window: it switches the group to `targetMode` when its
slot opens, holds that mode, then returns to `returnTo`. A **pooled window** is
one with the pooled mode as target and the daily mode as `returnTo`.

- **Enter.** Core requests the switch `<request id>.enter`. A refusal before it
  starts releases the request's fence, and the next sweep tries again while the
  slot is open. A switch already running on the group makes the request wait.
- **Hold.** The window holds the mode for `holdMinutes` after the switch became
  active. Without `holdMinutes`, it holds until 15 minutes before the end of
  its reservation, which leaves room for the return.
- **Requests inside a window.** A request that needs the window's mode names
  the window with `withinWindow: "<topology request id>"`.
  - It must be reserved inside the window's slot, on endpoints of the window's
    mode. The window and its own requests do not collide with each other; other
    work still does.
  - `place` searches the slot inside the window.
  - A request inside a window does not start until the window has reached its
    mode.
  - The window cannot be moved so that one of its requests falls outside it, or
    cancelled while one is still planned.
- **Return.** At the end of the hold, the window waits while one of its
  requests is still reserved, running or uncertain. Then Core requests the
  switch `<request id>.return-1` back to `returnTo`.
  - **Retries.** A return refused because the group is busy is asked again on
    the next sweep, up to five attempts. After that the window fails, and the
    group stays in the window's mode, which is a known good state.
  - **No flapping.** When the group's next topology window targets the same
    mode and starts within 30 minutes of this window's end, the return is
    skipped (`phase: return_skipped`, with the next window named).
- **Outcome.** The window completes when the return switch is active, or when
  the return was skipped. It fails when its enter switch is refused or rolled
  back. It becomes uncertain when a switch it requested ends uncertain. Its
  receipt names the switches, with `authority: core.runtime-topology`.

A lane request too large for its lane is refused with `LANE_CONTEXT_EXCEEDED`
and the suggestion `queue_for_pooled`. When a pooled window is planned for the
group, the refusal names it in `data.nextPooledWindow` (`id`, `start`, `end`,
`mode`), and its message gives the start time. Nothing switches on a single
request.

### Automatic start and Run now

Reserving a Profiler, embedding reindex or topology request
(`POST /:id/reserve`) accepts `autoStart: true`. It is the owner's consent for that slot only and is refused
for every other kind; changing the slot replaces it. When the slot opens, the
Core observer launches the request through the same path as `run`: executor
host check, durable dispatch mark, window assertion, then the Profiler start or
the RAG build with the queue request identity. A refusal before the mark (host busy, executor changed)
retries on the next sweep while the window stays open. A launch whose answer is
lost becomes `uncertain`, is never retried, and waits for the owner; the
observer finds a build RAG did receive by that identity. `POST /:id/run` with
`expectedRevision` is the same launch for a reserved Profiler, embedding
reindex or topology request inside its slot; Automations → Calendar shows it as **Run now** and
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

The read-only `GET /:id/operator-release?dispatchId=…` returns
`agentx.operator-release/v1` from Core runtime coordination for an exact active
operator dispatch. It accounts for overlapping workloads, inferences, physical
aliases and uncertain holders. Missing runtime evidence refuses; a healthy read
with `runtimeReleased: false` means the original native owner still holds it.
This snapshot grants no release and changes no queue revision. `operator-finish`
rechecks native authority at its terminal write; a holder arriving after the
snapshot still refuses completion. See [the Clawblox adapter](../integrations/island/README.md)
for an external operator consumer with model-free regression tests.

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

The owner MCP bus's `work_queue` tool uses the same operation for agents
(actor `owner-mcp`): it may also file a `coding` source request, still
without an executor, and cancel an unstarted request with its revision.

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
A recovered native receipt resolves its earlier uncertain notice, even while the
request continues running. The alert
and Nestor notification reads prove persistence, not external delivery.
Failures and missed windows before dispatch request the `telegram` channel.
Uncertain results and overdue receipts request that channel at critical severity;
existing active, unsent uncertainty notices are upgraded without reopening
acknowledgments. Completed work and ordinary cancellations stay local, and old
terminal alerts are not retrospectively enabled. The installed Telegram adapter
owns actual delivery, its budget and quiet hours.

A separate observer checks attention every 15 seconds, independently of pending
launch/evidence RPCs. A native dispatch missing its launch receipt becomes overdue
after five minutes. Running work becomes overdue after its estimated execution
duration plus five minutes from dispatch. Operator and island jobs remain
`dispatching` for their execution, so they use that full duration too. The
notification names the original request, resources and receipt owner. Its stable
ID preserves acknowledgment; a returned receipt resolves it. These deadlines
request attention and never prove termination, clear quarantine or relaunch work.
If an attached native receipt becomes unreadable, the regular observer marks the
request uncertain and requests attention immediately rather than waiting for a
possibly multi-hour duration estimate. A matching native receipt confirming execution
restores running observation; missing evidence never starts replacement work.
Operator/island jobs keep their external receipt owner and execution deadline.

The observer reports an unstarted requested/reserved job when its `startBefore`
or reservation end passes, including planning proposals without an executor.
This observation changes no queue state, admission or execution authority. It
uses one durable alert ID per request and missed deadline; repeated sweeps,
archive and acknowledgment do not create duplicates. A cancellation after the
deadline retains `window_expired_before_start` and that exact deadline, so a
consumer's expiry cleanup cannot hide the event. A timely cancellation stays
silent even when observed after the former deadline; legacy cancellations with
no recorded expiry are not guessed to be failures. Dispatching, running and
uncertain requests never become unstarted-expiry alerts.

## Refusal and lost-response recovery

`POST /:id/refused` records `{dispatchId, code, reason}` for an exact native
executor dispatch. It persists the no-start verdict before checking release;
reconciliation consumes the same receipt after a lost reply or Core restart.
Only a complete runtime snapshot with no overlapping workload/inference allows
settlement, with a second check when the queue transition commits. Native owners
retain their admissions and recovery quarantines. The route rejects another
dispatch, a changed refusal or an already recorded native operation. Custom
operator completion uses its own terminal receipt protocol below.

Profiler and RAG use `agentx.queue-launch/v1` for explicit pre-launch refusals,
bound to the Core request and executor kind. With the dispatch identity supplied
by Core/CLI, they publish that refusal to Core before returning their HTTP error.
If this publication loses its response, Core still retains a committed receipt;
if publication is unavailable, a received typed response lets the original
launcher store it. An HTTP status alone, a timeout, an empty lookup or a failed
read never proves no-start. Loss of both receipt publication and response remains
unknown and requests attention; no distributed receipt protocol infers a result
that no owner retained.

| Executor path | Conclusive refusal or retained outcome | Lost-response observation |
| --- | --- | --- |
| Benchmark preparation | Exact plan or typed preparation refusal persists before release checking | Same queue receipt; an unreturned preflight remains unknown |
| Benchmark batch | Preflight/stale-plan refusal before POST, or native pre-insert refusal confirmed by plan-tag lookup | Read the original plan tag/batch; never repeat a crossed launch |
| Profiler manual/automatic | Inventory/filter refusal before claim acquisition publishes to Core; claim failures remain fenced | Exact Core request lookup includes running and terminal trackers |
| Image manual/native | Worker loss before acceptance stores the exact manual dispatch refusal; created operations retain their own outcome | Original action/operation, artifact and restoration receipt; queued acceptance is not a launch |
| RAG embedding reindex | Typed refusal before durable build creation publishes to Core | Durable build ID equals the queue request; create/insert ambiguity remains unknown |
| Topology | Explicit pre-create switch refusal codes; other conflicts remain unknown | Original enter/return switch IDs and native recovery journal |
| Long transcription | Admission refusal persists in the personal request and can repair a missing queue receipt | Original queue/native SQLite identity and persisted admission; no second POST |
| Plant identification | Original import/dispatch and terminal identification receipt | A disappeared process or dispatch gap retains the slot for native reconciliation |
| Pipeline report campaign | Core no-start receipt before runner launch; budget grants remain intact | Original campaign and worker result; a committed grant is never reset for retry |
| Island/operator | Typed island no-start receipt, or hashed terminal receipt with release proof | Original runner/status and operator receipt; no inferred shell termination |

A successful preparation also stores its plan before release checking. A held
native admission therefore delays settlement without discarding the known plan.
The notification deadline applies to every active path above, including paths
whose native evidence still needs an operator. All recovery reads preserve the
original request identity and never authorize a replacement launch.

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

### Load-test results

An operator executor that runs Artillery includes `loadTest` in its existing
terminal receipt. `finish-operator` forwards it with the hash of that exact
receipt; Core uses the same Artillery validator and parser as
`POST /api/performance/load-tests`:

```json
{
  "loadTest": {
    "name": "Synthetic load test",
    "scenario": "synthetic-load",
    "timestamp": "2026-01-02T03:04:05Z",
    "raw_report": { "aggregate": { "counters": {}, "summaries": {} } }
  }
}
```

This fragment supplements the terminal receipt fields above. `timestamp` is
the test's actual execution time, with an explicit offset, supplied by its
executor; Core refuses a missing date rather than substituting import time.
The existing 1 MiB receipt limit applies. Native execution and release evidence
remain the operator executor's responsibility; a parsed report proves neither.

Core validates the report before accepting completion, records its content
hash in the terminal release receipt, then stores a `PerformanceLoadTest` with
`queueJobId`. Server performance reads it through its existing load-test table.
A unique job index prevents duplicates during concurrent delivery or restart.
If a finish response is lost or the result write fails after termination,
repeat the original `finish-operator` command with the same receipt file.
Core reconciles an exact terminal load-test receipt even with the original
revision; active jobs still require the current revision. This
repairs only the result, including after queue archive; it starts no work and
adds no second terminal event. A changed receipt, actor or report refuses.
Manual imports remain available and have no queue job identity.
