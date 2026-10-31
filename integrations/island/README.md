# Island runner safety

## Operator cohorts on a shared remote island

`cohort_runner.py` starts two or three distinct harnesses (`codex,dsh,pi`)
against one already prepared remote island. It takes the existing runner start
lock and active marker, so ordinary single-agent starts cannot overlap it. It
calls the native supervisor for every member, with deterministic child run IDs,
separate relay ports, delegated-world state, sessions and fresh memory. Provider
credentials, sandboxing, episode monitoring and cleanup remain native. The
principal alias and supplied pinned context are unchanged. Members receive a
five-minute startup allowance because the shared provider can serialize replies.

This is an operator CLI, not a new Benchmark launch button. Queue the cohort as
one operator-executed heavy-work request covering its hosts; retain native Core
admission. After the dispatch fence, prepare the remote world **once**, then:

```
python cohort_runner.py check --run-id <uuid> --context-window <pinned-context>
python cohort_runner.py start --run-id <uuid> --dispatch-id <core-dispatch> \
  --world <remote-world-id> --harnesses codex,dsh,pi --minutes 15 \
  --context-window <pinned-context>
python cohort_runner.py status --run-id <uuid>
python cohort_runner.py stop --run-id <uuid>
```

The existing runner configuration supplies the world, templates and binaries.
`--config` selects it explicitly. For an operator-only staged copy, use the
installed runner's Python and put its integration directory on `PYTHONPATH`;
this consumes the installed supervisor without changing privileged files.
Qualify with a separate one-minute `--netcheck` cohort first. It has no upstream
inference connection. Reset the world once between qualification and real play,
never between members. Existing run IDs, including partial preparation, refuse
another start. Status never launches a replacement.

The cohort receipt proves **local** member termination and process observation.
Unproven cleanup retains the existing active marker for owner reconciliation.
The coordinator must separately observe Core's exact-dispatch operator release
before finishing the queue request; local cleanup is not physical GPU release.
World recording stays with the remote world's native owner. This CLI does not
choose a model, change permissions, reset the world, or create another queue.

## Remote instance identity and session departure

The remote health probe retains `instanceId` and `recordingId` in the native
request/status. When world preparation supplies an identity, the executor passes
`--expected-instance`; the runner refuses a different instance before creating a
run or spawning a supervisor. The delegated relay pins the observed instance in
`X-World-Instance` on every upstream call. Replacing an island with the same type
therefore fails the existing watchdog instead of reconnecting into another run.
Cohort preflight retains the same identity for every member.

The relay tracks only sessions it joined and calls the existing `POST /leave`
for those capabilities at orderly shutdown, including signal handling. It never
resets a cohort's world. A hard kill can prevent departure; the world marks
unrefreshed presence `idle`, and restored avatars begin idle. Spectator traffic
cannot establish agent activity. Native Core admission/release remains separate.
Legacy world servers without instance IDs remain usable through their older
protocol; Benchmark does not offer identity-bound run live links for them.

The memory report exposes all four files in the persistence contract, including
`EPISODIC_MEMORY.md`. Missing files and bounded tail truncation are explicit;
reporting never mutates the persistent memory store.

## Single-agent execution

The native `island_runner.py` and `integrations/operations/island-executor.cjs`
are the execution path for Benchmark's island tab. `run_island.py` supplies
its episode loop; `llm_proxy.py` and `run_state.py` own the bounded transport
and filesystem helpers. These do not create another queue or viewer. Renderer
selection and runner SSH/host placement retain their existing interfaces.

## Required Clawblox adapter

Apply `clawblox-isolation.patch` to upstream Clawblox revision `8be90a0` in a
separate checkout, then build its CLI and Python package. Upstream is
[nacloos/clawblox](https://github.com/nacloos/clawblox), MIT licensed; the notice
is in `CLAWBLOX-LICENSE`. The patch includes network/PID/IPC isolation, hidden
host sockets and operator variables, interactive replay parsing, refusal when
required relays cannot be created, and exclusion of the owner's Codex login,
rules and skills. The Python package exports `agentx_isolation_version()`:
version 1 serves Codex; version 2 adds the one-turn harness adapters `dsh`
(DeepSeek Harness, `dsh headless`) and `pi` (`pi -p`). Both readiness and
episode startup refuse an adapter older than the requested harness needs.
Controller HOME is never reassigned.

DSH and pi answer one prompt and exit, so the v2 adapter runs them through
`harness_loop.py` inside the sandbox (the patch embeds the same file as
`src/agentx_harness_loop.py`; a test keeps both identical). The loop keeps one
session per episode, continues it with the auto-continue prompt like Codex's
Stop hook, writes Codex-shaped rollouts to `~/.agentx-loop/sessions` for the
supervisor and the replay, and pauses after a turn with no model output or an
error. The generated HOME holds only the provider config (local relay URL,
alias, capability variable name) and loop state; DSH's subagent, workflow,
title, telemetry, web and DeepSeek-account plugins are disabled.

Both generated model entries explicitly advertise `input: ["text", "image"]`
for the Core provider. The SDKs otherwise default an unknown logical alias to
text-only and refuse image tools before Core receives anything. This describes
the gateway's existing image contract (native vision or Core's native image
description fallback); it does not select another model or grant a new route.
Build the Python package from the current patch, not just any adapter reporting
isolation version 2. Preserve the artifact/source identity in qualification.

The only LLM relay from the sandbox leads to a per-episode loopback HTTP proxy.
It authenticates a new ephemeral capability and accepts exactly
`GET /api/llm/v1/models` and one inference route: `POST /api/llm/v1/responses`
for Codex or `POST /api/llm/v1/chat/completions` for DSH and pi. The other
inference route refuses like any unknown path. Discovery returns only
`agentx-primary`, and inference bodies must select that alias. Other paths,
methods, queries and encoded alternatives refuse. Core still owns admission.

The real gateway token and upstream URL stay outside the sandbox. Configure a
dedicated client in the instance's `AGENTX_LLM_GATEWAY_CLIENTS` secret; do not
reuse another harness's token. The proxy does not follow redirects, forward
arbitrary client headers or retry inference. Responses including SSE stream
through the existing gateway. Remote upstreams require TLS with normal
certificate verification; HTTP is accepted only for loopback upstreams. Bodies
are bounded to 8 MiB. `gatewayBaseUrl` may name the explicit `/api/llm/v1` base;
the existing `gatewayHost` configuration remains supported.

## Honest completion and memory

The supervisor uses one episode loop for process monitoring, initial activity,
stall recovery, memory reminder and cleanup. Early exit, no initial model
activity, stale final activity, failed/exhausted resume, failed/incomplete
netcheck or cleanup failure produces a failed result. SIGINT/SIGTERM produces
stopped, not completed. A completed duration is not a scientific success claim.
Readiness checks use the requested agent and harness before the dispatch mark.
The start and supervisor share a lock through the parent's last state write;
a fast startup failure cannot be overwritten by a stale starting state. Memory
preparation errors before execution prove that no local runtime was started.
Error traffic and metadata do not refresh the last timestamp of model output.
Session activity is read incrementally with a bounded record buffer. Oversized
image tool results are skipped without losing the preceding model timestamp;
they neither prove new model activity nor trigger a false idle observation.
Only the selected session is cached. A new session, rotation or truncation
invalidates that observation, so an hourly reset cannot inherit activity from
the previous session. No image bytes or transcript are written to a new store.

The native per-agent store copies only `SOUL.md`, `EPISODIC_MEMORY.md`,
`EPISODIC_MEMORY.jsonl` and `SEMANTIC_MEMORY.md`. All must be bounded regular
files; symlinks and malformed episodic JSONL refuse. Tools, credentials,
sessions and recordings are not transferred. `continue` uses this store;
`fresh` starts from templates and leaves the existing store untouched.
The optional direct episode entry also supports `--memory-from` for a terminated
previous episode. Native run IDs remain single-use.
Memory snapshots read at most the displayed tail, and file reads reject
symlinks and non-regular files using the opened descriptor.

## Release and uncertain responses

The per-run inference proxy drains an existing Core response after the harness
disconnects, discarding late text rather than closing Core's admitted request.
This also covers memory reminders and hourly context resets. It never retries
the inference or declares its physical release. During final proxy shutdown,
new dispatches refuse and existing responses get a bounded sixty-second drain.
A drain timeout fails local cleanup; native Core recovery/release remains
required. A genuine incomplete provider stream is never treated as successful.

The runner serializes local starts and returns typed process observation and
local cleanup evidence. A failed `pgrep` never becomes an empty process list.
The executor persists begin intent before dispatch; any existing local ledger,
including a lost begin answer or corrupt ledger, refuses another launch.
`island-settle` follows the exact native request/dispatch without launching.

Before attesting release, the executor requires an exited supervisor, proven
local cleanup, a successful empty process observation, and a fresh
`agentx.operator-release/v1` response from Core for that exact dispatch. This
native read accounts for workloads, inferences and physical aliases, including
quarantined holders. Missing or malformed evidence keeps the request open.
Core rechecks at `operator-finish`; a holder arriving after the read still
refuses completion. A lost finish answer is resolved from the same terminal
Core receipt before any further finish attempt.
Missing or malformed native runtime records refuse terminal attestation too;
an earlier successful release observation is insufficient on its own.

## Offline comparison measurements

`run_metrics.py` counts world commands from native recordings, independent of
whether the harness used curl, a helper script, or several calls in one tool.
Local `recordings/*.clawrec` files prove input attempts only: that schema has
no per-input result, so success counts/rates remain unknown. An explicit remote
GraphysX recording also provides each command's own result:

```
python integrations/island/run_metrics.py <finished-run-dir> \
  --world-recording <native-world-recording.ndjson> --agent <exact-agent-name> \
  --start-tick <first-run-tick> --end-tick <last-run-tick>
```

Preserve the fresh-world preparation receipt and terminal recording boundary
with the private run evidence. File selection and bounds must correspond to
this run; a format-valid file alone does not prove campaign attribution. Names
are matched exactly in shared worlds. Native replay resumes supersede the old
action branch. Missing, malformed, ambiguous or unfinished evidence never
becomes zero successful actions. A stale `PlaceSuccess` attached to `MoveTo`
is not counted as a placement. Native episode windows supply the rate duration,
excluding context-reset downtime and final cleanup. Incomplete episode windows
have no rate. Tool-derived counts remain labelled `toolProxy` diagnostics.

Provider token and cancellation accounting comes from Core's exact terminal
requests; rollout token counters are explicitly labelled and cannot supply
tokens per successful placement. Failed runs remain visible in summaries but
do not improve the means for completed runs. These measures do not rank
invented games; blind replay review and controlled campaign conditions remain
separate requirements. Real transcripts, recordings and result reports stay
outside the public repository.

## Remote worlds

`remote_world.py` lets the runner use a world that is already running elsewhere (for
example a GraphysX world service behind the instance's HTTPS proxy) without changing the
runner or the Clawblox adapter. Clawblox starts it as a delegated world (`[run] command` in
the world's `world.toml`, `WORLD_HOST`/`WORLD_PORT`); it relays only the agent routes of the
world protocol (exact list in the module), forwards only `X-Session` and `Content-Type`,
refuses redirects and cookies, requires verified TLS off loopback and listens on loopback
only. The agent still reaches only its capability proxy, which reaches the relay. The remote
world keeps recording, resume, spectating and images. A model-free netcheck through the
relay passed 23/23 on devX (2026-10-29), with direct access to the world refused from the
sandbox. Instance settings (the world folder with its target URL, the runner host firewall)
stay in the instance repository.

An instance may guard that relay with `--access-token-file` (a runner-owned regular
file, mode 0600) and `--expect-world <world-id>`. The relay adds `X-Island-Access`
outside the sandbox, replaces a caller-supplied header, and refuses a different
world. `--probe` reads health and API access without joining. `check --world …`
and `start --world …` refuse an unavailable or wrong remote world before starting
an episode. During play the runner watches the relay's health; sustained failure
or an unreachable world at completion fails the run while retaining cleanup.
`worldHealthSeconds` and `worldDownSeconds` configure its default 30-second
probe interval and 120-second failure threshold.

`AGENTX_ISLAND_WORLD_PREPARE` optionally names an absolute instance hook executable.
The queue calls `check <runner-world>` before dispatch and
`prepare <runner-world> <queue-request-id>` after the durable fence, before runner
start. Each prints one JSON object: `{ok, managed, world, recordDir, message}`.
The hook owns deployment choices, credentials and world selection; it must refuse
if another session owns the world. With a hook, preflight checks runner/harness
readiness separately because the selected terrain may not be running yet. Runner
start still validates that terrain after preparation. A preparation refusal is
recorded as not started. The immutable ledger, terminal receipt and Benchmark
report retain its world and recording directory, including when settling later.
The terrain UI is configured through `AGENTX_ISLAND_WORLDS` (see the terrain
selector change); these guards do not create a second world catalogue or viewer.

## Tests without models

```bash
python3 -m unittest discover -s integrations/island/tests -v   # includes test_harness.py
node --test integrations/operations/tests/island-executor.test.cjs integrations/operations/tests/heavy-work-queue.test.cjs
```

The tests use synthetic loopback upstreams, fake runtime processes and isolated
files. When bubblewrap is installed, a real network namespace/Unix relay test
checks that the general Core-shaped paths refuse while the model route works.
Core's tests also use a disposable MongoDB to cover a holder arriving between
release observation and terminal CAS. No test calls a model or production queue.

The native runner's `start --netcheck` runs a model-free stand-in for the
selected harness (`netcheck_probe.js`; for DSH and pi it also drives the v2
turn loop) with a proxy that has **no upstream**. Its authenticated call on
the harness's inference route must return 503 and the other route 403, so
positive network checks cannot infer. DSH and pi also check their generated
provider config (`harness-config`). Every required check in `netcheck.json`
must pass; missing/failed checks fail the episode. Instance `netcheckBlocked`
URLs add direct-network checks. Run only with the patched Clawblox package in
a disposable environment when qualifying source changes; this is not deployment
or model acceptance. [ISLAND.md](../../docs/ISLAND.md) retains the UI and host
configuration procedure.
