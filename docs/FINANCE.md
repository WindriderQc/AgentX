# Personal finance (Wallet Beefer)

Core owns the owner's finances: a ledger reconciled to the cent, a financial
plan, simulations, alerts and the Finances page. The OpenClaw finance agent
(`comptable`) only calls Core tools; it never stores figures of its own. This
file is the handover for any agent taking over: read it with `OPERATIONS.md`.
Personal values never enter Git; the instance keeps a private
`finance/HANDOFF.md` (paths, bots, schedules, coverage, decisions).

Finance is a personal capability of the `full` profile. In `demo`, the profile
guard answers `/api/finance/*` and `/finance` with 404
(`AGENTX_DEMO_SURFACE_DISABLED`) and the inbox daemon does not start.

## Principles

- **Arithmetic decides, the model reads.** A statement is accepted only when
  every account satisfies opening + Σ rows = closing and every printed running
  balance matches, to the cent. Totals are computed by Core; the agent quotes
  `*Display` strings and never adds amounts.
- **Nothing is written without reconciliation.** A statement that does not
  reconcile after the guided retries goes to review and writes no row.
- **The owner decides categories.** Rules and per-transaction decisions come
  from the owner (page or a conversation with the agent); model suggestions are only
  proposals.
- **Separate books.** Personal and corporate ledgers never mix.
- **Money never moves.** The system reads, explains, alerts and drafts; the
  owner executes every payment or transfer.

## Pipeline

1. A PDF lands in `FINANCE_INBOX_PATH` (personal) or `<inbox>/corp/`
   (corporation). The inbox daemon scans every `FINANCE_INBOX_POLL_MS`.
2. Text layer (`pdftotext -layout`) → local model with a JSON schema
   (`statementExtraction.js`). A PDF with almost no text is a scan: each page
   at 200 dpi goes to the vision model one page at a time
   (`scannedStatement.js`).
3. `findProblems` checks every row balance and each account's closing; on a
   mismatch the model gets the failing row (`FINANCE_EXTRACTION_RETRIES`).
4. Reconciled: `finance_statements` + `finance_transactions`, rules and
   decisions applied, file archived under `<archive>/[corp/]<year>/`. Not
   reconciled: `needs_review`, file under `FINANCE_REVIEW_PATH`, alert raised.
   A busy inference host leaves the file for the next scan.

A different PDF cannot replace a reconciled issuer/period when the extracted
account number is missing: it stays in review even if its arithmetic balances.
A hash already reconciled in the other ledger is refused before extraction;
depositing it again never moves its accounting ownership. Archiving a duplicate
in the same ledger refreshes its original-file link without rewriting rows or
owner decisions. These guards do not repair historical account assignments.

## Data model (MongoDB, instance database)

| Collection | Holds |
|---|---|
| `finance_statements` | One per statement: `statementKey` (ledger prefix, issuer, card last 4, period), status, accounts with opening/closing, `ledger`, `source` (text/image), file hash (provenance only) |
| `finance_transactions` | One per row: `amountCents` (statement sign, used by reconciliation), `flowCents` (owner's wallet: negative = money out; opposite sign for cards, credit lines, loans), category, tags, `manual`, `ledger`; unique on (accountKey, date, fingerprint, occurrence) |
| `finance_rules` | Owner-taught "description contains → category, tags"; longest pattern wins |
| `finance_overrides` | Owner decision for one transaction, keyed like the row so it survives re-ingestion; wins over rules |
| `finance_plan` | Budget lines, debts, credit, provisions, assets, tax room, open items, cash allocation, deadlines, milestones, phase, exceptional tags |
| `finance_alerts` | Deterministic alerts with stable keys (raised once) |
| `finance_document_links` | Proposed, confirmed or rejected links between a Secretary document and a ledger row, keyed by the document id and the row's stable key (account, date, fingerprint, occurrence); survives re-ingestion |
| `finance_ingestions` | Durable source identity, sealed candidate and before/after row plan, per-command dispatch observations and terminal receipt; an uncertain command is not replayed |

**Every total uses `flowCents`.** Using `amountCents` for spending counts card
purchases as income.

## Interfaces

- `/api/finance/*` (private LAN HTTPS access without a code; loopback for the
  persona): statements, balances, transactions, monthly, yearly, categories,
  merchants, category-months, coverage, tags, insights, alerts, rules,
  uncategorized, suggestions, transaction decisions, plan (whole, per section,
  operations), situation, debt and cash-flow simulations, balance history,
  CSV export, inbox status and scan. Every query takes `ledger=corp`.
  Ledger readers return `scope` with the selected book and applied filters.
  Unsupported selectors and unknown books return `FINANCE_QUERY_INVALID`
  instead of widening the question. Rules explicitly report a shared scope;
  goals and monthly reviews belong to the personal plan and refuse `ledger=corp`.
  Insights intersect their lookback with an explicit `from`/`to` interval.
- `/finance`: the Wallet Beefer dashboard (situation and plan first, then the
  history analysis), a Personnel | Corporation switch and a plan editor.
- `/api/finance/documents` (read-only view of the Secretary register) and
  `POST /api/finance/documents/links/decide` (confirm or reject proposals).
- OpenClaw plugin `integrations/openclaw/finance-ledger`: `finance_ledger`
  (read, including `action: documents`), `finance_categorize` (owner-confirmed
  rules and single-row decisions), `finance_document_link` (confirm or reject a
  proposed document match, only after the owner's yes), `finance_alerts` (list
  or report once), `finance_plan` (read, owner-stated operations, `done` to settle
  a deadline). Visible only to the configured finance agent.
  Ledger actions accept `ledger: perso|corp`, including `coverage`, and preserve
  supported date, merchant and exclusion filters. The result includes the
  requested selectors alongside Core's scope; incompatible selectors are refused.
- A watch or open item may set `kind`: `payment` (the brief says "à payer dans N
  jours") or `task` (neutral, the default: "dans N jours", "demain",
  "aujourd'hui", "en retard"). Alert texts do not change.
- `GET /api/finance/brief`: the finance line of the daily brief for other
  surfaces, for example "Finances : Payer le T2 corp en retard · Odyssée à payer
  dans 7 jours · relevés à déposer : Desjardins · 109 liens à confirmer". It
  carries short labels, late series by issuer name, and the proposals to confirm.
  It never carries an amount, an account number or a path: amounts, arrows
  between amounts, long digit runs and four-digit non-years are removed from every
  label. A watch or open item may set `briefLabel` to choose its wording; without
  it, the label is cut before a dash, parenthesis or colon, then at 50 characters
  on a word boundary. The missing-history count is not in the brief.
- `GET /api/finance/goals`: savings goals from the plan section `goals`. Progress
  comes from a ledger account (`source.kind: account`, its balance), an asset of
  the plan (`asset`), or the sum of a tag (`tag`, money set aside counts as
  progress). The pace is the average of the last three months with qualified
  account/date coverage; only those exact months enter its numerator. The projected month, the monthly
  amount the target date needs, and a status (`reached`, `on_track`, `behind`,
  `no_pace`) are computed by Core. Goals are shown as bars at the top of
  "My situation".
- `GET /api/finance/review/monthly`: the last complete month planned against
  actual by category, the three largest overspends, and the goals. The Comptable
  uses it for the monthly review.
- Scheduled agent jobs (instance configuration): daily alert check (silent
  with `NO_REPLY` when nothing is new) and a weekly review.

## Account and period coverage

Core's `financeCompleteness.js` checks statement date intervals for every
expected account in the selected book. The plan section `coverageAccounts`
declares the owner's inventory, independently for `perso` and `corp`:

```json
{
  "coverageAccounts": [
    { "ledger": "perso", "accountKey": "synthetic-bank|1234|EOP", "from": "2026-01-01", "to": null },
    { "ledger": "perso", "accountKey": "synthetic-card|5678|CARD", "from": "2026-01-01", "to": "2026-06-30" },
    { "ledger": "corp", "accountKey": "corp:synthetic-bank|9012|EOP", "from": "2026-01-01", "to": null }
  ]
}
```

Use exact keys from `balances`. Optional `from`/`to` are inclusive activity
boundaries, explicitly stated by the owner; first/last received statements do
not infer them. The page's plan editor offers **Comptes attendus**, including
both books and known-account suggestions. Existing per-section/operation APIs
can save this section. This is owner intent, not a data migration. Closing an
alert series in `seriesStatus` does not invent an account closing date.

Read responses carry `coverage` with `kind: statement_date_coverage`, selected
book/account, exact `period`, expected accounts, gaps by day, structured reasons
and `status: covered|partial|unknown|unavailable`. The coverage endpoint puts
this projection at its root and accepts `account`, `from`, `to`. Its legacy
`series` list still describes received issuer-series intervals for the existing
document-deposit reader; it does not certify completeness. Valid ordered calendar
dates are required; a read interval is bounded to 100 years.

An undeclared inventory or an unlisted observed account is `unknown`, even if
the known intervals are contiguous. An exact account-key filter defines a
bounded account universe; code filters check the declared matching accounts.
Neither filter bypasses date coverage. A missing card, day or pending review
prevents a complete claim. Activity dates keep a closed account from requiring
new statements forever. Stored row date bounds outside their owning source,
or rows without an account source, remain visible and qualify the affected
interval. A bounded historical anomaly does not invalidate an independently
covered later period. This is not a full stored-row integrity audit.
`dataAsOf` retains the oldest latest source date among
the accounts active at the end of the interval (or the selected closed accounts
when none remain active); per-account dates remain visible. Freshness uses the
existing `FINANCE_ALERT_STALE_DAYS` threshold without turning a historical
balance into a current one.

Expected calendar months are enumerated independently of matching transactions.
A covered month with no matching operations is zero; an empty month without
source evidence has null amounts. An incomplete month can still show its stored
totals, separately from an eligible monthly average. A partial requested month
has a period total but cannot enter a monthly denominator. Annual reads check
every calendar month, including empty ones; `fullYear: false` names a selected
fraction of a year. A current or partially received year is never presented as
a complete year. Missing months remain visible in the page and charts.

Date coverage does **not** verify book attribution, stored-row integrity,
currency identity or the correctness of the source itself. Those checks and
historical repairs remain separate. No existing real inventory is auto-confirmed.

## Amounts and denominators

Core returns measures with `kind`, `unit`, `amountCents`, exact `months`,
`monthCount`, `display` and `scopeText`. A monthly measure uses `cents/month`
and displays dollars per month; a period total uses `cents` and its exact dates.
This contract does not infer a currency code or perform currency conversion.
`monthly.averageNet`, situation actual measures and each trend's
`recentMeasure`/`previousMeasure` carry the actual eligible denominator, which
may be two months rather than three. `changeMeasure` is a difference between
monthly averages. A missing baseline stays null, never zero. Recurring charges
carry a monthly median and a separate `annualized_estimate` in `cents/year`;
the latter is not an observed yearly cost.

Native consumers quote measure `display` **and** `scopeText`. Legacy cents
aliases remain for compatibility. Plugin 1.6 requires qualified Core responses
and refuses missing coverage or trend units: install the supporting Core before
the adapter. Neither discovery nor synthetic source tests prove a delivered
model conversation. A live conversation qualification uses the native heavy-work
queue and its existing execution authority.

The page preserves null as an empty chart point and an unavailable text value,
uses muted marks for partial months, keeps exact account selection, and leaves
the initial view on all accounts. With no admissible months, situation and
budget actuals/gaps are null; a forecast without a cash balance is unavailable.
The minimal Nestor brief projects coverage limits without amounts, account keys
or source paths. Bank-channel descriptions do not identify a beneficiary or
supplier without supporting detail.

## Deadlines

- Staleness is judged per statement series (issuer and account or card last
  four), not on the newest statement of all accounts: a card that is still fed
  does not hide a payroll account that stopped. One alert per series. A series
  silent beyond `FINANCE_ALERT_DORMANT_DAYS` is dormant (one info alert). The plan
  section `seriesStatus` names a series and marks it `closed` to silence it;
  a closed series' pending alerts are acknowledged at the next refresh.
- `watch` and `openItems` accept optional `dueDate` (YYYY-MM-DD) and
  `recurrence` (`monthly`, `quarterly`, `yearly`). The free-text `date` stays
  valid. Settling an item means moving its `dueDate` forward; until then Core
  alerts daily (J-7, J-1, overdue). The plan operation `done` settles an item:
  a recurring one moves its `dueDate` to the next period (month-end safe), any
  other one is removed and kept as a settled milestone.

## Secretary documents

The Secretary's invoice register (`FINANCE_SECRETARY_REGISTER`, schema v2, a
file Core only reads, rewritten hourly by the Secretary) is matched to the
personal ledger. Core never writes to it.

- A document has an amount (the patient's share when the register has one,
  else the gross amount), a date and a kind. Statements (`relevé` kinds) are
  never matched and never ingested: they are listed as found in mail, for the
  owner to file.
- A row is a candidate when its amount is exactly the document's amount in
  cents and it is dated from 3 days before to 10 days after the document.
  A candidate whose description contains a word of the supplier is strong.
- One strong candidate is a confident proposal. Any other case is an ambiguous
  proposal (up to 5), for the owner to confirm. Nothing is confirmed by Core.
- Confirming a proposal rejects the other proposals for the same document.
  Rejected links are never proposed again. Confirmed and rejected links survive
  a sync; proposals that no longer match are removed.
- Document kinds are a closed set: `invoice`, `receipt`, `payment_proof`,
  `claim`, `remit_advice`, `quote`, `bank_statement`, `insurance_statement`,
  `tax`, `other`. Core reads the free-text label (kept as `documentKindRaw`)
  when the register does not carry `kind`; the Secretary producer writes `kind`
  from schema 3. Schemas 2 and 3 are both read.
- Statements of kind `insurance_statement` and `bank_statement` are never
  matched. Bank statements are listed under "Relevés trouvés dans Gmail". Each one
  is matched to an account series of either ledger: the last four digits of its
  document number and a tolerant issuer name (accents and small misspellings
  allowed; "caisse" stands for Desjardins). The ledger follows from the series, so
  a corporate statement is a corporate one. Its status: `fillsGap` (its month is a
  gap of that series), `alreadyIngested` (its month is covered) or `unknown` (no
  single series matches, or no date). Every unknown statement carries its reason.
- The plan section `seriesStatus` may declare a series the statements do not
  carry a last four for: `series` (issuer), `last4` (exactly four digits) and
  `ledger` (`perso` or `corp`). A declared series is used first. Without a
  declaration, a statement whose issuer matches a single series in a single
  ledger is matched to it; when the same issuer exists in both ledgers the
  statement stays unknown, with the reason "series in both ledgers, add last4 in
  seriesStatus".
- Deposit (`POST /api/finance/documents/statements/deposit`, up to 10 ids): Core
  copies the file from `FINANCE_SECRETARY_FILES` into `FINANCE_INBOX_PATH`, or into
  its `corp/` folder when the matched series is corporate. It copies only: nothing is deleted, the
  name keeps the Secretary id and date, a file whose hash is already ingested or
  already in the inbox is refused, and the normal reconciliation decides. The
  plugin tool `finance_statement_deposit` runs only after the owner's yes.
- The views: confident proposals; ambiguous matches grouped by document with
  their candidate rows, for the owner to pick one; documents without a
  transaction; outflows above a threshold without a document; claims still to
  file; figures to verify; bank statements found in mail. Totals are computed by Core.
- Claims keep health and insurance only: an insurer, a health or insurance
  supplier word (clinic, pharmacy, dental, insurer...), or a linked row in the
  Santé category. A claim or remittance kind alone is not enough: a client's
  payment advice is not an insurer's. Tax and government documents are excluded.
- A document whose `person` names one of the corporations (`FINANCE_CORP_NAMES`)
  belongs to the corporate ledger: it matches corporate rows only, is never a
  personal claim, and is listed by `GET /api/finance/documents?ledger=corp`.
- A claim goes to `toVerify`, out of the totals, when it is above
  `FINANCE_DOCUMENT_CLAIM_MAX_CENTS` (500 000 cents by default) or when its amount
  is more than twice its gross amount, or its patient share exceeds the gross.
- The statuses that count as settled for a reimbursement are `paid`, `reimbursed`,
  `settled` and `regle` (accents folded). Check them against the real register.

## Known traps (each found on real statements)

- Desjardins prints overdrafts with a trailing minus (`1 234.56-`).
- Card statements mark a credit balance with `CR` (negative amount owed).
- One card appears under several product names: tier words are dropped from
  the issuer so it keeps one account.
- Refinancing and other one-off movements distort averages: tag them with an
  exceptional tag (plan `excludeTags`, default `refi`) through per-transaction
  decisions, not rules.
- Card payments from the chequing account are internal transfers only when the
  card's own statements are ingested; otherwise they are the only trace of
  that spending.

## Operating it

### Ordinary ingestion and recovery

The ordinary inbox path stores a bounded ingestion intent under a stable key
derived from the PDF hash and book. Before accounting writes it drains already
admitted readers and holds Finance through the same persisted coordination
document used by repairs. New readers, mutations, scans and repairs refuse while
that ingestion is unresolved. Statement publication follows every verified row
write; a known PDF is a duplicate only if its stored membership, row counts and
account equations still agree.

New statements record `rowKeys`: exact membership independent of the first
owning `statementId`, so overlapping exports can share rows without losing their
provenance. Replacing a statement retains unchanged row IDs and owner decisions.
An omitted row is retained and reassigned when another exact membership still
requires it. A possibly required legacy row is not deleted automatically; the
replacement goes to review. Existing documents are not bulk-normalized.

A refused extraction retains its statement ID, accumulated attempts and review
history when a later reading of the same PDF is accepted. The source hash is
checked again before preparing an accounting write. Native recovery checks the
same original bytes and the saved candidate/plan digests, invokes no model and
does not deposit or move a file.

Run the native operator script with Core's existing database configuration:

```sh
node scripts/finance-ingestion-recovery.js status
node scripts/finance-ingestion-recovery.js resume \
  --request '<saved-request-key>' --confirmed-digest '<saved-digest>' \
  --source '<original-or-archived-PDF>' --actor '<operator>' \
  --core-origin '<native-loopback-Core-origin>'
```

Recovery resumes the same intent. For a dispatched command, its exact after-image
must be observed before continuing; an absent image does not authorize another
write. `FINANCE_INGESTION_WRITE_UNCERTAIN` retains exclusion for independent
native-outcome reconciliation. Never reset or delete the coordination/journal
records to regain availability. A reader left by a killed process also remains
subject to native ownership reconciliation, without age-based takeover.
Before accounting writes the native recovery verifies Core's loopback protocol
and coordination identity, and observes its ordinary inbox API refusing access.

Finance maintenance protocol v2 requires the served Core and native repair
executor to recognize ingestion exclusion. Upgrade and qualify those consumers
together. Legacy repair manifests remain unchanged; statements carrying explicit
membership require a separately reviewed membership-aware repair contract and
are refused by the legacy book-repair executor. Source checks do not apply any
historical repair or start a live extraction.

### Reviewed historical repairs

Reviewed historical book repairs use the bounded native
[Finance repair executor](FINANCE_REPAIR.md): persisted read/write exclusion,
immutable intent and receipts, same-identity recovery and exact scoped rollback.
It supports one statement, one row and its owner decision without re-ingestion
or account-number normalization. Testing or installing it does not apply a repair.

- Configuration: `FINANCE_INBOX_PATH`, `FINANCE_ARCHIVE_PATH`,
  `FINANCE_REVIEW_PATH`, `FINANCE_INBOX_POLL_MS`, `FINANCE_EXTRACTION_MODEL`,
  `FINANCE_EXTRACTION_RETRIES`, `FINANCE_ALERT_*` (see `OPERATIONS.md`). Keep
  the finance paths outside every RAG ingestion root.
- Deploying Core on the shared host: take `LEAD.md` (abort if held), pause the
  finance inbox (move queued PDFs aside) so the runtime lease is granted,
  `./agentx rebuild --no-deps core` with the instance env/project/override,
  restore the inbox, request a scan, release `LEAD.md` with a note. Never
  chain host commands after a failed lock check.
- Data changes (statements, rules, decisions, plan) need no deploy.
- Tests from the repository root: `npm test --prefix core -- --runTestsByPath tests/services/financeLedger.test.js` (synthetic fixtures
  only) and `npm test --prefix integrations/openclaw/finance-ledger`.
  Recovery and scope suites are `tests/services/financeIngestionRecovery.test.js`
  and `tests/services/financeQueryScope.test.js`; the existing repair suites
  verify their admission contract with the maintenance protocol.
