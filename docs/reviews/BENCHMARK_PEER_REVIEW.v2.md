# Benchmark System Peer Review v2

**Reviewer:** Codex (independent assessment)  
**Date:** 2026-02-09  
**Scope:** Benchmark batch execution, results APIs, leaderboard/UI logic, integration test coverage  
**Primary inputs:** `AGENTS.md`, `docs/reviews/BENCHMARK_PEER_REVIEW.md`, benchmark source files

---

## Executive Summary

This review re-validates benchmark behavior directly from source and test code.  
I confirmed multiple high-impact issues in correctness and scalability, merged additional findings from a focused second pass (batch execution + quality scoring internals), and retained corrections for v1 claims that are not defects in current code.

**Severity summary (confirmed in code):**
- **High:** 7
- **Medium:** 8
- **Low:** 5

---

## Findings (Ordered by Severity)

### 1. [HIGH] Math deterministic route can return wrong result shape and lose quality score
**Evidence:** `src/services/qualityScorer.js:1276` returns `numResult` with `score`, but downstream writes expect `quality_score` (`src/services/qualityScorer.js:799`, `src/services/benchmark/judging.js:60`).  
**Impact:** Math-scored results can silently lose quality/composite correctness in routed paths.  
**Recommendation:** Normalize routed scorer contracts so every branch returns `quality_score` + `scoring_method` consistently.

### 2. [HIGH] Failed-results reset endpoint is broken in leaderboard UI
**Evidence:** `public/js/leaderboard.js:277` calls `DELETE /api/benchmark/results?status=failed`, but backend only exposes `DELETE /api/benchmark/results/failed` at `routes/benchmark/results.js:351`.  
**Impact:** "Reset Failed" action in leaderboard fails at runtime.  
**Recommendation:** Use `/api/benchmark/results/failed` in leaderboard client.

### 3. [HIGH] Batch list `total` is incorrect when `limit` is used
**Evidence:** `src/services/benchmark/batches.js:15-17` returns `total: batches.length` after `getRecent(limit)`.  
**Impact:** Pagination metadata is capped by page size, not real DB total.  
**Recommendation:** Return `countDocuments()` total or rename field to `returned`.

### 4. [HIGH] Batch details load full result payloads unbounded
**Evidence:** `src/services/benchmark/batches.js:30` loads full `getByBatch`; payload includes full `prompt`, `response`, `judge_raw_response` at `src/services/benchmark/batches.js:135-147`.  
**Impact:** Large batches can create very large response bodies and memory pressure.  
**Recommendation:** Default to projected summary fields; fetch heavy fields on-demand in detail endpoint.

### 5. [HIGH] Dashboard failure stats ignore active filters (prompt/tag)
**Evidence:** `src/services/benchmark/results.js:194-201` applies only `success:false` (+ optional model filter), while filtered context is built in `matchQuery` at `src/services/benchmark/results.js:88-121`.  
**Impact:** Reliability/failure numbers can be polluted by data outside selected filter scope.  
**Recommendation:** Apply equivalent filter scope to failure aggregation (prompt category, tag/batch scope).

### 6. [HIGH] Summary/model stats perform full-document in-memory aggregation
**Evidence:** `src/services/benchmark/results.js:29-38` and `models/BenchmarkResult.js:309-333` use `.find()` then JS reduction instead of DB aggregation.  
**Impact:** Poor scalability and avoidable memory/CPU overhead on large result sets.  
**Recommendation:** Move aggregation logic into Mongo pipelines (`$group`, `$avg`, `$sum`).

### 7. [HIGH] Stop-check query runs once per test iteration
**Evidence:** `src/services/benchmark/execution.js:605-609` performs `findById(...status)` inside inner prompt loop.  
**Impact:** O(total tests) extra DB round trips during execution.  
**Recommendation:** Poll status every N tests or by elapsed time window.

### 8. [MEDIUM] Filtered dashboard overview uses unfiltered total
**Evidence:** `src/services/benchmark/results.js:124` uses global `countDocuments({})`; success is filtered (`line 125`), then failed is derived as `total - success` at `lines 463-467`.  
**Impact:** Success rate/failed counts are misleading under filters.  
**Recommendation:** Use a filtered total for filtered views.

### 9. [MEDIUM] Batch per-model judge failure display under-reports failures
**Evidence:** `public/js/benchmark/batch-execution.js:488-492` treats judge failure as `exec_failed`/execution failure, but not `llm_failed`.  
**Impact:** Per-model judge health can look better than reality during/after judging failures.  
**Recommendation:** Include `scoring_method === 'llm_failed'` in judge-failure counters.

### 10. [MEDIUM] Quality breakdown metadata is stale (still 5 levels/5 categories)
**Evidence:** `src/services/benchmark/results.js:537-538` returns categories `[coding..creative]` and levels `[1..5]`, while schemas support 11 categories and levels 1-10 (`models/BenchmarkPrompt.js:25-36`, `models/BenchmarkResult.js:51-60`).  
**Impact:** API metadata can mislead clients and downstream analytics.  
**Recommendation:** Derive categories/levels dynamically or update static metadata to current system.

### 11. [MEDIUM] `calculateResultStats` drops zero-valued metrics
**Evidence:** `public/js/benchmark/results-table.js:195` (`if (r.latency)`) and `:200` (`if (r.tokens_per_sec)`).  
**Impact:** Zero values are excluded from averages; skewed stats in edge cases.  
**Recommendation:** Check `!= null` and finite numeric conversion.

### 12. [MEDIUM] Performance modal shows stored composite, not active profile composite
**Evidence:** `public/js/leaderboard.js:749` shows `model.avg_composite`, while table uses dynamic `calculateCompositeScore(...)` at `public/js/leaderboard.js:427-430`.  
**Impact:** Table and modal can disagree for same model.  
**Recommendation:** Recompute modal composite using current selected profile.

### 13. [MEDIUM] `tokens_per_sec` stored as mixed string/number
**Evidence:** schema is `Mixed` at `models/BenchmarkResult.js:83-86`; generation code writes `.toFixed(2)` string at `src/services/benchmark/execution.js:688` and `:181`.  
**Impact:** Repeated parsing/coercion across backend/frontend; fragile typing.  
**Recommendation:** Store numeric type in DB; format only at render time.

### 14. [MEDIUM] Single-active-batch check has race window
**Evidence:** pre-check in route `routes/benchmark/core.js:106-130`, then create/save in `src/services/benchmark/execution.js:292-316` without unique guard.  
**Impact:** Near-simultaneous requests can create more than one running batch document.  
**Recommendation:** Enforce via atomic DB guard (e.g., lock doc / unique active token).

### 15. [LOW] Heartbeat reads full batch doc every interval
**Evidence:** `src/services/benchmark/execution.js:525-528` loads full batch just to heartbeat.  
**Impact:** Unnecessary DB payload and object hydration.  
**Recommendation:** Use direct `updateOne` on `last_activity_at` with status criteria.

### 16. [LOW] Duplicate representative-result selection logic
**Evidence:** `public/js/benchmark/results-analysis.js:10-69` and `:74-135` are near-duplicate branches.  
**Impact:** Maintenance drift risk.  
**Recommendation:** Consolidate into one function with optional model filter.

### 17. [LOW] CSV export zips unrelated performance and quality ranks into same row
**Evidence:** `public/js/leaderboard.js:1197-1214` combines `perfSorted[i]` with `qualSorted[i]`.  
**Impact:** Spreadsheet implies row-level relationship that may not exist.  
**Recommendation:** Export separate sections or join by model key.

### 18. [LOW] Manual level count aggregation is rigid
**Evidence:** `src/services/benchmark/results.js:136-145` hardcodes level_1..level_10 fields.  
**Impact:** Harder evolution if level taxonomy changes.  
**Recommendation:** Consider dynamic grouping by `prompt_level`.

### 19. [LOW] Latency sort path bypasses shared sort multiplier pattern
**Evidence:** `public/js/leaderboard.js:450-454` returns early, unlike other sort branches that flow through `sortMultiplier`.  
**Impact:** Maintainability inconsistency and future regression risk.  
**Recommendation:** Normalize latency branch with shared sorter behavior.

### 20. [LOW] Leaderboard consistency-bonus explanation drifts from backend threshold
**Evidence:** UI help text says bonus applies at `σ < 10` (`public/js/leaderboard.js:887`), backend threshold is `15` (`src/services/benchmark/generalistScore.js:81`).  
**Impact:** Users receive incorrect methodology explanation.  
**Recommendation:** Align displayed threshold text with backend constant (or expose threshold from API).

---

## Integration Test Coverage Gaps (Confirmed)

No integration coverage currently exists for several critical benchmark routes:
- `POST /api/benchmark/batch/:id/stop` (`routes/benchmark/core.js:162`)
- `POST /api/benchmark/batch/:id/recover` (`routes/benchmark/batches.js:175`)
- `POST /api/benchmark/batch/:id/judge` (`routes/benchmark/batches.js:240`)
- `GET /api/benchmark/batch/:id/judge/status` (`routes/benchmark/batches.js:269`)
- `POST /api/benchmark/batch/:id/rejudge-pending` (`routes/benchmark/batches.js:212`)
- `GET /api/benchmark/results/advanced` (`routes/benchmark/results.js:37`)
- `POST /api/benchmark/results/:id/human-review` (`routes/benchmark/results.js:222`)
- `GET /api/benchmark/generalist-leaderboard` (served by benchmark module; no integration assertion in `tests/integration/benchmark.test.js`)

---

## Corrections to v1 (Not Defects in Current Code)

### A. "Double-count in `updateStats`" is not currently a bug
`public/js/leaderboard.js:955` adds `tests + failed_tests`. Backend sets `tests` as success count and `failed_tests` separately (`src/services/benchmark/results.js:341-345`), so this is currently correct.

### B. BenchmarkPrompt category validation exists
`models/BenchmarkPrompt.js:25-36` enforces enum categories aligned with benchmark category taxonomy.

### C. Execution failure-rate math is functionally correct
`public/js/benchmark/results-analysis.js:144-151` computes `failed / completed`. Given current batch semantics (`completed` includes both pass+fail), the formula is correct; naming is still potentially confusing.

---

## Priority Fix Plan

1. Fix scoring contract mismatch in math deterministic route (`score` vs `quality_score`) to prevent silent scoring corruption.  
2. Fix endpoint mismatch + batch total + modal/per-model metric consistency (quick correctness wins).  
3. Tighten dashboard filter correctness (failure stats + filtered totals).  
4. Address scalability hotspots (`getBatch` projection, aggregation-based summaries, reduced stop-check frequency).  
5. Add integration tests for stop/recover/judge/rejudge/advanced/human-review/generalist routes.  
6. Clean up maintainability and docs consistency (duplicate logic, rigid level aggregation, threshold text drift, typing consistency).
