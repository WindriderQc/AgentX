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
`nestor_network`, `nestor_storage`, `nestor_files` and `nestor_gpus` relay
Core's read-only `network_devices`, `storage_summary`, `find_files` and
`gpu_status` tools (`/mcp`), which project the optional Data service: observed
devices, the storage index, a bounded file-name search (10 results by default,
25 at most; names, folders, sizes and dates, never contents) and GPU status.
Each answer carries a French sentence stating how old its source is; a stale
scan or GPU sample is said, and an unavailable Data service is a tool failure.
Only the owner context receives them: file names and paths are the owner's.
They are optional tools, enabled per agent in `tools.alsoAllow`; grant them to
`main` only.
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
Isolated `agent:main:household:work:<uuid>` sessions support exact native dispatch
discovery for background specialist reads. An ambiguous run stays unknown; this
namespace cannot acquire the dedicated worker's model-facing tool capabilities. The
instance supplies `conversationWorkAgentId` and a private `conversationWorkToken`
matching Core, and grants the dedicated worker only this tool. See
[the Core contract](../../../docs/NESTOR_CONVERSATION_WORK.md).
