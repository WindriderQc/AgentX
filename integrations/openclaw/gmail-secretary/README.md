# Gmail Secretary native tools

This optional OpenClaw plugin retains the existing tool names, bounded Gmail
reader, resumable evidence review, metadata-only search, triage labels, drafts
and explicit native approvals for sending/destructive changes. Gmail remains the
mail authority; tasks and selected memories use the existing Core services.

Run `npm run setup:integrations` at the repository root. The tiny `index.js`
loads the host OpenClaw SDK; the tested tool logic is in `lib/tools.js`. Install
the plugin on the native OpenClaw host using that host's normal plugin workflow.
No host account, scheduler job or mailbox is configured by AgentX startup.

For a dedicated mail specialist, set `agentIds` to its native agent ID. Every
Gmail tool then uses a session-bound native factory and is absent from other
agents, with an additional call-time gate. Omit `agentIds` to retain the existing
installation's tool-policy behavior. OpenClaw propagates a requester's explicit
tool denials to spawned specialists: when using this scope, remove Gmail-specific
denials from the delegating agent so its mail specialist can retain its tools.
Keep the specialist's own allowlist and native approvals in place.

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
next page. Direct `read(kind=message)` uses the same sequential reading guard.
`apply_triage` requires the exact `messageId` and `threadId` of a fully read,
source-pinned message. Missing receipts, skipped pages and changed source/page
bounds refuse. A new category replaces only that message's previous Secretary
category labels. Other members of the thread retain all labels, Inbox and read
state; verified receipts state `scope=message`. Sender-rule receipts explicitly
report that their bodies were not read. Classification is separate from archive
analysis and cleanup qualification. The reading position is kept in
`readingStateFile` (default: next to `triageStateFile`).
The generic organizer requires native one-time approval to add
`Secretary/Processed` to whole threads; background sessions cannot bypass the
message reading guard through that organizer. Explicit owner bulk organization
retains its approval path. Previously applied thread labels are not retroactive
proof that every message was read.

## Sending and mailbox approvals

Sending first prepares a Gmail draft through gog's native compose paths. This
resolves reply/reply-all recipients, signatures, quoted content and forwarded
attachments before approval. Existing drafts are read directly. The approval
lists the actual From, To, Cc and Bcc addresses, subject, attachment count,
explicit body preview and length, draft identity and snapshot fingerprint.
Review the complete draft in Gmail when the preview is insufficient. Recipient
lists and subjects are never silently truncated: a message whose mandatory
details exceed the native 512-character approval limit must be sent in Gmail.

Only the native resolution callback's `allow-once` grants a send. The grant
expires after 30 seconds, matches the native agent, session, call ID and complete arguments,
and is consumed before execution. Denial, timeout, cancellation, changed drafts
or missing callbacks refuse. Immediately before sending, the plugin verifies
the draft still matches, then sends the captured RFC822 bytes rather than a
mutable draft ID. Subsequent file or draft edits cannot change those bytes.
The plugin does not delete source drafts; they remain available for review or
separately approved deletion, including when sending is denied. After an
uncertain send result, reconcile the message in Gmail Sent before retrying.

This path needs Python 3 (standard library only), gog's `gmail drafts
create|reply|reply-all|forward`, `drafts get --format=raw` and `send --raw-file=-`,
and an OpenClaw runtime that resolves `requireApproval.onResolution` with the
native tool call ID and displays the complete description. Unsupported clients
refuse; there is no fallback to sending by unresolved ID. Exact snapshots are
bounded to 40 MB of base64/JSON input. MIME inspection and send bytes stay in
process memory and pipes, outside model context and provenance logs. Tests
exercise the real local MIME parser and stub Gmail; installed SDK/channel
presentation and actual mailbox effects require separate native qualification.
See [OpenClaw's approval contract](https://docs.openclaw.ai/plugins/plugin-permission-requests).

Organizer approval also covers adding Spam/Trash or removing Inbox through
label modification, including case/whitespace and CSV aliases. Policy and
command builders share label normalization. Quoted or control-character label
entries refuse; opaque user-label IDs require approval because they may resolve
to a protected Secretary label. Ordinary review labels remain available to
background triage.

The triage digest searches and records the exact message identity in Core; an
existing digest for another member or only the thread cannot hide the message.
Journal retention and failed delivery remain explicit in the returned/audited
receipt. Historical preservation uses the archive and source-assertion review;
it does not extend the short journal's retention. Deploy the Core message filter
before updating the native plugin, then qualify real mailbox effects separately.

Named-contact queries are opt-in through `GMAIL_SECRETARY_CONTACT_QUERY`; no
personal query is shipped. See `integrations/secretary/README.md` for the native
helper/watchdog. Tests use synthetic messages and stubbed commands. SDK factory
compatibility was checked with the already installed OpenClaw 2026.7.1; current
host registration, credentials and real mailbox acceptance remain separate.

## Action provenance

Gmail hooks record the trusted native session origin and hashed session/run/call
references in the existing private audit log, without input or output content.
Background review and scheduled sessions cannot send mail or perform mailbox
changes that require approval. They can read, prepare drafts and record bounded
review evidence. A conversation retains the existing one-time approval gate.
The shared classifier reads Nestor's configured Secretary/briefing session keys;
the model cannot declare its own origin. This labels session context and grants
no execution authority. Load this adapter from the complete AgentX checkout.
