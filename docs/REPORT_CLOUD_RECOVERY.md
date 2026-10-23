# Report cloud refusal recovery

An unknown report cloud call remains fenced until its native owner supplies
terminal evidence. `POST /api/pipeline/tasks/:id/reports/:requestId/receive-cloud-refusal`
receives an explicit operator mapping of a single native OpenClaw HTTP refusal (400, 401, 402, 403, 404, 422 or 429)
journal response, archived as a JSON task deliverable. It validates the exact
claim, source/inventory digests, unknown receipt hash, provider/model and call
timing, and requires the original worker to be inactive. The historical unknown
and failure observations remain; `/reconcile-models` receives the resulting
refused settlement. This proves refusal, never a successful model answer.
The global native spend ledger retains its historical observations.

When restarting Core would interrupt the fenced owner, the reviewed
`core/scripts/receive-report-cloud-refusal.cjs` accepts three arguments: the
installed Core directory, the reviewed `pipelineReportCloudRecovery.js` file,
and a private JSON intent containing `pipelineId`, `requestId` and `body`.
It uses the installed Core DB configuration and live native status, and runs
the same receiver without starting a model, worker or deployment. Stage the
reviewed files and retain their revision/hashes with the private receipt.
A new report execution can retry only the exact step covered by a received
refusal, within its new explicit provider policy and the original task cap.

Native model mode observes HTTP status through Node's request diagnostics,
correlated by the exact request object and execution context. It does not replace
the native SDK's transport, authentication or retries. One explicit negative
acknowledgement with no output carries a bounded refusal receipt to Core and
records a known zero amount; multiple attempts, server errors and missing status
retain UNKNOWN. Pre-dispatch payload validation does not count as a paid call.
The native gateway journal records the receipt's request ID and safe machine
fields, never upstream bodies or prompts. Core retains it in the step's attempts.
Sampling temperature is left to the native provider configuration for report
escalation; the requested output limit and exact supplied context remain checked.

Known refused attempts do not disqualify later completed work in the same
execution. A request containing only refusals still cannot deliver a report;
unknown or pending calls always retain the publication fence.

Completed cloud JSON is saved in the private step directory before validation,
including a rejected answer, so a local correction can read the original bytes.
Source excerpts use the current step's bounded context share; this is separate
from native spend reservation. A later explicitly authorized execution may retry
a failed answer only when Core supplies the exact original step/model completion
receipt from a settled execution. Its original charge stays in the task total;
partial accepted answers and uncertain calls keep their existing fences.

The exact native `OPENCLAW_USAGE_UNOBSERVED` error follows an SDK final result.
Core receives termination only after its original inactive worker confirms the
same source/claim. It retains the rejected result's original failure and unknown
billing; it never fabricates usage, a price or a successful report. Other errors,
missing final events and active owners retain UNKNOWN. New native plugins save
rejected SDK final results privately and expose an authenticated receipt read
(see the plugin README); older discarded output remains unavailable.

While any original cloud cost is unverified, a new authorized escalation carries
`freeOnly: true` and a zero native cost budget. A native paid model is refused
before dispatch, even if the selected model's configuration changes. Thus a
configured free route can continue after verified termination without spending
another paid allowance or erasing the original accounting uncertainty. The task
cap, original failure and report acceptance requirements remain in force.

Source checks reserve one minute for their mandatory checkpoint, not the eight
minutes of the optional final prose pass. The prose pass runs only after source
coverage is complete and its full time remains. Step and escalation timeouts
stay below the actual queue/hard deadline with that checkpoint reserve; windows
shorter than two minutes save their current report without starting a step.
