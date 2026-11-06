# Ecosystem observations

The owner ecosystem view polls `/api/nerve-center/ecosystem/live` every ten
seconds while visible. Core publishes the same bounded, dated observation to
`read_presentation`; GraphysX binds its reference after rendering. No model,
scanner, scheduler job or workload is started by refresh. Family devices retain
the static tour and cannot read this owner endpoint.

`AGENTX_INSTANCE_ROOT/config/ecosystem-live.json` maps scene IDs to existing
Nerve Center `hosts` or `services`. Version 1 remains supported. Version 2
supports up to 64 nodes, adds `observations: ["logical-check-id"]` and explicit
`unobserved: true`, and requires `observer: {script, config}` with absolute
native paths. Each node uses exactly one mapping kind. Source IDs cannot be
shared between map nodes. Keep actual identities and target definitions private.

The companion `config/ecosystem-observers.json` has `version: 1` and `checks`.
The installed `integrations/ecosystem/observe.py` reads this private manifest via
the existing Operations SSH target (`AGENTX_OPERATIONS_SSH_TARGET`), using strict
host verification. Core hashes its mounted manifest and requires the native
copy and response to match. The observer never reads credential files, follows
HTTP redirects, discovers machines or executes configured shell commands.

Supported checks have a logical `id`, a `kind`, and these typed fields:

| Kind | Fields | Meaning |
| --- | --- | --- |
| `docker` | `targets` (container names) | Running state and optional native health check; partial failures remain unknown/degraded |
| `systemd` | `scope` (`user`/`system`), `targets` (`.service` units) | Loaded, active and running process; an exited oneshot is not a running agent |
| `http` | `url` (literal private/loopback IP, no credentials or query) | Interface response only; redirects/auth challenges attest reachability, not functional acceptance |
| `prometheus` | `metric`, `labels`, `source` | Existing local Prometheus only: `up` for `host_collector`/`monitoring_collector`, or `node_zfs_zpool_state` with `state=online` for `storage_health` |
| `network` | `deviceId` (stable Data identity) | Existing Data inventory presence; never initiates a scan or identifies a machine by DHCP address |

For example, a synthetic private check can be
`{"id":"media-service","kind":"docker","targets":["example-media"]}`.
The observer config is limited to 64 checks and 32 KiB; process groups to eight
targets. Native transport and source reads have bounded deadlines and buffers.
Read failures affect only their source group. No native target, address, model,
credential or log is returned to the renderer or the presentation reader.

Core shares native observations for 25 seconds and live responses for five
seconds. Cache hits never renew observation dates. Prometheus dates come from
`timestamp(metric)`, not instant-query evaluation time. Native observations
expire after two minutes. Data positives retain the actual last-seen time and
Data's online window (capped at 30 minutes); an absent device is explicitly
network absence, not physical shutdown. The overall view expires after 30
seconds without renewal. Unknown/stale values lose their healthy appearance.

The view states each scope. Inference does not prove whole-machine health, an
unreachable exporter does not prove shutdown, storage exporter health does not
prove restoration, and no check proves a successful user task. Components without
a reliable probe remain explicitly unobserved. Native process groups do not
attest individual agents, voice quality, active campaigns or model readiness.

Install the script from the reviewed product revision and both private manifests
under the instance's native maintenance ownership. The Core mount and native
manifest must contain identical bytes. Roll back both manifests together, or
restore version 1. No new inbound route, Docker network or secret grant is needed.

Synthetic checks:

```sh
python3 -m unittest discover -s integrations/ecosystem -p 'test_*.py'
node --test core/surfaces/diskx/test/ecosystem-*.test.js
```
