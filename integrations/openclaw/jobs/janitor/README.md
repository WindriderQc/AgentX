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

## Helper receiver

`openclaw_janitor_helper_receiver.py` is an SSH forced-command receiver that
installs or checks exactly one janitor helper file. The client sends one ASCII
JSON header line (`protocol` `agentx-openclaw-janitor-helper-v2`, `action`
`check` or `install`, lowercase `sha256`, `size` up to 512 KiB) followed by the
payload on stdin. Any `SSH_ORIGINAL_COMMAND` is refused. An install writes a
candidate beside the target, compiles it, runs it with `--help`, replaces the
target atomically and validates it again; it answers one JSON line with status
`updated`, `unchanged` or `drift` (check only). Errors print `ERROR: ...` on
stderr and exit 1.

The target is `--target`, else `AGENTX_JANITOR_HELPER_TARGET`, else
`openclaw_shared_drive_janitor.py` beside the receiver. It must be absolute.
The entry script imports its sibling modules, so a target outside a directory
holding this package fails validation and is not installed.

Restrict the dedicated key in `~/.ssh/authorized_keys` on the native host:

```text
command="python3 <checkout>/integrations/openclaw/jobs/janitor/openclaw_janitor_helper_receiver.py --target <helper path>",restrict <public key>
```

Tests use synthetic data and no network; they run with
`node scripts/test-native-tools.cjs`.
