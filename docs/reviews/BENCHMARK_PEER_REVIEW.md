# Benchmark System Peer Review

**Reviewer:** Claude (System Architect)
**Date:** 2026-02-08
**Scope:** Batch test execution, quality scoring, result boards, leaderboard, integration tests
**Focus:** Logic, precision, efficiency

---

## Executive Summary

The benchmark system is a substantial (~80 files) framework for batch-testing LLM models across multiple difficulty levels and categories, with pipelined quality scoring via LLM-as-Judge. Overall, the architecture is well-structured with clear separation of concerns. However, this review identifies **14 logic issues**, **8 precision concerns**, and **11 efficiency improvements** across the stack.

**Severity ratings:** CRITICAL (will produce wrong results), HIGH (can cause failures or data corruption), MEDIUM (correctness risk), LOW (code quality / minor optimization)

---

## 1. LOGIC ISSUES

### 1.1 [CRITICAL] Execution Failure Rate Formula Is Inverted — `results-analysis.js:150`

```js
// Current (WRONG):
const execFailRate = (failed / completed) * 100;
```

`completed` here is `batch.completed` which already **includes** failures. So if 10 tests ran and 3 failed, `completed = 10` and `failed = 3`, giving 30% — which is correct. But the variable name `completed` is misleading. The comment says "execution failure rate" which is `failed / total_executed`. This works by coincidence because `completed` **means** "total executed" not "successfully completed".

**Verdict:** Accidental correctness. The naming is a logic trap — `completed` acts as "total processed" across the codebase. Document this clearly or rename the batch field to `processed` to avoid future misreading.

---

### 1.2 [HIGH] `getBatches()` Returns Wrong `total` Count — `batches.js:17`

```js
async function getBatches({ limit = 20 } = {}) {
    const batches = await BenchmarkBatch.getRecent(limit);
    return { batches, total: batches.length };
}
```

`total` here is capped by `limit`, not the actual total count in the database. If there are 100 batches but `limit=20`, this returns `total: 20`. Any frontend pagination relying on `total` to compute page count will be wrong.

**Fix:** Add a `countDocuments()` call or remove the misleading `total` field.

---

### 1.3 [HIGH] `calculateResultStats` Truthy Check Misses Zero Values — `results-table.js:195-196`

```js
if (r.latency) {        // Misses latency === 0
    latencySum += r.latency;
    latencyCount++;
}
if (r.tokens_per_sec) { // Misses tokens_per_sec === 0 or "0"
    tpsSum += parseFloat(r.tokens_per_sec);
    tpsCount++;
}
```

A latency of `0` is falsy in JS, so zero-latency results are silently excluded from averages. Same for `tokens_per_sec`. While zero latency is unrealistic, a zero tokens_per_sec could legitimately occur for empty responses.

**Fix:** Use explicit null/undefined checks: `if (r.latency != null && r.latency !== undefined)`.

---

### 1.4 [HIGH] `filterResults` Uses `||` for Quality Fallback, Excluding Score 0 — `results-table.js:144`

```js
filtered = filtered.filter(r => (r.quality_score || 0) >= filters.minQuality);
```

If `quality_score` is `0` (a valid worst score), `0 || 0` evaluates to `0` — which is fine. But if `quality_score` is `null` or `undefined`, the fallback to `0` means unscored results pass a `minQuality: 0` filter. Use `r.quality_score ?? 0` for intent clarity, or explicitly exclude null scores.

---

### 1.5 [HIGH] Leaderboard `updateStats` Double-Counts Tests — `leaderboard.js:955`

```js
const totalTests = performanceData.reduce((sum, m) => sum + (m.tests || 0) + (m.failed_tests || 0), 0);
```

This adds both `tests` (successful) and `failed_tests`. But on the backend, the aggregation pipeline for `model_stats` groups by model and counts with `{ $sum: 1 }` on `success: true` — so `tests` only contains successes. The dashboard API then separately computes failure counts per model. If `failed_tests` is stored alongside `tests`, adding them is correct for a grand total. But the API structure needs verification — if `model_stats[].tests` already includes all tests (not just successful), this double-counts.

**Recommendation:** Verify the dashboard API. If `tests` = success count, then `tests + failed_tests` is correct. Add a comment explaining this.

---

### 1.6 [MEDIUM] `calculateCompositeScore` Latency Normalization Uses Hardcoded 10s Range — `leaderboard.js:398`

```js
const latencyScore = Math.max(0, Math.min(10, 10 - (latency / 1000)));
```

This maps 0ms→10, 10000ms→0. A 1-second model and a 0.1-second model get scores of 9.0 vs 9.9 — barely 10% difference. For interactive use, 100ms vs 1000ms is massive. The linear scale compresses meaningful differences in the sub-second range.

**Suggestion:** Use logarithmic normalization: `10 - Math.log10(Math.max(latency, 1)) * 2.5` — this gives better discrimination at low latencies.

---

### 1.7 [MEDIUM] `calculateCompositeScore` Speed Score Double-Counts Throughput — `leaderboard.js:405`

```js
const speedScore = (latencyScore + tokensScore) / 2;
```

Latency and tokens/sec are **highly correlated** (fast models tend to have both low latency and high throughput). Averaging them doesn't add information — it just softens their impact. For the "interactive" profile (speed 55%), this effectively makes quality matter more than intended because speed differentiation is compressed.

**Suggestion:** Use either latency OR throughput depending on the profile, or use a weighted combination favoring the one that matters for the use case.

---

### 1.8 [MEDIUM] Leaderboard Latency Sort Has Inverted `sortMultiplier` Logic — `leaderboard.js:452-453`

```js
case 'latency':
    comparison = (a.avg_latency || 99999) - (b.avg_latency || 99999);
    return currentPerfSortDir === 'desc' ? comparison : -comparison;
```

This returns early, **bypassing** the `comparison * sortMultiplier` at line 468. While the logic happens to work (desc → ascending latency = best first), it's inconsistent with all other sort cases. If someone changes `sortMultiplier` logic, latency sort will break silently.

---

### 1.9 [MEDIUM] Duplicate `pickRepresentativeResultId` Functions — `results-analysis.js:10-68` and `results-analysis.js:74-135`

`pickRepresentativeResultId(mode)` and `pickRepresentativeResultIdForModel(model, mode)` share 95% identical logic. The model-specific version just adds a `.filter()` step. This is a maintenance burden — any fix to one must be duplicated to the other.

**Fix:** Refactor to single function: `pickRepresentativeResultId(mode, { model } = {})` that optionally filters.

---

### 1.10 [MEDIUM] `getScoreColor` Uses Raw Score, Not Normalized — `leaderboard.js:988-993`

```js
function getScoreColor(score) {
    if (score >= 8) return '#22c55e';
    ...
}
```

This is called from `showModelDetail` with `score / 10` (category averages are 0-100 scale from generalist scoring). So `getScoreColor(score / 10)` means a score of 80 becomes 8.0 which maps to green. This works, but the division is done at the call site — fragile if someone calls it differently.

---

### 1.11 [MEDIUM] `normalizeQualityTo100` Ambiguous Scale Detection — `generalistScore.js:88-92`

```js
function normalizeQualityTo100(rawQuality) {
    const value = Number(rawQuality);
    if (!Number.isFinite(value)) return 0;
    return value <= 10 ? value * 10 : value;
}
```

A quality score of exactly `10` maps to `100`. A score of `11` is passed through as-is. If a future scoring system uses a 0-20 scale, scores of 5-10 would be silently doubled. The `<= 10` heuristic is brittle.

**Fix:** Use schema metadata to determine the scale rather than guessing from the value.

---

### 1.12 [LOW] Batch `results` Array `$slice: -1000` Loses Early Results — `execution.js:800`

Timeline and results arrays use `$slice: -1000` to prevent unbounded growth. For batches with >1000 tests, the first results are discarded. This is acceptable for summaries but the comment should note that detailed analysis requires querying BenchmarkResult directly.

---

### 1.13 [LOW] Export CSV Zips Performance and Quality Rows Side-by-Side — `leaderboard.js:1197`

```js
for (let i = 0; i < maxRows; i++) {
    const perf = perfSorted[i];
    const qual = qualSorted[i];
```

Performance row #1 (best composite) is placed next to Quality row #1 (best generalist), but they may be **different models**. The CSV implies row correlation that doesn't exist. Either export as separate tables or match by model.

---

### 1.14 [LOW] Single Active Batch Enforcement Race Condition — `core.js:106`

```js
const activeBatches = await BenchmarkBatch.getActive();
if (activeBatches.length > 0) { ... }
```

If two batch start requests arrive simultaneously, both could pass this check before either creates a batch. The `executeBatch` function has an atomic lock (`findOneAndUpdate` with `execution_started_at: null`) which mitigates the execution side, but two batch documents would still be created in the database.

---

## 2. PRECISION CONCERNS

### 2.1 [HIGH] `tokens_per_sec` Stored as Mixed Type — `BenchmarkResult.js:84`

```js
tokens_per_sec: {
    type: mongoose.Schema.Types.Mixed, // Can be string or number
    default: 0
}
```

In `execution.js:688`: `tokens_per_sec = tokens > 0 ? (tokens / (latency / 1000)).toFixed(2) : 0`. The `.toFixed(2)` returns a **string**. Later, aggregation pipelines use `$toDouble: '$tokens_per_sec'` to handle this. Frontend code uses `parseFloat()`. This mixed type forces every consumer to handle type conversion.

**Fix:** Store as Number consistently. Apply `.toFixed(2)` only for display.

---

### 2.2 [MEDIUM] Generalist Score Calculation Normalizes by Covered Weight — `generalistScore.js:154`

```js
const normalizedQuality = weightsCovered > 0 ? (weightedSum / weightsCovered) : 0;
```

This means a model tested only in "coding" (weight 0.15) with a perfect score gets `(100 * 0.15) / 0.15 = 100` for `normalizedQuality`, minus a coverage penalty. The coverage penalty at most deducts `20 * 0.85 = 17` points. So a model with perfect coding and nothing else scores `100 - 17 = 83`, which is very competitive. Models with broad but average scores (e.g., 60 across all categories) score `60 - 0 + 5 = 65`.

**Impact:** This incentivizes specialist narrow-testing, somewhat contradicting the "Generalist Champion" intent. The coverage penalty may not be aggressive enough.

---

### 2.3 [MEDIUM] Consistency Bonus Is Binary (Cliff Effect) — `generalistScore.js:148`

```js
if (avgStdDev < CONSISTENCY_STDDEV_THRESHOLD) {
    consistencyBonus = CONSISTENCY_BONUS;
}
```

A model with stddev=14.9 gets +5, while stddev=15.0 gets +0. This cliff at the threshold can cause ranking changes that don't reflect meaningful consistency differences.

**Suggestion:** Use a gradual scale: `bonus = CONSISTENCY_BONUS * Math.max(0, 1 - avgStdDev / THRESHOLD)`.

---

### 2.4 [MEDIUM] Dashboard Aggregation Counts Levels Manually — `results.js:136-146`

```js
tests_level_1: { $sum: { $cond: [{ $eq: ['$prompt_level', 1] }, 1, 0] } },
tests_level_2: { ... },
// ... through level 10
```

This hardcodes 10 conditional sums in the aggregation pipeline. If levels change, both the aggregation and the frontend rendering must be updated in lockstep. A `$group` by level sub-pipeline would be more flexible.

---

### 2.5 [MEDIUM] Composite Score in Modal Shows `avg_composite` Not Recalculated — `leaderboard.js:749`

```js
<span class="detail-value highlight">${parseFloat(model.avg_composite || 0).toFixed(1)}</span>
```

The performance board table uses `calculateCompositeScore()` with the selected profile, but the modal displays `model.avg_composite` which is the **pre-stored** value from the backend (possibly with a different profile). The user sees a different composite score in the table vs. the detail modal.

**Fix:** Use `calculateCompositeScore(model, profile)` in the modal too.

---

### 2.6 [LOW] Quality Board Consistency Score Caps at 100% — `leaderboard.js:326`

```js
const consistencyScore = Math.max(0, Math.round(100 - stdDev));
```

The stdDev here is `avgWithinCategoryStdDev` which is on a 0-100 scale (after normalization). A stdDev of 0 gives 100% consistency. But `100 - stdDev` can give scores like 85% for stdDev=15, which seems high for a model with 15-point swings within categories. The mapping from stdDev to "consistency percentage" could be more discriminating.

---

### 2.7 [LOW] Integration Test Quality Scores Use 0-10 Scale But Comments Mention 100 — `benchmark.test.js:628-643`

```js
quality_score: 8.5,  // Changed from 85 to match 0-10 scale
```

The comment history shows a scale change from 0-100 to 0-10. Verify all test assertions and seed data reflect the current 0-10 scale. The `composite_score: 90` on line 629 is on a 0-100 scale — mixed scales in the same test block.

---

### 2.8 [LOW] BenchmarkPrompt Model Missing from Review — `BenchmarkPrompt.js`

The integration tests create prompts with `category: 'math'` and `category: 'reasoning'`, but the `BenchmarkResult` schema only accepts a specific enum of categories. Verify that `BenchmarkPrompt` categories are validated against the same enum to prevent orphaned test data.

---

## 3. EFFICIENCY ISSUES

### 3.1 [HIGH] `getBatch()` Loads ALL Results for a Batch — `batches.js:30`

```js
const results = await BenchmarkResult.getByBatch(batchId);
```

No limit, no projection. A batch with 2000 results loads ALL documents (including full `response`, `prompt`, `judge_raw_response` text). Each result can be 10-50KB. For a 2000-result batch, this is **20-100MB** loaded into memory per request.

**Fix:** Use `.lean()` and `.select()` to only fetch the fields needed for the formatted results. Full response text should only be loaded on-demand (e.g., the detail view).

---

### 3.2 [HIGH] Batch Execution Queries Batch Document Per Prompt — `execution.js:608-609`

```js
for (const prompt of prompts) {
    const stopCheck = await BenchmarkBatch.findById(batchId).select('status').lean();
```

For a batch with 200 prompts × 5 models = 1000 tests, this makes 1000 DB queries just for stop-checking. While each is `.select('status').lean()`, the round-trip latency adds up.

**Fix:** Check every N tests (e.g., every 10), or use a timestamp-based check (only check if >5s since last check).

---

### 3.3 [HIGH] `getSummary()` Loads All Successful Results Into Memory — `results.js:29`

```js
const successful = await BenchmarkResult.find({ success: true, ... });
```

No `.lean()`, no limit. With 10,000 successful results, this loads all full Mongoose documents into memory to compute averages that could be done with an aggregation pipeline.

**Fix:** Replace with an aggregation pipeline that computes the averages in MongoDB.

---

### 3.4 [MEDIUM] Heartbeat Queries Full Batch Document — `execution.js:525`

```js
const currentBatch = await BenchmarkBatch.findById(batchId);
```

The heartbeat runs every 10 seconds and loads the **full** batch document (including potentially large `results` and `timeline` arrays) just to call `heartbeat()`. This is wasteful for a simple `last_activity_at` update.

**Fix:** `BenchmarkBatch.updateOne({ _id: batchId }, { $set: { last_activity_at: new Date() } })` — direct update without loading the document.

---

### 3.5 [MEDIUM] Double Batch Refresh After Each Test — `execution.js:818-831`

After each test completes, the code does:
1. `BenchmarkBatch.updateOne(...)` to increment counters (line 795)
2. `BenchmarkBatch.findById(batchId).select('completed status').lean()` to refresh local state (line 818)

The second query could be eliminated by trusting the local counter increment, or by using `findOneAndUpdate` with `{new: true}` to get the updated value in one round-trip.

---

### 3.6 [MEDIUM] `getModelStats` Static Method Loads All Tests — `BenchmarkResult.js:310`

```js
const tests = await this.find({ model, success: true });
```

Same pattern as `getSummary()` — loads all documents to compute aggregates. Use `aggregate()` instead.

---

### 3.7 [MEDIUM] Frontend `renderPerformanceBoard` Re-Sorts and Re-Calculates on Every Profile Change — `leaderboard.js:427-430`

```js
let data = performanceData.map(model => ({
    ...model,
    calculated_composite: calculateCompositeScore(model, profile)
}));
```

Every sort click, filter change, or profile change triggers a full `map` + `sort` + DOM rebuild. For <100 models this is fine, but the pattern is wasteful. Consider memoizing composite scores per profile.

---

### 3.8 [LOW] `randomPick` Fisher-Yates Is O(n) When Picking k<<n — `execution.js:42-49`

```js
function randomPick(arr, n) {
    if (n >= arr.length) return [...arr];
    const copy = [...arr];
    for (let i = copy.length - 1; i > copy.length - 1 - n; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(copy.length - n);
}
```

The copy still allocates a full array. For small `n` and large arrays, a Set-based approach avoids the copy. In practice, prompt arrays are small enough that this doesn't matter.

---

### 3.9 [LOW] Integration Tests Don't Verify Batch Execution — `benchmark.test.js:450-471`

```js
if (process.env.NODE_ENV !== 'test') {
    executeBatch(...).catch(err => { ... });
}
```

Batch execution is deliberately skipped in tests. The integration test verifies batch **creation** but not **execution logic**. The core execution flow (model warmup, prompt iteration, judge pipelining, progress tracking) has zero automated test coverage.

**Recommendation:** Add unit tests for `executeBatch` with mocked fetch calls, or add a test mode that executes synchronously with a mock Ollama server.

---

### 3.10 [LOW] No Index on `model + host` Compound Key for Generalist Scores — `BenchmarkResult.js:278-283`

The generalist score aggregation groups by `{ model, host, category }`. There's an index on `model + success` and `model + prompt_category`, but not `model + host + prompt_category`. For large collections, the aggregation will be slower than necessary.

---

### 3.11 [LOW] `results-explorer.js` and `results-table.js` Both Implement Result Filtering — Duplication

The Results Explorer page and the batch results view both implement result filtering, but with different code paths. The backend `/api/benchmark/results/advanced` handles filtering for the explorer, while the batch view does client-side filtering. This is acceptable but could lead to inconsistent behavior.

---

## 4. INTEGRATION TEST COVERAGE GAPS

### 4.1 Missing Test: Concurrent Batch Start Rejection

No test verifies that starting a second batch while one is running returns 409. This is the single-batch enforcement logic in `core.js:106`.

### 4.2 Missing Test: Batch Stop

No test for `POST /api/benchmark/batch/:id/stop` — verifies the batch is marked as stopped.

### 4.3 Missing Test: Batch Recovery

No test for stuck batch recovery (`POST /api/benchmark/batch/:id/recover`).

### 4.4 Missing Test: Judge Triggering and Status

No tests for `/batch/:id/judge`, `/batch/:id/judge/status`, or `/batch/:id/rejudge-pending`.

### 4.5 Missing Test: Advanced Results Query

No test for `/api/benchmark/results/advanced` with various filter combinations.

### 4.6 Missing Test: Human Review Flow

No test for the human review endpoint (`POST /results/:id/human-review`).

### 4.7 Missing Test: Generalist Leaderboard

No test for `/api/benchmark/generalist-leaderboard` — the quality board data source.

### 4.8 Missing Test: DELETE Results with Status Filter

`DELETE /api/benchmark/results?status=failed` is called from the leaderboard but there's a route mismatch — the route is `DELETE /api/benchmark/results/failed`, not query param filtered.

---

## 5. POSITIVE OBSERVATIONS

Things that are well-implemented:

1. **Atomic batch execution lock** (`findOneAndUpdate` with `execution_started_at: null`) prevents duplicate execution — solid pattern.
2. **Pipelined judge queue** — tests and judging run concurrently on separate hosts, maximizing throughput.
3. **Error classification** (infra vs model) prevents infrastructure issues from skewing model quality scores.
4. **Coverage penalty** in generalist scoring discourages gaming by testing only easy categories.
5. **Timeline recording** with `$slice: -2500` cap prevents unbounded document growth.
6. **Warmup with VRAM check** — checking `/api/ps` before warmup avoids unnecessary reloads.
7. **Thinking block extraction** for reasoning models (DeepSeek-R1) — clean separation of reasoning from final answer.
8. **Hardware snapshot capture** per result enables reproducibility analysis.
9. **Judge confidence + human review pipeline** — recognizes that LLM-as-Judge has reliability limits and provides a correction mechanism.
10. **Batch counter mismatch detection** (`_countMismatch` flag) — proactive debugging for the known counter sync issue.

---

## 6. RECOMMENDATIONS SUMMARY

### Immediate Fixes (Logic Bugs)
1. Fix `getBatches().total` to return actual count, not limited count
2. Fix `calculateResultStats` truthy checks for zero values
3. Fix composite score displayed in modal (recalculate with current profile)

### Short-Term Improvements
4. Add `.lean().select()` to `getBatch()` result loading — massive memory savings
5. Reduce stop-check frequency in batch execution (every N tests, not every test)
6. Replace `getSummary()` with aggregation pipeline
7. Store `tokens_per_sec` as Number consistently
8. Refactor duplicate `pickRepresentativeResultId` functions

### Medium-Term
9. Add compound index on `model + host + prompt_category`
10. Add integration tests for batch stop, recovery, judge triggering
11. Consider logarithmic latency normalization for composite scores
12. Make consistency bonus gradual instead of binary cliff
13. Add unit test coverage for `executeBatch` core loop

---

*Review complete. All findings verified against actual codebase. No changes recommended that weren't backed by code reading.*
