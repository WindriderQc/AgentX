# Core task briefs and coding worker evidence

Use this reference when preparing engineering work, following a coding attempt
or changing DSH Studio's operator capabilities. Core Pipeline owns the task and
its result; Studio and the coding worker are execution interfaces.

## Prepare one bounded brief

Read an existing linked task before creating another. Keep implementation work
in Pipeline, personal errands in personal tasks, and durable owner facts in
Core memory. A plugin's own task list or memory store does not replace them.

Describe the observable result, relevant files/components, constraints, focused
verification and expected delivery. Include useful task/issue/Planning links,
not entire transcripts or a host inventory. Separate an optional live acceptance
check from source tests so the worker can deliver a reviewable change without
claiming production acceptance. Split independently deliverable changes when
they need different authorization, resources or review.

Use one of Core's existing brief formats:

- `spec`: supplied Markdown, passed to the worker as the task specification.
- `objective`, `sourceFiles`, `steps`, `constraints`, `acceptanceCriteria` and
  `relatedTasks`: Core renders these fields when `spec` is omitted. With a
  supplied `spec`, include the needed details in that text; the structured
  fields are not a second appended brief.

Example creation body, with synthetic paths and scope:

```json
{
  "title": "Fix Pipeline count after filtering",
  "service": "agentx-coding",
  "objective": "The filtered count uses Core's recorded total and discloses incomplete coverage.",
  "sourceFiles": ["core/public/js/pipeline.js", "docs/OPERATOR_UI.md"],
  "constraints": ["Use the existing Core projection; keep private task lanes excluded."],
  "acceptanceCriteria": ["Run the focused source tests with complete and partial coverage; report their commands and results."],
  "source": "coding-session",
  "sourceKey": "pipeline-count-session-reference"
}
```

`POST /api/pipeline/tasks` saves a queued, unassigned task. Only explicit
`service: "agentx-coding"` routes it to the local manual worker. `source` plus
`sourceKey` deduplicates task creation; after a lost creation reply, retry that
same identity and inspect the returned task rather than create a second task.
Use a new key for a genuinely different intent; replaying a key returns the
existing task and does not update its specification.

`priority` is 1 (highest) to 5. `dependsOn` takes existing Pipeline ids;
`notBefore` and `dueAt` are date/time fields. None authorizes execution.
Planning links add a bounded, privacy-filtered explanation to the worker's
prompt. The specification remains its assignment; Planning context is reference
material. Saving a plan or approving its current revision launches nothing.

For an authorized task edit, `GET /api/pipeline/tasks/:id` returns the task and
its `editToken`. `PATCH /api/pipeline/tasks/:id` takes
`{ changes: { spec, ... }, editToken, by }`. A conflict keeps the draft: compare
with the latest task before saving. Do not change a running assignment's scope
to imply that its earlier authorization covers new work.

## Follow the worker in Pipeline

Open `<core>/pipeline#pipelineFollow` for the worker controls and
`<core>/pipeline?task=0338` for a task dossier. An observed attempt links as
`<core>/pipeline?task=0338&attempt=2`. Use the instance Core origin for these
links, including navigation from Studio. Do not bypass Studio's signed launch
entry or open another worker to obtain visibility.

Read the exact task, request and attempt shown. The dossier exposes its next
action, ownership, feedback, plans and recorded evidence references. Worker
observation keeps heartbeat, useful source/test progress, budget and last test
distinct. An active process or recent heartbeat proves liveness at that time;
it does not prove useful progress or a passing test.

When the native runtime bridge is installed,
`GET /api/runtime-bridges/coding-dispatch/status` observes the local worker.
Add `?requestId=<original-uuid>` to reconcile a launch whose reply was lost.
An inactive host unit without an exact terminal receipt stays unknown. Inspect
the original identity through its native owner; never launch a replacement,
release a lease or clear quarantine because a process disappeared.

The manual launch keeps one request UUID for the exact task/observed selection.
The Pipeline UI revalidates eligibility and native capacity. A stale selection
or unknown outcome is a reason to refresh that request's evidence, not generate
another UUID. Manual worker eligibility is queued, unowned, non-private work
explicitly routed to `agentx-coding`; Core still checks start time and dependencies.
The separately authorized correction loop retains its own bounded scope, budgets
and native receipts. Ordinary routing does not enable it.

**Stop worker** requests cooperative stop for that exact task/request. An
accepted stop is an acknowledgment, not proof of worker exit or model release.
Confirm the terminal worker receipt and Core's exact inference completion/release
separately. A controlled stop preserves the local source checkpoint and starts
no automatic retry. New dependencies block publication until the owner reviews
the package change and explicitly hands the task back for installation.

## Report what the evidence proves

| Evidence | What may be reported |
|---|---|
| Source diff/checkpoint | Change prepared; work may still be incomplete |
| Exact test command and completed result | Those checks passed or failed on that content |
| Worker terminal receipt | That attempt finished with its recorded outcome |
| Native inference/resource release receipt | That exact runtime operation settled and released its authority |
| Draft PR and CI on its published head | Change available for review, with those CI results |
| Merge/deployment/device receipt | Only the separately recorded merge, installation or acceptance |

`POST /api/pipeline/tasks/:id/feedback` accepts `{ by, text, status? }`.
Worker `status: "done"` requests review; it does not accept its own result.
Feedback should name the changed behavior, exact checks/results, checkpoint or
PR when available, unresolved work and any separate live acceptance. Do not
invent a test result from model narration. The guarded worker uses its native
lease/result contract rather than impersonating a human reviewer.

Task deliverables stay in the existing dossier and task scope. Digest verification
proves file integrity, not external delivery. A queue completion does not mark
the linked Pipeline task or issue done. Keep runtime logs, manifests, secrets,
private references and full receipts outside the public product repository.

## One DSH runtime, separate profiles

Studio and the isolated coding worker use the reviewed DSH runtime selected by
the instance. Check `DSH_STUDIO_DSH_ROOT` and `AGENTX_DSH_ROOT` before diagnosing
version drift; an old directory alone is no proof of an active runtime.

Their native state, workspace, launch overlay and permission boundary stay
separate. Studio can use reviewed web/browser/context plugins; the worker keeps
its network isolation, task-local tools and frozen concrete capacity selection.
An idle Studio holds no inference-host claim. A runtime upgrade needs both Studio
and worker acceptance, without duplicating runtime maintenance.

Install/update this operator skill through native project skill discovery
(`.agents/skills` or `.dsh/skills`) in the intended Studio workspace. Download
the served bundle from `GET /api/operator-skill/download` after the product
revision changes; preserve its private `references/instance.md` and generated
`references/served.md`. Updating skill files does not require rewriting DSH's
native settings, provider overlay, history or plugin profile. Check that the
intended workspace discovers the new copy before reporting it active.
