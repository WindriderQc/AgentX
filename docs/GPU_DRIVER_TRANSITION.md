# GPU driver transition

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
`status`, `prepare`, `evidence`, `activate` and `abandon` actions, an explicit service URL and host ID.
The preparation action also requires the stable request ID and expected active
fingerprint. It accesses no database directly.

## Atomic host activation

`POST .../:hostId/activate` requires a stable activation `requestId` and the exact
`preparationId`. Every model in the manifest must have new compatible native
proof. The action acquires Core's exclusive host workload reservation, records a
`gpu_driver_activation` entry in the existing authority reconciliation journal
and freezes references to the new context, performance and tool proofs. It checks
scope, pins, physical identity, driver freshness and native proof integrity again
before publishing. A MongoDB time fence refuses publication after a driver sample
or required tool proof expires.

One HostProfile CAS selects the observed GPU inventory, known identity epoch and
complete proof set. It changes no historical evidence hash and copies no proof
into another authority store. Current Benchmark readers select those exact native
receipts; their normal receipt, qualification, identity and stale checks remain
mandatory. A later finalized ordinary Profiler publication takes priority. A
pending or compensated first ordinary write does not steal the prepared selector;
an invalidation after ordinary publication never restores an older prepared proof.

Core confirms invalidation of routing, readiness, context and enriched model
catalog caches under the exact live workload or adopted native recovery owner.
In-flight reads refresh when their generation changes. Core durably stores the
invalidation receipt; Benchmark records that receipt before resolving the journal
and releasing the reservation. There is no inference, collector or campaign launch
in the activation action.

A lost response, interrupted journal or missing cache acknowledgement retains
the native quarantine. Retry the same activation request to read its result or
reconciliation status; never invent another ID to retry an uncertain operation.
The existing recovery worker adopts and resumes that same journal. Before verified
publication, native compensation only cancels the pending intent and preserves
the current host identity. After publication, recovery resumes cache confirmation
without repeating the identity switch or rerunning qualification. A later physical,
driver or pin change retains its normal invalidation behavior; a stored activation
receipt describes the accepted transition, not perpetual current qualification.

If the acquire response is lost before the first Benchmark journal exists, the
existing record-less recovery worker finds Core's expired reservation through the
stable action recovery identity. It journals and settles that original workload
without publishing an activation or launching another action. Distinct acquire
attempt identities keep concurrent callers from sharing a live writer proof.

After activation, a known driver A-to-B observation updates the runtime identity.
Missing driver telemetry retains the last identity value and reports an unknown
driver on new measurements; it never masks a known changed driver.

## Abandon and prepare again

`POST .../:hostId/abandon` requires its own stable `requestId` and the exact
`preparationId`. Under a native exclusive workload, it marks only an unactivated
preparation abandoned and keeps a private operation receipt. It deletes no
manifest or proof and changes no current qualification. Repeating the same
intent reads its original receipt. Once its native workload is resolved, a new
preparation may capture the current scope and pins with a new request ID. An old
preparation ID always reads its archived abandoned result; it cannot be reopened.

A pending or published activation, or an unresolved activation journal, refuses
abandonment. Reconcile that original native operation before preparing again.
Neither manual database deletion nor a new coordination identity is a recovery
path. The CLI uses `--request-id` for the action and `--preparation-id` for its
frozen preparation; preparation alone uses `--expected-fingerprint`.

Source/CPU tests and disposable database checks remain separate from private
host installation, queued requalification and acceptance.
