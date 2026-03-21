
Used 4 references
Plan: Agent Mesh Foundation
Recommended architecture: keep OpenClaw, AgentX, and DataAPI as three separate planes with clear ownership instead of forcing one system to become everything. OpenClaw should remain the personal operator shell and conversational gateway over AgentX workflows. AgentX should remain the maintenance control room and system-of-record for repo health, bounded maintenance tasks, approvals, scheduling, and host telemetry. DataAPI should remain the deterministic data substrate and evolve only where it clearly adds value for indexing, scanning, and export. The fastest path is not agent-per-repo. The fastest path is bounded maintainer capabilities running against repo profiles, with AgentX as the orchestration plane.

Actual status

OpenClaw is already a real agent platform, not a sidecar. It has a gateway, 8 agents, cron as the source of truth for its own recurring jobs, Telegram delivery, session persistence, skills, delegation, and model chains. It is strong at personal automation, agent identity, scheduled reports, and conversational orchestration.
AgentX is already a real application platform, not just a chat UI. It has SpecialX queue-driven automation, repoWatcher, docJanitor, feature alignment scanning, validation scanning, cluster scheduling, host monitoring, analytics, workspaces, and dashboards. It is strong at observability, bounded automation, persistence, and app-facing control-plane concerns.
DataAPI is not yet a code intelligence engine. It is currently strongest at deterministic file metadata, scanning, export, storage analytics, and background-worker patterns. It can become a substrate for repo ingestion later, but today it does not provide AST indexing, symbol graphs, code contracts, or patch workflow orchestration.
OpenClaw and AgentX currently integrate mostly through observation rather than execution. AgentX probes OpenClaw health and agent inventory, and syncs OpenClaw cron jobs into cluster schedule data. There is no first-class AgentX-to-OpenClaw task dispatch, no OpenClaw-to-AgentX result callback, and no shared run ledger.
AgentX already has more repo-maintenance primitives than DataAPI. Moving maintenance orchestration into DataAPI now would slow delivery and duplicate existing work.
SpecialX is only partially positioned for the desired vision. It has bounded queue execution and audit records, but only a small set of task types and no repo-maintenance workflow model yet.
Host visibility exists in fragments. AgentX knows configured Ollama hosts, model routing, current loaded models, VRAM overrides, and schedule entries, but it does not yet maintain a complete actual-vs-scheduled usage ledger for all three hosts.
Hard decisions

Do not create one generalist agent per repo as the primary design. Create a maintenance mesh of narrow responsibilities that can operate across repos using project profiles.
Do not make OpenClaw the source of truth for application maintenance state. It should remain the operator-facing gateway and escalation shell.
Do not move existing AgentX maintenance intelligence into DataAPI in phase 1. Reuse AgentX first, then extract or backfill into DataAPI only where deterministic ingestion at scale is needed.
Do not allow autonomous code edits as the first milestone. Start with read-only findings, then patch proposals, then low-risk auto-fixes, then selective constrained autonomy.
Make AgentX the control room for AgentX plus DataAPI maintenance. Make OpenClaw the human-facing supervisor. Make DataAPI the optional scanning and export substrate.
Target end game

OpenClaw is the outer operator layer. It is where you converse, receive reports, trigger workflows, approve risky actions, and run personal automation.
AgentX is the primary maintenance system-of-record and AI-ops control plane. It stores repo profiles, health snapshots, findings, task queues, automation runs, approvals, host telemetry, and maintenance dashboards.
DataAPI is the deterministic ingestion and export layer. It scans repositories, stores file and artifact metadata, serves exports, and optionally hosts heavier background analysis jobs when needed.
Maintainer agents are responsibility-based, not repo-based. Initial agent set: Code Steward, Test Guardian, Docs Janitor, Architecture Reviewer, Data Contract Checker, Ops Runtime Guard, and Repo Intake/Indexer.
Every maintainer capability operates against explicit project rules: purpose, critical paths, forbidden edit zones, test commands, build commands, deployment paths, risk class, and approval policy.
Every action has a proof trail: extracted facts, impacted files, confidence, proposed patch, validation steps, approval state, and result metrics.
Architecture conclusion

The earlier idea that AgentX is simply the single HQ and OpenClaw is just another node is too simplistic. OpenClaw is a real operator environment for the broader daily AI system, but it should not own AgentX internal maintenance state.
The better framing is layered control. AgentX is the app-maintenance and AI-ops control plane. OpenClaw is the user-control, delegation, approval, and notification shell over AgentX workflows. DataAPI is the deterministic data plane.
For the vision of an agent using the code and helping maintain the code, AgentX is the best foundation to productize first because it already contains the repo-maintenance dashboards, scanners, queue runner, and cluster observability primitives.
OpenClaw should not be discarded. It should become the approval, escalation, notification, and high-level orchestration shell over AgentX maintenance workflows.
DataAPI should not be promoted to orchestrator. It should evolve into a substrate only where structured file inventories, heavy scans, exports, or background ingestion materially help.
Phase 1: Stabilize boundaries and define the maintenance product

Define the three-plane ownership model explicitly in implementation artifacts and runtime config: OpenClaw for operator interaction, AgentX for maintenance orchestration, DataAPI for deterministic ingestion and export.
Convert the repo-maintenance vision into bounded capabilities rather than repo agents. Initial scope should cover findings and proposals for AgentX and DataAPI only.
Define a repo profile contract for each managed repo. Minimum fields: repo identity, architecture summary, critical paths, protected zones, test/build commands, deploy path, approval level, and allowed maintainer capabilities.
Decide which findings are global and which are repo-specific. RepoWatcher, validation scanning, feature alignment, docs drift, and contract mismatches should emit findings into a common schema.
Keep OpenClaw out of code-authoring ownership in this phase. It can trigger scans and present summaries, but AgentX should own the canonical task and result records.
Phase 2: Turn AgentX into the maintenance control room

Unify existing scanners into a single maintenance snapshot pipeline. RepoWatcher, docJanitor, feature alignment, and validation scanning should feed one repo-health view instead of separate tools.
Introduce a normalized finding model and severity taxonomy that all maintenance scanners emit. Required fields: repo, component, category, severity, confidence, evidence, suggested action, and validation checklist.
Extend SpecialX from generic automation into maintainer execution. Add maintenance-oriented task types for scan, summarize, triage, patch proposal, docs fix, contract review, and test-gap analysis.
Build a maintenance dashboard in AgentX that ranks next actions by impact, risk, and confidence rather than exposing raw scanner output alone.
Treat repo profiles and approval policy as first-class data so the same maintainer capabilities can be reused across AgentX and DataAPI.
Keep code edits proposal-only by default. Any generated patch should link to findings, affected files, expected blast radius, and required validation steps.
Phase 3: Integrate OpenClaw properly instead of loosely

Add an AgentX-exposed task API that OpenClaw can call to trigger maintenance jobs and retrieve status.
Add an OpenClaw callback path so AgentX can log externally executed work, or have OpenClaw simply act as a client and keep AgentX as the run ledger.
Create explicit OpenClaw skills for maintenance control: repo summary, next actions, run scanner, approve patch class, request human review, and daily maintenance digest.
Map OpenClaw agents to roles, not repos. Example: main for summary and approval routing, clawdx-coder for implementation proposals, strategist for architecture review, terminal-ops for controlled environment remediation.
Keep cloud-capable OpenClaw agents gated behind explicit policies. Local-first remains default; cloud escalation only for narrow high-value review classes.
Phase 4: Build the deterministic repo intelligence layer

Start in AgentX by productizing what already exists, not by pausing to build a perfect indexing platform.
Add deterministic extraction outputs per repo: file inventory, route inventory, service inventory, model/schema inventory, env var map, tests inventory, docs inventory, and dependency map.
Add git-derived signals: churn hotspots, stale files, ownership candidates, frequent break areas, and recurring failure areas.
Only after the above is useful, decide whether DataAPI should store raw file snapshots, exports, and large scan artifacts for long-term retention or cross-repo queries.
If DataAPI takes on this role, limit it to storage and retrieval concerns. Keep reasoning, ranking, and approval workflows in AgentX.
Phase 5: Host telemetry and schedule truth for all three Ollama hosts

Promote host usage tracking into a first-class AgentX capability. Every routed inference should record host, model, task type, caller, duration, token metrics, and whether fallback occurred.
Overlay actual execution on top of the existing cluster schedule. Distinguish scheduled demand, live demand, and historical actual demand.
Introduce a host-usage ledger that answers: what is running now, what is scheduled next, how much VRAM is reserved, what is estimated duration, and what conflicts are likely.
Maintain per-host rolling metrics: utilization, queue depth, model switch frequency, average tokens/sec, actual duration by task class, and schedule drift.
Treat OpenClaw cron jobs, SpecialX tasks, benchmarks, roundtables, and persistent Ollama loads as a unified demand model.
Add conflict detection based on host capacity and estimated VRAM, not just overlapping clock times.
Add a host timeline view that shows planned vs actual execution by host, with alerting on overruns, starvation, and model thrashing.
Phase 6: Grow from findings to safe action

Stage 1 autonomy: read-only reports and ranked next actions.
Stage 2 autonomy: patch proposals with mandatory human approval.
Stage 3 autonomy: safe auto-fix zones limited to docs drift, stale examples, formatting, obvious imports, and low-risk tests.
Stage 4 autonomy: bounded code edits only in approved directories, with mandatory validation and rollback trace.
Stage 5 autonomy: scheduled maintenance cycles only after empirical trust is established and task categories have proven low failure rates.
Recommended maintainer capability set

Code Steward: dead code, sprawl, refactor candidates, dependency drift, module smell.
Test Guardian: missing tests, flaky tests, broken assumptions, missing contract coverage.
Docs Janitor: docs drift, stale examples, missing canonical links, architecture drift.
Architecture Reviewer: service boundary violations, circular dependencies, overgrown files, wrong ownership.
Data Contract Checker: AgentX to DataAPI payload mismatches, route/schema drift, integration breakpoints.
Ops Runtime Guard: env drift, broken schedules, stale jobs, deployment misalignment, host health anomalies.
Repo Intake/Indexer: deterministic extraction and health snapshot refresh.
What to build first for fastest value

A unified AgentX maintenance snapshot that combines repoWatcher, docJanitor, validation scanning, and feature alignment into one ranked repo-health surface.
A repo profile mechanism for AgentX and DataAPI so findings and tasks run with explicit rules.
A SpecialX maintainer task set with proposal-only outputs.
Host telemetry capture for all routed Ollama work and schedule reconciliation against cluster schedule.
OpenClaw skills for triggering and reviewing AgentX maintenance workflows.
What to defer

Full AST graph platform in DataAPI.
Autonomous merges or direct production code edits.
Repo-specific generalist agents as the core mental model.
Replatforming existing AgentX scanners into a new service before proving the merged maintenance workflow.
Any major rewrite of OpenClaw just to make it fit AgentX concepts.
Relevant files

repoWatcherService.js — strongest existing repo health scanner; should become one input to a unified maintenance snapshot.
docJanitorService.js — existing docs quality engine; should feed common findings.
featureAlignmentScanner.js — existing frontend/backend/docs alignment engine; useful for maintenance ranking.
validationScanner.js — existing service coverage and orphan detection; useful for code steward and architecture reviewer.
automationRunnerService.js — bounded execution runner for maintainer tasks.
specialxTaskHandlers.js — current SpecialX task surface; must expand for maintenance workflows.
SpecialX.js — current agent profile abstraction; can back responsibility-based maintainer profiles.
AutomationTask.js — queue and lease model for bounded execution.
AutomationRun.js — run ledger and artifacts for auditability.
modelRouter.js — best insertion point for host-usage telemetry.
clusterScheduleService.js — current planned schedule logic; should evolve to compare plan vs actual.
clusterLiveService.js — current live host polling.
MetricsSnapshot.js — candidate store for host usage telemetry.
cluster-schedule.js — current schedule and live APIs; should expose actual-vs-planned demand.
specialx.js — maintenance task API surface.
specialx.html — likely control-room entry point for maintainer workflows.
cluster.html — target UI for host usage, schedule weight, and conflict visualization.
sync-openclaw-schedule.js — existing OpenClaw to AgentX schedule bridge.
scan.js — existing file indexing worker pattern if DataAPI later becomes repository ingestion substrate.
fileBrowserController.js — existing file metadata/search surface.
api.routes.js — existing backend route surface for any future repository-ingestion APIs.
openclaw_Architecture.md — authoritative topology reference for OpenClaw role and current cron/agent system.
Verification

Verify ownership boundaries by reviewing a single end-to-end flow: OpenClaw trigger to AgentX task creation to AgentX result storage to OpenClaw summary delivery.
Verify AgentX can produce one unified repo-health snapshot for both AgentX and DataAPI without relying on chat-only reasoning.
Verify SpecialX maintainer task outputs include evidence, affected files, validation checklist, and confidence.
Verify host telemetry answers the operational questions: what ran, where, when, for how long, and with what resource cost.
Verify cluster schedule can display both planned and actual load for primary, secondary, and tertiary Ollama hosts.
Verify low-risk patch proposals stay inside approved directories and use repo profile rules.
Verify OpenClaw remains optional as the outer shell: AgentX maintenance should still work headlessly through its own APIs and UI.
Scope boundaries

Included: architecture decision, actual status, target operating model, phased plan, maintainer capability boundaries, and host telemetry strategy.
Included: a practical foundation for AgentX, DataAPI, and OpenClaw that can create value quickly.
Excluded: code implementation details, new markdown files in the repos, GitHub PR automation implementation, and full OpenClaw code review.
Excluded: making DataAPI the central orchestrator or replacing OpenClaw with AgentX.
Further considerations

If you later want repo-local rule packs, prefer one small machine-readable profile per repo over one new generalist agent per repo.
If OpenClaw Mission Control becomes the preferred operator UI, keep AgentX as the backend system-of-record and let Mission Control consume AgentX APIs rather than duplicating maintenance state.
If DataAPI grows into a true repository intelligence substrate, enforce a strict separation between extracted facts in DataAPI and interpretation/action in AgentX.
The plan is also saved in session memory at /memories/session/plan.md.

If you want, the next useful step is one of:

Turn this into a concrete implementation backlog ordered by week 1, week 2, week 3.
Narrow this to the minimum viable foundation and cut everything that does not create value in the first 7 days.
Start execution planning for Phase 1 only, with exact models, APIs, and UI changes.
