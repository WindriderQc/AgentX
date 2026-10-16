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

**Every total uses `flowCents`.** Using `amountCents` for spending counts card
purchases as income.

## Interfaces

- `/api/finance/*` (private LAN HTTPS access without a code; loopback for the
  persona): statements, balances, transactions, monthly, yearly, categories,
  merchants, category-months, coverage, tags, insights, alerts, rules,
  uncategorized, suggestions, transaction decisions, plan (whole, per section,
  operations), situation, debt and cash-flow simulations, balance history,
  CSV export, inbox status and scan. Every query takes `ledger=corp`.
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
- `GET /api/finance/brief`: the finance line of the daily brief for other
  surfaces, for example "Finances : Payer le T2 corp en retard · Odyssée à payer
  dans 7 jours · relevés à déposer : Desjardins · 109 liens à confirmer". It
  carries short labels, late series by issuer name, and the proposals to confirm.
  It never carries an amount, an account number or a path: amounts, arrows
  between amounts, long digit runs and four-digit non-years are removed from every
  label. A watch or open item may set `briefLabel` to choose its wording; without
  it, the label is cut before a dash, parenthesis or colon, then at 50 characters
  on a word boundary. The missing-history count is not in the brief.
- Scheduled agent jobs (instance configuration): daily alert check (silent
  with `NO_REPLY` when nothing is new) and a weekly review.

## Completeness and deadlines

- A month is complete only when the payroll account (`EOP`) statements cover
  every day of it (`financeCompleteness.js`). Incomplete months keep their
  totals, are flagged `complete: false` and are excluded from averages and
  savings rates. A ledger with no payroll statement at all flags nothing.
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
  matched. Only `bank_statement` is listed as found in mail, for the owner to file.
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
