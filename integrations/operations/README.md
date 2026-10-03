# Native operations helpers

Operations capabilities for an AgentX instance. Use the existing systemd timers and Windows tasks; this directory does
not install a scheduler or start background work. Keep instance settings, receipts,
access codes and backup generations outside the checkout.

| Helper | External settings | Behavior |
|---|---|---|
| `codex-usage-sync.js` / `sync-codex-usage-to-prod.ps1` | Endpoint, sessions root, optional `AGENTX_ACCESS_CODE_FILE` | Sends sanitized counters only; `--dry-run` sends nothing |
| `alert-governance-sweep.js` | `AGENTX_ALERT_RULES`, Core URL, Mongo container/database, optional SSH target | Compares by default; `--apply` reconciles managed rules without deleting unrelated rules |
| `alert-telegram-relay.js` | `AGENTX_ALERT_TELEGRAM_CONFIG` (see `alert-telegram.example.json`): chat, forum topic, private token file and JSON pointer | Core's Telegram adapter: posts active alerts whose rule lists `telegram`, records delivery in Core, and posts one « Résolu » notice per relayed alert. Optional `quietHours` hold non-critical alerts and notices; previews without `--send` |
| `council-telegram-relay.js` | `AGENTX_COUNCIL_TELEGRAM_CONFIG` (default `~/.config/agentx/council-telegram.json`): `chatId`, `topicId`, `tokenFile`/`tokenPointer`, optional `councilUrl`, `all`, `lookbackHours`, `maxPerRun` | Mirrors Council sessions that seat OpenClaw agents (or all with `"all": true`) to one forum topic: header with the question, each turn under the speaker's name, then the synthesis, each once and in order. A mirror only: interjections and the chair's decision stay on `/council`. `--create-topic NAME` creates the topic once; previews without `--send` |
| `sync-openclaw-schedule.js` | Core URL and native OpenClaw inventory | Mirrors official jobs; never creates native jobs or copies prompts |
| `verify-native-data-collectors.js` | Data URL, expected scanner IDs, optional `--expect-gpu` collector IDs | Checks current or advancing heartbeat evidence |
| `backup-critical-runtime-state.sh` | `BACKUP_ROOT`, `CRITICAL_BACKUP_VOLUMES`, optional `CRITICAL_BACKUP_MYSQL_CONTAINER` | Archives selected Docker volumes and optional transactional SQL, with SHA-256 evidence |
| `restore-drill-critical-runtime-state.sh` | Exact archive path | Restores into disposable volumes/MySQL and removes only those disposable resources |
| `offhost-backup-replication.ps1` | Required `SourceHost`, `SourceRoot`, private `DestinationRoot` | Copies Mongo, configuration, Qdrant and native-state archives; verifies hashes; retention is opt-in |
| `archive_mirror.py` | Required `--source-host`, `--source-root`, private `--destination`; optional `--latest-zfs-snapshot`, `--remote-receipt` | Append-only pull of a private archive directory (for example the Secretary evidence archive); copies new and changed files, verifies each by SHA-256, keeps replaced versions, never deletes |

Core defaults to loopback port 3180; Data defaults to 3183. Linux helpers on the
same host use the internal/loopback endpoint. Windows consumers using the HTTPS
household entry must authenticate with the existing parental code. For usage sync,
store that code in an ACL-protected external file and select `-AccessCodeFile` or
`AGENTX_ACCESS_CODE_FILE`; the code is read per request and never passed on the
command line. Redirects are rejected. Install the instance CA through the normal
Node trust configuration; never disable TLS verification.

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
