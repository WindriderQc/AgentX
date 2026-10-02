# Gmail Secretary native tools

This optional OpenClaw plugin retains the existing tool names, bounded Gmail
reader, resumable evidence review, metadata-only search, triage labels, drafts
and explicit native approvals for sending/destructive changes. Gmail remains the
mail authority; tasks and selected memories use the existing Core services.

Run `npm run setup:integrations` at the repository root. The tiny `index.js`
loads the host OpenClaw SDK; the tested tool logic is in `lib/tools.js`. Install
the plugin on the native OpenClaw host using that host's normal plugin workflow.
No host account, scheduler job or mailbox is configured by AgentX startup.

Set plugin configuration outside Git: `gogPath`, `account`,
`keyringPasswordFile`, `attachmentRoot`, `auditLog`, `triageStateFile`,
`evidenceHelperPath` and `evidenceRoot`. Defaults use the current OS home and the
canonical `integrations/secretary/secretary_evidence.py` path. A separately copied
plugin needs an explicit helper path. The helper receives the same configured
account, executable and keyring file as the other tools; use a separate evidence
root for each account. Preserve existing evidence and cursors when reinstalling.

Triage applies the owner's sender rules before the model. Core stores them
(Super Dad desk → "Règles de tri Gmail", `/api/secretary/triage-rules`) and the
plugin reads the enabled ones from `coreUrl` (default `http://127.0.0.1:3180`).
A matching message is labelled directly and listed in `autoTriaged`. Rules only
choose Receipts, Newsletters, FYI or Review; Urgent, Needs Reply and Waiting
need the model and an email-action card. When Core is unreachable, every
message goes to the model. Rules only look at the sender and subject.

A message the model classifies must be read to its last page: `backlog_next`
returns 20,000-character pages, and `continue {id, sourceHash, offset}` reads the
next page. `apply_triage` refuses a message that is only partly read, until
`bodyTruncated` is false. A new category replaces the thread's previous
Secretary category label. The reading position is kept in `readingStateFile`
(default: next to `triageStateFile`).

Named-contact queries are opt-in through `GMAIL_SECRETARY_CONTACT_QUERY`; no
personal query is shipped. See `integrations/secretary/README.md` for the native
helper/watchdog. Tests use synthetic messages and stubbed commands. SDK factory
compatibility was checked with the already installed OpenClaw 2026.7.1; current
host registration, credentials and real mailbox acceptance remain separate.
