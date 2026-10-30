# Island runner safety

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
