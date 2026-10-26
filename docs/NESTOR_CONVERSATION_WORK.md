# Durable Nestor conversation work

Core's optional `conversationWorks` capability lets personal voice dialogue
continue while the complete native Nestor Main works in an isolated session.
In `native` mode, every accepted work request uses Main, including personal tasks,
reasoning, web, specialists and authorized actions. Capability keywords never
select a restricted agent. Main retains its installed tools, memory, model,
permissions and approval contracts. The live guardian continues ordinary
conversation and support while Main works.
Nestor remains the single visible identity.
Core owns acceptance, complete requests, execution metadata, verified task reads,
structured results and presentation receipts. OpenClaw owns the native agent/tool
loop. Polling the browser projection never starts inference.

When the native dispatch owner is free, queued awaited work precedes queued
background reviews. A native review whose guardian has explicitly completed and
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

Core accepts complete work requests before any model inference. An immediate
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
