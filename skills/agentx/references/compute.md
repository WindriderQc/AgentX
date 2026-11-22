# From a measurement or task to a result

## Read Benchmark coverage

For the native Profiler progress and pinned-fit readers, see
[Benchmark and Profiler](benchmark.md).

Use general `benchmark_coverage({})` for the matrix of pinned or routed
host/model pairs. Its HTTP equivalent is `GET /benchmark/api/benchmark/coverage`
under Core's configured prefix. Quote `generatedAt`, `scorerVersion`, exact
host/model and scope. For the selected pair:

- Read `profile`, `profileDepth`, `profileNote` and `next`. Profiler measures
  runtime capability on that host. Stale or missing evidence can require a
  profile even when scores exist. The Profiler host view preserves baseline
  dates and stages.
- Report `promptsScored/promptsTotal` with the requested `byCategory` counts.
  Coverage counts distinct current catalogue prompts with qualifying scores for
  that artifact and scorer. It measures completion, independently of score
  quality. A complete pair also needs a current profile.
- For actual results use `benchmark_results({host,model,limit})` with the
  matrix pair. Open the native read at
  `GET /benchmark/api/benchmark/coverage/results?host=<host>&model=<model>`
  where authorized. Cite the scored prompt, judge status, errors and date
  when present. Old, unscored and errored rows alone cannot fill a gap.
- Inspect `parked` and `automaticMeasurement.enabled/quietHours/waitingFor`
  before explaining a wait. A request through `benchmark_request_measurement`
  is a priority change for the pair. Keep disabled automation and parked hosts
  as observed. [Benchmark operations](ops.md#benchmark) covers calibration
  and driver changes.

## Use an available GPU

1. Observe `gpu_status` and, if needed, the timestamped [host inventory](ops.md#models-routing-and-usage).
   Distinguish free VRAM at observation time from topology, existing claims,
   planned reservations and native admission. Start from a real need: a
   missing measurement, an approved image request, or linked Pipeline work
   with a specific deliverable. A CPU-only task can stay on CPU.
2. Read owner `work_queue` with `{"action":"list"}`, then `show` for the
   linked request ID. Use `summary.counts` and `presentation.nextAction`.
   For engineering work also read the [task and authority](dev.md#pipeline-tasks).
   Check scope, dependencies, pause, budget, eligible hosts, time window and
   native capability. Report a pause or pending decision with its owner.
3. Match kind and executor. A Profiler host queue needs its registered host
   ID and target model. Benchmark uses a prepared native plan and explicit
   candidate/judge endpoints, or the coverage job's immutable intent. Images
   need the configured worker and original image request. A coding task uses
   its eligible worker. A custom live check uses the explicit operator receipt
   protocol. The owner MCP planning request has **no executor**. An operator
   can submit a reviewed executable manifest under a new stable key linked to
   the proposal; see the [queue procedure](ops.md#heavy-work-queue).
   Without an authorized compatible executor, return the blocker and the task
   link. Never unpause, switch topology or launch a substitute to fill idle time.
4. On authorized execution follow the **same** queue request, dispatch ID and
   native attempt/batch/tracker. Verify terminal outcome and resource release.
   A reservation, preparation receipt or accepted dispatch stops short of
   runtime proof. Missing receipt or lost reply stays uncertain: reconcile
   the original identity with its native owner and retain its fence.
5. Open the result in its owning reader. For a Benchmark run use
   `GET /benchmark/api/benchmark/batch/<native-batch-id>` from the original
   receipt. A recent score for the same pair alone cannot identify this run.
   Other outputs include an image artifact or a verified Pipeline
   deliverable in `pipeline_artifacts` and its task dossier. Match IDs, date
   and outcome to the request. Return the accessible link or reader arguments.
   If the run is proven but the output cannot be opened, report execution and
   the missing deliverable separately.

Product procedures at the served revision: `docs/HEAVY_WORK_QUEUE.md`,
`docs/PROFILER_CONTEXT.md` and `docs/CODING_TEAM_ARCHITECTURE.md`.
