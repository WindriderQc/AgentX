# Status

AgentX is one active repository with optional profiles and capabilities.
Core, Benchmark and RAG run together; Data is optional. Application ports bind
to loopback. Family devices use the LAN HTTPS [private gateway without a human code](PARENTAL_ACCESS.md).
The runtime baseline is Node.js 24 with Express, MongoDB, Qdrant, Ollama and Docker.
Instance configuration, data and deployment receipts remain outside Git.

## On main

- **Human access.** Private LAN HTTPS entries open human pages/APIs directly,
  without an account, code or adult cookie. Native credentials and business
  boundaries remain separate. [Voice ID](VOICE_ID.md) is a design proposal only;
  this repository change does not establish deployment or device acceptance.

- **Surfaces.** The full profile serves Nestor (`/dad`), Household (`/panel`),
  Reader (`/lecture`), animal sounds (`/kids/sounds`), PsyX (`/psyx`) and the
  Data Toolbox (`/data-toolbox`), read-only except naming or acknowledging a
  network device. The `demo` profile keeps chat,
  model discovery, RAG and Benchmark. Core owns one common home at `/`,
  `/portal` and `/ecosystem`; full-profile navigation groups Personnel, Famille
  and Atelier, with Système as the secondary menu. Household, PsyX and Data
  use the same navigation catalogue as Core, Benchmark and RAG. Every served
  page is reachable from navigation or a contextual link; a shared test fails
  when a page has no link or a menu entry has no page.
- **Core ownership.** Conversations, selected notes, tasks, attachments and
  memory reads have one owner each, in Core. Surfaces and native harnesses
  (OpenClaw, VoiX, Data collectors, usage and memory-review tasks) call those
  capabilities. Core also owns user-confirmed conversation points; PsyX and
  personal Nestor share their editor and continuation context. Optional local
  drafts disclose coverage and require confirmation; concurrent edits refuse
  rather than overwrite. Exports and erasure cover the saved point. Core also
  persists independent optional-context and performance preferences for
  Playground, PsyX, personal Nestor and Famille. Their shared editor explains
  resource effects, offers presets and requires an explicit save; Famille
  controls live in the parental space.
- **Conversation recovery.** Playground retains accepted requests and response
  bytes in Core. Owners can download refused or interrupted exchanges without
  sending the request again. Completed retries replay the saved response;
  unknown outcomes do not start another inference. Conversation erasure also
  removes associated recovery content and rejects late writes across workers.
  Canonical transcript pages and complete payload chunks keep histories beyond
  one BSON document readable and exportable. Current-content search preserves
  owner filters, phrases and conversation-wide exclusions. Atomic root writes
  retain session counters, message identities and conditional review predicates;
  stale writers and missing content refuse explicitly.
  Ordinary Ollama calls preserve complete input and disable context shifting;
  an unqualified runtime refuses before inference. Benchmark/Profiler keep
  their intentional probes under validated workload ownership.
- **Memory.** Selected notes, an owner-only mail journal and an encrypted
  identifier vault live in Core. Nestor, the mail assistant and external agents
  on `/mcp` share the same owner notes; sensitive identifiers leave note and
  journal text for the vault when its key is set. Agents file Markdown notes
  into the owner's vault inbox when the instance names one.
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
- **Local images.** An optional full-profile studio creates and edits images
  through a local ComfyUI worker. Core retains operation identities, GPU recovery
  fences and verified archived output. The private native tool returns a
  pending operation and studio link. Household delivers this Core receipt even
  when the conversation model refuses or switches to a fallback. Operation
  observation never creates another image. Profiles and physical GPU placement require
  instance qualification; see [local images](LOCAL_IMAGES.md).
- **Pipeline.** List, dossier and Planning references share Core's read-only
  next-action projection. **Needs attention** pages the engineering and
  private-lane queues separately, with an exact total or an explicit lower
  bound. An expired automation lease reads as worker state unknown, and Core
  refuses late input naming it. The dossier shows recorded attempt references,
  status transitions, versioned plans and task deliverables with integrity
  checks. Attempt timing reports coverage for observed phases, including the
  model-call waits of each attempt; startup is not yet measured. A read-only diagnosis explains stalled
  tasks and gives a stable escalation key without repairing them. See
  [operational screens](OPERATOR_UI.md).
- **Planning.** The page is a frozen historical reference. Its idea inbox is
  live: Nestor and family captures wait there until the parent reviews them.
  Coding workers receive bounded context from linked Planning objectives;
  private item content stays out, while omitted links appear by reference only.
- **Team.** Agent Ops (`/agent-ops`) projects who does what and whether it
  runs from read-only runtime evidence, when the instance provides it. Its Team
  tab shows each agent with the persona that presents it, edits a member's
  displayed name, voice, avatar colour and personality text, and creates an
  identity or another style for an agent. In Super Dad the owner can address a
  configured team member by name. Family prompts place the child temperament
  after the selected adult personality on both native and Core inference paths;
  this is verified by composition tests, not installed-runtime conversation tests.
- **PsyX.** Its welcome opens listening, the toolbox or the latest active
  session; an optional editable point of the session supports finishing and
  resuming. The conversation and composer fit the viewport while panels scroll.
  Each reply receives the context enabled in its performance settings, with
  memory fitted to its lane's budget. Review and dream availability, timing and
  read-only sources are configurable there; crisis checks remain active. A user
  may choose a frontier cloud agent
  for deep turns or for all turns when the instance names one: it is never a
  fallback, and Core keeps the conversation and its memory. Between sessions
  PsyX can select context from its conversations and three read-only owner sources
  and writes a portrait of the user; each such run is logged and can be undone.
  Messages remain whole, omitted reply context is counted, and portraits report
  the text coverage of the actual inference lane. New portrait quotations are
  checked against supplied source text; older quotations remain unverified.
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
  and Ollama reachability stays separate from GPU residency. An optional private
  physical GPU map excludes conflicting Core admissions through different
  endpoints on the same device, preserving CPU endpoint
  separation and durable recovery fences across mapping changes. A Configuration
  section shows each setting's state per service, and the operations watch
  card shows the latest report and edits the watch's switch, interval and
  language.
- **Benchmark.** Prompts span eight categories, listed once in
  `shared/benchmarkCategories.js`; the agent category scores background agent
  work (triage, review, diagnosis, watch reports, tool use) against planted
  findings. A leaderboard rank is authoritative only when every judge
  behind it holds a recorded qualification for the row's exact artifact, runtime,
  context, scoring settings, scorer version and current reference set; otherwise
  it is provisional and says why. Old verdicts without a complete saved judge
  contract remain provisional. Complete accuracy calibrations may qualify their
  explicit settings; partial case selections remain diagnostic. Ranked rows share one quality
  cohort (judge, scorer version, generation settings) and compare only
  results on prompts as the catalog holds them today: adding a prompt keeps
  earlier results comparable, editing one takes only its results out, and
  each row says which prompts it shares with the board and the leader. Each
  result carries a qualification card. The Profiler shows runtime continuity and, after a
  profile, a pin context proposal that Core applies with a speed check and
  rollback. It profiles and benchmarks CPU-resident hosts too, and leaderboard
  rows show their host's residency. `./agentx action` and the OpenClaw
  maintenance plugin prepare, start and read a bounded batch (one model, one
  registered local host, chosen categories): a start names a prepared plan,
  passes the runtime approval hook in the plugin and is never sent twice. Its
  tests use a stand-in for Benchmark; an installed OpenClaw runtime and a
  messaging channel have not exercised the approval.
- **Finance.** A personal ledger in Core accepts only statements that reconcile
  to the cent. The Wallet Beefer page (`/finance`), deterministic alerts and
  the `comptable` agent's tools read it. See [finance](FINANCE.md).
- **Data.** A native GPU collector samples `nvidia-smi` into Data; the Nerve
  Center and the Profiler label stale or missing samples as such.
- **Alerts.** A native operations relay posts selected Core alerts to a
  Telegram forum topic and records the delivery in Core. Its configured quiet
  hours defer noncritical alerts; resolution notices report when a delivered
  alert clears. An opt-in operations watch turns what the rules currently
  flag into one short model-written report, as background work for a
  CPU-resident host. An opt-in network watch raises one alert per unknown
  device, with a suggested name.
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
| Build an explicitly reviewed household RAG corpus | [#10](https://github.com/WindriderQc/AgentX/issues/10) |
| Characterize CPU spill for models exceeding GPU memory | [#11](https://github.com/WindriderQc/AgentX/issues/11) |
| Bounded capability milestones for an additional Nestor persona | [#14](https://github.com/WindriderQc/AgentX/issues/14) |
| Complete finance capability and legacy retirement | [#15](https://github.com/WindriderQc/AgentX/issues/15) |
| Qualify a reproducible thinking-mode benchmark campaign | [#16](https://github.com/WindriderQc/AgentX/issues/16) |
| Optional visual math stage for Household | [#18](https://github.com/WindriderQc/AgentX/issues/18) |
| Apply context proposals with co-resident model evidence | [#19](https://github.com/WindriderQc/AgentX/issues/19) |
| Nestor reviewer context and measured voice impact | [#20](https://github.com/WindriderQc/AgentX/issues/20) |
| Explicitly reviewed household document promotion to RAG | [#21](https://github.com/WindriderQc/AgentX/issues/21) |
| Verified local mail archive and safe provider cleanup | [#23](https://github.com/WindriderQc/AgentX/issues/23) |
| Nestor private knowledge across sources | [#24](https://github.com/WindriderQc/AgentX/issues/24) |
| Instance inventory and storage placement tooling | [#25](https://github.com/WindriderQc/AgentX/issues/25) |
| Household photo metadata and staged visual retrieval | [#26](https://github.com/WindriderQc/AgentX/issues/26) |
| Qualify French Canadian speech recognition | [#28](https://github.com/WindriderQc/AgentX/issues/28) |
| Local French Canadian voices and custom voice profiles | [#29](https://github.com/WindriderQc/AgentX/issues/29) |
| Specialist handoff acceptance and multi-speaker reply continuity | [#41](https://github.com/WindriderQc/AgentX/issues/41) |
| Qualify a small co-resident model beside the sequential 27B pin | [#60](https://github.com/WindriderQc/AgentX/issues/60) |
| Backup speech peer when the primary speech host is down | [#117](https://github.com/WindriderQc/AgentX/issues/117) |
| Secretary mailbox lifecycle: one full catch-up, then a steady service | [#130](https://github.com/WindriderQc/AgentX/issues/130) |
| Native agent job isolation and migration acceptance | [#131](https://github.com/WindriderQc/AgentX/issues/131) |
| Technical debt from the October audit | [#133](https://github.com/WindriderQc/AgentX/issues/133) |
| Action-ready personal morning brief with a stable task focus | [#176](https://github.com/WindriderQc/AgentX/issues/176) |
| Offline replay to qualify fast-lane delegation decisions | [#262](https://github.com/WindriderQc/AgentX/issues/262) |
| Fast streaming voice lane with delegation to the native agent | [#263](https://github.com/WindriderQc/AgentX/issues/263) |
| Shared voice loop follow-ups for Nestor and PsyX | [#280](https://github.com/WindriderQc/AgentX/issues/280) |
| Explain the load phase and prompt prefix reuse on first-token time | [#282](https://github.com/WindriderQc/AgentX/issues/282) |
| Keep date-only personal task deadlines on the intended household day | [#287](https://github.com/WindriderQc/AgentX/issues/287) |
| Team page: one place to see and configure an agent's identity and runtime | [#291](https://github.com/WindriderQc/AgentX/issues/291) |
| Classify personal due-today lanes in the household timezone | [#292](https://github.com/WindriderQc/AgentX/issues/292) |
| PsyX: supervisor critique of each reply | [#303](https://github.com/WindriderQc/AgentX/issues/303) |
| PsyX: intake interview, standard questionnaires and technique cards | [#305](https://github.com/WindriderQc/AgentX/issues/305) |
| Decide opt-in deployment after complete main CI | [#334](https://github.com/WindriderQc/AgentX/issues/334) |
| Coordinate speech and images on shared physical GPUs | [#342](https://github.com/WindriderQc/AgentX/issues/342) |
| Complete PsyX trust and longitudinal quality improvements | [#343](https://github.com/WindriderQc/AgentX/issues/343) |

## What a green result means

Code/tests, containers, deployment and real-device acceptance are separate
claims. A passing suite or CI run does not establish the next one. Windows,
GPU and real-phone voice acceptance remain separate from a Linux CPU demo.
