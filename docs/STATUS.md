# Status

AgentX is one active repository with optional profiles and capabilities.
Core, Benchmark and RAG run together; Data is optional. Application ports bind
to loopback. Family devices use the LAN HTTPS [private gateway without a human code](PARENTAL_ACCESS.md),
one address where Benchmark answers under `/benchmark` and RAG under `/rag`.
The runtime baseline is Node.js 24 with Express, MongoDB, Qdrant, Ollama and Docker.
Instance configuration, data and deployment receipts remain outside Git.

## On main

- **Personal agenda.** `/dad/calendar` presents up to 50 primary-calendar events
  in the instance time zone, with explicit partial coverage and a Core read
  reference for Nestor's selected view. Family-pinned devices retain their
  existing access boundary. The shared `personal_calendar` tool creates Google Calendar
  events and actual reminders, once or repeating, through the host's existing
  native Google authorization. Google owns series and popup delivery; stable
  request identities reconcile creation. Edits, moves, cancellation, explicit
  occurrence/series scope, guest changes and self-only RSVP share the same tool.
  Google ETags fence concurrent edits; Core action receipts fence uncertain
  replays. Guest effects require explicit intent and exact recipients.
  Existing Core personal tasks accept
  repeating schedules and advance once on occurrence completion. Runtime grants
  and device notification acceptance remain separate. See
  [personal calendar](PERSONAL_CALENDAR.md).

- **Content presentation.** Personal Nestor selects pages, Markdown, lists,
  tables, code and images in one content workspace with retained navigation,
  copy, expansion and closure. Analytics' inference overview provides a bounded,
  dated Core read of the same summary response and selected window. Its live
  runtime and GPU sections carry independent short-lived Core references to
  their displayed data, with explicit collector freshness and unavailable reads. Current
  browser selection, display observation and Core data remain distinct; their
  evidence stays on the canonical turn. Shared MCP and an optional owner-only
  OpenClaw adapter expose the reader. CPU/browser contracts are separate from
  installed runtime and physical-device acceptance. See
  [content presentation](CONTENT_PRESENTATION.md).

- **Energy observability.** `/energy` is a read-only shared-meter timeline backed
  by Data's existing MQTT IoT history. Instances opt in with
  `ENERGY_IOT_DEVICE_ID`; measured energy stays separate from confidence-labelled
  inference and automation estimates.

- **Automations.** `/automations` is the shared catalogue and calendar for native
  AgentX host jobs, Core backups and OpenClaw cron jobs, including native core
  functions. Identity comes from the owning scheduler; Cluster Schedule mirrors
  are excluded from executable counts. Retired mirrors have a separate archive.
  Each source reports freshness independently; unavailable sources retain bounded
  cached evidence and disable controls. Cadence, pause/resume, explicit execution,
  durable receipts and Windows inventory remain available for host jobs. OpenClaw
  and backup controls continue in their native owning screens. Its Calendar view reuses Cluster Schedule for tasks, hosts, continuous services,
  GPU capacity, measured use, placement and Core's heavy-work queue; there is no
  parallel agenda. Old schedule and host-job URLs redirect to this hub. Agent Ops keeps agent evidence and
  documentation-only obligations. See [operational jobs](OPERATIONS_JOBS.md).

- **Household daily use.** The parent view filters tasks by child, review, date
  and text, shows recorded deadlines for the next seven days, and edits open
  routines against their stored revision. Date-only deadlines use the household
  day. Nestor, its day page and the family conversation share the Core shopping
  list; purchases are checked on parent pages. Local space navigation,
  conversation starters and a character count support desktop and mobile use.
  My day opens on owner actions, with complete search, date filters and a
  revision-checked title/date editor. Separate views group mail findings by
  exchange and retain technical follow-ups and Secretary reading. Human
  acceptance chooses the personal action wording and deadline; dismissed
  proposals keep their sources and can be restored. Focus and spoken briefings
  use accepted actions, with counts taken before display pagination. Secretary
  source pages carry conservative quote-boundary context across continuation
  windows; container headers do not attribute quotations or attachments.
  Existing source text, page identities and reading receipts remain valid.

- **Heavy work.** Core stores one-off requests from operator/coding sessions,
  resource-aware planned windows, dispatch identities and executor receipts.
  The Automations Calendar view edits slots and shows estimated versus actual status. The
  operator CLI explicitly launches existing Benchmark plans and Profiler host
  queues, and tracks custom coding checks through explicit operator receipts.
  Accepted images queue before GPU work and start once within a bounded window.
  Operator and Nestor reads share complete automatic/action-required phase
  counts, responsible next actions and independent reservation counts through
  the [work lifecycle contract](WORK_LIFECYCLE.md).
  Nestor can propose/read/cancel unstarted work and read durable result alerts;
  LeadX queues preparation and approved Benchmark starts through the same entrance.
  Confirmed migration preserves legacy QUEUE.md as an archive. Code tests are
  separate from instance migration and live qualification. See
  [heavy work](HEAVY_WORK_QUEUE.md), tracked in
  [#566](https://github.com/WindriderQc/AgentX/issues/566).

- **Engineering intake.** New generic Pipeline/TODO requests start as proposals.
  The task dossier records acceptance, clarification, deferral or a reason not
  to pursue the need, separately from execution and budgets. Acceptance is bound
  to the reviewed request text; changed content requires review. Existing work
  keeps its native policy without invented history, and native reviewed source
  promotions retain their acceptance. See [work lifecycle](WORK_LIFECYCLE.md).

- **Work relationships.** Pipeline links qualified issue/conversation reports and
  related engineering tasks with scoped reasons and retained history. Exact
  lookup identifies shared work; replay-safe report admission records one
  proposal per stable report/scope identity. Native PR observations remain
  separate from task closure, installation and final acceptance. The owner MCP
  read shares Core's contract. No external status synchronization or public
  export occurs. See [work references](WORK_RELATIONSHIPS.md).

- **Work authority.** Pipeline and owner MCP distinguish declared roles from
  native executors and expose current scope, cumulative native budgets and
  unresolved requests. Revocation blocks new delegated effects while retaining
  original receipts and observation; partial stops retain unconfirmed children.
  Private-LAN access has no authenticated human principal or independent-person
  review guarantee. See [work authority](WORK_AUTHORITY.md).

- **Execution sources.** Playground and the existing inference contract select local
  Ollama or OpenClaw, with distinct model and native agent modes. Provider
  credentials and catalogues belong to OpenClaw. Model receipts attest supplied
  context, no native memory or agent prompt, zero tool executions and one native
  invocation. Benchmark model and agent cohorts remain distinct; historical
  results keep their original provenance. See [execution sources](EXECUTION_SOURCES.md).
- **Nestor page visits.** The personal conversation displays product pages
  and configured instance web services from one validated directory, including
  saved native Main results. Same-origin pages share bounded visible headings;
  external links retain service authentication and a bounded background visit.
  [Behavior and verification](NESTOR_WEB_GUIDE.md). Physical background microphone
  behavior and external service content access require separate qualification.
- **Human access.** Private LAN HTTPS entries open human pages/APIs directly,
  without an account, code or adult cookie. Native credentials and business
  boundaries remain separate. A device pinned to Famille reaches only family
  pages; "Nestor superDad" and the owner's secret phrase, heard by Core's
  speech proxy, open full access on it for a few minutes
  ([family-pinned devices](PARENTAL_ACCESS.md#family-pinned-devices-and-owner-unlock)).
  [Voice ID](VOICE_ID.md) is a design proposal only; this repository change
  does not establish deployment or device acceptance.

- **Surfaces.** The full profile serves Nestor (`/dad`), Household (`/panel`),
  Reader (`/lecture`), animal sounds (`/kids/sounds`), PsyX (`/psyx`) and the
  Data Toolbox (`/data-toolbox`), read-only except editing a network device's
  record, requesting a network scan from the active collector, publishing
  an MQTT message by hand, asking the storage collector for a scan,
  storing the owner's duplicate-review decisions (intent only: no file is deleted),
  generating or deleting a report, editing an IoT device's display name, location
  and notes, and explicitly sending a GPIO or reboot command. The IoT controls also save and
  assign versioned profiles, save daily timers, explicitly publish either to
  compatible firmware and reconcile uncertain publications against fresh
  device reports. Daily execution belongs to the device. Its IoT tab shows
  device cards, raw live graphs and sampled history; Système links directly to it.
  It also shows storage growth and Data's
  activity log. DiskX (`/diskx`) draws the indexed disks and the latest Janitor
  duplicate report in GraphysX's 3D city, presentation only, and Nestor links
  to it with the report's counts. `POST /api/graphysx/propose` turns a sentence
  from the GraphysX AgentX Center into validated world commands from the
  vocabulary GraphysX publishes (`GRAPHYSX_VOCABULARY_URL`); the page holds them
  as a proposal for a human decision and Core applies nothing. The `demo` profile keeps chat,
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
- **Optional Hermes conversation.** Personal Nestor can use Hermes behind the existing local voice and reactive avatar. Core keeps dispatch identity, transcript and terminal receipts; native cancellation and uncertain results remain fenced. Family and LLMx exclude this backend. See [Hermes conversation](HERMES_CONVERSATION.md).
- **Nestor guardian and brain.** Optional personal voice work commits the human
  request before inference. Native mode sends all work to complete Main with its
  installed tools, memory, specialists and approval contracts while the guardian
  stays available. Both share canonical Core context; Main can refresh it while
  working. Ordinary dialogue receives a real guardian response while Main runs;
  its tool work remains exclusively with Main. Adequate replies receive Main
  review without duplicate speech.
  Legacy read mode uses an isolated worker for bounded task reads and review.
  Conservative mailbox and current public-information
  reads receive an immediate saved-request acknowledgment and use isolated native
  Main web research with durable tool admission limits or Main/Secretary consultation
  while the guardian remains available. Core retains results through reconnect, fences
  uncertain dispatches and separates display, playback start and completion.
  Personal review, task workers and native consultations receive the complete
  canonical conversation separately from selected memory, including recorded
  tool evidence. Oversized context refuses rather than dropping older turns.
  The feature defaults off; text, Open, specialists and Famille keep their
  existing contracts. See [conversation work](NESTOR_CONVERSATION_WORK.md).
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
  Optional [answer tables](ANSWER_BLOCKS.md) persist through the existing history
  route and restore in Playground with a complete text version. The passive
  table contract does not yet include an automatic model-output adapter.
  Ordinary Ollama calls preserve complete input and disable context shifting;
  an unqualified runtime refuses before inference. Benchmark/Profiler keep
  their intentional probes under validated workload ownership.
- **Memory.** Selected notes, an owner-only mail journal and an encrypted
  identifier vault live in Core. Nestor, the mail assistant and external agents
  on `/mcp` share the same owner notes; sensitive identifiers leave note and
  journal text for the vault when its key is set. Agents file Markdown notes
  into the owner's vault inbox when the instance names one.
  Reviewed notes and RAG memory documents retain fact validity separately from
  recording time and keep candidate provenance through reads and reindexing.
  Historical source assertions have a separate review at `/dad/history`: source
  dates, event dates, attribution and revision-fenced decisions stay explicit.
  Retaining an action keeps it open; source review creates neither a personal
  commitment nor selected memory unless the owner keeps an assertion as a
  souvenir: a permanent owner note with its event date, people, places and
  sources, recalled by Nestor with that date, those people and the number of
  archived sources, and forgotten together with its source.
  The owner's people registry (`/dad/people`) gathers the people of person
  and important mail and of contact cards; Core proposes merges on a shared
  address or phone (a shared full name is only a suggestion), and only the
  owner merges, with undo. A person shows their exchanges and the souvenirs
  that name them.
  Nestor's private owner tool `mail_recall` searches, by meaning, a private
  corpus of person and important mail, read attachments, souvenirs and people,
  with date, people and source. It lives in its own RAG collection that only
  Core can reach; `/mcp`, Family and children never do, and forgotten items
  leave it. An
  assertion consolidated from several messages names its people and places and
  cites up to 19 sources; its souvenir keeps them all. The native archive reader verifies pinned
  originals independently of Gmail. Instance import, process qualification and
  evidence-gated mailbox cleanup are tracked in
  [#795](https://github.com/WindriderQc/AgentX/issues/795).
- **Voice.** Household and PsyX share Core's browser conversation engine, VoiX
  transport, synthesis validation, stream relay and spoken-text cleanup. Native
  voice replies use the same speech boundary; physical device adapters retain
  their own capture and playback. The loop keeps one language per turn, prepares
  clauses ahead and permits one bounded retry after a speech stream failure.
  Local early recognition overlaps microphone capture through bounded whole-prefix
  snapshots, with one active recognizer and only the latest waiting audio. Only
  coverage of the final detected speech permits reuse. Pocket speech releases
  generated prefixes while retaining a forty-millisecond final fade window.
  Browser timings separate first clause, speech dispatch/headers, response bytes
  and an output estimate including queued silence and reported device latency;
  these observations do not establish acoustic arrival.
  Household flushes its final clause before turn completion and persists browser
  voice timings; PsyX keeps its protected speech route without a timing store.
  Timed holding phrases are off by default. Conversation and explanations stay
  fully spoken; documents use a useful spoken summary and complete screen text.
  Voice choices are request-scoped; Stop or disconnect cancels upstream speech
  synthesis without starting a backup request. VoiX bounds recognition before
  upload parsing and executor submission, with separate admission for CPU Stop;
  abandoned native work keeps its place until it actually ends. See
  [agents and voice](AGENTS_AND_VOICE.md). Workshop → Voice workshop centralizes
  explicit STT/TTS tests, bounded replay, advanced listening preferences and device
  acceptance. Conversation pages keep daily controls and open the same diagnostic
  component on their current loop. Test results and physical acceptance remain
  distinct.
- **Personalities.** Household versions personalities separately from modes and
  binds them to agents on the server. An adult-authorized session can switch its
  personality between turns while keeping its agent and permissions. Turns
  distinguish the presenting speaker, observed performing agents and requested
  voice; a requested voice does not establish what the device heard.
- **Conversation paths.** Household keeps stable contracts in system/native
  instructions and variable context beside the current request. Canonical user
  text stays unchanged. Selected history messages retain their full text;
  the pack API declares the recent block window and its maximum message count.
  New family sessions can opt into direct Core inference;
  existing sessions keep their backend. Direct inference composes Core's family
  features but has no native tool loop. The personal fast lane's delegation
  definition and conversation replay are available for offline qualification;
  the production lane remains gated.
- **Local images.** An optional full-profile studio creates and edits images
  through a local ComfyUI worker. Core retains operation identities, GPU recovery
  fences and verified archived output. The private native tool returns a
  pending operation and studio link. Household delivers this Core receipt even
  when the conversation model refuses or switches to a fallback. Operation
  cards show preparation and the completed image in Nestor/Famille and recover
  accepted requests when a conversation resumes. Family drawings use a bounded
  quick preset after inference, with no private native tools. The atelier opens
  the selected operation with its brief and seed and can reuse its image as a
  reference. Operation observation never creates another image. Profiles and physical GPU placement require
  instance qualification; see [local images](LOCAL_IMAGES.md).
  An optional Qwen 2.1 Turbo recipe uses the checkpoint's eight-step schedule
  for creation and edits at Qwen's configured formats. It retains a versioned
  archived graph/export; full-size Qwen originals remain usable as parents.
  Atelier also embeds the optional Hermes imageX specialist: conversation,
  editable prompt proposals, operational console, routing facts and read-only
  profile documents. Core retains the conversations and verifies proposal links
  on generated images. Atelier preserves working briefs up to 32,000 UTF-16 units
  for Hermes preparation; the final render prompt, including explicit constraints,
  stays within 8,000. Oversized input remains visible and refuses instead of being
  cut on paste. Applying a proposal precedes explicit local generation;
  the specialist's text consultation receives no reference image bytes.
  A browser editor adds exact, editable text over verified originals, with PNG,
  standalone SVG and portable JSON exports. Reopening a project checks its
  embedded image and preserves the archived source; editing starts no GPU work.
  A **Textes dans l’image** checkbox controls no-text instructions, single-pass
  lettering or a text-free render followed by prefilled editable layers. Hermes
  recommends a method and placements in a reviewed proposal; Core preserves
  supplied exact labels. Placement is checked manually on the rendered image.
  Explicit brief constraints survive Hermes rewriting and remain in accepted
  requests, drafts and recipe exports. A browser composition sketch joins as an
  ordinary reference. Verified parent/result comparison includes a manual,
  exportable checklist. CPU composition replaces only chosen rectangles and
  verifies the exported PNG's decoded pixels outside them against the parent.
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
  **Run one task** hands a queued, unowned, non-private `agentx-coding` ticket
  to the local coding worker: a fresh clone on its own branch, a shell and the tests inside a
  sandbox without network (its one way out is the model route), then a draft
  pull request. **Follow and decide** has a coding-worker monitor with the exact
  task and launch request, observation age and a dossier link. Its attempt is
  shown only when the loaded dossier proves the request binding. The optional
  native Studio sidebar bundle links to this same monitor. Pipeline shows the host heartbeat separately from useful source
  or test progress, remaining budgets, test outcomes and the stop checkpoint.
  A controlled stop preserves source changes locally without an automatic retry;
  an inactive host without a terminal receipt stays unknown and blocks new work.
  Manual private reports keep source read-only, archive verified partial files
  on controlled stops and support explicit continuation of the same scope and
  source from a digest-bound checkpoint. Lost outcomes reconcile the original
  request without relaunch; candidate acceptance requires independent review and
  explicit complete-scope confirmation. Archive selections agree across status
  cards and board, with unknown or incomplete count evidence labelled explicitly.
  Review of that pull request and its CI is
  the gate; nothing merges or deploys by itself. See
  [the coding worker](../integrations/coding/README.md). The disabled-by-default
  [correction loop](CODING_AUTONOMY.md) records explicit engineering scope,
  linked executions, cumulative budgets and manual interventions. Core observes
  exact-head CI and resumes the same task/PR through native claims; uncertain
  publication/model outcomes remain fenced. Its code-step planner can submit a
  durable dependency graph to Core: independent non-overlapping steps run in
  isolated worktrees on other registered DSH or OpenCode executors, while the
  root adopts tested one-commit bundles in order, performs final verification
  and publishes the same single task PR. The dossier retains executor, harness,
  budget, test, commit, wait/failure and assembly evidence. Green CI ends at
  human review.
- **Planning.** The page is a frozen historical reference. Its idea inbox is
  live: Nestor and family captures wait there until the parent reviews them.
  Coding workers receive bounded context from linked Planning objectives;
  private item content stays out, while omitted links appear by reference only.
- **PsyX source coverage.** Dream portraits distinguish source items collected
  from text supplied to the model. Collection limits, stalled pagination and
  unknown task totals appear in the prompt and saved portrait coverage.
- **Inference health.** Nerve Center shows per-host watchdog success counts and
  the last probe or skip reason. Unusable, skipped and control-plane-only probes
  leave resident worker health unknown; only a completed resident inference
  establishes it. These counters cover the current Core process.
- **Retrieval input.** Reranking passes complete passages to Core. Embedding
  inputs are sent whole or refused: the provider declares its character limit,
  Core requests native context refusal, and ingestion does not index a partial
  document after an embedding or chunk-limit failure. Batch results account
  for refused documents individually. Nerve Center → Embeddings changes the
  model RAG documents use through a queued full rebuild into a new collection;
  search keeps the serving collection until the rebuild switches, and a failed
  or cancelled rebuild keeps it.
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
  explicit settings; partial case selections remain diagnostic.
  Candidate output requests above the declared 50000-token limit are refused;
  API and stored configuration share the same timeout limits. Batches can set
  `execution_config.early_stop_enabled: false` for complete prompt coverage.
  A scorer change re-opens only the grades it affects: the others are carried over to the new
  version, in the leaderboard and the coverage matrix alike.
  Ranked rows share one quality cohort (judge, scorer version, generation settings) and compare only
  results on prompts as the catalog holds them today: adding a prompt keeps
  earlier results comparable, editing one takes only its results out, and
  each row says which prompts it shares with the board and the leader. Each
  result carries a qualification card. The Profiler shows runtime continuity and, after a
  profile, a pin context proposal that Core applies with a speed check and
  rollback. It profiles and benchmarks CPU-resident hosts too, and leaderboard
  rows show their host's residency. `./agentx action` and the OpenClaw
  maintenance plugin prepare, start and read a bounded batch (one model, one
  registered local host, chosen categories): a start names a prepared plan,
  passes the runtime approval hook in the plugin and is never sent twice.
  Preflight refuses a candidate window that no profile verifies; the action
  then plans that model at its verified context, as the coverage job does. Its
  tests use a stand-in for Benchmark; an installed OpenClaw runtime and a
  messaging channel have not exercised the approval.
- **Finance.** A personal ledger in Core accepts only statements that reconcile
  to the cent. The Wallet Beefer page (`/finance`), deterministic alerts and
  the `comptable` agent's tools read it. See [finance](FINANCE.md).
- **Photos.** Core answers photo questions (smart search, people, places,
  OCR text, thumbnails) from a separate Immich server through `/api/photos`,
  with the only Immich key. Tested against a mocked Immich. See [photos](PHOTOS.md).
- **Data.** A native GPU collector samples `nvidia-smi` into Data; the Nerve
  Center and the Profiler label stale or missing samples as such.
  Advisory storage triage records the metadata sample it receives, including
  action and file-entry coverage. Maintenance JSON reports retain all received
  proposals; their Markdown overview names the displayed subset.
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
| Work intake, issue/task relationships and attributable authority | [#1011](https://github.com/WindriderQc/AgentX/issues/1011) |
| Playground screen capture through canonical attachments | [#2](https://github.com/WindriderQc/AgentX/issues/2) |
| Real-device acceptance for phone, microphone and voice | [#3](https://github.com/WindriderQc/AgentX/issues/3) |
| Principal model selection and DSH Studio qualification | [#734](https://github.com/WindriderQc/AgentX/issues/734) |
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
