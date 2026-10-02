# Shared-drive janitor assessment

The OpenClaw native job `shared-drive-janitor-assessment` runs
`openclaw_shared_drive_janitor.py` from this checkout. It is a read-only client
of the optional Data service: it may queue metadata or budgeted candidate-hash
scans, then reads storage evidence and asks Data to generate and persist the
shared-drive strategy report. It never calls approve, reject, run or execute
endpoints and never moves, renames, archives or deletes files. Data stays the
owner of storage evidence and janitor execution.

| Module | Role |
|---|---|
| `openclaw_shared_drive_janitor.py` | CLI entry used by the job |
| `client.py` | Data API calls (`/api/v1/storage/...`, `/api/v1/janitor/profiles/shared-drive/strategy`) |
| `report.py` | Report assembly and JSON persistence |
| `rendering.py` | Bounded notification and verbose evidence digest |

The two roots are `media` (`/mnt/media`, excluding its nested Datalake child)
and `datalake` (`/mnt/datalake`), as Data indexes them.

## Assessment options

| Option | Environment | Default |
|---|---|---|
| `--base-url` | `AGENTX_JANITOR_BASE_URL` | `http://127.0.0.1:3183/api/v1` (Compose loopback Data port) |
| `--dashboard-url` | `AGENTX_JANITOR_DASHBOARD_URL` | `http://127.0.0.1:3180/data-toolbox#janitor` |
| `--report-dir` | `AGENTX_JANITOR_REPORT_DIR` | `~/.local/state/agentx/shared-drive-janitor` |
| `--sources` | | `media datalake` |
| `--refresh` | | off; queues one scan per source and waits for completion |
| `--metadata-only` | | with `--refresh`, `hash_mode=none` instead of `candidates` |
| `--hash-max-files`, `--hash-max-bytes` | | 5000 files, 50 GiB per scan |
| `--poll-seconds`, `--max-wait-seconds` | | 15 s, 4 h shared deadline |
| `--verbose-summary` | | print the full evidence digest instead of the notification |

Each run writes `shared-drive-assessment-<timestamp>.json` and `latest.json` to
the report directory and prints a short notification ending with the dashboard
link. The dashboard URL must be `http(s)` without spaces and at most 200
characters, otherwise the default is printed. Exit code 0 means the assessment
completed; 1 means a Data request failed or a refresh scan did not complete
(`Shared-drive janitor failed: ...` on stdout).

```bash
python3 integrations/openclaw/jobs/janitor/openclaw_shared_drive_janitor.py \
  --base-url "$AGENTX_JANITOR_BASE_URL" --dashboard-url "$AGENTX_JANITOR_DASHBOARD_URL" --refresh
```

Instance values (Data URL, dashboard URL, schedule, job id, delivery target)
live in the native OpenClaw job configuration outside Git.

Tests use synthetic data and no network; they run with
`node scripts/test-native-tools.cjs`.
