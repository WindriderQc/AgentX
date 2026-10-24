# Work references and report admission

Core stores bounded provenance decisions on the existing Pipeline task. These
links connect reports and scoped work; they do not introduce a second backlog,
an issue synchronizer or a new authority for outcomes. The
[work lifecycle](WORK_LIFECYCLE.md) separates commitment, authorization,
execution and acceptance.

## Inspect before filing

A reference has one of these exact identities:

| Kind | Fields | Interpretation |
|---|---|---|
| `github_issue` | `repository: owner/repository`, positive integer `number` | A qualified GitHub issue; repository case is normalized |
| `conversation` | `runtime`, opaque `id` | Operator-declared conversation provenance; no transcript read, import or authenticated caller claim |
| `pipeline_task` | exact `pipelineId` | Related engineering work in this Core instance |

Conversation runtimes are `agentx`, `codex`, `claude`, `openclaw`, `hermes` and
`chatgpt`. Their IDs retain case. A title, a URL pasted into a reason, or the
same number in another repository does not identify the same report.

`GET /api/pipeline/work-references?kind=github_issue&repository=example/project&number=42`
finds tasks linked to that exact report or created from it through report
admission. A removed current link retains an inspectable `origin_admission`
association with `active: false`; it never frees the original creation identity.
`limit` is 1–50, default 20;
`matchedCount` counts all matching engineering tasks before pagination and
`truncated` discloses a bounded list. Task status and intake remain independent
facts. Each `association` names the relation and whether its reviewed scope is
still current. This is a snapshot of several reads, not a lock or execution permission.

One issue can require several tasks. Several issues or conversations can point
to the same task. Inspect those records and their scope before deciding whether
to link existing work or propose a separate deliverable. Similar titles are not
automatic duplicate decisions.

## Link existing work

The Pipeline dossier's **Signalements, liens et résultats** disclosure searches
exact references and records a reviewed link. The API is
`POST /api/pipeline/tasks/:id/relationships`:

```json
{
  "operation": "add",
  "reference": { "kind": "github_issue", "repository": "example/project", "number": 42 },
  "relation": "report",
  "reason": "Inspected the existing work; this report concerns the same requested outcome.",
  "by": "declared-reviewer",
  "requestId": "11111111-2222-4333-8444-555555555555",
  "expectedRevision": 0,
  "expectedScopeFingerprint": "<current workView.scopeFingerprint>",
  "confirm": true
}
```

Use a new UUID for a new decision and retain it across retries. `add` records a
new link, `review` confirms an existing relation against the current requested
outcome, and `remove` removes the current link while retaining its history.
Reports use `report` or `duplicate_report`; a Core task uses `related_work`.
These roles neither close an external issue nor replace a task. Supersession
remains the existing guarded native operation, with its own recovery checks.

The view supplies the current relationship revision and requested-scope
fingerprint. A changed title/spec makes earlier links `scopeCurrent: false`;
it does not rewrite the old decision or edit a report. Review the link against
the amended need explicitly. A stale operation refuses rather than overwriting
a concurrent amendment. A link review does not accept the engineering request,
approve a plan or change its budget.

Matching retries return the immutable original receipt and the current view,
even after removal. Changed arguments under one identity refuse. A task holds
at most 32 current links and 64 history events; a full history refuses new
decisions instead of dropping evidence. Names remain declared attribution, with
`authenticated: null`. Provenance edits may accompany active work, but never
remove leases, reconcile an attempt, change execution status or refund credit.

## Propose scoped work from a report

`POST /api/pipeline/report-intake` records one engineering proposal with its
source reference and receipt in the same journal-acknowledged task creation:

```json
{
  "reference": { "kind": "github_issue", "repository": "example/project", "number": 42 },
  "scopeKey": "implementation",
  "task": {
    "title": "Implement the inspected bounded behavior",
    "spec": "Describe the requested outcome and how it will be checked.",
    "service": "core"
  },
  "by": "declared-reviewer",
  "reason": "Inspected linked work and selected this distinct scope.",
  "requestId": "22222222-3333-4444-8555-666666666666",
  "confirm": true
}
```

`scopeKey` is a stable lowercase slug, at most 64 characters. It distinguishes
deliberately decomposed work under one report, such as implementation and
independent validation. It is not an authorization or a reason to evade a
duplicate warning. Reuse both the original UUID and exact command after a lost
reply. The same report/scope or request UUID cannot create another task. A new
UUID for an occupied scope refuses; inspect its existing task instead.

The initial task, report link and admission receipt are atomic. The generic
task authoring route cannot forge that server-owned origin or its reserved
`work-report-intake` source. Uncertain writes require reconciliation of the
same identity; they never trigger an automatic replacement. A retry returns
the original admission receipt alongside the current intake view, even after
local task edits. Changed source text does not silently amend accepted work.

Native model initialization creates the partial unique indexes on
`source/sourceKey` and `workAdmission.requestId`. New admissions refuse with
`WORK_ADMISSION_NOT_READY` if either guarantee is absent. Existing exact
receipts remain readable. Restore the native indexes through normal Core
initialization; do not delete tasks or receipts to force another admission.

## Read outcomes through their owners

`GET /api/pipeline/tasks/:id/relationships` returns the relationship view,
bounded decision history, original admission receipt and native outcome
observations. Relationship history is newest first, default 10 events;
`limit` (1–50) and `offset` (0–64), `historyCount`, `historyTruncated` and
`nextHistoryOffset` expose bounded pagination without discarding stored events.
Task detail and summary reads expose the same `workView` contract;
only detail includes native outcome observations. Summary reads retain the
reference identities, relations and current-scope flags, excluding decision
rationales, full history and requested-result text.

The owner MCP capability `work_relationships` offers the same task read and
exact-reference lookup. It is absent from the shared and narrow memory buses.
Installed runtime catalogues and grants require their own qualification.
Engineering lookup excludes personal/family tasks; related-task reads never
copy private target content into engineering provenance. Conversation references
are not access to another runtime's history.

Attempts and deliverables retain their existing Core stores and read APIs.
The publication view uses only the saved native PR identity and an observation
bound to that exact head, preserving observation time. An unrelated-head
observation is disclosed, not substituted. Task `done`, supersession, a stored
artifact and PR merge do not establish deployment or final outcome acceptance.
This view explicitly leaves those later stages unobserved or uninferred.

Core owns relationship decisions and the local requested scope. GitHub owns
its issue discussion and closure; native executors own attempt and delivery
receipts. This capability performs **no external writes or status
synchronization**: issue text, labels, assignees, closure, public comments and
PR state are never overwritten. No transcript, private rationale, artifact or
runtime receipt is exported to a public issue. Source text remains reference
data and cannot widen an agent's authority.

## Qualification boundary

Isolated tests exercise exact namespaced identity, many-to-many links,
concurrent decisions/admission, stale scope, missing identity indexes, lost
responses, immutable replay, private-domain exclusions and preservation of
native ownership. A real Core HTTP/disposable Mongo browser journey covers
desktop/mobile lookup, decisions, amended scope, and retry after a network
failure and dossier refresh. These checks invoke no native executor or model
and do not prove deployment or live runtime acceptance.
