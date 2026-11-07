# Reading Analytics

Open `/analytics` for a compact overview of Core-observed calls and declared
direct-provider usage.
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
  without passing through Core appear only when a runtime submits a declared
  usage receipt. Undeclared traffic remains outside this view.
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
  Declared receipts use their native USD cost or a configured estimate; unknown
  cost and subscription usage have no invented API price. Models with any
  unpriced calls are identified. No recorded cloud calls is
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
Operations watch excludes successful/cancelled queue notices and acknowledged
failures with a native release receipt from its current findings. They remain
in the inbox/history. Active failures, uncertain outcomes, unverified receipts
and acknowledged operational incidents still participate in surveillance.

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

The instance's secretary review jobs declare the `secretary-service` principal
and Core's memory-note index declares `core-memory`; Core maps them to
`secretary-service-v1` and `core-memory-v1` the same way. Explicit-model clients
such as OpenClaw and Eko name no router task, so their calls stay **not
declared** for task type: Core does not derive a task from the consumer
contract. Group them by contract instead.

Household (surface) turns record the same message fields as the Playground:
`stats.usage` with the tokens the engine measured (summed over a tool loop),
`stats.meta.model` with the model that served the message (the principal
alias resolved to the host pin current at record time, alias kept in
`requestedModel`) and `cost`. An engine that reports no complete counts leaves
usage unknown. A cloud provider without a
configured price keeps its tokens and an unknown cost, never $0. Chat cost,
feedback and stats grouped by model use each message's own model; the
conversation's `model` is only its latest one. A turn with supplied knowledge
sources, or a native agent turn with a `rag_search`, `memory_search` or
`wiki_search` receipt, marks the conversation `ragUsed`; a turn where retrieval
ran or the agent owns a knowledge tool marks it `ragRequested`. Historical
turns are not backfilled.

Output throughput (`tokensOutPerSecond`) is null when a row produced no output
tokens, as embeddings never do. A model OpenClaw ran itself is recorded as
`openclaw:model:<provider>/<model>`; cloud classification and pricing read the
provider inside that name, so OpenRouter calls through the LAN gateway count
as cloud.

## Declared native usage

`POST /api/analytics/runtime-usage` accepts content-free receipts from Hermes
and OpenClaw on the existing private-LAN Analytics boundary. This is declared
accounting, not server-attested execution or a new consumer principal. Required
fields are `runtime` (`hermes` or `openclaw`), stable `instanceId`, native `runId`,
integer `callIndex`, `transport: "direct-provider"`, `provider`, `model`,
`inputTokens`, `outputTokens`, `billing` (`metered` or `subscription`) and ISO
`completedAt`. `inputTokens` includes cached input; optional `cachedInputTokens`
is its cache-read subset. Optional `durationMs` measures the native call/run,
and `nativeCost: { amount, currency: "USD" }` reports a known metered cost.
Missing token counts refuse; unknown costs stay null. Configured pricing is
used only without cached input, because the ordinary calculator has no cache
tariff. A run aggregate and its individual calls must never both be submitted.

The native identity `(runtime, instanceId, runId, callIndex)` deduplicates retries
atomically. Changing the payload under that identity returns 409. Keep native
identities, completion timestamps and arguments across retries, including lost
replies. Core stores only a hash of the native run id, plus accounting metadata,
in `inferencelogs` with `source: declared-receipt` and `runtime: external`.
Receipts outside the configured inference-log retention refuse with 410;
historical calls are not backfilled automatically. The response supplies a
`receiptId`; `GET /api/analytics/runtime-usage/:receiptId` reconciles it through
the safe inference-log projection. It does not expose native session ids.

A call already recorded by Core uses `transport: "core"` with its exact
`coreLogId` and native identity instead. Core binds that identity to the existing
row without adding usage; an unconfirmed log refuses with 409. A later direct
declaration under the bound identity conflicts. Runtime collectors must select
only explicitly configured direct providers: a provider label alone does not
prove that it bypasses Core. Do not run both a call collector and a run-aggregate
collector on the same traffic. The current local LLM gateway does not forward
OpenRouter; provider-routing changes require their own compatible transport.

Inference summary and federated buckets expose `coreObservedCalls` and
`declaredCalls`; log rows expose their source and declared billing/cost kind.
The cloud overview names the declared count. Stored native costs are not priced
again. Partial known costs remain a partial total with unpriced coverage.
`cloud_health` retains its token-limit semantics: Core-observed cloud tokens
and declared **known-cost metered** tokens enter its gate. Subscription and
unpriced declarations remain visible but are excluded; the budget reports
`cloud_gate_tokens`, `cloud_declared_requests` and
`cloud_excluded_declared_requests`. These records are not a provider invoice.

Household Hermes submits its completed native run receipt directly to this Core
service. A duplicate browser turn reuses the same native declaration. Native
local/Core fallback is excluded. The durable run journal retains the source
receipt and a content-free pending outbox if accounting is unavailable. Later
observations retry the same entries, including across subsequent native runs;
only acknowledged receipts leave the outbox. At 1,000 pending entries a new
native run refuses until accounting is reconciled. The journal can also be
resubmitted with the collector.
Accounting failure does not discard a completed conversation answer.

`integrations/operations/runtime-usage-sync.cjs` translates native OpenClaw
agent-session JSONL on its host. It sends metadata and usage only, including
tool-use calls, and never invokes a model. Explicit `--direct-providers` excludes
Core bridges; model-mode executions do not use this agent transcript. Example:

```sh
node integrations/operations/runtime-usage-sync.cjs \
  --core-url https://core.example.test \
  --sessions-dir /absolute/native/agent/sessions \
  --instance-id native-openclaw-instance \
  --direct-providers openrouter,openai-codex --lookback-days 30
```

Use the same instance id on every run. Set lookback within Core's retention.
Run the collector through the instance's existing native operational scheduler;
source delivery does not install a recurring job. No new compute queue is used.
For an archived Hermes terminal journal, pass `--hermes-state /absolute/state.json`
and `--hermes-origin https://hermes.example.test` instead of the OpenClaw flags.
The state contains `runId`, stable `settledAt` and native terminal `receipt`.
Retain the original Hermes origin, which determines the same instance id as the
live transport. Native Hermes use outside Household must supply its terminal
run journal through this adapter; merely installing Core does not instrument
another native entry point.

OpenClaw continuity projects usage from its existing bounded native transcript
only when the exact run's first assistant call follows a retained user boundary,
every assistant call has complete native counts, and the final reply is terminal.
Missing, clipped, delegated and repeated-message evidence stays unknown. Core
stores the measured sum on the household turn; it does not sum its own bridge
logs again. This chat accounting is separate from platform inference totals.
