# Native operations helpers

Operations capabilities for an AgentX instance. Use the existing systemd timers and Windows tasks; this directory does
not install a scheduler or start background work. Keep instance settings, receipts,
access codes and backup generations outside the checkout.

| Helper | External settings | Behavior |
|---|---|---|
| `codex-usage-sync.js` / `sync-codex-usage-to-prod.ps1` | Endpoint, sessions root, optional `AGENTX_ACCESS_CODE_FILE` | Sends sanitized counters only; `--dry-run` sends nothing |
| `alert-governance-sweep.js` | `AGENTX_ALERT_RULES`, Core URL, Mongo container/database, optional SSH target | Compares by default; `--apply` reconciles managed rules without deleting unrelated rules |
| `alert-telegram-relay.js` | `AGENTX_ALERT_TELEGRAM_CONFIG` (see `alert-telegram.example.json`): chat, forum topic, private token file and JSON pointer | Core's Telegram adapter: posts active alerts whose rule lists `telegram`, records delivery in Core, and posts one « Résolu » notice per relayed alert. Optional `quietHours` hold non-critical alerts and notices; previews without `--send` |
| `sync-openclaw-schedule.js` | Core URL and native OpenClaw inventory | Mirrors official jobs; never creates native jobs or copies prompts |
| `verify-native-data-collectors.js` | Data URL, expected scanner IDs, optional `--expect-gpu` collector IDs | Checks current or advancing heartbeat evidence |
| `backup-critical-runtime-state.sh` | `BACKUP_ROOT`, `CRITICAL_BACKUP_VOLUMES`, optional `CRITICAL_BACKUP_MYSQL_CONTAINER` | Archives selected Docker volumes and optional transactional SQL, with SHA-256 evidence |
| `restore-drill-critical-runtime-state.sh` | Exact archive path | Restores into disposable volumes/MySQL and removes only those disposable resources |
| `offhost-backup-replication.ps1` | Required `SourceHost`, `SourceRoot`, private `DestinationRoot` | Copies Mongo, configuration, Qdrant and native-state archives; verifies hashes; retention is opt-in |

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
