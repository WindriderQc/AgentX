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
