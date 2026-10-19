# Bounded Coding Team PR correction loop

Core owns authorization, selection, task transitions, cumulative budgets and
native model receipts. A replaceable host runner executes one leased attempt.
GitHub supplies observations; it is not a task queue. The loop ends at human
review and never merges, installs or declares product acceptance.

## Authority and states

The singleton `PipelineCodingAutonomy` switch defaults to disabled. Task
`codingAutonomy` records the explicit scope, reviewed intent fingerprint,
heavy-work campaign, linked executions, cumulative usage, observations and
manual interventions. Routing to `agentx-coding` alone grants no execution.
Ideas, personal, Family/Household and profile-scoped tasks are excluded.
Tasks need low risk, a reviewed public/internal review-only automation intent,
complete dependencies and an open availability gate. Selection uses priority,
six-hour aging and a stable task-ID tie break. Native claims and the existing
singleton automation slot prevent another worker from taking owned work.

```
authorized queued → dispatching → preparing → work/tests → publishing
                                                        ↓
review ← native worker verdict/release ← published PR → waiting_ci
                                                        ↓
                               correction → new linked execution
                                                        ↓
                             ready_for_review / blocked / closed
```

Each correction keeps the same task, branch and PR and creates a new requestId
linked to its predecessor. A repeated network request only reconciles its
original identity. Completed native attempts remain immutable. Core can observe
several PRs while one host worker runs. Observations have their own cadence,
separate from the shared heavy-work dispatcher, and each sweep reads at most
two due PRs, oldest first. Failed reads back off to five minutes.
Queued CI failures continue observing the same commit while paused or blocked
by the resume limit. A successful CI rerun can reach `ready_for_review` without
another worker; its waiting time consumes the existing cumulative CI budget.
Human review requests, source conflicts, stopped tasks and active corrections
retain their own execution barriers.

The runner preserves source checkpoints before fetching only `main` and the
exact task branch. It merges remote operator contributions and current main
without force pushing. Conflict versions stay in the isolated checkout; the
Coding Team edits and tests them while the runner controls Git metadata.
An interrupted merge preserves its index and local resolution. A second
upstream conflict receives a bounded new coding turn after native release.

The worker has no network, Git write access, GitHub credentials or production
checkout. Runner-only relay headers bind every inference to its existing task,
request and lease. Core records the call before native dispatch, checks the
frozen model/host/context/artifact capacity, and persists terminal evidence
before returning the stream's terminal frame. Unknown model outcomes retain
the fence. Core charges at least the native call count and union of native
request intervals, including after a stale runner counter or restart. Each
inference receives a Core deadline from the remaining cumulative model budget;
deadline cancellation does not prove native model termination. The approved
campaign must cover the frozen host before admission.

## Publication and observations

Independent verification uses a native command profile, not a task-provided
shell command. The dispatcher profile runs the coding Python suites; the bounded
Core profile runs `inferenceRuntimePolicy`. Neither replaces full PR CI or
product acceptance. Dependency edits require separate operator handling.

The autonomous worker receives Core's remaining cumulative work, test, model
duration and model-call budgets, plus the exact installed verification command.
Before each model request, the relay adds a fresh runner budget advisory with
the remaining durations, model calls and no-progress window. It preserves the
worker's complete history and model options; the advisory is not saved back into
the harness history and never grants authorization, credit or useful progress.
The native Core admission and runner limits remain authoritative. A harness
`max-tokens` termination records `model_output_limit` and blocks publication;
it does not enlarge the model's output limit or the task's attempt ceiling.
Model waiting and reasoning consume the model duration budget even when the
work deadline is longer. The same native command supplies the worker's focused
test loop and the runner's independent verification. Unknown profiles refuse
before model execution.

Before publication the runner checks exact authorized paths, all unpublished
commit blobs (including added-then-removed artifacts), credentials, private
paths, generated content, links/submodules, source size rules, test results and
native model termination. The public PR body comes from final changed files
and verification coverage, excluding raw task/model/log content.

Original PR repository, branch, target and open state are verified before push.
Closed original PRs block instead of creating a replacement. A private durable
publication intent precedes every external effect. After a lost response,
reconciliation reads the exact branch commit, original PR and final description.
It never reruns a worker, pushes again or repeats a PR mutation while the result
is unknown. A saved exact native verdict is replayed through Core's existing
result fingerprint and release path. Missing proof stays held for an operator.

GitHub observations identify the exact tested SHA. Old check runs cannot certify
the published commit. Five repository checks are required: `tests (core)`,
`tests (benchmark)`, `tests (rag)`, `tests (data)` and `compose`. Pending or unknown
mergeability waits; failures, cancellations, timeouts and conflicts trigger a
bounded correction. Skipped/neutral and unconfigured checks remain unverified.
Successful checks also disclose which verification steps ran or were skipped
as out of scope. Failure summaries, annotations and bounded job diagnostics are labelled
untrusted evidence in the next worker prompt; they never become runner commands.
Repeated diagnostics against the same diff block. The loop makes no model call
just to wait.

## Operator procedure

1. Review one engineering task, its public source scope and dependencies. Use
   exact file paths and an installed independent verification profile. Scope
   changes invalidate execution authority instead of silently widening it.
2. Submit an operator campaign through the installed entrance from the instance
   sheet and [the heavy-work queue](HEAVY_WORK_QUEUE.md). Link the coding session
   and Core task or GitHub issue, exact hosts, estimate and permitted window.
   A synthetic manifest is:

   ```json
   {
     "key": "synthetic-coding-campaign-v1",
     "title": "Bounded synthetic coding qualification",
     "kind": "other",
     "hosts": ["http://gpu.example.test:11434"],
     "estimatedMinutes": 120,
     "notBefore": "2030-01-01T10:00:00-05:00",
     "startBefore": "2030-01-01T12:00:00-05:00",
     "source": {"type": "coding", "ref": "coding-session-reference", "taskId": "0123"},
     "executor": {"mode": "operator", "receiptRef": "private-receipt-reference"}
   }
   ```

3. Reserve the approved slot in Cluster Schedule. In Pipeline's **Coding Team
   autonomy**, confirm the reviewed scope and use **Begin the approved campaign
   window**. This crosses the existing operator dispatch fence without running
   a command. An already begun campaign is read as the same identity.
4. Authorize the exact task and file scope with that campaign ID. Review budgets,
   then **Enable authorized scope**. Only authorized tasks are selected; the next
   eligible task starts without a separate per-launch confirmation.
   The authorization form exposes all cumulative budgets and the no-progress
   window, plus the installed coding, Core and Benchmark comparison verifiers.
   Durations use minutes and model calls use a count; Core validates every limit.
5. Follow the active request, stages, native unresolved calls, remaining budgets,
   PR SHA/check coverage and manual intervention history. Submit a review
   correction against the current PR commit when needed.
6. At `ready_for_review`, review the draft PR. Human review, merge, installation
   and real product acceptance have separate receipts. Once the campaign's
   scope is finished/stopped, independently verify native release and close the
   same queue request through its operator-finish protocol. The loop does not
   manufacture that operator release receipt.

For Coding Team, Core re-validates the active reservation and its
`startBefore` when it selects a worker, when the runner reads the worker
manifest and on every model call; other heavy-work executors keep their own
window protocol. A `startBefore` that covers only the initial dispatch can
therefore cut off subsequent calls even while the reserved slot has not
ended. Size the reviewed finite window to cover the intended model calls and
corrections, not just the first attempt. A campaign reservation is a planned
slot: it does not grant runtime or native admission or permission to
dispatch. Native admission and the explicit operator begin remain separate
requirements, and an expired window is refused; it is never silently
extended or replayed. An early failed turn keeps its local source checkpoint
and cumulative costs and does not deliver a validated PR.

API base: `/api/pipeline/coding-autonomy`. `GET /` exposes the switch revision,
active request and task projections. `POST /config` requires `confirm: true`,
`enabled` and `expectedRevision`. `POST /tasks/:id/authorization` requires the
current authorization revision, explicit boolean, campaign ID and reviewed
scope. New unowned tasks can receive a normalized low-risk intent through this
review; existing intents must match. `/tasks/:id/review` requires the current
head and bounded text; `/tasks/:id/runs/:requestId/stop` targets one exact run.
The existing private LAN/operator access applies; there is no new account model.

Default cumulative per-task limits:

| Limit | Default and maximum |
|---|---:|
| Corrections after first execution | 2 |
| Work, including preparation and capacity waiting | 240 minutes |
| Tests | 80 minutes |
| Model waiting/generation | 90 minutes |
| Model requests | 128 |
| CI waiting across all executions | 60 minutes |
| No useful source/test progress | 45 minutes |

The separate manual private report profile defaults to 128 calls per execution
and accepts an explicit operator budget up to 256. It does not change these
autonomous cumulative limits. See [private reports](../integrations/coding/README.md#private-markdown-reports).

Worker test observation recognizes the installed Node Jest entry point and
correlates the harness's encoded tool-result envelope with its original call.
Filtered output cannot hide a failing test or tool error. Only test names,
outcomes and durations enter progress receipts; commands and output stay private.
Recognized display filters and trailing log destinations do not make the same
test invocation and outcome useful again. Test selectors, environment and working
directory remain part of its identity; existing recorded history is preserved.

These limits can be reduced on authorization, never reset by a correction or
reauthorization of a started campaign. Work and the reviewed native attempt
duration must allow at least the native lease minimum of ten seconds.
Repeated source/test fingerprints survive
restarts and resumes; a full progress history blocks instead of forgetting old
states. Heartbeats, reads, cache churn and identical test repetitions are not
useful progress. Existing per-stage and soft/hard worker guards also apply.

**Pause** prevents new work and corrections; a current worker and observations
continue. **Remove task authorization** fences future execution. **Cancel waiting
and future corrections** ends CI waiting without signalling another job.
**Stop this exact worker** persists a stop fence and requests cooperative host
cleanup for its task/requestId. A stop before receipt closes that identity under
the launch lock; a delayed launch cannot resurrect it. Waiting capacity is
cancelled through its native owner without consuming a model attempt.
A closed campaign window before claim ends with `queue_window_closed` after
that exact waiting capacity is released. Native acquisition is journaled before
admission; a lost accepted reply is reconciled by its original request and
release receipt. If no authoritative receipt exists, or the native owner is
quarantined, cancellation retains the request and requires native recovery.

Stop acceptance and entry into publication share the host lock. Publication may
already have begun: that stop is explicitly refused and its actual PR receipt
remains visible. Future corrections are fenced. Worker exit, native model
termination and workload release are separate facts. An absent process, expired
lease or lost receipt proves none of them. Preserve checkpoints and reconcile
through the native owner; do not delete admissions or quarantine.

## Reconcile a stopped execution

An expired coding workload with a received blocked worker verdict retains its
native fence. Before deploying Core, its owner can run
`node scripts/recover-coding-capacity.js prepare <private-intent.json>` once in
the reviewed Core image, using the instance's external environment/database
and network. This command starts no server and invokes only Core's coding owner.
The intent contains `pipelineId`, original `requestId`, a stable `key`,
`confirm: true`, `workerTerminated: true` and confirmation
`ORIGINAL_CODING_WORKER_TERMINATED_RECOVER_NATIVE_CAPACITY`. Independently verify
the exact host unit stopped first; pause autonomy and withdraw authorization.
The command checks the original host receipt and durable native verdict,
journals the original persistent resident set, and adopts the existing recovery
identity. Active children, foreign workloads, maintenance or changed topology
refuse. It never substitutes a new workload or caller-provided principal.

Keep that adopted fence while the instance operator recovers any UNKNOWN child
through its native owner. A controlled restart must follow the queued campaign
and installed host-unit procedure; preserve its exact restart timestamp and
received receipt. Restart recovery records a durable, idempotent native release
receipt, retaining the original UNKNOWN evidence. After restoration, run the
same command with `recover-children` and the verified native `restartReceipt`
in the private intent when recovering the original coding parent's children;
Core derives their exact proofs from its prepared journal. Then run the
same command with `complete` and the same private intent. It checks the complete
persistent resident set, digests, contexts and aggregate GPU bytes before VERIFIED,
RESTORED and atomic parent release. Unresolved children still refuse. On a lost
answer, reconcile the same key and original receipt, never repeat a restart.
For a deployment blocked by that original fence, a reviewed recovery candidate
may be mounted read-only into the installed Core image for this one-shot command;
record its exact source revision and hashes outside Git. This is operator
reconciliation, not autonomous delivery or an installation of the candidate.

Pause autonomy and withdraw the original task authorization. After independently
verifying the original worker termination and native resource release, close its
original operator campaign through the heavy-work queue. In Pipeline, confirm
that verification and use **Reconcile this original execution**. Core reads the
exact host receipt, completed native attempt, received campaign receipt and raw
runtime authority. Maintenance or overlapping active/unknown admissions refuse.

`POST /tasks/:id/runs/:requestId/recover` requires `confirm: true`, confirmation
`ORIGINAL_WORKER_TERMINATED_AND_NATIVE_AUTHORITY_RELEASED`, a stable `key`,
`expectedRevision`, every unresolved `callIds`, and the original campaign's
received `receiptRef` and `receiptSha256`. The reference is evidence metadata;
Core does not open a caller-supplied file. Archived campaigns remain readable.
Changed evidence under the same execution refuses. A lost response is reconciled
with this same identity, never with a new worker or model invocation.

Core fences activation, durably prepares and confirms the recovery, then releases
only the original selection slot. A lost first acknowledgement retains the fence
until the same recovery is re-acknowledged. A confirmed recovery survives restart.
The run closes administratively as `stopped`, with conservative cumulative usage
and an explicit `operator-reconciliation` intervention. Original model receipts,
pending-call history, native attempt evidence and PR remain intact. Recovery is
not native model success and does not qualify autonomous coding or authorize a
stopped task to resume. New work requires its own task authorization and campaign.

## Installation, activation and rollback

Review the PR and complete CI first. Merge, normal installation and persistent
activation each require the owner's specific approval for these changes.
Re-read served revision and concurrent work before the approved install. Use the
instance's existing `agentx action deploy --services core --revision origin/main`
with its stable actor, clean checkout, maintenance/LEAD owner and native admission.
The host runner loads modules from the same installed AgentX checkout; compare
its module hashes with the approved revision before enabling. Do not restart
other services or interrupt workloads to force admission.

After installation, the singleton still defaults disabled. First enable only a
synthetic exact-file task, a bounded campaign and reduced limits. Preserve the
installed model/context contract. Persistent broader activation follows separate
qualification and scope approval.

Rollback starts by pausing and removing future authorization. Stop the exact
active worker if needed and prove native termination/release before changing the
runner. Preserve Mongo journals, host receipts, Git checkpoints and PR history.
Use the normal reviewed revert on main and native maintenance procedure; never
clear coordination records as rollback. A restart or revert does not authorize
resuming an uncertain execution. The manual **Run one task** control remains.

## Controlled qualification

Use a distinct synthetic task and new fixture files on its own branch. The
Coding Team first writes a small helper and tests, then publishes a draft PR.
Submit exact-head review feedback requiring a new observable helper behavior,
or create a conflict in a disposable synthetic fixture. The operator supplies
the condition/test, while the Coding Team writes the correction. Observe a new
linked request updating the same PR and exact-head successful CI, followed by
`ready_for_review`. Preserve both attempts and native release receipts.

Qualify targeted stop during waiting and work, and the publication lock, while
another unrelated job remains unchanged. Record actual worker exit and model
termination separately. Repeat lost-response/restart scenarios with durable
identities. Keep live manifests, host inventories, raw logs and dated results
outside Git. Any operator correction of worker source is labelled assisted and
cannot count as an autonomous result. Live qualification is tracked in
[issue #681](https://github.com/WindriderQc/AgentX/issues/681).

### Explicit continuation after administrative recovery

A recovered failure is still a failure. `authorization` cannot reset its spent
budget or history. With autonomy paused and its active slot free, an operator can
POST `/api/pipeline/coding-autonomy/tasks/:id/runs/:requestId/continuation` for the
exact last administratively recovered execution. Confirm with
`CONTINUE_RECOVERED_CHECKPOINT_WITH_ADDITIONAL_BUDGET`, a stable `key`, current
`expectedRevision`, exact native `head`, a new active operator `queueRequestId`
linked to the same task/coding session, reviewed `verificationProfile`, correction
`text`, `additionalRuns` and explicit `budget` credits for `workSeconds`,
`testSeconds`, `modelSeconds`, `modelCalls` and `ciSeconds`.

Each grant is bounded by the normal per-campaign caps. The additional worker
count replaces any unused resume allowance and remains within the original
reviewed native attempt ceiling. The original limits, spent costs, attempts,
UNKNOWN and pending receipts remain unchanged. A recorded operator intervention
starts a new no-progress window without erasing the source/test history. The
next request links to the recovered request on the same card and private branch;
the runner refuses an absent, dirty or substituted checkpoint before model work.

Activation is fenced until the grant write has been durably acknowledged. After
a lost reply, reconcile the same key and fingerprint; never submit a replacement
grant. Retrying adds no budget and creates no worker. This procedure records an
operator continuation; it does not turn the earlier failure into autonomous
success or authorize arbitrary scope changes.

A clean unpublished native budget or no-progress stop uses the same endpoint
with `CONTINUE_NATIVE_CHECKPOINT_WITH_ADDITIONAL_BUDGET`. This is a distinct
authority: the exact latest worker must be finished and recorded in Core, its
model journal must contain only uniquely identified completed calls with their
durably acknowledged Core settlements, and its native attempt must retain the
matching failure receipt. Core admits each journalled inference through the
native capacity and lease. A late settlement can be observed after the failed
worker's verdict without replacing or upgrading that verdict. First pause autonomy,
withdraw this task's authorization and finish its original campaign as failed
through the operator entrance. Then name a new active campaign and the exact
clean checkpoint. No administrative recovery is invented. Operator stops,
runner errors, active admissions, publication and unresolved calls refuse this
path. Original costs, failures, limits and the native attempt ceiling remain
unchanged; explicit credits and a new no-progress window are journalled as an
operator intervention.

### Reviewed terminal continuation and native attempt limits

Pipeline offers **Record reviewed continuation** for a stopped, unpublished
failed checkpoint with authorization removed and autonomy paused. The operator
reviews a new campaign, five additional budgets, the correction and the total
native attempt limit. Its separate confirmation is
`CONTINUE_TERMINAL_CHECKPOINT_WITH_REVIEWED_ATTEMPT_LIMIT`. The continuation API
also requires `expectedNativeAttemptLimit`, `nativeAttemptLimit` and
`expectedAutomationFingerprint`. Worker exit, output limit and failed tests
can use this reviewed path only when the matching native terminal failure and
every current model settlement are durably received. Operator stops refuse.

The native ceiling is at most ten attempts; a grant authorizes at most three
additional workers. Each credit retains the ordinary per-campaign cap, and the
cumulative limits, including the original allocation and every earlier grant,
are at most 57,600 work seconds, 19,200 test seconds, 21,600 model seconds,
512 model calls and 14,400 CI seconds. An amendment changes only the native
attempt ceiling, saves the complete original intent and basis, and atomically
records the normalized fingerprint, current basis and grant. An existing plan
refuses a changed ceiling until its binding is reconciled. Original attempt
counts, scopes, limits, costs, failures and UNKNOWN receipts remain recorded.
The older confirmations cannot extend the native ceiling or accept worker exit.
A lost response still requires the same key and intent; the grant never launches
a worker inline.
The cumulative envelope also applies to older confirmations after a reviewed
amendment. A known validation refusal after selection is fenced, but before a
grant write is attempted, records a durably acknowledged abandonment that
invalidates concurrent grant writes before releasing this exact slot. A lost
abandonment acknowledgement retains the fence until the same intent is received
again. Only a confirmed, unapplied abandonment allows review of a new intent;
an uncertain grant write still requires reconciliation of its original key.

### Finished deliveries and qualification archives

Finished PRs remain observable while execution is paused or authorization is
removed. A bounded, backed-off read records merge/closure and the newest checks
on their exact remote commit, with the original worker head retained. It does
not change attempt outcomes, costs, execution authorization or task status.
Merge and failed CI can both be recorded. Human acceptance, installation and
product acceptance remain separate receipts. A closed PR refuses new review
corrections through the coding loop.
The separate `ciObservationActive` status fact describes the budgeted campaign
watch only: finished, unowned publication in `waiting_ci` or an authorized
failure/resume-limit watch. Human review, conflicts, stopped/closed or owned
executions report false. The panel explains exact-zero exhaustion for each
budget and retains uncertainty disclosure for historical UNKNOWN receipts even
after confirmed administrative recovery.

An operator can **Archive qualification** with a private receipt reference,
SHA-256, reason and outcome (`passed`, `abandoned` or `superseded`). The API
`POST /api/pipeline/coding-autonomy/tasks/:id/disposition` requires confirmation
`ARCHIVE_QUALIFICATION_WITH_ORIGINAL_RECEIPTS`, the exact latest `requestId` and
`expectedRevision`. The worker must be finished with authorization removed and
without an active claim. This is an operator annotation, not task delivery:
the task status and its dependency barriers remain in force, including original
UNKNOWN outcomes. An identical retry preserves the same annotation. Archived
qualifications and closed tasks remain accessible through the history toggle;
the live panel counts waiting work, blocked cards and review separately.

`agentx-benchmark-artifact-tests/v1` is a native network-isolated verifier for
`artifactComparison*`, paired statistics and paired regression tests. Its Jest
configuration comes from the installed runner, rather than the worker checkout.
Loopback HTTP fixtures are permitted; production services and databases are not
reachable. Independent review and full CI must still accept the published commit.

The coding model route preserves up to 120 seconds (one quarter for shorter
budgets) for completion. Core refuses fresh calls inside that reserve before
journal/admission. The runner stops source work before the hard model ceiling and
drains existing Core connections under heartbeat within the remaining work/model/queue
budget, including after a worker disconnect. EOF alone does not prove successful
inference: only the native Core receipt can permit publication and resource
release. An unfinished or uncertain native call retains UNKNOWN and its fence.

An unpublished worker checkpoint with an exact received native `tests_failed`
verdict and completed model calls can receive a bounded local correction. Core
retains the original operator review guidance, charges the failed run and links
the next worker; the native feedback carries bounded test diagnostics as
untrusted data. Operator stops, exhausted budgets, unknown runtime outcomes and
published PR review remain subject to their existing gates.


## Private report authority

Manual reports use the original Pipeline task and its explicit result selection.
They do not borrow a Git attempt or reset the autonomous code envelope. Core
records immutable report grants, their terminal parent/checkpoint, campaign,
source, specification and all historical usage. A new execution receives a new
identity only under those finite credits; a lost reply reconciles the original
identity. Earlier active or uncertain report calls and unreceived allocations
retain their fences, including when a parent is omitted. An operator stop needs
a subsequent explicit grant before more work.

Campaign identity, task, host, dispatch and window are checked at start and before
native model dispatch after admission. Each call remains subject to Core's native
runtime admission. The deadline covers the runner preparation time and cannot
move on replay. File capacity is reserved under the task CAS for every promised
checkpoint. No automatic report restart, merge, installation or acceptance is
introduced. See the [report workflow](../integrations/coding/README.md#private-markdown-reports).

### One-click resume (#878)

A stopped or new report resumes from the task drawer with one choice: **As
soon as possible**, **Tonight** or **At a time**
(`POST /api/pipeline/tasks/:id/report-resume`, previewed by `GET`). Core:

- reads the remaining documents from the latest run's coverage and turns them
  into a safety budget (calls, work seconds, executions) shown to the owner
  rather than asked; the per-document cost is conservative until the lane has
  agent measurements;
- records a report campaign it owns in the heavy-work queue (`kind: other`,
  `executor: { mode: 'pipeline-report', pipelineId }`, key
  `report-campaign:<task>:<checkpoint>`), places it with the "When" choice and
  marks it to start automatically;
- at the slot, records the grant on that campaign and launches the worker from
  the saved checkpoint with a request id derived from the campaign, saved
  before the host call;
- settles the campaign itself when the report is delivered or stops for good
  (no continuation left under it). A refusal before the worker launch releases
  the campaign with a `core:not-started` receipt instead of an uncertain fence.

The work ends on progress, not on a clock: a stop whose saved bytes equal its
parent's is `no_progress` and is not continued; blocked documents raise an
alert. "Chain the executions automatically" is a per-task consent that lets
the continuation loop chain this task even while the global switch is off.
Cloud escalation stays an explicit per-task choice under the owner's cost cap.
The full form (manual campaign, limits, scope, instructions) stays under
Advanced.
