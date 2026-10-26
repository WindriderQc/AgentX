# Native operations helpers

Operations capabilities for an AgentX instance. Use the existing systemd timers and Windows tasks; this directory does
not install a scheduler or start background work. Keep instance settings, receipts,
credentials and backup generations outside the checkout.

The optional [native operations supervisor](../../docs/OPERATIONS_JOBS.md)
centralizes these schedules on a server and exposes safe controls through Core.
It installs no jobs until an operator configures its native runtime.

| Helper | External settings | Behavior |
|---|---|---|
| `codex-usage-sync.js` / `sync-codex-usage-to-prod.ps1` | Endpoint, sessions root | Sends sanitized counters only; `--dry-run` sends nothing |
| `alert-governance-sweep.js` | `AGENTX_ALERT_RULES`, Core URL, Mongo container/database, optional SSH target | Compares by default; `--apply` reconciles managed rules without deleting unrelated rules |
| `alert-telegram-relay.js` | `AGENTX_ALERT_TELEGRAM_CONFIG` (see `alert-telegram.example.json`): chat, forum topic, private token file and JSON pointer | Core's Telegram adapter: posts active alerts whose rule lists `telegram`, records delivery in Core, and posts one « Résolu » notice per relayed alert. Optional `quietHours` hold non-critical alerts and notices; previews without `--send` |
| `council-telegram-relay.js` | `AGENTX_COUNCIL_TELEGRAM_CONFIG` (default `~/.config/agentx/council-telegram.json`): `chatId`, `topicId`, `tokenFile`/`tokenPointer`, optional `councilUrl`, `all`, `lookbackHours`, `maxPerRun` | Mirrors Council sessions that seat OpenClaw agents (or all with `"all": true`) to one forum topic: header with the question, each turn under the speaker's name, then the synthesis, each once and in order. A mirror only: interjections and the chair's decision stay on `/council`. `--create-topic NAME` creates the topic once; previews without `--send` |
| `sync-openclaw-schedule.js` | Core URL and native OpenClaw inventory | Mirrors official jobs; never creates native jobs or copies prompts |
| `verify-native-data-collectors.js` | Data URL, expected scanner IDs, optional `--expect-gpu` collector IDs | Checks current or advancing heartbeat evidence |
| `backup-critical-runtime-state.sh` | `BACKUP_ROOT`, `CRITICAL_BACKUP_VOLUMES`, optional `CRITICAL_BACKUP_MYSQL_CONTAINER` | Archives selected Docker volumes and optional transactional SQL, with SHA-256 evidence |
| `restore-drill-critical-runtime-state.sh` | Exact archive path | Restores into disposable volumes/MySQL and removes only those disposable resources |
| `offhost-backup-replication.ps1` | Required `SourceHost`, `SourceRoot`, private `DestinationRoot` | Copies Mongo, configuration, Qdrant and native-state archives; verifies hashes; retention is opt-in |
| `host_jobs_control.py` / `host_job_worker.py` | External native configuration and state roots | Server recurrence, bounded workstation adapters, replay-safe receipts and inventory |
| `benchmark-public-publish.js` | Outbox; for `--send`: `AGENTX_PUBLIC_SCOREBOARD_TARGET`, `_SSH_KEY`, `_KNOWN_HOSTS`; optional `_EXCLUDE`, `BENCHMARK_SERVICE_URL` | Pushes an allow-listed public copy of the Benchmark scoreboard (machine names, no addresses) by rsync over SSH; previews without `--send`. See [public scoreboard](../../docs/PUBLIC_SCOREBOARD.md) |
| `bundle_delivery.py` | Published source, private staging and local destination | Verified non-destructive delivery into a local workspace |
| `session_archive.py` | `--host-label`, one `--source label=path` per directory or file, `--destination-host`, existing `--destination-root`, private `--state-dir`; optional `--dry-run` | Append-only push of local Claude Code / Codex session transcripts from the host that holds them (`collect` starts it from the archive host); verifies each file by SHA-256 on arrival, replaces a session that only grew, keeps any other replaced version, never deletes, never reads credential files |
| `archive_mirror.py` | Required `--source-host`, `--source-root`, private `--destination`; optional `--latest-zfs-snapshot`, `--remote-receipt` | Append-only pull of a private archive directory (for example the Secretary evidence archive); copies new and changed files, verifies each by SHA-256, keeps replaced versions, never deletes |

## Session transcript archive

`session_archive.py send` runs on the host where the transcripts live (Windows or
Linux) and needs only Python and SSH to the archive host, whose `python3` runs the
receiving half of the same file, sent with each call. Each source has a label:

```
python3 session_archive.py send --host-label devx \
  --source claude-projects=$HOME/.claude/projects \
  --source codex-sessions=$HOME/.codex/sessions \
  --source codex-archived=$HOME/.codex/archived_sessions \
  --source codex-history=$HOME/.codex/history.jsonl \
  --destination-host archive-host --destination-root /archive/agent-sessions \
  --state-dir $HOME/.local/state/agentx/session-archive
```

The archive root must already exist. The tool writes `live/<host>/<label>/<path>`
(the current copy), `versions/<host>/<run>/<path>` (a copy replaced by a
non-append change) and `receipts/<host>/<run>.json` plus `latest-run.json`;
directories are `0700` and files `0600`. A file that disappeared at the source,
for example through a client's own transcript retention, stays archived and is
counted as `missingAtSource`. `.credentials.json`, `credentials.json`, `auth.json`
and `*.tmp`/`*.partial`/`*.lock` files are never read. The local state directory
keeps the size and modification time already archived, so an unchanged file is
not read again; delete it only to force a full re-verification. Transcripts are
verbatim and may contain secrets: keep the archive owner-only and out of RAG.

To keep a source host free of installed code and timers, run `collect` on the
archive host instead: it starts `send` on the source over SSH from this same
file, and the files come back over the source host's SSH to the archive host.
`--state-dir` is then a directory on the source host.

```
python3 session_archive.py collect --host-label devx \
  --source-host devx --return-host archive-host \
  --source claude-projects=/home/owner/.claude/projects ... \
  --destination-root /archive/agent-sessions \
  --state-dir /home/owner/.agentx/session-archive/state
```

On a Windows workstation the operations worker runs `send` as the
`session-archive` handler. For a Linux source, schedule `collect` from the
archive host's user timer, for example hourly (`OnCalendar=hourly`,
`Persistent=true`).

Core defaults to loopback port 3180; Data defaults to 3183. Linux helpers on the
same host use the internal/loopback endpoint. Windows consumers may use the private
HTTPS LAN entry without a human code. Usage sync sends no parental bearer and
requires an explicit API acceptance receipt. Remove obsolete access-code arguments
from existing tasks/wrappers. Redirects are rejected. Trust the instance CA through
normal Node configuration; never disable TLS verification.

For a Windows usage task running in the signed-in user's session, set its executable
to `%SystemRoot%\System32\wscript.exe` and its arguments to
`//B //Nologo "<operations-dir>\sync-codex-usage-hidden.vbs" -Endpoint "<endpoint>" -LookbackDays 7`.
Keep the VBS launcher beside `sync-codex-usage-to-prod.ps1` and `codex-usage-sync.js`.
It starts PowerShell hidden from creation and waits for its exit code, preserving
Task Scheduler's result and overlap policy. Starting PowerShell directly with
`-WindowStyle Hidden` can briefly show a console and interrupt typing.

Other interactive background tasks can use `run-hidden.vbs` with one private
UTF-16 command file. That file contains the original quoted executable and argument
string on one line, without a trailing newline. Set the task executable to
`%SystemRoot%\System32\wscript.exe`, with arguments
`//B //Nologo "<operations-dir>\run-hidden.vbs" "<private-command-file>"`.
Preserve the task's working directory, user, triggers and settings. The launcher
passes the configured command unchanged, starts it hidden and waits for its exit
code. Missing or invalid configuration returns 2; a launch failure returns 1.

The alert example is disabled and uses local logging. Preserve the live instance's
rule IDs, delivery channels and cadence when copying its private configuration.
Legacy `aiops-operator` authority and drift-event identity remain accepted to avoid
duplicating existing alerts. Mongo container/database must be explicitly updated
for the selected canonical project; the defaults match `agentx` / `agentx_product`.

For native backups, set `BACKUP_ROOT` to an external absolute directory and
`CRITICAL_BACKUP_VOLUMES` to the existing space-separated volume list in the unit's
external environment file. MySQL is optional; when selected its existing
`MYSQL_DATABASE` and `MYSQL_ROOT_PASSWORD` environment are used inside the container.
No live MySQL data directory is archived. New archive manifests include checksums;
restore drills also accept the old version-1 manifest and logical SQL filename.
Mongo's canonical backup includes integrated PsyX data. Off-host receipts live at
`<SourceRoot>/latest-offhost-receipt.json` and are not restore acceptance.

Before updating a native task/unit, snapshot its executable, arguments, environment
file paths, identity, triggers and enabled/running state. Change paths/settings
within that same supervisor, preserving the cadence. Disabled retired tasks stay
disabled. Deployment uses the `agentx` launcher; there is no auto-push or
auto-deploy script.

Validation: 35 Node checks cover counters, access-code transport, alert evidence,
schedule projection and collectors. Bash and PowerShell syntax parse locally.
The existing Linux Compose CI job runs `tests/backup-roundtrip.sh` with disposable
volumes and MySQL: full backup/restore, old archive compatibility, volume-only
restore and rejection of corrupt payloads. Native task activation and real backup
acceptance are per-instance work.

`archive_mirror.py` mirrors a directory that only grows, such as the Secretary
evidence archive, to another machine. It lists the source over SSH, transfers
new or changed files as one tar stream per batch, and accepts a file only when
its SHA-256 equals the source's. A file that changed at the source moves the
previous local copy to `versions/<run>/`; a file that disappeared at the source
is only counted (`missingAtSource`). Transient paths (`downloads/*`, `*.tmp`,
`*.partial`, `backfill.lock`) are skipped. With `--latest-zfs-snapshot` it reads
the newest snapshot under `<source-root>/.zfs/snapshot`, so listing, hashes and
content come from one consistent point in time. Files live under
`<destination>/current`; `latest-run.json` and `runs/` hold counts only, and
`--remote-receipt` writes the same counts back to the source host so its age can
be watched there. On Windows the destination gets an owner, SYSTEM and
Administrators ACL without inheritance. Schedule it with an existing Windows task
or systemd timer; a missed run is caught up on the next one.

The transfer copies only requested regular-file bytes with the listed size;
tar links, metadata and unrequested paths are ignored. It does not require the
`tarfile` extraction filter added in Python 3.11.4.
