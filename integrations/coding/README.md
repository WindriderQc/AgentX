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
any file of the clone and runs the tests. When it stops, the runner commits what
changed, pushes the branch, opens the draft pull request and records the result
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
  eight minutes for a busy host instead of refusing. If the worker still stops,
  the runner waits two minutes and continues in the same workspace.

## Dependencies

Packages are installed before the worker starts, in a second sandbox that has
the network and no worker. Install scripts are skipped (`--ignore-scripts`) and
the test database is prepared with the runner's own script, so nothing the
worker wrote runs while the network is open. The step is skipped while the
package files are unchanged.

A worker that needs a new package adds it to `package.json` and stops. The
runner then leaves the ticket `blocked`, with the change on the local branch and
no pull request. Handing the task back to the team is the owner's approval: the
next run installs the package and the worker continues. That install step still
has the whole network, including the host's own services; it runs registry
packages without their scripts, never the worker.

There is no file allowlist, plan approval, attempt budget or separate verifier.

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

A run has two hours by default; `--timeout-seconds` changes it. Continuous
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
