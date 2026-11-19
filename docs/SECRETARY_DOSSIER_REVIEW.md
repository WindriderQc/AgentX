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

## Native state of a selected historical decision

`GET /api/secretary/history/:id/decision-state` observes the selected committed
Core history document. Its `agentx.history-decision-state/v1` fingerprint binds
the entry revision and projection, exact source references, context version,
decision and confirmation, review history, and complete embedded source-review
state, including pending intents and page progress. Reasons and source bodies
are not returned. A souvenir reference remains `not_rechecked`: reading this
document does not inspect the current note, provider or archive.

The optional `expected` query fingerprint returns `observed_match` or `changed`.
`POST .../decision-state/check` is also read-only: it takes the earlier `entry`
projection, a fresh UUID `observationId`, and optional `expected` fingerprint.
Core compares that projection against its own current entry and returns
`entryMatches` separately from fingerprint equality. A supplied value never
becomes native evidence. The consumer must require both the expected equality
and `entryMatches: true`. The echoed observation identity rejects substitution
of an older response; it creates no durable intent, decision or grant. Core
performs the full JSON comparison so consumers need not reproduce JavaScript
number serialization. The current souvenir projection from a list (`souvenir`)
is excluded by the consumer; its reference remains pinned in the entry.

Both routes use the existing owner human-surface boundary and private/no-store
responses. Family-pinned clients are refused. After the awaited privacy lookup,
a final native read supplies the complete document; an erasure committed during
that lookup cannot return an older decision. Missing and forgotten entries share
the same unavailable response. Input projections are bounded to 256 KiB and the
returned snapshot to 64 KiB. The check stores no observation and records no new
decision; existing privacy suppression still applies.

`retention_reconcile.py --native-decisions` additionally compares the selected
disposition's decision entries, and current primary/related assertions found by
its existing Gmail history discovery, through this native contract. At most
100 entry identities are checked twice with fresh observation IDs and matching
fingerprints. The v2 private report retains native fingerprints, observation IDs
and times, pending intent counts and the unchanged global blockers. A pending
intent returns exit code 2; an unavailable, changed or malformed native reply
refuses without a success report and never falls back to the legacy reader.
An empty selection is `no_selected_entries`, never accepted decision coverage.

Each native snapshot is one committed document, not an atomic batch. The
existing paginated discovery covers entries whose primary source is Gmail;
it does not prove discovery of every cross-source assertion citing mail,
completeness of archive findings, semantic correctness or downstream settlement.
The legacy v1 observation stays available without the flag. Neither report is a
retention-planner acceptance input: all four global native gaps, blocked cleanup
and false execution flags remain. No human approval or mailbox executor is added.

## Native discovery for an exact mail message

`POST /api/secretary/history/decision-state/discover` observes visible owner
history entries citing one selected Gmail message, either as the primary source
or within `relatedSources`. The primary source may be a document, testimony,
export or another supported system. Other messages in the same thread are not
selected. The input contains only `source` (system, message/thread IDs and
original SHA-256), a fresh UUID `observationId`, and optional `expected`
fingerprint. It supplies expectations, never authority or an import.

The `agentx.history-message-scope/v1` snapshot binds the selected reference to
the sorted entry IDs, revisions and native decision-state fingerprints. The
query matches the message identity before checking thread/hash equality, so a
conflicting recorded reference remains an explicit `sourceBinding: conflict`
instead of disappearing behind the selection filter. Every matching reference
on an entry must agree; the client refuses a conflict. The echoed observation
UUID, scope fingerprint and per-entry native checks reject older replies,
missing members, altered projections or a changed decision.

Core performs two bounded membership queries around the existing privacy
checks. Changed membership, decisions or privacy guards refuse the observation;
no old entry is returned after an erasure settles during the privacy lookup.
The reader excludes context source bodies inside MongoDB, then conditionally
projects at most 512 KiB per stored record before materializing it in Node.
It refuses more than 100 entries, 8 MiB of selected stored records or a 4 MiB
response, without returning a partial successful scope. Each database query has
a five-second limit. Responses are private/no-store; the existing owner and
pinned-family boundary applies. No observation or new decision is stored.
Existing privacy suppression still applies to forgotten content.

`retention_reconcile.py --native-message-scope` selects the v3 private report
and implies native decision checks. It discovers exactly 1–20 messages from the
saved disposition file, with at most 100 distinct entries across them and
16 MiB of aggregate responses per observation. It does not paginate or scan
unrelated history. Each discovered member must still match the per-entry native
contract; two agreeing scope observations and fresh entry rechecks are required.
The report retains final scope fingerprints, native member pins and observation
identities/times. Changing shared entries, unavailable contracts, capacity limits
or malformed replies refuse without a success report or legacy fallback. The
archive, saved dispositions and prior reports are unchanged. Existing v1 and v2
modes retain their original behavior.

This covers observed visible membership for the selected messages in Core,
including references across primary source systems. It establishes neither one
atomic cross-document snapshot nor complete archive finding coverage. Empty
membership is `no_selected_entries`, not semantic or cleanup acceptance.
Forgotten entries contribute no decisions. Souvenir/provider/archive state is
not rechecked. All four global native gaps, blocked cleanup and false execution
flags remain; no permission, approval binding, model campaign or executor is added.

## Recorded findings and current Core decisions

`POST /api/secretary/history/decision-state/findings` takes the same exact Gmail
reference, fresh observation UUID and optional expected fingerprint as message
discovery. It observes the current native archive inventory and relates each
recorded finding to exact primary/related Core references. It stores no receipt
and takes no decision. Existing privacy suppression still applies.

The existing SSH mail bridge calls `findings --message ... --thread ... --sha256
... --request-id ...` before any Gmail account/keyring requirement. The
`secretary.archive-findings/v1` reader shares the qualified no-follow file reader
and its 16 MiB total byte budget. It checks the original bytes against their
exact receipt, unique manifest message identity and current review/manifest
`evidenceHash` agreement. All four finding-section arrays and unresolved-thread
questions are required. Missing, stale, ambiguous or malformed metadata refuses
instead of becoming an empty finding set. Limits are 256 selected findings and
128 thread questions; there is no truncated success.

Finding IDs reuse the existing import/disposition algorithm. The response
contains IDs, sections, content/metadata hashes and original byte length, never
finding text, question text or archive paths. Its metadata fingerprint covers
every opened file's bytes. This is an inventory of recorded analysis: the
reader does not recompute the full evidence packet, prove parsed-body/MIME
agreement, complete analysis, independent preservation or semantic correctness.

Core requires two agreeing native inventories with distinct server-generated
nonces, checks every member's existing native decision fingerprint, then
rechecks the complete Core message scope after all producer/entry calls.
Changed inventory, membership, decisions, pending source-review state or an
intervening erasure refuses an older result. The resulting
`agentx.history-finding-scope/v1` snapshot binds both inventories' stable content
to the current native Core scope. The snapshot is bounded to 256 KiB.

Each recorded finding is `no_core_reference`, `needs_review` or
`observed_decision`. The last means only a recorded Core choice with reason/date
and the existing import kind, not an authenticated person or semantic acceptance.
Candidates, retained actions/deliverables, pending source-review intents and
different kinds stay explicit review blockers. Core references outside the
current recorded finding set remain visible. Whole-thread unresolved questions
also hold review of the selected message; no other message becomes a candidate.
An empty recorded finding set cannot establish semantic acceptance.

`retention_reconcile.py --native-finding-scope` selects v4 and implies v3's
bounded message/decision checks. The same local coverage observation supplies
both dispositions and native comparisons. The client requires exact agreement
on the source, review content/evidence hashes, complete recorded finding set,
thread-question count and reconciled Core scope/member versions. It retains the
native snapshot, fingerprint and observation identity/time in the new private
report. Native replies are bounded to 512 KiB; counts alone appear on stdout.
A held finding/message returns exit code 2 even when the earlier export
comparison matches. Unavailable or changed evidence refuses without a success
report or legacy fallback. Previous v1/v2/v3 modes and reports are unchanged.

All four global native acceptance gaps, blocked cleanup and false execution
flags remain. Neither the native inventory nor an `observed_decision` supplies
atomic batch acceptance, complete finding coverage, a current downstream note,
mailbox approval or an executor. Real archive campaigns use the heavy-work queue
and their own authorization; source tests use isolated synthetic fixtures.

## Current linked souvenirs in historical reconciliation

`POST /api/secretary/history/decision-state/downstream` takes the same exact
Gmail source, fresh observation UUID and optional expected fingerprint as
finding discovery. It composes the existing recorded-finding/native-decision
scope with current souvenirs already linked by those Core entries. It creates,
activates, edits, indexes or forgets no note. Unlinked assertions remain
`not_linked`; they are not silently promoted to selected memory.

The existing owner memory capability supplies bounded `souvenirEvidence` through
its own personal-space, active, validity and expiry filters. Pending, forgotten,
expired, out-of-space or missing notes are unavailable. At most 100 selected note
IDs are read, each projected record is bounded inside Mongo to 512 KiB before
materialization, and the total is bounded to 8 MiB. No embedding is read or run.
Family memory callers cannot use this evidence capability.

For an available link, Core binds its revision and opaque content/metadata
fingerprint, exact history-entry backlink, every expected source hash and full
kept source context. The keep path and reader share the same source-reference
projection. Owner corrections to souvenir text, dates, people or places remain
intact; their current fingerprint is observed without copying them into the
historical assertion. Source/context mismatches and unfinished replacements
remain `needs_review`; unavailable links remain held. No note text, quoted
context or source-reference list leaves this response.

Two memory observations must agree, with intervening and final Core
membership/decision/privacy fences. The stable
`agentx.history-downstream-scope/v1` fingerprint includes the existing complete
finding scope and every selected entry's link state. Responses are private/no-store
and bounded to 512 KiB without truncated success. This is a dated observation
of existing links, not an atomic cross-collection snapshot, semantic acceptance,
recall-index qualification, an authenticated human or a provider approval.
Tasks, appointments and other downstream capabilities are not inspected here.

`retention_reconcile.py --native-downstream-scope` selects v6 and implies v4's
finding/message/decision checks. It can also compose the existing v5 restoration
option. Two complete native downstream observations per selected message must
match the previously verified finding scope. Shared entries and shared note
fingerprints must agree across the complete selected message set. Final Core
and archive disposition checks follow these observations before a new private
report is written. Missing or changing evidence has no legacy fallback.
Standard output contains only counts, including current links and unlinked
entries without double-counting shared assertions; held links return exit 2.
Each reply is bounded to 1 MiB, the complete capture to 16 MiB and each HTTP
observation to 60 seconds without automatic retry. Real corpus qualification
still uses its own authorization and heavy-work queue.

All four global native gaps and false/blocked execution flags remain. A current
linked note is not a complete downstream disposition, and an unlinked assertion
is not evidence of either a failed projection or a wish to create memory.
Older decision/finding contracts and v1–v5 reports keep their original behavior.

The [global selected decision contract](SECRETARY_GLOBAL_DECISIONS.md) composes
these observations across 1–20 exact messages, with two complete finding passes
and a final Core membership/privacy fence over the entire selection. Its optional
v8 report retains all global acceptance/approval gaps and changes no decision.

The [global linked-souvenir contract](SECRETARY_GLOBAL_DOWNSTREAM.md) also
observes the whole selected downstream graph. Two complete per-message passes
are fenced by a final joined Core/note query after privacy checks. Optional
v10 reconciliation detects earlier-note changes during later work; all global
acceptance/approval gaps remain and no note or index is written.

## Current live Gmail source in historical reconciliation

`POST /api/secretary/history/decision-state/mailbox` observes one exact selected
Gmail message through the Secretary's existing native account and SSH transport.
The owner surface supplies the audience; input contains only the exact
`source` (`system`, `messageId`, `threadId`, `sourceSha256`), a fresh
`observationId` UUID and optional previous `expected` fingerprint. Caller
headers, account names, search queries and approval flags grant no access.

The native `mailbox-scope` command uses only read-only `gmail.get` with
`--format=raw`, the exact selected message ID, `--gmail-no-send` and the existing
keyring configuration. It qualifies canonical base64url bytes up to 16 MiB,
hashes the actual bytes rather than trusting Gmail's estimated size, and returns
only the hash/length, exact current message/thread IDs, internal date, history
ID and sorted unique label IDs. History IDs remain decimal strings to avoid
64-bit rounding. Metadata is bounded to 256 label IDs of 128 characters each.
Only a typed provider not-found failure becomes `not_found`; authorization,
timeout, transient, malformed or unknown replies refuse without exposing
provider content. There is no archive fallback or provider write.

Core requires two fresh native nonces and agreeing observations, followed by a
final exact Core membership/decision/privacy fence. Conflicting recorded source
bindings refuse before provider access. Absence, changed original hash/thread,
draft and Trash remain explicit blockers. `SENT` and `DRAFT` are label
observations; their absence does not establish receipt, an actor or authorship.
The native account selector is hashed for consistency, not authenticated as an
OAuth subject or a person. A matching source does not accept its meaning.

The response is `agentx.history-mailbox-scope/v1`, private/no-store, and bounded
to 128 KiB; native replies are bounded to 64 KiB. The optional reconciliation
flag `--native-mailbox-scope` selects v7 and implies v4's finding, message and
decision checks. It composes existing v5 restoration and v6 downstream options.
Two complete live scopes per selected message must agree with the already
verified finding scope's Core pins. Account selector hashes must stay equal
across the selection. Replies are bounded to 1 MiB each, 16 MiB aggregate and
60 seconds without automatic retry. Current Gmail internal dates at or beyond
the explicit cutoff add `live_message_outside_cutoff`. Core/archive disposition
pins are rechecked after all native calls. Held evidence yields exit 2; failed
or changing evidence writes no success report. Standard output contains counts;
native fingerprints and metadata remain in the immutable private report.

These are observations across Gmail and Core, not an atomic snapshot, semantic
or preservation acceptance, settled downstream state, an authenticated person,
or a native manifest approval. All four global gaps remain, with
`mailboxEffects: 0`, `approvalBound: false`, `executionAllowed: false` and
`cleanupStatus: blocked`. No real mailbox qualification follows from isolated
tests or installation; real corpus acceptance retains its separate authority.

## Native preservation of a selected source

`POST /api/secretary/history/:id/preservation` takes only a stable UUID
`requestId`, the displayed assertion `revision` and a `source` index (0–18)
from its stored source set. Core derives the exact Gmail message, thread and
original SHA-256. Clients supply no proof, host, archive path, acceptance flag
or approval. This is an owner human-surface route, not a model or family tool.

Core calls `secretary.archive-preservation/v1` through its existing SSH mail
transport on the primary and an optional operator-selected mirror. Each
observation uses a fresh server nonce, which both native replies must echo.
The native reader selects its own evidence root, verifies the pinned original,
every recorded attachment and their full MIME decoding within a 16 MiB total
read budget, 128 attachments and 4,096 MIME parts. Reads use POSIX no-follow
file descriptors and refuse missing, escaped, changed or inconsistent sources.
The final source fence reopens every qualified file and compares its current
bytes with the buffered qualified bytes, checking metadata before and after.
Each verification pass rereads at most the same 16 MiB source-set bound; the
initial source/MIME budget is unchanged. Matching inode/size/timestamps alone
cannot qualify a late same-size rewrite. Multiple finish passes used by native
restoration retain the same bound per pass. This is not an atomic filesystem
snapshot or a guarantee against changes after a completed verification.
They write no archive, restore directory or provider record. Unsupported
encapsulated MIME structures remain explicit refusals.

`verified_scope` requires agreeing source metadata, original and attachment
bytes, MIME counts and distinct hashes of the native machines' `/etc/machine-id`.
Two paths or SSH aliases on one machine cannot count as two copies. An absent
reader, stale nonce, malformed result or read failure stays blocked. The scope
is the selected original, its recorded attachments and MIME decoding; it is
neither the complete archive nor proof of independent physical storage failure
domains, semantic correctness or human consent.

The immutable bounded receipt lives on the existing `PersonalHistoryEntry`.
At most 20 checks are retained, without eviction. Replaying the same UUID and
arguments returns the original receipt without replacing it. Assertion/context
revision fences reject late storage. A lost Mongo acknowledgment is reconciled
with the original UUID, never a new write identity. An unavailable receipt is
not proof that a pending write cannot still settle.

`GET .../:id/preservation` discovers retained request IDs without claiming fresh
native verification. `GET .../:id/preservation/:requestId` rechecks both copies
with a new server nonce. `nativeState: current` means the fresh scope matches
the retained snapshot; it does not turn an originally blocked snapshot into a
verified one. Changed sources or entry versions are stale; unavailable native
reads remain unknown. All responses are private/no-store. Ordinary history
decisions, fact confirmation and selected memory remain unchanged.

Explicit forgetting and source-note erasure clear the embedded proofs, and
pending native reads cannot return or store them after the erasure fence. Only
opaque request-key hashes survive, allowing the same UUID to receive an empty
`erased` acknowledgment. No source identifiers or proof survive in that reply.

The primary uses the existing `SecretaryMailControl` configuration. The mirror
requires both optional `SECRETARY_ARCHIVE_MIRROR_SSH_TARGET` and
`SECRETARY_ARCHIVE_MIRROR_REMOTE_ROOT`; it never falls back to the primary.
The mirror host selects its archive root through the existing native evidence
configuration. These settings are not forwarded by Compose automatically and
their absence activates nothing. Installation, host trust and real-copy
qualification are separate operator work; a large corpus campaign still uses
the heavy-work queue. This contract adds no transport credential or permission.

All four retention-planner native gaps remain explicit: this narrow mechanical
receipt supplies no global preservation acceptance, semantic validation,
atomic decision reconciliation or exact mailbox-approval binding. Every result
keeps `executionAllowed: false` and `cleanupStatus: blocked`. No mailbox
executor, new approval path, migration or actual cleanup is introduced.

### Complete selected restoration scope

`POST /api/secretary/history/preservation-scope` composes existing immutable
restoration receipts for an explicitly selected set of 1–20 exact Gmail messages.
It takes a fresh `observationId`, optional previous `expected` fingerprint and
`checks`: each item has only `entryId`, the retained `requestId`, `snapshotHash`
and exact `source` (`system`, `messageId`, `threadId`, `sourceSha256`). Duplicate
messages, missing receipts, byte-only v1 proofs, originally blocked proofs and
stale assertion/context versions refuse before native restoration starts.

Core rechecks every retained v2 receipt through the existing primary/mirror
restoration transport with fresh server nonces. Every source must remain current
and use the same primary/mirror archive identities across the selected set.
The final bounded Mongo read compares every selected assertion, context and
receipt after all native calls, with source-erasure checks before and after.
There is no partial success, new stored receipt, mode upgrade or fallback.
The database bounds each projected record to 512 KiB and the complete selection
to 4 MiB; the final snapshot is bounded to 1 MiB without truncation.

`agentx.history-restoration-scope/v1` binds the complete selected source-set hash,
retained proofs and current entry pins into one fingerprint. Its nonces/timestamps
stay outside that stable snapshot. A matching expected fingerprint reports
`observed_match`; a mismatch reports `changed`. All results remain private/no-store.
The source-set hash is a canonical projection of the selected exact sources,
not verification of an arbitrary caller-supplied manifest file or other metadata.
The snapshot proves bounded mechanical coverage, not one atomic observation of
all files/documents, all archive metadata, physical storage independence,
semantic interpretation, authenticated human consent or mailbox approval.

`retention_reconcile.py --native-restoration-checks <private-file>` selects v5
and implies v4 finding/message/decision checks. The private JSON array uses the
same `checks` fields and must cover every saved disposition exactly once; an
omission, additional message or different source hash refuses before network
calls. Two native scope observations must match. After restoration, Core
membership/decisions and local archive-derived disposition pins are checked
again before a new immutable private report is written. Original receipts,
saved dispositions, v1–v4 reports and prior behavior remain unchanged. Standard
output contains only status/counts. Exit zero means a matching observation,
never execution authority; all four global gaps and blocked/false flags remain.

Each existing two-copy transport has its unchanged 45-second bound; a full
20-message request can take up to approximately 15 minutes per pass. The client
bounds each response to 2 MiB and each observation timeout to 960 seconds, with
no automatic retry. Real archive restoration is separately authorized queued
work, even though only private temporary copies are removed. Synthetic CPU
fixtures do not establish installed reader, two-host or storage acceptance.

### Temporary disk restoration

The explicit [current review-file graph mode](SECRETARY_REVIEW_PACKET_RESTORATION.md)
also restores original metadata, current packet/review/page receipts, declared
extractions, compound indexes/member blobs and value lanes. It retains distinct
v3 preservation receipts and composes them through the v9 private consumer;
earlier originals/attachments receipts cannot answer this mode.

The same `POST .../:id/preservation` optionally takes
`verification: "restoration"`. An absent value or `"preservation"` keeps the
original byte/MIME check. The selected mode belongs to the immutable UUID:
reusing a UUID cannot upgrade an earlier check or downgrade a restoration.
The combined limit remains 20 retained checks on the existing assertion.
Frozen v1 snapshots keep their original contract and hash.

For restoration, the existing primary and mirror transports call
`restoration --message ... --thread ... --sha256 ... --request-id ...`.
The native `secretary.archive-restoration/v1` command verifies the selected
original and recorded attachments with the existing preservation reader, copies
the exact opened file set into private temporary storage outside the evidence
archive, and reopens that copy through the same native byte/MIME verification.
The copied set also contains its raw receipt and complete thread manifest;
this reads no other message's original and establishes no whole-thread recovery.
The source is checked again for changes during the operation. Temporary files
are removed before a successful result; failed copying, verification or cleanup
cannot yield a successful proof. No provider, account or keyring is needed.
Temporary paths are opened through no-follow directory descriptors. Cleanup
is restricted to the journal of files and directories created by this probe;
unknown or replaced entries refuse cleanup instead of becoming deletion targets.
Cleanup first captures names atomically with `renameat2(RENAME_NOREPLACE)` into
private unpredictable slots, then checks the retained inode identity. Unsupported
platforms and collisions refuse without a weaker replacement operation. The
native OS account and privileged processes remain trusted: this is not a
sandbox against a hostile process with the same UID rewriting private slots.

Each read and restored file set stays within 16 MiB, 131 files and 128 recorded
attachments. The restoration profile also limits relative paths to 32 components
and creates at most 512 directories below its temporary root. These bounds do
not change the v1 reader.
The result retains original machine/archive identities and only hashes, sizes,
MIME counts and restoration counters. It exposes no source or temporary paths,
filenames or contents. Its restoration object binds equal source/restored
file-set hashes, copied file/byte counts and successful temporary removal.
Disk reopen and synchronization qualify this bounded mechanical recovery;
they do not prove crash recovery or independent physical storage failure domains.

Core validates both restoration replies under fresh server nonces and still
requires distinct native machine identities and agreeing selected-source
content. The resulting snapshot is `agentx.history-preservation/v2`; each
copy retains its own complete file-set hash. Complete manifests can differ on
unselected members between copies, while the selected message must agree.
Changing any copied file on a later read makes that retained receipt stale.
Unavailable restoration remains unknown or blocked: Core never substitutes
the earlier byte-only command. `GET` rechecks the stored mode rather than a
client-selected substitute; discovery exposes the retained mode. Existing
assertion/context, lost-acknowledgment, capacity and erasure fences apply.

This optional command creates and removes only a bounded temporary copy. It
writes neither the archive nor mailbox and adds no transport configuration,
permission, human identity or cleanup approval. Synthetic isolated checks do
not establish acceptance on a live archive; large real-copy campaigns retain
their queue and authorization requirements. All four global native gaps and
blocked/false execution flags remain, including whole-manifest preservation
acceptance. The receipt qualifies only its exact selected source and files.

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
