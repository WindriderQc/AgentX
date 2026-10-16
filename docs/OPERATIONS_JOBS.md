# Native operational jobs

`/automations` is Core's shared operations hub. Its catalogue and calendar combine
server-owned host jobs, Core backups and the official OpenClaw cron inventory.
Native OpenClaw core functions remain distinct from agent turns and commands.
The shared System navigation has one entry. `/operations-jobs` redirects here;
`/cluster-schedule` redirects to the Calendar view, retaining placement, measured
usage and the heavy-work queue. Agent Ops retains agent dossiers, responsibilities,
attention and documented obligations without duplicating the native job catalogue.

`GET /api/automations` reads each owner independently. Job identity is the owner
plus its native ID, never its name. Native jobs appear once; obsolete OpenClaw
mirrors are disabled archive references. Cached evidence is labelled per source
and unavailable owners have no active controls. The catalogue does not install,
run, delete or reschedule OpenClaw jobs. Their existing Control UI owns these
changes; Core's Backup screen owns its policy. Host-job actions retain the bounded
`/api/operations/jobs` entrance and native revision/request fences.

The Calendar view reuses the existing Cluster Schedule page and its
`/api/cluster/schedule` timeline, host, queue, placement and utilization APIs.
There is one calendar controller and recurrence resolver. Task/host switches,
search and owner filters share that view. Measured utilization is an expandable
section of the same page. The former Resources URL redirects here; there is no
parallel agenda or second calendar API. Core backup recurrence is a read-only
virtual entry from its native scheduler, without another persisted schedule.
The History tab contains complete supervisor receipts; Core and OpenClaw history
stay in their owning screens. Windows inventory and local execution retain
their source boundaries. This full-profile capability adds no Nestor or family
grants.

The native server supervisor owns one configuration, occurrence state and dispatch
receipts outside Git. Core calls its named entrance over SSH; cadence and pause
changes are revision-fenced writes to that same authority. Cluster Schedule mirrors
its safe projection rather than owning another executable schedule. No command,
credential, executable path or source path is accepted from a browser.

## Placement

Collectors execute beside local sessions; backup and archive copies execute beside
the off-host destination. Published bundles are delivered through verified SSH
transfer into a local workspace, retaining existing files. The server schedules
these named adapters. Its systemd timer continues when Core is unavailable; an
acknowledged complete backup marker may be cached for recovery transfer.

Supported handlers are usage counters, submit-only memory collection, off-host
backup replication, archive mirroring and bundle delivery. The memory handler
preserves the native source filters and watermarks and never synthesizes or applies
memory. Existing synthesis remains under its native owner. These handlers do not
invoke inference or change model pins. Heavy coding/qualification work still uses
[the heavy-work queue](HEAVY_WORK_QUEUE.md) and existing native ownership.

Backup copies require a recorded complete Core backup. Archive mirroring requires
an available snapshot; bundle delivery requires a published manifest. An unchanged
source does not cause another scheduled copy. Manual runs retain the source gate.

## Installation

Copy the product helpers and their `host_jobs` package to stable, versioned native
runtime directories. Configure `host_job_worker.py` on the workstation with a
private `state/config.json`: job IDs, their named handler options, local paths and
existing state/watermark locations. Configure `host_jobs_control.py` on the server
with a separate private root and its server-owned `config.json`. Both use version 1;
the server configuration declares hosts and recurrence, and the worker configuration
declares the allowed local adapters. Instance settings never belong in product Git.

Start from the disabled synthetic example in
`integrations/operations/host_jobs/config.example.json`. Adapt the supplied service
and timer to the native user. The external environment file supplies
`AGENTX_OPERATIONS_CONTROL` and `AGENTX_OPERATIONS_ROOT`. Authorize and verify SSH
host keys in both directions. A Windows task depending on desktop SMB credentials
needs a tested transfer adapter before switching to SSH execution.

Core receives these external environment settings:

- `AGENTX_OPERATIONS_SSH_TARGET`: native server SSH target; unset disables the bridge.
- `AGENTX_OPERATIONS_ROOT`: absolute server state/configuration root.
- `AGENTX_OPERATIONS_CONTROL`: absolute native `host_jobs_control.py` path.

Core uses its existing native SSH key/known-host configuration with strict host-key
checking. Source controls must remain protected by the existing private LAN entry
and browser-origin guard. No new grants are added to Nestor or family consumers.

Snapshot the existing Windows definitions and compare source filters, credentials,
retention and destinations before migration. Validate the native adapters, ensure
old jobs are idle, and disable their old recurrence before activating the server
supervisor. Keep original XML and qualification receipts outside Git. Disabled
standby launchers remain disabled. A paused native job may be run explicitly;
pausing affects future automatic starts and preserves accepted execution identities.

## Execution and recovery

`accepted → running → completed/failed`; a host unavailable before SSH command
acceptance becomes `waiting-host`. The supervisor retries that same identity when
the host returns. Uncertain command acceptance or a lost result becomes `unknown`
and remains fenced. Reconcile the same request through the native worker receipt;
never replace it because a response, process or file is missing. The UI preserves
an unresolved manual request across refresh and reports unknown outcomes explicitly.

Installation establishes the next occurrence rather than replaying all past jobs.
Missed occurrences coalesce into one current execution. Three proven handler
failures stop automatic starts until an operator resumes or successfully runs the
job. A worker deadline preserves uncertainty rather than claiming termination.
Private stdout, stderr, configurations and immutable run receipts remain native.
Core displays only safe status, counts, dates and verification evidence.

The CLI accepts `status`, `tick`, `run`, `execute`, `reconcile`, `patch` and
`inventory`. `run` requires an exact UUID request ID. Browser edits accept only
`enabled` and a bounded daily/interval schedule, with the current revision.

Validation distinguishes synthetic concurrency/replay, API and browser checks from
native task cutover and actual off-host transfer acceptance. An archive hash receipt
is not a restore rehearsal.
