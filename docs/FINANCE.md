# Personal finance (Wallet Beefer)

Core owns the owner's finances: a ledger reconciled to the cent, a financial
plan, simulations, alerts and the Finances page. The OpenClaw finance persona
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
  balance matches, to the cent. Totals are computed by Core; the persona quotes
  `*Display` strings and never adds amounts.
- **Nothing is written without reconciliation.** A statement that does not
  reconcile after the guided retries goes to review and writes no row.
- **The owner decides categories.** Rules and per-transaction decisions come
  from the owner (page or persona conversation); model suggestions are only
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

**Every total uses `flowCents`.** Using `amountCents` for spending counts card
purchases as income.

## Interfaces

- `/api/finance/*` (adult session through the gateway; loopback for the
  persona): statements, balances, transactions, monthly, yearly, categories,
  merchants, category-months, coverage, tags, insights, alerts, rules,
  uncategorized, suggestions, transaction decisions, plan (whole, per section,
  operations), situation, debt and cash-flow simulations, balance history,
  CSV export, inbox status and scan. Every query takes `ledger=corp`.
- `/finance`: the Wallet Beefer dashboard (situation and plan first, then the
  history analysis), a Personnel | Corporation switch and a plan editor.
- OpenClaw plugin `integrations/openclaw/finance-ledger`: `finance_ledger`
  (read), `finance_categorize` (owner-confirmed rules and single-row
  decisions), `finance_alerts` (list or report once), `finance_plan` (read,
  owner-stated operations). Visible only to the configured finance agent.
- Scheduled persona jobs (instance configuration): daily alert check (silent
  with `NO_REPLY` when nothing is new) and a weekly review.

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
