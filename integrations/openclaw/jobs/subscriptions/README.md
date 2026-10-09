# Subscription audit job

The OpenClaw `subscription-audit` job reviews 90 days of subscription, renewal,
receipt, trial, newsletter and cancellation mail and writes an operator report.
It never unsubscribes, cancels, deletes, archives or changes read state.

- `openclaw_subscription_audit.py` runs one bounded, read-only Gmail search through
  `gog` (`--readonly --gmail-no-send`, only `gmail.messages.search`, 50 results),
  keeps only `from`, `subject`, `date` and `labels`, then runs the audit.
- `subscription-audit.js` groups messages by sender domain, classifies each vendor
  (`validate_usage`, `unsubscribe_candidate`, `active_keep`, `cancelled_or_done`,
  `manual_review`), deduplicates repeated alerts through a state file and records
  operator resolutions.

When Gmail cannot be read (missing keyring password, `gog` failure, unexpected
JSON), the wrapper renders the built-in synthetic fixture instead, prints
`FIXTURE-ONLY / BLOCKED ON GMAIL ACCESS` with the reason and exits `2`. A normal
run exits `0`; any other failure prints `Status: FAILED` and exits `1`.

## Configuration

| Option | Environment | Default |
| --- | --- | --- |
| `--account` | `GMAIL_SECRETARY_ACCOUNT` | required |
| `--gog` | `GMAIL_SECRETARY_GOG` | `gog` on `PATH` |
| `--keyring-password-file` | `GMAIL_SECRETARY_KEYRING_FILE` | `~/.config/gogcli/keyring-password` |
| `--timezone` | `GMAIL_SECRETARY_TIMEZONE` | `UTC` |
| `--workspace` | `SUBSCRIPTION_AUDIT_WORKSPACE` | `~/.openclaw/workspace` |
| `--audit-script` | | `subscription-audit.js` beside the wrapper |
| `--node` | | `node` |

The Gmail settings are the same ones the [Secretary](../../../secretary/README.md)
uses. Instance values (account, executable and keyring paths, workspace) live in
the native OpenClaw job configuration outside Git.

Reports land in `<workspace>/reports/subscription-audit/`: `latest.html`,
`latest.md`, `latest.summary.json`, `state.json` and the sanitized
`input-gmail.json`, all created with owner-only permissions.

```sh
python3 integrations/openclaw/jobs/subscriptions/openclaw_subscription_audit.py \
  --account "$GMAIL_SECRETARY_ACCOUNT" --workspace "$HOME/.openclaw/workspace"

node integrations/openclaw/jobs/subscriptions/subscription-audit.js run --fixture --report-dir /tmp/subscription-audit
node integrations/openclaw/jobs/subscriptions/subscription-audit.js resolve \
  --state <workspace>/reports/subscription-audit/state.json \
  --vendor example-audio.invalid --status snoozed --snooze-until 2099-01-01
```

## Tests

`node scripts/test-native-tools.cjs` runs the synthetic Node tests in `test/` and
the Python tests in `../tests/`. They stub `gog` and never contact Gmail or OpenClaw.
