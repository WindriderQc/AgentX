# Reading Analytics

Open `/analytics` for a compact overview of recorded AgentX-routed calls.
The selected period applies to the four headline metrics, the volume/error
chart, model or consumer comparison, and local/cloud accounting. The default
is 24 hours until the operator starts the daily-use reporting period. Then
**Since daily use began** is the default; rolling periods still include earlier
records. This boundary selects dates, not traffic purpose: later tests and
Benchmark calls remain included. Models and consumers share the same total-call denominator;
**All other calls** includes rows omitted from the compact comparison.
**Errors** switches that same comparison to cause × consumer, with model detail
on hover. Its bars and percentages use all operational errors as the denominator;
**All other errors** preserves the remainder beyond the displayed groups.
**Explore the details** retains routing, full model tables, Playground analytics,
knowledge, provider and subscription panels.

Mini-curves beside calls, output and latency show the same UTC buckets as the
main chart. Each uses its own scale with a zero baseline; missing observations
leave gaps. Outcome and local/cloud rings require reconciled counts. Empty or
failed reads leave a neutral ring. GPU tracks distinguish load from allocated
VRAM on the same 0–100% scale; memory allocation is not evidence of GPU work.
The model/consumer view compares call share (blue) with share of recorded elapsed
time (violet), each against its own full-window total. These comparisons describe
observations, not a claim that one metric caused another.

## What the numbers mean

- **Inference calls** counts recorded attempts across callers and routes,
  including admission refusals. A gateway waiting for a reservation may record
  several refused attempts for one client request. Its error rate is an attempt
  rate, not a percentage of failed user requests. Calls made by a native provider
  without passing through Core are outside this view.
- **Completed successfully** is successful terminal records divided by all
  records. Errors and caller cancellations remain separate below it. An empty
  window has no success percentage.
- **Reported output tokens** and prompt tokens include reported usage only.
  Missing usage cannot establish that no tokens were consumed.
- **Mean call latency** averages calls with a positive recorded duration.
  Partial timing coverage is shown. **Summed call time** adds end-to-end call
  durations, including routing and waits. Concurrent calls overlap. Neither
  this sum nor local elapsed time measures GPU busy time, rented compute,
  energy use or native decoding speed. Output tok/s in the detailed table uses
  that same end-to-end duration.
- **Cloud estimate** uses configured token prices for recognized cloud calls.
  Unpriced models are identified and excluded. No recorded cloud calls is
  different from unpriced traffic. All models contribute to local/cloud totals;
  the detailed model list displays at most 40, with coverage in the API.

The overlaid chart uses calls on the left axis. **Errors** puts operational error
percentage on the right; **Latency** puts mean end-to-end seconds there for the
same buckets. The right axis is labeled separately and scales independently.
Cancellations are excluded from the error percentage. Buckets
are hourly for 24 hours and daily otherwise, in UTC; first and last buckets can
be partial. Empty buckets in a successfully read window have zero calls and
no error percentage. Retention is disclosed, including when a requested window
exceeds it; retention configuration does not prove complete collection.

The chart footer links to the error comparison and reports how many errors were
admission refusals. A reservation, active incompatible inference or recovery
quarantine can refuse an attempt before inference is dispatched; this is not
evidence that the model failed. Refusals remain in the totals. The embedding path's stable `admission_refused` reason also counts as an admission
refusal, even on legacy rows whose broad outcome code says upstream or fallback
failure. Its specific blocking cause remains unspecified; raw error prose never
establishes the cause. These historical
causes do not establish that the host is still blocked; use Live inference for
the current state.

`failureAnalysis.byReason` reconciles all errors; `topErrors` shows at most ten
cause/consumer/model groups. Causes come from a closed operational vocabulary,
never upstream error text. New trusted-runtime records retain their terminal
outcome. Older unknown outcomes can use a terminal failed admission retry only
when its attempt, zero retry delay and admission-only timing support it. Earlier
retries cannot explain a later provider failure. Missing evidence stays
**Cause unrecorded**; an older Core without these fields shows causes unavailable.

The consumer attribution line reports identified versus missing contracts and
breaks missing calls down by caller category. Its inspection link opens the
canonical paged log API for that exact time window with
`consumerContractMissing=true`; `false` selects identified contracts. This filter
cannot be combined with an exact `consumerContract`. Missing means absent,
null, empty, or the legacy `unknown` label. Runtime, caller category and task
type do not prove application identity; historical contracts are not inferred.
`attribution` in the summary exposes these same counts and a nullable percentage
for an empty window. Core Ops Watch stamps `core-ops-watch-v1` on new calls.
The error link also discloses causes that remain unrecorded. The bounded
`read_presentation` receipt carries attribution counts and unclassified errors
to clients reading the exact selected summary.

Historical values are snapshots refreshed on demand. The exact window and browser timezone stay
visible; after five minutes the status asks for a refresh. Failed reads clear
the overview's prior values. Later responses for a superseded period are ignored.
Playground conversation panels retain their separately labeled period and
cover conversations, not platform-wide calls.

## Moving from development to daily use

`GET /api/analytics/inference/usage-period` reads the optional reporting boundary.
An operator starts it with `PUT` on that path and `{ "since": "<ISO timestamp with timezone>" }`.
The timestamp must not be in the future. Repeating the same timestamp is safe;
a different timestamp refuses with 409. This writes one reporting marker and
never deletes logs, alerts, Benchmark results, admissions or recovery receipts.
`summary?window=usage` returns 409 before a marker exists. Afterwards its exact
window and presentation receipt share that boundary, limited to retained history
(at most 90 days), with the original start and retention disclosed.

The overview's attention state uses the last hour within the selected period.
Attested admission refusals are informational and listed separately; other
errors, including unclassified failures, still need review. Historical errors
and their last occurrence remain visible without declaring a current outage.
No recent traffic means no recent observation. Live admissions, maintenance and
quarantines retain their independent display. Playground, provider and
effectiveness details use 24 hours when the daily-use period is selected;
subscription panels retain their native monthly/quota periods.

At transition, review terminal work notifications through their native receipts
and acknowledge reviewed outcomes in Core's alert inbox. Acknowledgment does not
turn failed work into success or close linked tasks. Keep unresolved incidents
visible until their owner verifies recovery; never use a bulk age cleanup to
clear uncertain execution or native release records.

Core generation binds new calls from its resolved `benchmark-service` principal
to `benchmark-service-v1`. Existing explicit internal consumer contracts are
preserved. A benchmark-like `callerDetail` or a contract in the request body
does not establish that identity. This follows the existing private-LAN service
attribution contract; native workload proof and admission remain required.
Historical records without a contract remain unchanged.

Benchmark generation and judge calls carry the same bounded
`workItemId=benchmark-workload/<workload-id>` through Core's existing telemetry.
Use the existing `/api/analytics/inference/logs?workItemId=…` filter to inspect
one operation. This links calls without another task store or dashboard panel;
native workload proof and admission are unchanged. Older rows and calls with
no valid workload identity remain unlinked.

## Live inference and GPU work

In the full profile, **Live inference** reads Core's existing runtime-coordination
snapshot and GPU telemetry every 15 seconds while the page is visible.
Active, unexpired admissions are counted separately from uncertain/quarantined
records, held workloads and maintenance. An admission is not a GPU-utilization
measurement. Failed reads leave the current work unknown.

GPU rows use fresh collector samples only and show utilization, used/total
VRAM, sample age and reported power. CPU endpoints are excluded. Endpoints
reporting the same collector GPU are deduplicated by physical bus identity.
Configured capacity and Ollama residency do not substitute for GPU telemetry;
a stale or missing sample reads unknown, not idle.

Open `/nerve-center?focus=cluster` for host cards, GPU utilization, VRAM,
residency and sampled occupancy history. `/nerve-center?focus=inference` opens
inference detail. `/performance` concerns Core page/API response times.
Demo omits the live panel and does not probe disabled operational routes.

## Verification

The route and integration suites cover full-model accounting, UTC buckets,
outcome separation and missing timing. The integration suite uses disposable
local MongoDB. `tests/browser/analyticsOverviewJourney.cjs` serves synthetic
receipts locally, never a model or production database; it checks seven
viewports, window races, failures, empty activity, stale telemetry, keyboard
detail access and the demo profile. Run it from the repository with Playwright
available, or set `AGENTX_PLAYWRIGHT_MODULE` to its installed module path.
`AGENTX_ANALYTICS_BROWSER_REPORT` selects an out-of-Git screenshot directory.

RAG's Core-bound embedding, query-expansion, reranking and compression requests
declare the existing `rag-service` principal. Core maps it to `rag-service-v1`
and records the same contract on embedding attempts and their route decisions,
including failures. This is the existing private-LAN attribution boundary, not
an authentication change; caller detail and request-body contracts do not
establish service identity. Direct native calls and historical rows are unchanged.
