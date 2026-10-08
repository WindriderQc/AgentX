# Operations

The conversation storage primitives retain a durable writer token
when a worker dies or a Mongo mutation has an unknown outcome. An erasure call
then reports `CONVERSATION_ERASURE_PENDING` or
`CONVERSATION_WRITE_RECOVERY_REQUIRED`; it has not completed. The erasure barrier
continues to reject new content writes. A successful erasure means the prior
writer settled and all of that owner's content was deleted with acknowledged
Mongo writes. Other owners remain independent.

Playground chat records accepted requests and response bytes before delivering
them. Its recovery disclosure lists refused, interrupted or unassociated
exchanges from Core in pages of 50, including older copies. Downloading a saved exchange never sends its
request again. `GET /api/history/receipts/:receiptId` and the corresponding
`DELETE` stay in the server-resolved Playground owner scope and use no-store
responses. Erasing a recovery copy leaves an already saved conversation intact;
erasing that conversation purges its associated copies and rejects late writes.
Household, PsyX and external consumer routes keep their existing contracts.

`Conversation` keeps an atomic reference to immutable transcript pages and
complete payload chunks. Existing embedded histories remain readable and move
on their next content write; no bulk migration is required. Content and search
metadata have integrity checks. A missing page, chunk or search index projection
returns `CONVERSATION_TRANSCRIPT_UNAVAILABLE`, never a partial history or export.
A whitespace-delimited search token larger than the safe index row (8 MiB)
also refuses search explicitly; its full content remains readable and exportable.
Queries requiring an oversized field's bounded index projection refuse with
`CONVERSATION_QUERY_REQUIRES_FULL_CONTENT`. Partial message selections cannot
replace a full transcript. Query upserts, update pipelines and raw/unordered
bulk inserts have no transcript implementation and refuse explicitly.

There is no automatic fence takeover or recovery endpoint. Never clear a writer
token merely because it is old, or report erasure complete after an uncertain
database command. Recovery requires independent proof that the exact writer and
its database operations have settled, followed by a retry of the requested
erasure. Receipts and runtime evidence belong outside Git.

For the screen labels, inspection steps and evidence disclosures used by Pipeline,
Nerve Center and Profiler, see [operational screens](OPERATOR_UI.md).

For a first installation and local Ollama setup, follow [installation](INSTALLATION.md).

The optional [local image service](LOCAL_IMAGES.md) documents worker isolation,
external profiles, GPU restoration and explicit recovery.

## Local foundation

`agentx.ps1` (Windows) and `agentx` (Linux) manage the same Compose definition.
`doctor`, `up`, `health`, `status`, `logs`, `rebuild` and `down` operate on the
selected project (`agentx` by default). `AGENTX_PROJECT_NAME` selects another
instance; its containers, network and volumes are isolated. Default volume names
remain `agentx_canonical_*`. `down` preserves data. `reset` has a project-specific
destructive confirmation.

Container output goes to Docker's `json-file` driver (`agentx logs`, `docker compose
logs`), bounded at three 10 MB files per service. Core, Benchmark and RAG also write
`error.log` and `combined.log` to their `*_logs` volume (`/app/logs`), rotated at five
5 MB files each. Core request logs record the path without its query string.

Default application ports: Core 3180, Benchmark 3181, RAG 3182, bound to 127.0.0.1.
MongoDB and Qdrant are internal. Browsers on a foreign site cannot read or mutate
AgentX APIs: Core, Benchmark, RAG and Data answer CORS only for the origins of
`CORE_PUBLIC_URL`, `BENCHMARK_PUBLIC_URL` and `RAG_PUBLIC_URL` (plus their loopback
variants), and refuse a non-GET request a browser marks `Sec-Fetch-Site: cross-site`
with 403. AgentX pages on other local ports are same-site; clients that send no
browser headers (harnesses, curl, service calls) are unaffected. The checked-in `config/agentx.env` contains only
generic defaults. `AGENTX_ENV_FILE` selects an external instance env file, and
shell variables override its values. `AGENTX_COMPOSE_OVERRIDE` optionally selects
one external Compose override for private mounts or additional service settings.
Launchers read ports and container IDs from Compose, including optional Data;
they do not execute an env file as shell code. Keep actual operator configuration
and secrets outside the checkout; never copy production volumes into Git.

### Settings catalog and Configuration view

`shared/envCatalog.json` lists every setting an instance can give the services.
It has two kinds of entries:
- variables `docker-compose.yml` forwards from the instance env file (`forwarded: true`, with their compose default);
- variables the code reads but compose does not forward, which only an instance override can set.

Each entry has a category, a secret flag and a purpose. `node scripts/env-catalog.cjs`
compares the catalog with compose and the code, and the shared test suite fails on drift. When
you add or remove a variable, run `node scripts/env-catalog.cjs --write`, then describe
each new forwarded entry.

The Nerve Center **Configuration** section (`GET /api/nerve-center/config-status`)
shows each setting per service with one of these states:
- *customized*: set, and different from its default;
- *default*: unset or equal to its default, so the default applies;
- *not configured*: unset with no default, so the option is off;
- *not reported*: the service does not report its environment. RAG and Data do not yet.

The default filter lists the forwarded options that are not configured, so an
opt-in feature is not forgotten. Core and Benchmark also log a one-line summary at
startup. Secret values are never shown, only whether they are set. The view is
read-only: edit the instance env file, then recreate the service.

The same launcher is the deployment path: select a reviewed checkout and external
instance configuration, then run `./agentx up --build` (or `./agentx.ps1 up --build`).
It waits for container and published HTTP health. Builds receive the Git revision,
with a dirty suffix when appropriate, unless the operator supplies an explicit
build revision. This checkout has no automatic production pull/deploy scheduler.
Configure [private LAN access](PARENTAL_ACCESS.md) at the HTTPS gateway. Human
interfaces and APIs require no account or code; the network is their boundary.

### Conversation context and performance

**Contexte et performance** edits optional work without recreating Core. Each
interface has an independent persisted preference scope:

| Interface | Entry | Optional work |
| --- | --- | --- |
| Playground | Conversation header | Profile and model history; its existing precision controls hold RAG, web search, thinking and model parameters. |
| PsyX | Conversation header | Context sources, automatic recommendations, deep replies, recap drafts, review and dream availability, timing and dream sources. |
| Nestor | Private conversation settings | Core history, selected notes, confirmed point, approved documents, family context, review advice, recap drafts and background review with its delay. |
| Famille | Performance settings in Nestor's private parental space | Separate Core history, notes, approved documents, routines, review advice and background review with its delay. |

**Allégé** disables the applicable optional switches; **Par défaut** removes
saved overrides. Both are drafts until **Enregistrer les réglages**. Concurrent
editors receive a conflict and can reload. Current instance environment values
supply initial defaults; stored overrides survive restarts. A disabled context
source stays stored, but is omitted from subsequent model context. A disabled
background feature stops scheduling new inference and invalidates obsolete
results; an already admitted PsyX inference settles normally. Access checks,
transcript integrity and deterministic crisis protections stay active. A recap
can still be written manually with its model-generated proposal disabled.
Native OpenClaw history, memory and tools are configured in OpenClaw; the panel
links to that interface and the Nerve Center's model/routing settings.

### Bounded maintenance actions

`./agentx action <name>` runs one action from a closed list on a running
instance, never a free shell. It reads the instance from `AGENTX_ENV_FILE`,
`AGENTX_PROJECT_NAME` and `AGENTX_COMPOSE_OVERRIDE` and refuses to guess them.
A mutating action also needs `AGENTX_LEAD_FILE`, the instance's `LEAD.md`
coordination file, and `--actor <who>`: it takes that lease, refuses while
another operator holds it, releases it with a note, and prints a JSON receipt
(`agentx.maintenance-action/v1`), also written to `AGENTX_ACTION_RECEIPTS_DIR`
when set. Exit codes: 0 completed, 1 failed, 2 usage, 3 unknown (a dispatched
Benchmark launch not yet reconciled), 4 refused (held, busy or not admitted).

| Action | Effect |
|---|---|
| `status` | Read-only: checkout revision, revision served by Core, Benchmark, RAG and Data, active coordination, lease holder, running deploys. |
| `lease --actor <who> --claim <purpose>` | Takes the configured `AGENTX_LEAD_FILE` only when free and keeps it held after the command. The actor is a stable session identifier. |
| `lease --actor <same-who> --release <summary>` | Releases only that actor's current lease, records its summary and preserves every earlier note. Another holder or a free lease refuses. |
| `deploy --services core,benchmark[,...] [--revision origin/main] [--wait-minutes 10] [--queue-minutes 0]` | Deploys take turns, and one deploy carries every commit merged before it fetched. A held `LEAD.md` or a running deploy refuses at once, or is waited for up to `--queue-minutes`, checked every 10 s. Before taking the lease the action looks at what is served. A service is up to date when it reports the revision, a descendant, or a commit with the same build (nothing its Dockerfile copies, the Dockerfile, the compose file or `.dockerignore` differs), from a container created after the instance env file and override last changed; a service that reports no revision (`benchmark-runner`) never is. When every requested service is up to date and the checkout holds the revision, the action completes with `alreadyServed: true`, without the lease, a build or a recreate; a queued action leaves that way as soon as the deploy ahead of it serves its revision. Otherwise the action takes the lease and needs a clean tree, a revision on `origin/main` and a fast-forward of the checkout; fast-forwards to `origin/main` as fetched at that moment and, when a merge of docs, integrations or another service left every requested image unchanged, completes there with `alreadyServed: true`; otherwise it builds the images first (building touches no running container), then waits for the instance to be idle and recreates with `./agentx up --no-deps`, without rebuilding, through Core's runtime lease. Automated inferences start again within seconds, so a lease refusal is retried every 10 s until a gap appears; `--wait-minutes` bounds the idle wait and the retries together, after which the action stops refused (exit 4) with the images built and the checkout already on the new revision. Any other launcher failure stops at once. Nothing running is cut; it then reads each service's `/health` every 2 s, for up to 60 s, until all report the revision. A service that still reports another revision, or does not answer, fails the action with that last reading. |
| `recover-quarantine --host <ollama url>` | For an UNKNOWN inference on a local Ollama: refuses while an inference or a workload is active there, restarts the unit named for that host in `AGENTX_ACTION_OLLAMA_UNITS` (`{"<url>": {"unit": "...", "scope": "system"\|"user"}}`, `sudo -n` for system units), checks a new process answers, then attests each UNKNOWN admission with `recover-runtime-restart`. Workloads keep the profiler procedure below. |
| `recalibrate-judges [--host <url> --model <name>]` | Runs Benchmark's quick judge calibration (the default judge when no target is given) and returns its report. |
| `benchmark-batch-prepare --host <ollama url> --model <name> --categories coding,agent [--levels 1,2,3,4,5] [--repeats 1-5] [--judge-host <url> --judge-model <name>] [--name <run name>] [--tag <tag>]` | Starts nothing and takes no lease. Checks the request against Benchmark as it is now and records a plan: see "Benchmark batches from an action" below. |
| `benchmark-batch-start --plan <reference>` | Starts exactly the prepared plan, once, under the lease, and returns Benchmark's batch id. The lease is released when Benchmark has answered, not when the batch ends. |
| `benchmark-batch-status --id <batch id>` | Read-only, no actor, no lease, no receipt file: Benchmark's own record of a batch (state, tests planned, completed and failed, judging counters, mean score per category once judged). |

An instance can install a small wrapper that exports these variables, so an
operator session or agent calls a single command.
Lease changes serialize their read/write pair through a `LEAD.md.writer-lock`
sidecar. A leftover sidecar refuses further changes; verify that the exact
writer and its filesystem operation have stopped before operator recovery.
Age alone never authorizes takeover. Both lease commands return the normal
JSON action receipt and use the same configured path as deployment.
Coordination GETs may retry one dropped transport within their original
ten-second probe budget. They require a complete successful Core snapshot;
an unavailable or incomplete response never establishes idle state. This read
retry does not repeat a maintenance mutation.
The OpenClaw plugin `integrations/openclaw/agentx-maintenance` exposes status,
deployment, quarantine recovery, judge calibration and Benchmark batches to
configured operator agents as one tool, `agentx_maintenance_action`: no shell,
validated arguments, a closed subset of actions per agent, and the actor is
always `openclaw:<agent>`. A batch start passes the runtime's approval hook.
See its README for the configuration and for what local tests do not prove.

#### Benchmark batches from an action

The three batch actions cover one model on one registered local Ollama host:
prepare, start, read. Stopping or resuming a batch stays an operator route
(`POST /api/benchmark/batch/:id/stop`). They need `AGENTX_ACTION_RECEIPTS_DIR`:
each plan is one file under its `benchmark-batch/` directory.

- **Closed request.** Categories come from `shared/benchmarkCategories.js`,
  levels are 1 to 5 (all by default), repeats 1 to 5 (1 by default). The name is
  at most 60 characters and the tag 40. Any other option is a usage error:
  there is no request body, prompt text, judge prompt, `paid_approval`, harness
  target or `multi_judge`, and a model under Ollama's `cloud` tag is refused as
  candidate and as judge. `shared/benchmarkBatchPlan.cjs` holds this contract
  for the action and for the plugin.
- **Prepare.** The host, and the judge host when one is named, must be among
  the hosts of `GET /api/benchmark/judge/readiness`. Without a named judge the
  plan pins that route's `preferred_target`; with none ready it refuses. Fixed
  reads of each registered host's `/api/tags` verify installed model identities
  and reject `remote_host`/`remote_model` aliases before any preflight probe. The
  categories are resolved to `prompt_ids` from `GET /api/benchmark/prompts`; a
  category with no prompt at the chosen levels, or more than 100 prompts,
  refuses. `POST /api/benchmark/preflight` then gives Benchmark's verdict on the
  installed model, the judge and the prompts. Its warnings also name the
  pinned models the batch affects: an execution host's are unloaded and
  restored after it; a separate judge host's keep serving, since the batch
  holds that host as shared and takes no claim on it. A candidate pinned at a
  context wider than its profile verifies is refused by preflight with the
  launch's own message (`Context <n> is not verified ...`). The action then
  reads `GET /api/benchmark/coverage/execution-config` and prepares the batch
  with the coverage job's settings for that pair: the verified context
  (`force_num_ctx`), no thinking, the answer budget and the per-test timeout
  the job would use. The plan says so in `context` (`pinned`, `verified`) and
  in its first warning. A pair outside the coverage scope, or without a
  verified context, keeps the refusal. The receipt carries the plan
  reference, the exact launch body, the projection (prompts, repeats, tests,
  prompts per category) and the `start` object that names the plan.
- **Plan identity.** A reference is `bp-<id>-<digest>`; the digest covers the
  id and every request value, including the pinned judge. A start may restate
  the values (the plugin always does): values that do not reproduce the digest
  are a usage error, as is a plan file that no longer matches its reference.
- **Start.** Under the lease, the action reads the same three routes again. A
  launch body that differs from the prepared one refuses with `PLAN_STALE`. It
  then marks the plan dispatched and sends one `POST /api/benchmark/batch`.
  Benchmark's own launch rules decide. A success returns `batchId` and
  `totalTests`. A 409 or 423 is a refusal with `verdict: conflict`; a 400, 422
  or 503 error is a refusal with `verdict: not-admitted`. The exact pre-insert
  errors `WORKLOAD_ADMISSION_REJECTED`, `WORKLOAD_ADMISSION_CONFLICT` and
  `WORKLOAD_RECOVERY_ARM_REJECTED` are also refusals, even when returned as 500.
  Core's own refusal to admit the workload (another workload or a maintenance
  lease holds a host) is a 409 with `WORKLOAD_ADMISSION_REJECTED`.
  These verdicts carry Benchmark's
  answer. The plan can be started again only when Benchmark also lists no batch
  for it (`planStartable: true`).
- **Unknown.** A lost connection, a timeout or any other answer, including a
  500 not identified as a pre-insert refusal, leaves the launch unknown (exit 3).
  A dispatched plan is never posted again. The launched
  batch carries the tag `agentx-plan-<id>`, so the same start run again looks it
  up with `GET /api/benchmark/batches?tag=`: one batch found completes with
  `recovered: true` and its id; none found stays unknown. An unknown plan is
  held until reconciled. Do not prepare a replacement launch to work around an
  unknown outcome: admission alone cannot prevent a duplicate after the first
  batch finishes. If an error response accompanies a stored batch, its ID and
  original error remain explicit and execution stays unknown even on replay;
  a running row does not prove admission hand-off succeeded. A plan already
  confirmed launched replays its batch id without a request.
- **What tests prove.** The action tests run against a loopback stand-in for
  these routes. They do not run Benchmark, Ollama or a judge.

### Benchmark batch launch contract

`POST /api/benchmark/batch` (route `benchmark/routes/benchmark/coreBatchLaunch.js`)
starts a batch. The Benchmark page and the batch action both use it.

| Field | Rule |
|---|---|
| `targets`, or `host` + `models` | Required. `targets` are provider-neutral Benchmark targets; `host` and `models` name Ollama models on one host. At most 50 targets. A local host must be a configured host that answers its inventory with every model installed (422 otherwise). |
| `levels` | Required array, at most 5 values from 1 to 5. With `prompt_ids`, the stored levels are those of the selected prompts. |
| `prompt_ids` | Optional, at most 100 prompt ids. This is how categories are chosen: the route has no category field. Unknown ids give 422. Without it, every prompt of the levels runs, sampled by `depth_config` when given. |
| `judge_config` | Optional. `host` and `model` go together and name a configured host with that model installed; without them Benchmark takes the selected ready judge. No ready judge gives 503 `JUDGE_NOT_READY`. Tuning fields: `temperature`, `num_predict` (safe integer, at least 100), `num_ctx`, `max_retries`, `timeout` (integer milliseconds, 5,000–2,147,483,647), `voting_count`; values above 4,096 tokens or 120 s are kept and listed in `data.warnings`. `think` is false unless the operator sets `true`: the judge then reasons before each verdict, the launch warns that reasoning shares `num_predict` with the verdict, and the results form their own quality cohort. A `target` of kind `harness` selects an isolated-model harness judge. |
| `execution_config` | Optional. `repeats` (1 to 5), timeouts, `think` and `response_mode` within the route's bounds. |
| `multi_judge` | Optional rule (`off`, `l4l5`, `low_confidence`, `always`) or object. Absent means off. |
| `run_name`, `description`, `tags` | Optional: 200 and 2000 characters, 20 tags of 50 characters. `GET /api/benchmark/batches?tag=` filters on one tag. |
| `execution_mode`, `depth_config`, `paid_approval` | Optional: `latency` (default) or `throughput`; prompt sampling; the approval a paid target needs. |

The route answers in this order: 400 for a malformed body, 422 for a target that
cannot be a candidate, 503 when no judge is ready, 422 for an unusable execution
host, 409 when a batch is already active (`active_batch`) or when the host is
profiling (`EXECUTION_HOST_PROFILING`), 422 when the judge model or the
preflight fails (`issues`, `preflight`). Creating the batch then takes Core's
workload admission; an error from that step carries its own status when it has
one and 500 otherwise, so a 500 does not say whether a batch exists. A success
returns `batch_id`, `total_tests`, the execution `plan` and the `preflight`
report. One batch is active at a time. The route has no request identity: a
caller that loses the answer must not post again, and finds its batch through
a tag it set.

### Moving an instance to a fresh source history

When a source repository starts a new history, do not merge the previous Git
history into it. Clone the new source into a separate clean checkout, select the
same external env/override and project name, and rebuild through the launcher.
Coordinate the deployment with the instance owner and preserve verified backups.
The existing Docker volumes and external configuration remain instance-owned.
Keep private sound packs in the external read-only mount described in
[installation](INSTALLATION.md#private-sound-packs). Old issue/PR references
belong to the prior private archive; reconcile active delivery references in
instance configuration before resuming an automated worker.

### Updating a running instance

Deployment is manual and triggered by the operator after a merge to `main`. The
source repository is public, so the host fetches it over HTTPS and holds no
GitHub credential. On the host, in the instance checkout (`origin` set to
`https://github.com/WindriderQc/AgentX.git`), with the tree clean and no build
running:

```bash
git fetch origin
git merge --ff-only origin/main
AGENTX_ENV_FILE=<instance.env> AGENTX_PROJECT_NAME=<project> \
AGENTX_COMPOSE_OVERRIDE=<instance.compose.json> ./agentx up --build --no-deps core
```

Rebuild only the services whose code changed (`core`, `benchmark` with
`benchmark-runner`, `rag`, `data`); `--no-deps` leaves the other containers
running. Always pass the instance's project name: without it the launcher uses
the default `agentx` project. When `up` or `rebuild` would recreate Core or
Benchmark on a running instance, Core decides from what that recreate would
cut, and the launcher prints its verdict:

- Core alone takes Core's `core-recreate` maintenance lease. A running Profiler
  workload does not block it: its writer is in Benchmark, it reaches Ollama
  directly, Core keeps its admission through the restart and Benchmark keeps
  heartbeating once Core answers again (it waits while Core is down, within the
  admission Core last confirmed). While the lease is held the profile keeps
  its own inference through Core, which drains admitted requests before it
  exits. Core inference, batches and judges (which go
  through Core inference), a workload in recovery or about to expire, and another
  maintenance lease block it.
- Benchmark alone (`benchmark`, `benchmark-runner`) owns every workload writer:
  it takes no lease (conversations go from Core to Ollama) and waits until Core
  reports no workload.
- Both, or every service when none is named, take the global `runtime-deploy`
  lease, refused while any workload or inference is active.

A refusal stops with exit code 4 without touching a container and names each
blocker (kind, id, hosts, owner, start, reason) with its clean cancel route:
the Profiler panel or `POST /api/profiler/pipeline/profile/:profileId/cancel`,
`POST /api/profiler/pipeline/profile-host/:queueId/cancel`,
`POST /api/profiler/hosts/test/run-fleet/:queueId/cancel` or
`POST /api/benchmark/batch/:id/stop` on Benchmark. Core serves the same verdict
at `/api/nerve-center/runtime-coordination/deploy-blockers?service=core|benchmark|all`.

When the only blockers are background inference (`inference-automated`, or
Core's own `watchdog-probe`), the launcher does not refuse at once. It posts a
drain request (`POST /api/nerve-center/runtime-coordination/drain`), which
`/runtime-coordination/active` reports as `drain`, and retries the lease for up
to `AGENTX_RUNTIME_LEASE_DRAIN_SECONDS` (120 by default, 0 disables the wait).
A resumable job that reads coordination before each unit, such as the Secretary
mail catch-up, pauses on it, so the launcher waits for at most the unit in
flight. The request is advisory, lives in the Core process and is withdrawn
when the wait ends. Interactive, benchmark and maintenance blockers refuse
immediately, as before.
The bounded action wrapper delegates a Core-only recreate to this launcher
gate, so back-to-back background calls cannot prevent the drain request from
being sent. Other or mixed service selections retain the full idle wait.

Images are built first (`up --build` included), so the lease, which keeps new
work out, covers only the recreate: it is heartbeated and released once health
is green. Recreating mid-batch would otherwise cut the workload and quarantine
its host for the rest of its admission. `--force-runtime` (or
`AGENTX_FORCE_RUNTIME=1`) skips the lease for an operator recovery only; with
Core not running, no lease is needed. A Core container that exists but does
not answer its health check makes the launcher stop (exit code 4), since
another recreate may be in progress. Recreate
Core or Benchmark on a running instance only through the launcher
(`./agentx rebuild --no-deps core` or `./agentx up --build --no-deps core`): a
direct `docker compose up` bypasses the lease. Still coordinate with other
operators of the instance. A new setting (for example
`PSYX_VOICE_MODE`) is added to the external env file by hand; code
deployment never changes instance configuration. The service `/health`
responses report the deployed `revision`.

Services rebuilt at different revisions of one product version read as mixed
builds on the home page, the Playground cockpit and the Nerve Center
Services / Build widget, which lists the revisions. That state is expected
after a partial deployment and raises no operational finding. Different product
versions or profiles, or a service that reports no identity, are a deployment
mismatch: service health is degraded and the finding names the cause.

### Code runner

Benchmark scores a coding prompt that carries `reference_tests` by running the
candidate's program instead of asking a judge to read it. The Compose project
includes `benchmark-runner` for that: a sidecar with no network, a read-only
image, a tmpfs scratch, one CPU, 512 MB, 128 processes, and jobs run as
`nobody`. It only sees the `benchmark_jobs` volume, where Benchmark writes a
job (interpreter, budgets, files) and reads the answer back (exit code, capped
output). The interpreters it can start are exactly `python3` and `node`.

`BENCHMARK_CODE_RUNNER` selects the mode on the Benchmark service: `volume`
(the Compose default) hands jobs to the sidecar; `local` runs the same executor
inside the Benchmark process and is refused when `NODE_ENV` is production;
`off` answers every job as unavailable. Without a runner, a coding response
with reference tests is not scored: the row asks for review instead of
carrying a penalty. Infrastructure is never recorded as a candidate failure.

After the first build of the sidecar on a host, check its isolation before
trusting executed scores: the `code runner started` line of
`docker compose logs benchmark-runner` must show `"root":true` (so jobs drop to
`run_as_uid`) and `"prlimit":true` (so per-job limits apply), and
`GET /api/benchmark/judge/readiness?refresh=1` must report `execution_scored`
as available. If either flag is false, jobs still run inside the container
limits but without the per-job uid drop or rlimits.

`npm run test:drivers --prefix benchmark` runs the tests that execute generated
drivers and the daemon with the local interpreters; CI runs it through
Benchmark's `test:surfaces`, and it takes a few seconds. The regular suite skips
them unless `BENCHMARK_DRIVER_SMOKE=1` is set.

## Tests

Run `npm run setup`, then `npm run test:prepare` and `npm test` at the root.
Core and Benchmark record completed launcher evidence under `test-results/`;
only a final zero exit code is a pass. RAG uses its existing Jest command.
Do not add forceExit to hide open resources or use application MongoDB for tests.
The disposable MongoDB binary is prepared locally. Tests do not prove inference
against real Ollama, Qdrant ingestion, browser rendering or device audio.

`npm run test:surfaces --prefix core` runs the portable Household tests, then
the root `test:integrations` and `test:shared` contract tests; CI includes them
in the existing Core job, which runs for changes under `shared/`, `scripts/` and
`skills/`. HTTP/Mongo surface integration tests
run in the normal Core suite. The Compose smoke uses the full profile to verify
the built-in Nestor page and family API inside the production image.

For a private repository, CI uses `AGENTX_CI_RUNNER` when set, otherwise
GitHub's `ubuntu-latest`. For a public repository, both jobs always use
`ubuntu-latest`, regardless of that variable. Detach private self-hosted runners
before publishing: an untrusted pull request can change the workflow itself.
See [GitHub's runner security guidance](https://docs.github.com/en/actions/reference/security/secure-use).
The self-hosted runner is installed
outside Git: a dedicated system user in the `docker` group (the Compose smoke
needs Docker), and a systemd drop-in that limits the runner to half the CPU
threads, `Nice=10`, idle IO and a memory cap, so it does not compete with
inference. If that host is off, unset the variable to fall back to GitHub.
Run the relevant tests locally before pushing: every push to a pull request
starts a run.

A pull request run tests only the services its files touch, and a merge starts
no run. `main` is therefore validated as a whole only by a manual run, in which
every job runs: `gh workflow run agentx-ci --ref main`. Start one after a batch
of merges and wait for its result before deploying.

## Optional surface integrations

Data is available through Compose profile `data`. Set `COMPOSE_PROFILES=data`
and `AGENTX_PROFILE=full`, then use the existing `up` command. Startup waits for
Data's Mongo-backed health endpoint too. The Core portal links to `/data-toolbox`;
the UI exposes read routes plus one write, naming a network device or marking it
known. Native collectors require explicit external
targets/roots. Background jobs are disabled unless
`DATA_BACKGROUND_JOBS_ENABLED=true`. The optional Obsidian inventory requires
an external `OBSIDIAN_VAULT_POLICY_PATH` and read-only mount. The historical
instance policy is intentionally not shipped. See [Data](../data/README.md).

Set `NETWORK_DEVICE_WATCH_MS` (for example `300000`) to let Core check the
network inventory and raise the `network-new-device` alert once per unknown
device. The first check accepts the current inventory as the baseline; name a
device or mark it known in the Data Toolbox to acknowledge it. The rule
targets `telegram`, so the operations relay delivers it when configured. The
alert carries a guess of what the device is and a suggested name, asked from
the `ops_watch` task's model with the vendor, hostname and address; it is a
hint, never applied by itself, and a missing answer never delays the alert
beyond three minutes.

Switch the operations watch on in the Nerve Center, section "Operations
watch", which also shows the latest report, checks on demand and sets the
interval and the report language. Core stores these settings; `OPS_WATCH_MS`
and `OPS_WATCH_LANGUAGE` apply only until they are saved there. Core takes what its rules already flag (the ecosystem snapshot's operational
issues and the active alerts) and asks the `ops_watch` task's model for one
short report: findings by severity, impact, next action. The model runs only
when the set of findings changes, never decides what is wrong, and cannot hide
a finding: when it is unavailable the report carries the plain list. Each
distinct set of findings is one `ops-watch-report` incident (`telegram`), which
resolves once the findings are gone; `GET /api/nerve-center/ops-watch` returns
the latest report and the settings. The input is small
and nothing waits on the answer, so route `ops_watch` to a CPU-resident host in
the Nerve Center routing table. Any task routed to a CPU-resident host stays on
that host (the table shows "Stays on this host"): each CPU instance is a lane
filled on purpose, so two background tasks routed to two CPU hosts never end up
on the same one. A task routed to a GPU host may follow its model to another
GPU host, never to a host of the other residency.

`config/obsidian-vault/` holds generic household note templates (appliance,
routine, recipe, procedure) and `Maison.base`, an Obsidian Base listing
appliances with their warranty dates, routines and recipes under
`Docs/Maison`. Copy `Templates/` beside the documents folder, not inside it, so
templates are never ingested; point Obsidian's Templates plugin at it. Note
properties such as `garantie_fin` are indexed with the note's first chunk.

Data classifies shared-drive files by directory role (backups, install media,
mail stores, source trees, games, models…). A deployment whose share uses other
folder names lists them in an out-of-Git JSON file kept in the instance
directory, named by `DATA_PATH_ROLE_ALIASES_FILE` and mounted read-only into
the Data container. Shape: `{ "version": 1, "roles": { "BACKUP_DIR":
["nas-mirror"], "MAIL_DIR": ["re:archive-\\d+"] } }`. Keys are the role sets
in `data/utils/fileMetadataRoles.js`; each entry is matched as whole path
segments (a literal may contain `/`), case-insensitively, as a literal unless
prefixed `re:`; at most 200 entries per role and 64 characters each. When the
variable is unset the file is never read. An unreadable or invalid file logs
one warning naming the file and the problem, and Data runs with the built-in
roles only. No sample with real folder names is shipped.

Live GPU values (Nerve Center cluster cards, Profiler hardware evidence) come
from `integrations/data-collectors/gpu-agent.js`, a native process on the Core
host: Data publishes only on loopback, so the collector runs beside it and
reaches the GPU hosts itself. Each cycle runs
`nvidia-smi --query-gpu=... --format=csv,noheader,nounits` read-only, locally
for `"local": true` hosts and over `ssh -o BatchMode=yes -o ConnectTimeout=5`
for the others, all hosts in parallel with a per-host timeout, and posts the
results to `/api/v1/hardware/samples`. Nothing is installed on a GPU host.

1. Authorize the collector user's SSH key on every remote GPU host and record
   their host keys in its `known_hosts`: batch mode never prompts, so a missing
   key or unknown host key is reported as that host's error. A Windows host
   without an authorized key is unsupported; it stays "not collected".
2. Copy `gpu-hosts.example.json` outside Git and list the hosts:
   `[{"id":"gpu-a","name":"GPU A","ssh":"user@gpu-a","ollamaUrl":"http://gpu-a:11434"},{"id":"core","local":true}]`.
   Optional per host: `sshPort`, `nvidiaSmi` (executable path), and
   `ollamaService` (below). `ollamaUrl` must equal the Ollama URL Core and
   Benchmark use for that host: it is how they find the host's GPUs.
3. Copy `gpu-agent.env.example` (set `DATA_URL=http://127.0.0.1:<DATA_PORT>`)
   and `gpu-agent.service.example` into the user's systemd directory, then
   enable the unit. `GPU_AGENT_HOSTS_JSON` may replace the file.
   `GPU_AGENT_INTERVAL_MS` (default 30 s, 5 s to 10 min) and
   `GPU_AGENT_HOST_TIMEOUT_MS` (default 10 s) bound the work.
4. Check once with `GPU_AGENT_ONCE=1 node gpu-agent.js` (non-zero exit when a
   host or the post failed), then
   `node integrations/operations/verify-native-data-collectors.js --expect-gpu <GPU_AGENT_ID>`.

Below the cluster cards, the Nerve Center shows GPU occupancy over a window
(1 h, 6 h, 24 h, 7 d or 30 d) from the same samples
(`GET /api/nerve-center/inference/gpu-occupancy?window=`, read from Data's
`/api/v1/hardware/occupancy`). For each physical GPU it gives the busy share
(utilization of at least 10 %, or `busyAtPct=`), mean utilization, VRAM used
p95 and maximum against the total, mean and p95 power against the limit, the
throttled share, and the sample count with its coverage of the window. Every
share is of the time samples cover: a stretch without samples (collector or
host down, Data unreachable) is reported as missing, never as idle. Each
collector host names the configured Ollama hosts it matches by `ollamaUrl`.
When `AGENTX_RUNTIME_RESOURCES_JSON` is set, a GPU is linked to its physical
resource, and so to every endpoint that uses it (Ollama, voice, images), when
the resource `id` is the GPU's UUID or PCI bus id as `nvidia-smi` reports them,
or when the resource lists the Ollama URL of a collector host that has a single
GPU. Resources linked to no sampled GPU are named; on a host with several GPUs,
name each resource after its GPU's UUID to link it, changing the map only as
[Physical GPU admission](#physical-gpu-admission) requires.

Some Ollama behaviour is set by the server's environment, not by a request:
the KV cache type, flash attention, parallel requests, resident model slots,
GPU spreading and visible devices. Name a host's Ollama service with
`ollamaService` and the collector also reads these settings, read-only, every
`GPU_AGENT_OLLAMA_ENV_INTERVAL_MS` (default 10 min, 1 min to 24 h):

- a systemd unit name, such as `"ollama.service"` or `"ollama-cpu.service"`:
  `systemctl show <unit>` with the unit's `Environment`, load and active state,
  main-process start time, `NeedDaemonReload` and whether it also reads an
  `EnvironmentFile`. A user that is not root can run it.
- `"windows"`: `reg query` of the machine environment, then of the SSH user's
  environment (the user's values win). The SSH user should be the one running
  Ollama.

Only `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_FLASH_ATTENTION`, `OLLAMA_NUM_PARALLEL`,
`OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_MAX_QUEUE`, `OLLAMA_SCHED_SPREAD`,
`OLLAMA_KEEP_ALIVE`, `OLLAMA_CONTEXT_LENGTH`, `OLLAMA_GPU_OVERHEAD`,
`OLLAMA_LLM_LIBRARY`, `OLLAMA_VULKAN` and `CUDA_VISIBLE_DEVICES` are kept, with
plain values of at most 64 characters (`shared/ollamaServiceEnvironment.js`);
every other variable is discarded where it is read. A listed key with an
unexpected value is reported by name only. An unset key means Ollama's
default. What is observed is the configuration: a systemd unit shows what
systemd has loaded, values in an `EnvironmentFile` are not seen, and a service
not restarted since a change still runs the previous values (compare the
start time). Data keeps the latest observation per host; a cycle without a
fresh read leaves it unchanged, and a failed read is stored as that
observation's error.

Core's Nerve Center reads `/api/v1/hardware/latest` through `DATAAPI_BASE_URL`
and shows a fresh sample's values with its age; a stale, failing or uncollected
host shows that state instead of numbers. A host card also shows the latest
Ollama server settings the collector read, with their source and age, whatever
the GPU sample's freshness: an unset key reads as Ollama's default (`f16` for
the KV cache), and a failed read says so instead of showing defaults. Benchmark reads the same projection
(its `DATAAPI_BASE_URL`, default `http://data:3083` in Compose) to fill
`agentx.profiler-hardware-collector/v1`. When it resolves an artifact's
identity (at most every 5 minutes per host), it records on the host profile
the settings that change what a profile measures: KV cache type, flash
attention, `CUDA_VISIBLE_DEVICES`, `OLLAMA_SCHED_SPREAD` and the GPU count
Ollama sees. Fresh hardware samples also retain every GPU's identity and VRAM
on the host profile, alongside the legacy aggregate GPU field. Inventory order,
utilization and sample time do not change the identity; replacing either GPU does.
The inventory describes the machine; the observed visible-device setting describes
which devices the endpoint can use. A stale or failed sample preserves the last
observed inventory. The collector does not observe the runtime's actual split mode;
spreading settings alone do not establish placement. These facts become part of
the runtime fingerprint, so a profile,
context result or benchmark qualification measured under other settings
stops matching, and preflight or a sweep asks to profile the host again. Only
a successful observation changes them, and none while the unit waits for
`daemon-reload`; a host never observed keeps the fingerprint it had. A
retired host-report agent still
running on a GPU host is removed by hand on that host; Core has no
host-report route.

Data's existing suites, real Mongo index regression and HTTP capability smoke
run through `npm test --prefix data` with a launcher-owned disposable MongoDB.
The existing service CI matrix and Compose smoke cover the optional Data image.

Agents file Markdown notes into the owner's Obsidian vault inbox when Core's
`VAULT_INBOX_PATH` names an absolute directory, mounted read-write through the
instance Compose override; unset, the capability answers "not configured".
External agents use the `write_vault_note` tool on `/mcp`; Nestor uses the
`vault_note` OpenClaw tool, backed by `/api/consumers/nestor/v1/vault/notes`.
Notes are named `YYYY-MM-DD Title.md`, carry `author`, `created` and
`status: inbox` frontmatter, and never overwrite an existing file. Keep the
inbox outside approved ingestion roots (e.g. `RAG/Inbox` beside `RAG/Docs`):
moving a note into the documents folder is the owner's approval.

External agents reach the owner's durable memory through the same `/mcp`
endpoint, available through the private LAN gateway or trusted loopback/Docker
callers: `memory_search` searches the
owner's personal notes and `memory_remember` saves or corrects one fact,
preference or decision. They use the store Nestor and the memory editor use,
labelled owner/private, refuse secret-like text and record `mcp-agent` as the
source of new notes. They never read or write family notes. Infrastructure
knowledge belongs in the docs or a vault note, not in owner memory; RAG
documents are searched with `rag_search`.

The same endpoint lets a lead agent supervise Benchmark's coverage without
running it. `benchmark_coverage` reads the matrix (profile state and catalog
prompts scored for each model pinned or routed on a host) and what the
automatic measurement job is waiting for. `benchmark_results` reads the recent
scores, speeds and judge failures of one pair, never the answer text.
`benchmark_request_measurement` asks for a pair to be measured before the
others, with a reason and a priority, or withdraws the request. A request only
reorders the queue: Benchmark starts the measurement itself, in its quiet
hours, when the runtime is idle. The agent chooses what, Benchmark chooses
when.

The personal finance capability is described for a new maintainer in
[FINANCE.md](FINANCE.md). The personal finance ledger ingests bank and credit-card statements dropped in
`FINANCE_INBOX_PATH`. Core reads the PDF text layer (`pdftotext -layout`), a
local model returns the accounts and rows as JSON (a PDF with almost no text
layer is a scan: each page is rendered at 200 dpi and read by the vision model
one page at a time), and a statement is accepted
only when every account reconciles to the cent, including each printed running
balance; on a mismatch the model gets the failing row and retries
(`FINANCE_EXTRACTION_RETRIES`, default 3, at most 5). Accepted files move to `FINANCE_ARCHIVE_PATH/<year>/` and write
`finance_statements` / `finance_transactions`; others move to
`FINANCE_REVIEW_PATH` (default `<inbox>/a-verifier`) and write no transaction.
Statements dropped in `<inbox>/corp/` go to a separate corporate ledger
(`ledger: corp`, archived under `<archive>/corp/<year>/`); every finance query takes
`ledger=corp`, and the plan, simulations and alerts stay personal.
A busy inference host leaves the file for the next scan
(`FINANCE_INBOX_POLL_MS`, default 15 minutes). `FINANCE_EXTRACTION_MODEL` pins
a model; otherwise the `analysis` route applies. The three paths must be
absolute and mounted through the instance Compose override; the inbox stays
off otherwise. Keep them outside every approved RAG ingestion root: owner RAG
search has no exclusion filter. `/api/finance` (statements, balances,
transactions, monthly summary, top outgoing descriptions, inbox status and
scan) and the `/finance` page (balances, monthly in/out, where the money goes,
a "how much at…" search and statement status) use the private LAN HTTPS entry without a code. The network boundary is
responsible for human access.
Transactions get a category from a fixed list and free tags through rules the
owner teaches (`/api/finance/rules`: description contains a pattern, the longest
pattern wins); rules apply to past and future rows, and `/api/finance/uncategorized`
lists what is left, largest amounts first. The category "Virements internes"
can be excluded from every summary so transfers between the owner's accounts
are not counted twice. `/api/finance/summary/yearly` totals each calendar year
(multi-year questions by tag, category or search), `/api/finance/insights`
computes the advice material (monthly savings rate, stable recurring charges,
category trends, large recent expenses) and `/api/finance/export.csv` exports
the filtered transactions with their totals for a spreadsheet.
Deterministic alerts are recomputed after each scan that ingests something and
on `GET /api/finance/alerts`: statement to review, no statement for
`FINANCE_ALERT_STALE_DAYS` (45), balance of `FINANCE_ALERT_MIN_BALANCE_ACCOUNTS`
(EOP) under `FINANCE_ALERT_MIN_BALANCE_CENTS` (off when unset), expense over
`FINANCE_ALERT_LARGE_EXPENSE_CENTS` (1 000 $) in the last 45 days, new stable
recurring charge, and a category up 50 % and `FINANCE_ALERT_CATEGORY_SPIKE_CENTS`
(100 $) a month. Each fact is raised once; `POST /api/finance/alerts/report`
returns the pending alerts and marks them reported for a delivery job.
The OpenClaw finance agent (`comptable`) reads it through the `finance_ledger` tool of the
`integrations/openclaw/finance-ledger` plugin (loopback Core URL, visible only
to the configured finance agent); amounts arrive as cents plus a formatted
string so the model never converts or sums them. `finance_categorize` saves
rules the owner confirmed in the conversation; `finance_plan` applies the
owner's explicit changes to the Core plan. `finance_alerts` can mark alerts
reported in an authorized delivery workflow. These bounded Core writes grant
no financial transaction, workbook edit or general filesystem permission.

Full profile serves `/dad`, `/panel`, `/kids/sounds` and `/lecture`. The normal
Core inference configuration is sufficient for text conversation. OpenClaw needs
explicit `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN` in the instance;
`HOUSEHOLD_CONVERSATION_BACKEND` accepts auto, agentx or openclaw. Auto selects
OpenClaw only when both values exist. Do not copy runtime credentials into Git.

`HOUSEHOLD_FAMILY_CONVERSATION_BACKEND` optionally gives Family its own engine:
`agentx` (Core inference) or `openclaw`. When set, every new child-safe
conversation (Famille, Kids Room, Lecture and native Family voice) uses it,
whatever the page requested; unset, or any other value, leaves
`HOUSEHOLD_CONVERSATION_BACKEND` in charge. It is read when a conversation is
created: an existing conversation keeps its engine, so changing the setting
never replays a turn on the other one. Super Dad and LLMx scene conversations
are unaffected. On `agentx` a family turn has no native agent tools; routines,
idea and reminder capture, the math picture and animal sounds come from Core
and work on both engines.

`HOUSEHOLD_VOICE_TASK` names the router task of a spoken turn on Core inference
(the `agentx` engine), in any pack; the default is `voice_persona_chat`. Typed
turns and LLMx scenes keep their pack's task (`general_chat`,
`nestor_answer_light`, `voice_persona_reader`). Assign that task's model and
host in the router like any other task; the reply still streams and thinking
stays off.

`HOUSEHOLD_VOICE_MODEL` optionally selects a native `provider/model` per run for
personal Nestor voice on the main agent. The agent, session history, selected
notes and tools stay the same. Blank preserves native model policy. Explicit
Open selection, text conversation, specialist agents and family conversations
retain their existing model choice. Set this only after qualifying the selected
model's conversation continuity and tools; it is not a reasoning-quality guarantee.

Every turn, on both engines, carries what was selected for it (notes, household
members, approved knowledge, routines, save receipts, the sound note, the reply
language, a team member's last exchange and the reviewer's advice) as labelled
reference data beside the request. With the same pack, mode and personality,
the system message and native instructions keep a stable prefix. This supports
prompt reuse; history reconstruction, runner options and competing callers can
still prevent a cache hit. LLMx scene instructions remain variable. Core's
canonical transcript contains the submitted user text only. See
[voice qualification](AGENTS_AND_VOICE.md#measure-the-path-that-the-person-experiences).

`HOUSEHOLD_PERSONA_VOICES` optionally gives personas an instance voice without
editing the shared catalog: a JSON object maps a persona id, or `"*"` for every
persona, to `provider|voice` (`kokoro`, `windows_sapi` or `voxcpm`), for example
a VoxCPM2 voice cloned on the voice host. A voice saved through Agent Ops › Team
outranks this map; an explicit browser voice selection wins over both. Catalog
snapshots carry the effective voice, and server replies resolve the instance map
again for each reply. Invalid map entries keep the catalog voice. See
[personality selection and authoring](AGENTS_AND_VOICE.md#personality-selection-and-attribution).
Kids Room and Lecture create their conversation with the Nestor personality and
read replies through the same voice ladder, so Nestor's instance voice applies
there too; the reading voice chosen on that browser ("Voix des lectures") wins.
On the Household browser conversation page (Super Dad or Famille), replies use
`core/public/js/voice/speech-ladder.js`: the selected voice, the personality's
presentation voice, its declared catalog fallback when present, then the
browser's own speech where permitted. Duplicate choices are skipped, and a
rejected synthesis request advances to the next rung. A failure after the stream
starts permits one clause retry below the failed voice, at most once per turn.
Interruption never starts that retry. The reply can remain unspoken if every
voice fails. Server replies
do not use browser `speechSynthesis`. PsyX uses its
protected chosen-voice route without a device voice fallback. See
[shared speech behavior](AGENTS_AND_VOICE.md#shared-speech-behavior).

`HOUSEHOLD_TEAM_MEMBERS` optionally lets the owner address a team member
directly in Super Dad: a JSON object maps an OpenClaw agent id to the names it
answers to. A personal turn that starts with that name, or asks to "ask" or
"demande à" it, runs in that agent's own native session (its model, tools and
memory; the conversation agent's session key is never replaced), shows its name
on the reply and speaks with the catalog personality that declares the agent.
The next turn returns to the conversation's agent, which receives that exchange
once as reference data. Family turns never use it.

In a spoken conversation the page says the handoff at once ("Je passe ta
question à …"). Speaking again while the member works does not cancel it: the
member's turn detaches, the conversation's agent takes the new turn and is told
the member is still working, and the member's reply is recorded as usual and
said at the next pause (`GET /private/sessions/:id/member-reply`). A member
already working is not asked a second question; the conversation's agent
answers and says so. Only a stop (the spoken stop or the stop control) cancels
a member, in flight or in the background. Detached work lives in Core's memory:
a page that never collects the reply still finds it in the history, and the
conversation's agent receives it as reference data on its next turn.

With `HOUSEHOLD_VOICE_WARMUP=true` (off by default: its first real use was
followed by a turn that produced no deliverable text, and that link is not
ruled out), a new spoken personal conversation warms its own prompt while the page speaks
its greeting (`POST /private/sessions/:id/warm`). A model with sliding-window
attention resumes its prompt cache only near the end of the previous prompt,
and a new native session changes a late section of the agent's system prompt,
so the first spoken turn used to read the whole prompt again. Core runs one
small turn in the conversation's native session, with the instructions of an
ordinary spoken turn: it tells the agent that it has just greeted the owner, and
the first real turn then only appends to a cached prompt. The warm-up is not a
turn of the conversation (nothing recorded, spoken or shown), never runs once
someone has spoken, ends after 60 s at most, and a failure is only a warning.
Any other call to the same model before the first turn takes the cache back.

Live voice transcribes through VoiX. `HOUSEHOLD_BROWSER_STT_FALLBACK` optionally
lets Super Dad (`personal`) or both spaces (`true`) fall back to the browser's own
speech recognition when VoiX is unreachable (transcription 502/503/504, a network
error, or `/api/voix/health` down at start). The default `false` hides it: in
Chrome and Edge that recognition sends the microphone audio to the browser
vendor's cloud service, which breaks the local-only default. Even when allowed it
never starts on its own: the page shows a French notice with that warning and a
button, the choice is remembered per space in that browser and revocable under
Réglages › Écoute, and a banner stays visible while it is in use. The recognizer
only replaces transcription; wake word, Stop, echo and interruption handling are
unchanged. Leave it `false` or `personal` when the family space must stay local.

VoiX requires `VOIX_BASE_URL` for speech and native devices. `DATAAPI_BASE_URL` is optional. Email actions require
`LEANTIME_BASE_URL`, `LEANTIME_API_KEY`, `LEANTIME_EMAIL_ACTION_PROJECT_ID` and
`LEANTIME_EMAIL_ACTION_USER_ID`; no owner project/user IDs are shipped.
Provide these through external runtime configuration/Compose overrides.
`VOIX_FALLBACK_URL` optionally names a backup VoiX for the shared Core stateless
voice routes used by Household and PsyX (when PsyX uses the same primary):
transcription, synthesis (whole and streamed), the voice catalog and the player
script. Core probes `VOIX_BASE_URL/health` every 15 s with a 1.5 s timeout and
uses the backup while the probe fails. A primary network error or 502/503/504 is retried
once on the backup; a 4xx is not. Answers carry `X-Voix-Upstream: primary|fallback`,
`GET /api/voix/upstream` reports the active upstream, and the conversation page
shows "Voix de secours (serveur principal indisponible) : réponses plus lentes."
while the backup answers. Caller disconnects cancel transcription and synthesis;
no backup starts after cancellation. Deadlines cover body reads; both surfaces
reject a synthesis error event before streaming audio.
The optional [spoken-controls adapter](../integrations/voix/README.md) adds local
Stop/silence recognition on the same VoiX process before Whisper transcription.
`VOIX_SPOKEN_CONTROLS_ENABLED=true` selects that shared upload endpoint for Household and PsyX only after the
instance installs and qualifies its model. False preserves ordinary transcription.
In Nestor browser replies, energy is not speech: a sound the microphone hears
over a reply is a candidate, and the reply keeps playing. A candidate that goes
on for 0.8 s is recognized as far as it was heard, and every candidate is
recognized when it ends. Words hold the reply, reversibly, until the whole
utterance is recognized; confirmed speech or a Stop control then cancels the old
turn before another starts, and anything else resumes the remaining audio. A
click, a keyboard or a door never pauses a reply. A reply that has not started
yet waits for a candidate to be recognized, a moment, so it does not begin over
a person who is speaking.
When no reply text has arrived 3 s after a voice turn starts, Nestor says one short
holding phrase (« Un instant… ») and shows that it is still thinking; hearing that
phrase back is echo, not an interruption. Cancelling an OpenClaw turn before it
streamed content, a tool call or reasoning settles at once; after that, Core waits
for the run's native end and otherwise pauses the conversation with a French notice.
A native stream has 3 s to close after its matching completion row or after
Core reads its verified final answer. Core then delivers that answer or reports
that it could not retrieve it; the gateway has another 30 s to close HTTP.
GraphysX waits for its completion row, which carries the browser tool call,
before this grace applies. Silence without completion or readable final evidence
keeps the existing run deadline and does not establish native termination.
A successful observation that invalidates a final answer before Core accepts
its grace withdraws that deadline. A later verified answer receives a fresh
3 s grace; a matching native completion remains terminal. An invalidation read
after the grace has been accepted prevents answer delivery but does not reopen
the stream or withdraw its drain.
If the continuity endpoint cannot be read, Core retains final text already
verified for this run, with model/provider and tool evidence unavailable. A successful newer
observation invalidates or replaces that text; cancellation and late stream
row errors still prevent delivery. A partial native projection explicitly marked
`answerObservation.reason: read_failed` for the same session/run also preserves
only that verified text and its existing grace. Fresh run/tool receipts remain
visible, while the final model/provider stays unknown until a new verified answer
is read. The adapter emits this mark only when reading the transcript throws;
missing readers, malformed histories and successful non-final observations do
not qualify. Older projections or incompatible marks invalidate the retained
text. Core image actions keep their receipt
recovery path; GraphysX continues to require its completion row.
Each native continuity read has a 10 s timeout. The native adapter compares
tool arguments and results internally and projects only successful tool names
and confirmed repetitions for the same run. Four consecutive identical calls
with identical results stop the turn; native process and session waits are
excluded. Core reports an unsuccessful verification after confirmed termination,
or pauses while the stop remains unconfirmed. An explicit request to personal
Nestor on `main` to read or count tasks requires a successful task-list or personal-briefing result
from that run before Core delivers the answer. This check does not validate
every fact in general conversation and never replays the inference. Same-run
task proof survives a failed later read without restoring old model/run receipts.
The Super Dad and Famille avatar dock loads GraphysX's `<llmx-face>` module from
`HOUSEHOLD_AVATAR_MODULE_URL` (a GraphysX build's `/embed/llmx-face.js`). Core
relays it at `/api/household/avatar/llmx-face.js`, like the VoiX player, so the
page CSP stays `'self'`; without it the dock shows a 2D orb driven by the same
conversation signals.
Pictures beside Nestor come only from sources Core can resolve. `SEARXNG_URL`
enables internet image search (strict SafeSearch in Famille; the browser loads the
https image directly without a referrer). Household photos and media need both a
read-only mount and the Data file index: `HOUSEHOLD_PHOTOS_DIR` /
`HOUSEHOLD_MEDIA_DIR` are the host folders mounted at `/mnt/household/<source>`,
and `HOUSEHOLD_IMAGE_ROOTS_JSON` maps each source to the canonical root Data
indexes for it. A picture is found by file or folder name, so named folders work
better than camera names. `HOUSEHOLD_IMAGE_FAMILY_SOURCES` lists what Famille may
show (default all four). A picture the OpenClaw agent generates with its own image
tool (cited in its reply as `MEDIA:<path>`) is relayed from the Nestor plugin's
gateway route `/api/nestor/media`, which serves only image files inside OpenClaw's
media directory (`<state dir>/media`, or the plugin's `mediaRoot`); Core uses
`OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN` for it. Other `MEDIA:` files,
such as synthesized speech, keep their existing handling.
Super Dad accepts photos up to 50 MB. The model receives a JPEG copy within the
2 MB attachment limit (vision models downscale to about 1,000 pixels anyway).
When `IMAGE_ARCHIVE_DIR` names a writable directory in the Core container
(mount a host folder there through the instance Compose override), Core keeps
the original of every attached photo, and every generated picture it relays, at
full quality: `<origin>/<year>/<month>/<sha256>.<ext>` with a JSON sidecar
(`origin` is `uploaded` or `generated`). The same image is stored once. The
archive is independent of conversations: forgetting a conversation does not
delete its archived images. Unset, nothing is archived and photos are still
reduced for the model.
The private parent journal lists, under each child-safe turn, what reached the
child's screen: each block with its title and a short preview, every picture
with its source and a thumbnail, whether a math picture was drawn in 3D, and
only the fact that a secret was shown.
Opening Super Dad on any device offers to resume its latest conversation when
the last exchange is less than 24 hours old; the conversation, its history and
attachments come from Core, not from the browser. Famille does not offer it.
Opening a saved conversation, from that offer or from the recent list, starts
listening again by itself on a device whose microphone is already granted, in
standby when the wake word is required; elsewhere the conversation opens with
the microphone off and Reprendre asks for it.
Famille keeps the Nestor personality but replaces its adult temperament with a
playful, curious tone for children (`FAMILY_TONE` in
`core/surfaces/household/family-context.js`), sent with the family surface
contract on the OpenClaw backend and appended to the family pack prompt on the
AgentX backend. In both final prompts the child temperament follows the selected
adult personality. A follow-up invitation is optional when useful. Accuracy
and the safety rules still come first. Composition tests establish this ordering;
the installed runtime and conversational preference need separate qualification.
Every Super Dad turn also receives the active child profiles of the Family page
(`/dad/family`) as approved knowledge, so the children's names and age bands
do not depend on which notes a search selects. Famille turns do not.
A parent may record an optional birth date (`YYYY-MM-DD`, from 1900 to today)
for each profile on `/dad/family`. It is stored with the profile in
`household_profiles` and travels with the MongoDB backup. Only the adult
routes `GET /api/family/profiles/details` and `POST /api/family/profiles/birth-date`
read or change it; both stay behind the parental gate. Super Dad receives the
age in years, computed for the turn's date (`PLANNING_TIME_ZONE` when set,
otherwise the server's local date), and the birthday as day and month, never
the stored date. Without a birth date it keeps the age band. Famille turns, the
Family page and the child-facing profile and room routes see the age band only.
When the profiles, notes or memory hold only part of an answer, Super Dad says
what they establish and plainly what they do not, without guessing exact ages,
dates or relationships.
The background brain runs after each Super Dad and Famille turn when
`HOUSEHOLD_BRAIN_ENABLED=true` (the Compose default; `HOUSEHOLD_BRAIN_FAMILY=false`
leaves Famille out). It uses the router's `master_brain` lane unless
`HOUSEHOLD_BRAIN_MODEL` names an Ollama model; `HOUSEHOLD_BRAIN_HOST_URL` pins it
to one Ollama host so it never competes with the voice model's host; a fast voice
model and a larger reviewer on another host form a two-level conversation. A new
turn supersedes a running review: without a pinned host its request is cancelled
so the voice gets the host back; on a pinned host the request finishes and its
result is discarded, because cancelling an admitted request quarantines the host.
Reviews use shared admission unless `HOUSEHOLD_BRAIN_EXCLUSIVE=true`, which waits
for an idle host, blocks other callers and unloads co-resident models. The
browser speaks its remark only while listening with no turn in flight.
The default family knowledge corpus is empty and disabled; an approved external
configuration may be selected with `NESTOR_KNOWLEDGE_CONFIG_PATH`.

A household documents folder extends that corpus without listing each file. In
the external RAG ingestion policy (`RAG_INGESTION_POLICY_PATH`),
`ingestion.classifiedRoots` labels every file under a root beneath an approved
root, e.g. `{ "root": "<approved root>/Maison", "scope": "household",
"sensitivity": "normal" }`; add `pdf` to `allowedExtensions` for manuals and
warranties (scans without a text layer yield no text). The ingested source is
the folder's first segment below the approved root (`maison`). The Nestor
knowledge configuration then names it: `"householdDocuments": { "source":
"maison", "lanes": ["family", "reader", "operator"], "topK": 3, "minScore": 0.45 }`.
`minScore` (0.3-1) is calibrated for the embedding model: about 0.45 suits
bge-m3 on French content. Family retrieval accepts only results from that
source that carry the household/normal labels; putting a file in the folder is
the parent's approval.

Markdown files are read as Obsidian notes. Frontmatter `tags`, inline `#tags`,
`title` and `aliases` are kept; other properties are indexed as text in the
note's first chunk. Chunks follow heading sections and start with their
breadcrumb (`Title > Section`); `[[links]]` become readable text and their
targets are stored on the document; `%% comments %%` are not indexed. A note
may narrow its folder labels with `scope`/`sensitivity` properties but never
widen them: only a household root yields household labels, and unknown labels
skip the file. `rag: false` keeps a note out of the index and removes it if it
was indexed. A Markdown file indexed as flat text is re-chunked on the next scan.

To retire a PDF, move it out of the classified household root, then delete its
exact indexed ID with `DELETE /api/rag/documents/:documentId` and the JSON body
`{"confirmation":"DELETE <documentId>"}`. Refresh the Data file inventory and
verify that the old ID is absent from the RAG document list and from filtered
search results. Removing the file alone does not revoke an existing index entry.
For a replacement, verify the new document is searchable before retiring the old
one. Keep the source original in the private archive when retention is required.

RAG search accepts `followLinks` (0-3): after the direct results, it appends the
best chunk of notes they link to (by file name or alias), under the same
filters and marked `linkedFrom`. Household retrieval follows up to two links
(`householdDocuments.followLinks`); a linked note keeps the household/normal
label check but not the score floor, because the parent's link is the curation.

Similarity floors are cosine scores, and their meaning depends on the embedding
model: the defaults were measured with `nomic-embed-text:v1.5`. Each one is a
Core setting supplied through the instance Compose override (0-1; an unset or
invalid value keeps the default):

| Variable | Default | Applies to |
|---|---|---|
| `MEMORY_SEARCH_MIN_SCORE` | 0.6 | Memory reads that do not choose a floor, so an unrelated question returns nothing instead of the nearest noise. This includes Core `POST /api/rag/search` and the MCP `rag_search` tool. Hybrid searches and callers with an explicit `minScore` keep theirs. |
| `CHAT_RAG_MIN_SCORE` | 0.3 | Chat RAG context (semantic search; hybrid RRF ranks keep 0.15). |
| `MEMORY_REVIEW_RAG_MIN_SCORE` | 0.55 | Memory review searches for existing memory. |
| `MEMORY_REVIEW_DUPLICATE_SCORE` | 0.8 | Memory review score above which a candidate is flagged as a duplicate. |

The household documents floor is `householdDocuments.minScore` in the Nestor
knowledge configuration.

Every installation needs private HTTPS, LAN peer restrictions and loopback
backend bindings verified before device access; check IPv6, NAT and tunnels too.
Native agent tools, voice and external evidence panels need their configured
services; their inclusion as code is not a live operational receipt.
Selected-note editing and recall use Core and do not require OpenClaw or VoiX.

`npm run build` builds Core assets. `npm run check:compose` renders both base and
optional Ollama definitions without contacting a Docker daemon. Actual startup
requires Docker. No tests or compilation result is a deployment receipt.

CI's existing Compose job also builds and starts Core/Benchmark/RAG with fresh
MongoDB/Qdrant volumes on a disposable GitHub-hosted Linux runner. Inference is
pointed at a closed loopback port; no operator secrets or homelab endpoints are
used. It verifies service health and synthetic Qdrant write/read/filter/delete,
then removes that runner's disposable stack. A passing result validates containers,
not Ollama inference or the real-phone experience.

## Light-task fallback ladder

Host health reports `gpuHealth` for configured pins. A fresh `/api/ps` sample
showing a CPU or partial-VRAM pin, including a co-resident embedder, raises one
`pin-vram-spill` incident through the existing alert engine. Fresh GPU telemetry
reporting no GPU uses the same host incident. The health tick
does not reload a model solely because of this diagnostic. The light-task
ladder excludes a spilled target model or a host with fresh empty GPU inventory
through its existing admission guards; healthy co-resident targets remain eligible.
Missing or stale evidence remains unknown, not a GPU failure. This incident
does not auto-resolve on silence: fresh full residency of every configured pin
records recovery evidence before resolution. Native service-unit failure
delivery remains instance configuration; this diagnostic does not install a
supervisor or modify a driver, pin, context or Modelfile.

Pin restore verification refuses observed CPU/partial residency. Older inventory
without byte measurements retains loading verification but reports
`gpuVerified: false`; `verified` alone does not prove full GPU residency.

Every task routes to its configured model and host. When that primary is
unavailable, a light task may answer with a different model on another host
instead of refusing. The ladder is instance configuration in the external env
file; it is empty by default, and Core then routes exactly as before.

```bash
AGENTX_TASK_FALLBACKS_JSON='{"quick_chat":[{"model":"gemma4:12b-it-qat","host":"tertiary"}],"nestor_answer_light":[{"model":"gemma4:12b-it-qat","host":"tertiary"},{"model":"gemma4:e4b","host":"secondary"}],"rag_query_expansion":[{"model":"gemma4:12b-it-qat","host":"tertiary"}]}'
AGENTX_TASK_FALLBACK_WAIT_MS=2000
```

Keep the value on one line. Here a quick chat, a short Nestor answer and RAG
query expansion fall back to the always-on `tertiary` host, and a short Nestor
answer tries `secondary` next.

- Keys are task types, values ordered `{ model, host }` fallbacks (at most
  four). `host` is a configured host ID: `primary`, `secondary`, `tertiary`
  with its `OLLAMA_HOST*` URL, or an additional ID from the inference host
  registry described below. Pin the fallback model on its host first.
- Only `quick_chat`, `buddy_reaction`, `nestor_answer_light`,
  `rag_query_expansion`, `rag_reranking`, `rag_compression` and `janitor_ai`
  may degrade. A ladder naming any other task, an unknown task or an
  unconfigured host is rejected as a whole at startup: Core logs
  `[TaskFallbackLadder] AGENTX_TASK_FALLBACKS_JSON rejected` with every
  problem, and no task degrades until the value is fixed.
- The primary counts as unavailable when its host is not configured or does
  not answer, a benchmark claim or session hold refuses it, runtime
  coordination blocks ordinary admission there, an UNKNOWN quarantine fences
  it, or it is busy: another inference admission is active on that host (the
  27B serves one request at a time). A busy, claimed or blocked primary is
  re-checked for up to `AGENTX_TASK_FALLBACK_WAIT_MS` (default 2000, at most
  10000) before the task degrades with reason `primary_busy`,
  `benchmark_claim` or `admission_blocked`. Strict tasks keep queueing.
- Each rung faces the same checks and must list the model among the host's
  installed models; the first rung that passes serves the request through the
  usual admission and claim guard. When no rung passes, the caller gets its
  usual busy or unavailable answer.
- A target that passed the probe but refuses before any output (claim, session
  hold, admission refusal, connection refused before the request was sent) is
  replaced once by the next rung (reason `dispatch_refused` from the primary).
  A request that reached the model, or that has started streaming, is never
  resent. This applies to `/api/inference/generate` and to Core inference for
  Household; the Playground chat uses the probe only.
- A degraded answer says so: `agentx_routing` and the `X-AgentX-Degraded*`
  headers on `/api/inference/generate`, `routing.degraded` on chat replies (the
  Playground badge shows "mode dégradé"), `routing.fallbackUsed` on household
  turns (the Nestor conversation marks the reply "mode dégradé"). InferenceLog rows record `fallbackUsed` with a
  `task_fallback_<reason>` code, and the lane observability projection
  (`taskFallbacks`) counts ladder use since the last start. Hourly counters
  that survive a restart keep the rungs served, the ladders exhausted (no
  rung could serve) and the `/api/inference/generate` refusals at selection or
  admission, which write no InferenceLog row: `GET
  /api/analytics/inference/contention?window=24h|7d|30d|90d` returns their
  buckets and totals by task and code, kept as long as the inference logs.

A strict task never changes model, and never changes host unless the other
host has its model installed: the scheduler's placement away from the
configured host is verified first. While a benchmark claim holds the only host
with the model, `/api/inference/generate` answers 503
`NO_UNCLAIMED_OLLAMA_HOST` without dispatching. A claim, session hold or
runtime admission refusal met at dispatch answers with its own code
(`BENCHMARK_CLAIM_ACTIVE`, `HOST_SESSION_HOLD_BUSY`,
`RUNTIME_INFERENCE_ADMISSION_DENIED`, `RUNTIME_INFERENCE_RECOVERY_REQUIRED`).
The caller retries after the campaign or the hold.

The ladder is chosen before dispatch. `DEGRADED_FALLBACK=true` is separate:
one retry after a failed dispatch, normally of the same model on another host,
for three interactive lanes.

OpenClaw's conversation provider asks for an exact model rather than a task.
With `OPENCLAW_CONVERSATION_FALLBACK_TASK=nestor_answer_light` it borrows that
task's ladder; unset, it keeps its busy reply. Only turns carrying
`x-agentx-busy-reply: conversation` degrade; cron turns on the plain provider
keep their 409. Before dispatch the turn degrades when the primary is busy,
down, quarantined or spilled; a benchmark claim or blocked admission is first
asked to yield (at most 30 s with a fallback configured), and a refusal before
any output then moves the turn to a rung once. The degraded turn goes without
tools or thinking, its system prompt names the brain in use, its reply starts
with a one-line notice (`🪶 Cerveau léger (…)`), and it carries the
`X-AgentX-Degraded*` headers. Its InferenceLog row records `fallbackUsed` and
the `task_fallback_<reason>` code, like a ladder rung served by Core. When no
rung answers, the busy reply remains.

`OPENCLAW_CONVERSATION_NO_THINK_MODELS` lists conversation models that answer
without reasoning whatever thinking level the agent asks for, for example the
model of a spoken lane; the other models keep the level they were sent. When
several uses share one model, each use sets its own reasoning instead: a gateway
provider sending `x-agentx-think: off` or `on` decides for all its turns, over
that list (see `core/integrations/runtime-bridges/README.md`).

## Routing snapshot cache

The runtime bridges (OpenClaw model discovery, inspection and every model call;
Hermes model discovery and chat completions), the runtime configuration export,
PsyX and `GET /api/consumers/v1/routing` read one effective routing snapshot:
configured task routes, host preferences and per-task context and contract
evidence. Building it reads each routed host's `/api/tags`, its Benchmark host
profile and the registry entry, so Core shares one snapshot per option set.

```bash
AGENTX_ROUTING_SNAPSHOT_CACHE_MS=5000
AGENTX_ROUTING_SNAPSHOT_STALE_MS=300000
```

- Fresh window (`AGENTX_ROUTING_SNAPSHOT_CACHE_MS`, default 5000): callers
  share the snapshot. `0` rebuilds it on every call and turns the stale window
  off.
- Stale window (`AGENTX_ROUTING_SNAPSHOT_STALE_MS`, default 300000, counted
  from the build): past the fresh window, a caller gets the held snapshot at
  once while one background refresh replaces it for the next caller, so a model
  call does not wait for the build. A failed refresh keeps the held snapshot
  until it leaves the stale window; past it, callers wait for a build and
  receive its error. `0` makes every caller past the fresh window wait.
- The exact-artifact view (OpenClaw model discovery and inspection, the
  Pipeline model alias gate, the runtime configuration export) is never served
  stale: its qualification verdict is rebuilt once the fresh window is over.
- Concurrent callers share one build. A caller that disconnects leaves alone;
  a build callers wait for stops opening host reads once every one of them has
  left, and a failed or abandoned build is never kept.
- A router task override, an inference host registry change, a host preference
  update or delete, and a pin add, change, removal or clear discard the
  snapshot at once, fresh or stale: the next caller waits for a build and sees
  the write.
- Within the fresh window the exact artifact identity of a model on a host
  (catalog digest, host profile, registry entry) is resolved once, whatever the
  number of tasks routed to it.
- Fields that change without one of those writes can lag by up to the stale
  window on the views served stale: host status, loaded models (OpenClaw
  resident model discovery), the benchmark claim flag and context evidence.
  Admission, benchmark claims, session holds, busy checks and runtime
  coordination are read live on every inference and never come from the
  snapshot.

## Inference hosts

### Physical GPU admission

`AGENTX_RUNTIME_RESOURCES_JSON` optionally maps private physical GPU identities
to consumer endpoint URLs. Keep the actual inventory in the external instance
env file; the Configuration view hides its value. A generic example is:

```json
[{"id":"gpu-a","endpoints":["http://gpu-a:11434","http://gpu-alias:11435"]}]
```

Each identity describes one physical device, independently of an IP address or
port. Include every managed endpoint that uses that GPU; an endpoint using
several GPUs appears in each device's list. Leave CPU-only endpoints unmapped.
Endpoints are HTTP(S) origins without credentials, paths or query strings.
Unset or an empty array retains endpoint-only coordination. Invalid entries
refuse inference and workload admission as a whole.

Core stores the derived resource IDs on each admission. Distinct endpoints
sharing a device cannot acquire concurrent inference, even for the same model.
A workload reserves both its endpoints and their physical devices; its own
inference still requires its exact endpoint-bound proof. A yielded workload
admits ordinary inference only on its listed endpoints. Unrelated GPUs and
unmapped CPU endpoints keep their existing admission rules.

Configure or change this map only after all inference and workload admissions
have settled. A fingerprint in the same Mongo admission command prevents a
new mapping from bypassing held legacy or UNKNOWN admissions. Until those
owners release or reconcile, new dispatch refuses with
`runtime_resource_configuration_changed`; exact heartbeat, release and recovery
remain available. Do not remove admission records to activate a new map.
`GET /api/nerve-center/runtime-coordination/active` reports configuration validity,
whether a change is blocked, and the stored resource IDs on held admissions.

This mapping coordinates participating Core consumers. Listing a speech peer,
game or other application does not make it participate or prove that its CUDA
allocations were freed. Speech compute drain, backup readiness and physical
GPU release require their own adapter and qualification under
[#342](https://github.com/WindriderQc/AgentX/issues/342).

Ordinary Core inference requires a stable Ollama version of at least 0.30.10.
Before dispatch, Core reads `/api/version` with a five-second bound; missing,
malformed, prerelease or older evidence returns
`INFERENCE_CONTEXT_POLICY_UNAVAILABLE` (503). Chat and generation send
`truncate: false` and `shift: false`; embeddings send `truncate: false`. Input
and history are preserved for the runtime to accept or explicitly reject.
Configured `num_ctx`, output limits, model artifacts and pin preferences stay
under their existing authority. Disabling context shifting can reload an
already resident runner, so qualify startup latency on the instance. A direct
lane does not opt out. Benchmark/Profiler probes require an exact Core workload
reservation to retain their boundary-testing behavior.
Resident pin warmups, session warmups, model starts, pin speed checks and
watchdog probes/restores carry the same refusal flags. This keeps periodic
maintenance from reloading the runner merely to re-enable context shifting.

Every Ollama endpoint Core may use is a host. `OLLAMA_HOST` (and the optional
`OLLAMA_HOST_2`, `OLLAMA_HOST_3`) bootstrap the first hosts under the keys
`primary`, `secondary` and `tertiary`. Every further endpoint is registered from
the Nerve Center **Inference hosts** section, without a count limit, and is
stored in Core's `inference_hosts` collection. Core loads the registry at
startup, before routing, so a registered host is accepted wherever a
configured host is: host allowlists, pins, task routing and the light-task
fallback ladder use its id.

A host is one endpoint, not one machine. A machine that runs a GPU Ollama on
11434 and a CPU Ollama on 11435 has two hosts. `OLLAMA_HOST_VRAM_MAP` accepts
`host:port=MiB` entries, and a port-qualified entry wins over a bare `host=MiB`.

Each host declares a residency:

- `gpu` (default): every pin must be wholly in VRAM. A CPU or partial
  placement is a `pin-vram-spill` incident and the ladder skips that model.
- `cpu`: every pin must have no VRAM share. A pin found in VRAM raises the same
  incident with failure code `cpu_host_uses_vram`, which means the instance
  still sees a GPU. An empty GPU inventory is expected and never degrades it.
  A partial placement is refused on both.

`maxInflight` caps the requests Core sends to the host at once per model
(default: `GATE_MAX_INFLIGHT`). Registering a CPU host sets it to 1, so further
requests wait in Core's host gate instead of inside Ollama. Strict tasks keep
waiting; light tasks may still take the ladder.

The API is `GET|POST /api/nerve-center/inference-hosts` and
`PATCH|DELETE /api/nerve-center/inference-hosts/<id>`. A new host needs a
lowercase id, a private-network or loopback address without path, and a
residency; Core probes `/api/version` and registers the host even when it does
not answer, saying so. `PATCH` on `primary`, `secondary` or `tertiary` stores a
name, residency or limit for that configuration file host. The address of a
registered host does not change: remove it and add it again. Removal requires
`REMOVE HOST <id>` confirmation and is refused while the host has pins or a
task routes to it. Human Nerve Center changes use LAN access without identity
verification; confirmations and runtime admission rules remain required.

A CPU instance is a second Ollama service on the same machine, outside AgentX.
A generic systemd unit for it:

```ini
[Service]
User=ollama
Environment=OLLAMA_HOST=0.0.0.0:11435
Environment=CUDA_VISIBLE_DEVICES=
Environment=OLLAMA_VULKAN=0
Environment=OLLAMA_MAX_LOADED_MODELS=1
Environment=OLLAMA_NUM_PARALLEL=1
Environment=OLLAMA_KEEP_ALIVE=-1
ExecStart=/usr/local/bin/ollama serve
CPUQuota=600%
Nice=10
IOSchedulingClass=idle
MemoryMax=24G
```

Set `OLLAMA_MODELS` as well when the GPU instance keeps its store outside the
default path, so both instances read the same models. `CPUQuota` leaves cores
to whatever else the machine runs.

A CPU brain, from nothing to work:

1. Start the instance and pull a model there. Generation speed follows memory
   bandwidth divided by active weights, so prefer a mixture-of-experts model
   with few active parameters; a dense model of the same size is several times
   slower.
2. Add the host in the Nerve Center, section "Inference hosts", with residency
   CPU.
3. Pin the model on it with its context and **CPU threads** (at most the cores
   `CPUQuota` allows). The threads are not optional: every request and every
   health probe reuses the pin's context and threads, and a pin without them
   lets callers load the model with different options, which reloads it each
   time. Through the API, `PUT .../pin` only names the model; `PATCH .../pin`
   with `{model, contextSize, numThread}` sets the rest.
4. Route background tasks to it in the routing table. They stay on that host.
5. Read the journal of the instance for `starting llama-server`: after the
   first load there should be none.

What suits it: one short request at a time whose answer nothing waits on (a
watch report, an advisory, a classification). What does not: agent turns, whose
prompts take minutes to read at a few dozen tokens per second, and judgment
tasks the smaller model does differently. Before moving such a task, send the
same prompts to both models and read where they differ.

In the `full` profile Benchmark reads the registry from Core every 30 seconds,
so a registered host becomes a Profiler and benchmark target with its residency. On a CPU host the
Profiler proves a measurement with no VRAM share instead of a full one, and its
context probe stops at `CONTEXT_PROBE_CPU_MAX_CTX` (default 32768) with a
per-step timeout of `CONTEXT_PROBE_CPU_TIMEOUT_MS` (default 20 minutes): CPU
prefill takes minutes. CPU context probes measure the ascending ladder before
trying a larger context that was already resident, so an early timeout does
not precede every lower-context measurement. Every other Profiler request on a
CPU host (throughput,
generation stability, prefill/decode matrix, thinking) waits at least as long,
so a 512-token answer at a few tokens per second is not cut at the GPU-sized
`testTimeoutSec` and left without a terminal receipt. A probe unloads models only on its own Ollama instance,
so profiling the CPU instance leaves the machine's GPU pins resident.
The Profiler's thinking probe classes each model and host. `disallowed` is
kept for a model that stops with reasoning and no visible answer. A probe cut
off by its output cap while still reasoning is retried at 2,048 tokens (4,096
for the reasoning puzzle); still cut off, it reads `unknown`, since the budget
did not decide. A model that answers, then reaches the cap while reasoning,
reads `metered`. Core lets a qualified `metered` or `on` model think on
reasoning tasks (`deep_reasoning`, `analysis`); profiles from before this
classification (`profileVersion` below 3) are flagged in preflight until
re-profiled.
Leaderboard rows carry their host's residency (`local · CPU`), and
`GET /api/benchmark/generalist-leaderboard?residency=cpu|gpu` keeps one kind;
rank CPU and GPU runs with `axis=quality`, since the composite axis penalises
latency.

`benchmark/scripts/repo-coding-qualification.js --dry-run` verifies authored
repository fixtures using golden diffs without inference. A live run selects
`--models`, `--host`, `--core`, `--tasks`, `--attempts` and an external `--out`
directory. `CORE_URL` must match the selected Core and the Benchmark service's
existing credentials/database configuration must be available. The runner owns a
managed workload, an exact host claim and renewable heartbeats; `--claim-id`,
when supplied, names this new owned campaign rather than another process's claim.
Every attempt resolves its frozen artifact and uses Core's durable inference
admission. A lost or nonterminal response stops the matrix and retains authority
for reconciliation. A completed run restores the host before releasing admission.
Responses and run records retain effective model, tokens, seeds and contracts,
including contract failures. Output reports stay outside Git.

Tool-call reliability is separate product evidence: the profiler evidence route
matches exact model/host/digest/runtime and the canonical tool fixture. Repeated
campaigns persist each repetition and finalize supported, qualified or failed
states; missing, stale or interrupted evidence cannot qualify an artifact. A
single repository fixture attempt does not publish a tool qualification.

`POST /api/benchmark/comparison/paired` compares two artifacts prompt by
prompt, for example one model at Q8 on two GPUs and at Q4 on one. The body
names two arms, `a` and `b`, each `{ batch_id, model, host? }`. It also takes an
optional `categories` list and an optional `bootstrap` (`iterations` 200–20000,
default 2000; `seed`, default 1).

- **Pairing.** Results pair on the catalog prompt they ran. When both rows carry
  a prompt fingerprint, it must match, so an edited prompt never pairs. The
  repeats of a prompt are averaged inside an arm. Controlled sampling defaults
  to `seed_policy: repeat_index_v1`: repeat zero uses the base seed, then each
  repeat increments it modulo 2^32. Both contenders use the same index policy.
  `fixed` retains same-seed diagnostics; production sampling omits seed overrides.
  The policy and base seed enter the cohort, while the repeat index does not.
  A campaign freezes the complete candidate set, including each digest, runtime
  and effective context/output budget. Both arms in that campaign share its
  cohort; replacing a tag's installed artifact or changing its context creates
  another cohort. Unrelated contender sets are reported as non-authoritative.
- **Overall and per category.** The response gives `B − A` in points (0–100)
  with a paired t interval and a seeded bootstrap interval; `significant` means
  the bootstrap interval excludes zero. `minimumDetectableDelta` is the smallest
  difference these prompts would detect at 5 % and 80 % power. It is an
  approximation that shows what the current catalog can resolve.
- **Spread and pairing counts.** Each arm reports `repeatSpread`, how much a
  prompt's score moves between repeats. The response also counts the prompts
  only one arm ran and those left out because they changed.
- **Authority.** `comparability.authoritative` is false when any of these holds:
  - the arms were scored in different quality cohorts or scorer versions;
  - a judge is one of the contenders (`self`), or shares their model family
    by name (`same_family`).

  Results scored by executed tests or deterministic checks have no judge.

To know a model's run-to-run noise, compare two batches of the same artifact;
the response says so (`sameArtifact`). `POST /api/benchmark/regression/compare`
keeps comparing batches of the same model and host.

Core's default output reserve is configurable with
`AGENTX_DEFAULT_MAX_OUTPUT_TOKENS` (4,096 when unset). A resolved context window
bounds this default to one quarter of the window, with the existing minimum
reserve of 256 tokens. Explicit caller budgets take priority and remain bounded
by the full context window. The inference contract reports the effective reserve,
the configured default and its source in `contextBudget.output`; an invalid
setting produces a contract warning and uses 4,096. The Configuration view
also lists this setting. Change the instance env file and recreate Core to apply
it; this setting does not qualify a model or alter its measured context.

A batch's response budget is the most a candidate may generate, reasoning
included. When the launch sets `execution_config.response_max_tokens`, that value
applies. When it sets none, each candidate gets the documented default (32,000),
limited to half of its frozen context window so the other half stays for the
prompt, and never lower than the reserve Core chose. The plan's
`execution_config` names the rule (`response_budget_rule`). Each candidate of
the frozen campaign records its budget and where it came from
(`num_predict_source`). Preflight (`POST /api/benchmark/preflight` and the
launch's own preflight) lists the same per candidate before the launch, in
`checks.budgets.candidates`: the window (`num_ctx`), the budget
(`num_predict`), its source and the room left for the prompt
(`input_tokens`), resolved from Core's contract as the launch resolves them. A
candidate whose contract does not resolve is listed with its error and
`error_code`, as a warning. One case is an issue that blocks instead: a window
no profile verifies (`CONTEXT_NOT_VERIFIED`), which the launch refuses when it
freezes the contract; preflight gives the same message first.
`checks.budgets.judge` gives the window the judge reads (`num_ctx`: the
launch's `judge_config.num_ctx`, else the judge model's frozen window) and,
under `categories`, what each selected prompt category requires of it:

- **Window.** `window_needed` adds the category's longest selected prompt
  (task, expected and reference answers and criteria, about four characters a
  token), 512 tokens for the question and its format, the longest candidate
  budget and the judge's own `num_predict`. `fits` compares it with the judge's
  window: a judge input Core would have to truncate leaves that row unscored.
- **Reasoning.** `math` and `reasoning` recommend a judge that reasons
  (`judge_config.think: true`), since their questions ask it to check every
  step and calculation; the other categories do not need it.
- **Validation.** From the judge's qualifying accuracy calibration
  (`POST /api/benchmark/judge/calibrate-accuracy`), the reference cases of the
  category the judge graded, their mean absolute deviation from the reference
  grades and any identity or attention failure among them: `validated`
  (deviation at most 1.5, no failure), `failed`, `no_reference_cases` (the
  calibration record holds no judged case of that category) or `unvalidated`
  (no qualifying calibration). A case settled without the judge (a
  deterministic check, a quick match or executed tests) does not count;
  `settled` gives their number. The reference set covers every catalog
  category.

Each unmet requirement is one line of `warnings`, naming the categories.
These are warnings: they never block a launch, and the catalog is not
lowered for a judge that does not meet them.

`POST /api/benchmark/judge/calibrate-accuracy` freezes the judge's automatic
context and exact installed identity before scoring. The response reports its
resolved `judge_config`; a full default run retains that snapshot in its
qualification record. Each saved case includes judge prompts and raw responses,
per-question answers, dimension scores, caps, secondary bounds, language gates
and attention evidence. `GET /api/benchmark/judge/qualifications/:id` returns
these diagnostics; the summary list omits them. Older records may have no raw
evidence. Identity drift or workload cancellation stops the run.

For a small diagnostic, pass `case_ids` from `benchmark/data/judge-calibration-set.json`.
The same request accepts `num_ctx`, `num_predict`, `timeout` (milliseconds) and `think`
with the batch judge validation and warnings. Selected cases or explicit operator
settings produce `diagnostic: true`, `valid: false` and a skipped
`qualification_record`. They never publish or withdraw judge qualification,
even if every selected case passes. Qualification readers match the exact frozen
judge artifact, runtime, settings, scorer version and reference set. Omit these
diagnostic fields to run the full default qualification.

Batches launched before this rule ran under Core's default output reserve
(at most 4,096 tokens), which cut long reasoning. They keep their own quality
cohort, so the leaderboard does not mix the two.

A new batch freezes its Ollama judge's context (including an automatic pin),
exact installed digest and Core runtime fingerprint before it is saved. Missing
identity or context refuses the launch; a stale performance profile alone does
not. Secondary judges and the tiebreaker are frozen too. Quality cohort v4
includes their settings and escalation policy. Frozen calls keep their chosen
output budget after a length stop; incomplete output cannot supply a score.
Each normalized verdict must
return the same artifact, runtime and window through Core, otherwise it cannot
supply a score. Frozen judge calls request `includeArtifactIdentity: true`,
so Core resolves and returns identity even without mandatory performance
qualification. Benchmark verifies that reply without a separate contract request
per verdict. It is contract evidence, not a resident-runtime receipt or a measure of
judge accuracy. Historical rows retain their stored cohorts. A standalone
re-judge freezes its runtime before warmup; a partial run moves only the judged
rows and independent deterministic/executable scores into its new cohort.

A response that reaches its generation budget while hidden reasoning is present
records `truncation.thinking_budget_exhausted`. This observation alone does not
prove runaway reasoning. The incomplete response stays excluded from automatic
ranking, and its visible answer and hidden reasoning remain available for review.
Historical `thinking_runaway` flags remain stored; new token-cap observations
do not set that flag. Paired thinking reports count the two separately.

No judge size is assumed. A launch keeps the operator’s integer output budget
and deadline, including values above the former 32,768-token and 30-minute
ceilings. Values above the usual 4,096 tokens and 120 seconds are kept as chosen,
and the launch result lists what they cost in `data.warnings`. Output budgets
must be safe integers of at least 100; deadlines must be at least 5,000 ms and
at most 2,147,483,647 ms, because Node turns a larger timer into a 1 ms delay.

Benchmark batches send their configured `per_test_timeout_ms` to Core as
`timeoutMs`, so Core's non-streamed Ollama attempt uses the same budget instead
of the default `INFERENCE_FETCH_TIMEOUT_MS` (10 minutes). The monolithic,
reference and decomposed judge paths also send their configured
`judge_config.timeout` to Core. Core accepts this override only from the
Benchmark direct lane with workload admission proof, as a positive integer
within Node’s 2,147,483,647 ms timer limit. Benchmark's own timer covers its HTTP
request through response-body consumption, including time spent before Core
dispatches to Ollama. A disconnect still cancels the upstream request.
Other callers retain Core's configured default. A timeout alone does not prove
runtime terminality or authorize release of an uncertain claim.

Point `OLLAMA_MODELS` at the machine's existing store to reuse downloaded
models. On CPU, generation speed follows memory bandwidth divided by active
weights: prefer mixture-of-experts models with few active parameters. One CPU
instance serves one request at a time; a second parallel request adds no
throughput.

### Inference log timings and prompt cache

Each `inferencelogs` row keeps Core's wall clock in `durationMs` (routing and
queueing included) next to the phases Ollama reports for the call, in
milliseconds: `loadMs` (model load), `promptEvalMs` (prompt evaluation) and
`evalMs` (generation). A streamed call also records `firstTokenMs`, from
dispatch to the first frame carrying content, thinking or a tool call. A phase
that is not reported is absent, never 0; paths that do not see Ollama's final
record (council turns, embeddings, a streamed `/api/inference/generate`) carry
none. Ollama reuses its prompt cache only for the longest prefix identical to
the previous request on the same loaded model, so a cache miss reads as a
`promptEvalMs` that is high for the row's `tokensIn`, where a reused prefix
costs a fraction of it. OpenClaw and Hermes chat turns add `promptPrefix`: the
count of system sections (split at `## ` headings) and of non-system messages,
an 8-hex hash of the tools array, and `divergence`, the first position that
differs from the previous admitted agent call to the same host and model. Its
`kind` is `system` (with the section `index` and its `heading`, truncated to 40
characters), `tools`, `message` (an earlier message changed at `index`),
`append` (the previous messages are intact and new ones start at `index`, the
cache-friendly shape), `none`, or `first` when Core has nothing to compare
since it started. Beyond that heading the row holds only counts, positions and
a hash, never prompt content. A miss whose divergence is `append` or `none`
points elsewhere: another caller used the model in between, or the model was
reloaded (`loadMs` is high).

Every admitted call that Core dispatches to Ollama, whoever makes it (chat,
Nestor, household, agents, classifier, council, Benchmark through Core), is
also compared at dispatch with the last eight requests sent to the same host
and model, in the order Ollama receives them. Chat, `/api/inference/generate`
and trusted-runtime rows then carry `promptCache` (council turns and a
degraded retry's own row do not, though their requests count as interleavers).
`sharedChars` is the prefix,
in characters, identical to the request just before (what the cache still
holds); `reusableChars` the longest prefix identical to any of the eight (what
it could have offered); `chars` the whole prompt. A prompt is compared in
segments: the leading system message split at `## ` lines, the tools, then each
message, or for `/api/generate` the system text and the prompt's paragraphs.
`verdict` is `warm` (nothing lost), `interleaved` (other requests came between
this call and the earlier one it continues: `interleaved` counts them and
`interleavedBy` names up to three by admission `kind`, `consumerContract` and
`taskType`), `reload` (`loadMs` of at least one second: the model was loaded
again and its cache with it), `cold` (no recent request shares a prefix) or
`untracked` (Core has seen no earlier request there since it started).
`lostChars` is the reusable prefix that was evaluated again and
`lostPrefillMs` its share of `promptEvalMs`, prorated over the characters
evaluated, so it never exceeds the call's own prefill. It assumes one cache
slot, which is how the `qwen35` family runs; on a model with several slots
Ollama may still hold the earlier prefix, and the row's small `promptEvalMs`
then keeps the estimate small. Calls that reach Ollama without Core (another
client on the host) are not seen: the miss they cause reads `warm` with a high
`promptEvalMs`, or `reload`. The hashes stay in Core's memory; the row holds
counts and labels only.

`GET /api/analytics/inference/prompt-cache` adds these rows up per group: the
calls under each verdict, `lostChars`, `lostPrefillMs` against the
`promptEvalMs` of the rows where it was measured (`lostPrefillShare`), and the
five labels that came in between most often. It accepts the `/distribution`
filters, `window` and `groupBy` fields; the default groups by `hostKey,model`,
and `groupBy=consumerContract` (or `taskType`, `runtime`, `caller`) gives the
same per agent.

A row also says what the call waited for before Ollama received it.
`admissionWaitMs` is the runtime admission of the attempt that ended the call
(admission accepts or refuses without queueing, so a large value points at its
coordination store, not at contention). `hostGateWaitMs` is the wait at Core's per-(host, model)
gate, the only queue Core holds itself; a call refused before the gate has
none. Calls retried by the trusted-runtime retry policy add `retry`: the
number of `attempts`, the total backoff `delayMs` and a `history` of at most
six failed attempts, each with its `attempt`, its `cause` code (`other` for
anything that is not a code), its backoff and its own admission and gate
waits. Rows recorded before these fields existed have none of them.

`GET /api/analytics/inference/distribution` turns these rows into
distributions. It accepts the `/api/analytics/inference/logs` filters, covers
`window` (`24h`, `7d`, `30d`, `90d`; default `7d`) unless `from`/`to` are given,
and groups by one or two of `consumerContract` (default), `taskType`, `model`,
`host`, `hostKey`, `caller`, `runtime`, `status` and `fallbackReason` (`limit`
groups, default 50, at most 200). A fallback reason is grouped as its stable code
(for example `task_fallback_primary_busy`): a free-text legacy reason reads
`other`, and a call without one reads `none`. The same codes filter `/logs` and
`/distribution` (`fallbackReason=`) and appear in the summary's
`byFallbackReason`. For the totals and each group it returns p50, p90, p95, p99 and
max of `inputTokens` (`tokensIn`, or the dispatch estimate when the call ended
without usage), `tokensOut`, `durationMs`, `firstTokenMs`, `loadMs`,
`promptEvalMs`, `evalMs`, `nonModelMs` (wall clock not covered by the three
Ollama phases: routing, admission, queueing, retries and network),
`admissionWaitMs`, `hostGateWaitMs`, `numCtx` and `contextFill`
(`inputTokens / num_ctx`); the calls per prompt-size bucket (up to
8k, 16k, 32k, 64k, 96k, 128k, 192k, above); and the calls filling at least 50,
75 and 90 % of their context. Percentiles are MongoDB approximations. A metric
no row reports has a null value with a count of 0. Rows expire after
`INFERENCE_LOG_TTL_DAYS` (returned as `retentionDays`), so a window longer
than that covers only the retained rows.

## Resident model pins

The Nerve Center host cards show parallel requests **per model** separately from
resident model slots. This is the last observed `OLLAMA_NUM_PARALLEL` process
setting, with its observation date, not a measured throughput guarantee or a
live reading from `/api/ps`. Unobserved hosts show Unknown. Extra requests queue;
VRAM, context size and AgentX admission can reduce effective concurrency.
After inspecting the running process environment or its matching startup log,
record the observation through
`PUT /api/nerve-center/host-preferences/<encoded-host-url>/ollama-concurrency`
with `{ numParallel, observedAt, source }`, where `source` is
`process-environment` or `startup-log`. Without a recorded observation, the card
uses the `OLLAMA_NUM_PARALLEL` the GPU collector read from the host's Ollama
service (`ollamaService` in the GPU collector setup under
[optional surface integrations](#optional-surface-integrations)) and says so; a
recorded observation stays authoritative and a differing collector reading is
shown beside it. This updates host metadata only; changing Ollama's parallelism
requires separate host configuration and qualification.

Below that value, the **Effective** line gives each pinned and loaded model the
request slots Ollama actually gives it. Ollama gives one slot, whatever
`OLLAMA_NUM_PARALLEL` says, to a model that cannot complete text (an embedding
model) and to the architectures its scheduler runs sequentially, among them the
Qwen 3.5/3.6 hybrids (`qwen35`, `qwen35moe`) and `qwen3next`: the card shows
`1 (architecture qwen35)`. Core reads each model's family and capabilities
from `/api/show` (cached ten minutes per host and model) and compares the
family with the scheduler's list in
`core/src/services/ollamaModelParallelismService.js`, copied from Ollama's
`server/sched.go`; review it when upgrading Ollama. Any other model shows the
configured value with `(server setting)`, or only `server setting` while that
value is unknown, and a model whose metadata cannot be read shows `unknown`.

One host can keep a conversation model and an embedding model resident together.
`pinnedModels` holds an independent `{ model, keepAlive, contextSize, autoRestore, numThread }`
entry for each resident. `keepAlive: -1` requests permanent residency; a positive
`contextSize` sets the runtime context without editing the artifact's Modelfile.
`numThread` (optional, **CPU threads** in the pin row) sets Ollama's `num_thread`
for the warm request and for every inference on that model, so a CPU pin leaves
cores to the machine's other services. Memory bandwidth, not core count, limits
CPU generation: beyond 6 to 8 threads the gain is small. Unset keeps Ollama's
own choice.

In the Nerve Center, adding or removing a pin and changing its keep-alive or
auto-restore setting affects that model. Choosing a primary pin preserves the
other entries. Clear pinned set removes all pins with operator confirmation.
Adding pins raises the declared `maxConcurrentModels` to fit the list; an explicit
slot limit below the pin count is rejected. This value declares AgentX residency
intent. It does not change the Ollama process or allow concurrent inference
through the runtime coordination guards.

Configure [`OLLAMA_MAX_LOADED_MODELS`](https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests)
(plural) in the host's external Ollama service
environment if a fixed runtime limit is needed. Both models and their configured
contexts must fit in VRAM on a GPU host, and stay outside it on a CPU host
(see [inference hosts](#inference-hosts)). Pin add/update requests verify the complete set through
Ollama `/api/ps`; if verification fails, the previous pin settings are restored
under the same runtime mutation lease and runtime restoration is checked again.
An unknown mutation outcome keeps its existing coordination quarantine.

The per-host `/api/nerve-center/host-preferences/<encoded-host-url>/pin` API uses
`POST` to add, `PATCH` to change the named model's options, `PUT` to make the named
model primary, and `DELETE` with `{ model }` to remove only that pin. `DELETE`
without a model clears the set and requires `CLEAR HOST PIN` confirmation.

`POST .../pin/context` with `{ model, contextSize, expectedContextSize,
operatorDecision: "apply" }` changes one pin's context for a Profiler proposal.
It refuses without writing when the model is not pinned, the pin no longer has
`expectedContextSize`, the context is unchanged, the model is an embedder, a
benchmark claim or session hold owns the host, or the current short-prompt decode
speed cannot be measured. After the write it requires every resident placed as
the host declares (fully in VRAM, or none of it on a CPU host) and a short-prompt speed within `PIN_CONTEXT_SPEED_TOLERANCE_PCT` (default
10) of the current pin; otherwise it restores the previous pins through the same
rollback. The response reports `rollback: verified` or `unverified`; an
unverified rollback keeps the runtime lease quarantined.

## Moving mail digests out of memory notes

Mail digests saved as personal notes before the mail journal existed are moved
with `core/scripts/migrate-mail-digests.js`, run in the Core container. A note
carrying a Gmail thread/message id is a digest; one that reads like mail
without an id is listed for review and never moved; everything else stays a
note. Report and backup hold private text: write them to the instance backups,
never into the checkout.

```bash
docker exec agentx-core-1 node scripts/migrate-mail-digests.js --report /tmp/digests-plan.json
docker exec agentx-core-1 node scripts/migrate-mail-digests.js --apply --backup /tmp/digests-backup.json
```

Each digest becomes its own journal entry (tag `migrated-from-notes`, dated by
when the note was filed) and its note is forgotten: hidden from every reader,
recoverable from the backup. Digests filed longer ago than the journal
retention, and notes that cannot be read, stay notes and are listed as skipped.
A 16-digit number without letters is never taken for a Gmail id.
`--ids <file.json>` limits a run to chosen note ids. Copy the files out of the
container before it is recreated.

## Identifier vault

Generate the key once on the host and add it to the instance env (never Git):

```bash
echo "IDENTIFIER_VAULT_KEY=$(openssl rand -base64 32)" >> /srv/agentx/instance/instance.env
```

Recreate Core, then seal identifiers already stored in notes and the mail
journal: the dry run prints counts by kind only; `--apply` writes the original
texts to a backup first (clear text: keep it outside Git and delete it once the
result is checked).

```bash
docker exec agentx-core-1 node scripts/seal-identifiers.js
docker exec agentx-core-1 node scripts/seal-identifiers.js --apply --backup /tmp/identifiers-backup.json
```

Back the key up with the instance secrets: without it, stored values cannot be
read.

## Completed coding task replay

`core/scripts/completed-coding-replay.js` reads a private
`agentx.completed-coding-corpus/v1` manifest with a `tasks` array. Each entry
contains the completed `pipelineId`, `status: "done"`, original `spec`, exact
40-character `baseRevision`, `originalReceiptFingerprint`, repository-relative
`sourceFiles` and permitted `scope`. Its operator-selected `verification`
contains a profile name, immutable original `sourceFiles`, executable `argv`
and bounded `timeoutMs`. The original receipt supplies the base revision;
current HEAD is never substituted. Missing bases or authority files refuse the
corpus before inference. Task, authority and verifier snapshots enter the
corpus fingerprint.

```sh
node core/scripts/completed-coding-replay.js --corpus /private/completed-tasks.json --repo /path/to/AgentX --out /private/replay-run --model example-model --host-url http://gpu.example.test:11434 --dry-run
```

Removing `--dry-run` admits each call through Core against the selected host's
pinned model. The replay never claims or writes Pipeline tasks, changes a
routing default or chooses a capacity fallback. Only proven refusals before
dispatch wait and retry; uncertain dispatch stops the run. Each task receives
its full original authority text and returns one unified patch. A detached
worktree at its original base receives that patch. Changes outside scope or
to the immutable verifier refuse verification. Bubblewrap runs the exact
verifier with a read-only worktree, disposable `/tmp`, no home or network;
missing sandbox support or dependencies fail verification without a fallback.
`/node/node` selects the running Node executable when a profile needs Node.
The worktree is removed after recording the result.

The private report directory must be outside every Git checkout. It contains
the pinned corpus, model responses, attempt results and summary with verified
pass rate, duration, actual model, call count and nullable token usage. The
fixed gate requires every selected task to finish and pass; interrupted or
uncertain runs are incomplete. This bounded patch replay measures the supplied
corpus and adapter, not an unrestricted worker session.

The standalone advisory command reads an operator-supplied packet containing
the original task authority and exact patch; its packet fingerprint binds the
receipt to that input. It is optional and outside the local worker's run.

`core/scripts/coding-advisory-review.js --packet /private/reports/0700-packet.json
--out /private/reports/0700-advice --model local-coding-model
--host-url http://localhost:11434` runs a consultative review against an explicitly
selected configured host and pinned model, through Core's trusted inference
admission. `--dry-run` validates the packet without inference. The private receipt
records the original base, patch and packet fingerprints, actual tokens and model,
whether it is a self-review, and the model's notes. The command never writes
Pipeline tasks, accepts work, changes verification or merges a PR. An existing
receipt prevents another call; only a proven refusal before dispatch is eligible
for a later attempt. Unknown completion remains fenced by Core. Truncated or
empty notes carry an explicit status. Advisory notes are not an executable test
or a model qualification.

Live coding attempt evidence also retains observed session tokens and the
actual model on successful and failed outcomes, independently of cost
telemetry. An attribution alias is resolved only from server evidence; missing
or mixed model attribution remains unknown. `GET /api/pipeline/performance?groupBy=model`
returns per-model aggregates and a separate unknown bucket. Observed token
sums and coverage stay distinct from totals when attempts have missing usage.

## Fast voice lane replay

Before the fast voice lane answers real conversations, an offline replay
measures how a light model decides between answering and handing a request
to the native agent. The model receives the stable personal prompt, the
Nestor personality and a single `delegate` tool
(`core/surfaces/household/voice-lane.js`). The script reads the most recent
personal voice requests, sends each one after the last exchanges of its
conversation through Core's admitted inference (never to a model host directly) and compares the decision with
whether the recorded turn used agent tools.

```bash
docker exec agentx-core-1 node scripts/voice-lane-replay.js --out /tmp/voice-lane-replay --dry-run
docker exec agentx-core-1 node scripts/voice-lane-replay.js --out /tmp/voice-lane-replay-1 --limit 200
```

- `--out` is required, must be a new directory outside the application tree
  and any Git checkout, and receives `summary.json`, `summary.md` and
  `disagreements.jsonl`. These files hold private request text: copy them out
  of the container to a private location and never commit them. Stdout prints
  counts only.
- The model comes from `--model` and `--host-url`, or from the router task
  `--task` (default `voice_persona_chat`); it must be pinned on that host so
  the replay never displaces a resident model.
- A busy host is waited for (`--retries`, `--busy-wait-ms`); a request that
  may have reached the model is never sent twice. `--dry-run` only counts the
  sample.
- Gate: at most 5 % missed delegations (tools were recorded, the model
  answered itself) and at most 15 % unnecessary delegations. Recorded tool use
  is a weak label (the agent may have answered without a tool it should have
  used) and notes are not replayed, so the owner judges the disagreement
  sample.

## Qdrant payload indexes

RAG creates the payload indexes its filters use (`documentId`, `revision`,
`chunkIndex`, `source`, `tags`, `scope`, `sensitivity`, `sourceIdentity`,
`contentHash`, `noteName`, `aliases`) and a full-text index on `text` for
keyword search. They are created with a new collection, and the missing ones
are added the first time RAG verifies an existing collection. Qdrant builds
them in the background: on a collection of about 100,000 chunks this is a
one-time cost of a few seconds. A failed index creation is logged as a warning
and does not stop ingestion or search; without the `text` index the keyword
half of a hybrid search fails and reports `applied.keywordSearchFailed`.
Keyword search scores at most 500 candidate chunks that contain a query term.

### Embedding host chain

Core's embedding proxy (`POST /api/inference/embed`, used by RAG) tries the
host routed for the model, then every other configured host, registered CPU
hosts included. It moves to the next host when any of these happens:

- the host fails a short liveness probe;
- Core refuses admission there, for example under a Benchmark claim or a
  workload;
- the host does not answer in time;
- the host answers that the model is not installed (HTTP 404).

Only the last host's 404 reaches the caller. A response served by another host
carries `X-AgentX-Fallback-Used: true` and `X-Routed-Host`, and the inference
log keeps one error row per skipped host with its reason. To keep searches
working while the GPU embedding host is claimed, install the embedding model on
a CPU host and register it. A CPU host answers a short query almost as fast as
a GPU, but ingests documents several times slower. An explicit `ollamaHost` in
the request disables the chain.

## Switching the embedding model

The embedding model and its dimension belong to one Qdrant collection. A new
model gets a new collection; the old one stays untouched as the fallback.
Documents are re-embedded from the `originalText` stored on each document's
first chunk; a document without it is reported and must be re-ingested from
its source.

1. Pull the new model on the embedding host and pin it there in the Nerve
   Center host preferences with `keepAlive` -1, so it stays resident beside the
   current one.
2. Snapshot the current collection (`POST /api/rag/snapshots`, or a Core
   backup) while the instance still points at it.
3. Count what will move, then copy into the new collection. The script runs
   inside the RAG container, reads the source collection only and embeds
   through Core with the model given on the command line:

   ```bash
   AGENTX_PROJECT_NAME=<project> docker compose --env-file <instance.env> \
     exec -T -e EMBEDDING_MODEL=<model> -e EMBEDDING_DIMENSION=<dims> rag \
     node scripts/migrate-embedding-collection.js \
     --source <current collection> --target <new collection> --dry-run
   ```

   Rerun without `--dry-run` to copy (`--limit N` for a first trial). The
   JSON summary lists migrated, skipped and failed documents with reasons; the
   exit code is non-zero when any failed. The script refuses a target equal to
   the source, stops when the target's vector size differs from
   `EMBEDDING_DIMENSION`, and copies the source payload indexes.
4. Writes continue on the old collection during the copy. Pause ingestion
   scans and memory review, or run a final pass with `--delta`, which copies
   only documents missing from the target or whose hashes differ.
5. Set `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION` and `QDRANT_COLLECTION` in the
   instance env file and recreate RAG and Core through the launcher.
   `/api/rag/embedding-migration/status` must report the new model with
   matching dimensions.
6. Recalibrate the similarity floors above for the new model.
7. Keep the old collection until retrieval on the new one is verified; going
   back is the previous three settings.

## Running a second instance

A different project name isolates containers, networks and volumes. It does not
choose free host ports: select unused loopback ports in the external env file.

```bash
export AGENTX_PROJECT_NAME=agentx-canary
export AGENTX_ENV_FILE=/path/outside/git/agentx-canary.env
export AGENTX_COMPOSE_OVERRIDE=/path/outside/git/agentx-canary.compose.yml  # optional
./agentx up --build
./agentx health
```

PowerShell uses the same names with `$env:NAME = 'value'` and `./agentx.ps1`.
These three are launcher inputs: set them in the launching shell and keep the
same values for `status`, `logs` and `down`. The env file supplies Compose
settings such as ports, `AGENTX_PROFILE` and `COMPOSE_PROFILES`.

Restored host and routing settings can activate background probes, prewarming
and watchdogs. For a data-only copy, set the Compose network to `internal: true`
in the external override, leave credentials and mounts absent, and verify that
no container can reach the live services. A separate database does not
coordinate model claims with the live runtime: do not run real inference on a
second instance until its consumers have one agreed authority.

## Live instance

Native operations helpers live in
[integrations/operations](../integrations/operations/README.md): backup and
restore, off-host replication, alert reconciliation, schedule projection and
usage counters. Instance paths, hosts, volume lists and delivery rules are
external settings; importing source alone does not activate a task. The backup
path is deployment-owned: verify the actual mount, and update backup supervisors
and off-host replication together.

### Backup schedule

Core creates the Mongo, configuration and Qdrant backup set once per
occurrence of a cron expression. The occurrence state is persisted, so a Core
restart never adds a cycle and never moves the schedule. These are Core
environment settings supplied by the external env file or Compose override,
like the other `BACKUP_*` values; the checked-in Compose file only carries
`BACKUP_SCHEDULE_ENABLED: "false"`.

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_SCHEDULE_ENABLED` | `false` | Enables automatic creation. |
| `BACKUP_SCHEDULE_CRON` | `0 3 * * *` | Occurrence cron (five fields, cron-parser syntax). An explicitly empty value switches to the interval anchor. |
| `BACKUP_SCHEDULE_TZ` | `PLANNING_TIME_ZONE`, else `UTC` | IANA time zone the cron is evaluated in, e.g. `America/Toronto`. |
| `BACKUP_INTERVAL_MS` | 24 h | Interval anchor only: the next occurrence is the last successful occurrence plus the interval. Ignored, with a startup warning, while a cron is set. |
| `BACKUP_STARTUP_DELAY_MS` | 5 min | Grace before an overdue occurrence or a resumed retry runs after a start. It never anchors the schedule. |
| `BACKUP_RETRY_DELAY_MS`, `BACKUP_MAX_RETRIES` | 1 h, 3 | Retry of the failed retryable layers only. A retry never moves the anchor and is dropped when it would overlap the next occurrence. |

An invalid cron or time zone disables automatic creation with a visible reason
on the backup page instead of failing Core. The backup page shows the effective
cadence, the next occurrence and why it was chosen. Pick a time outside
01:00–03:00 local in zones with DST: the default 03:00 keeps its local time
across both changes in America/Toronto, Europe/Paris and Australia/Sydney,
whereas an occurrence inside a DST gap or overlap is resolved by cron-parser
and may shift or repeat on the change day.

Rules that hold for every session, human or agent:

- Read the instance's lead/ownership note before any runtime mutation and
  respect the current owner. Do not start a second driver.
- Never run two writers against the same personal database or volumes.
- Never restore an old dump over current state. When two data sets diverge,
  freeze writers, preserve both, then reconcile. `down` preserves volumes;
  `reset` is not a recovery command.
- Operate the live instance with its external env file and Compose override,
  never with the checked-in demo values.
- Keep published ports on loopback and the application off public endpoints.
- No paid inference, benchmark campaign or canary without explicit approval.

Current state and open acceptance are in [STATUS.md](STATUS.md).

## Profiler restoration and UNKNOWN recovery

Profiler scout, single-profile, host queues and full-profile drivers write a
`profile_run` journal in `HostProfile.reconciliation` before runtime dispatch.
Core retains the exact pre-claim resident snapshot: artifact digest, artifact
and VRAM bytes, context and lifetime. Restore loads generative residents before
embeddings and verifies the complete set: digest, size, context and lifetime
exactly; GPU placement by rule. A resident that was wholly in VRAM must be
wholly in VRAM again; one that had already spilled may return with a different
GPU share, reported as `placementDrift` in the release receipt. An observed residency mismatch has
one bounded reload attempt; an unacknowledged warm or an unexpected extra
resident does not authorize replay. Active inference or changed ownership
prevents restoration effects.

The existing startup/periodic `profilerProjectionRecovery` resumes these
journals in both profiles, like Benchmark's startup claim recovery and
authority reconciliation. It claims a writer epoch, adopts Core recovery ownership, restores
the exact host claims, records VERIFIED then RESTORED and releases the workload.
A failed pass is retried after 1, 2, 4 … minutes, capped at an hour
(`failedAttempts`, `nextAttemptAt`). After six failures automatic recovery
stops: `operatorRequiredAt` is set, the journal keeps the reason, and the
recovery view shows "Automatic recovery stopped". Fix the cause, then unset
`reconciliation.operatorRequiredAt` and `reconciliation.nextAttemptAt` on that
`HostProfile` to resume.
All profile-run journals in a multi-host workload must have terminal runtime
observations before the shared quarantine can be restored. A saved measurement
is separate from a successful runtime restoration. A verified journal left
after an acknowledged Core release resolves from its durable release receipt.

A running single-model profile can be cancelled from its Profiler panel or with
`POST /api/profiler/pipeline/profile/:profileId/cancel`. When the request in
flight is a direct Ollama request whose model was resident at the request's
context, the cancel samples `/api/ps` and aborts it. `/api/ps` lists no
requests, but Ollama sets a runner's `expires_at` only when its last request
ends. The aborted request is terminal once, after `PROFILE_CANCEL_SETTLE_MS`
(default 15 seconds), two `/api/ps` samples are identical and the model shows
a different `expires_at` than before the abort, or is no longer loaded. The run
journal keeps the receipt (`reconciliation.cancelAbort`), and Core restores the
pinned models as after any profile. Without that proof within
`PROFILE_CANCEL_PROOF_BUDGET_MS` (default 60 seconds) the request stays UNKNOWN
with reason `PROFILE_CANCEL_STOP_UNPROVEN` and needs the restart attestation
below. Any other request (a model still loading, a streamed or Core-routed
request) is not aborted: the cancel lands at the next checkpoint, once it has
returned. The panel shows which case applies and the remaining proof time. The
profile ends as `cancelled`. Prefer it to restarting Ollama, which leaves the
interrupted request UNKNOWN. A profile inside a host queue has no cancel of its
own (`409`); the queue is cancelled instead.

The same proof applies when the deadline of such a request expires, in any
profile run (single, host queue or pipeline). For example, a CPU context probe
step that outlasts `CONTEXT_PROBE_CPU_TIMEOUT_MS`. The run samples `/api/ps`,
aborts the request and waits for the stop proof. Proven: the journal keeps the
receipt (`reconciliation.deadlineAbort`), the step is recorded as timed out at
that context, the probe sends no further request, and the profile completes with
the context verified below it. Not proven: the request stays UNKNOWN with reason
`PROFILE_DEADLINE_STOP_UNPROVEN`, the profile fails with that explanation and
needs the restart attestation below. A request that cannot carry the proof (a
model still loading at the deadline, a streamed or Core-routed request) keeps
the client deadline and stays UNKNOWN when it expires.

A watchdog probe is admitted only on a host where Core has admitted nothing
else: on a host that serves one request at a time it would otherwise queue
behind a slow call, hit its own deadline and quarantine a host that was
answering. A refused probe is skipped until the next cycle.

A probe exercises only a resident that is there to stay (`keep_alive` -1). A
model loaded for a while, by a judge or a one-off call, is left to expire: the
probe carries `keep_alive` -1 and would otherwise keep it on the host forever.
With no such resident the watchdog checks that the runtime answers, without
loading or touching a model.

An UNKNOWN inference (not a workload) is released by the watchdog without a
runtime restart for a watchdog probe or a connection Core closed itself.
A watchdog probe is released after
`WATCHDOG_PROBE_RECOVERY_SETTLE_MS` (default 10 minutes). A caller abort, where
Core itself closed the upstream connection after a client disconnect, a busy
reply or a superseded turn, is recorded with `unknownOrigin: caller-abort`:
Ollama cancels a generation whose connection closed, so it is released after
`CALLER_ABORT_RECOVERY_SETTLE_MS` (default 60 seconds) when its model is
resident at the request's context, and after the full probe window otherwise
(a model load may still be running). Both require nothing else Core admitted on
the host and two identical `/api/ps` samples; the release receipt keeps the
evidence. An abort triggered by Core's own inference deadline is recorded as
`unknownOrigin: deadline-abort` and follows the same proof, with a distinct
`agentx.inference-deadline-recovery/v1` receipt.

When a Benchmark test reaches its deadline or is stopped, the exact host claim
release can close new Core dispatch on that host (`drainingHosts`). The workload
remains held: its inferences must all carry the same parent admission and
generation, and only Core caller/deadline aborts qualify for automatic recovery.
The watchdog always waits the full probe settle window under this parent,
then checks stable residency and the exact coordination proof atomically.
Benchmark polls explicit, matching pending-drain receipts for at most 12
minutes while retaining its workload heartbeat. Core renews the exact host
claim during this wait. Only after the child quarantine is released does the
normal finalizer restore and verify the pre-claim snapshot, before releasing
the parent workload. An invalid receipt or elapsed wait retains ownership for
recovery. Profiler workloads and unrelated inferences do not qualify.

A host the workload holds as shared (a judge-only host) has no claim to
release, so no dispatch is closed there. Its own caller and deadline aborts
follow the ordinary rule above instead: released after
`CALLER_ABORT_RECOVERY_SETTLE_MS` when the model is resident at the request's
context, after the full window otherwise, while the workload stays held. The
models resident on that host then serve other callers again without waiting
for the execution host. The receipt names the parent workload with
`sharedHost: true`.

A runtime disconnect is released the same way without an operator: when the
runtime end closes the connection of a dispatched request that Core had not
aborted (a socket hang-up, a reset, a stream cut before its end), the runtime
died or was restarted. Core releases that quarantine after the full
`WATCHDOG_PROBE_RECOVERY_SETTLE_MS` window (ten minutes by default) once two
`/api/ps` samples are identical and nothing else it admitted touches the host.
The release rests on a quiet runtime, not on an observed restart; the receipt
says `agentx.runtime-disconnect-recovery/v1`. Under a Benchmark workload it
applies once that workload's owner is gone; the workload keeps its own
recovery.

A lost heartbeat or a runtime bridge quarantine still needs the restart
attestation below.

For an UNKNOWN workload, use this operator sequence:

1. Inspect the exact operation's journal, Core workload admission and benchmark
   claim. Preserve the evidence and respect the instance's current writer.
   Never clear `benchmarkClaim`, delete the admission or edit residency state
   to make an unavailable host appear ready.
2. If `serverTerminalObserved` is true, the recovery worker can adopt after the
   previous owner is no longer live. It reloads and verifies the saved resident
   set, embedding models included. Failure keeps quarantine for a later sweep.
3. If a dispatched request lacks its terminal response, process death, quiet
   telemetry and lease expiry do not prove that Ollama stopped. Stop the old
   profiler writer and arrange an authorized controlled runtime restart. After
   independently verifying termination, use the existing Benchmark endpoint
   `POST /api/profiler/hosts/test/recovery/:hostId/confirm-runtime-restart` with
   the exact `operationId`, `runtimeInstanceId`, `restartedAt` and confirmation
   `RUNTIME_RESTARTED_AND_OLLAMA_REQUESTS_TERMINATED`. Each ambiguous host needs
   its own attestation. This is a restart receipt, not a request to restart.
4. Verify the recovery receipt, cleared exact host claims, workload release and
   live resident/GPU state independently. Do not infer conversation or device
   acceptance from a cleared journal. A batch quarantine with no journal
   record (its owner died before writing one) is journaled by Benchmark
   itself, at startup and every five minutes in the full profile: once the
   batch is terminal and the original owner is no longer live, Core reads the
   exact recovery identity back to the principal that armed it and the
   ordinary worker lifts the quarantine. A reconciled batch keeps the
   `authority_reconciliation_reason` its own code recorded, such as
   `execution_crash`; the worker writes its reason only on a batch without
   one. Any other orphan without a durable
   journal requires owner-led reconstruction of the exact admission proof;
   the worker does not invent it from a host label.

Profiler context recommendations describe their measured workload. A result
measured with one model does not establish that the same context fits alongside
embedding or other pins. Preserve benchmarked Modelfiles. A pin context changes
only through the Profiler proposal described in
[pin context proposals](PROFILER_CONTEXT.md#pin-context-proposals).
