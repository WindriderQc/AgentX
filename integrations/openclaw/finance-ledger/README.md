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
`coverage` reads the existing statement-series coverage and gaps. Supported
date, merchant and exclusion filters reach Core; a selector unsupported by
the chosen action is refused rather than discarded. The result records
`requested` selectors and Core's `scope`. Rules are shared between books;
goals and the monthly review use the personal plan only. Those actions do not
take a ledger selector in the native client.

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
