# OpenClaw report jobs

Native OpenClaw cron jobs run these scripts on the OpenClaw host and deliver
their standard output as the scheduled message. Each script reads Core (or
Leantime) over HTTP, prints a bounded plain-text report and exits `0`. Any
missing credential, HTTP failure or invalid evidence prints one line on stderr
and exits `1`, so the job fails visibly instead of posting a partial report.
They only read; none of them changes Core state except `reconcile`, which asks
Core to refresh due Planning metrics.

Instance values (Core URL, Leantime URL and user id, host label, token files,
OpenClaw job ids, delivery targets) belong to the native job configuration
outside Git. Core URLs default to the loopback Core (`http://127.0.0.1:3180`);
`--base-url`, `AGENTX_CORE_URL` or the older `AGENTX_BASE_URL` override it.

| Script | Core routes | Credential |
| --- | --- | --- |
| `agentx_planning_ops.py reconcile` | `POST /api/planning/automation/reconcile` | `AGENTX_MCP_TOKEN` |
| `agentx_planning_ops.py daily-digest` | `/api/reports/daily-digest`, `/api/budget/status` | `AGENTX_OPERATOR_TOKEN` |
| `agentx_planning_ops.py weekly-review` | `/api/reports/weekly-review`, `/api/budget/status` | `AGENTX_OPERATOR_TOKEN` |
| `openclaw_morning_briefing.py` | `/api/reports/morning-brief` | none |
| `openclaw_dark_squad_report.py` | `/api/agent-ops`, `/api/openclaw/status`, `/api/budget/status` | none |
| `openclaw_leantime_idea_inbox.py` | Leantime JSON-RPC | Leantime API key file |

## Planning ops

`agentx_planning_ops.py [--base-url URL] [--timeout S] COMMAND` has three
commands. `reconcile [--dry-run] [--force]` reports scanned/updated/skipped
totals and fails when a metric refresh failed. `daily-digest` and
`weekly-review` format the Core reports for Telegram with the local token
budget and cloud observability; benchmark lines name a leader only when it is
full-scope qualified, never from coverage or latency. Output stays under 3,800
characters.

`AGENTX_MCP_TOKEN` comes from the environment or `~/.openclaw/.env` /
`~/.openclaw/gateway.systemd.env`. `AGENTX_OPERATOR_TOKEN` comes from the
environment or `~/.config/agentx/aiops.env`.

## Morning briefing

`openclaw_morning_briefing.py [--report-url URL] [--timeout S] [--exception-only]`
renders the statement-free morning brief: alert level, message count and cost,
average latency, and the Dreaming Review queue or overdue reconciliation.
`--exception-only` prints nothing when there is no alert, pending review or
overdue reconciliation. The report URL defaults to the Core URL plus
`/api/reports/morning-brief`.

## Dark Squad supervision

`openclaw_dark_squad_report.py [--base-url URL] [--host-label NAME]` summarises,
in French, the pipeline counts, live OpenClaw automations, Agent Ops source
health, local and cloud LLM usage, and the disk and memory of the host it runs
on. The first line reads `ATTENTION` or `OK`. Redirects and routes outside the
Core origin are refused. `--host-label` (or `AGENTX_REPORT_HOST_LABEL`) names
the host on the resource line; without it the line reads `Hôte`.

## Leantime idea inbox

`openclaw_leantime_idea_inbox.py` lists up to 50 open tickets of one Leantime
user through `Tickets.getAllOpenUserTickets`, in French, with the Leantime host
as source. It requires:

- `--url` or `LEANTIME_JSONRPC_URL`: the Leantime `/api/jsonrpc` URL;
- `--user-id` or `LEANTIME_IDEA_USER_ID`: the inbox owner's Leantime user id;
- `--api-key-file` or `LEANTIME_API_KEY_FILE`, else `~/leantime-nestor-apikey.txt`
  or `~/.leantime-nestor-apikey`.

Redirects are refused so the key never leaves the configured origin.

## Tests

Synthetic tests stub HTTP and contact nothing:

```bash
python3 -m unittest discover -s integrations/openclaw/jobs/tests -v
node scripts/test-native-tools.cjs
```
