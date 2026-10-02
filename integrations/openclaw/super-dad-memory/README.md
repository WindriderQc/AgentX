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
`personal_identifier` lists the owner's sealed identifiers (labels and last
digits) through `/api/consumers/nestor/v1/identifiers` and reveals one value
only in the owner's Household session; on Telegram it says the value can be
shown in Super Dad. Core seals identifiers found in notes and journal entries,
so `personal_memory` may return `[coffre: label …1234]` instead of the number.
`vault_note` files a Markdown note through `/api/consumers/nestor/v1/vault/notes`
into the owner's vault inbox (Core's `VAULT_INBOX_PATH`); only the owner context
receives it, and an invalid receipt is reported as not saved.
The gateway continuity endpoint only projects agent catalogs and exact native
run evidence. It does not read or write personal notes.
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
