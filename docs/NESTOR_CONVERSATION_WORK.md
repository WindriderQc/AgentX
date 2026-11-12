# Durable Nestor conversation work

Core's optional `conversationWorks` capability lets personal voice dialogue
continue while the complete native Nestor Main works in an isolated session.
In `native` mode, every accepted work request uses Main, including personal tasks,
reasoning, web, specialists and authorized actions. Capability keywords never
select a restricted agent. Main retains its installed tools, memory, model,
permissions and approval contracts. New native intakes start with Main; a dedicated
guardian can relay conversation only while another exact Main request is occupied.
Nestor remains the single visible identity.
Core owns acceptance, complete requests, execution metadata, verified task reads,
structured results and presentation receipts. OpenClaw owns the native agent/tool
loop. Polling the browser projection never starts inference.

### Main first on new personal native requests

The personal OpenClaw surface freezes `entryPolicy=main-first/v1` in each new
native acceptance and work record. The original complete request, attachments,
profile and turn identity remain immutable. Core queues every such request for
complete Main through the existing native dispatch owner, including ordinary
dialogue. The foreground HTTP request reads that original work's verified result;
it never calls another Main or constructs a second native attempt. Main receives
its complete native instructions, selected memory and canonical conversation,
without the legacy directive that assumes a guardian already answered. Its tools,
permissions and installed approval contracts remain native.

When Main is available, its received native answer returns through the ordinary
voice response with `openclaw/main` evidence, provider, model and exact run. A
Core acknowledgment remains a separate response kind. Missing native timings
remain absent; foreground polling time is not a model timing measurement.

Only another work holding the exact native dispatch gate with a matching Main
attempt, observed run identity, `running` state and no terminal result permits a
temporary dedicated guardian while that original native transport is still
in flight in its observer. A retained running label after the transport returns
or after restart cannot establish that condition. This process-local observation
does not admit work, release a fence or prove business completion.
The current work cannot be its own busy owner.
Queued, uncertain, missing or mismatched native identities permit only an honest
Core status, without another model call. An absent dedicated guardian likewise
uses that status while leaving available Main work intact. The guardian retains
its tool-free role. A received ordinary relay reply can use the existing Main
review contract; an explicit requested work keeps its complete Main owner.

Barge-in or voice Stop releases the foreground wait without aborting the admitted
Main transport. The existing work keeps its attempt and native reconciliation.
An uncertain start never authorizes a replacement. Versioned pre-dispatch work
controls remain separate from stopping speech. Conversation erasure revokes the
context and payloads while retaining an admitted native fence until its exact
terminal evidence arrives.

Foreground publication and detachment arbitrate under the existing conversation
write fence. Detachment before publication selects the existing durable result
delivery. Publication first retains a foreground result with automatic work-feed
speech disabled. A lost final HTTP response leaves its original result available
for explicit Listen after reconnect; neither a duplicate turn nor polling replays
it automatically. Neither result availability nor HTTP completion proves that
audio played. Existing display/playback receipts keep their own meaning.

Main's canonical reply and its retained work result are linked as `sameAsReply`
only when exact text, work identity, result version, fingerprint and native run
proof match. That context entry keeps the original result receipts without
repeating the answer text as a second reply. A missing, changed or mismatched
canonical reply leaves the complete received result visible. No result or native
evidence is rewritten to achieve this projection.

Accepted records without this policy retain their guardian-first contract, model
profile and execution identity, including after a restart or disabling new intake.
The default mode remains `off`; text, Open, addressed specialists, Family and
Hermes retain their existing routes. This change grants no native consent or
business authority. Ordinary native questions use the optional [conditional question bridge](NESTOR_NATIVE_QUESTIONS.md).
Secret and execution approvals retain their native owners.

### Reconcile an uncertain personal capture

Main uses the existing Core personal task tools. After an uncertain
`add_personal_task` response, `list_personal_tasks` accepts only the original
UUID `requestId` and, if already known, `expectedCaptureFingerprint`. The same
read is available through `GET /api/secretary/tasks`. Exact capture lookup
rejects list filters (including default pagination/scope fields) and incompatible
identities. Ordinary task listing keeps its existing filters.

Core reads the existing personal capture identity and fingerprint from the
personal task, without replaying creation or allocating an id. A `recorded`
`captureStatus` supplies `captureReceipt` with the original UUID, task id,
fingerprint and creation date. `taskObservation: current_state` describes the
separate `tasks` entry, including later edits, completion or dismissal. That
receipt does not reconstruct the original payload or prove current source
reconciliation. A provided fingerprint must match the stored capture.

Missing, erased or incomplete evidence returns `captureStatus: unknown` and no
receipt or task. This proves neither failure nor absence of an effect and
permits no automatic second creation. Lookup changes no task or mail proposal
approval. It adds no native confirmation grant, mutation journal or alternate
business owner; native approval bridging remains separate.

### Relay attribution in Main's context

The complete canonical context labels a received dedicated guardian reply with
`replyAttribution.role=relay` only when its accepted work/request fingerprint,
guardian session/run, completed guardian state and observed native turn receipt
match. The label retains the work, agent, native session and run identities.
Historical turns without this proof have `role=unknown`; a model name, declared
speaker, browser field, missing receipt or uncertain settlement cannot establish
a relay. Received native Main results have `workResults.attribution.role=leading`
when their exact completed native evidence matches. The original human request,
guardian reply, result, tool evidence and presentation receipts remain separate.

Initial Main preparation and its host-bound context refresh use this same
projection, including relay turns received while Main works. A reconnect reads
the original work and native identities. Attribution grants no tool access,
consent, new request or authority to replay work. Main keeps its native tools,
memory and permission contracts; uncertain executions retain their existing
dispatch fence. The complete projection still counts toward the declared context
budget, and conversation erasure revokes it with the original content.

Main's instructions ask it to review relevant relay replies and explicitly name
any necessary correction in its returned answer. Core retains that answer beside
the original relay text, through the existing result delivery. Supplying context
or requesting review does not prove that a review occurred or that its result was
displayed or spoken. Those observations retain their own receipts.

This native attribution applies to the optional personal OpenClaw Main/guardian
path, including its retained guardian-first records. Family and Hermes compose
the same tool-free local conversation continuity capability as described below.
Family remains excluded from personal work and the owner bus.

### Optional Family and Hermes conversational relay

`HOUSEHOLD_CONVERSATION_RELAY_ENABLED=true` opts these surfaces into the existing
`runtimeServices.inference.conversation` capability. It also requires the existing
server-owned `AGENTX_CONVERSATION_CONTINUITY_JSON` policy with a resident guardian
pin on a different local host. Both settings are absent by default. The relay
changes no pin, model context, route or installed agent permission. This mode is
independent of the optional second-brain/reviewer scheduling preferences.

Family first tries its exact configured voice/text task route and pinned context.
It does not require the personal `daily_operator` route to exist.
Its atomic exclusive admission treats an already active shared inference as an
occupied lane. A proven refusal before dispatch permits a guardian reply even
when the principal is unavailable without a verified active holder. Only a fresh
active holder is described as busy; queue labels, expired ownership and quarantine
do not establish occupation. Another owner's recovery fence remains intact, and
the guardian must independently pass native admission on a different resident
host. A timeout, partial reply or uncertain outcome of this turn never permits
a replacement call. The guardian receives the family
instructions and bounded recent text dialogue, with the complete current human
message. Its instructions reuse the complete canonical family/mode policy and
the read-only reply format, without the principal's tool, navigation or image
action contracts. These extra contracts cannot consume the relay's existing
input budget. It receives no selected private memory, tools or owner bus. Deterministic
child safety runs before this path. The next turn tries the unchanged main route.

Hermes initially owns its ordinary native run and tools. Speaking again can detach
its foreground through the existing background-member delivery, leaving that
same transport and durable Hermes journal active. A guardian turn requires a
different current request, the exact original run/session/key and a fresh native
`running` observation while that original transport remains in flight. After a
restart a retained `running` label is insufficient: the surface reports missing
reconciliation without starting a guardian or another native run. Explicit Stop
keeps Hermes' existing native cancellation behavior. The original result is saved
in its original canonical turn and existing delivery; reconnect never executes
it again. Missing live delivery can be read in history, without automatic replay.
With the relay enabled, a history read after restart reconciles only the stored
native run id. It can retain that original terminal receipt and fill the original
pending canonical slot; it never posts another native request. Missing identity
or unavailable status remains unknown. The existing Hermes journal update compares
its previous key, run and state, so a stale read cannot replace a newer run.
Finalization retains Household's existing 50,000-character reply bound; the
separate native conversation-work result contract keeps its 16,000-character bound.

Both paths announce the temporary relay in text and voice with an explicit
automatic AgentX notice, distinct from the guardian's generated reply. When no
guardian can accept the turn, the warm, deterministic service notice identifies
itself as automatic; its technical explanation remains in the turn's evidence.
It records tools as `not_run`, rather than claiming that a model rejected tools.
Scripted greetings are marked as automatic in the visible conversation.
The Family relay retains the server's household clock. Supplied weather keeps
its original source projection plus separately converted local observation and
retrieval times and observation age; a recent retrieval never makes the reading
current. Guardian instructions keep the answer conversational and leave the
automatic service announcement to Core.
Canonical intake binds
each stable turn id before inference; a duplicate reads its existing outcome
without a second inference, including after interruption or an uncertain reply.
Completed Core inference produces `toolEvidence.conversationRelay.completed=true`.
A cancelled or failed reply can retain observed model fragments with
`completed=false`, a parser-input character count and unverified playback. These
observations establish neither a complete result nor sound heard by the user.
On the next main turn with Core history enabled, Core supplies the attributed relay dialogue, including marked fragments, as
reference data even when native Hermes history is already established. It asks
the main brain to make any necessary correction explicit. This does not inject
new instructions into an in-flight Hermes run or prove that review occurred.
Selected context and relay dialogue share an explicit context budget; erasure
revokes their canonical payloads. Results, action permissions and display/speech
receipts retain their existing owners. A relay cannot execute a later action
merely because it appears in this reference context.

The optional server setting `HOUSEHOLD_GUARDIAN_TOOLS` is an empty allowlist by
default. Its reviewed catalogue accepts `iss_passes`, `weather` and `math`,
comma-separated; any unknown name disables the offered relay toolset. This
setting changes neither native agent grants nor the owner bus. The dedicated
OpenClaw guardian retains its existing tool-deny fences.

The Family/Core and personal Hermes local relay can use only these bounded
reads. ISS reuses Core's pass computation and server location, with no model
coordinates, observer labels or coordinate-bearing viewer URL. Weather reuses
the family projection and preserves observation/retrieval age separately. Math
reuses Core's counting (1–100) and non-negative addition (sum 1–20); it evaluates
no expression or code. Source errors and unavailable conditions remain explicit.

The existing conversation tool loop allows at most two rounds of three calls.
Each continuation retains the selected local host/context and ordinary native
admission, with retries disabled. For an occupation-triggered relay, Core rechecks
the principal's actual occupation before each read and additional model call;
an unavailable/foreign observation stops the chain. A Family reply triggered by
a proven pre-dispatch unavailability refusal completes on the same read-only
guardian without claiming an active principal run. The relay cannot switch back
to Main during that chain. Repeated
identical reads retain the same per-turn result and receipt, including failures.
Results and the combined context are bounded; erasure and duplicate canonical
intake retain their existing fences. This opt-in source support does not activate
an instance tool, prove model quality or confirm that audio was heard.

CPU HTTP fixtures cover occupied shared inference, independent active Hermes
transport, return, voice streaming, Stop, reconnect, erasure, missing guardian
and ambiguous native state. They do not establish model quality, microphone
behavior, acoustic playback or live instance activation.

### Optional native OpenClaw guardian reads

The dedicated native guardian can consume that same server catalogue through
its optional `conversation_work` transport. `guardian_tools` reads the offered
definitions; `guardian_read` accepts only `{name,args}` from those definitions.
`HOUSEHOLD_GUARDIAN_TOOLS` remains empty by default; an unknown policy entry
disables the catalogue. The native grant and provider tool capability remain
independent prerequisites. This source path changes neither, and an installed
tool-free guardian remains tool-free. Discovery itself grants no read.

Each read requires the exact host-bound guardian agent, session, run and native
call ID. Core verifies the canonical pending request and the same Main-first
relay occupation selected by the native dispatch owner, including its live
executor, before reservation, execution and publication. A released, unknown,
cancelled, paused or erased owner refuses. Main and legacy workers keep their
existing tools and receipt shapes. All other dedicated-guardian tools, owner
bus calls, actions and second dispatches remain blocked.

Core reserves each call in the existing conversation work under its content
write fence before reading. Six distinct reads and at most sixteen native call
identities fit one turn. Equal reads reuse
their original receipt across native call IDs and restarts; `requestedCallId`
and `reused` identify such a reference without inventing a new execution. Each
referencing call is retained as an immutable alias in the same guardian journal;
reusing that call ID with different arguments refuses after restart too.
A reserved call without a stored result stays uncertain: its exact identity can
be observed again but never executed again, and no other read starts while it
is unresolved. Failed source observations likewise retain the original result.
The shared handlers bound arguments and results and keep household coordinates
and weather provider details server-side. Canonical receipts include the real
agent/session/run/call identities. Main's complete conversation retains these
receipts and exact `$evidence` references, including failed and uncertain reads,
so its return preserves the relay's observations and the existing correction
and attribution contracts. CPU fixtures do not qualify installed grants,
native provider support, model tool use or physical playback.

When the native dispatch owner is free, queued awaited work precedes queued
background reviews. New Main-first dialogue is awaited work. A native review whose guardian has explicitly completed and
answered waits for 30 seconds of quiet after its own preparation/settlement and
the latest accepted turn's intake/preparation/settlement. A pending latest
guardian also defers that review. Requested work and an explicit Main handoff do
not wait for quiet. Interrupted, failed, unknown and legacy guardian outcomes
keep their existing dispatch behavior.

Deferral cannot indefinitely reset a review's eligibility: 120 seconds after
that review's original acceptance it is eligible at the next
free gate, even if conversation continues. When both classes remain queued,
one oldest overdue review alternates with one oldest awaited work. The last
dispatched classification survives restart in the existing dispatch record;
each class keeps FIFO. These are admission bounds, not completion deadlines or
permission to expire a native owner. Every original review remains durable,
with its complete context and result contract; deferral creates no native
attempt and no replacement request. The existing observer checks eligibility
without another agent or scheduling loop. This native admission policy does not
change the optional legacy background review preferences.

An active or uncertain native attempt keeps its owner and is never preempted.
Admission cannot predict a future human arrival or remove the cost of an
already admitted review. The policy changes waiting order, not Main's model,
tools, memory, complete context or total inference work. Qualify latency and
physical playback separately from deterministic admission tests.

The private browser work list identifies each card by the exact canonical human
request, receipt time and a short work reference. Long requests expand in place.
It distinguishes waiting, running, paused, failed and unconfirmed execution,
without implying a completion estimate. The guardian must likewise use received
Core states and disclose when no completion estimate is supplied. Request controls
are separate from voice pause, which stops the microphone and playback.
Pause/resume/cancel keep their existing pre-dispatch ownership and revision
checks; a native execution has no browser cancel button. A missing or mismatched
canonical request hides its controls. A lost command response triggers a fresh
read of that same work, with controls disabled until verification, and never
resends the mutation. Cancelled requests retain their state on screen. The list
scrolls independently to keep the dialogue and composer within reach.

### Exact pre-dispatch command receipts

The existing private work-control route accepts only version 2 commands:
`{ version: 2, requestId, workId, requestSha256, revision, action }`. The browser
uses the exact `controlBasis` from the work projection and a new UUID for each
explicit pause, resume or cancel. Core requires the matching conversation,
work, immutable request fingerprint and current work revision. It also reads
the complete canonical request under the existing conversation write fence;
an absent or replaced request refuses the command. Work revision is a concurrency
fence, not an intent-amendment version or a native approval grant.

The state transition and its `controlReceipts` entry commit atomically in the
existing work record. The receipt binds the UUID, action, work, request fingerprint,
base revision and resulting state/revision. An exact duplicate returns that original
receipt, even after later commands or a Core restart; on that work, the same UUID
with changed content refuses. The browser never resends an uncertain command. It retains only
its command identity and basis in that tab's session storage before sending, so
reload or conversation reselection can read the same receipt from the work
projection. If the browser cannot retain this pending identity, it sends no command.

A missing or unrelated receipt remains unconfirmed, even if a newer generic status
is available. Controls stay disabled for that pending command until its exact
receipt arrives; a definite HTTP refusal clears only that refused command.
Receipts are never evicted: the journal holds at most 64 commands per work,
reserving the last slot for pre-dispatch cancellation. Monotonic work revisions
also prevent reapplying an older basis with a new command UUID. Conversation
erasure removes these receipts with the existing work metadata.

Older clients without version 2 identities receive
`CONVERSATION_WORK_CONTROL_INVALID` and an instruction to refresh the conversation;
they cannot perform a partial or unbound command. Older work records gain their
first receipt only on a newly accepted version 2 command. No historical receipt
is inferred from a state or event. The existing private-LAN human access boundary
is unchanged: model text, declared callers and client approval booleans grant
no native consent. These receipts control only unadmitted conversation work;
they cannot amend an admitted request, stop or relaunch a native attempt, or
perform a business mutation. Native approvals, versioned clarification replies
and intent amendments remain separate contracts tracked in #664.

## Contract

Enable `PERSONAL_CONVERSATION_WORK_MODE=native`,
`PERSONAL_CONVERSATION_WORK_AGENT_ID` and a private
`PERSONAL_CONVERSATION_WORK_TOKEN`. The default mode is `off`. The native plugin
needs the same token in `conversationWorkToken`, and the dedicated agent ID in
`conversationWorkAgentId`. Tokens stay in instance secret configuration, never
model parameters or browser requests.

For a compact voice guardian, additionally set
`PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID` and the matching plugin
`conversationGuardianAgentId`. Install a separate native agent with its own
small workspace, the existing voice model, `tools.deny: ["*"]`, no skills,
heartbeat or subagents. Give this agent a separate native provider alias whose
model entry sets `compat.supportsTools: false`. Copy the existing voice endpoint,
credentials, routing headers, model ID and token limits unchanged; only this
guardian alias disables model tools. Native OpenClaw uses that capability before
constructing bundled MCP runtimes, whereas the agent's final deny policy alone
can still incur an unnecessary MCP connection timeout. Keep the final deny
policy and native guardian hook as execution fences. Main's workspace, model, tools and permissions stay
unchanged. The guardian remains an internal role, hidden from the speaker list.
New intakes persist its identity; existing Main guardian runs retain their exact
owner. Each guardian turn has a fresh native session containing up to six recent
messages (2,000 characters each) and an 8,000-character selected-context excerpt.
The exact current request is never clipped. Complete history, attachments and
context remain canonical in Core and available to Main. Only this tool-free
guardian streams spoken text before native completion; final evidence must
match the spoken prefix, or the turn fails without playing a replacement.

For accepted guardian-first records, Core accepts complete work requests before any model inference. An immediate
canonical acknowledgment handles clear work requests. Ordinary dialogue receives
a real guardian response even while another Main work is active; its request
still reaches complete Main. Selectors only choose this foreground reply style,
never the boss's capabilities. The native pre-tool hook fences all tools in the
exact Core-bound guardian run, so the guardian cannot duplicate Main's work.
Text, legacy and background Main runs retain their native tools.
Ordinary dialogue starts its Main review only after the guardian settles, so
Main reads the actual completed reply rather than racing to answer the same
question. A review may complete remaining authorized work with Main's full
capabilities. Main can disposition an adequate, completed canonical guardian reply as
`no_work`, without duplicate
speech. When a dedicated guardian cannot finish a request, its native reply starts
with `[[NESTOR_MAIN_REQUIRED]]` before a brief acknowledgment. Core removes that
prefix from streamed speech and canonical prose, retains `awaiting_main`, and
promotes the accepted work without changing its request or execution identity.
This disposition changes presentation only; it grants no execution authority.
If the model omits the prefix but supplies a short progress acknowledgment
promising Main's result, Core still retains `awaiting_main`. Quoted story
dialogue and completed answers do not match that presentation fallback.
Other requests receive Main's exact completed native answer, including
reasoning that needs no tools. An answered guardian turn's alternate review
prose is kept for explicit Listen. Older turns without this disposition can
deliver their exact retained substantive tool result; discovery and context
reads alone do not authorize a second voice. Core enforces this distinction,
including for a stale browser. Awaited work results retain automatic delivery
through the conversation's single speech queue. Requested task, web and Secretary consultations
retain their existing requirements for actual same-run tool evidence.

Pipeline priority/status reads use the existing `ecosystem_snapshot` tool with
`mode: "pipeline"` and a 5,000-character ceiling. This focused projection keeps
exact status counts and up to eight visible active task summaries ordered by
numeric priority, without unrelated alert and runtime arrays. Private task
records remain withheld and coverage is explicit. Main reports unavailable
fields without repeatedly rediscovering the same tools or delegating the same
read. Engineering Pipeline work remains distinct from personal tasks and the
heavy-work planning queue.

The boss and guardian share Core's canonical conversation and work state.
Main starts with the exact request, selected context, original local date and
the complete canonical conversation before its first invocation, including older
published Main answers and their retained evidence. Its host-bound
`conversation_work context` can refresh current
turns, guardian replies and pending or received work during execution. This route
cannot select another conversation or run, acquire the legacy worker's task or
publication permissions, or survive conversation erasure. Context is reference
data, not an extra request or authorization. This does not implement the separate
intent-amendment or native-approval bridge tracked in #664.
The complete-context and capacity guarantees below apply to native Main and
legacy workers alike, preserving each mode's execution permissions.

For a verified contextual task read, Core serializes the current receipt and
data before historical context. An unavailable read likewise appears first.
This keeps the current observation visible in a native relay's bounded rendered
head; the complete Core response and initial Main context remain available and
unchanged. Earlier historical counts are not a substitute for the current read.

The host-only `native_owner` probe resolves image operations to the original
canonical owner session. Both `local_image` and `imagex` preserve the actual
native run/call action identity; their model parameters cannot select an owner.
An unavailable owner observation stops before specialist planning or submission.

General native work admits at most sixteen parent tool calls and four web calls.
After the web limit, non-web tools remain available within the total budget.
Pure web consultations keep their existing stricter limit below. Specialist
tools retain their native owners. The matching native adapter must advertise
`nativeConversation`; an older adapter refuses new native work before inference.
No tools, execution permissions or approval bypasses are granted by this mode.

## Inference profiles

Personal Nestor's **Context and performance** editor selects Local, Cloud brain,
or Cloud guardian and brain for upcoming standard personal voice turns. Local
keeps the installed native routes. Cloud brain overrides only complete Main's
model; the all-cloud profile also overrides the dedicated guardian's model.
Agent identity, tools, permissions, selected memory and complete conversation
ownership keep the same contracts. Family, text, Open and explicitly addressed
specialists keep their existing routes.

The instance names native model references in
`PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL` and
`PERSONAL_CONVERSATION_CLOUD_GUARDIAN_MODEL`. Cloud choices require native work,
its private binding and a separate configured guardian; an unset route disables
that choice. A saved cloud profile that becomes unavailable refuses new work,
instead of silently choosing a local model. No credentials enter preferences.

Core freezes the profile and model references in the canonical acceptance
receipt and durable work, before inference. A later save affects new turns;
already accepted work and its recovery retain their original selection. Local
records without a model override continue to follow the installed native policy.
The browser cannot supply an arbitrary model through its turn request.

Native provider configuration owns authentication, runtime selection, fallbacks
and reasoning effort. Configure a fast thinking default for the guardian and
more reasoning for Main through their existing native policies. OpenAI
subscription OAuth and API-key billing are separate routes; qualify the intended
account and effective model on the actual native run. Keep the OpenClaw native
agent runtime when the installation relies on its existing tools and hooks.

## Legacy migration modes

`read` retains bounded task reads/review through the dedicated worker and isolated
Main for conservative public-information and mailbox reads. `observe` retains
review without business reads. Both use the same durable intake and delivery.
The dedicated ID remains configured for already accepted legacy work; enabling
`native` does not change those records, identities, tool scopes or unknown runs.
Disabling new intake likewise retains accepted native work for reconciliation.

The dedicated agent has its own workspace, no visible channel, no heartbeat,
no subagents and no cloud/CPU fallback. Grant only `conversation_work` plus the
native tool-discovery transport. Do not reuse Main, the family agent or an
existing specialist. Preserve the installed guardian and worker model/context
contracts; the worker request bounds output to 4,096 tokens without changing
model residency or context. Core supplies the complete canonical conversation
before the worker's first invocation, separately from selected personal memory.
The context tool refreshes that complete conversation, including original input,
guardian replies, shown text, attachment references and recorded tool evidence.
It also includes every published background answer on its source turn, with
its tool receipts and separate presentation receipts; a
published answer is not proof that the owner saw or heard it. Earlier boss
corrections are not limited by the guardian's selected-feedback window.
Coverage names the first/last turn and turn count; neither UI pagination limits
nor a recent-turn window define the boss's context. Isolated native Main
consultations receive the same complete conversation. The complete
current human request is always retained and returned. Inputs outside the
4,000-character intake budget refuse instead of truncating.

Earlier tool evidence is referenced, not re-sent (`evidenceReferenceEncoding`,
`core.tool-evidence-references/v1`). The latest published work keeps its complete
evidence inline. For earlier works, a receipt whose data is at least 1,024
characters keeps its identity, tool, status and native run, and its data becomes
`{ "$evidence": { ref, sha256, chars, summary } }`. The summary is deterministic
(task count and first titles, a native consultation's status and completed tools,
or a bounded preview). Every turn and answer stays complete. The stored value is
unchanged in Core: `conversation_work` with operation `evidence` and that exact
`ref` returns it, read-only, only for a published work of the caller's own
conversation. This keeps long conversations under the work-context budget;
source tests do not establish a live latency gain.

Within what remains inline, repeated identical large tool-result data use a lossless per-response inline
dictionary in the model context: each receipt retains its identity, native run,
order and presentation, with `data.$ref` pointing into `sharedToolEvidence` in
that same conversation. The complete value is supplied once in the same block;
no follow-up fetch, summary or history window replaces it. Canonical conversation
and receipt storage, and the ordinary conversation read, remain expanded.
Changed results are distinct. This reduces repeated reference data; source tests
do not establish model comprehension or a live latency gain.

Long strings repeated elsewhere in that block, including a published answer
repeated inside its native receipt, can use `sharedTextEncoding` with
`core.shared-context-text/v1`. A later copy becomes an object containing only
`$textRef`, a JSON pointer to its first complete inline string. Pointers never
target another text reference. Original caller markers disable this projection;
short, changed and unique strings stay distinct. The context refresh and initial
native preparation use the same projection. No storage or context limit changes.

Otherwise changed evidence payloads may share exact unchanged nested objects or
arrays using `sharedValueEncoding` (`core.shared-context-values/v1`). A later
copy is `{ "$valueRef": "#/path/to/first/value" }`. An object with `$valueBase`
and `$valuePatch` copies its retained base and replaces exactly the listed fields;
all changed values stay explicit. Patches require identical ordered property
names, so no deletion or ordering change is implied. Each version reconstructs
independently. References point only to already retained values; the whole-result
dictionary's forward references cannot become bases or create cycles. Turn, work
and receipt envelopes stay expanded. Literal caller `$valueRef`, `$valueBase` or
`$valuePatch` markers disable this projection. This stage precedes text sharing,
so text references always target retained strings.

The combined selected-memory and conversation reference block must fit the
existing 96,000-character work-context budget. Preparation refuses with
`CONVERSATION_CONTEXT_REQUIRED` before native dispatch if it does not fit;
if the canonical conversation grows beyond that limit during an original run,
its mandatory context refresh records the same precise refusal. A native run
ending without a verified result preserves that cause for the owner's failure
card, instead of relabeling it as a generic unpublished result. A later successful
refresh clears the refusal; no original is restarted or historical answer accepted.
Core never substitutes a summary, clips messages or drops older turns. This is
an application context bound, not a change to the installed model window.
Personal background review also receives the complete conversation and recorded
tool evidence. An oversized review is disclosed without inference or partial
advice. The guardian retains the last completed feedback, with its source-turn
identity and an explicit distinction from newer turns that could not be reviewed.
Family review keeps its separate existing context policy and scope.

The guardian remains available while the boss works and receives the latest
completed feedback and durable work results on subsequent turns. Roles, context
ownership and tool permissions belong to the product; changing a model or its
reasoning effort does not change this contract or supply additional tools.

Only Main's standard personal voice turns enter this capability. Text, Open,
explicit specialist requests, LLMx and family conversation retain their existing
paths and permissions. Core fixes the accepted mode per work, so switching the
flag off stops new intake while accepted work remains observable and deliverable.
The observer stays available until accepted work has settled.

Before guardian inference, Core commits an immutable accepted request and a
canonical human turn with one pending assistant slot. Completion replaces that
slot once. A stable browser turn ID deduplicates requests; changed content under
the same ID conflicts. Selected context is committed separately before work can
be queued. Eligible greetings can also be reviewed; a worker can conclude that no
additional work is useful. Unclassified conversational turns
are reviewed after the guardian settles; explicit task reads can run concurrently.
Stale intake can recover after restart without replaying an uncertain guardian.
Recovered work explicitly identifies missing selected context.

In read mode, conservative mailbox reads receive a canonical acknowledgment
without invoking either model in the foreground. The native background Main
uses its installed model/tools in an isolated `household:direct` session and
consults the Secretary through `sessions_spawn` and `sessions_yield`. The live
guardian keeps its own session and voice model. Its pending-work context prevents
redispatch. Mixed or ambiguous effects, message drafts, sends, modifications and
deletions retain their existing synchronous native path and approval contracts.
Current public-information questions and explicit web reads use the same
acknowledgment and isolated native Main path. Tool discovery is separate from
web research: publication requires a successful same-run `web_search` or
`web_fetch`, not merely `tool_search`. Relative dates use the request's original
local calendar day and configured planning time zone. Effects, declined searches,
personal records and local service checks retain their existing paths.
Pure web consultations admit at most four web reads and eight total tool calls,
including discovery, through Core and the native adapter's pre-tool hook. Core
retains each admission in the existing work, even when the page fails to load;
changing URLs or restarting the adapter does not reset it. After exhaustion the
adapter blocks further tools and directs Main to conclude from its verified
sources or explain the actual lookup limitation. Mixed task/mail reads keep
their existing native contracts. An older adapter without this capability
refuses pure web dispatch before inference.

Every private worker receives the same adult-owner presentation contract as
the guardian. Child profiles remain reference data; they do not select the
audience. A bounded reviewer's missing tool is not proof that Main lacks it.
The bounded task-read worker receives no web/mailbox tools or specialist grants.
The native Main namespace is preserved so its existing personal tool scope remains
available; the fresh session identity separates the boss from the live guardian.
Preparation checks the installed native adapter's isolated-work capability before
dispatch. A mismatched Core/plugin installation refuses before invoking a model,
retaining the failed request instead of creating an unrecoverable native attempt.

Core retains the exact parent run and successful consultation-tool observations
beside the received requester-settle answer. Parent completion on yield does not
mean the child has answered: the dispatch gate waits for that same answer through
restart or a lost response. A missing or ambiguous run never permits replacement.
Only the trusted native adapter can publish this received result; the model-facing
work API cannot publish it or use its identity to acquire task-read capabilities.
Stopping acknowledgment or result speech does not cancel the accepted work.

One durable personal dispatch gate permits one native work at a time. The
work attempt/session is recorded before the outbound call. An unfinished
preparation may be revoked by an exact CAS before its dispatch fence. A marked
or uncertain dispatch never expires into another attempt. Reconcile the exact
native session/run and terminal lifecycle receipt. The trusted Responses adapter
also retains authenticated `response.failed`/`response.incomplete` terminal events
bound to the original session and run. This handles native refusals before an
`agent_end` hook, including provider authentication cooldown. Core stores only a
bounded failure category, never the provider's diagnostic text, and reconciles
that original receipt after restart. A rewritten-stream refusal keeps its
existing final-answer recovery path. Missing history, a connection failure and a
returned HTTP promise do not prove settlement. An older uncertain dispatch without
this receipt still requires native reconciliation; it is never cleared by age.
Native runtime admission and workload ownership remain authoritative.

The plugin binds calls using the native before-tool hook's session, run and call
identity. Call identities retain the complete provider value, including composite
call/item IDs; admission and result evidence join the exact bounded identity.
Tool names keep their separate validation. Main's `conversation_work request` returns acceptance and result
metadata, not task data. For migrated requests its legacy task reads are blocked.
An explicit lookup is already accepted before guardian inference. Its canonical
intake lets the guardian acknowledge it without another tool dispatch. Current intake IDs
and states belong to the final turn directive; static system instructions remain
identical across turns so changing work identities do not invalidate their cache.
A failed native acceptance call never becomes proof of a completed lookup: Household
uses the current Core status for a truthful acknowledgment and retains failed
native receipts. Browser objects, foreign requests and stale content cannot
substitute for the bound Core capability.
The worker can obtain canonical context, read bounded personal tasks and publish
an answer, correction, clarification or no-work disposition. A task lookup result
requires verified Core read receipts owned by that exact work. Retrying a lost
tool response with the same native call ID returns its saved receipt. Core keeps
result payload references with the existing transcript owner, and atomically
updates work revision, state and ordered events. Erasure removes work content,
leaves only operational identity needed to reconcile an admitted native attempt,
and refuses late publication.

## Delivery and control

Private routes under `/api/voice-personas/private/sessions/:sessionId` provide:

- `GET /work?cursor=…`: ordered, paged canonical work/result snapshots and events.
- `POST /work/:workId/control`: pause, resume or cancel an undispatched work using
  its exact revision. An admitted native run needs reconciliation by its owner.
- `POST /work-deliveries/:deliveryId/receipt`: versioned display, claim, scheduled
  playback, completion, interruption and deferral receipts.

The personal conversation shows a permanent six-component flow graph with direct
conversation and background-review branches, a timer strip, and a collapsible
cross-turn event chronology. Connectors appear only for exact turn/work receipts.
Active nodes use labelled indicators and indeterminate motion, never a guessed
percentage or ETA; reduced-motion settings remove the motion. Failed polling
marks active Core states stale until a successful snapshot. It reuses ordered work events, the saved turn's
server phases and the browser's voice offsets. Browser and Core clocks are labelled
separately; missing events stay unknown. The browser projection includes bounded
agent/run identities and tool receipt metadata, never selected context or payloads.
Each snapshot also projects a dispatcher blocked by an unverified execution,
even when the conversation cursor has no new events. Queued requests and answer
reviews say they are waiting; acknowledgments disclose that block instead of
claiming work has started. The guardian's canonical work context carries the
same blocked status. A received authentication failure describes that attempt's
refusal without asserting the provider's current credential state. Questions about current coding-team activity
use the same native Pipeline evidence as explicit Pipeline status questions;
the guardian cannot establish ongoing work from conversational context alone.
The conversation map lights the review only after an observed dispatch; a received
request alone remains pending. Its browser `firstAudio` offset marks a playback
attempt before the player call, so the map labels it as a request to play, not
proof of sound. The mobile branches and keyboard focus remain connected through
work revisions. A compact active-stage summary stays beside Pause while the
person scrolls the conversation; the avatar's show view still presents its board.
Advice has an ID and version. A later turn records exact advice references and
which parts of an older review entered its selected context. Inclusion attests
supplied context, not influence on the answer; application requires its own action
receipt and is never inferred from timing or a reply.

The guardian’s next selected context includes canonical statuses and received
results from the same conversation, so it can follow up on the worker’s work.
For an explicit read of the owner's open personal tasks, Main's native
`conversation_work context` call also returns the existing canonical task read
and its same-run receipt. This read selects the active owner-action scope;
unreviewed email extractions and other findings are not owner commitments.
Explicit review/category requests retain the existing task tools.
Repeating the same native call identity reuses that
receipt. Other scopes and filters keep Main's existing tools; missing task data
does not remove the complete shared context. Main retains its installed model,
memory, tool inventory and native result validation.
A trusted surface derives `spokenText`, `readingText` and `displayText` from the
retained result when projecting it. Conversation and explanations stay complete;
a document's spoken summary and full screen content remain distinct. Explicit
Listen uses the full reading view and the original turn’s language, even if the
browser preference changes while Main works. These views do not rewrite the native result,
change its version or authorize a new execution.
An explicit maximum number of list items in the original human request bounds
the list's screen and reading views, including nested detail of omitted items.
Counts remain independent of this presentation cap. Unconstrained lists remain
complete, and the native answer and its receipts stay unchanged.
The accepted canonical turn retains its selected French/English `speechLanguage`
before either brain starts; duplicate intake cannot replace it. Older turns
without that metadata fall back to the received answer's inferred language.
The work presenter explicitly preserves this result language through the shared
player, including every replay segment; later browser preferences apply to new turns.

The result card survives a paused microphone and reconnect. At a natural pause,
one browser claims presentation. Speech starts only while Nestor is listening,
awake and free of another turn. Display does not establish speech; the first
scheduled audio node (or browser-speech start event) and completed playback have
separate receipts. These prove browser playback, not acoustic arrival at the
speaker. Lost/abandoned presentation claims never cause automatic replay. The
person can explicitly listen again, including after an interruption; this only
replays saved speech and never repeats a business action.

The private native route `/api/voice-personas/native/work` accepts only the
instance token and a host-bound native identity. It exposes no arbitrary work,
owner or conversation selector to the model. Family, foreign sessions, foreign
runs and invented receipt references refuse.

## Operating and validation

Install matching Core/plugin code and prepare a dedicated native profile before
enabling intake. Verify the private token, tool inventory, unchanged model/context
settings and native admission. Live canaries go through the installed heavy-work
queue, with coding session/issue, hosts, duration, start window and native
result/release evidence. See [heavy-work queue](HEAVY_WORK_QUEUE.md).

CPU tests use disposable Mongo, native tool/lifecycle fixtures and process
interruption. Browser checks distinguish canonical HTTP/DOM playback receipts,
native model execution and physical-device acceptance. None substitutes for the
others. Keep runtime manifests, receipts and private content outside public Git.
Track capability expansion and acceptance in [issue #664](https://github.com/WindriderQc/AgentX/issues/664).
