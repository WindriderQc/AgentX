# Native Nestor adapter

This is the OpenClaw Nestor tool/evidence adapter.
OpenClaw keeps its native agent loop, tool execution and transient run receipts.
Selected personal notes live exclusively in Core's Mongo note
collection, shared with the Nestor browser UI and native voice.

Configure `agentxUrl` explicitly for the intended AgentX instance. Optional
`secretarySessionKeys` and `briefingSessionKeys` contain the existing native job
session keys; there are no operator IDs, new schedules or delivery actions here.
A key (`agent:<id>:...`) names the agent that owns the job, so a dedicated mail
agent's triage job can record personal notes without any other agent gaining them.
The existing owner Telegram/Household context checks remain in effect.

`personal_task_dossier` also accepts private Household consultations of the
`secretary` agent when explicitly granted in `tools.alsoAllow`. That scope
only exposes `read` (save an evidence snapshot) and `get` (page the saved task
and sources); other actions are refused before contacting Core. It cannot
save a proposal or change a task. Scheduled, delegated, sandboxed and other
agents' sessions do not gain this access. Recommendations stay in the reply.

`personal_memory` uses `/api/consumers/nestor/v1/memory/notes`. A failed or
ambiguous write is never retried automatically or redirected to a local note
file. List/search coverage and Core receipts are returned to the native tool.
`mail_journal` records and searches the owner-only mail journal through
`/api/consumers/nestor/v1/mail-journal` (one dated digest per thread or
message). It is offered to the owner context and to the configured
`secretarySessionKeys`; `personal_memory` keeps lasting facts only and its
description sends mail summaries to the journal.
`team_brief` is the one way a collaborator shares what it knows with the main
agent: `/api/consumers/nestor/v1/team-brief` returns the same read-only
envelope for each of them (`covers`, `sections`, `beyond`), computed by Core
from that collaborator's own records: the Secretary's mail journal, the
accountant's ledger. It is offered to the owner context only. A new
collaborator is one entry in Core's `teamBriefService` and one value in the
tool's `member` list.
`personal_identifier` lists the owner's sealed identifiers (labels and last
digits) through `/api/consumers/nestor/v1/identifiers` and reveals one value
only in the owner's Household session; on Telegram it says the value can be
shown in Super Dad. Core seals identifiers found in notes and journal entries,
so `personal_memory` may return `[coffre: label …1234]` instead of the number.
`vault_note` files a Markdown note through `/api/consumers/nestor/v1/vault/notes`
into the owner's vault inbox (Core's `VAULT_INBOX_PATH`); only the owner context
receives it, and an invalid receipt is reported as not saved.
`nestor_network`, `nestor_storage`, `nestor_files`, `nestor_gpus` and
`nestor_janitor_report` relay Core's read-only `network_devices`,
`storage_summary`, `find_files`, `gpu_status` and `janitor_report_view` tools
(`/mcp`), which project the optional Data service: observed devices, the
storage index, a bounded file-name search (10 results by default, 25 at most;
names, folders, sizes and dates, never contents), GPU status and the latest
Janitor duplicate report with its DiskX link (counts and logical bytes only;
the survivor rule is never an authorization).
Each answer carries a French sentence stating how old its source is; a stale
scan or GPU sample is said, and an unavailable Data service is a tool failure.
Only the owner context receives them: file names and paths are the owner's.
They are optional tools, enabled per agent in `tools.alsoAllow`; grant them to
`main` only.
`nestor_read_presentation` relays Core's shared `read_presentation` using the
current screen reference's exact `id` and `revision`. It is optional and offered
only to the private owner context; grant it explicitly to `main` if desired.
The adapter owns no snapshot, Analytics query or page reader. Expiry remains an
unavailable read rather than a repeated action. See
[content presentation](../../../docs/CONTENT_PRESENTATION.md).

ISS passes have no adapter here: agents use Core's public `iss_passes` directly
(`agentx__iss_passes` through the `agentx` MCP connection). The plugin only
recognises its results as verified reads in the continuity receipts.

`nestor_photos` answers household photo questions through Core's
`/api/photos` (Immich behind Core; no Immich key here): search by words or
exact filters, count, one photo's details, the known names, and `show`, which
copies up to four previews into the media directory and returns
`MEDIA:<path>` so Household and Telegram show the picture itself. The
audience comes from the host session, never from parameters: the owner reads
everything; a household session of another configured agent (a child or
family member) always reads with `audience=family` (no hidden photo, no
unreviewed generated text). Other sessions get no tool. Grant it in
`tools.alsoAllow` to `main` and to the family agents that may show photos.
The gateway continuity endpoint only projects agent catalogs and exact native
run evidence. It does not read or write personal notes.
When the transcript read throws, the turn projection keeps its fresh run/tool
capsule and returns an explicit `answerObservation` with `reason: read_failed`,
source, session key and run ID. The answer itself remains unavailable. Core may
retain text already verified in that same call, with final provider attribution
unknown. A missing reader or a successful invalid/non-final history emits no
read-failure mark; the projection never exposes the raw error or transcript.
Its existing tool and run receipt capsules include session provenance from the
host context, never the model's arguments or returned provenance. `unknown`
keeps missing legacy context explicit. Provenance grants no action authority;
the native outbound gates retain their own controls. The adapter uses shared
modules from the AgentX checkout.
The gateway media endpoint (`GET /api/nestor/media?path=`) serves one image
file from OpenClaw's media directory (`<state dir>/media`, or `mediaRoot`) so
Household can show a picture the agent generated. It refuses any other
directory, symbolic links leaving it and non-image files, and never lists.

This directory does not install the plugin, move personal data, change active
jobs or establish live Telegram acceptance.

Run `npm test --prefix integrations/openclaw/super-dad-memory`. The Core
Household integration suite also calls this exact adapter over loopback HTTP
against real disposable MongoDB and verifies the result through the Nestor UI
API. OpenClaw's SDK and native runtime are not simulated by that check.

The optional `conversation_work` tool binds a dedicated native worker to Core's
durable personal conversation work. Main can request a migrated task read; the
worker can read canonical context and tasks and publish a verified result.
Isolated `agent:main:household:direct:<uuid>` sessions support exact native dispatch
discovery for background specialist reads. An ambiguous run stays unknown; this
attempt cannot acquire the dedicated worker's model-facing tool capabilities. The
instance supplies `conversationWorkAgentId` and a private `conversationWorkToken`
matching Core, and grants the dedicated worker only this tool. See
[the Core contract](../../../docs/NESTOR_CONVERSATION_WORK.md).

In Core's `native` mode, every accepted personal work uses complete Main rather
than the dedicated worker. Main's `conversation_work context` relays one private
`native_context` read using the hook's exact session/run identity, without an
arbitrary work selector. It refreshes canonical requests, current recent turns,
guardian replies and pending or received results. Earlier tool evidence arrives as
`$evidence` references with summaries; `conversation_work evidence` with an exact
`ref` reads one complete stored value from the same conversation. It grants no worker task or
publication capability. Main retains its installed native tools and specialists;
Core receives the exact native final answer, including a tool-free reasoning
answer or a private no-work review of an adequate greeting. The continuity
catalog advertises `nativeConversation` so an older installation refuses before
dispatch.

The private guardian-work probe binds the same host run to Core's accepted
native-mode turn. All guardian tool calls, including deferred actions, are
blocked while complete Main owns that work. Ordinary conversation still gets
the guardian's native reply. Legacy turns and background Main do not acquire
this restriction. A known guardian remains fenced if Core later fails or its
conversation is erased.

Image tools resolve a background Main's original owner conversation through the
private, host-bound `native_owner` probe before creating, reading or cancelling
an operation. The action key still uses the exact native run and tool call.
`imagex` uses the shared memory plugin's private binding configuration. Ordinary
owner turns keep their existing image routes; a failed owner probe never starts
specialist planning or an image submission.
# Native web consultation budget

For a Core-bound background Main web consultation, the pre-tool hook asks Core
to admit each native call using the host's session, run and call identities.
Core retains the limits and admissions in the existing conversation work.
The hook admits the resolved execution, including failed reads. OpenClaw's
`tool_call` dispatch wrapper is not counted again, so one research call consumes
one admission and the execution remains fenced by Core before it starts.
After four web reads or eight total calls, further tools are blocked and Main
must conclude from checked sources or describe the actual lookup limitation.
General complete Main work has sixteen parent tool admissions and four web reads;
the web-only limit does not consume its remaining non-web permissions.
Ordinary guardian runs and specialist consultations preserve their native
tools. This adds no model-visible tool or grant. Deployment requires matching
Core and plugin versions; the continuity catalog advertises the budget hook.
