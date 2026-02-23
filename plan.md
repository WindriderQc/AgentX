# Context Window Empirical Testing — Implementation Plan

## Summary

Replace heuristic-only context window detection with empirical binary-search probing.
Each model gets a real test: fill context progressively, measure tokens/sec,
detect the VRAM→CPU spill cliff, and store the proven limit in the registry.

---

## Phase 1: Schema & Data Layer

### 1.1 Add `contextTest` sub-schema to ModelRegistry

**File:** `models/ModelRegistry.js`

Add new embedded schema:

```javascript
contextTest: {
  testedNumCtx: Number,           // Proven max context (highest passing step)
  baselineTokensPerSec: Number,   // Speed at min context (reference point)
  atLimitTokensPerSec: Number,    // Speed at proven limit
  degradationPct: Number,         // % slowdown: limit vs baseline
  vramAtLimitMiB: Number,         // VRAM usage at proven limit
  modelTheoreticalMax: Number,    // From Ollama /api/show
  degradationThreshold: Number,   // Threshold used for this test (e.g. 50)
  testedAt: Date,
  testDurationMs: Number,
  hostUrl: String,                // Which host was tested
  status: { type: String, enum: ['pending', 'running', 'completed', 'failed'] },
  error: String,                  // Error message if failed
  steps: [{
    numCtx: Number,
    tokensPerSec: Number,
    promptTokens: Number,
    completionTokens: Number,
    vramUsedMiB: Number,
    vramTotalMiB: Number,
    latencyMs: Number,
    passed: Boolean,
    reason: String                // Why pass/fail
  }]
}
```

### 1.2 Update `getEffectiveConfig()` method

**File:** `models/ModelRegistry.js`

New priority chain:

```
User override (executionOverrides.num_ctx)
  → Tested limit (contextTest.testedNumCtx)     ← NEW
    → Auto-detected estimate (executionDefaults.num_ctx)
      → System default (8192)
```

Return source provenance:
- `source: 'user'` — user set it explicitly
- `source: 'tested'` — empirically proven ← NEW
- `source: 'auto'` — heuristic estimate
- `source: 'system'` — fallback default

---

## Phase 2: Context Probe Service

### 2.1 Payload Generator

**New file:** `src/services/contextProbe/contextProbePayload.js` (~50 lines)

Purpose: Generate a prompt that fills a target number of tokens.

- Use a repeating, predictable text block (prose paragraph)
- Approximate: 1 token ≈ 4 chars for English text (same heuristic as tokenCounter.js)
- Target: fill ~80% of the `num_ctx` with prompt, leave ~20% for generation
- Short generation request: "Respond with exactly one word: OK"
  (We only care about prompt processing speed, not generation)

Exports:
```javascript
function generateFillPrompt(targetTokens)
// Returns: { prompt: string, estimatedTokens: number }
```

### 2.2 Core Probe Service

**New file:** `src/services/contextProbe/contextProbeService.js` (~250 lines)

#### Configuration (env vars with defaults):

```
CONTEXT_PROBE_DEGRADATION_PCT=50     # Default: 50% speed drop = limit
CONTEXT_PROBE_ON_SYNC=false          # Auto-probe new models on sync
CONTEXT_PROBE_TIMEOUT_MS=120000      # 2 min timeout per step
CONTEXT_PROBE_MIN_CTX=2048           # Baseline context size
```

#### Main function: `probeModelContext(modelName, options)`

Algorithm:

```
1. RESOLVE HOST
   - Look up model in registry → get sourceHost
   - Validate host is reachable (GET /api/tags)

2. GET THEORETICAL MAX
   - POST /api/show { name: modelName } → model_info.context_length
   - Store as modelTheoreticalMax
   - This is the upper bound for binary search

3. DEFINE CANDIDATE LIST
   - Standard: [2048, 4096, 8192, 16384, 32768, 65536, 131072]
   - Filter: only candidates ≤ modelTheoreticalMax
   - If modelTheoreticalMax not available, cap at 65536

4. RUN BASELINE
   - num_ctx = CONTEXT_PROBE_MIN_CTX (2048)
   - Generate fill prompt for ~80% of 2048 tokens
   - Call Ollama /api/generate with { model, prompt, stream: false, options: { num_ctx } }
   - Record: tokens/sec, VRAM snapshot, latency
   - This is baselineTokensPerSec

5. BINARY SEARCH
   - low = index of baseline in candidates
   - high = last index in candidates
   - bestPassing = candidates[low]

   while low ≤ high:
     mid = floor((low + high) / 2)
     testCtx = candidates[mid]

     a. Generate fill prompt for ~80% of testCtx
     b. Call /api/generate with num_ctx = testCtx, timeout = CONTEXT_PROBE_TIMEOUT_MS
     c. Measure tokens/sec from response (eval_count / eval_duration)
     d. Snapshot VRAM via ollamaVramService.getHostVram()
     e. Record step result

     PASS conditions (ALL must be true):
       - No error / timeout
       - tokens/sec ≥ baseline × (1 - degradationThreshold/100)

     If PASS:
       bestPassing = testCtx
       low = mid + 1  (try higher)
     If FAIL:
       high = mid - 1  (try lower)

6. STORE RESULTS
   - Update ModelRegistry.contextTest with all fields
   - Update capabilities.maxContext = testedNumCtx
   - Do NOT overwrite executionDefaults (keep the heuristic for reference)
   - Set contextTest.status = 'completed'
```

#### Error handling:

- Ollama timeout → step fails, reduce context
- Ollama error (OOM, etc.) → step fails, reduce context
- SSH/VRAM unavailable → probe still works, just without VRAM snapshots
- Model not found on host → abort with clear error

#### Exports:

```javascript
async function probeModelContext(modelName, options = {})
// options: { degradationPct, timeoutMs, force }
// Returns: { status, testedNumCtx, steps, duration }

async function getProbeStatus(modelName)
// Returns current contextTest from registry

function getAvailableContext(registryDoc)
// Returns: { numCtx, source, confidence }
// Helper for other services to get the best-known context limit
```

### 2.3 Integrate with Sync Orchestrator

**File:** `src/services/modelSync/syncOrchestrator.js`

After model sync completes:
- If `CONTEXT_PROBE_ON_SYNC=true` AND model was just created (not updated):
  - Queue a probe (non-blocking, don't hold up sync)
  - Log: "Queuing context probe for newly discovered model X"

Implementation: call `probeModelContext()` in a fire-and-forget `Promise`
with a `.catch()` that logs errors. Don't `await` it during sync.

---

## Phase 3: API Routes

### 3.1 New Endpoints

**File:** `routes/model-registry.js` (add to existing router)

```
POST /api/models/registry/:name/context-test
  - Trigger a context probe
  - Body: { degradationPct?: number, force?: boolean }
  - Returns: { status: 'started', message }
  - If test already running, returns 409

GET /api/models/registry/:name/context-test
  - Get latest test results
  - Returns: { status, data: contextTest }
```

### 3.2 Update existing execution-config endpoint

**File:** `routes/model-registry.js`

Update `GET /:name/execution-config` response to include:
- `contextTest` summary (testedNumCtx, testedAt, status)
- Updated `effective.num_ctx.source` to reflect 'tested' when applicable

---

## Phase 4: Generalized Context Query Helper

### 4.1 Expose `getAvailableContext()` for other services

**File:** `src/services/contextProbe/contextProbeService.js` (exported function)

```javascript
function getAvailableContext(registryDoc) {
  // Priority: user override → tested → auto-detected → system default
  if (registryDoc.executionOverrides?.num_ctx) {
    return { numCtx: registryDoc.executionOverrides.num_ctx, source: 'user', confidence: 'high' };
  }
  if (registryDoc.contextTest?.testedNumCtx && registryDoc.contextTest.status === 'completed') {
    return { numCtx: registryDoc.contextTest.testedNumCtx, source: 'tested', confidence: 'high' };
  }
  if (registryDoc.executionDefaults?.num_ctx) {
    return { numCtx: registryDoc.executionDefaults.num_ctx, source: 'auto', confidence: 'medium' };
  }
  return { numCtx: 8192, source: 'system', confidence: 'low' };
}
```

This function can be imported by:
- `chatService.js` — to set `num_ctx` in Ollama requests
- `testExecution.js` — benchmarks already do this via registry lookup
- Future agents — SpecialX runners, etc.

---

## File Changes Summary

| Action | File | Lines Changed |
|--------|------|---------------|
| **Edit** | `models/ModelRegistry.js` | +30 (contextTest schema) +15 (getEffectiveConfig update) |
| **New** | `src/services/contextProbe/contextProbePayload.js` | ~50 |
| **New** | `src/services/contextProbe/contextProbeService.js` | ~250 |
| **Edit** | `src/services/modelSync/syncOrchestrator.js` | +15 (auto-probe integration) |
| **Edit** | `routes/model-registry.js` | +60 (two new endpoints + execution-config update) |

**Total new code:** ~375 lines across 2 new files
**Total edits:** ~120 lines across 3 existing files

---

## Testing Approach

### Manual Verification (Primary)

1. Start server with a local Ollama host
2. `POST /api/models/registry/sync-hosts` → models appear
3. `POST /api/models/registry/<model>/context-test` → probe runs
4. `GET /api/models/registry/<model>/context-test` → see results
5. `GET /api/models/registry/<model>/execution-config` → verify tested num_ctx appears
6. Verify steps array shows binary search progression with tok/s measurements

### Edge Cases to Verify

- Model with no VRAM (SSH disabled) → probe works without VRAM snapshots
- Model with very small theoretical max (e.g., 2048) → only baseline step
- Ollama timeout during probe → graceful failure, partial results saved
- Concurrent probe requests → 409 conflict
- `CONTEXT_PROBE_ON_SYNC=true` → new model triggers auto-probe

---

## Dependencies

- Existing: `ollamaVramService`, `ModelRegistry`, `parameterDetection`, `node-fetch`
- New env vars (all optional with defaults):
  - `CONTEXT_PROBE_DEGRADATION_PCT` (default: 50)
  - `CONTEXT_PROBE_ON_SYNC` (default: false)
  - `CONTEXT_PROBE_TIMEOUT_MS` (default: 120000)
  - `CONTEXT_PROBE_MIN_CTX` (default: 2048)

---

## Not In Scope (Future)

- Scheduled re-probing (cron-style)
- Multi-model concurrent probing (one at a time per host)
- UI dashboard for probe results
- Integration with chatService to auto-use tested context (separate PR)
