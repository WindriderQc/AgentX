# Architecture

See [private LAN access and migration](PARENTAL_ACCESS.md) and the illustrated
[local voice ID proposal](VOICE_ID.md). Human access has no account or code;
voice identity is not implemented.

## Components

| Component | Responsibility | Runtime dependencies |
|---|---|---|
| `core/` | Express UI/API; conversations, inference and routing, tools/tasks, memory, attachments, runtime coordination; hosts the surfaces | MongoDB; selected inference endpoints; Benchmark/RAG APIs |
| `benchmark/` | Model evaluations, profiles, scoring, judging and comparison | MongoDB; Core; selected inference endpoints |
| `rag/` | Ingestion, chunks, embeddings and retrieval | MongoDB; Qdrant; Core embedding proxy |
| `data/` (optional) | Filesystem/network inventory, GPU telemetry, feeds, exports and janitor operations | MongoDB; explicitly configured collectors, roots and feeds |
| `shared/` | Cross-service contracts, utilities and the local test harness | None; no separate service |
| `integrations/` | Host-native adapters: OpenClaw tools, coding team, Secretary, operations helpers, memory-review and Data collectors, benchmark harness broker | External instance settings |
| `skills/` | Portable authoring capabilities and format validation; `skills/agentx` is the operator skill, which Core serves as a zip (`GET /api/operator-skill/download`) together with the instance's own sheet when `config/operator-skill/instance.md` exists under the instance root | Explicit consumer invocation |

Each service keeps its own process, `package.json` and test suite. One Compose
definition and one launcher (`agentx` / `agentx.ps1`) run them all.

Compose defaults to project `agentx` and `agentx_canonical_*` volumes. Selecting
another project isolates container names, networks and `${project}_canonical_*`
volumes. Application ports are loopback-only, 3180–3182 (Data 3183). MongoDB and
Qdrant stay internal.

Distribution uses optional profiles and capabilities from this one repository.
Concrete host settings, credentials, personal data and backups are external
runtime material. No other repository holds product or operations code; an
instance may keep a private instance repository for its own configuration,
runbooks and assets ([ADR 0001](adr/0001-one-repository.md)).

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
A cloud model is only ever reached by an explicit lane a surface owner chose:
PsyX's frontier lane sends a turn to an OpenClaw agent
(`core/src/services/frontier/openclawAgentClient.js`) when its user setting asks
for it, and falls back to the local route, visibly, when that agent fails.

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

Personal-task deadlines follow one contract on every write path (the
Household `POST /api/secretary/tasks` and `POST /api/secretary/tasks/update`
routes and the Secretary MCP `add_personal_task` / `update_personal_task`
tools, which share `personalTaskService.parseDueAt`). `dueAt` accepts a date
(`YYYY-MM-DD`) or a full ISO datetime:

- A date names the household calendar day in the configured household time
  zone (`PLANNING_TIME_ZONE`, default `America/Toronto`) and is stored as the
  end of that day — 23:59:59.999 local (`endOfHouseholdDay` in the household
  domain). It is never midnight of the UTC day: for a household west of UTC
  that instant is still the previous local evening, so a task due
  "Sunday, October 4" would otherwise be due Saturday.
- A full ISO datetime, with an explicit offset or `Z`, keeps its exact
  instant unchanged. The lane and overdue projections read that instant as
  stored.
- Date strings are validated as real calendar days before conversion;
  unparseable values are rejected, not silently stored.

`relevantUntil` stays distinct: it dates the activity the task serves and
closes the task once that household day begins; it is never a deadline and
keeps its midnight instant. Day lanes (due today, overdue, briefing) remain
computed in the same household zone as the stored deadline (#292).

Coding-worker selection (`/tasks/next`), the exact worker read
(`/tasks/:id/worker`) and the atomic claim share one scope
(`core/src/helpers/workerTaskScope.js`): the `personal`, `family`, `household`
and `secretary` services and the `idea-drop` and `household-*` sources never
enter the coding lane, including after a requeue clears their assignee. Query
parameters do not widen that scope. Human management of private tasks continues
through the task list, detail and editing routes.

Internal task ownership is distinct from human identity. Human APIs use the
private LAN without an account or code. Check-in and explicit household review
remain separate operations; receipts cannot attest that a parent acted.

`GET /api/pipeline/tasks/:id/eligibility?automation=true` explains the current
engineering-task admission snapshot with the same dependency, time and automation
predicates used by selection and claim. It grants no permission, acquires no slot
and reveals no private dependency content. The atomic claim remains authoritative.

The exact worker read attaches `planningContext`
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

Core's owner-scoped exchange store (`services/conversations/`) preserves the
accepted request and ordered response bytes for Playground chat and streaming.
Authenticated server middleware selects the owner; public receipt fields cannot
select another exchange. Recovery checks content hashes and packet counts before
returning complete content. An identical completed retry replays its stored
HTTP response without another inference; an uncertain or interrupted outcome
never authorizes reexecution. A concurrent local retry can wait up to five
seconds for its original delivery to settle.

Canonical conversations store immutable BSON pages and complete binary payloads
behind an atomic reference in `Conversation`. Model reads hydrate the complete
messages; embedded legacy histories move to pages on their next content write.
Message IDs, feedback, attachments and audit evidence retain their contracts.

A `conversationId` is a continuation handle for the Playground chat endpoints
(`POST /api/chat` and `POST /api/chat/stream`). Core stores every accepted turn
under that id, and on a later call it rehydrates the stored user/assistant turns
into the model context when the caller does not send its own `messages`. An
explicit `messages` array always wins over the stored transcript, so the
Playground browser — which tracks history in memory and resends it — is
unaffected. Rehydration is read-only and owner-scoped: an unknown, archived, or
foreign `conversationId` loads nothing, and the route still refuses such an id
before inference. A connector that posts only the id and the new message still
reaches the earlier turns in the model context, so a stored id stays a real
continuation rather than a storage-only reference.
One durable owner fence spans content writes and canonical publication, including
session counters and conditional review updates in the same root command.
Final writes retain the caller's scope and version predicates; stale saves refuse.
Playground publishers reuse their admitted fence through an owner-bound context.
Search indexes complete current content rather than preview fragments or old
pages, and applies exclusions across the conversation. Full exports hydrate
before writing any output. Missing or corrupt content refuses explicitly.
Publication and erasure share the owner's scope
gate: an erased exchange cannot publish a late first conversation, and a late
browser stopped/failed outcome cannot restore its erased turn identity.

Ordinary admitted Ollama calls preserve complete input with `truncate: false`;
generation and chat also disable context shifting with `shift: false`. The
shared buffered and streaming executors qualify the runtime before admission.
An unavailable or unqualified stable version returns
`INFERENCE_CONTEXT_POLICY_UNAVAILABLE` without dispatch. Benchmark/Profiler
requests retain their exact probes only under a Core-owned workload identity
validated by distributed admission. Internal session-hold warmups retain their
own runtime preparation contract. Neither caller context values nor benchmarked
Modelfiles are rewritten by this policy.

Runtime admission lets several models run on one host at once. A shared
admission conflicts only with the same model under another residency (context,
runner options or keep-alive), which would make Ollama reload it under a running
call. An exclusive model handoff, an UNKNOWN inference and another endpoint on
the same physical GPU still exclude every other admission on that host.

A workload reserves its hosts, except the ones it holds as shared. Benchmark
holds a separate judge host that way and takes no host claim on it: other
callers keep their ordinary shared inference there, beside the judge, and a
household turn does not ask the batch to yield for it. An exclusive handoff
still waits for the batch, and Core does not share a host that sits on the
same GPU as one the workload reserves.

Content writes and erasure share a durable Mongo owner fence, including across
Core workers. Erasure closes admission before waiting for an existing writer,
then deletes the owner's pages, payload chunks and exchange packets. It leaves
only the identity and erasure tombstones needed to reject a replay. A dead writer
or unknown Mongo mutation outcome retains its exact fence: elapsed time does
not prove that a database command stopped, so no TTL steals this ownership.
These primitives work with standalone Mongo and require no transactions.

Surface sessions and turns use Core's `Conversation` collection through
`surfaceConversationService`. Session settings are embedded in the conversation;
text lives in its normal messages, and the turn's tool, safety, voice and scene
evidence is attached to the assistant message. Transcript, evidence, turn count
and application opening are written in one atomic document update, so native
delivery retries cannot append the same event twice. A scene receipt updates the
original assistant message.

Each Household turn captures `speaker {agentId, personaId, personaVersion, name}`,
`performedBy [{agentId, runId}]` and the requested synthesis `voice {provider,
voice}`. Speaker identifies the personality presenting the reply; performedBy
retains native execution and delivery run identities from continuity evidence,
including `deliveredBy` for a requester-settle or background completion. A
consulted agent name alone does not establish its run. Without native execution
evidence, the turn records its session agent with a null run ID. Completed,
deterministic and interrupted turns use the same Household write boundary before
Core persists them. Public audits expose this captured attribution; the `done`
payload exposes speaker both as `data.speaker` and `data.reply.speaker`.
The recorded voice describes the server's requested synthesis, not a playback
receipt. Earlier audits retain their captured identity and voice when session
presentation or instance settings change.

Core's `runtimeServices.conversationRecaps` binds an exact owner/prompt or
surface/pack/scope in server code. The `agentx.conversation-recap/v1` contract
reads the latest confirmed point, prepares an optional local-inference draft and
saves the person's summary, takeaway and next step in `Conversation.sessionRecap`.
Drafts include actual whole-message coverage and write nothing. Saved edits
require the previous recap revision and canonical transcript fingerprint; the
atomic root version refuses concurrent turns or editors. Canonical transcript
references support metadata-only continuity reads. Existing exports and erasure
include the embedded point. PsyX and personal Nestor share its routes and browser
editor, clear private drafts on locking/navigation, and carry confirmed points
as reference context. Family conversations do not receive personal points.

Core's `runtimeServices.conversationPreferences.forOwner` binds an exact server-selected
owner and surface. The `agentx.conversation-preferences/v1` contract reads an
applicable catalog and environment defaults without writing. Explicit overrides
live in `ConversationPreferences`; a unique owner/surface index and revision compare
refuse concurrent editors. Playground, PsyX, personal Nestor and Famille are
independent. A shared browser editor applies presets only after confirmation.
Surfaces use the selected optional context, inference and background-work switches;
saved content remains available for manual reading and export. Settings changes
invalidate obsolete background results without cancelling admitted PsyX inference.
Famille preferences are editable through the private parental space. Access,
transcript integrity and deterministic safety checks remain mandatory. Native
OpenClaw memory, history and tools retain their own configuration authority.

Surface records use a distinct internal user namespace and are not exposed by
the default Playground history API. PsyX transcripts are namespaced away from
ordinary chat.

Execution selection distinguishes local direct inference from OpenClaw, whose
model and agent modes are separate. Provider credentials and the native cloud
catalogue belong to OpenClaw. Core keeps conversation/context persistence and
inference events; isolated model benchmarks use a native SDK invocation without
an agent loop. [Execution sources](EXECUTION_SOURCES.md) defines receipts,
parameter observability, billing and migration validation.

The Household conversation executor selects Core inference or the configured
OpenClaw native agent loop per session and never replays an uncertain turn on
the other backend. Core inference reports that agent tools are unavailable;
configured OpenClaw supplies native tool receipts. The backend is fixed when
the conversation is created; an instance may give new Family conversations
their own choice (`HOUSEHOLD_FAMILY_CONVERSATION_BACKEND`). On Core inference a
spoken turn uses the instance's voice router task and a typed turn the pack's.

A Household prompt is laid out for the model server's prompt cache, which
reuses only the longest prefix identical to the previous request:

- the system message (Core inference) or the instructions (native agent) hold
  what is the same for the whole conversation: the pack, memory and mode
  contracts, the personality, the surface contract and the reply-channel
  contract;
- the history follows. On Core inference it is a block window
  (`historyWindow` in `persona-records.js`): it grows to the pack's maximum of
  `historyTurns` messages, then drops a whole block of turns at once. A block
  is half the turn window (`ceil(historyTurns / 4)` turns, at least one), so the
  first history message moves once every block, to a multiple of the block,
  computed from the conversation's recorded turn count. The native agent keeps
  its own session history;
- the final user message carries everything selected for this turn (notes,
  household members, approved knowledge, routines, save receipts, the sound
  note, the reply language, a team member's last exchange, the reviewer's
  advice) in one delimited reference block, then the request.

Core inference history is rebuilt from the recorded turns, so it contains what
was said and never an earlier reference block; a native session keeps the
blocks it received as historical reference data. LLMx scene and KidX workshop
prompts are part of the instructions and change with the scene or screen they
describe.

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

See [agents, personalities and voice](AGENTS_AND_VOICE.md) for the selection
boundaries and the evidence required to qualify conversation and speech paths.

Core's `core/public/js/voice` owns browser microphone capture, speech endpoint
detection, echo rejection and cancellable playback. Household and PsyX compose
its conversation loop with their protected session and turn adapters.
`core/src/services/voice` owns the VoiX transport, primary/backup selection,
request-scoped synthesis validation, deadlines through body consumption and
stream forwarding. Both surfaces use these capabilities. Engine error events
are rejected before audio headers are committed, and a disconnected caller
cancels its upstream request without starting a backup request.

The shared loop speaks a reply clause by clause while it is generated and
prepares at most one clause ahead of the sound. A surface may have it say one
short holding phrase when no reply text has arrived after a few seconds
(Household does; PsyX keeps it off). The phrase never delays an available
answer: it is dropped when reply text arrives before it plays, and a phrase
already playing ends while the first clause is prepared to follow it.

A turn is spoken in one language. A French or English preference the person
chose wins; in automatic mode the language recognized in their speech decides,
then their words, then French. The loop hands that language to the surface
adapter with every clause, notice and holding phrase, and adapters do not
re-score a clause.

A clause is spoken when text follows its end, so a reply's last clause waits
for a signal that nothing follows. A surface that streams its reply gives that
signal as soon as the spoken text is complete (`onSayEnd`), ahead of the turn's
closing work; the completed turn remains the fallback. PsyX speaks a reply only
once its turn is confirmed, so it has nothing to flush early.

A voice can fail at two moments. Before its stream starts, the synthesis proxy
refuses it and the surface's ladder (`speech-ladder.js`) steps to its next
voice. After an accepted stream has started, the failure reaches playback: the
loop then asks the surface for that one clause again, naming the speech that
failed, at most once per turn and never after an interruption. The ladder
restarts below the voice that failed and that voice is left for the rest of the
turn; a clause prepared ahead with it is prepared again before it is heard.
Household's ladder is the chosen voice, the personality's voice, its catalog
voice, then the device's own voice. PsyX has one chosen voice and no device
voice: its retry is the same request on its protected route.

For a surface that keeps it, the loop measures each voice turn
(`voice-timeline.js`): milliseconds from the moment the end of the person's
speech is decided (after the endpoint's trailing silence) to the transcript,
the turn request, the first reply text, the holding phrase if one played, and
the start of the reply's first clause, with whether the turn was interrupted by
then. Three durations explain those marks: the silence waited before the end
of speech was decided (it comes on top of every mark), the length of the
captured clip, and the recognition time the speech service reports, so the rest
of the transcript delay is upload and transport. This is browser timing, not an
acoustic measurement. The loop sends it
once per turn, when that first clause starts or the turn ends without one; a
surface that answers `pending` receives it once more when the turn's request
has ended. `core/src/services/voice/timeline.js` keeps only the known marks and durations
as bounded whole numbers. Household stores them as `voiceTimings` on the recorded
turn (`POST …/sessions/:sessionId/voice-timings`, by the browser's turn id,
within the session's own space) and the parent journal shows the main delays.
PsyX provides no store, so nothing is measured or sent there.

The server side of a Household turn is kept the same way (`serverTimings`,
`turn-phases.js`): how long the turn took to prepare its context and to get
its answer, and for a native agent run when the gateway accepted the request,
the run was created, generation or a tool started, the stream ended and the
final answer was read. With the inference log's model phases, this shows what
the agent path costs outside the model.

Speech recognition is slower on its first request after a pause. When a
conversation starts and whenever someone starts speaking after such a pause,
the loop asks its surface to wake recognition (`POST /api/voix/warm` for
Household, `POST /api/psyx/voice/warm` for PsyX), so the model runs once
while the person is still talking. It is best effort, sent at most once per
warm period, to the primary speech service only, and an unreachable or older
speech service is not an error.

A turn ends after one second of silence, so a spoken hesitation does not cut
the sentence. Recognition does not wait for that second: after half a second
of silence the shared voice loop offers what was said so far to a surface that
implements `transcribeEarly`, and uses that text when the same pause ends the
turn. If the person goes on, the request is cancelled and the whole clip is
transcribed as before; a failed or declined early request is never the turn's
failure. Household offers it on its local transcriber only, never on the
browser's own recognizer. The turn-taking rule is unchanged: recognition
overlaps the wait instead of following it.

The shared speech boundary removes code fences, images, links, table markup,
HTML and presentation symbols from spoken text while preserving prose and
emergency phone numbers. The browser and the synthesis proxies use it; stored conversation text stays unchanged. Spoken prompt
guidance is shared, with domain limits composed by each persona.

Spoken conversation has one lane: the page captures the microphone and plays
the reply, and the speech service only transcribes and synthesizes (#478). Its
own microphone loop is not used by Core: there is no native session route,
voice-memory consumer or media vault proxy. Stateless transcription and
synthesis may use the configured backup. PsyX uses
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

### Local images

Core's optional image capability owns `ImageOperation`, idempotent action
identities, execution state, GPU admission and verified archive references.
The full-profile `/images` page and private native `local_image` tool compose
that capability. Household composes the same service for simple family drawings
after inference settles, through a bounded display directive. The family agent
receives no private native tools. Core persists the server-resolved conversation
scope with each operation; Household's read routes verify all scope fields.
Private native Household creates use the same binding. ComfyUI only executes
bounded server-owned graphs; callers cannot submit arbitrary workflows.

The Atelier's optional imageX surface delegates bounded text advice and planning
to Hermes through a gateway-authenticated OpenClaw plugin route. Core stores
sessions, transcript and operational evidence in its canonical Conversation
capability under `image-workshop`; the harness is an execution adapter. The UI
applies a validated proposal explicitly before normal image creation. Core
resolves proposal provenance from the completed canonical turn. Read-only
profile documents and configured routing are disclosed without credentials or
arbitrary filesystem access. No unfinished consultation is replayed at restart.

Browser cards read progress and verified completion without re-submitting a
creation. Resume also reads scoped operations independently of the turn audit,
so an accepted image remains discoverable after a lost reply. `/images` loads
the selected operation's stored brief and seed; using its artifact as an editing
reference is an explicit browser action. These are application surface bounds,
not separate human identities: the deployment uses trusted LAN access and its
shared archive may be visible to the household.

The worker reserves every configured GPU consumer endpoint through the existing
runtime coordinator. An optional private physical-resource map also excludes
Core admissions through other endpoints on the same GPU. Stored resource IDs
and an atomic topology fingerprint retain that fence across processes and
configuration changes. CPU-only endpoints remain distinct. This map does not
control unmanaged speech or other CUDA consumers. The image worker's durable
journal precedes resident unloading and prompt submission. Completion requires
terminal job evidence, archive validation and verified resident restoration. Lost responses and restarts preserve an unknown
outcome instead of submitting another prompt. Archive retry is independent of
GPU execution. Native tools return asynchronously so the caller's agent loop
can release a shared GPU before image preparation. See [local images](LOCAL_IMAGES.md).

### Memory

`memoryReadService.forAudience` binds owner or household access in trusted
server code and reuses the RAG client and Memory Policy V2 labels. The Nestor
consumer, memory adapter, chat context builder, MCP search and Household
approved-corpus reader share it. It is an information filter, not
authentication: server-bound capabilities constrain operations, while human
LAN access does not establish the identity of a person. See [ADR 0002](adr/0002-memory-access.md).

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
fact drawn from mail is still saved as one note. There is no household reader;
PsyX's dream reads recent entries in-process as context about the owner's life.

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

Core owns the common home (`/`, `/portal`, `/ecosystem`).
`shared/productSpaces.js` defines the browser destination catalogue;
`shared/productNavigation.js` applies profile filtering and configured service
authorities. `core/src/ui/productShell.js` renders the same EJS navigation in
static surfaces. The landing exposes no private application content; adult
pages and APIs retain the parental gateway guard.

- `core/surfaces/household`: Nestor, Family, Reader and
  animal-sound UI. Its HTTP and MCP handlers call Core capabilities and declare
  no session, audit, task or profile models of their own. The server derives a
  new session's agent from a personality's declared agent binding; a tone-only
  personality overlays the selected agent. A conflicting explicit agent or a
  later personality bound to another agent returns 400 with
  `VOICE_PERSONA_AGENT_MISMATCH`. Presentation never widens tools, memory access
  or permissions. Family keeps agent `family` with personality `nestor` or none,
  including when Nestor's catalog binding names `main`.
  `POST /api/voice-personas/private/sessions/:sessionId/persona` and the matching
  `/api/voice-personas/family/sessions/:sessionId/persona` route accept
  `{personaId, personaVersion?}` through the existing adult gateway access.
  Omitted versions select the latest active personality; inactive exact versions
  return 400 with `VOICE_PERSONA_INACTIVE`, and `personaId: null` clears the
  overlay. A turn in progress returns 409 with `VOICE_TURN_IN_PROGRESS`.
  Switches and turns share synchronous admission in the Core writer, so a turn
  cannot start during resolution or snapshot replacement. The write updates
  only the personality snapshot; later turns apply and record that snapshot.
  `HOUSEHOLD_PERSONA_VOICES` applies when the snapshot is selected and is resolved
  again for each server reply; a voice saved through Team takes precedence over
  that map. Changing or removing an instance override affects
  later speech; the frozen catalog voice supplies the default, and explicit
  session voice choices take precedence.
  Its Super Dad and
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
  private-only, shown masked, and stored redacted. A `say_end` event follows
  the last spoken `delta`, before pictures are resolved and the turn is
  recorded, so the voice page says the reply's last clause without waiting for
  `done`; a consumer that ignores it still gets everything from `done`.
  An image block names a source and search words, never an address;
  `visuals.js` resolves it (SearXNG images, or the Data file index under a
  configured, mounted photo/media root), streams it to the page's Images zone and
  keeps the result on the turn. A picture the OpenClaw agent generated and cited
  as `MEDIA:<path>` becomes an image block relayed from the Nestor plugin's
  read-only gateway media route.
  After each recorded turn a slower local model reviews the conversation in
  the background (`brain.js`, the router's `master_brain` lane): it proposes
  follow-up questions (the page's "Pistes"), revisions of shown content,
  corrections that the next turn carries as advisory notes beside its request, and
  at most one short remark the browser speaks only at a natural pause, unless
  the person chose quiet. It has no tools, saves nothing, keeps its latest
  review in memory per conversation, and a new turn cancels it.
  Kids Room and Lecture conversations carry the Nestor personality like
  Famille, and read replies through the same voice ladder
  (`persona-presentation.js`): the reading voice chosen on that browser, then
  Nestor's voice with its instance override, then his catalog voice.
- `core/surfaces/psyx`: uses the Core conversation lifecycle and admitted
  inference. `core/src/domains/psyx` owns longitudinal state and reflection
  rules. After each completed turn a background review (router task
  `PSYX_REVIEW_TASK`, default `deep_reasoning`) writes a conversation digest and
  memory proposals into PsyX state; proposals enter memory only when the user
  accepts them. Between sessions a dream reads selected context, with the owner's
  notes, open tasks and mail journal read in-process and read-only, and writes a
  portrait and memory changes directly into PsyX state, each one logged and
  undoable. Coverage and verified quotation references describe the material
  supplied to that inference; quotation matching does not validate hypotheses.
  Human access uses the [private LAN](PARENTAL_ACCESS.md) without a code;
  native consumers keep a separate access token.
- `core/surfaces/data-toolbox`: UI served by Core, consuming the optional
  Data process over HTTP. It is read-only except for editing a network device's
  record, requesting a network scan, publishing one MQTT message by hand,
  asking the storage collector to scan a configured source, storing the
  owner's duplicate-review decisions, and generating or deleting a report in
  Data's own report store. Collectors are host-native adapters under
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

The local coding worker uses a fresh repository clone on its task branch,
with a shell and test tools inside Bubblewrap. The runner keeps credentials
outside that sandbox, commits completed work and opens a draft pull request.
Interrupted work stays committed locally for continuation. Core admits model
calls; only proven admission refusals wait and retry. Review and normal PR CI
are the acceptance gate. See [the coding worker](../integrations/coding/README.md).

Nerve Center reads `live.gpuHealth` from the existing host-preference endpoint;
HTTP reachability stays separate from pin GPU residency. Benchmark's bounded
`GET /api/profiler/recovery` projects existing HostProfile journals without
coordination credentials or runtime mutations. Host/dashboard browser reads
also replace raw journals with the capability-free recovery projection.
See [operational screens](OPERATOR_UI.md) for user-facing states and actions.

- [ADR 0001: one canonical repository](adr/0001-one-repository.md)
- [ADR 0002: reuse existing memory classification](adr/0002-memory-access.md)
- [ADR 0003: ingested content is data, never authority](adr/0003-ingested-content.md)
