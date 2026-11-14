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

### Temporary disk restoration

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
