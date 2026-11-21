# Benchmark, Profiler and coverage

Discover `benchmark_coverage` and `benchmark_results` on the general Core
MCP bus in an authorized operator session. The equivalent reads are
`GET /benchmark/api/benchmark/coverage` and
`GET /benchmark/api/benchmark/coverage/results?host=<id-or-name>&model=<model>`
on a gateway with Benchmark under `/benchmark`. The private instance sheet
can specify another Benchmark entry. Check its own `/health` revision.
Coverage and Profiler are operator capabilities. Famille's
[AgentX Living Source](sources.md) exposes Benchmark reachability only.

## Interpret the coverage matrix

1. Record `generatedAt`, `scorerVersion` and the exact host/model pair.
   Scope is models pinned on a host or routed to it. Keep parked lanes out
   of launch recommendations. An omitted pair has no result in this scope.
2. Read `profile`, `profileDepth`, `profileNote` and `next`. A missing,
   stale or unqualified profile needs Profiler evidence first. An existing
   quick profile can lack Benchmark qualification. A current profile with
   gaps points to Benchmark. Core admission still decides whether it can run.
3. Report `promptsScored/promptsTotal` and relevant `byCategory` counts.
   They describe prompt coverage, independent of answer quality. Counts
   follow current prompt fingerprints and scorer version, and the profiled
   artifact digest when known. Changed artifacts, prompts or scoring can
   reopen gaps. Completion requires a current profile and full scored coverage.
4. For actual score or speed evidence, use `benchmark_results {host, model,
   limit}` on that pair. Keep score, judge status, errors, date and cohort
   together. It returns recent result metadata. Compare equivalent
   prompt/scorer/artifact and execution-source cohorts. The Benchmark UI
   remains the place to open full available results.
5. Read `automaticMeasurement.enabled`, `quietHours`, `waitingFor`, and
   `last` (or the HTTP `job` fields). Paused, parked, outside quiet hours,
   no qualified executor or a refused admission are reasons to wait or
   review. A missing score is not permission to launch anything.

## Inspect a profile or launch receipt

In Profiler, read the host baseline, model readiness and qualified context.
The HTTP reads under `/benchmark/api/profiler` include `/hosts` and
`/readiness`. Verify the exact host, artifact, runtime/driver and context,
profile depth and date. A baseline says when it was measured. Use
[`gpu_status` and runtime reads](ops.md#health-and-hosts) for current activity.
Profiles and results for a different lane or an old runtime do not qualify
this lane. See `docs/PROFILER_CONTEXT.md` for fit, long context and drift.

`benchmark_request_measurement` changes priority for an existing pair with
a reason. It does not override the native measurement switch, quiet hours or
admission. An operator-approved run goes through the
[heavy-work queue](ops.md#heavy-work-queue) and the named Benchmark or Profiler
executor. Check the prepared plan and judge for Benchmark and the compatible
host/artifact profile for Profiler. Verify the exact native attempt or batch,
terminal result and release, then open the scores or profile. An empty active
batches view alone cannot establish that a run completed.

For an existing queued Profiler run, read Core's exact queue record first.
Under `/benchmark/api/profiler`, use
`GET /pipeline/profile-host/<operation.id>/progress`. If the native ID is
missing, use `GET /pipeline/profile-host/active?queueRequestId=<Core queue id>`
and follow its unique matching `queueId`. For `pinned-fit` use
`GET /fit-checks/<executor.fitCheckId>` instead. Match the Core queue ID and
host, and the original dispatch ID where the receipt supplies it. An empty
lookup or expired tracker leaves the outcome unverified. Check the original
native journal and Core release receipt before treating the host as released.

Use the [standalone judge cancellation procedure](ops.md#benchmark) only for
its exact admission. Product details are in `docs/OPERATOR_UI.md`,
`docs/HEAVY_WORK_QUEUE.md` and `docs/PROFILER_CONTEXT.md` at the relevant
Core and Benchmark revisions.
