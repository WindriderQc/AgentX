# Data

Optional AgentX service for storage/file inventory and its growth, network
observations, GPU telemetry, live feeds, database inspection, downloadable
reports, an activity log, integrations and supervised janitor operations. Source, tests and distribution belong to this repository.

Core's full profile hosts `/data-toolbox`, a UI backed by Data HTTP APIs. Its
tabs are Overview, Storage, Files, Network, GPU, Databases, Live Data, MQTT and
Janitor; the GPU tab reads the four `GET /api/v1/hardware` routes and the MQTT
tab the three `/api/v1/mqtt` routes described below. The Toolbox reads, with
five kinds of write: a network device's record (`PATCH /api/v1/network/devices/:id`:
name, known flag, type, location, notes), a network scan request
(`POST /api/v1/network/scan`, followed through
`GET /api/v1/network/scan-requests/:id`), an MQTT message published by
hand, a storage scan request, and the Janitor's duplicate-review decisions
(`PUT`/`DELETE /api/v1/janitor/profiles/shared-drive/review-decisions/:sha256`
and `POST .../review-decisions/batch`, described under
[Duplicate-review decisions](#duplicate-review-decisions): a record of intent
that deletes no file). Data stores the device fields as given, with no length limit of its own:
the Toolbox relay bounds them (name and location 80 characters, notes 500, a
fixed list of types). A collector sweep rewrites only what it observed (IP,
MAC, hostname, vendor, status, last sighting), so these fields survive it. The
Toolbox does not expose `POST /api/v1/network/devices/:id/enrich`, which needs
nmap inside the Data container. The storage scan request is
`POST /storage/agent-scans` with the name of a configured source and nothing
else, so hashing follows the defaults; the scan reads the disks and refreshes
the index, and changes no file. The Storage tab follows it through
`GET /storage/status/:scan_id` and `GET /storage/scans`; the Files tab reads
`/storage/files/browse`, `/stats`, `/tree`, `/duplicates` and
`/cleanup-recommendations` and `/storage/directory-count`. The original mutation APIs remain inside Data with their
existing domain checks. Mount shared storage read-only unless a specific maintenance operation
requires an explicitly approved writable mount. No disk mount is shipped by default.

Core also projects three reads for the personal assistant: the storage summary,
a bounded file-name search and GPU status
([operations](../docs/OPERATIONS.md)). They use the `GET` storage and hardware
routes below and change nothing here.

Enable Compose profile `data` when needed. Data does not read `AGENTX_PROFILE`:
it starts in either profile and reads only its own collections of the shared
database, and its database browser lists only its allowlisted collections. Core uses `DATAAPI_BASE_URL`; the
optional service defaults to internal `http://data:3083`. When Data is stopped
or not deployed, the Household panel and Agent Ops service health show its own
row `down` and marked `optional`; AgentX and the service summary are then
`degraded` ("optional Data unavailable"), never `down`. Direct native Data
defaults to loopback. Background feeds and existing janitor schedules start only
with `DATA_BACKGROUND_JOBS_ENABLED=true`; manual APIs remain available. Network
scan defaults require `NETWORK_SCAN_CIDR` or an explicit request target.

Without that setting no janitor profile timer is ever armed: a profile created
or updated with a schedule keeps it in the database and starts at the next
start with background jobs enabled. Every start, whatever the setting, repairs
what a crash left in progress: a `running` janitor run becomes `stopped`, and a
profile action left `executing` returns to `pending` with its preview
invalidated, `execution_interrupted_at` and a note. Nothing is approved or
executed by that repair; the action needs a new preview, which re-verifies
every file. A profile run fails at once, with the root named in its `error`,
when a root is missing or is not a directory.

Janitor AI advice (triage, duplicate resolution, path analysis) asks Core's
`janitor_ai` task and waits 60 seconds, with one retry. When that task is
routed to a slow CPU-resident host, raise `JANITOR_AI_TIMEOUT_MS` (up to
1200000); above two minutes a timed-out request is not retried, so a second
long request never queues behind the first.

Live feeds (ISS position, earthquakes, barometric pressure, satellite elements,
air quality, MQTT sensors) are all off until the master switch and each feed are
turned on with `POST /api/v1/livedata/config`. That call answers 409 when Data
runs without `DATA_BACKGROUND_JOBS_ENABLED=true`, since a stored switch would
start nothing. Pressure and air quality are read per location: locations live in
`weatherLocations`, seeded once from `LIVEDATA_LOCATIONS_JSON`
(`[{"name":"Home","lat":46.81,"lon":-71.21}]`) when that collection is empty.
Pressure comes from keyless Open-Meteo every 15 minutes, or from OpenWeather
when `WEATHER_API_KEY` is set. A feed that cannot run (missing key, no location,
upstream error) reports the reason as `lastError` in `GET /api/v1/livedata/feeds`.
`MQTT_BROKER_URL` (with optional `MQTT_USERNAME`, `MQTT_PASSWORD`) republishes
ISS and pressure points and feeds the `sensors` feed from the topics in
`LIVEDATA_MQTT_TOPICS`; unset, MQTT is skipped.

The Toolbox Live Data tab draws these feeds on a world map with the existing
`GET` routes only (`/latest` for ISS, pressure, air quality and sensors,
`/history` for the earthquake list); Data has no map route. The ISS, the
earthquakes, the stored locations and the sensor points that carry `lat` and
`lon` are drawn; satellite elements have no position and are not. The country
outlines are a static file of the Toolbox
([credits](../core/surfaces/data-toolbox/public/geo/CREDITS.md)), so the map
needs no internet access. See [the operator guide](../docs/OPERATOR_UI.md#data-toolbox-live-data-map).

The MQTT monitor lives under `/api/v1/mqtt`. When `MQTT_BROKER_URL` is set,
Data opens a second broker connection for it at startup, with or without
`DATA_BACKGROUND_JOBS_ENABLED`, subscribes to `#` and keeps the last 500
messages in memory; nothing is stored and a restart empties the list. The
broker's own `$SYS` topics are not part of `#`. `GET /status` returns
`configured`, `connected`, `broker` (host and port only, never the URL or the
account), `since`, `received`, `lastMessageAt` and `lastError`. `GET /messages`
returns messages oldest first, each with `seq`, `ts`, `topic`, `payload`,
`bytes`, `truncated`, `binary`, `retained` and `qos`: `payload` is UTF-8 text
cut at 4 KiB, or a hex preview of the first 64 bytes when the bytes are not
UTF-8, and `bytes` is the real size. `since=<seq>` returns what came after that
sequence number, and without it the newest `limit` messages (default 100, at
most 500); `topic` is an MQTT filter with `+` and `#`, refused with 400 when a
wildcard is misplaced. The answer carries `latestSeq`, `nextSince` (what to ask
next), `more`, `dropped` with `droppedCount` when the buffer no longer holds
everything after `since`, and `epoch`, which changes when the monitor restarts
and its sequence numbers start again. `POST /publish` takes `{ topic, payload,
retain }` and publishes one message at QoS 0 on any topic: `topic` is a
non-empty string of at most 256 bytes without `#`, `+`, NUL or a leading `$`,
`payload` a string of at most 4 KiB (it may be empty), `retain` an optional
boolean, and any other field is refused. It answers 400 for an invalid body,
503 when no broker is configured or connected (the message is never queued for
later), 504 when the write is not confirmed within 5 s, and otherwise only
after the client has written the message. Data logs the topic and size of a
published message, never its payload. Like the rest of Data, these routes have
no login of their own: whoever reaches Data, or the Toolbox in front of it, can
publish to every device on the broker.

A duplicate report keeps its summary in `dedup_reports` and its groups in
chunked `dedup_report_details` documents, so a large inventory cannot exceed
MongoDB's 16 MB document limit. `GET /api/v1/janitor/dedup-report` returns one
page of `groups`, largest first: `group_offset` (default 0) and `group_limit`
(default 100, at most 1 000), with `groups_page` giving `offset`, `limit`,
`returned` and `total`. Zero-byte files are never grouped as duplicates. A
profile run stores at most 2 000 proposed actions (and 8 MiB of them) in its
`janitor_runs` document; the rest is counted in `proposed_actions_omitted` and
only appears in a later run, once the stored duplicates have been removed. `GET /api/v1/storage/files/duplicates` bounds
`limit` to 1–500. Queued network scan requests expire one day after they were
requested (TTL index). New indexes on `nas_files`, `livedata_points`,
`dedup_report_details` and `network_scan_requests` are built at the first start
after an upgrade.

### Duplicate-review decisions

The nightly shared-drive strategy report
(`GET /api/v1/janitor/profiles/shared-drive/strategy/latest`) lists the verified
duplicate groups of `/mnt/media` and `/mnt/datalake`. The owner's decision about
a group is stored in `janitor_review_decisions`, one document per group.

**A decision is intent only.** It says what the owner wants for a later cleanup.
Storing, importing or removing one approves nothing, previews nothing and
deletes nothing: the only path that deletes a file is still
`POST /api/v1/janitor/profiles/runs/:run_id/actions/:idx/approve` on a profile
run action, with a fresh SHA-256 preview, the typed confirmations and
`JANITOR_EXECUTION_ENABLED=true`. That path does not read the decisions, and a
decision's hash, date or content is not a preview id or a confirmation.

- **Identity.** One decision per content hash (`sha256`, 64 lowercase
  hexadecimal characters, the document `_id`). A duplicate group is "every
  current file with this hash", so the hash is what stays the same from one
  nightly report to the next. The file size and the paths seen when deciding
  are kept as evidence, with the report id and date when known.
- **Decision.** `keep_all` (reject deletion), `dedupe` (accept, with
  `survivorPath`, which must be one of the evidence paths) or `defer`; an
  optional `note` of at most 500 characters; `decidedAt`.
- **Validation** (`shared/janitorReviewDecisionRules.js`, also applied by the
  Toolbox relay). Unknown fields are refused. `evidence.size` is a whole number
  of bytes from 1 to 2^53 - 1. `evidence.paths` lists 2 to 500 different paths,
  each absolute, normalized (no empty, `.` or `..` segment), at most 1 024
  bytes and under `/mnt/media/` or `/mnt/datalake/`. `survivorPath` is refused
  on `keep_all` and `defer`.

| Route (under `/api/v1/janitor/profiles/shared-drive`) | Effect |
| --- | --- |
| `GET /review-decisions` | newest first; `decision`, `pathPrefix` (a root or a path under one), `state` (`current` or `stale`), `sha256` (at most 100, comma-separated), `limit` (1-200, default 50), `offset`; answers `decisions`, `pagination` and a `summary` of every stored decision |
| `PUT /review-decisions/:sha256` | store or replace the decision of one group (201 when new) |
| `POST /review-decisions/batch` | 1 to 200 decisions, all valid and all different or nothing is stored; `mode` is `upsert` (default) or `insert_missing`, which never replaces a stored decision and answers `saved` and `skipped` |
| `DELETE /review-decisions/:sha256` | remove the decision (undo); 404 when there is none |
| `GET /strategy/latest/groups` | one page of the latest report's verified groups in the report's order: `offset`, `limit` (1-50, default 30), `review=undecided` to skip decided groups, or `sha256` (at most 50) to read named groups |

**Staleness** is computed when reading, never stored, and a stale decision is
never applied to the group's new shape. A decision is `stale` when what it was
made on no longer matches: `group_not_verified` (fewer than two current copies
carry the hash), `size_changed`, `path_missing` (a copy is gone),
`hash_changed` (a copy now has other content, or its hash is no longer current
for its size and date), `new_copies`, `survivor_missing`. Each reason gives a
count and at most three paths. `GET /review-decisions` checks against the file
index as it is now (`nas_files`, with the report's own test of a current
member), at most the 2 000 most recent decisions per request (`summary.truncated`
says when more exist; the counts by decision always cover all of them). A page
of groups checks each decision against the group that page shows.

**The report is aware of the decisions, read-only.** A generated report stores
`reviewDecisions`: counts by decision, how many still fit this report's groups,
and `dedupe.reclaimableBytes`, the duplicate bytes the still-fitting `dedupe`
decisions represent (copies minus one, times the file size; nothing is freed by
storing them). Reading the latest report returns the same summary as it stands
now (the stored one moves to `reviewDecisions.atGeneration`) and marks each
group that has a decision with `review`. Which groups are verified, the
policy's survivor and the proposals are unchanged; where the owner's survivor
differs from the policy's, `review` carries both (`survivorPath`,
`policySurvivorPath`, `survivorDiffersFromPolicy`). The stored group chunks are
not rewritten. `GET /strategy/latest/groups` reads only the chunk documents a
page needs (a chunk holds at most 100 groups or 4 MiB); with
`review=undecided` it reads at most 10 chunks per request and `nextOffset` says
where to resume.

Native collectors live in `integrations/data-collectors`. Set `DATA_URL`,
`SCAN_CIDR` (network) and `STORAGE_SOURCES_JSON` (storage) in external instance
configuration. Storage sources map explicit host roots to stable canonical paths,
for example `media` to `/mnt/media`, excluding a nested `Datalake` root counted
separately as `/mnt/datalake`. No personal physical root is inferred.

A scan target is an IPv4 address or an IPv4 CIDR from `/16` to `/32`; Data
refuses anything else, and the network collector checks a queued target again
before it runs `nmap` (its own `SCAN_CIDR` may be wider). Posted scan results
keep only devices with an IPv4 `ip`, an empty or well-formed `mac` and text
`hostname`/`vendor`; the response counts the others in `rejected`. nmap XML
that does not parse is refused with HTTP 400 and changes no device. With
`pruneMissing`, a result without any valid device marks nothing offline and
says so in `pruneSkipped`. The collector gives up on a Data request after
`NETWORK_AGENT_HTTP_TIMEOUT_MS` (default 15000).

A finished scan removes the index rows it did not see, one root at a time. A
root where the scan indexed no file keeps its rows and the scan ends `partial`
with the reason in `last_error`: an unmounted or emptied mountpoint walks as a
clean, empty directory and must not erase the inventory and its hashes. The
in-container scanner also keeps existing rows when a directory could not be read
or a batch failed. A root that was really emptied keeps its last rows until a
scan indexes at least one file there.

Two scans never run on overlapping roots, since the first to finish would remove
the rows the other one stamped. `POST /storage/scan` answers 409 with the id of
the scan already queued or running there. `POST /storage/agent-scans` returns
that scan's id with `coalesced: true` when it is an external scan of the same
source, so a nightly job waits on it, and 409 when an in-container scan holds
the root. An external scan ends `failed`, with the reason in `last_error` and
no index row removed, after 10 minutes running without a collector heartbeat or
batch, or 6 hours queued without a claim; this is checked at startup, each
time scans are requested, claimed, listed or read, and every minute by the
activity watch described below. A finished external scan is
not reopened: a late batch or completion gets 409. A batch is accepted only for
a running external scan; entries outside its roots and malformed `sha256`
values are dropped and counted in `counts.rejected` and `counts.hashes_rejected`.
`POST /storage/scan` takes `batch_size` from 1 to 10000 and extension lists of
at most 200 strings. `POST /storage/stop/:scan_id` stops an in-container scan
only: a scan run by a native collector has no stop and ends on its own.
`GET /storage/scans` sorts by start date, newest first, so a queued scan, which
has none yet, comes after every other; read it by id. `GET /storage/files/tree`
returns the folders that hold files directly, largest first, each with the
count and size of its own files only, and says `truncated` when it reached its
`limit` (at most 2 000). `GET /storage/files/duplicates` returns the largest
groups only and has no offset; its `summary` describes the groups returned, the
totals of the index are in `GET /storage/summary`.

GPU telemetry lives under `/api/v1/hardware`. The native `gpu-agent` collector
posts one cycle per interval to `POST /samples` (and `POST /collector/heartbeat`
at start), unauthenticated like the network and storage collectors because Data
publishes only on loopback. `GET /latest` returns one snapshot per GPU host with
its collector, `ollamaUrl`, last error, consecutive failures, `ageMs` and
`freshness` (`fresh`, `stale` after three collector intervals with a 90 s floor,
or `no_data`); a failing host keeps its last GPUs and sample time. A host whose
Ollama service the collector reads also carries `ollamaEnvironment`: the latest
observation of its allowlisted Ollama server settings, with its own
`observedAt` (see `docs/OPERATIONS.md`). `GET /history`
returns bounded per-GPU samples (`hostId`, optional `gpuIndex`, `from`, `to`,
`limit` up to 2 000). History expires through a TTL index,
`DATA_HARDWARE_HISTORY_TTL_DAYS` (default 7, at most 90); a changed value is
applied to the existing index at startup. `GET /collectors` lists heartbeats.
`GET /occupancy` aggregates the history per physical GPU (collector host and
GPU UUID, or index when no UUID was read) over `from`/`to` (default the last
24 h, at most 90 days), optionally for one `hostId`, with `busyAtPct` (default
10) as the busy threshold. Each sample stands for the time since that GPU's
previous sample, up to 1.5 collector intervals, else for one interval; what no
sample covers is `missingMs`, and `coverage` is the observed share of the
window. Per GPU it returns `samples`, the first and last sample times, `busy`
(time at or above the threshold and its share of the time utilization was
read), time-weighted mean and p50/p95 utilization, VRAM used p50/p95/max and
total, mean/p95/max power and the limit, and `throttled` time (power cap,
thermal, hardware slowdown) with its share of the time throttle reasons were
read. The power cap counts only while the GPU is busy: the driver also raises
that flag on a card at rest, where it limits nothing. A GPU the host last reported with no sample in the window has coverage 0.

`DATA_COLLECTOR_PLACEMENT_JSON` may provide the Toolbox's operator display map:
`{"network":{},"storage":{}}`, with rows keyed by configured collector ID and
`host`, `supervisor`, `runtime`, `cadence` text. Without it, registrations and
observed health remain visible, but configured supervisor placement is unknown.

`npm test` runs existing unit tests and actual Mongo index tests in a disposable
database using the shared test launcher. It cannot use a production URI. Native
collector, real filesystem, scheduler and live-data acceptance remain separate.

## Reports

Reports of the file inventory live under `/api/v1/exports`. `POST /generate`
takes `{ type, format }` (`full`, `summary`, `media`, `large`, `stats`; `json`
or `csv`, `full` in JSON only) and answers `202` at once with the report's
`filename` and `status: "running"`: a full report sorts every indexed file
without an index, so its duration grows with the inventory and no request waits
for it. At most two reports are generated at a time; a third request gets `429`.
`GET /` returns `{ reports, totalSize, limits }`, newest first, each report with
`filename`, `type`, `format`, `status` (`running`, `ready` or `failed`), `size`,
`sizeFormatted`, `createdAt`, `requestedAt`, `recordCount`, `skippedCount` and
`error`. `GET /:filename/download` streams a `ready` report as an attachment
(`application/json` or `text/csv`), and `DELETE /:filename` removes one, or
clears a failed generation from the list. Both accept only a name the exporter
creates (`export_<type>_<date>_<time>_<6 hex>.<format>`): anything else is
refused with `400`, a symbolic link is never followed, and other files in the
directory are neither listed nor touched.

Reports are written to `DATA_EXPORT_DIR`. In Compose that is `/data/exports`,
the mount point of the `${project}_canonical_data_exports` named volume, so
reports survive a recreated container; a native run defaults to `exports`
beside the service code. A report is written as `<name>.part` and takes its name
only when complete, so a listed report is never partial; a failed generation
leaves no file, and a `.part` file left by a crash is removed by the next list
or generation. The store keeps at most 20 reports and 1 GiB: when a new report
brings it over either bound, the oldest are removed, never the new one. The
state of running and failed generations is kept in memory: a restart ends a
running generation and forgets it.

## Activity log

Data records what it does and notices in `appevents`, kept 30 days.
`GET /api/v1/events` returns `{ events, pagination, filters }`, newest first;
each event has `id`, `type`, `severity` (`info`, `warning`, `error`), `message`
(one English sentence, at most 300 characters), `meta` (a small structure, at
most 4 KiB, never file contents) and `at`. Filters: `type` (a type or the
beginning of one, such as `storage` or `storage.scan_`), `severity`, `since`,
`until` (ISO dates or epoch milliseconds), `page` (at most 500) and `limit`
(default 50, at most 200); an invalid filter gets `400`. `GET
/api/v1/events/stream` pushes the same events as server-sent events, with the
same `type` and `severity` filters. `POST /api/v1/events` lets a trusted caller
add an event of its own: `{ message, type, severity, meta }`, where `type` is
`external.<name>` (default `external.note`); Data's own types, an unknown
field, a message over 300 characters or a `meta` over 4 KiB are refused.

| Type | Recorded when | Severity |
|---|---|---|
| `storage.scan_queued` | a scan is queued for a native collector (not when a request joins a scan already queued) | info |
| `storage.scan_started` | a collector claims a queued scan, or `POST /storage/scan` starts one in the container | info |
| `storage.scan_finished` | a scan ends; `meta.outcome` is `complete`, `partial`, `failed` or `stopped`, with `meta.reason` and the headline `meta.counts` | info, warning (`partial`, `stopped`), error (`failed`) |
| `storage.scan_expired` | the reaper fails an external scan: no collector heartbeat for 10 minutes, or no claim for 6 hours | error |
| `collector.first_seen` | a storage, network or GPU collector creates its registry row (`meta.kind`, `meta.collectorId`) | info |
| `collector.silent` | a collector that was reporting has not reported for 5 minutes (or three of its intervals when that is longer) | warning |
| `collector.back` | a collector reported silent reports again | info |
| `gpu.host_stale` | a GPU host that was sampled has had no successful sample for 5 minutes; `meta.lastError` says why when the collector reported an error | warning |
| `gpu.host_recovered` | a stale GPU host is sampled again | info |
| `network.device_first_seen` | a sweep inserts a device the inventory did not hold (`meta.ip`, `meta.mac`, `meta.vendor`, `meta.hostname`); more than 25 new devices in one sweep make one summary event with `meta.count` | info |
| `janitor.run_finished` | a janitor profile run ends; `meta.status` is `complete` or `failed` | info, error |
| `livedata.feed_failing` | a live feed fails three runs in a row (one run for a feed fetched less often than every 5 minutes) | warning |
| `livedata.feed_recovered` | a failing feed fetches again | info |
| `mqtt.monitor_disconnected` | the MQTT monitor loses, or cannot open, its broker connection | warning |
| `mqtt.monitor_connected` | the MQTT monitor connects again after a disconnection | info |

Only changes are recorded: a feed that keeps failing, a broker that keeps
refusing or a device seen at every sweep adds nothing. The last state reported
for each collector, GPU host, feed and the MQTT monitor is kept in
`activity_state`, so a restart reports nothing twice; "first seen" comes from
the creation of the registry row or device row itself. A collector or host that
was already away when its state was first recorded is not announced. Silence is
the absence of a request, so one check runs every minute from startup, with or
without `DATA_BACKGROUND_JOBS_ENABLED`: it reads Data's own records only, fails
dead external scans, and counts a silence from the later of the last report and
Data's own start, so a restart of Data is not a silence. Writing an event never
fails the operation it describes: an error is logged and the operation goes on.
The scans a janitor profile runs itself are not in the log, nor is a janitor
run that a restart stopped.

## Storage growth trends

When a scan ends `complete`, Data stores one snapshot per scanned root in
`storage_trend_snapshots`: the root's files and bytes, and those of its
folders, read from the directory rollups the scan has just rebuilt. A scan that
ends `partial` (rows kept because the scan indexed nothing under a root, or
folders it could not read), `failed` or `stopped` stores nothing, and neither
does an in-container scan limited to some extensions or whose rollups could not
be rebuilt. There is one snapshot per root and UTC day: a later complete scan
of the same day replaces it. Snapshots are kept 800 days.

A snapshot holds every top-level folder of the root, or the 40 largest by bytes
with the rest summed in one `other` entry. When the root has at most 5
top-level folders, it also holds the 20 largest subfolders of each, the rest
again as `other`. Files that sit directly in the root or in a top-level folder
are a `files` entry, so the entries of a level add up to its total. A folder is
named by its `key`: `Movies`, `Movies/Action`, and `/other`, `/files`,
`Movies//other`, `Movies//files` for the summed entries.

`GET /api/v1/storage/trends?root=&from=&to=&folder=&limit=` returns `roots`
(every root with snapshots, its first and last day and last totals) and, for
`root`, `totals` (one point per snapshot: `day`, `at`, `scanId`, `files`,
`bytes`), `folders` (one series per folder of the newest snapshot in the
window, largest first, at most `limit`: default 12, at most 42) and `growth`
(files and bytes added between the first and last snapshot of the window, and
the 5 folders that grew the most). With `folder`, the series are that folder
and its subfolders, and `growth` is the folder's own. `from` and `to` are dates
(default the last 90 days, at most 800 days); an invalid or oversized parameter
gets `400`. A folder that was inside `other` on some days has no point for
those days, and is counted in `growth` only when the first snapshot listed it.
`scanHistory` gives, apart from the totals, the `files_seen` counter of
completed collector scans of that root found in `nas_scans`, one point per day:
it is what a collector walked, not index rows, and scans kept no byte total, so
it is never merged into `totals` or `growth`.
