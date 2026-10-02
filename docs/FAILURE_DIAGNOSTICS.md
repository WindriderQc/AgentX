# Failure diagnostics

The operator-facing interpretation is described in [operational screens](OPERATOR_UI.md).

Core exposes a read-only `agentx.failure-diagnostic/v1` projection through
runtime admission failures, inference retry errors (`failure.diagnostic`) and
Pipeline automation performance attempts (`failureDiagnostics`).

The shared implementation is `shared/failureDiagnostics.js`. It uses the
classifications defined by the existing worker receipt contract and exact
existing codes. It does not change the normalized worker receipt, its
fingerprint, stored Pipeline evidence or execution policies.

| Field | Meaning |
| --- | --- |
| `code` | Original bounded identifier, or null when no valid code exists. |
| `recognizedCode` | Whether the identifier has an explicit diagnostic mapping. |
| `category` | Configuration, availability, admission, worker, model, verification, evaluator, evidence, policy, budget, timeout, cancellation or unknown. |
| `classification` | Existing worker failure classification; separate from a model quality score. |
| `evidenceSource` | Authority to consult for recovery evidence; not proof that evidence was observed. |
| `nextAction` | Stable recommendation for a reader, not an executable command. |
| `recovery.authorization` | Always `not_granted`: a diagnostic cannot authorize replay, release, adoption or promotion. |
| `recovery.requiredEvidence` | Evidence that the responsible controller must verify before considering recovery. |
| `derivedFrom` | Present for diagnostics derived from a verification verdict or terminal inference progress instead of a persisted failure code. |

The existing controller still decides whether an operation may retry, under
its admission, dispatch, cancellation and budget rules. Its `retryable` and
`safeToRetry` flags are not changed by this projection. Passing those flags,
a completed lease or arbitrary recovery fields to the diagnostic function
does not grant authorization. Recommendations do not replace controller proof.

## Interpretation

- An admission wait asks for a fresh admission decision and proof that the
  current request was not dispatched. An expired lease alone proves neither.
- A stream interruption, unverified response or transport reset requires
  reconciliation of the prior execution. A timeout does not prove termination.
  Terminal `recovery_required` progress keeps reconciliation requirements even
  if its initial cause appeared transient. A generic admission denial without
  a specific cause also remains uncertain because it can describe a release
  that was not acknowledged after dispatch.
- A worker process failure requires inspection of worker and workspace effects.
  It is not a model quality verdict.
- A failed independent verification requires the exact revision and its test
  report. A legacy `verification.status: failed` becomes a diagnostic with
  `code: null`; it does not invent a persisted code.
- A grader error belongs to the evaluator. The evaluator must be qualified
  before its evaluation can be trusted; the diagnostic cannot rank a model.
- Wrong model attribution or a missing receipt is an evidence failure, even
  when tests passed. Missing monetary evidence is not a measured zero.
- A declared worker `model_error` or `invalid_result` describes a reported
  response/contract problem. It does not establish a quality score or permit
  automatic replay.

Unknown valid codes remain visible with conservative evidence requirements.
There is no substring-based inference of a failure family. Successful retry
history is not projected as a current failure. Codes and verdicts remain
separate so old readers can continue using their existing fields.

## Interruption scenarios

Each boundary is covered either by a **simulated API fixture** (an in-process
double for the peer) or by the **real death** of a disposable child process
killed with SIGKILL after a chosen write commits. Real-death suites use a
disposable MongoDB and loopback peers; lease or owner ageing is simulated by
moving durable timestamps. Phone and voice acceptance is outside this matrix.

| Boundary | Kind | Expected outcome | Test |
|---|---|---|---|
| Profiler writer dies before its journal | Real death | Nothing to recover; no runtime request | `benchmark/tests/integration/profilerInterruption.process.test.js` |
| Profiler writer dies after its journal, before dispatch | Real death | Fresh dead owner is not taken; once aged, one restore and one release | same |
| Response lost after dispatch | Real death | Journal stays `mutating`, operator required on every sweep; no replay, restore or release | same |
| Terminal receipt, then a co-resident is missing | Real death + simulated Core | No release; ownership returned; a later sweep restores, then releases once | same |
| Core release acknowledged, then writer lost | Real death + simulated Core | Projection reconciled from the release receipt; no second restore | same |
| Swallowed interruption, owner epoch replaced, Core dispatch refused | Simulated | Next mutation fenced; quarantine kept | `benchmark/tests/unit/profiler/profilerRunJournal.test.js` |
| Two recovery workers | Simulated | One owner-epoch CAS wins | `benchmark/tests/unit/profiler/profilerProjectionRecovery.test.js` |
| Concurrent inference, owner change, interrupted warm during restore | Simulated | No restore mutation, or no bounded retry | `core/tests/unit/benchmarkRuntimeRestore.test.js` |
| Lost release responses, reaper, restart generations | Real MongoDB, in process | Identity-bound receipts; single-writer adoption | `core/tests/unit/runtimeCoordinationService.test.js` |
| Pipeline claim committed, Core dies before responding | Real death | One attempt and lease; retries and second claims refused; expired lease flagged; operator requeue then one new worker | `core/tests/integration/pipelineInterruption.process.test.js` |
| Worker result committed, Core dies before responding | Real death | One result; identical exact-lease retry returns `alreadyRecorded` and releases only its orphan slot; changed retries stay refused | same |
| Human decision committed, Core dies before responding | Real death | Decision persists; repetition is a no-op; stale worker cannot reopen it | same |
| Shutdown during a probe or with a missing terminal | Real process, signals | Exact receipt or quarantine; bounded exit | `core/tests/integration/serverShutdown.process.test.js` |
