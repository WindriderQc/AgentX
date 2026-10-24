# Actors and bounded work authority

Core owns engineering intent and delegation policy; native executors own effects
and receipts. The Pipeline dossier and owner MCP `work_authority` expose the same
`agentx.work-authority/v1` read. It describes recorded roles, current scope,
cumulative budgets and unresolved original requests. It grants no authority and
performs no external write. Personal and Household work remain in their native
domains. See [work lifecycle](WORK_LIFECYCLE.md).

## What the existing credentials mean

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| Private LAN human entry | Access to the existing human surface/API | An authenticated individual, household parent or independent reviewer |
| `by`, assignee, agent/model name, `x-agentx-caller` | Declared attribution and routing context | A person, a permission grant or an approved action |
| Internal Nestor consumer token | The internal inference transport contract | Human identity, requester authority or a coding grant |
| Core automation lease | Possession of the current task lease, with native expiry/fences | Person identity or permission to widen scope |
| Native executor/request identity | The recorded runner and exact execution correlation | A human identity, new budget or proof of success |
| PsyX bearer token | The existing specialized native integration access | A global login, adult cookie or engineering delegation |
| DSH signed launch / native runtime grants | The installed integration's narrowly checked operation | All requester powers, publication/deployment consent or bypass of Core admission |

No accounts, login replacement or new household access mechanism are introduced.
Anyone reaching a LAN human entry retains its current capabilities. Owner-only
MCP means the Nestor contract's domain, not proof of an authenticated person.
Family profiles and names cannot become authenticated principals.

## Roles and evidence coverage

The dossier distinguishes the recorded requester, assignment, authorizer,
native executor and latest recorded reviewer. Missing facts stay unknown. In
particular, an assignee is not inferred to be the accountable owner of the
result. Existing coding grants record the operator API and time, but do not
record an authenticated individual authorizer. The read states that limit.
Role observations come from retained transitions; trimmed or historical records
cannot reconstruct missing attribution. The audience is engineering on the
private LAN, never permission to export a transcript or private task publicly.

Review and publication retain their existing human gates. The operator review
path compares declared reviewer and assignee names. This helps catch an
accidental same-name review; it cannot prove two distinct people or resist a LAN
caller declaring another name. There is no claim of authenticated separation of
duties. Native workers receive bounded tools rather than operator permissions.
A stronger person-level approval boundary requires a separately reviewed access
design; agent names cannot supply it.

## Scope, budgets and concurrent delegation

A code-step graph binds to the exact Core task basis, root request, source
commit, coordinator, reviewed paths and locks. Creating an attempt, starting
model inference and obtaining an executable manifest require current authority
and accepted current intent. Personal/family routes cannot enter that path.
Changed content, private-domain routing, intake revision, scope/locks and
revocation are fenced at the durable state write, together with the graph and
autonomy revisions. A stale caller must read the current revision; it cannot
replace the root or reset a campaign to obtain another budget.

Step reservations and usage stay under the native root's cumulative envelope.
Retries, corrections and supplementary grants retain earlier spending. The
read exposes cumulative limits, settled usage, active reported usage and the
number of recorded grants; these observations are not a new admission ledger.
Pending/unknown model calls remain reserved until their original result is
reconciled. Only the native owner decides remaining execution capacity.

Delegation does not approve itself, inherit the requester's full capabilities,
authorize model/resource admission, communicate externally, merge or deploy.
Installed native consultation also retains its own request identity, tools,
permissions and approval rules. Reference text in reports or prompts never
widens an executable scope.

## Revocation, receipt recovery and stopping

Revocation blocks future attempts, model calls and executable manifests. It
does not make already launched work disappear. Observation continues for the
original children without launching or resuming them. Exact original inference,
terminal, artifact, adoption and assembly receipts remain recordable after
revocation or a content change, subject to their existing identity, artifact,
receipt validation and revision fences. Recording a receipt grants no further
execution or publication permission. An unrelated or replacement root cannot
use this recovery path.

A stop is a separate native operation. Its accepted receipt is a stop intent,
not proof that every child has terminated or released resources. Partial stop
results preserve each exact request; a lost, refused or missing response remains
unconfirmed. Children and their reserved budget are retained until native
observation establishes the result. Unknown launch outcomes reconcile against
the original executor and request; there is no replacement launch to make an
uncertain result look complete.

## Acceptance journeys and attention limits

These source checks use isolated CPU tests and disposable databases; they do
not invoke models or claim runtime deployment/live acceptance.

| Journey | Reproducible source evidence |
|---|---|
| Proposal, acceptance, content amendment and racing intake/claim | `core/tests/routes/pipelineIntake.api.test.js` |
| Many reports/scopes, exact duplicate lookup and immutable replay | `core/tests/routes/pipelineWorkReferences.api.test.js` |
| Lost launch, same-request resume and native outcome recovery | `core/tests/unit/pipelineCodeDagCoordinator.test.js`, `core/tests/unit/pipelineCodingAutonomyRecovery.test.js` |
| Revocation/content/private-domain changes, receipt recovery and write races | `core/tests/unit/pipelineCodeDagStateService.test.js`, `core/tests/unit/pipelineCodeDagInference.test.js`, `core/tests/services/pipelineCodeDagAuthority.mongo.test.js` |
| Partial cancellation retains unresolved children | `core/tests/unit/pipelineCodeDagCoordinator.test.js` |
| Family check-in, approval, recurring rollover and stale approval | `core/tests/services/familyTaskService.test.js` |
| Stale diagnosis and mutation guards | `core/tests/routes/pipelineTaskDiagnosis.api.test.js` |
| LAN access, native credentials and family/person identity limits | `core/tests/integration/lan-human-access.test.js` |
| Common read facts in Pipeline and owner MCP, absent from shared/family tools | `core/tests/routes/pipelineWorkReferences.api.test.js`, `core/tests/unit/mcpOwnerTools.test.js` |
| Desktop/mobile decisions, failed response, refresh and authority disclosure | `core/tests/browser/pipelineIntakeJourney.cjs` |

Human review remains work needing a person: Pipeline marks it as attention and
reports review counts using the existing selection/coverage rules. A receipt or
elapsed wait cannot auto-accept the outcome. Queue counts describe requests;
attempt metrics describe attempts, not distinct needs or human availability.
There is no measured reviewer availability, reserved review capacity, automatic
review SLA or person-authenticated approval. Unknown accountability is shown
rather than assigning every decision to an agent. See the dossier's next action,
count scope and observation time before making a commitment.

Merged code, installed revision and accepted outcome remain separate facts.
Installation uses the instance's deployment/ownership procedure. Live model
qualification uses the approved campaign, heavy-work queue and native admission;
passing the source journeys does not authorize that campaign.
