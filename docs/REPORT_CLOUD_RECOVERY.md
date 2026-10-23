# Report cloud refusal recovery

An unknown report cloud call remains fenced until its native owner supplies
terminal evidence. `POST /api/pipeline/tasks/:id/reports/:requestId/receive-cloud-refusal`
receives an explicit operator mapping of a single native OpenClaw HTTP 402
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
