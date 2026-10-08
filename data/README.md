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
optional service defaults to internal `http://data:3083`. Direct native Data
defaults to loopback. Background feeds and existing janitor schedules start only
with `DATA_BACKGROUND_JOBS_ENABLED=true`; manual APIs remain available. Network
scan defaults require `NETWORK_SCAN_CIDR` or an explicit request target.

Janitor AI advice (triage, duplicate resolution, path analysis) asks Core's
`janitor_ai` task and waits 60 seconds, with one retry. When that task is
routed to a slow CPU-resident host, raise `JANITOR_AI_TIMEOUT_MS` (up to
1200000); above two minutes a timed-out request is not retried, so a second
long request never queues behind the first.

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

Native collectors live in `integrations/data-collectors`. Set `DATA_URL`,
`SCAN_CIDR` (network) and `STORAGE_SOURCES_JSON` (storage) in external instance
configuration. Storage sources map explicit host roots to stable canonical paths,
for example `media` to `/mnt/media`, excluding a nested `Datalake` root counted
separately as `/mnt/datalake`. No personal physical root is inferred.

A finished scan removes the index rows it did not see, one root at a time. A
root where the scan indexed no file keeps its rows and the scan ends `partial`
with the reason in `last_error`: an unmounted or emptied mountpoint walks as a
clean, empty directory and must not erase the inventory and its hashes. The
in-container scanner also keeps existing rows when a directory could not be read
or a batch failed. A root that was really emptied keeps its last rows until a
scan indexes at least one file there.

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
