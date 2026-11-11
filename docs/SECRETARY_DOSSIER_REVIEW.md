# Personal dossier review

Core reviews an existing accepted personal task before suggesting a replacement
or closure. A task's age or activity date only requests review. Silence proves
neither that the request remains open nor that it was resolved.

## Source read and proposal

The owner tool `personal_task_dossier` is available on the existing Core MCP
personal transport, `/api/consumers/nestor/v1/mcp`. Local's private native
adapter, Hermes and other authorized owner clients use the same implementation.
The shared and memory-only buses do not advertise this tool.
A later native mail finding can match an active personal task through either
its original mail URL or the thread selection retained in a saved owner
dossier. Multiple dossier receipts still identify that same task. This only
requests fresh reconciliation; it neither closes the task nor accepts another
commitment, and completed tasks are not reopened by the association.
Model tool replies default to bounded metadata (`view: summary`), not source
text. `get` with `view: sources` reads the source index; `view: source` and an
exact `sourceId` reads one saved source. `view: proposal` reads all proposal
fields, gaps and source selection; `schema` reads the proposal schema, `tasks`
reads existing actions, and `document` pages the entire saved receipt.
Paged views return exact JSON fragments with `contentHash`, `offset`,
`nextOffset`, `totalChars` and `complete`. Continue using the returned offset
and hash; a changed value refuses rather than mixing versions. Concatenating
the fragments recovers every original character. Each serialized page stays
within 6,000 characters and preserves Unicode pairs. A partial read remains
explicit and is not proof of complete source coverage. `view: full` retains
the legacy complete model reply; human review and internal services continue
to read the full saved dossier unchanged. Reading another page neither calls
the mail/calendar providers again nor creates another dossier.

It supports:

- `read`: an exact numeric task `ref`, up to three `threadIds`, up to five
  `calendarIds`, and optional explicit ISO `timeMin`/`timeMax`. A source thread
  already linked in the task is included. The default calendar is `primary`;
  that does not establish coverage of other calendars. The read stores a Core
  evidence receipt and returns its `id`, selected scope and missing coverage.
  Unaccepted extractions can read evidence first; their existing human review
  still owns acceptance before a task lifecycle proposal.
- `get`: the saved receipt by `id`, its immutable proposal, task revision and
  any recorded human decision. Its `observedAt` is the read time, not a claim
  that sources have remained unchanged since.
- `propose`: the receipt `id` and an attributed state, proposed action,
  summary, exact source passages, remaining work and uncertainties. Keep the
  settled date choice, confirmed appointment and preparation separate. An
  update explicitly chooses the new action title and deadline, including null.
  `remainingWork` contains established owner commitments. `openQuestions`
  retains missing details separately: an unsent draft creates no duty to send
  it, and no reply to it establishes no duty to follow up. A no-send instruction
  also constrains recommended next steps.

Local's native adapter wraps those canonical arguments in `request`. Core
returns `proposalSchema` with the read, so the adapter does not reproduce the
domain schema or business rules. Hermes uses the canonical owner-tool schema.

Search other relevant recent correspondence with the existing native mail
tools first and include those threads. Source text remains untrusted data.
The bounded native reader orders current provider messages newest first,
keeps drafts distinct and uses the existing conservative quotation boundaries.
New reads use `secretary.dossier-sources/v2`, reusing the depth-aware
`secretary.source-context/v2` engine. Each source retains its unchanged text,
source hash, containing-message provenance, original-body Unicode range and
full segment extent. Author/date claims, verified original matches, ambiguous
resumed text, repeated assertion keys and later replies stay explicit in
`attribution`. An answer need not repeat the quotation to require reconciliation.
The Core proposal keeps this context and exact citation spans; a quoted or
unresolved passage, or an older source with later replies, cannot alone
establish a current commitment or resolution. These reading signals never
identify an addressee's obligation or decide whether a request is resolved.

Saved dossiers keep their original snapshot, proposal and fingerprint. On the
human apply path, Core requests each saved thread's original reader contract;
legacy snapshots request `secretary.dossier-sources/v1`, preserving the earlier
segmentation and source IDs. The native bridge accepts only those explicit
versions. Existing receipts are neither rewritten nor automatically reread.
Quoted text never inherits the containing message's author or date. Existing
verified attachment extractions are read separately, without OCR, embeddings
or inference. Their containing mail date is provenance, not the document's
printed date. Missing originals, corrupt originals, unread scans, external
linked documents and truncated text stay explicit gaps. Only selected sources
are covered; an empty calendar does not disprove a booking confirmed by mail.

Core checks that cited passages occur in the saved source. A non-uncertain
state needs a dated source outside drafts and quotations. This validates the
reference, not the semantic correctness of a model's conclusion. The human
still reads the evidence. A closure proposal refuses incomplete coverage,
remaining work or uncertainties. Uncertain dossiers stay open for clarification.

## Human decision and history

`/dad/day` shows each pending proposal, its actor, remaining preparation,
source excerpts, source dates and links. Applying requires a second explicit
click; dismissal is separate. There is no age-based bulk-close control.

The human route `POST /api/secretary/tasks/dossier/:id/decision` accepts the
displayed `proposalHash`, task `revision`, and `decision: apply|dismiss`.
Application re-reads native versions and the open task snapshot. Changed
sources, task revisions or another decision refuse instead of overwriting.
The same task retains its ID, original source note, previous wording in
feedback and a link to its immutable evidence receipt. An open action keeps
its last decision and dated evidence visible after application or dismissal.
The decision receipt
commits in the task's atomic version-checked update; a status change carries
the existing canonical transition event. Replaying the identical decision
returns that receipt, including after completion. A different decision refuses.
Repeating-task changes continue through the existing occurrence workflow.

The MCP tool has no apply operation. A proposal, its state, and its source
content grant no authority to send mail, invite, reschedule or notify anyone.
The dossier workflow performs none of those external mutations.

## Historical source-text reviews

The existing `/dad/history` assertion has a separate source-review panel. It
records a person's explicit review of an exact text scope without confirming a
fact or context, closing a follow-up, accepting a personal commitment or granting
mailbox permission. Ordinary history decisions retain their existing meanings.
Core owns the bounded observations, served-page coverage and decision receipts
on that same `PersonalHistoryEntry`; there is no parallel register or copied mail
store. An entry retains at most 20 snapshots, each at most 256 KiB, without
automatic eviction of its earlier reviews.

`POST /api/secretary/history/:id/source-review` takes the displayed `revision`
and a stable UUID `requestId`. Core derives the source set from the stored
assertion and its related sources, rather than accepting client-supplied source
hashes or coverage. The native `secretary.archive-reader/v3` checks each pinned
Gmail original's bytes. The snapshot binds message/thread identities, original
hashes, reader contract, text-part hashes and lengths, attachment/reading gaps,
assertion revision and context revision/hash. Only metadata and fingerprints are
stored; mail bodies remain in their existing archive.

New snapshots use `agentx.history-source-review/v2` and also freeze the native
original `From`, `To`, `Cc`, `Date` and `Subject` headers, each bounded by the
reader's 2,000-character limit. The owner panel displays them as escaped text,
including empty fields as unknown. A message's declared date is not a fact date,
and its sender does not establish who wrote a quotation. Reaching the native
header limit remains an explicit gap. Missing or malformed headers make the
new source observation unavailable; changed headers invalidate page delivery
and a pending decision. Frozen v1 snapshots keep their original hashes and
resume under their original contract without synthesized headers.

`GET .../source-review/:requestId` retrieves that receipt and rechecks its native
sources. An unavailable reader remains unknown, never a substituted source or
proof of disappearance. Unsupported sources, including selected Outlook exports,
remain explicit gaps; this workflow imports nothing. `GET .../:requestId/page`
accepts the exact `source`, `part` and continuation `offset`. It rechecks native
identity and versions, serves one bounded text page and advances coverage under
a version check. Repeated pages are safe, skipped pages refuse, and Unicode
offsets retain the native reader's character units. Coverage means pages served,
never comprehension. Attachments, HTML supplements, unreadable or extracted-text
limits and compound members remain gaps even when all readable text is served.

`POST .../:requestId/decision` takes `snapshotHash`, the original `revision`,
`decision: reviewed_scope|needs_follow_up` and a reason. `reviewed_scope` requires
all readable text parts to have been served; `needs_follow_up` retains partial
or unknown coverage. Neither is global semantic acceptance. Core rereads the
same native scope before atomically recording the decision on the assertion.
The decision increments its revision, invalidating other drafts and stale
history forms, while leaving its fact, context and follow-up states unchanged.
The same intent replays its exact receipt after a lost response; different
content under that identity refuses. Core reserves the sealed decision intent
on the same review before native revalidation; this reservation is not an
accepted review. A retry containing only `intentHash` can resume that retained
intent but cannot supply a new choice or reason. The browser durably journals
only UUIDs and fingerprints, never reasons or mail bodies. Unavailable storage
blocks a new write. Before Core acknowledges the intent, its content stays in
browser RAM only; closing the page cannot reconstruct content Core never
received. That outcome stays unknown and locked to the same identity. Refresh
reconciles that same intent; a still-current GET without a decision does not
prove the previous POST cannot arrive later. The user sees the actual recorded
choice, reason and date, or an immutable pending intent to retry. Terminal
receipts clear that temporary decision journal. Earlier receipt identities
remain discoverable on the same assertion, without a client-side registry.

Changed native bytes, assertion/context revisions and concurrent decisions
refuse late updates. Explicit forgetting and existing source-note erasure clear
all embedded source reviews together with the assertion; pending native reads
cannot write a late receipt or return their page after the erasure fence.
Only opaque request-key hashes survive as transport suppression fences; they
contain no source snapshot, message body or decision reason.
For a known request key, the read route can confirm that canonical erasure with
an empty `erased` acknowledgement, allowing the browser to remove its pending
transport journal without treating an unknown response as an erasure receipt.
Old decisions remain historical observations, not claims that sources stayed
current. Native availability is rechecked on opening a review, not inferred from
a stored decision. Source replies use private, non-cacheable HTTP responses and
the browser renders text inertly.

These are existing owner human-surface routes, not an MCP apply operation. A
server-selected family audience refuses before source access. Private LAN
access does not authenticate a person or establish an independent reviewer;
the receipt records that limitation. Names, model text, headers and client
`verified` flags provide no consent or authority. The retention planner v2 keeps
all four native acceptance gaps and its blocked/false execution flags. This
source-text review supplies no cleanup manifest, grant or executor.

## Catch-up and duplicate candidates

Future catch-up findings retain their actor, source status and date. Resolved,
waiting, historical and uncertain actions become reconciliation signals. A
current action on a thread already linked to an open personal task also becomes
a signal, rather than another inbox action. Exact source identity supplies
candidates, not proof that two tasks are duplicates. Signals change no task and
carry no acceptance or closure authority. The fresh dossier read includes them
as extraction hints alongside native sources. Old reading receipts are retained;
installation does not launch a replay of the archive.

## Installation and validation

Install the Core code and native `integrations/secretary` helper from the same
revision. The native `super-dad-memory` plugin retains Core currentness and
review references in its bounded task context; install that adapter revision
as well. Enable the tool explicitly in the owner's native MCP tool selection
and install the reviewed agentx skill through that runtime's skill
mechanism. Keep family profiles outside the owner bus. Do not replace a live
configuration with a template or alter installed model/context contracts.

Disposable Mongo tests verify proposals, evidence gaps, concurrent decisions,
source changes, task identity and replay. The browser journey verifies displayed
citations and the human decision on desktop/mobile. Native reader tests verify
provider attribution and archived extraction integrity. These checks do not
qualify an autonomous Nestor answer. Native model acceptance uses the existing
heavy-work queue and retains its original request/result identity. Instance
data, transcripts and receipts remain outside public Git.
