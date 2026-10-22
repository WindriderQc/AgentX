# Coding Team: multi-host and multi-harness architecture

## Decision

The Coding Team has one product protocol and replaceable local harnesses. Core
owns task selection, durable request identity, host choice, budgets, admission,
result reconciliation and delivery. DSH, OpenCode, or a later harness owns only
one bounded coding session inside the workspace the host runner gives it.

This deliberately does **not** standardize every worker on one harness. A single
harness would simplify qualification, but would also make its session format,
tool names and release cycle part of Core's task contract. The stable boundary
is smaller:

1. Core selects an executor and saves its `executorId` with the request before
   launch.
2. Every executor exposes `coding_dispatch_control.py`'s status, launch, stop,
   observe and reconcile protocol.
3. The host runner supplies the same isolated workspace, Core model relay,
   budgets, native claims, verification and publication flow to every harness.
4. A harness adapter translates one prompt into its native non-interactive CLI.
   It cannot become the task queue or publish by itself.

## Executor registry

`CODING_EXECUTORS_JSON` is a private deployment value forwarded to Core. It is
an ordered JSON array of one to 32 entries:

```json
[
  {
    "id": "linux-dsh-a",
    "label": "Existing DSH worker",
    "harness": "dsh",
    "sshTarget": "worker@example-a",
    "remoteRoot": "/srv/agentx/AgentX",
    "profiles": ["code", "report", "autonomous"],
    "priority": 10
  },
  {
    "id": "linux-opencode-b",
    "label": "Second local worker",
    "harness": "opencode",
    "sshTarget": "worker@example-b",
    "remoteRoot": "/srv/agentx/AgentX",
    "profiles": ["code", "autonomous"],
    "priority": 20
  }
]
```

The host names above are synthetic. Instance host inventories stay outside the
public repository. If the registry is absent, the existing
`CODING_DISPATCHER_SSH_TARGET` and `CODING_DISPATCHER_REMOTE_ROOT` values create
one `default` DSH executor, so an existing installation keeps its behavior.
An instance should first register its incumbent worker explicitly, retaining
the legacy pair for rollback, before adding new hosts. `label` is the bounded
operator-facing machine name shown in the Coding Team monitor; `id` is the
stable receipt and routing identity.

Status is aggregated. The UI lists every reachable/unreachable executor and
its harness, while duplicate task candidates from several hosts appear once
with their available-worker count. Candidate rows retain all compatible
executors so a code or report launch binds a host that supports that profile. Once a
request is submitted, the browser, report resume and autonomous journal retain
that executor. If an old receipt lacks the binding, Core asks every executor
for the exact request. One receipt establishes the owner; two receipts are a
conflict; an unanswered executor keeps an otherwise absent request uncertain.
Core never moves an accepted or uncertain request to another host.
The host reports its installed `AGENTX_CODING_HARNESS`; Core refuses a registry
entry that claims a different harness. Current entries also require distinct
SSH targets because the host controller owns one fixed native unit.

The remote controller currently requires a POSIX SSH endpoint. A Windows host
may participate through a Linux VM or WSL distribution, but Core must target an
SSH service inside that Linux environment; a Windows SSH endpoint that opens
PowerShell is not compatible. Keeping the transport uniform avoids embedding
host-specific shell quoting and `wsl.exe` lifecycle behavior in Core.

Each registry entry currently represents one native host unit and therefore
has capacity one. More concurrency is expressed with more executors, not by
starting hidden children behind a host lock.

## Harness adapters

`AGENTX_CODING_HARNESS=dsh` is the default. It uses the released DSH headless
profile and the existing guard patch. DSH's internal workflow/subagent tools
stay off for this lane: Core and the runner must be able to see every work unit
and model receipt.

`AGENTX_CODING_HARNESS=opencode` uses OpenCode's non-interactive `run` command.
Set `AGENTX_OPENCODE_ROOT` to a reviewed, self-contained installation and
optionally `AGENTX_OPENCODE_ENTRY` to its relative executable (default
`bin/opencode`). The adapter supplies an inline configuration that:

- routes the selected model through the same loopback Core relay;
- allows source reads, edits and shell tests in the mounted workspace;
- disables nested tasks, external directories, web tools and default plugins;
- disables model-list downloads, LSP downloads and auto-update for the run.

OpenCode is mounted read-only. Its writable state remains in the worker's
private home. It does not receive Core or GitHub credentials. This adapter must
be qualified with the installed version before its executor is enabled; source
tests only prove command/config generation.

Codex and Claude remain useful interactive/cloud coding clients, but they are
not local-AI Coding Team harnesses. A host on which those clients happen to be
installed can still run a separate local DSH or OpenCode executor.

## Core-owned distributed code steps

The planner runs once under the selected root executor, freezes the reviewed
source plan and submits it to Core. Core derives serialization edges for
overlapping paths and locks, persists the resulting DAG and dispatches each
ready step to a distinct available executor other than the root coordinator.
DSH and OpenCode receive the same immutable step manifest; harness choice stays
an executor property and never changes task semantics.

The distributed engine keeps these rules:

- Core owns a durable task graph; a model may propose steps but cannot grant or
  dispatch them.
- Each step has an exact base commit, allowed paths, dependencies, executor,
  model-call budget, test profile and terminal receipt.
- Independent steps use separate Git worktrees/branches and may run on separate
  executors. Dependent or overlapping steps serialize.
- The runner, not a harness, verifies commits and focused tests. The root
  coordinator incrementally assembles verified Git bundles in DAG order;
  conflicts, failed final verification, verification source mutation and
  publication refusals proven before an external effect produce a durable
  terminal receipt instead of leaving the graph pending. Final-test duration
  is charged once to the graph's aggregate work and test budgets.
- Publication happens once from the assembled branch. Sub-workers never push,
  open pull requests, merge or deploy.
- Lost launch or model replies retain the original work-unit identity. They do
  not create a replacement on another host.
- A publication whose effect may have been sent remains on its original
  publication identity and resumes with read-only reconciliation only. It is
  neither terminalized from missing evidence nor pushed or posted again.

Every child attempt has its own request, executor, base commit, budget,
inference journal and result receipt. Uncertain launch or inference outcomes
remain fenced on that identity. Aggregate reservations cannot exceed the root
budget. The assembler imports immutable one-commit Git bundles, runs the final
independent verification and publishes the established task branch once. The
root then records the one native task verdict; it never falls back to a hidden
single-host implementation after Core accepts the graph.

Pipeline projects the graph, host and harness selection, focused tests, commit
and adoption receipts, waits or failures, aggregate usage and final publication
without exposing private manifests, host targets or local paths.

## Qualification

CPU tests cover registry validation, legacy fallback, pooled candidate status,
explicit routing, cross-host receipt discovery, unavailable-host uncertainty,
waiting cancellation, DSH invocation, OpenCode command/config generation,
parallel independent steps, dependency and overlap waves, host loss, aggregate
budgets, exact restart recovery, deterministic adoption and one final
publication.

Installing or invoking either harness with a live local model is heavy work.
Queue that qualification under the instance procedure, link the executor and
task/issue, and retain the native request and release receipts. A passing dummy
CLI or source test is not live acceptance. Harness comparison is an operational
qualification input for executor priority, not a different Core protocol and
not a prerequisite for enabling another already-qualified worker.
