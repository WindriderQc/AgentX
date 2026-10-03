# Architecture

## Components

| Component | Responsibility | Runtime dependencies |
|---|---|---|
| `core/` | Express UI/API; conversations, inference and routing, tools/tasks, memory, attachments, runtime coordination; hosts the surfaces | MongoDB; selected inference endpoints; Benchmark/RAG APIs |
| `benchmark/` | Model evaluations, profiles, scoring, judging and comparison | MongoDB; Core; selected inference endpoints |
| `rag/` | Ingestion, chunks, embeddings and retrieval | MongoDB; Qdrant; Core embedding proxy |
| `data/` (optional) | Filesystem/network inventory, GPU telemetry, feeds, exports and janitor operations | MongoDB; explicitly configured collectors, roots and feeds |
| `shared/` | Cross-service contracts, utilities and the local test harness | None; no separate service |
| `integrations/` | Host-native adapters: OpenClaw tools, coding team, Secretary, operations helpers, memory-review and Data collectors, benchmark harness broker | External instance settings |
| `skills/` | Portable authoring capabilities and format validation | Explicit consumer invocation |

Each service keeps its own process, `package.json` and test suite. One Compose
definition and one launcher (`agentx` / `agentx.ps1`) run them all.

Compose defaults to project `agentx` and `agentx_canonical_*` volumes. Selecting
another project isolates container names, networks and `${project}_canonical_*`
volumes. Application ports are loopback-only, 3180–3182 (Data 3183). MongoDB and
Qdrant stay internal.

Distribution uses optional profiles and capabilities from this one repository.
Concrete host settings, credentials, personal data and backups are external
runtime material. There is no separate private operations repository.

## Ownership

Surfaces (Nestor, Household, PsyX, the model workbench) compose personas, domain
policies and reusable Core capabilities. Core owns canonical conversation,
inference/routing, memory/RAG access, tools/tasks, files/images, events/jobs and
observable execution. OpenClaw, Telegram and other external harnesses use those
capabilities and can be replaced without moving canonical data or business rules.

A capability (ledger, mail triage rules, tasks) lives in Core. An agent is an
isolation boundary in the harness: its own tools and permissions, memory,
session history, channels and scheduled jobs. A team member such as the
Secretary (`secretary`, Gmail) or the accountant (`comptable`, finance) is an
agent because one of those differs from the personal assistant's. A
personality is presentation only (name, tone, voice) laid over an agent;
several personalities can share one agent and none widens its permissions. A
personality may declare the agent it belongs to (`agentId` in the Household
catalog), which gives Super Dad its team cards and a member's voice. A
scheduled job runs on the agent that owns its capability, in isolated sessions.

Chat and consumer routing are not yet fully converged on one path. Family and
child memory and tools stay scoped even where the mechanism is shared.

Task routing sends each task type to its configured model and host. Light
tasks (quick reactions, short Nestor answers, RAG helpers, the janitor) may
carry an instance-configured fallback ladder: when the primary is unavailable
before dispatch, the first rung that passes the same claim, admission and
quarantine checks answers, and the reply is marked degraded. Every other task
is strict and never changes model
([configuration](OPERATIONS.md#light-task-fallback-ladder)).

### Fallback matrix

Four mechanisms may retry or substitute a model call. None escalates to cloud.

| Mechanism | Applies to | Trigger | Requested vs used | Replay of an executed request | Control |
| --- | --- | --- | --- | --- | --- |
| Transport retry (`core/src/services/routing/inferenceRetry.js`) | Trusted-runtime inference (`runtimeServices.inference.execute`) whose caller opts in; today OpenClaw pipeline turns. Household turns and OpenClaw conversations only wait for a reserved host to yield. | Failure marked `retryable` and `safeToRetry`: workload reservation or transient admission conflict, request not sent, provider 429/503. Up to 6 attempts within 120 s, exponential backoff. | Same model and host; attempts and causes reported as `retry` progress. | No. An unknown outcome is not retryable, and a returned stream is never re-entered. | Caller option `retry.enabled`; interactive wait at most 60 s. |
| Task fallback ladder (`core/src/services/routing/taskFallbackLadder.js`) | Seven light tasks with a configured ladder; strict tasks never degrade. | Before dispatch: primary unconfigured, down, claimed, held, blocked, quarantined, busy or VRAM-spilled. After dispatch: one move to the next rung on a refusal proven before output. | `fallbackFrom` / `fallbackTo` marker, `X-AgentX-Degraded*` headers, `routing.degraded` on chat. | No. Only pre-dispatch refusal codes or `ollamaRequestNotSent` move the request (`refusedBeforeDispatch`). | `AGENTX_TASK_FALLBACKS_JSON`, `AGENTX_TASK_FALLBACK_WAIT_MS`. |
| Degraded fallback (`core/src/services/routing/degradedFallback.js`) | `/api/inference/generate` and Core inference for `quick_chat`, `buddy_reaction`, `nestor_answer_light`, or a route-managed request with `allowCrossModelFallback`. | Connection failure, pre-response timeout, HTTP 502/503/504, verified missing model. Same model on another approved host, or an operator-pinned qualified model. | `agentx_degraded` (`requested`, `primary`, `actual`, `modelChanged`) and `X-AgentX-Degraded-Primary-Model` / `-Actual-Model`. | Possibly: a non-streamed request that timed out or lost its connection may have run on the first host. Nothing reached the client: streaming requests are never retried, and only one retry happens. | `DEGRADED_FALLBACK=true`. |
| OpenClaw conversation opt-in (`core/integrations/runtime-bridges/openclaw/conversation-fallback.js`) | OpenClaw turns carrying `x-agentx-busy-reply: conversation` on a routed model; cron turns and pipelines never. | Primary busy, down, quarantined or spilled before dispatch (a claim first gets a yield wait), or a refusal before output. Uses the borrowed task's ladder, without tools or thinking. | `X-AgentX-Degraded-Primary-Model` / `-Actual-Model` and a one-line notice at the start of the reply. | No. Only `refusedBeforeOutput` errors move the turn, once. | `OPENCLAW_CONVERSATION_FALLBACK_TASK`. |

### Tasks

Core owns task persistence (`PipelineTask`, atomic `Counter`). Trusted server
consumers receive bounded operations, never models or an ID allocator:

- `runtimeServices.tasks.personal`: create, list, update, complete. Family and
  engineering rows cannot be changed through it.
- `runtimeServices.tasks.family`: launch, check-in, approval, recurrence, cancel,
  reopen. `HouseholdProfile` owns the `household_profiles` collection; the
  household domain keeps its age bands, routines, calendar projections and
  parent-approval rules. Family fields are optional in `PipelineTask`, so other
  task lanes keep their shape.

Coding-worker selection (`/tasks/next`), the exact worker read
(`/tasks/:id/worker`) and the atomic claim share one scope
(`core/src/helpers/workerTaskScope.js`): the `personal`, `family`, `household`
and `secretary` services and the `idea-drop` and `household-*` sources never
enter the coding lane, including after a requeue clears their assignee. Query
parameters do not widen that scope. Human management of private tasks continues
through the task list, detail and editing routes.

Internal task ownership is not browser authorization. The parental gateway
permits child check-in and requires an adult session for parent controls.

`GET /api/pipeline/tasks/:id/eligibility?automation=true` explains the current
engineering-task admission snapshot with the same dependency, time and automation
predicates used by selection and claim. It grants no permission, acquires no slot
and reveals no private dependency content. The atomic claim remains authoritative.

The exact worker read and coding-team preparation attach `planningContext`
(`core/src/services/planningWorkerContextService.js`): the linked Planning
milestones, outcomes and workstreams plus a linked milestone's parent, with a
short "why", success criteria (metric target, target date) and `planning:<id>`
references. Planning stays the authority; the context is computed at read time,
never stored on the task, and bounded (4 items, 2,500 characters). Missing,
archived, non-objective and private links are counted by reference only, and
private task lanes receive none. An item is private when it or any ancestor
(parent or workstream chain, bounded and cycle-safe) has a `private`,
`personal`, `family`, `household`, `secretary`, `finance`, `origin:family` or
`profile:*` tag or a family/household owner; a missing or cyclic ancestor also
counts as private. It is untrusted reference data framed as such in the worker
and planner prompts: instruction-like text in any included field is flagged,
and it never changes the
task scope, tools, budgets, permissions or work mode.

`GET /api/pipeline/attention?scope=engineering|private` pages the open tasks whose
Core next action calls for a human, ordered by rank then `pipelineId`. It reports
an exact total, or a lower bound when its bounded scan does not cover every open
task, and a fingerprint of the full queue so clients signal only real changes.
The two scopes follow `workerTaskScope` and are never merged. The read claims
nothing and consumes neither a slot nor an attempt.
The weekly Planning review reads that same engineering projection for its first
50 delivery actions. It reports the queue's exact total when coverage is
complete, otherwise its lower bound and partial coverage. If the read fails,
the review marks delivery coverage unavailable instead of reusing unscoped
dashboard task rows.

Ideas wait in an inbox before they become work
(`core/src/services/ideaInboxService.js`). Nestor's `add_idea` tool and a
child's explicit idea or reminder in a family conversation each create one
Planning idea in `inbox`, tagged with its origin (`origin:nestor` or
`origin:family`) and kind. Nothing is queued until the parent reviews it on
Dad's Desk ("Idées à trier") or through `/api/planning/ideas/:id/promote`: a
personal task, a pipeline task (`source: planning-idea`, `sourceKey:
idea:<id>`, so a retry reuses it), later, or rejected. A family conversation
also receives a read-only summary of the Kids Room routines; it cannot check
in, approve or reach personal tasks.

### Conversations

Surface sessions and turns use Core's `Conversation` collection through
`surfaceConversationService`. Session settings are embedded in the conversation;
text lives in its normal messages, and the turn's tool, safety, voice and scene
evidence is attached to the assistant message. Transcript, evidence, turn count
and application opening are written in one atomic document update, so native
delivery retries cannot append the same event twice. A scene receipt updates the
original assistant message.

Surface records use a distinct internal user namespace and are not exposed by
the default Playground history API. PsyX transcripts are namespaced away from
ordinary chat.

The Household conversation executor selects Core inference or the configured
OpenClaw native agent loop per session and never replays an uncertain turn on
the other backend. Core inference reports that agent tools are unavailable;
configured OpenClaw supplies native tool receipts.

A household turn outranks evaluation work on a shared inference host. When a
Benchmark workload reserves the host, the turn asks that workload to yield,
tells the person at once that Nestor is waiting (on screen, and aloud in a
browser voice turn), and waits up to 60 s. The
workload keeps its admission and yields only at a prompt boundary, through
`POST /api/nerve-center/workload-admissions/:id/yield-point`; Core never
yields it on its behalf. While yielded, the host admits shared inference, the
workload's own inference is refused as `workload_yielded`, and its TTL is
renewed; it resumes once the household has been quiet for 20 s. A turn that
still finds the host reserved gets a plain French answer: the OpenClaw busy
reply for native conversations, otherwise `HOUSEHOLD_NESTOR_BUSY`. A request
from OpenClaw's conversational provider (the one that asks for the busy reply,
used by Telegram) gets the same priority and keeps the host through its agent
loop; its wait stops at 45 s, under the gateway's provider timeout.

### Voice

Core's `core/public/js/voice` owns browser microphone capture, speech endpoint
detection, echo rejection and cancellable playback. Household and PsyX compose
its conversation loop with their protected session and turn adapters.
`core/src/services/voice` owns the VoiX transport, primary/backup selection,
request-scoped synthesis validation, deadlines through body consumption and
stream forwarding. Both surfaces use these capabilities. Engine error events
are rejected before audio headers are committed, and a disconnected caller
cancels its upstream request without starting a backup request.

The shared speech boundary removes code fences, images, links, table markup,
HTML and presentation symbols from spoken text while preserving prose and
emergency phone numbers. The browser, synthesis proxies and native voice reply
projection use it; stored conversation text stays unchanged. Spoken prompt
guidance is shared, with domain limits composed by each persona.

Browser and native VoiX microphones are hardware adapters. Native sessions,
devices, configuration and the media vault remain on their owning VoiX primary;
stateless transcription and synthesis may use the configured backup. PsyX uses
only its protected routes; choosing a voice never changes shared VoiX settings.
Its initial female Canadian voice preference preserves explicit browser choices.
The browser buffers audio transiently and stops capture when the session closes
or the page is hidden. Native device capture and playback still require their
own device acceptance.

### Attachments

`conversationAttachmentService` owns attachment bytes and extracted document
text in `ConversationAttachment`; user messages hold immutable references. The
capability binds surface, session, pack and scope before upload, download or
context preparation, and rejects an attachment ID from another conversation.
Ollama receives images only after the exact routed model confirms vision
support. OpenClaw receives native image blocks, with bounded earlier attachment
material rehydrated on later turns. Extracted document text is not indexed as
memory. See [attachment behavior and limits](api/NESTOR_ATTACHMENTS.md).

### Memory

`memoryReadService.forAudience` binds owner or household access in trusted
server code and reuses the RAG client and Memory Policy V2 labels. The Nestor
consumer, memory adapter, chat context builder, MCP search and Household
approved-corpus reader share it. It is an information filter, not
authentication: the request ingress still establishes which capability a caller
may use. See [ADR 0002](adr/0002-memory-access.md).

Selected notes live in Core's `MemoryNote` model and scoped `memoryNoteService`.
The Nestor browser editor, voice operations and the OpenClaw `personal_memory`
tool share it; there is no separate note file writer. Pack/space and audience
are bound on the server. Family reads require explicit household/normal labels.
Expired and forgotten notes are excluded, and voice retries cannot resurrect a
forgotten note. Notes are not copied into a second RAG index, so a correction or
forgetting takes effect on the next retrieval. A daily sweep deletes notes that
have been forgotten or expired for longer than `MEMORY_NOTE_RETENTION_DAYS`
(default 30; 0 keeps them).

Native action provenance follows `shared/agentActionProvenance.cjs`. The
OpenClaw adapter derives session origin from host context and configured jobs,
never tool arguments. Native outbound gates inspect that origin, and existing
gateway, mail audit and Nestor receipt projections retain it. Provenance grants
no authority and observes session origin rather than the causal source of an
individual model decision; Core remains the owner of business data.

Dated mail digests do not belong in notes. Core's mail journal
(`MailJournalEntry`, `mailJournalService`) keeps one owner-only entry per thread
or message: when it happened, who, a short summary and a reference to the
private evidence. Recording the same thread again replaces its entry, and Mongo
removes entries `MAIL_JOURNAL_RETENTION_DAYS` (default 365) after the mail's
date. The mail assistant and owner Nestor reach it with the OpenClaw
`mail_journal` tool through `/api/consumers/nestor/v1/mail-journal`; a lasting
fact drawn from mail is still saved as one note. There is no household reader.

Sensitive identifiers (NIQ, NAS, REEE, account numbers named as such, and card
numbers that pass the Luhn check) never stay in a note or journal text when
`IDENTIFIER_VAULT_KEY` is set: `identifierVault` encrypts each value once
(AES-256-GCM) in `identifier_vault` and the text keeps `[coffre: label …1234]`.
Only owner notes and journal entries are sealed. Nestor's
`personal_identifier` tool lists labels anywhere the owner talks to him; the
OpenClaw plugin reveals a value only in the owner's Household session, which
stays on the local network. Core's consumer route itself trusts its unmarked
loopback callers, like the note route. The vault protects data at rest: a
revealed value stays in that conversation's history.

## Access and identity

AgentX is a single-household application on a trusted LAN. It has no user
accounts and is not multi-tenant. Several separate mechanisms decide what a
request can reach; none of them replaces another.

| Mechanism | What it decides | What it does not do |
|---|---|---|
| Runtime profile (`demo`/`full`, `shared/agentxRuntimeProfile.js`) | Which surfaces and APIs this installation serves | Authenticate anyone or restrict who reaches a served route |
| [Parental access](PARENTAL_ACCESS.md) | Whether a browser session, or a bearer carrying the configured code, reaches adult pages and private data through the gateway | Identify a person; it is one shared-device boundary |
| Specialized tokens (for example PsyX native access, runtime bridges, external consumers) | Whether one integration's own routes accept a caller | Grant anything beyond those routes |
| Memory audiences (`memoryReadService.forAudience`, Memory Policy V2 labels) | Which memory an already-admitted caller's request reads, owner or household | Admit the caller; it is an information filter |
| Browser origin guard (`shared/browserOriginGuard.js`) | CORS for AgentX's own origins; refusal of state-changing requests a browser marks cross-site | Stop non-browser clients, or act as adult access or a firewall |
| User identity (`core/src/helpers/userHelpers.js`) | Nothing yet: every request runs as user `default` | Separate people's conversations, profiles or memory |

Requests without browser headers (curl, harnesses, service-to-service calls)
keep the trusted-network contract: backend ports are bound to loopback, and
the LAN gateway is the only browser entry. Exposing a port or a route that
bypasses the gateway removes the parental boundary.

## Surfaces

Core registers surfaces for the `full` profile only; `demo` keeps the
distributable chat/model/RAG/benchmark experience. Personal capabilities such as
finance (`/api/finance`, `/finance`) are in the demo exclusion list of
`shared/agentxRuntimeProfile.js`, and their daemons start in `full` only.

- `core/surfaces/household`: the French home, Nestor, Family, Reader and
  animal-sound UI. Its HTTP and MCP handlers call Core capabilities and declare
  no session, audit, task or profile models of their own. Its Super Dad and
  Famille conversations dock Nestor's GraphysX voxel face (`avatar-dock.js`),
  driven only by observable conversation state: phase, microphone and speech
  level, token rate, tool calls and a busy inference host. A child's counting
  (to 100) or addition (to 20) question gets a look-only 3D picture in the
  page's Images zone: Core recognises it (`math-scene.js`), streams the
  picture, and answers with the exact result itself, without waiting for
  inference; the dock starts the picture on Nestor's first word and GraphysX's
  `<llmx-stage>` draws it. Its applied/rejected receipt is kept once on the
  family turn (`sceneReceipt`), re-derived from the recorded question.
  A conversation reply has a spoken and a shown channel (`reply-channels.js`):
  the model puts screen content in `<show kind="…">` blocks, and Core also
  diverts code, tables, long lists, links, paths and key-like tokens. Only the
  spoken text is streamed as `delta`, stored as `replyText` and sent to browser
  TTS or native VoiX; blocks stream as `show` events to the page's "À l'écran"
  zone (`display-board.js`) and are kept on the turn as `display`. Secrets are
  private-only, shown masked, and stored redacted.
  An image block names a source and search words, never an address;
  `visuals.js` resolves it (SearXNG images, or the Data file index under a
  configured, mounted photo/media root), streams it to the page's Images zone and
  keeps the result on the turn. A picture the OpenClaw agent generated and cited
  as `MEDIA:<path>` becomes an image block relayed from the Nestor plugin's
  read-only gateway media route.
  After each recorded turn a slower local model reviews the conversation in
  the background (`brain.js`, the router's `master_brain` lane): it proposes
  follow-up questions (the page's "Pistes"), revisions of shown content,
  corrections that the next turn's instructions carry as advisory notes, and
  at most one short remark the browser speaks only at a natural pause, unless
  the person chose quiet. It has no tools, saves nothing, keeps its latest
  review in memory per conversation, and a new turn cancels it.
- `core/surfaces/psyx`: uses the Core conversation lifecycle and admitted
  inference. `core/src/domains/psyx` owns longitudinal state and reflection
  rules. After each completed turn a background review (router task
  `PSYX_REVIEW_TASK`, default `deep_reasoning`) writes a conversation digest and
  memory proposals into PsyX state; proposals enter memory only when the user
  accepts them. Browser access uses the shared [parental session](PARENTAL_ACCESS.md);
  native consumers keep a separate access token.
- `core/surfaces/data-toolbox`: UI served by Core, consuming the optional
  Data process over HTTP. It is read-only except for naming a network device
  or marking it known. Collectors are host-native adapters under
  `integrations/data-collectors`; paths, network targets and supervisor
  placement are external configuration.

Core can also load explicitly configured local extension modules; see
[trusted extensions](TRUSTED_EXTENSIONS.md). Runtime bridges and the optional
printer evidence API live in `core/integrations` and are off by default.

## Decisions

Pipeline list/detail and Planning task references use Core's read-only
`agentx.pipeline-next-action/v1` projection. Queue reasons use the claim
predicates; worker freshness uses recorded heartbeats, never `updatedAt`.
Missing or stale heartbeats and expired automation leases request inspection
without proving worker death. Worker feedback, heartbeats or status calls naming a lease that
is no longer the task's active lease are refused (`TASK_LEASE_INACTIVE`). A
terminal feedback write stores a fingerprint of its exact request on the
attempt. An identical retry for that completed lease returns 200 with
`alreadyRecorded: true` and releases only a matching orphan automation slot;
changed requests and older attempts without this fingerprint remain refused.
The projection exposes no dependency content and grants no effect authority.
Task detail also carries `agentx.pipeline-evidence-references/v1`: per-attempt
references built from recorded values only. The one-shot launch request id
reaches the automated claim and is stored as `dispatchRequestId` on the lease
and attempt. Leases appear as one-way `lease-<16 hex>` fingerprints in the
projection and Core logs; the reference is never accepted as mutation authority.
Human task creation, list, detail and editor responses omit raw lease ids from active and
historical attempts. The next-task discovery read does likewise; the scoped
worker read and claim retain the exact id for mutations. Operator status,
feedback, cost-reconciliation and supersession responses also omit raw ids.
Every status change made through Core's pipeline and family/personal task paths
(create, claim, worker verdict, operator status, supersede, task preparation,
family check-in/approval/rollover/cancellation/reopen, personal completion) appends one
`agentx.pipeline-task-transition/v1` event to `transitions[]` in the same
single-document update, guarded on the previous `status` and `transitionSeq`.
The status and its event therefore commit together without a replica set; a
stale writer gets 409 `TASK_TRANSITION_CONFLICT`. An event holds `seq`, `at`,
`from`, `to`, `kind`, `actor` (`declared` as sent, `authenticated` always null
until Core authenticates pipeline callers, `channel` naming the write path),
`attempt`, a bounded `reason` and references (`taskRef`, `attemptRef`,
`leaseRef` fingerprint, `dispatchRequestId`, `supersededByRef`). The store keeps
the last 50 events; summaries read the last 20. `transitionLog.coverage` says
`none`, `partial` or `complete` with a `reason`. New family and personal tasks
use the same event guard and can report complete coverage.
Older documents are not back-filled, and the timeline shows only recorded events.
The event guard is added beside each caller's own filter, never over it.
`GET /api/pipeline/tasks/:id/diagnosis` and the bounded `GET /api/pipeline/diagnosis`
return `agentx.pipeline-task-diagnosis/v1`: a read-only classification of an
active task as `execution_observed`, `planned_wait`, `human_decision`,
`dependency`, `recovery_required` or `unknown`, with the owner of the next step,
the action and the missing evidence. An expired lease is `recovery_required`
and an absent or stale heartbeat is `unknown`; neither is reported as a stopped
worker. Only those two categories carry an escalation key, derived from durable
task state so repeated reads of one episode return the same key. The diagnosis
applies no repair; `observedVersion` pins status, `transitionSeq`, owner,
heartbeat and lease expiry so a future repair can compare-and-set against it.
It does not consult runtime recovery: a task status is not evidence of a GPU
operation's outcome. Private lanes (family, personal, household, secretary,
idea drops) keep their own workflow: they are classified `human_lane` before any
owner or heartbeat rule, and the list scans only the engineering scope.
The existing full-profile alert sweep also scans engineering tasks in bounded
pages. It records one durable Alert per escalation key; an operator acknowledges
or resolves it. The scan never resolves an alert from an absent diagnosis,
because concurrent scans can observe different task states. A unique index
prevents duplicate records even after acknowledgment or resolution. Diagnosis
GETs remain read-only; the alert feed carries no task title, private lane
content or raw automation lease ID.
An operator may pass the complete diagnosis `observedVersion` as `expected` to
`POST /api/pipeline/tasks/:id/status`. Core compares it with the current task
and guards the atomic write on status, transition, owner, heartbeat, attempt
count and exact lease identity/expiry. A mismatch returns 409 without changing
the task; calls without `expected` retain their existing behavior.

Task plans are versioned as `agentx.pipeline-task-plan/v1` revisions in
`planRevisions[]` with a monotonic `planRevision` counter (last 10 kept). Task
preparation records its plan as a revision; other callers use
`POST /api/pipeline/tasks/:id/plan` with `expectedRevision` (409
`PLAN_REVISION_CONFLICT` otherwise). A revision stores mode (`plan` or
`research`), declared author and write path, bounded text and steps, the
automation scope and its fingerprint, the task basis (title, spec, service)
and a revision fingerprint. The API refuses plans over 8,000 characters;
preparation shortens model output and marks it `truncated`. An optional
decision (`POST .../plan/decision`: `approved` or `changes_requested`, signed)
names the exact revision and fingerprint and is stored inside that revision,
so a newer revision starts undecided and never inherits it. Decisions on an
older revision, another fingerprint, a changed scope or a changed task request
get 409. Requesting changes on a queued, unleased task moves it to `blocked`
with its transition event. Plans, their text and their approval grant no
execution authority (`executionAuthority: 'none'`): automation intent and the
explicit one-shot launch stay the only start path, and PR gates and worker
receipt fingerprints are unchanged.
Each automated claim records the current plan revision and fingerprint on its
attempt when a plan exists. The claim compares the revision again in its atomic
task update, so a concurrent plan change prevents a stale attempt and releases
its reserved slot. An attempt without a plan remains valid; the binding does
not approve the plan or change launch authority.

A task keeps the files it produced in `pipeline_task_deliverables`
(`pipelineTaskDeliverableService`), separate from conversation attachments: a
deliverable is keyed by `pipelineId`, optional worker `attempt` and name, never
by a conversation. `POST /api/pipeline/tasks/:id/deliverables` takes
`{name, dataUrl, sha256, by, attempt?, leaseId?}`, applies the same byte checks and 2 MiB
cap as attachments, and stores nothing when the declared SHA-256 differs from
the bytes (422 `DELIVERABLE_HASH_MISMATCH`). Core derives owner (the task) and
scope (`engineering` or `private` lane, from the worker scope rule) from the
task; a worker file must name an existing attempt of a worker-scope task and
present that attempt's active, unexpired lease and assignee. An atomic task
write grants a numbered deposit permit before the file is stored; terminal
feedback that wins first prevents the permit. Deposits without an attempt are
refused for automated tasks because pipeline callers lack a distinct operator
identity. Core stores only the permit number and lease fingerprint in the
deliverable receipt, never the raw lease ID. Manual tasks have no automation
lease and retain the existing declared
`operator_api` upload path; pipeline callers still have no authenticated
operator identity. A retry of the same file is idempotent and a different file under the same name is
409 `DELIVERABLE_CONFLICT`; a task keeps at most 20. Each read returns an
`agentx.pipeline-task-deliverable-receipt/v1` that keeps `storage` (written to
Core's MongoDB), `availability` (`available` after a recomputed digest,
`present_unverified` in listings, `missing`, `corrupt`) and `externalDelivery`
(`none`: Core sends no deliverable to a third party) apart, with
`memory.status: not_indexed`. Download (`.../deliverables/:did/download`)
serves only bytes whose digest matches, as an attachment; an id from another
task is 404. Deliverables live as long as their task; there is no expiry or
deletion path yet.
For automated, leased attempts, the guarded coding dispatcher registers its
bounded Markdown verification report through this API before terminal worker
feedback. It reads and verifies an existing identical report on retry, including
after a lost POST response. If both the POST outcome and its follow-up read are
unknown, it leaves the task in progress for recovery; a definitively missing or
unverified deliverable blocks the attempt instead of marking it review-ready.

Nerve Center reads `live.gpuHealth` from the existing host-preference endpoint;
HTTP reachability stays separate from pin GPU residency. Benchmark's bounded
`GET /api/profiler/recovery` projects existing HostProfile journals without
coordination credentials or runtime mutations. Host/dashboard browser reads
also replace raw journals with the capability-free recovery projection.
See [operational screens](OPERATOR_UI.md) for user-facing states and actions.

- [ADR 0001: one canonical repository](adr/0001-one-repository.md)
- [ADR 0002: reuse existing memory classification](adr/0002-memory-access.md)
- [ADR 0003: ingested content is data, never authority](adr/0003-ingested-content.md)
