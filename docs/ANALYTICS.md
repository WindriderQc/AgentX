# Reading Analytics

Open `/analytics` for a compact overview of recorded AgentX-routed calls.
The selected period applies to the four headline metrics, the volume/error
chart, model or consumer comparison, and local/cloud accounting. The default
is 24 hours. Models and consumers share the same total-call denominator;
**All other calls** includes rows omitted from the compact comparison.
**Explore the details** retains routing, full model tables, Playground analytics,
knowledge, provider and subscription panels.

## What the numbers mean

- **Inference calls** counts recorded calls across callers and routes. Calls
  made by a native provider without passing through Core are outside this view.
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

The overlaid chart uses calls on the left axis and operational error percentage
on the right. Cancellations are excluded from that error percentage. Buckets
are hourly for 24 hours and daily otherwise, in UTC; first and last buckets can
be partial. Empty buckets in a successfully read window have zero calls and
no error percentage. Retention is disclosed, including when a requested window
exceeds it; retention configuration does not prove complete collection.

Historical values are snapshots refreshed on demand. The snapshot time stays
visible; after five minutes the status asks for a refresh. Failed reads clear
the overview's prior values. Later responses for a superseded period are ignored.
Playground conversation panels retain their separately labeled period and
cover conversations, not platform-wide calls.

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
