# AgentX Finance Ledger (OpenClaw plugin)

Gives the OpenClaw finance persona one read-only tool, `finance_ledger`, backed
by Core's `/api/finance` routes. Core owns the ledger and computes every total;
the tool forwards bounded filters and adds a `*Display` string (`1 234,56 $`)
beside each `*Cents` integer, so the model quotes amounts instead of converting
or summing them.

Questions: `balances` (latest closing balance per account), `transactions`
(rows and totals by account, period, description words, category or tag),
`monthly` (in/out/net per month and the average), `yearly` (per calendar year),
`insights` (savings rate, recurring charges, category trends, large recent
expenses) and `statements` (ingested
statements, including those that need review), `categories` (totals per
category), `uncategorized` (descriptions still to classify, biggest first) and
`rules` (the category list and learned rules). A second tool,
`finance_categorize`, saves rules the owner confirmed in the conversation; Core
validates the category and re-applies every rule to past and future rows.
`finance_alerts` lists Core's deterministic alerts, or reports them once
(`report: true` marks them reported) for a scheduled delivery.

Ledger questions accept `ledger: "perso"` (default) or `ledger: "corp"`.
`coverage` reads expected accounts and date gaps, with `account`, `from`, `to`.
Supported
date, merchant and exclusion filters reach Core; a selector unsupported by
the chosen action is refused rather than discarded. The result records
`requested` selectors and Core's `scope`. Rules are shared between books;
goals and the monthly review use the personal plan only. Those actions do not
take a ledger selector in the native client.

Version 1.6 requires Core's qualified Finance reads. It refuses missing coverage,
an inconsistent coverage book or trends without explicit measure units. Update
Core before installing the adapter. Expected accounts are owner declarations in
the existing plan's `coverageAccounts` section; `unknown` is not complete.
Quote each measure's `display` together with `scopeText`: a monthly average over
two received months is not a three-month total. Preserve null amounts and
baselines; a recurring yearly estimate is not an observed yearly cost. Bank
channel words do not identify a supplier. [Core's contract](../../../docs/FINANCE.md#account-and-period-coverage)
defines coverage, active dates, denominators and the remaining verification limits.

The tool is visible only to the agents listed in `agentIds` (default
`comptable`), unsandboxed, in their own sessions. Configure the plugin with the
loopback Core URL:

```json5
plugins: {
  load: { paths: ["<checkout>/integrations/openclaw/finance-ledger"] },
  entries: { "finance-ledger": { enabled: true, config: { agentxUrl: "http://127.0.0.1:3180" } } }
}
```

and allow `finance_ledger` and `finance_categorize` in that agent's tool list. Run the tests with
`npm test` in this directory.
