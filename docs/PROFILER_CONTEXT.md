# Interpreting context profiles

The Profiler's [runtime continuity panel](OPERATOR_UI.md#profiler) distinguishes
a saved measurement from restoration and runtime release. An interrupted request
does not establish a context ceiling or authorize replay.

Keep four different observations separate:

- **Model capacity** is the declared window in model metadata.
- **Tested context** is the largest candidate that passed the recorded workload,
  repeated samples, GPU checks and request deadline for an exact artifact/runtime.
- **Interactive/document recommendations** select passing candidates under their
  configured throughput-degradation thresholds. They are performance policies,
  not measurements of maximum memory capacity or recall quality.
- **Active context** is the instance's selected runtime contract. A profile or
  transport correction does not itself authorize changing this contract.

For normal routed inference, Core sends the HostPreference pin as `options.num_ctx`
when the caller omits that option. A verified workload recommendation remains
separate evidence: it does not override the pin or rewrite a Modelfile. If no
pin exists, an explicit Modelfile `PARAMETER num_ctx` is a fallback before a
verified profile recommendation. Native `model_info.context_length` describes
capacity and does not set a normal request context. A caller that deliberately
sends a different `num_ctx` changes the request; the OpenClaw bridge rejects a
value that differs from its effective routed context with
`CONTEXT_POLICY_MISMATCH`.

A transport failure at the next candidate does not prove a VRAM ceiling. Inspect
each sample's failure, latency, actual prompt tokens and GPU evidence. Preserve
earlier receipts: a targeted large-window success and a later full sweep may
measure different workloads and use different baselines. A single-point targeted
probe cannot establish a small-prompt-relative interactive recommendation.

The probe records this distinction. A step or sample with
`failureKind: "transport"` ended without an answer from Ollama (the client
deadline expired or the connection was lost) while the model stayed fully
GPU-resident at the requested context. It reports no degradation percentage,
because no throughput was measured. Every other failure is `"capacity"`,
including a transport failure without that residency proof. When the nearest
failure above the tested context is a transport failure, the snapshot and the
context profile's latest evidence carry `ceilingFailureKind: "transport"` and
the tested context is a floor. Such a run may raise `maxVerifiedContext`, but it
keeps a higher value already verified for the same artifact and runtime
(`latestEvidence.ceilingRetained: true`) unless the same run holds capacity
evidence at or below it. Raise `CONTEXT_PROBE_TIMEOUT_MS` to verify a window
whose reload and prefill exceed the request deadline.

Every ladder rung is measured with its prompt filled to the probe's fill
percentage of that rung's window. The interactive recommendation and the
performance knee therefore price a nearly full window. They do not measure a
short prompt in a large allocated window; Full's throughput curve, which holds
the allocation fixed and varies the fill, is the evidence for that.

The prompt generator's requested fill is not the measured tokenizer coverage.
Use `promptTokens` and `promptCoveragePct` for the actual workload. Neither an
allocated context window nor a partially filled successful probe proves recall
quality across every token of that window. `qualityContextStatus: unknown` is
intentional until separate quality evidence exists.

## Pin context proposals

A completed profile compares its evidence with the host's Core pins
(`GET /api/profiler/context-proposals?hostId=` and the profile progress result's
`contextProposal`). Each probe sample records the other models Ollama reported
loaded beside the probed model (`coResidents`: model, size, VRAM share, context;
`null` when the inventory was unreadable).

- **Proposed** is the largest passing candidate whose samples all had the model
  and every other pinned resident fully in VRAM, each co-resident at its pinned
  context when one is set. Expected VRAM is the host usage recorded there.
- **Unknown limit**: no candidate has that proof, or the profile predates
  co-resident recording. The candidates and missing residents are listed; the
  qualification is a reprofile with the listed pins resident. A context verified
  alone is shown as such, never offered as the pin. A decrease is offered only
  after a capacity failure (spill/OOM) at or below the current pin; a ladder that
  stopped on a transport timeout (`contextCeilingFailureKind: transport`) only
  proves a floor and asks for requalification with a longer probe deadline.
- **Not pinned** / **not applicable** (embedders) / **matches**: no offer.

Interactive and document recommendations are available for workload-specific
request budgeting only when their exact-artifact evidence is verified. Normal
pinned calls keep the pin's window unless the caller explicitly selects another
allowed request context. A proposal never writes recommendations into the pin.

`POST /api/profiler/context-proposals/:model/decision` takes `{ hostId,
proposalId, contextSize, decision }` naming the exact proposal shown; a changed
proposal is refused as `PROPOSAL_STALE`. `keep_current` is recorded and keeps the
proposal visible until the pin matches or a newer profile (new `proposalId`)
replaces it. `apply` is forwarded to Core's guarded `pin/context` route (see
[resident model pins](OPERATIONS.md#resident-model-pins)); its outcome, including
a rollback, is recorded with the decision. When Core gives no HTTP answer the
decision is `apply_outcome_unknown`: Core may have applied the pin, so the next
read compares against the live pin and the operator checks it before retrying.

## HTTP deadlines

Long non-streaming probes can spend several minutes before response headers.
The Benchmark Ollama client uses the existing `node-fetch` dependency and HTTP
agents, with its AbortSignal deadline covering headers and the response body.
Native Node fetch uses a different transport and can impose a separate headers
deadline before the configured probe budget expires. Do not silently replace
the client transport or treat a generic `fetch failed` as a model capacity result.

The normal client tests cover delayed headers, stalled headers/body and caller
cancellation using loopback HTTP, without Ollama. An optional real-time regression
waits 310 seconds before headers with a 420-second request budget:

```powershell
$env:OLLAMA_CLIENT_LONG_HTTP_TEST = '1'
npm test --prefix benchmark -- --runInBand tests/unit/ollamaClientTransport.test.js
Remove-Item Env:OLLAMA_CLIENT_LONG_HTTP_TEST
```

This test performs no inference. Passing it repairs transport evidence; it does
not retroactively qualify a historical profile, change pins, or establish a new
context recommendation. An authorized future GPU probe is a separate operation.
