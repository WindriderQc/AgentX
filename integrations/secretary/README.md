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

`openclaw_gmail_secretary_watchdog.py` retains the stale-review, resumable
mailbox and auto-disabled-job handling. It requires explicit `--account`,
`--triage-job-id` and `--watchdog-job-id`; executable, audit/keyring paths and
cadences are configurable. It can edit those selected native schedules, so it is
not launched automatically by AgentX. Preserve deliberate owner pauses.

No old installer containing private job IDs, contact prompts, or account paths is
shipped. Configure the existing native job after reviewing its current state,
with backup copies outside Git. Existing synthetic Python tests run through
`node scripts/test-native-tools.cjs`; this does not contact Gmail/OpenClaw.

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

## Outlook mailbox export

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
Household's existing parental boundary protects the personal Secretary routes.
