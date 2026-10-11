# Bounded Coding Team PR correction loop

Core owns authorization, selection, task transitions, cumulative budgets and
native model receipts. A replaceable host runner executes one leased attempt.
GitHub supplies observations; it is not a task queue. The loop ends at human
review and never merges, installs or declares product acceptance.

## Authority and states

The singleton `PipelineCodingAutonomy` switch defaults to disabled. Task
`codingAutonomy` records the explicit scope, reviewed intent fingerprint,
heavy-work campaign, linked executions, cumulative usage, observations and
manual interventions. Routing to `agentx-coding` alone grants no execution.
Ideas, personal, Family/Household and profile-scoped tasks are excluded.
Tasks need low risk, a reviewed public/internal review-only automation intent,
complete dependencies and an open availability gate. Selection uses priority,
six-hour aging and a stable task-ID tie break. Native claims and the existing
singleton automation slot prevent another worker from taking owned work.

```
authorized queued → dispatching → preparing → work/tests → publishing
                                                        ↓
review ← native worker verdict/release ← published PR → waiting_ci
                                                        ↓
                               correction → new linked execution
                                                        ↓
                             ready_for_review / blocked / closed
```

Each correction keeps the same task, branch and PR and creates a new requestId
linked to its predecessor. A repeated network request only reconciles its
original identity. Completed native attempts remain immutable. Core can observe
several PRs while one host worker runs. Observations have their own cadence,
separate from the shared heavy-work dispatcher, and each sweep reads at most
two due PRs, oldest first. Failed reads back off to five minutes.

The runner preserves source checkpoints before fetching only `main` and the
exact task branch. It merges remote operator contributions and current main
without force pushing. Conflict versions stay in the isolated checkout; the
Coding Team edits and tests them while the runner controls Git metadata.
An interrupted merge preserves its index and local resolution. A second
upstream conflict receives a bounded new coding turn after native release.

The worker has no network, Git write access, GitHub credentials or production
checkout. Runner-only relay headers bind every inference to its existing task,
request and lease. Core records the call before native dispatch, checks the
frozen model/host/context/artifact capacity, and persists terminal evidence
before returning the stream's terminal frame. Unknown model outcomes retain
the fence. The approved campaign must cover the frozen host before admission.

## Publication and observations

Independent verification uses a native command profile, not a task-provided
shell command. The dispatcher profile runs the coding Python suites; the bounded
Core profile runs `inferenceRuntimePolicy`. Neither replaces full PR CI or
product acceptance. Dependency edits require separate operator handling.

Before publication the runner checks exact authorized paths, all unpublished
commit blobs (including added-then-removed artifacts), credentials, private
paths, generated content, links/submodules, source size rules, test results and
native model termination. The public PR body comes from final changed files
and verification coverage, excluding raw task/model/log content.

Original PR repository, branch, target and open state are verified before push.
Closed original PRs block instead of creating a replacement. A private durable
publication intent precedes every external effect. After a lost response,
reconciliation reads the exact branch commit, original PR and final description.
It never reruns a worker, pushes again or repeats a PR mutation while the result
is unknown. A saved exact native verdict is replayed through Core's existing
result fingerprint and release path. Missing proof stays held for an operator.

GitHub observations identify the exact tested SHA. Old check runs cannot certify
the published commit. Five repository checks are required: `tests (core)`,
`tests (benchmark)`, `tests (rag)`, `tests (data)` and `compose`. Pending or unknown
mergeability waits; failures, cancellations, timeouts and conflicts trigger a
bounded correction. Skipped/neutral and unconfigured checks remain unverified.
Successful checks also disclose which verification steps ran or were skipped
as out of scope. Failure summaries, annotations and bounded job diagnostics are labelled
untrusted evidence in the next worker prompt; they never become runner commands.
Repeated diagnostics against the same diff block. The loop makes no model call
just to wait.

## Operator procedure

1. Review one engineering task, its public source scope and dependencies. Use
   exact file paths and an installed independent verification profile. Scope
   changes invalidate execution authority instead of silently widening it.
2. Submit an operator campaign through the installed entrance from the instance
   sheet and [the heavy-work queue](HEAVY_WORK_QUEUE.md). Link the coding session
   and Core task or GitHub issue, exact hosts, estimate and permitted window.
   A synthetic manifest is:

   ```json
   {
     "key": "synthetic-coding-campaign-v1",
     "title": "Bounded synthetic coding qualification",
     "kind": "other",
     "hosts": ["http://gpu.example.test:11434"],
     "estimatedMinutes": 120,
     "notBefore": "2030-01-01T10:00:00-05:00",
     "startBefore": "2030-01-01T10:15:00-05:00",
     "source": {"type": "coding", "ref": "coding-session-reference", "taskId": "0123"},
     "executor": {"mode": "operator", "receiptRef": "private-receipt-reference"}
   }
   ```

3. Reserve the approved slot in Cluster Schedule. In Pipeline's **Coding Team
   autonomy**, confirm the reviewed scope and use **Begin the approved campaign
   window**. This crosses the existing operator dispatch fence without running
   a command. An already begun campaign is read as the same identity.
4. Authorize the exact task and file scope with that campaign ID. Review budgets,
   then **Enable authorized scope**. Only authorized tasks are selected; the next
   eligible task starts without a separate per-launch confirmation.
5. Follow the active request, stages, native unresolved calls, remaining budgets,
   PR SHA/check coverage and manual intervention history. Submit a review
   correction against the current PR commit when needed.
6. At `ready_for_review`, review the draft PR. Human review, merge, installation
   and real product acceptance have separate receipts. Once the campaign's
   scope is finished/stopped, independently verify native release and close the
   same queue request through its operator-finish protocol. The loop does not
   manufacture that operator release receipt.

API base: `/api/pipeline/coding-autonomy`. `GET /` exposes the switch revision,
active request and task projections. `POST /config` requires `confirm: true`,
`enabled` and `expectedRevision`. `POST /tasks/:id/authorization` requires the
current authorization revision, explicit boolean, campaign ID and reviewed
scope. New unowned tasks can receive a normalized low-risk intent through this
review; existing intents must match. `/tasks/:id/review` requires the current
head and bounded text; `/tasks/:id/runs/:requestId/stop` targets one exact run.
The existing private LAN/operator access applies; there is no new account model.

Default cumulative per-task limits:

| Limit | Default and maximum |
|---|---:|
| Corrections after first execution | 2 |
| Work, including preparation and capacity waiting | 240 minutes |
| Tests | 80 minutes |
| Model waiting/generation | 90 minutes |
| Model requests | 128 |
| CI waiting across all executions | 60 minutes |
| No useful source/test progress | 45 minutes |

These limits can be reduced on authorization, never reset by a correction or
reauthorization of a started campaign. Repeated source/test fingerprints survive
restarts and resumes; a full progress history blocks instead of forgetting old
states. Heartbeats, reads, cache churn and identical test repetitions are not
useful progress. Existing per-stage and soft/hard worker guards also apply.

**Pause** prevents new work and corrections; a current worker and observations
continue. **Remove task authorization** fences future execution. **Cancel waiting
and future corrections** ends CI waiting without signalling another job.
**Stop this exact worker** persists a stop fence and requests cooperative host
cleanup for its task/requestId. A stop before receipt closes that identity under
the launch lock; a delayed launch cannot resurrect it. Waiting capacity is
cancelled through its native owner without consuming a model attempt.

Stop acceptance and entry into publication share the host lock. Publication may
already have begun: that stop is explicitly refused and its actual PR receipt
remains visible. Future corrections are fenced. Worker exit, native model
termination and workload release are separate facts. An absent process, expired
lease or lost receipt proves none of them. Preserve checkpoints and reconcile
through the native owner; do not delete admissions or quarantine.

## Installation, activation and rollback

Review the PR and complete CI first. Merge, normal installation and persistent
activation each require the owner's specific approval for these changes.
Re-read served revision and concurrent work before the approved install. Use the
instance's existing `agentx action deploy --services core --revision origin/main`
with its stable actor, clean checkout, maintenance/LEAD owner and native admission.
The host runner loads modules from the same installed AgentX checkout; compare
its module hashes with the approved revision before enabling. Do not restart
other services or interrupt workloads to force admission.

After installation, the singleton still defaults disabled. First enable only a
synthetic exact-file task, a bounded campaign and reduced limits. Preserve the
installed model/context contract. Persistent broader activation follows separate
qualification and scope approval.

Rollback starts by pausing and removing future authorization. Stop the exact
active worker if needed and prove native termination/release before changing the
runner. Preserve Mongo journals, host receipts, Git checkpoints and PR history.
Use the normal reviewed revert on main and native maintenance procedure; never
clear coordination records as rollback. A restart or revert does not authorize
resuming an uncertain execution. The manual **Run one task** control remains.

## Controlled qualification

Use a distinct synthetic task and new fixture files on its own branch. The
Coding Team first writes a small helper and tests, then publishes a draft PR.
Submit exact-head review feedback requiring a new observable helper behavior,
or create a conflict in a disposable synthetic fixture. The operator supplies
the condition/test, while the Coding Team writes the correction. Observe a new
linked request updating the same PR and exact-head successful CI, followed by
`ready_for_review`. Preserve both attempts and native release receipts.

Qualify targeted stop during waiting and work, and the publication lock, while
another unrelated job remains unchanged. Record actual worker exit and model
termination separately. Repeat lost-response/restart scenarios with durable
identities. Keep live manifests, host inventories, raw logs and dated results
outside Git. Any operator correction of worker source is labelled assisted and
cannot count as an autonomous result. Live qualification is tracked in
[issue #681](https://github.com/WindriderQc/AgentX/issues/681).
