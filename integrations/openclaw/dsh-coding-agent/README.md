# DSH native tool

This optional OpenClaw plugin retains `dsh_coding_agent` and its bounded workspace,
no-secret assertion, output limits, receipt matching and audit trail. It invokes
the canonical Linux wrapper in `integrations/coding/dsh-headless.sh`.

Set native plugin configuration outside Git: `wrapperPath`, `receiptRoot`,
`auditLog`, `model`, `claimHost`, `coreUrl`, `lockFile` and optionally `nodePath`.
The model and claim host are required by the wrapper; no machine/model is chosen
by the plugin. The minimal child environment passes these settings and does not
inherit unrelated account secrets. Paths otherwise use the OS home.

Run root `npm run setup:integrations` before portable tests. `index.js` loads the
native host SDK; `lib/tools.js` contains the tested logic. No DSH process, agent,
model or scheduled task starts during installation/tests. Live native validation
is separate from these tests.
