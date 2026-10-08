# Data

Optional AgentX service for storage/file inventory, network observations, GPU
telemetry, live feeds, database inspection, exports, events, integrations and
supervised janitor operations. Source, tests and distribution belong to this repository.

Core's full profile hosts `/data-toolbox`, a read-only UI backed by Data HTTP
APIs. The original mutation APIs remain inside Data with their existing domain
checks. Mount shared storage read-only unless a specific maintenance operation
requires an explicitly approved writable mount. No disk mount is shipped by default.

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
batch, or 6 hours queued without a claim; this is checked at startup and each
time scans are requested, claimed, listed or read. A finished external scan is
not reopened: a late batch or completion gets 409. A batch is accepted only for
a running external scan; entries outside its roots and malformed `sha256`
values are dropped and counted in `counts.rejected` and `counts.hashes_rejected`.
`POST /storage/scan` takes `batch_size` from 1 to 10000 and extension lists of
at most 200 strings.

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
read. A GPU the host last reported with no sample in the window has coverage 0.

`DATA_COLLECTOR_PLACEMENT_JSON` may provide the Toolbox's operator display map:
`{"network":{},"storage":{}}`, with rows keyed by configured collector ID and
`host`, `supervisor`, `runtime`, `cadence` text. Without it, registrations and
observed health remain visible, but configured supervisor placement is unknown.

`npm test` runs existing unit tests and actual Mongo index tests in a disposable
database using the shared test launcher. It cannot use a production URI. Native
collector, real filesystem, scheduler and live-data acceptance remain separate.
