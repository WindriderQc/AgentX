# Durable Nestor conversation work

Core's optional `conversationWorks` capability lets personal voice dialogue
continue while a separate native Nestor worker checks personal tasks or reviews
a completed conversational turn. Conservative current public-information reads
and explicit personal mailbox reads run in isolated background Main sessions,
retaining Main's web tools and native Secretary delegation.
Nestor remains the single visible identity.
Core owns acceptance, complete requests, execution metadata, verified task reads,
structured results and presentation receipts. OpenClaw owns the native agent/tool
loop. Polling the browser projection never starts inference.

## Contract

Enable `PERSONAL_CONVERSATION_WORK_MODE=read` (or `observe` for review without
business reads), `PERSONAL_CONVERSATION_WORK_AGENT_ID` and a private
`PERSONAL_CONVERSATION_WORK_TOKEN`. The default mode is `off`. The native plugin
needs the same token in `conversationWorkToken`, and the dedicated agent ID in
`conversationWorkAgentId`. Tokens stay in instance secret configuration, never
model parameters or browser requests.

The dedicated agent has its own workspace, no visible channel, no heartbeat,
no subagents and no cloud/CPU fallback. Grant only `conversation_work` plus the
native tool-discovery transport. Do not reuse Main, the family agent or an
existing specialist. Preserve the installed guardian and worker model/context
contracts; the worker request bounds output to 4,096 tokens without changing
model residency or context. The worker gets selected Core context through the
context tool, and explicitly marked excerpts of recent turns. The complete
current human request is always retained and returned. Inputs outside the
4,000-character intake budget refuse instead of truncating.

Only Main's standard personal voice turns enter this capability. Text, Open,
explicit specialist requests, LLMx and family conversation retain their existing
paths and permissions. Core fixes the accepted mode per work, so switching the
flag off stops new intake while accepted work remains observable and deliverable.
The observer stays available until accepted work has settled.

Before guardian inference, Core commits an immutable accepted request and a
canonical human turn with one pending assistant slot. Completion replaces that
slot once. A stable browser turn ID deduplicates requests; changed content under
the same ID conflicts. Selected context is committed separately before work can
be queued. Simple greetings need no worker. Unclassified conversational turns
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
native session/run and terminal lifecycle receipt; missing history, transport
failure and a returned HTTP promise do not prove settlement. Native runtime
admission and workload ownership remain authoritative.

The plugin binds calls using the native before-tool hook's session, run and call
identity. Main's `conversation_work request` returns acceptance and result
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

The guardian’s next selected context includes canonical statuses and received
results from the same conversation, so it can follow up on the worker’s work.
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
