# Native Nestor adapter

This is the OpenClaw Nestor tool/evidence adapter.
OpenClaw keeps its native agent loop, tool execution and transient run receipts.
Selected personal notes live exclusively in Core's Mongo note
collection, shared with the Nestor browser UI and native voice.

Configure `agentxUrl` explicitly for the intended AgentX instance. Optional
`secretarySessionKeys` and `briefingSessionKeys` contain the existing native job
session keys; there are no operator IDs, new schedules or delivery actions here.
The existing owner Telegram/Household context checks remain in effect.

`personal_memory` uses `/api/consumers/nestor/v1/memory/notes`. A failed or
ambiguous write is never retried automatically or redirected to a local note
file. List/search coverage and Core receipts are returned to the native tool.
`vault_note` files a Markdown note through `/api/consumers/nestor/v1/vault/notes`
into the owner's vault inbox (Core's `VAULT_INBOX_PATH`); only the owner context
receives it, and an invalid receipt is reported as not saved.
The gateway continuity endpoint only projects agent catalogs and exact native
run evidence. It does not read or write personal notes.
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
