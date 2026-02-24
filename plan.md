# Host Full Test Page — Revised Implementation Plan

## Summary

Build a **Host Full Test Page** that lets operators run comprehensive
performance tests on every model across all configured Ollama hosts.
Tests measure real throughput (tokens/sec), latency, and VRAM consumption.
All results persist to ModelRegistry so every service downstream
(routing, benchmarks, chat) benefits from empirically measured data.

The page reuses the existing context probe infrastructure and adds a new
**lightweight performance probe** that is faster to run (single generation,
no binary search) and stores per-host throughput snapshots directly in the
Model Registry.

---

## Architecture Overview

```
┌──────────────────────────────────────┐
│          host-test.html (UI)         │
│  Host cards → Model list → Actions   │
│  Results table + Chart.js charts     │
└──────────────┬───────────────────────┘
               │ fetch()
               ▼
┌──────────────────────────────────────┐
│      routes/host-test.js (API)       │
│  GET  /hosts-status                  │
│  POST /run                           │
│  POST /run-all                       │
│  GET  /results                       │
│  GET  /results/:model                │
└──────────────┬───────────────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
┌──────────────┐  ┌───────────────────────────────┐
│ hostTestSvc  │  │ contextProbeService (existing) │
│  (NEW)       │  │   Binary-search num_ctx        │
│  Quick perf  │  │   Already persists to registry │
│  probe       │  └───────────────────────────────┘
└──────┬───────┘
       │ persist
       ▼
┌──────────────────────────────────────┐
│  ModelRegistry.hostPerformance[]     │  ← NEW sub-schema
│  + capabilities.avgTokensPerSec      │  ← NEW field
│  + capabilities.avgLatencyMs (existing)
│  + capabilities.p95LatencyMs (existing)
└──────────────────────────────────────┘
```

---

## Phase 1: Schema Extension — ModelRegistry

### 1.1 Add `HostPerformanceSnapshot` sub-schema

**File:** `models/ModelRegistry.js`

This stores per-host test results. A model can exist on multiple hosts;
each host gets its own snapshot. Array capped at 50 entries per model
(latest per host kept, oldest pruned).

```javascript
const HostPerformanceStepSchema = new mongoose.Schema({
  hostUrl: { type: String, required: true },
  hostId: { type: String },                       // 'primary' | 'secondary' | 'tertiary'
  tokensPerSec: { type: Number, required: true },  // eval_count / eval_duration
  promptEvalTokensPerSec: { type: Number },        // prompt_eval_count / prompt_eval_duration
  latencyMs: { type: Number, required: true },     // wall-clock time
  timeToFirstTokenMs: { type: Number },            // prompt_eval_duration in ms
  promptTokens: { type: Number },
  completionTokens: { type: Number },
  vramUsedMiB: { type: Number },
  vramTotalMiB: { type: Number },
  numCtx: { type: Number },                        // context size used for test
  testedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['pass', 'fail', 'timeout', 'error'], default: 'pass' },
  error: { type: String }
}, { _id: false });
```

Add to `ModelRegistrySchema`:
```javascript
hostPerformance: [HostPerformanceStepSchema]   // Max 50, pruned on write
```

### 1.2 Add `avgTokensPerSec` to CapabilitiesSchema

**File:** `models/ModelRegistry.js`

```javascript
avgTokensPerSec: { type: Number, default: null, min: 0 }
```

This is the overall average tokens/sec across all passing host tests.
Updated automatically when host tests complete.

### 1.3 Add static method `updateHostPerformance()`

**File:** `models/ModelRegistry.js`

```javascript
/**
 * Persist a host performance snapshot and recalculate capabilities.
 * Keeps max 50 snapshots (latest per host, FIFO for old entries).
 * Recalculates: avgTokensPerSec, avgLatencyMs, p95LatencyMs from
 * the stored snapshots.
 *
 * @param {string} modelName
 * @param {object} snapshot - HostPerformanceStepSchema-compatible object
 * @returns {Promise<Model>} Updated model
 */
ModelRegistrySchema.statics.updateHostPerformance = async function(modelName, snapshot) {
  const model = await this.findOne({ modelName });
  if (!model) return null;

  // Push new snapshot
  model.hostPerformance.push(snapshot);

  // Prune: keep max 50, prefer latest per host
  if (model.hostPerformance.length > 50) {
    // Sort by testedAt desc, keep first 50
    model.hostPerformance.sort((a, b) => (b.testedAt || 0) - (a.testedAt || 0));
    model.hostPerformance = model.hostPerformance.slice(0, 50);
  }

  // Recalculate capabilities from passing snapshots
  const passing = model.hostPerformance.filter(s => s.status === 'pass');
  if (passing.length > 0) {
    const avgTps = passing.reduce((sum, s) => sum + s.tokensPerSec, 0) / passing.length;
    const avgLat = passing.reduce((sum, s) => sum + s.latencyMs, 0) / passing.length;
    const sortedLat = passing.map(s => s.latencyMs).sort((a, b) => a - b);
    const p95Idx = Math.min(Math.ceil(sortedLat.length * 0.95) - 1, sortedLat.length - 1);

    model.capabilities.avgTokensPerSec = Number(avgTps.toFixed(2));
    model.capabilities.avgLatencyMs = Math.round(avgLat);
    model.capabilities.p95LatencyMs = Math.round(sortedLat[p95Idx]);
  }

  model.lastUpdated = new Date();
  return model.save();
};
```

**Why this design:**
- One array per model keeps the data co-located with the registry entry
- Aggregated capabilities fields let routing, benchmarks, and chat services
  read performance without re-querying snapshots
- Capped at 50 to prevent unbounded growth
- Recalculates on every write so capabilities are always fresh

---

## Phase 2: Host Test Service

### 2.1 Performance Probe

**New file:** `src/services/hostTest/hostTestService.js` (~200 lines)

This is a **lightweight** performance test. Unlike the context probe
(which binary-searches context sizes), this runs a single generation at
the model's effective num_ctx and records throughput metrics.

#### `testModelOnHost(modelName, hostUrl, options)`

```
1. VALIDATE
   - Verify host reachable: GET {hostUrl}/api/tags (timeout 5s)
   - Verify model exists on host (model name in tags response)

2. WARM-UP (mandatory for precision)
   - Send a short prompt ("Hello") with num_predict: 1
   - Ensures model is loaded into VRAM before measuring
   - Record warm-up latency (not included in results)

3. PROBE
   - Get effective num_ctx from ModelRegistry (user override → tested → auto → 8192)
   - Generate fill prompt at 25% of num_ctx (enough to measure, not too slow)
   - POST /api/generate { model, prompt, stream: false, options: { num_ctx, num_predict: 64 } }
   - Parse response:
     - tokensPerSec = eval_count / (eval_duration / 1e9)
     - promptEvalTps = prompt_eval_count / (prompt_eval_duration / 1e9)
     - timeToFirstTokenMs = prompt_eval_duration / 1e6
     - latencyMs = wall clock (Date.now() - start)
     - promptTokens = prompt_eval_count
     - completionTokens = eval_count
   - Snapshot VRAM via ollamaVramService.getHostVram()

4. PERSIST
   - Call ModelRegistry.updateHostPerformance(modelName, snapshot)
   - Return snapshot object to caller

5. ERROR HANDLING
   - Timeout (default 60s) → status: 'timeout'
   - HTTP error → status: 'error', record error message
   - Model not found on host → throw clear error (don't persist)
   - Host unreachable → throw clear error (don't persist)
```

**Why warm-up:** Ollama lazy-loads models into VRAM. Without warm-up,
the first request includes model load time, skewing latency 10-100x.
A 1-token warm-up ensures VRAM is populated. The warm-up cost is ~2-5s,
a tiny fraction of any multi-model test run.

**Why 25% context fill:** We want to measure generation throughput, not
stress-test context limits (that's what context probe does). 25% gives
a realistic prompt size without being so large it dominates latency.

**Why num_predict: 64:** Enough tokens to get a stable tokens/sec
measurement. Too few (1-5) has high variance; too many (500+) wastes
time when we only need throughput signal.

#### `testAllModelsOnHost(hostUrl, options)`

```
1. Fetch models from host via GET /api/tags
2. Filter: exclude embeddings, diagnostic models (same logic as ollama-hosts.js)
3. For each model (sequential — avoid GPU contention):
   a. Call testModelOnHost(modelName, hostUrl, options)
   b. Emit progress via options.onProgress(modelName, result, index, total)
   c. On error: record failure, continue to next model
4. Return { host, results[], summary: { total, passed, failed, avgTps } }
```

**Why sequential:** Running parallel model tests on the same GPU causes
VRAM thrashing and invalidates performance measurements. Sequential
ensures each model has exclusive GPU access during its test.

#### `testModelAcrossHosts(modelName, options)`

```
1. Look up model in registry → get sourceHost
2. Get all configured hosts (getOllamaHosts pattern)
3. For each host:
   a. Check if model exists on that host (GET /api/tags)
   b. If yes: call testModelOnHost(modelName, hostUrl)
4. Return { model, hostResults[] }
```

Useful for comparing a model's performance across primary/secondary/tertiary.

### 2.2 Configuration

```
HOST_TEST_TIMEOUT_MS=60000          # Per-model test timeout (default 60s)
HOST_TEST_NUM_PREDICT=64            # Tokens to generate (default 64)
HOST_TEST_CONTEXT_FILL_PCT=25       # % of num_ctx to fill with prompt (default 25)
HOST_TEST_WARMUP=true               # Enable warm-up (default true)
```

---

## Phase 3: API Routes

### 3.1 New Route File

**New file:** `routes/host-test.js` (~180 lines)

Mounted at `/api/host-test`.

#### Endpoints:

```
GET /api/host-test/hosts-status
  Returns all configured hosts with connectivity status, model count, latency.
  Reuses getConfiguredHosts() from ollama-hosts.js and checkHostHealth() from modelRouter.
  Response: {
    hosts: [{
      id, name, url, available, latency, modelCount, models[]
    }]
  }

POST /api/host-test/run
  Run performance test for a specific model on a specific host.
  Body: { modelName, hostUrl, hostId? }
  Validates model exists on host before testing.
  Returns: { status: 'success', data: snapshot }
  Errors: 404 if model not on host, 503 if host unreachable.

POST /api/host-test/run-all
  Run performance tests for ALL models on a specific host.
  Body: { hostUrl, hostId? }
  Fire-and-forget: returns immediately, tests run in background.
  Returns: { status: 'started', testId, totalModels }
  Progress tracked via in-memory map (testId → { total, completed, results[] }).

GET /api/host-test/run-all/:testId/progress
  Poll progress of a run-all batch.
  Returns: { status, total, completed, failed, currentModel, results[] }

GET /api/host-test/results
  Query all host performance snapshots across all models.
  Query params: hostUrl?, hostId?, limit (default 100)
  Aggregates from ModelRegistry.hostPerformance arrays.
  Returns: { results[], summary: { modelsTested, avgTps, avgLatency } }

GET /api/host-test/results/:modelName
  Get host performance history for a specific model.
  Returns: { model, hostPerformance[], capabilities }
```

### 3.2 In-Memory Progress Tracker

For `run-all` operations, we need progress tracking without a persistent
queue (this is an interactive UI feature, not a SpecialX automation task).

```javascript
// In-memory map: testId → { status, total, completed, failed, currentModel, results[], startedAt }
const activeTests = new Map();
// Auto-cleanup after 30 minutes
```

**Why not queue-based:** Host tests are interactive UI operations, not
background automation. The user watches progress in real-time. A full
AutomationTask/SpecialX run is overkill here. The in-memory tracker
is cleared on server restart, which is fine — stale test state has no
value.

---

## Phase 4: Frontend Page

### 4.1 HTML Page

**New file:** `public/host-test.html` (~250 lines)

Structure follows existing conventions (dashboard.html pattern):

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <title>AgentX • Host Test</title>
    <!-- Standard head: fonts, styles.css, font-awesome, Chart.js -->
</head>
<body>
    <div id="nav-container"></div>
    <script src="/js/components/nav.js"></script>
    <script src="/js/workspace.js"></script>
    <script>injectNav('host-test');</script>
    <div class="bg-grid"></div>

    <div class="host-test-page">
        <header class="page-header">
            <div>
                <div class="eyebrow">AgentX • Infrastructure</div>
                <h1><i class="fas fa-flask"></i><span class="title-separator"></span>Host Full Test</h1>
                <p class="lede">Test model performance across all Ollama hosts</p>
            </div>
            <div class="header-controls">
                <button id="refreshHostsBtn" class="btn small">
                    <i class="fas fa-sync-alt"></i> Refresh
                </button>
            </div>
        </header>

        <!-- Host Cards Row -->
        <section id="hostsSection" class="stats-row">
            <!-- Dynamically populated: one card per host -->
        </section>

        <!-- Action Bar -->
        <section id="actionBar" class="section-card" style="display:none;">
            <!-- Model selector, test buttons, progress indicator -->
        </section>

        <!-- Results Section -->
        <section class="analytics-grid">
            <!-- Left: Results Table -->
            <div class="section-card" id="resultsTableCard">
                <div class="section-header">
                    <h2>Test Results</h2>
                    <div class="header-actions">
                        <select id="resultFilterHost" class="form-select small">
                            <option value="">All Hosts</option>
                        </select>
                    </div>
                </div>
                <div class="section-body">
                    <table id="resultsTable">
                        <thead>
                            <tr>
                                <th>Model</th>
                                <th>Host</th>
                                <th>Tokens/s</th>
                                <th>Latency</th>
                                <th>TTFT</th>
                                <th>VRAM</th>
                                <th>Status</th>
                                <th>Tested</th>
                            </tr>
                        </thead>
                        <tbody id="resultsBody"></tbody>
                    </table>
                </div>
            </div>

            <!-- Right: Charts -->
            <div class="section-card" id="chartsCard">
                <div class="section-header">
                    <h2>Performance Charts</h2>
                </div>
                <div class="section-body">
                    <div style="height: 300px; margin-bottom: 24px;">
                        <canvas id="tpsChart"></canvas>
                    </div>
                    <div style="height: 300px;">
                        <canvas id="latencyChart"></canvas>
                    </div>
                </div>
            </div>
        </section>
    </div>

    <script type="module" src="/js/host-test.js"></script>
</body>
</html>
```

### 4.2 Frontend JavaScript

**New file:** `public/js/host-test.js` (~400 lines)

#### State Management:
```javascript
const state = {
    hosts: [],              // Configured hosts with status
    selectedHost: null,      // Currently selected host for testing
    results: [],             // All test results (from API)
    activeTestId: null,      // ID of running run-all batch
    tpsChart: null,          // Chart.js instance
    latencyChart: null       // Chart.js instance
};
```

#### Core Functions:

```javascript
// 1. Load hosts and their status
async function loadHosts()
  // GET /api/host-test/hosts-status
  // Render host cards with: name, url, status dot, model count, avg latency
  // Click card → select host → show action bar

// 2. Select a host → populate action bar
function selectHost(hostId)
  // Show: model dropdown (from host's model list), "Test Selected" button,
  //        "Test All Models" button, progress bar

// 3. Run single model test
async function runSingleTest(modelName, hostUrl)
  // POST /api/host-test/run { modelName, hostUrl }
  // Show spinner on button, await result, add to results table + charts
  // On error: show toast with error message

// 4. Run all models on host
async function runAllTests(hostUrl)
  // POST /api/host-test/run-all { hostUrl }
  // Start polling GET /api/host-test/run-all/:testId/progress every 2s
  // Update progress bar: "Testing model X (3/12)"
  // Append each result to table as it completes
  // On complete: stop polling, refresh charts

// 5. Load historical results
async function loadResults(hostFilter?)
  // GET /api/host-test/results?hostUrl=...
  // Populate results table and charts

// 6. Render results table
function renderResultsTable(results)
  // Columns: Model, Host, Tokens/s, Latency, TTFT, VRAM, Status, Tested
  // Color-code: green (>20 tok/s), yellow (5-20), red (<5)
  // Sort by tokens/sec descending by default

// 7. Render charts
function renderCharts(results)
  // TPS Chart: horizontal bar chart, one bar per model, grouped by host
  //   x-axis: tokens/sec, y-axis: model names
  //   Color per host (primary=cyan, secondary=purple, tertiary=amber)
  // Latency Chart: bar chart showing latency per model
  //   Stacked: TTFT (bottom) + generation (top)
```

#### UI Interactions:
- Click host card → highlights, shows action bar with that host's models
- "Test Selected" → runs single model, result appears immediately in table
- "Test All Models" → progress bar animates, results stream into table
- Filter dropdown in results table → filter by host
- Results table sortable by any column header click

### 4.3 Navigation Registration

**File:** `public/js/components/nav.js`

Add to the **Monitor** group (after 'Performance'):

```javascript
{ label: 'Host Test', href: 'host-test.html', icon: 'fa-flask', id: 'host-test' }
```

---

## Phase 5: Model Registry Integration — Stats Flow

This is the critical path for "stats kept to benefit the model register."

### 5.1 Write Path (on every test completion)

```
testModelOnHost()
  → measures tokensPerSec, latencyMs, timeToFirstTokenMs, vramUsedMiB
  → calls ModelRegistry.updateHostPerformance(modelName, snapshot)
    → pushes to hostPerformance[] array
    → recalculates capabilities:
        capabilities.avgTokensPerSec    = avg of all passing snapshots
        capabilities.avgLatencyMs       = avg of all passing latency
        capabilities.p95LatencyMs       = 95th percentile of latency
    → saves model
```

### 5.2 Read Path (downstream consumers benefit)

| Consumer | Field Read | Benefit |
|----------|-----------|---------|
| **Model Router** (`routeRequest`) | `capabilities.avgLatencyMs` | Route to fastest host for task |
| **Chat Service** | `capabilities.avgTokensPerSec` | Estimate response time for user |
| **Benchmark** (`testExecution`) | `capabilities.avgLatencyMs` | More accurate timeout calculation |
| **Leaderboard** | `capabilities.avgTokensPerSec` | Performance ranking column |
| **Model Explorer** | `hostPerformance[]` | Per-host breakdown visualization |
| **Config Optimizer** | `hostPerformance[].numCtx` | Correlate num_ctx with throughput |
| **getBestForTask()** | `capabilities.p95LatencyMs` | Constraint: `maxLatency` filter |
| **getCategoryStats()** | `capabilities.avgLatencyMs` | Category-level avg latency |

### 5.3 Data Lifecycle

- **Fresh:** Snapshots < 24 hours old
- **Stale:** Snapshots > 7 days old (UI shows warning badge)
- **Pruned:** When array > 50, oldest are dropped on next write
- **No TTL auto-delete:** Data is always valuable as historical reference

---

## Measurement Precision Guarantees

### Warm-Up Protocol
Every test includes a mandatory 1-token warm-up request to the same model
on the same host. This ensures the model is loaded into VRAM before the
timed measurement begins. Without this, cold-start latency (model loading
from disk into VRAM) would corrupt throughput numbers.

### Metric Sources (from Ollama response)
| Metric | Source | Formula |
|--------|--------|---------|
| `tokensPerSec` | `eval_count`, `eval_duration` | `eval_count / (eval_duration / 1e9)` |
| `promptEvalTokensPerSec` | `prompt_eval_count`, `prompt_eval_duration` | `prompt_eval_count / (prompt_eval_duration / 1e9)` |
| `timeToFirstTokenMs` | `prompt_eval_duration` | `prompt_eval_duration / 1e6` |
| `latencyMs` | Wall clock | `Date.now() - start` |
| `promptTokens` | `prompt_eval_count` | Direct |
| `completionTokens` | `eval_count` | Direct |

**Why Ollama-native metrics:** We use Ollama's internal `eval_duration`
(nanoseconds) rather than wall-clock time for tokens/sec. This excludes
network latency, HTTP overhead, and JSON serialization, giving a pure
GPU throughput number. Wall clock is still recorded separately for
end-to-end latency.

### Sequential Execution
All models on a single host are tested sequentially (never parallel).
This prevents GPU memory contention where two models partially loaded
into VRAM would both page to CPU RAM, giving artificially low throughput.

### Consistent Test Conditions
- Fixed `num_predict: 64` (configurable via env var)
- Fixed `temperature: 0.1` (low randomness = consistent output length)
- Prompt fill: 25% of effective num_ctx (configurable)
- Same payload generator as context probe (deterministic text blocks)

---

## File Changes Summary

| Action | File | Estimated Lines |
|--------|------|-----------------|
| **Edit** | `models/ModelRegistry.js` | +40 (HostPerformanceStepSchema, avgTokensPerSec, updateHostPerformance) |
| **New** | `src/services/hostTest/hostTestService.js` | ~200 |
| **New** | `routes/host-test.js` | ~180 |
| **New** | `public/host-test.html` | ~250 |
| **New** | `public/js/host-test.js` | ~400 |
| **Edit** | `public/js/components/nav.js` | +1 (nav entry) |
| **Edit** | `server.js` or `app.js` | +2 (mount route) |

**Total new code:** ~1030 lines across 4 new files
**Total edits:** ~43 lines across 3 existing files

---

## Error Handling Matrix

| Scenario | Detection | Recovery | User Feedback |
|----------|-----------|----------|---------------|
| Host unreachable | `GET /api/tags` timeout 5s | Skip host, don't persist | Red status dot on host card |
| Model not on host | Model name not in `/api/tags` list | 404 response | Toast: "Model not found on host" |
| Generation timeout | `HOST_TEST_TIMEOUT_MS` exceeded | Record status: 'timeout' in snapshot | Yellow badge in results table |
| Ollama OOM | HTTP 500 from `/api/generate` | Record status: 'error' in snapshot | Red badge + error tooltip |
| VRAM unavailable | SSH fail in ollamaVramService | Continue without VRAM data (null) | VRAM column shows "—" |
| Warm-up fails | 1-token generate errors | Abort test for that model, record error | Error row in results |
| Concurrent test | Same model+host already testing | Reject with 409 | Toast: "Test already running" |
| Server restart during run-all | In-memory progress lost | UI polling gets 404 → shows "interrupted" | Status: "Interrupted, re-run" |

---

## Implementation Order

1. **Schema first** (Phase 1) — extend ModelRegistry, no runtime changes
2. **Service** (Phase 2) — hostTestService with tests
3. **Routes** (Phase 3) — API endpoints
4. **Frontend** (Phase 4) — page + JS
5. **Nav integration** — add to Monitor group
6. **Verify end-to-end** — run tests, check registry values update

---

## Not In Scope (Future)

- Scheduled periodic host tests (cron/SpecialX integration)
- GPU temperature monitoring during tests
- Multi-GPU host detection (treat host as single unit)
- Export test results to CSV/JSON
- Automated alerts when performance degrades below threshold
- Test history charts (time-series of a model's performance over weeks)
