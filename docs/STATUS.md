# Status

AgentX is one active repository with optional profiles and capabilities.
Core, Benchmark and RAG run together; Data is optional. Application ports bind
to loopback. Family devices use the LAN HTTPS [parental gateway](PARENTAL_ACCESS.md).
The runtime baseline is Node.js 24 with Express, MongoDB, Qdrant, Ollama and Docker.
Instance configuration, data and deployment receipts remain outside Git.

## On main

- **Surfaces.** The full profile serves Nestor (`/dad`), Household (`/panel`),
  Reader (`/lecture`), animal sounds (`/kids/sounds`), PsyX (`/psyx`) and the
  Data Toolbox (`/data-toolbox`), read-only except naming or acknowledging a
  network device. The `demo` profile keeps chat,
  model discovery, RAG and Benchmark.
- **Core ownership.** Conversations, selected notes, tasks, attachments and
  memory reads have one owner each, in Core. Surfaces and native harnesses
  (OpenClaw, VoiX, Data collectors, usage and memory-review tasks) call those
  capabilities.
- **Voice.** Household and PsyX share Core's browser conversation engine, VoiX
  transport, synthesis validation, stream relay and spoken-text cleanup. Native
  voice replies use the same speech boundary; physical device adapters retain
  their own capture and playback. The loop keeps one language per turn, prepares
  clauses ahead and permits one bounded retry after a speech stream failure.
  Household flushes its final clause before turn completion and persists browser
  voice timings; PsyX keeps its protected speech route without a timing store.
  Voice choices are request-scoped; Stop or disconnect cancels upstream work
  without starting a backup request. See [agents and voice](AGENTS_AND_VOICE.md).
- **Personalities.** Household versions personalities separately from modes and
  binds them to agents on the server. An adult-authorized session can switch its
  personality between turns while keeping its agent and permissions. Turns
  distinguish the presenting speaker, observed performing agents and requested
  voice; a requested voice does not establish what the device heard.
- **Conversation paths.** Household keeps stable contracts in system/native
  instructions and variable context beside the current request. Canonical user
  text stays unchanged. New family sessions can opt into direct Core inference;
  existing sessions keep their backend. Direct inference composes Core's family
  features but has no native tool loop. The personal fast lane's delegation
  definition and conversation replay are available for offline qualification;
  the production lane remains gated.
- **Pipeline.** List, dossier and Planning references share Core's read-only
  next-action projection. **Needs attention** pages the engineering and
  private-lane queues separately, with an exact total or an explicit lower
  bound. An expired automation lease reads as worker state unknown, and Core
  refuses late input naming it. The dossier shows recorded attempt references,
  status transitions, versioned plans and task deliverables with integrity
  checks. Attempt timing reports coverage for observed phases; resource wait
  and startup are not yet measured. A read-only diagnosis explains stalled
  tasks and gives a stable escalation key without repairing them. See
  [operational screens](OPERATOR_UI.md).
- **Planning.** The page is a frozen historical reference. Its idea inbox is
  live: Nestor and family captures wait there until the parent reviews them.
  Coding workers receive bounded context from linked Planning objectives;
  private item content stays out, while omitted links appear by reference only.
- **Routing.** Light tasks may carry an instance-configured fallback ladder;
  every other task stays on its model. The OpenClaw conversation provider can
  borrow that ladder when the instance opts in; it is off by default. A bounded
  snapshot cache shares routing refreshes while live admission and claims remain
  authoritative. Inference logs expose reported native phases and instrumented
  agent prefix divergence, without treating missing data as zero or a stable
  prefix as proof of a cache hit.
- **Nerve Center.** Inference hosts are registered from the Nerve Center
  without a count limit; the configuration file only bootstraps the first.
  Each host is GPU- or CPU-resident, so one machine can run a GPU brain and a
  CPU brain side by side, and pin checks and alerts follow that residency.
  Resident pin sets are edited with verified add, update and rollback, with an
  optional CPU thread count per pin. Hosts show observed request concurrency,
  and Ollama reachability stays separate from GPU residency.
- **Benchmark.** Prompts span eight categories, listed once in
  `shared/benchmarkCategories.js`; the agent category scores background agent
  work (triage, review, diagnosis, watch reports, tool use) against planted
  findings. A leaderboard rank is authoritative only when every judge
  behind it holds a recorded qualification for the row's scorer version;
  otherwise it is provisional and says why. Ranked rows share one quality
  cohort (judge, scorer version, generation settings) and compare only
  results on prompts as the catalog holds them today: adding a prompt keeps
  earlier results comparable, editing one takes only its results out, and
  each row says which prompts it shares with the board and the leader. Each
  result carries a qualification card. The Profiler shows runtime continuity and, after a
  profile, a pin context proposal that Core applies with a speed check and
  rollback. It profiles and benchmarks CPU-resident hosts too, and leaderboard
  rows show their host's residency.
- **Finance.** A personal ledger in Core accepts only statements that reconcile
  to the cent. The Wallet Beefer page (`/finance`), deterministic alerts and
  the `comptable` agent's tools read it. See [finance](FINANCE.md).
- **Data.** A native GPU collector samples `nvidia-smi` into Data; the Nerve
  Center and the Profiler label stale or missing samples as such.
- **Alerts.** A native operations relay posts selected Core alerts to a
  Telegram forum topic and records the delivery in Core. Its configured quiet
  hours defer noncritical alerts; resolution notices report when a delivered
  alert clears.
- The former aiOPs, AgentX-Ecosystem and standalone component repositories are
  archived, read-only references.

## Open

Issues hold the current work and remaining acceptance:

| Area | Tracking |
|---|---|
| Playground screen capture through canonical attachments | [#2](https://github.com/WindriderQc/AgentX/issues/2) |
| Real-device acceptance for phone, microphone and voice | [#3](https://github.com/WindriderQc/AgentX/issues/3) |
| DSH Studio bounded-session runtime claims | [#4](https://github.com/WindriderQc/AgentX/issues/4) |
| Qualify benchmark judges against human references | [#6](https://github.com/WindriderQc/AgentX/issues/6) |
| Evaluate dedicated collections for family and personal tasks | [#7](https://github.com/WindriderQc/AgentX/issues/7) |
| Bounded maintenance actions through Core | [#8](https://github.com/WindriderQc/AgentX/issues/8) |
| Measure spoken-turn latency by observed phase | [#9](https://github.com/WindriderQc/AgentX/issues/9) |
| Build an adult-reviewed household RAG corpus | [#10](https://github.com/WindriderQc/AgentX/issues/10) |
| Characterize CPU spill for models exceeding GPU memory | [#11](https://github.com/WindriderQc/AgentX/issues/11) |
| Real-device acceptance for camera face unlock | [#12](https://github.com/WindriderQc/AgentX/issues/12) |
| Per-person camera profiles | [#13](https://github.com/WindriderQc/AgentX/issues/13) |
| Bounded capability milestones for an additional Nestor persona | [#14](https://github.com/WindriderQc/AgentX/issues/14) |
| Complete finance capability and legacy retirement | [#15](https://github.com/WindriderQc/AgentX/issues/15) |
| Qualify a reproducible thinking-mode benchmark campaign | [#16](https://github.com/WindriderQc/AgentX/issues/16) |
| Optional visual math stage for Household | [#18](https://github.com/WindriderQc/AgentX/issues/18) |
| Apply context proposals with co-resident model evidence | [#19](https://github.com/WindriderQc/AgentX/issues/19) |
| Nestor reviewer context and measured voice impact | [#20](https://github.com/WindriderQc/AgentX/issues/20) |
| Adult-reviewed household document promotion to RAG | [#21](https://github.com/WindriderQc/AgentX/issues/21) |
| Verified local mail archive and safe provider cleanup | [#23](https://github.com/WindriderQc/AgentX/issues/23) |
| Nestor private knowledge across sources | [#24](https://github.com/WindriderQc/AgentX/issues/24) |
| Instance inventory and storage placement tooling | [#25](https://github.com/WindriderQc/AgentX/issues/25) |
| Household photo metadata and staged visual retrieval | [#26](https://github.com/WindriderQc/AgentX/issues/26) |
| Qualify French Canadian speech recognition | [#28](https://github.com/WindriderQc/AgentX/issues/28) |
| Local French Canadian voices and custom voice profiles | [#29](https://github.com/WindriderQc/AgentX/issues/29) |
| Specialist handoff and multi-speaker reply continuity | [#41](https://github.com/WindriderQc/AgentX/issues/41) |
| Qualify backup speech readiness on CPU | [#117](https://github.com/WindriderQc/AgentX/issues/117) |
| Mail catch-up and steady-state lifecycle | [#130](https://github.com/WindriderQc/AgentX/issues/130) |
| Agent/personality migration and shared resolution | [#131](https://github.com/WindriderQc/AgentX/issues/131) |
| Durable conversation exchange and erasure coordination | [#234](https://github.com/WindriderQc/AgentX/issues/234) |
| Offline delegation replay and owner-reviewed qualification | [#262](https://github.com/WindriderQc/AgentX/issues/262) |
| Production personal voice lane with delegation | [#263](https://github.com/WindriderQc/AgentX/issues/263) |
| Shared voice microphone, resource cleanup and selection follow-ups | [#280](https://github.com/WindriderQc/AgentX/issues/280) |
| Explain direct voice load and prompt prefix reuse | [#282](https://github.com/WindriderQc/AgentX/issues/282) |

## What a green result means

Code/tests, containers, deployment and real-device acceptance are separate
claims. A passing suite or CI run does not establish the next one. Windows,
GPU and real-phone voice acceptance remain separate from a Linux CPU demo.
