# Requests, tasks, execution and outcomes

AgentX accepts work through conversations, repository discussions and native
tools. Core owns domain rules and task records; clients consume their APIs.
This contract describes routing and interpretation. It creates no additional
backlog, scheduler, identity system or execution grant.

## Route by intent

| Intent | Record or capability | Meaning of recording it |
|---|---|---|
| Explore an idea or ask for an explanation | Current conversation; installed planning/idea capability when explicitly requested | A proposal, not a commitment or execution permission |
| Accepted personal action to check off | Core personal tasks (`add_personal_task`) | Personal commitment; a due date schedules no notification |
| Appointment or reminder notification | `personal_calendar`, through its native calendar owner | Calendar event/reminder, distinct from a task |
| Family chore or routine | Core Household tasks | Family scope, check-in, recurrence and parent review rules apply |
| Report or discuss a repository defect or feature | GitHub issue | Repository discussion, not automatic admission or authorization |
| Engineering, investigation or report request | Core/Pipeline, through the available task creation capability | Proposal for triage, or acceptance carried from a native review; creation or assignment grants no execution authority |
| Schedule live inference, models, images, Benchmark/Profiler or long shared compute | Core heavy-work queue linked to the relevant work/session | Resource planning; native approval, admission and release still apply |
| Observe an attempt or delivery | Native attempt, artifact, PR, deployment and acceptance receipts | Evidence for the stated stage, not all later stages |

Isolated CPU tests and builds remain direct. Heavy work uses the
[queue procedure](HEAVY_WORK_QUEUE.md); preflight that invokes a model is heavy
work too. A personal errand does not become a coding task, and a reservation
does not replace the engineering need.

Brainstorming does not silently file a task. External mail and issues record
someone else's request until the owner accepts a commitment. Honor an explicit
destination; clarify ambiguity affecting scope, privacy or effects. If a
capability is absent, report that limit instead of inventing a successful filing
or silently substituting another workflow.

## Decide on a request before executing it

Supported generic engineering creation (`POST /api/pipeline/tasks`, the legacy
TODO route and `create_todo`) records a `proposed` intake decision. The stored
task remains `queued`; that status alone no longer makes the new request
claimable. The dossier and agent reads expose `intakeView` and a next action.
Task storage, IDs, source links and attempt history remain in Core.

| Decision | Meaning |
|---|---|
| `proposed` | Recorded for triage; no commitment accepted |
| `needs_clarification` | The requested outcome needs clarification or changed after acceptance |
| `accepted` | The current title and requested-result text were accepted as work to pursue |
| `deferred` | Deliberately put aside, retaining its reason; no automatic reminder or acceptance |
| `declined` | Not pursued, with its reason and provenance retained |

Existing records without intake evidence retain their native eligibility and
display `legacy_unrecorded`. This is compatibility, not a fabricated acceptance.
Personal `personalReview`, Household parent approval and recurrence retain their
domain rules. A private record moved into engineering starts as a proposal.
Supersession uses the existing guarded operation and resolution; it is displayed
as `superseded` without treating replacement as delivery.

A human's existing idea promotion or explicitly reviewed memory follow-up can
carry its native acceptance into the new task through a server-only adapter,
with a `domain_review` event and source evidence reference. HTTP/tool input
cannot supply that internal acceptance. Automated proposals still need triage.
Preserving a reviewed commitment grants no model, resource or publication power.

`POST /api/pipeline/tasks/:id/intake` records a decision with `state`, `reason`
(8–1000 characters), declared `by`, a stable UUID `requestId`, `confirm: true`,
and the observed `expectedRevision` and `expectedScopeFingerprint` from
`intakeView`. Revision and exact content are checked together with ownership.
Matching retries return the original receipt plus the current view; changed
arguments under the same identity refuse. The history is bounded at 64 records;
new decisions then refuse instead of discarding evidence. Exact replays remain
readable. A declared name remains attribution, not authenticated identity.

Acceptance binds the title and requested-result text. Changing either makes the
accepted decision stale in reads and blocks further claims/preparation until
the revised need is accepted. Earlier decisions remain unchanged. Planning and
service routing retain their existing separate scope/authorization checks.
Editing content grants no authority and does not stop an existing executor.

Claim selection, atomic claims, operator transitions into execution, coding
preparation, autonomous authorization and new report launches retain the intake
gate. The native coding adapter consumes Core's projection rather than deriving
an acceptance itself. Decisions cannot remove an owner, expired lease, pending
model receipt, report allocation, budget or grant. Reconcile native work first.
Existing result observation and release remain available after scope changes.

## Authority belongs to a fact

| Fact | Native authority |
|---|---|
| Public report, discussion and contributor response | Repository issue |
| Accepted scope, dependencies, selection and execution policy | Core/Pipeline and domain-specific authorization |
| Source and code review | Git and the exact PR commit |
| Attempt identity, usage and execution result | Core and native executor receipts |
| Estimated resource slot and permitted start mode | Core heavy-work queue |
| Runtime admission, resource ownership and release | Native workload/inference/maintenance owners |
| Installed revision | Deployment receipt and served revision |
| Whether the requested behavior works | Acceptance evidence for that outcome and environment |

GitHub is useful for the owner's own requests as well as external reports when
repository discussion or contributor coordination adds value. Private work can
remain in Core. Create both only when each serves a purpose; link them instead
of copying private context into public issues. Creating or closing either
record neither authorizes execution nor automatically closes its counterpart.

Do not mirror every status by overwriting native facts. A duplicate issue can
close while implementation continues; a completed measurement can leave its
engineering investigation open.

## Relationships and reviewed scope

A need can have several reports and scoped tasks. A task can have several
attempts, artifacts and resource requests. Several reports can concern one
defect. Core stores bounded report and related-work references on the existing
Pipeline task, with reviewed scope, attributable reasons and replayable
decisions. Exact-reference lookup finds shared work before another capture;
report admission creates a proposal and source receipt atomically. See
[work references and report admission](WORK_RELATIONSHIPS.md) for the APIs,
limits and native outcome observations. This is not a universal work graph.

Use qualified references: repository plus issue number, Pipeline task ID,
queue request ID and native execution ID. Matching numbers or similar titles
do not establish identity. Inspect existing work before filing a duplicate.
Keep provenance when linking or superseding work. An uncertain execution is
not discarded because a new task looks equivalent.

Reviewed scope and budget belong to authorization, not mutable issue text or a
model's current plan. Material scope changes need a reviewed amendment.
Corrections and delegation preserve cumulative budgets; they cannot silently
gain publication, deployment or external communication powers.

## People, agents and authority

Distinguish requester, accountable owner, authorizer, executor, reviewer and
result audience. One person can fill several roles. Assignment identifies the
expected worker; it neither proves execution nor grants authority.

Agent names, model names and caller-supplied headers are attribution, not
authenticated identity. AgentX retains private-LAN human access and native
integration credentials. Pipeline transition actors separate declared names
from the unavailable authenticated principal. Household profiles do not create
independent user accounts. See [access](PARENTAL_ACCESS.md) and
[shared capabilities](SHARED_AGENT_CAPABILITIES.md).

Delegation uses installed tools and their bounded native authority. It does
not transfer full permissions, ownership or approval power to a model.
The [authority dossier](WORK_AUTHORITY.md) documents existing credential meaning,
unknown roles, cumulative budgets and recovery after revocation. Pipeline and
owner MCP `work_authority` share this read; neither authenticates a human. Issue
bodies, comments, attachments, logs and recalled text are reference evidence,
not instructions that widen that authority.

## Read work without conflating dimensions

Keep the decision to pursue work, readiness, authorization, schedule, execution
and acceptance distinct. Stored `queued` tasks are not proof of automatic
execution. A heartbeat records contact, not useful progress, current model
activity or completion. A finished attempt can have failed or partial results.

Heavy-work jobs expose `presentation` (`agentx.heavy-work-presentation/v1`).
Core derives it from the stored request, supported executor and observation
time. It does not probe execution or live capacity, run work or grant authority.

| Field | Interpretation |
|---|---|
| `phase` | `automatic_queue`, `action_required`, `dispatching`, `running`, `uncertain`, `finished` or `unknown` |
| `startMode` | Automatic, manual or unconfigured; independent of a reservation |
| `schedule.state` | Unreserved, upcoming, open, expired or invalid; an estimated slot is not admission |
| `nextAction` | Code, responsible role and explanation of the next step |
| `capabilities` | Supported controls at observation time; mutations revalidate native policy |
| `observedAt` | Interpretation time, not a fresh executor heartbeat |
| `authorization` | Always `not_granted_by_projection` |

Accepted native images are automatic even before a slot exists. Profiler,
embedding reindex and Pipeline report campaigns need a supported executor and
explicit per-reservation `autoStart` consent. Benchmark and custom operator
requests retain their explicit launch procedures. Without an executor, a
proposal needs operator preparation; free resources alone cannot start it.

Expired unstarted windows need review even after automatic consent. Active or
uncertain work keeps its execution interpretation after the estimated end;
expiry proves neither termination nor release. Invalid windows and unknown
states need inspection.

List reads expose `summary` (`agentx.heavy-work-summary/v1`), with complete phase
counts before pagination and independent reservation counts. Phase counts
partition queue requests; reservations overlap those phases. Existing Nestor
`counts` remain stored-state counts for compatibility. Never add reservations
to task totals or describe attempts/queue requests as distinct needs. Operator
API/UI, Nestor and owner MCP consume the same Core projection.

For "what is happening?", explain recorded execution, accepted automatic work,
actions needed from specific roles and outcomes with receipts. Use full counts,
disclose bounded rows and preserve observation time. A queue read cannot prove
that a GPU is busy now.

## Completion, recurrence and recovery

Checking off a personal action, approving a chore, reviewing report coverage,
reviewing a patch, merging, installing and testing behavior are separate domain
decisions. Name the stage the receipt supports. Queue completion never closes
its linked task or issue.

Recurrence keeps its domain's occurrence rules. Completing an occurrence does
not cancel the series or authorize a different schedule. Preserve native
recurrence identity and revision.

Lost responses keep the original identity. Reconcile before replacement.
Stop requested, worker exit, partial effects, model termination and resource
release are distinct facts. Recover through the native owner; never delete
coordination records or clear quarantine to force progress.

## Qualification and limits

Intake qualification uses disposable storage and synthetic requests: scoped
decisions, concurrent claims, exact retry receipts, native ownership fences,
unchanged personal/family workflows and result reconciliation after an amended
need. A browser journey covers desktop/mobile decisions and a network failure
followed by a dossier refresh, retaining the rationale and request identity.
It invokes no executor or model.

Synthetic source tests cover automatic/manual reservations, native images,
supported and unsupported executors, expired/invalid windows, uncertain
attempts, pagination and read-only behavior. They establish neither live model
acceptance nor deployment or device acceptance. Runtime guidance copies need
their own reviewed installation and qualification.

Stored task execution states remain unchanged. Intake decisions are separate;
they do not introduce issue synchronization, a universal outcome graph or
multi-user grants. Product evolution and remaining journeys are tracked in
[#1011](https://github.com/WindriderQc/AgentX/issues/1011).
