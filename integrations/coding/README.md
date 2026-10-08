# Local coding worker

**DSH Studio integration is deferred.** Its launcher reserves the inference
host for the whole web-server lifetime. Keep the code and private workspaces,
but do not enable permanent Studio startup. See
[the decision, preserved state and resumption checks](../../docs/DSH_RESUMPTION.md).

Core Pipeline is the task queue. One local worker takes one task, writes the
change and opens a draft pull request. Reviewing that pull request, with its
normal CI, is the gate. Nothing here merges or deploys.

## One run

```bash
AGENTX_CODING_MODEL=<model Core serves> GH_TOKEN=<token> \
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
  targets the patient route (`/api/hermes-openai/patient/v1`), which waits up to
  eight minutes for a busy host instead of refusing. A nonzero exit or a budget
  stop ends the attempt without an automatic retry. An explicit handoff can
  resume its local source checkpoint.

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
limit outside model waiting and tests. Heartbeats continue during those waits.

On a controlled stop, the child process group and its in-flight model relay are
closed, source changes are committed locally and the task is blocked. A failed
or unknown last observed test, changed dependency files, or a previous checkpoint
containing generated runtime artifacts prevents publication. An abrupt host
failure stays unknown for an operator to reconcile. Successful delivery opens
one draft PR and reuses it on subsequent handoffs.

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

Install DSH under `$HOME/dsh` (`AGENTX_DSH_ROOT` overrides). Runner settings
live outside Git, by default in `~/.config/agentx/coding.env`
(`AGENTX_CODING_ENV_FILE` overrides):

- `AGENTX_CODING_MODEL`: required, a model Core serves.
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
its first receipt instead of starting a second run. A lost launch reply stays
unknown and blocks another launch until the operator reconciles the host unit.
New requests use `~/.local/state/agentx/coding-run-requests`. Guarded receipts
remain in `coding-dispatch-requests`, keep their original outcomes and cannot
launch the replacement worker with the same request id.

## DSH wrappers

`dsh-studio.sh` and `dsh-headless.sh` are the older Studio and Nestor-tool
wrappers around `with-agentx-claim.js`. The coding worker does not use them.
