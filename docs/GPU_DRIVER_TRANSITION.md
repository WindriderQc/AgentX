# GPU driver observation and prepared evidence

Data's native collector reports `driver_version`. Benchmark stores the complete
sample in `HostProfile.gpuDriverObservation`, separately from the GPU inventory
that currently determines runtime identity. The sample retains its own date,
source, latest availability and Data's `staleAfterMs` window. New measurement
metadata reports a driver only while that native window covers the measurement
and the latest read is observed. Partial, unavailable and expired observations
produce an unknown measured driver. Historical evidence is unchanged.

## Preparation

`POST /api/profiler/hosts/gpu-driver/:hostId/prepare` accepts a stable `requestId`
and the exact `expectedFingerprint` of the current host. It records a manifest;
it starts no collector, inference, Profiler run or qualification campaign.
A repeated identity with the same intent returns the stored preparation. A
changed intent, another pending preparation or a lost host CAS is refused.

The manifest is the union of all currently valid native context, performance
and tool capabilities on that host and exact installed artifacts. It includes
capabilities that have no corresponding record in one of the other stores.
Existing native receipt, identity, stale-state, integrity and expiry checks decide
eligibility. An unreadable owner or a changing scope refuses the complete
capture. Two matching captures bind the serving contexts and Core's current
pins. Tag normalization preserves namespaces; `:latest` aliases do not create
another capability.

There is no universal Full requirement. A native qualified standard performance
profile uses the same performance gate as a Full profile. A verified context
recommendation or quality window retains its native requirements, without
requiring the new performance proof to repeat an otherwise diagnostic depth. The manifest retains verified context capacity, required thinking
and supported-tool capabilities. A lower context or removal of a required
capability does not silently satisfy this operation. Native lane readiness for
chat, documents and coding agents is preserved through the existing lane
projection, including its own agent-workload thresholds.

The target uses the newly observed drivers and
`gpuDriverIdentityVersion: agentx.gpu-driver-identity/v1`. This identity epoch is
absent from historical hosts. Unknown identity versions are refused. It separates prepared evidence from the current
identity even if a driver was previously recorded manually. Recording a
preparation does not set that field on the host or alter its current fingerprint.

## Native measurement and deferred publication

Profiler's existing single-model and host-queue entries accept
`driverPreparationId`. The host-queue executor in Core's heavy-work queue carries
that same field. A prepared queue defaults to the complete manifest and does not
skip models because a previous identity was profiled recently. The exact target
is checked again at context and performance publication.

New context profiles and snapshots retain the preparation identity. They are
stored under the target fingerprint; a new preparation cannot inherit the
retained ceiling of an earlier preparation. Performance evidence remains in
`ModelPerformanceProfile` with `active: false`. The existing
`profiler_evidence_write` journal and profiler authority receipt publish only
`ModelProfile.preparedReadiness` and `preparedThinkingProfiles`. These maps are
excluded from ordinary reads. Current readiness, thinking, roster and active
performance evidence remain unchanged. Journal replay and compensation use
these same prepared projections; they do not restore or relabel active history.

Tool campaigns use the existing runner and mocked toolbox. The optional
`--driver-preparation-id` selects an explicitly prepared contract and records
its exact measured context and preparation identity in the immutable native tool
evidence digest. Core's separate
`POST /api/inference/contract/resolve-prepared-driver` requires a live
`tool-capability-qualification` workload and its exact admission and host claim.
It checks that proof before and after reading Benchmark. Benchmark independently
re-attests the claim through Core's existing heartbeat before returning prepared
evidence. Caller attribution alone is insufficient.

Core still builds the target through its native inference and context contract
resolvers. The serving context is the one frozen in the manifest. A prepared
snapshot is marked `prepared_gpu_driver_qualification` and cannot be reused as
an ordinary campaign snapshot. Ordinary inference keeps its current identity.
The target tool contract requires new native context/performance evidence but
does not require its own tool proof before that proof can be measured.

All live measurement retains the existing heavy-work queue, admission, claims,
terminal receipts and restoration requirements. Preparation grants no launch,
pin-change or deployment authority.

## Operator reads

`GET /api/profiler/hosts/gpu-driver/:hostId` returns the current fingerprint and
stored operation. `GET .../:hostId/prepared/:requestId` checks the complete frozen
scope and reports missing or drifting native proofs for each model. Its `ready`
field describes preparation completeness, not a new model qualification source.
Driver, physical identity, pins, serving context, source scope or proof integrity
drift prevents readiness.

The thin HTTP CLI is `benchmark/scripts/gpu-driver-preparation.js`, with
`status`, `prepare` and `evidence` actions, an explicit service URL and host ID.
The preparation action also requires the stable request ID and expected active
fingerprint. It accesses no database directly.

There is no activation endpoint or CLI action in this preparation capability.
No prepared evidence becomes active through these reads or measurements. The
complete transition is tracked in [#1129](https://github.com/WindriderQc/AgentX/issues/1129).
Source/CPU tests and disposable database checks remain separate from private
host installation, queued requalification and acceptance.
