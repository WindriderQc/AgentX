# Local coding worker

DSH powers both the isolated coding worker and the human-operated Studio.
Studio uses Core's OpenAI gateway with request-scoped admission; an idle web
server holds no inference host. See [Studio setup and qualification](../../docs/DSH_RESUMPTION.md).

Core Pipeline is the task queue. One local worker takes one task, writes the
change and opens a draft pull request. Reviewing that pull request, with its
normal CI, is the gate. Nothing here merges or deploys.

## Autonomous corrections

Pipeline also provides the explicitly authorized, disabled-by-default
[Core-owned correction loop](../../docs/CODING_AUTONOMY.md). It reuses native
claims/capacity, prepares current Git versions, verifies and updates the same
PR, observes exact-commit CI and gives the Coding Team bounded correction turns.
Its cumulative budgets and durable publication/native receipts survive resumes.
The manual path below stays available; it does not turn routing or idea intake
into autonomous authorization.

## One run

```bash
AGENTX_CODING_MODEL=auto GH_TOKEN=<token> \
  python3 integrations/coding/coding_run.py 0903
```

`coding_run.py` claims the task in Core and clones the repository into
`~/dsh-workspaces/task-<id>` on branch `agentx/coding-task-<id>`. It installs the
dependencies of `core`, `benchmark`, `rag` and `data` and prepares the test
database, then starts DSH there inside Bubblewrap with the ticket, its
discussion and its Planning context. The worker has a shell: it reads and edits
any file of the clone and runs the tests. When it stops, the runner commits the
source changes, excluding generated caches and session transcripts. A completed
turn pushes the branch, opens the draft pull request and records the result
on the ticket (`review`, or `blocked` when nothing changed or the worker stopped
early). Running the same task again continues in its existing workspace, so an
answer on the ticket becomes a follow-up.

`auto` (the default) follows Core's `code_generation` route. Each autonomous
attempt freezes the concrete model from its native capacity claim. An explicit
`AGENTX_CODING_MODEL` remains a dedicated choice and must match that claim.

The runner uses four protections:

- The sandbox shows the worker its own clone and nothing else of the host: no
  live checkout, no instance files, no credentials. Git metadata stays read-only
  during the turn; delivery ignores Git hooks and owner filters.
- The worker has no network. It cannot reach Core's other routes, other
  services of the host, the local network or the Internet, whatever a ticket, a
  web page or a package tells it. Its one way out is `model_relay.py`: a socket
  in its home that forwards `POST /v1/chat/completions` to Core and refuses
  everything else.
- The GitHub token stays with the runner outside the sandbox. The worker cannot
  push; the runner only pushes the task branch and opens a draft pull request.
- Core admits each inference with the rest of the household's traffic. The relay
  targets Core's OpenAI gateway (`/api/llm/v1`) as client `coding-team` with
  `patient` admission, which waits up to eight minutes for a busy host instead
  of refusing. The runner reads that client's token from
  `AGENTX_LLM_CODING_TEAM_TOKEN` and the relay adds it; the worker never holds
  it; a run without the token refuses before the worker starts. A nonzero exit or a budget
  stop ends the attempt without an automatic retry. An explicit handoff can
  resume its local source checkpoint.

## Private Markdown reports

Documentation audits follow the shared
[review procedure](../../skills/agentx/references/documentation-review.md).

### Runner-owned steps (default)

The runner, not the model, owns the plan and the report (#834). One execution
keeps its single Core authority (claim, call limit, deadline, campaign window)
and runs several short worker sessions in fresh context:

- **Plan.** `coding_report_steps.py` groups pending and partial documents by
  directory. Each group fits a share of the step context, which comes from the
  lane capability profile: the measured agent step, else the measured speed
  knee, else 24k tokens. A document larger than that is reviewed in line
  ranges, one range per step.
- **Step.** The worker receives only its group, the claims already checked and
  the earlier findings for those documents. It writes one JSON result
  (`step-NN.json`) in its private output directory. A step has its own call
  and time limits; reaching them ends that session only.
- **Save pass.** If a drained step leaves no result file, the same native worker
  gets one bounded session to save JSON from that step's exact paired tool
  results. It reserves the final writer budget and uses at most four calls and
  fifteen minutes from the existing execution. Ambiguous sessions, uncertain
  calls, an operator stop or any existing result artifact prevent this pass.
  Private receipts bind its source, evidence and usage. Omitted evidence cannot
  establish completed coverage; the normal source validator still owns merging.
- **Verify and merge.** `coding_report_ledger.py` checks every cited path and
  line against the frozen snapshot, computes source digests itself and merges
  the step whole or not at all. A group that fails twice marks its documents
  `blocked` with the reason. A document still partial after three steps
  without new evidence stays partial and is reported as remaining scope.
  A document can retain up to 100 source references, matching Core coverage;
  each finding remains bounded to 40 references. Every reference is checked.
  A model output limit fails that report step and retains its native receipt;
  after Core verifies termination, other groups may continue in the same
  budget. Operator stops, unresolved calls and execution deadlines still stop
  the run. Failed corrections keep the report incomplete.
  New reviewer feedback can request `recheckDocuments` in its correction JSON.
  Only reviewed documents from the unchanged frozen inventory can reopen as
  partial. Their evidence and prior review remain recorded; the ordinary group
  review must produce any corrected note and findings before coverage returns.
  A retry receives the prior rejection reason and, when available in the same
  execution, its own rejected JSON path. It corrects that result without
  overwriting the original artifact or restarting verified research.
  Other pending groups and ranges run before failed documents are retried,
  so a difficult document cannot hold up the rest of the review twice.
  Prompts enter through a private read-only file and become the CLI task text
  inside its Node process, so Linux's per-argument size limit cannot discard
  a large save pass. Context limits and complete research receipts are preserved.
  A synchronous Node preload restores the task argument before the CLI runs
  as the native entrypoint, preserving its main guard and asynchronous lifetime.
- **Render.** After every step the runner regenerates the Markdown report and
  `coverage.json` from the ledger, so findings, tables and totals cannot
  drift, and each step counts as saved progress.
  Saved new source evidence, reviewed ranges or completed documents refresh
  the progress timer before the next session. Failure receipts, retry resets
  and reworded notes alone do not.
- **Writer.** A last short session receives only the verified findings and
  writes the summary and explanations.
- **Resume.** The ledger is embedded in the report as an HTML comment. A
  continuation restored from Core's checkpoint resumes it exactly. A report
  written before steps keeps its findings verbatim in an "earlier executions"
  section; reviewer corrections apply to it only as exact text replacements.
  Corrections can also replace an existing evidence check exactly, after the
  runner verifies its source hash and line. They retain the original text in
  the step receipt and cannot change coverage states or source references.

When calls or time run short with documents left, the execution stops with
`model_call_limit` or `hard_budget` and archives the partial report for a
continuation. The Pipeline worker monitor shows merged and failed steps,
ledger totals and the step size with its basis.
### Automatic continuation and alerts

With **Private reports continue automatically** switched on (Pipeline, Coding
Team autonomy panel; off by default), Core starts the next execution of a report
that stopped with `model_call_limit` or `hard_budget` and archived a changed
partial report (#835). It performs the same requeue an operator does, from that
exact checkpoint and under the existing grant and campaign window; Core's report
authority still binds the run when the worker starts. One continuation exists
per parent outcome, under a request id derived from it and saved before any host
call; an unknown outcome blocks the task and alerts instead of relaunching.

Whether or not the switch is on, Core alerts the owner (Core alert feed, morning
brief, Nestor's work-queue notifications) when documents are blocked, an
execution stops for another reason, two executions end with the same saved
report, a continuation needs a new grant or window, or a report is ready for
review.

### Cloud escalation of a failed step

Off by default. The owner sets the ordered models and a cost cap per task in the
same panel (default: `openai/gpt-5.6-sol`, then
`openrouter/nvidia/nemotron-3-super-120b-a12b:free`, $10), and each task must
allow it on its explicit report grant ("Allow cloud escalation of failed
steps"). An execution started with both records the models and the task's
remaining allowance, fixed for that run.

After a group fails once on the local model, the runner sends one self-contained
request: the group's documents and the source files they cite (or that define
the identifiers they name), with line numbers, plus the result schema. Core
executes it through OpenClaw's single-call model mode, trying the models in order
and skipping one OpenClaw cannot call directly; OpenClaw's own cost reservation
is capped by what the task has left, and every call is journalled on the
execution with its model and cost. The answer goes through the same ledger
verification as a local step; a second failure blocks the group. Escalated
findings are marked in the report, the Pipeline monitor counts escalated steps
and an alert records each escalation. A multi-turn tool session is not used:
OpenClaw's model mode accepts plain messages only.

`AGENTX_REPORT_MODE=single` restores the previous single-session worker, whose
prompt asks the model to choose groups, save, and keep the table and totals
consistent itself. A partial report is a reviewable checkpoint, not completion
of the requested audit.

Pipeline records an explicit **Code change** or **Private Markdown report** result
before launch. The dossier and global one-task form use the same preparation.
A report selection cannot silently become a source-writing Git run. The worker
keeps its read-only source and private output sandbox.

Queue and begin the approved campaign through the instance operator entrance,
linking the coding session, original task, required hosts and permitted window.
In the report form, name that active campaign, the per-worker call limit
(128 or 256), additional cumulative call/work credits and the maximum workers
(one to four). Giving the task records this explicit grant in Core. A repeated
grant key reconciles the same intent and never adds credit. Historical code and
report executions remain charged; an extension does not erase their costs.
The campaign window and remaining task envelope bound every native deadline.
Core revalidates campaign identity, task, host and window before dispatch and
after native admission. A planned reservation alone never permits inference.

Native callers prepare the same Core-owned selection and grant before using
`coding_dispatch_control.py launch-report TASK REQUEST_UUID ATTEMPT_COUNT review.md`.
Optional `--model-call-limit 256` selects the accepted per-worker limit; it
cannot exceed the cumulative grant. The native receipt and Core journal retain
that selection. Preparation does not launch a worker. Ordinary code and the
existing autonomous correction loop retain their own authority contracts.

The complete source snapshot is mounted read-only at `/workspace`. The report
session starts in its private per-request output directory: DSH's existing
`workspace-write` policy allows that directory only, plus its normal temporary
storage. Source commands use absolute paths or `git -C /workspace`; the worker
reads `/workspace/AGENTS.md` explicitly. DSH saves its Markdown in
`/home/agent/deliverables/REQUEST_UUID/review.md`, in its private home outside
Git. New verified report bytes count as useful progress; touching a file,
repeating bytes or model activity does not extend budgets. No dependencies,
Git publication, model/context changes or live acceptance jobs are introduced.
The report prompt announces the execution's accepted model-call ceiling. Each model request
also receives a fresh estimate of remaining calls, time and progress allowance,
with an early instruction to save and finish when few calls remain. Observed
counts can lag; Core's exact limit and the fixed deadline remain authoritative.

Core journals each call against the exact manual claim, task identity,
specification digest, local model and fixed deadline before dispatch. Unknown
native model completion remains fenced. Once completion is proven, the runner
freezes the bytes and a private delivery intent under the same stop/publication
lock. Core stores and verifies the immutable file through task deliverables and
moves the original claim to `review`. This is a candidate for independent review,
not proof of coverage or automatic completion. A later owner or specification
change supersedes only the old execution receipt and leaves that task intact.

On a controlled stop, proven native model settlement also allows Core to archive
valid, nonempty Markdown as a **partial** deliverable. The task stays blocked.
The native stop intent freezes the partial bytes and digest for replay; editing
the live output later cannot change the original receipt. Partial and candidate
files carry their request, claim, source revision and specification provenance.
If there is no valid file or termination remains unknown, do not infer a saved
checkpoint from model activity or a stopped process.

A subsequent explicit handoff continues the latest terminal execution on the
same task, at the same source and specification. Pipeline restores its exact
private checkpoint and coverage. Native callers name `--parent-request-id UUID`
and `--parent-sha256 SHA256`. When the original terminal run never produced any
file, its parent identity can be retained without a digest; an expected missing
or altered checkpoint still refuses. A terminal continuation with no new file
inherits the earlier verified bytes and coverage through its recorded parent. A fresh explicit grant is required after
an operator stop. No restart or budget increase happens automatically.

Core freezes the selected Markdown inventory and file hashes at the source
commit. The runner supplies `source-inventory.json` and an initially pending
`coverage.json`; the model records checked documents and source references as
it works. The runner checks evidence file digests and lines against the frozen
Git objects. Core stores these declarations with the result, separate from
independent review. An inventory or a changed report hash proves neither
complete coverage nor accuracy. Acceptance requires every document reviewed,
the exact candidate digest and a separate review receipt reference and digest.
The dossier exposes the whole task budget, saved files, source and coverage.

All file deposits share task-owned capacity reservations. A report grant is
refused if its workers cannot retain their checkpoints within the file limit;
ordinary uploads cannot consume promised report slots. Partial files remain
immutable, and a terminal execution with no file does not reserve space forever.

Legacy code checkpoints can be received through the Core archive endpoint
`POST /api/pipeline/tasks/:id/reports/:requestId/archive-checkpoint` with the
exact terminal transition, source revision, private `.review-work/*.md` path,
file digest, original specification digest, scope evidence and explicit native
termination/release evidence. Scope evidence is an explicit operator attestation;
Core refuses a specification that differs from the attested original. Core reads the
bytes directly through the native control and reconciles original native costs.
It retains the original worker result, labels model content and operator archive
separately, and records an operator attestation rather than inventing a successful
report execution. This archival step grants no model work or acceptance.

After a lost acknowledgement, use **Reconcile saved report** in Pipeline or the
same native `reconcile TASK REQUEST_UUID` control. Known refusals before model
dispatch retain the original claim, native start and zero-call preparation costs
on the task; a lost refusal acknowledgement reconciles the same identity. It replays a saved start allocation when needed and repairs only the original durable model settlement and frozen result;
it never reruns the worker or invents completion from an inactive unit. Inspect
partial private output after a stop. The original request, result and native
release evidence remain required before another launch. Accepting a candidate
requires a separate reviewer, the exact candidate request and digest, and an
explicit confirmation that the complete requested scope was checked. A saved
file or normal worker exit does not establish that coverage.

## Progress and stop decisions

The runner writes a private progress receipt for each launch request. Pipeline
shows the lifecycle and current stage, heartbeat, last useful progress, soft
and hard budgets, current/last test outcome, stop reason and source checkpoint.
It exposes no prompts, command lines, session transcripts or raw tool output.
The worker prompt includes its remaining budgets. Automatic model-generated
session titles are disabled: Pipeline already owns the task title, and that
background request would compete with the coding turn.
An inactive host unit without a terminal receipt remains `unknown`; it is not
evidence that the task completed.

A run has a two-hour soft budget by default. New source content or a new test
result against that content can extend it by 30 minutes, up to a four-hour
hard ceiling. Cache churn, touching files, repeated source states, repeated
identical test outcomes and model activity do not extend it. The runner also
bounds model requests (128), model waiting (22 minutes), generation (30 minutes),
tools (15 minutes) and tests (40 minutes), with a 45-minute useful-progress
limit outside an active test. Repeated model waits and reading tools cannot
reset this limit. Heartbeats continue during those waits.

On a controlled stop, the child process group and its in-flight model relay are
closed, source changes are committed locally and the task is blocked. A failed
or unknown last observed test, changed dependency files, or a previous checkpoint
containing generated runtime artifacts prevents publication. An abrupt host
failure stays unknown for an operator to reconcile. Successful delivery opens
one draft PR and reuses it on subsequent handoffs.

Pipeline's **Stop worker** requests a cooperative stop for the exact task and
request id. The host serializes it with launches and refuses a stale selection;
it never signals a shared unit. Repeated stops are idempotent. The runner polls
the private stop receipt, closes its child group and model relay, preserves raw
outputs and source checkpoints outside the product repository, and records
`operator_stop`. SIGTERM/SIGINT use the same runner cleanup. An accepted stop is
not a terminal result: Core can still drain its already-dispatched model stream
to collect terminal evidence. Verify the worker exit and Core's exact inference
completion receipt separately before declaring the model stopped. No retry
follows an operator stop. Stop acceptance and entry into publication share a
host lock: an accepted stop prevents publication; once publication has started,
the host refuses a stop that could no longer revoke its external effects.

## Dependencies

Packages are installed before the worker starts, in a second sandbox that has
the network and no worker. Install scripts are skipped (`--ignore-scripts`) and
the test database is prepared with the runner's own script, so nothing the
worker wrote runs while the network is open. Preparation is cached against the
package files and the validated Node/npm distribution, including Node version
and ABI and hashes of the Node executable and npm's bundled files and symlink
targets within the mounted distribution. External system libraries and global
Node modules are outside this artifact identity; use a self-contained Node/npm
distribution for dependency preparation. A runtime
change invalidates the cache; old package-only markers require preparation.
Network-free probes validate the selected distribution before a cache hit or
installation. Node and npm are called explicitly from that distribution, with
no fallback. Failed preparation or runtime drift cannot publish a valid marker.
The worker's package-change guard remains separate from this preparation key.

A worker that needs a new package adds it to `package.json` and stops. The
runner then leaves the ticket `blocked`, with the change on the local branch and
no pull request. Handing the task back to the team is the owner's approval: the
next run installs the package and the worker continues. That install step still
has the whole network, including the host's own services; it runs registry
packages without their scripts, never the worker.

The worker can edit the whole source tree. CI and human review remain the
verification gate for its draft pull request.

## Settings

Install DSH 0.2.0-rc.2 under `$HOME/dsh` (`AGENTX_DSH_ROOT` overrides). Runner settings
live outside Git, by default in `~/.config/agentx/coding.env`
(`AGENTX_CODING_ENV_FILE` overrides):

- `AGENTX_CODING_MODEL`: defaults to `auto`, following Core's `code_generation`
  route; an explicit model Core serves keeps a dedicated selection.
- `GH_TOKEN`: pushes the branch and opens the pull request. Unset: the commit
  stays on the local branch and the ticket says so.
- `AGENTX_CODING_REPOSITORY`, `AGENTX_CODING_BASE_BRANCH`: default
  `WindriderQc/AgentX` and `main`.
- `AGENTX_CORE_URL`: default loopback port 3180.
- `AGENTX_NODE_BIN`: optional path to the Node executable in a complete Node/npm
  distribution. It is selected before the runner imports; the same distribution
  is mounted read-only in both sandboxes. Invalid selections block preparation.

`--timeout-seconds` changes the soft budget; the hard ceiling is twice that
value. Continuous
integration tests the worker's draft pull requests like ready ones, because
its branches are named `agentx/coding-task-<id>`.

## Run one task from the Pipeline page

Core calls `coding_dispatch_control.py` over SSH (`CODING_DISPATCHER_SSH_TARGET`,
`CODING_DISPATCHER_REMOTE_ROOT`). `status` lists queued, unowned, non-private
tasks explicitly routed with `service: agentx-coding`; ordinary Core and other
Pipeline tickets remain available for their own workflows. `launch` starts
`coding_run.py` for one of the listed tasks as the transient user
unit `agentx-coding-run`. One task runs at a time. A repeated request id returns
its first receipt instead of starting a second run. After a lost launch reply,
the matching active unit means running; exact terminal progress means finished.
Missing or malformed proof stays unknown and blocks another launch. A completed
autonomous request also requires Core's recorded native result before any new
launch. Core verifies released claims, capacity and inferences before closing
its autonomous slot; the worker's exit alone never proves model release.
New requests use `~/.local/state/agentx/coding-run-requests`. Guarded receipts
remain in `coding-dispatch-requests`, keep their original outcomes and cannot
launch the replacement worker with the same request id.

## DSH wrappers

`dsh-studio.sh` prepares a private copy of native settings and points its
`agentx-primary` model at Core. It preserves the configured workspace and
isolation boundary. `dsh-headless.sh` retains its bounded-session claim wrapper;
the isolated Coding Team worker has its own native task/capacity lifecycle.

Report inference binds each native admission and generation before provider
dispatch. Core's existing queue observer retains matching native release receipts
and can reconcile an interrupted call without another model request. The report's
original UNKNOWN observation, timestamps and costs stay in its termination audit;
termination recovery does not assert model success or documentary acceptance.
The dossier's **Reconcile saved report** action then receives the original result.

A legacy call without that binding requires explicit operator mapping through
`POST /api/pipeline/tasks/:id/reports/:requestId/map-native-termination` with the
original call/prepare IDs, claim/spec/source, UNKNOWN digest and independent
mapping evidence. Its native admission is unique to that call. An operator may
archive the original native JSON receipt in the same task before the recent
runtime journal rotates; Core verifies those exact stored bytes and labels that
custody as an operator attestation. This private-LAN operation requires explicit
operator attribution and confirmation, retains the unknown observation and never
modifies runtime coordination or launches work.
