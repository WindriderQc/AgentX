# Data

Optional AgentX service for storage/file inventory, network observations, GPU
telemetry, live feeds, database inspection, exports, events, integrations and
supervised janitor operations. Source, tests and distribution belong to this repository.

Core's full profile hosts `/data-toolbox`, a read-only UI backed by Data HTTP
APIs. The original mutation APIs remain inside Data with their existing domain
checks. Mount shared storage read-only unless a specific maintenance operation
requires an explicitly approved writable mount. No disk mount is shipped by default.

Enable Compose profile `data` when needed. Core uses `DATAAPI_BASE_URL`; the
optional service defaults to internal `http://data:3083`. Direct native Data
defaults to loopback. Background feeds and existing janitor schedules start only
with `DATA_BACKGROUND_JOBS_ENABLED=true`; manual APIs remain available. Network
scan defaults require `NETWORK_SCAN_CIDR` or an explicit request target.

Native collectors live in `integrations/data-collectors`. Set `DATA_URL`,
`SCAN_CIDR` (network) and `STORAGE_SOURCES_JSON` (storage) in external instance
configuration. Storage sources map explicit host roots to stable canonical paths,
for example `media` to `/mnt/media`, excluding a nested `Datalake` root counted
separately as `/mnt/datalake`. No personal physical root is inferred.

GPU telemetry lives under `/api/v1/hardware`. The native `gpu-agent` collector
posts one cycle per interval to `POST /samples` (and `POST /collector/heartbeat`
at start), unauthenticated like the network and storage collectors because Data
publishes only on loopback. `GET /latest` returns one snapshot per GPU host with
its collector, `ollamaUrl`, last error, consecutive failures, `ageMs` and
`freshness` (`fresh`, `stale` after three collector intervals with a 90 s floor,
or `no_data`); a failing host keeps its last GPUs and sample time. `GET /history`
returns bounded per-GPU samples (`hostId`, optional `gpuIndex`, `from`, `to`,
`limit` up to 2 000). History expires through a TTL index,
`DATA_HARDWARE_HISTORY_TTL_DAYS` (default 7, at most 90); a changed value is
applied to the existing index at startup. `GET /collectors` lists heartbeats.

`DATA_COLLECTOR_PLACEMENT_JSON` may provide the Toolbox's operator display map:
`{"network":{},"storage":{}}`, with rows keyed by configured collector ID and
`host`, `supervisor`, `runtime`, `cadence` text. Without it, registrations and
observed health remain visible, but configured supervisor placement is unknown.

`npm test` runs existing unit tests and actual Mongo index tests in a disposable
database using the shared test launcher. It cannot use a production URI. Native
collector, real filesystem, scheduler and live-data acceptance remain separate.
