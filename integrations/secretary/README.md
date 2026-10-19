# Native Secretary evidence and watchdog

`secretary_evidence.py` preserves complete private Gmail sources, bounded read
pages, resumable reviews, attachment hashes and the existing accounting export.
It reads Gmail through `gog`; it does not send mail, change mailbox state or create
a second task/memory authority. Source-linked task/memory receipts still point to
Core. Private evidence stays under an external `--root` / `GMAIL_SECRETARY_ROOT`.

Configure `GMAIL_SECRETARY_GOG`, `GMAIL_SECRETARY_ACCOUNT` and
`GMAIL_SECRETARY_KEYRING_FILE` outside Git. `GMAIL_SECRETARY_CONTACT_QUERY` is an
optional private named-contact search; generic invoice/mailbox scopes are built
in. Existing contact inventory can remain in the private archive even when that
query is disabled. Accounting publication remains off until an owner sets a
destination; preserve the existing private `publish.json` deliberately.

The archive reader can machine-read images and scanned PDFs with locally
installed Tesseract (`fra+eng`) and Poppler (`pdftoppm`). PDFs use 200 dpi and at
most 12 pages. Rendering and all OCR pages share a 150-second deadline; no tool
is installed or invoked by the test suite. DOCX native text uses Python's standard
library. `ocr --limit N` works only on the external archive, without Gmail access.
The native next-page operation attempts at most one file after a quick collection.

OCR is recorded separately by file hash as `ocr_text_extracted`, never as native
text or visual acceptance. Unreadable/timeout attempts do not loop. Files still
need visual review and their threads cannot become complete. Existing archived
originals are reused; changed evidence reissues pages and preserves earlier
findings as partial. OCR does not expand Nestor conversation upload formats.

When a thread's evidence changes, page recording retains findings and task/note
receipts whose message and attachment citations still exist. Findings from
removed sources stay in the exact prior review under
`review-history/<thread id>/<content hash>.json`; they do not block new pages or
become findings about a different source. Only summaries for unchanged source
pages survive. Unresolved questions remain open, and earlier quality acceptance
does not certify the new revision. Current page citations are still validated.

Discovery retains every source ID, including replaced drafts. When a collected
thread omits a discovered ID, the collector checks that message individually.
Only a typed Gmail not-found response records it as unavailable; authorization,
network and unclassified failures keep the source pending. Immutable
`source-observations/` receipts back the `source-availability/` index. Rediscovery
reopens collection without removing those receipts. Native progress and raw
completeness report unavailable sources separately from uncollected sources.
Unavailable means the provider could not return the source; it does not certify
preservation, analysis or eligibility for mailbox cleanup.

`openclaw_gmail_secretary_watchdog.py` retains the stale-review, resumable
mailbox and auto-disabled-job handling. It requires explicit `--account`,
`--triage-job-id` and `--watchdog-job-id`; executable, audit/keyring paths and
cadences are configurable. It can edit those selected native schedules, so it is
not launched automatically by AgentX. Preserve deliberate owner pauses.

No old installer containing private job IDs, contact prompts, or account paths is
shipped. Configure the existing native job after reviewing its current state,
with backup copies outside Git. Existing synthetic Python tests run through
`node scripts/test-native-tools.cjs`; this does not contact Gmail/OpenClaw.

Native source review follows [personal action review](personal-action-review.md).
My day keeps all findings in categories: owner actions, requests to clarify,
technical follow-ups and Secretary reading. Mail-derived personal tasks remain
proposals until accepted as owner actions. Existing
imports without an acceptance record are projected for review without a bulk
rewrite; platform alerts and assistant reading steps also leave the daily focus.
Review preserves the source note and records the decision and original title.
Dismissal is reversible and never records the proposal as completed. The human
capture and idea-promotion paths retain their explicit acceptance.

## One-time mailbox catch-up

`mailbox_backfill.py` copies every discovered but uncollected thread into the
same private archive, back to back and without a model, then stops. It is the
catch-up job, not a schedule: start it once (for example as a transient
`systemd-run --user` unit on the native host), let it finish, and leave the
steady Secretary run to handle new mail.

It first finishes any incomplete discovery and adds mail newer than the
completed inventories, then collects threads newest first through the same
read-only `gog` collector and attachment store. Provider calls are spaced
(`--min-interval`, default 0.2 s) and transient failures are retried with
backoff; several failed threads in a row stop the run as `stopped`, since that
means quota, credentials or network. Every collected thread survives an
interruption, so running it again resumes. `--max-threads N` makes a measured
trial run.

Only one runner works on an archive (`backfill.lock`, taken over when its
process is gone). While the lock is fresh, the triage-driven `native_next`
skips its own collection and keeps reviewing pages. `--status` prints
`backfill-status.json`: phase, threads collected and failed, remaining, rate,
ETA and provider calls. Failed thread ids are kept in `backfill-errors.json`.
Neither file contains message content.

```bash
python3 integrations/secretary/mailbox_backfill.py --root "$GMAIL_SECRETARY_ROOT" --max-threads 50
python3 integrations/secretary/mailbox_backfill.py --root "$GMAIL_SECRETARY_ROOT" --status
```

## Catch-up review of collected pages

`mail_catchup.py` reviews every unread evidence page back to back, then stops.
It replaces the two pages per triage turn for a large archive: each page goes
through Core's `/api/inference/generate` (`--task-type`, default `analysis`) with
a JSON schema, and is recorded by `evidence_record.record_page`, the same
validation the agent's `gmail_secretary_evidence` record uses. No OpenClaw
session or transcript is created, so a long catch-up never grows an agent's
session store.

Pages run by lane: named correspondence (`contact`), invoice attachments,
invoice mail, the rest of the mailbox, and Gmail promotions/social/updates/forums
(`bulk`) last. `--light-model` (with `--light-host`) sends the bulk lane to a
smaller model; `--lanes` restricts or reorders lanes and `--max-pages N` makes a
measured trial run. Before each page it reads Core's runtime coordination and
pauses while maintenance or a benchmark workload is active; Core refusals and
outages also pause on the same page instead of failing it. Invalid model output
is logged in `catchup-errors.json`; several failures in a row stop the run.

Nothing is written to the owner's tasks or memory. A finding the model marks
`current` in mail from the last 30 days is kept in `catchup-proposals.json` and
sent to Core's `POST /api/secretary/catchup/proposals`, which files it once (by
its key) as an idea in Dad's inbox to promote or set aside; the file then marks
it `queued` with the idea id, and an unreachable Core leaves it `pending` for the
next try. Dad's desk shows the job's progress from `secretary_mail_desk.py
catchup` (counts only). `--instructions-file` adds private
owner instructions kept outside Git (for example which correspondence matters).
While `catchup.lock` is fresh, `native_next` only collects new mail and returns
`empty`, and the watchdog no longer holds triage at catch-up cadence for deep
review. `--status` prints `catchup-status.json`: phase, per-lane counts,
proposals, pages per hour, ETA, pause reason and last error, never content.

```bash
python3 integrations/secretary/mail_catchup.py --root "$GMAIL_SECRETARY_ROOT" --lanes contact --max-pages 20
python3 integrations/secretary/mail_catchup.py --root "$GMAIL_SECRETARY_ROOT" --status
```

### Steady review after the catch-up

Once the archive is caught up, the same job keeps it so: run it after each
archive sync with `--task-type mail_review` and no `--light-model`. It reviews
only the pages collected since the last run, then stops. `mail_review` is its
own Core task, so the Nerve Center routing table chooses the model and host;
the task stays on that host. Each page is one short request and nothing waits
on the answer, which suits a CPU-resident host and leaves the GPU hosts to
conversation.

```bash
python3 integrations/secretary/mail_catchup.py --root "$GMAIL_SECRETARY_ROOT" --task-type mail_review
```

## Original messages and completeness

`raw_messages.py sync` stores the original of every message in every archived
thread, exactly as Gmail keeps it (`format=raw`), as a content-addressed
`raw/<sha256>.eml` that any mail client opens. A copy is accepted only when its
decoded size equals Gmail's `sizeEstimate` and its Message-ID equals the one
already archived; the receipt in `raw-receipts/<message id>.json` records the
hash, size, labels, dates and path. Mismatches are listed by id in
`raw-errors.json` and retried on the next run. It reuses the backfill's paced,
resumable runner with its own `raw-sync.lock`, so triage collection is not
paused. `--rehash` also refetches an original whose SHA-256 no longer matches.

`raw_messages.py completeness` reports, per discovery scope, the messages
discovered, archived in a thread and with a verified original, and lists the
missing ids in `completeness-report.json` (`--rehash` re-reads every original).
It exits non-zero until everything is complete. Neither command contacts Gmail
for anything but read-only `gmail.get`, and no output contains message content.

```bash
python3 integrations/secretary/raw_messages.py --root "$GMAIL_SECRETARY_ROOT" sync --max-messages 30
python3 integrations/secretary/raw_messages.py --root "$GMAIL_SECRETARY_ROOT" completeness
```

## Historical coverage and preservation evidence

`history_coverage.py` prepares a chronological inventory and review backlog from
the existing Gmail archive. Supply an explicit timezone-aware `--before` cutoff.
Each row names a message, its immutable-source hash, review revision, reading
coverage, extracted-finding identities and outstanding checks. A thread can
contain messages on both sides of the cutoff: recent messages are excluded
individually. Unknown dates and drafts remain visible as blocked work.

This is an archive coverage report, not proof that discovery includes the entire
live mailbox. `Secretary/Processed`, `coverage: complete` and empty finding arrays
do not establish validated interpretation, message-level classification, resolved
actions or addressed information. The report contains no Gmail commands and
grants no mailbox approval. Existing native approvals still own mailbox effects.

`verify_archive.py --proof <private-file>` adds per-source hash verification
evidence to the existing verifier. Its report fails if an archived message has
no raw receipt, even when all receipts that remain are intact. A proof records
the host, root, source hashes and optional MIME restore sample. Coverage accepts
independent-copy evidence only from a different host with matching source hashes;
another directory on the same host does not establish independent preservation.
Hash verification and restoration of a large live archive use the instance's
heavy-work queue; synthetic tests remain ordinary isolated checks.

```bash
python3 integrations/secretary/verify_archive.py "$ARCHIVE_COPY" --sample 20 --proof "$PRIVATE_PROOF" --report "$PRIVATE_VERIFICATION_REPORT"
python3 integrations/secretary/history_coverage.py --root "$GMAIL_SECRETARY_ROOT" --before "$HISTORY_CUTOFF_WITH_OFFSET" --primary-proof "$PRIVATE_PRIMARY_PROOF" --mirror-proof "$PRIVATE_MIRROR_PROOF" --output "$PRIVATE_COVERAGE_REPORT"
```

Reports and proof files contain private source identifiers and stay outside Git.
The separate Outlook import is not part of Gmail coverage; selecting an existing
export does not start an Outlook synchronization or a new import.

### Chronological source review in Core

`history_import.py` projects existing Gmail findings into Core's historical
review at `/dad/history`, starting with the oldest source. A prepared private
manifest pins the source, finding and review hashes. `--publish` submits bounded
batches to `/api/secretary/history/import`; exact source-key receipts let an
interrupted delivery resume without creating another assertion. Use the same
delivery state when preparing a new manifest to advance beyond delivered rows.
Preparation never calls Gmail or a model. Larger preparations/imports use the
instance's queued CPU/IO window.

Imported assertions remain candidates, with their extracted actor, raw status,
source date and event date kept separate. Unknown event dates stay unknown.
Review can retain an assertion, resolve an action/deliverable, dismiss it or
forget it using the current revision. Retaining an action keeps it in the open
review list. This creates neither an accepted personal task nor a selected memory.
`POST /api/secretary/history/:id/souvenir` (current revision) is the owner's
explicit choice to keep a non-action assertion as a souvenir: a permanent owner
memory note (`kind: souvenir`) with its event date, people, places and source
references. Keeping it again returns the same note. Decisions retain a revision
history; forgotten identities suppress replay, forgetting a linked owner note or
souvenir suppresses its historical source too, and forgetting the source forgets
its souvenir.

The source reader uses the preserved `.eml`, pinned by its SHA-256, through the
existing native Secretary host bridge. It paginates body text without Gmail or
credentials and lists attachment metadata separately. Corruption, changed source
hashes, unsafe paths and oversized originals refuse explicitly. The body view
does not establish attachment reading. Sources remain readable when provider
links disappear. HTTP reads and review retain the instance's existing private
LAN human entrance; owner scope separates native domains, not human identities.

Reader contract `secretary.archive-reader/v3` enumerates inline MIME text
representations and permits an exact bounded `part` selector, with independent
pagination and decoded-text hashes. The review page lets the reader inspect
plain text and HTML converted to inert text separately. A preferred body view
does not certify the other versions; unreadable alternatives remain visible.
Nested message attachments and unnamed documents remain attachments, with their
own authorship/content review, rather than silently becoming the outer body.
HTML reading also exposes link/resource destinations, image descriptions,
attribute text and script data as a bounded inert supplement. No link is fetched
and no script executes. Clipped values and omitted entries stay explicit review
gaps; the original remains the retrieval source. Supplements do not change body
text, decoded-text hashes or pagination offsets. Legacy evidence pages retain
their preferred-body text and are not retroactively qualified by this reader.

The importer reports stale reviews, unknown dates, missing originals, oversized
findings and thread questions that lack message attribution. Those gaps remain
outstanding review work. Outlook exports are outside this adapter's scope.

```bash
python3 integrations/secretary/history_import.py --root "$GMAIL_SECRETARY_ROOT" --maximum 200 --manifest "$PRIVATE_HISTORY_BATCH" --state "$PRIVATE_HISTORY_DELIVERY"
python3 integrations/secretary/history_import.py --root "$GMAIL_SECRETARY_ROOT" --manifest "$PRIVATE_HISTORY_BATCH" --state "$PRIVATE_HISTORY_DELIVERY" --core "$CORE_ORIGIN" --publish
```

### Preparing exact-message cleanup review

`retention_plan.py` combines chronological coverage, a fresh completed Gmail ID
inventory, independent-copy proofs, a triage qualification and exact-message
analysis/disposition receipts. The inventory query uses the cutoff's epoch
seconds, including Spam and Trash with `in:anywhere`; ambiguous dates, duplicate
IDs, unfinished pagination and observations older than 24 hours hold candidates.
This is an observed inventory, not an atomic mailbox snapshot.

The qualification uses `agentx.secretary-retention-qualification/v1`, requires
an explicit boolean `qualified: true`, identifies
the reviewer and corpus hash, and records compared cases for full bodies,
pagination, quoted authors, dates, sent mail, drafts, attachments, calendar,
contacts, invoices, later replies and untrusted mail instructions. These are
reviewer attestations to inspect, not independent proof that conclusions are true.
The planner never creates a successful qualification or analysis on its own.
Passing individual extraction focus checks does not override a false or missing
whole-process attestation. Reference comparison reports remain separate from
successful qualification receipts.
Qualification also covers signature information, owner aliases, MIME alternatives
and external documents. Each analysis separately attests signature/identity
checks, all MIME representations and external-reference disposition. An empty
legacy finding array is never evidence that these checks passed. Synthetic
reference inputs live in `fixtures/retention-challenges.json`; that corpus is
explicitly unqualified until actual results are compared and reviewed.

Analysis receipts use `agentx.secretary-retention-analysis/v1` and pin the original,
current thread/review hashes, qualification hash and `reviewPacket` hash. Exact
page, attachment, finding and thread-question sets require dispositions with a
reason and evidence reference. Keeping an action open cannot discharge it. A
changed source or review invalidates the old decision; conflicting decisions hold
the message. Missing originals/copies, drafts, unknown dates and stale thread
reviews cannot be waived by an analysis receipt.

Use `verify_archive.py --tree-index <pinned-native-mirror-state>` on both copies
to rehash the complete indexed archive, including metadata. Incremental mirrors
may skip unchanged size/mtime entries; that shortcut is not a fresh integrity
check. The proof records the shared index hash and only actually verified files.
The planner also checks that the current manifest, provider projection, raw
receipt and review metadata match both copies; an older snapshot holds changed
metadata until it is preserved and verified too.

The private output contains `candidateForOwnerReview`, never execution permission.
It has no provider transport or mailbox mutation. An actual cleanup still needs
a fresh exact-message provider/metadata check, a concrete manifest, the native
one-time approval, reversible Trash first and reconciliation of each effect.
Newer members of a mixed-date thread stay outside the selected message scope.
Keep manifests and all qualification/analysis receipts outside Git.

```bash
python3 integrations/secretary/retention_plan.py --root "$GMAIL_SECRETARY_ROOT" --before "$HISTORICAL_CUTOFF" --inventory "$PRIVATE_GMAIL_INVENTORY" --primary-proof "$PRIVATE_PRIMARY_PROOF" --mirror-proof "$PRIVATE_MIRROR_PROOF" --qualification "$PRIVATE_QUALIFICATION" --decisions "$PRIVATE_ANALYSIS_RECEIPTS" --output "$PRIVATE_RETENTION_PLAN"
```

### Compound attachment preservation and reading

A saved ZIP/RAR or Office package does not establish preservation or review of
its interior documents. `compound_sources.py` explicitly inventories bounded
containers into `compound-sources/indexes/<attachment sha256>.json` and preserves
file members in content-addressed `compound-sources/blobs/`. Member identities
include parent identity, ordinal and original name, so duplicate names and
byte-identical files retain their distinct occurrences and parent chains.
Original MIME, outer attachments, page identities and existing reading receipts
are unchanged. No document, formula or member filename is executed.

ZIP and Office ZIP packages use the standard library. RAR, 7z and tar require
an already installed `libarchive`; no decoder is installed automatically.
ZIP archive/member comments are separate preserved sources. Decoded timestamps
remain archive metadata, not capture dates or life events. New ZIP inventories
also retain separate local-header and central-directory extra fields in member
metadata, including each tag, byte count, SHA-256 and exact base64 payload.
Printable UTF-8 payloads have an additional text representation; these are
untrusted source data, never instructions. Local-only fields are retained even
when the central directory reports no extra data. Local header bounds, names,
flags, compression, sizes and CRC values are checked before reading members;
streaming placeholders and small forced-ZIP64 local headers are supported.
Other physical ZIP records still require separate review; exposing extra fields
does not establish complete semantic reading of container metadata. Libarchive
does not expose every format-specific header or comment: those metadata need a
separate review/evidence reference, not an assertion that the decoder supplied them.
Unsupported declared containers (including MSG/EML here), encrypted data, bad
paths, special entries, malformed directories, ZIP64 central directories,
multipart archives and exceeded limits remain explicit incomplete/invalid
coverage. Partial output is preserved without accepting it as complete.
Directory entries with nonzero or unknown size also hold coverage: their payload
cannot be skipped as though the directory were empty.

Default bounds are 32 MiB input, 8 MiB/member, 64 MiB expanded, 256 entries and
three nested levels. ZIP extra fields have a 256 KiB aggregate raw-byte limit per
container; serialized member metadata has a 512 KiB limit across the complete
nested inventory. Exceeded limits hold the source rather than truncate metadata.
The inventory checks a 30-second deadline between members;
the native operator still owns process/runtime admission and timeouts. Queue
heavy or long shared work before invocation through the installed heavy-work
entrance. Indexing is never launched by collecting mail, opening the reader or
preparing a cleanup plan. An existing index is reused; explicit `--retry` retains
its exact prior bytes. Reconcile a lost native attempt before requesting a retry.
New code does not enrich or rewrite cached indexes automatically. An explicit
retry adds the metadata while retaining existing member identities, saves the
previous index verbatim and changes its hash, requiring new preservation proofs
and a new exact analysis decision.

```bash
python3 integrations/secretary/compound_sources.py --root "$GMAIL_SECRETARY_ROOT" --message-id "$ARCHIVED_MESSAGE_ID"
```

The original reader exposes cached compound scope without decompressing or
rehashing member bodies during that body read; `memberCopiesChecked` distinguishes
that projection from the planner's integrity check. The planner hashes the current
member copies and requires independent proofs for the index and every member blob.
It adds `compoundAttachments` to the exact review packet only for compound
attachments; ordinary-message packet hashes stay unchanged. A changed index or
member invalidates the previous decision. Per-message aggregate bounds also hold
oversized compound scopes rather than silently omitting excess sources.

For these messages, qualification additionally needs an actually compared
`compound_attachments` case. Analysis receipts must supply exact
`compoundMembers` dispositions keyed by every file-member ID, including nested
containers/comments, plus `compoundMetadata` keyed by every outer attachment hash.
Each needs `state: addressed` or `no_relevant_content`, a reason and an evidence
reference. The outer attachment disposition cannot substitute for these sets.
An inventory remains unread with `analysisAccepted: false`; generating it does
not settle actions, validate interpretation, confirm owner facts or authorize
mailbox changes. Private indexes, blobs, proofs and review decisions stay outside
Git and need the same independent preservation as other source evidence.

### Durable analysis attempts

The batch prompt receives an explicit analysis date, frozen per page in
`review-contexts/` before its inference intent is composed. Replays use the same
date after midnight or a restart; corrupt or mismatched contexts stop instead
of silently changing the request. Keep these small context receipts with the
archive backups. The source date never becomes the analysis date.

Source extraction records explicit requests and promises with their actual
actors. Missing linked documents, OCR work and MIME comparison stay review gaps,
and do not become personal errands. Old sources default to historical status,
which does not mean their requests are resolved. Calendar status, partial dates
and invoice/payment evidence remain attributed to their sources. These rules
improve candidate extraction; every cleanup still needs source adjudication.

The batch reviewer writes an acknowledged per-page dispatch fence before asking
Core for inference. Its stable request identity appears in Core telemetry;
the private archive retains policy/prompt hashes and a result receipt before
recording findings. A later record/write failure reuses that saved result,
including when the final completion-state write was lost. It never generates
the page again merely because its review file is absent.

Only typed Core refusals known to occur before dispatch can wait and retry the
same identity. Transport loss, unrecognized HTTP errors, malformed model output
and unreadable/corrupt receipts stop with `phase=uncertain`. Both batch review
and the native cursor hold subsequent model requests until the original native
outcome is reconciled. Status exposes `unresolvedInferenceAttempts`; no source
is marked read or fully analyzed because the model request was attempted.

Keep `review-attempts/` with the archive and its backups. Reconcile the original
correlation ID through Core/native result and release receipts; restore a
verified saved result where available. Do not delete fences, clear quarantine
or change prompts to launch a replacement. A new policy must retain the prior
attempt and its proven terminal outcome. These receipts add no model, routing,
task/memory or mailbox authority. Synthetic tests do not qualify a live campaign.

## Outlook mailbox export

### Reviewing existing calendar and contact sources

`structured_sources.py` reads preserved Gmail ICS/VCF attachments and, only when
explicitly selected by export SHA-256, calendar/contact conversions from an
existing Outlook inventory. It does not run `readpst`, connect to Outlook, create
calendar events/contacts or write Core. Larger source scans use the instance's
queued CPU/IO window. Original hash/size checks precede interpretation; missing,
changed, oversized, malformed or unsupported encodings remain visible gaps.

The private sidecar retains property names, groups, raw values, parameters,
component hierarchy and source occurrences. It handles UTF-8 line unfolding and
preserves multiple coordinates, nested alarms, calendar methods, sequence,
cancellation and recurrence properties. It does not expand recurrence, merge
versions/people or infer attendance. Local times retain their timezone text;
unknown/partial dates and legacy converted properties stay unnormalized. Event
dates, source timestamps and contact observations remain distinct; a dateless
contact is not assigned a meeting or import date. `structureStatus=parsed`
indicates structural reading only; `analysisComplete` remains false.

This is a bounded structural reader, not a complete calendar scheduling or vCard
implementation. The property formats are documented in
[RFC 5545](https://www.rfc-editor.org/rfc/rfc5545),
[vCard 3.0](https://www.rfc-editor.org/rfc/rfc2426) and
[vCard 4.0](https://www.rfc-editor.org/rfc/rfc6350).

```bash
python3 integrations/secretary/structured_sources.py --root "$GMAIL_SECRETARY_ROOT" --outlook-export "$SELECTED_EXISTING_EXPORT_SHA256" --output "$PRIVATE_STRUCTURED_REVIEW"
```

`outlook_import.py import <file.pst>` brings an Outlook mailbox export into the
same private archive. The PST is kept unchanged under `outlook/exports/<sha256>.pst`.
Its items are extracted with `readpst` (Debian/Ubuntu `pst-utils`; override the
binary with `SECRETARY_READPST`) into a private staging directory that is always
removed afterwards: mail becomes `.eml`, contacts `.vcf` and calendar entries
`.ics`, each stored once under `outlook/items/` by content hash, with the
folders it appeared in, in `outlook/inventory.json`. Mail is linked to the
archived Gmail message with the same Message-ID (`alsoInGmail`). Importing the
same export again adds nothing. The extracted files are readpst's conversion of
the PST, not bytes from Microsoft's servers; the PST stays the export's
original. `status` prints counts; `import-<sha>.json` reports hold counts only.

```bash
python3 integrations/secretary/outlook_import.py --root "$GMAIL_SECRETARY_ROOT" import /path/to/export.pst
python3 integrations/secretary/outlook_import.py --root "$GMAIL_SECRETARY_ROOT" status
```

## Forwarded mailbox watch

When another mailbox forwards its incoming mail into the archived Gmail
account, `forwarding_check.py` watches that the forwarding keeps working,
reading only archived headers. It distinguishes two silences and posts each to
Core's alert intake (`/api/alerts/evaluate`, source
`secretary-forwarding-check`) on every run while it lasts; Core resolves the
alert itself once runs stop reporting it:

- `mail_archive_stale`: no message reached the archive within
  `SECRETARY_ARCHIVE_STALE_HOURS` (24 by default), so the archive sync is the problem;
- `mail_forwarding_quiet`: the archive is fresh but no message addressed to
  `SECRETARY_FORWARDED_ADDRESS` arrived within `SECRETARY_FORWARD_QUIET_HOURS`
  (72 by default).

`SECRETARY_FORWARD_MARKER_HEADER` (for example the header the forwarding
provider adds) ignores mail sent to both addresses. The address is an instance
setting and never appears in the event; `SECRETARY_FORWARDED_LABEL` names the
component. Delivery (local log, Telegram) comes from the instance's alert rules
for those two metrics. `--dry-run` reports without posting; the last result is
in `forwarding-status.json`.

## Archive verification and restore drill

`verify_archive.py <copy root>` checks any copy of the archive (the live root,
an off-host mirror's `current` directory or a restored tree) without contacting
a provider or writing inside it. It re-reads every recorded file against its
SHA-256: originals (and their Message-ID against the archived thread),
attachments, Outlook items and the kept PST exports, and lists missing or
mismatched ones by id or relative path. `--sample N` restores N originals into
a disposable directory (removed afterwards unless `--restore-to` is given) and
opens each like a mail client, decoding every MIME part. It has no dependency on
the other Secretary modules, so it runs on the machine that holds the copy.
Exit code 0 means intact; the report holds counts and identifiers only.

```bash
python3 integrations/secretary/verify_archive.py /path/to/copy --sample 50 --report /outside/the/copy/drill.json
```

## Household document discovery

`household_documents.py` searches the existing private attachment register and
archived message bodies for possible school, daycare, hockey and karate files.
It groups identical file hashes, reports source messages and extraction status,
flags obvious medical, legal and billing sources for extra review, and marks
the archive's coverage as incomplete or unknown. The ranking is only a triage
hint: a school message can contain an unrelated private attachment. It is read-only: a
candidate is not an approved document and no output is sent to RAG.

```bash
python3 integrations/secretary/household_documents.py --root "$GMAIL_SECRETARY_ROOT" --since 2026-01-01 --limit 30
python3 integrations/secretary/household_documents.py --root "$GMAIL_SECRETARY_ROOT" --query "school hockey" --include-unread
```

Run it only on the private host or a private copy of the archive. Its JSON may
contain personal filenames, subjects, short extracted previews and Gmail links;
keep results outside Git. An adult must inspect the original and select each
file before it is placed in the classified household ingestion root. Text
extraction and a matching filename do not establish that a file is current,
safe for children, or suitable for the family corpus.

## Dad desk mail actions

`secretary_mail_desk.py` lists the existing Secretary/Urgent and Secretary/Needs
Reply labels, removes only the selected label when a thread is handled, reads
the recent unprocessed Inbox count, and ranks the senders of recent
Secretary/Review mail (metadata only). The desk offers that ranking to create
triage rules. Label removal is verified by reading the
thread again. It never sends mail, reads message bodies, archives or trashes.

Use the same external `GMAIL_SECRETARY_ACCOUNT`, `GMAIL_SECRETARY_GOG` and
`GMAIL_SECRETARY_KEYRING_FILE` settings as the evidence collector, or explicit
CLI options. `GMAIL_SECRETARY_TIMEZONE` defaults to UTC. When no CLI or environment override is supplied, the helper reads the existing
`gmail-secretary` plugin settings from `~/.openclaw/openclaw.json` (or
`OPENCLAW_CONFIG_PATH`) on its native host. The OpenClaw profile remains the
account/keyring authority; Core does not copy credentials into SSH commands.

Core uses `OPENCLAW_INVENTORY_SSH_TARGET` and an explicit
`SECRETARY_MAIL_REMOTE_ROOT` (falling back to `CODING_DISPATCHER_REMOTE_ROOT`).
The root must be the canonical checkout on that host. With no native settings,
mail actions report unavailable while the rest of the desk remains usable.
Personal Secretary routes are accessible through the private LAN without a
human code. Native Gmail grants and explicit review before family publication
remain separate; the server does not authenticate a parent.
