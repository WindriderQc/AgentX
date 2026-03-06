# Benchmark Data Quality Plan

**Status**: Active
**Created**: 2026-03-06
**Scope**: Fix scoring bugs, improve statistical reliability, add multi-judge support

---

## Context

4,030 test results across 31 model+host combos. Single judge (qwen2.5:7b-instruct-q5_K_M).
16 categories, 130 tests per model (3-10 prompts per category). Scores 0-10, displayed 0-100.

**Core problems**: 6 dead models polluting leaderboard, single-judge ceiling effects,
small sample sizes, score compression at top tier.

---

## Phase 1: Fix Scoring Bugs (Critical) -- DONE

### 1.1 Empty-Response Model Filtering

**Bug**: Models with 100% empty responses appear on leaderboard with generalistScore=5.

**Root cause chain**:
- `execution.js:447-449` marks empty responses with `quality_score: 0`, `scoring_method: 'empty_response'`
- `generalistScore.js:154` treats them as `hasScore: true` because `count > 0`
- All-zero scores have stddev=0, which is < `CONSISTENCY_STDDEV_THRESHOLD` (15)
- Result: `generalistScore = 0 - 0 + 5 = 5`

**Fix** (in `generalistScore.js`):

A. Add empty-response ratio check in `getCategoryScoresByModel()`:
   - Include `scoring_method: 'empty_response'` count per category in aggregation pipeline
   - Expose `emptyResponseRate` per model in the aggregated output

B. Add model-level validity gate in `calculateAllGeneralistScores()`:
   - Compute overall `emptyResponseRate` across all categories
   - If `emptyResponseRate > 0.5` (50%+), return `{ generalistScore: 0, filtered: true, reason: 'excessive_empty_responses' }`
   - Leaderboard API and UI should hide or visually flag `filtered: true` models

C. Fix consistency bonus for degenerate cases in `calculateGeneralistScoreFromCategories()`:
   - If `normalizedQuality < 10` (i.e., avg quality < 1/10), set `consistencyBonus = 0`
   - Being consistently terrible should not earn a bonus

**Files to modify**:
- `src/services/benchmark/generalistScore.js` (lines 142-213, 221-339)
- `routes/benchmark/analytics.js` (leaderboard endpoint — pass through `filtered` flag)
- `public/js/leaderboard.js` (hide or gray out filtered models)

**Estimated scope**: ~50 lines changed across 3 files.

### 1.2 Composite Scorer Quality Floor

**Current**: `compositeScorer.js` caps composite at 5.0 when `quality_score = 0`.

**Problem**: A cap of 5 is too generous. A model that produces nothing useful shouldn't score 5/100.

**Fix**: Change the quality floor cap from 5.0 to 0.0 when quality_score = 0.
If we want to distinguish "model responded but badly" from "model returned nothing",
add a second tier:
- `quality_score = 0` AND `scoring_method = 'empty_response'` -> composite cap = 0
- `quality_score = 0` AND `scoring_method != 'empty_response'` -> composite cap = 2 (responded but garbage)

**File**: `src/services/scoring/compositeScorer.js` (~5 lines)

---

## Phase 2: Empty-Response Root Cause (High Priority) -- DONE

### 2.1 Diagnose Empty Responses

**Affected models (100% empty)**:
- qwen2.5-coder:7b
- gemma3:12b-it-qat
- llama3.1:8b
- deepseek-coder-v2-lite (both variants)
- sammcj/qwen2.5-coder:7b

**Affected models (partial empty)**:
- qwen3.5:27b — 28/130 empty (22%)

**Investigation steps**:

A. Query BenchmarkResult for empty-response records to check:
   - `done_reason` — did Ollama signal completion or error?
   - `latency` — did it hit the 10-minute timeout?
   - `eval_count` / `tokens` — zero tokens generated vs tokens generated but empty after extraction?
   - `execution_settings.num_predict` — was num_predict too low?
   - `host` — are all failures on the same host?

B. Likely causes (ordered by probability):
   1. **Model format incompatibility** — Some models need chat template, others need raw. If the prompt format doesn't match, model may emit EOS immediately.
   2. **Timeout** — 27B models on 24GB card may timeout (qwen3.5:27b partial failures support this)
   3. **Context overflow** — 8192 default num_ctx may be too small for some models
   4. **Model not loaded** — Ollama may fail to load model silently

C. Create diagnostic script: `scripts/diagnose-empty-responses.js`
   - Query all `scoring_method: 'empty_response'` results
   - Group by model, host, done_reason, latency range
   - Output summary table

### 2.2 Fix Empty Responses

Based on diagnosis, likely fixes:

A. **Prompt format**: Ensure execution uses `/api/chat` (chat completion) not `/api/generate` (raw completion) for chat-tuned models. Check `testExecution.js` for API endpoint selection.

B. **Timeout handling**: For 27B+ models, increase `per_test_timeout_ms` or add per-model timeout overrides via ModelRegistry execution defaults.

C. **Retry on empty**: Add a single retry when `hasEmptyResponse && done_reason !== 'timeout'`. Sometimes models need a second attempt (cold start, VRAM pressure).

D. **Mark as infra failure**: If empty response is caused by timeout/connection, classify as `infra_error: true` so coverage penalty exemption applies.

**Files**:
- `src/services/benchmark/execution.js` (retry logic, format detection)
- `src/services/benchmark/testExecution.js` (API endpoint selection)
- `src/services/benchmark/config.js` (per-model timeout overrides)
- New: `scripts/diagnose-empty-responses.js`

---

## Phase 3: Prompt Expansion (Medium Priority)

### 3.1 Minimum 8 Prompts Per Category (L1-5)

**Current state** (from audit-prompt-coverage.js):
- 193 total prompts (base: 23, enhanced: 120, deep: 50)
- For a typical L1-5 run (120 prompts total):
  - math (8% weight): **3 prompts** -- one bad answer swings score by 33 points
  - creative (8%): **3 prompts**
  - factual (8%): **4 prompts**
  - reasoning (13%): 6 prompts
  - coding (12%): 7 prompts
  - Enhanced categories: 12 each (adequate)

**Target**: Minimum 8 prompts per category for L1-5 levels.

**Statistical justification**:
- 3 samples: 95% CI width ~60 points (useless)
- 5 samples: 95% CI width ~40 points (marginal)
- 8 samples: 95% CI width ~25 points (acceptable)
- 10 samples: 95% CI width ~20 points (good)

**Approach**:

A. Audit current prompt counts:
   ```js
   db.benchmarkprompts.aggregate([
     { $group: { _id: { category: "$category", level: "$level" }, count: { $sum: 1 } } },
     { $sort: { "_id.category": 1, "_id.level": 1 } }
   ])
   ```

B. Identify gaps: categories × levels with < 5 prompts

C. Generate new prompts for gaps:
   - Use a strong model (14B+) to generate diverse prompts matching existing patterns
   - Each prompt needs: name, prompt, expected_answer, scoring_type, judge_criteria, scoring_dimensions
   - Human review before seeding

D. Seed via existing `scripts/` seed infrastructure or extend `data/benchmark-prompts-*.json`

E. Add prompt count validation to `src/services/benchmark/init.js`:
   - On startup, warn if any category has < 5 prompts
   - Block batch start if any category has < 3 prompts (hard minimum)

**Files**:
- `data/benchmark-prompts.json` / `data/benchmark-prompts-enhanced.json` / `data/benchmark-prompts-deep.json`
- New: `scripts/audit-prompt-coverage.js`
- `src/services/benchmark/init.js` (validation)

### 3.2 Prompt Quality Review

While expanding, also review existing prompts for:
- Ambiguous questions with multiple valid answers (hurts deterministic scoring)
- Expected answers that are too specific (penalizes correct-but-different responses)
- Missing `judge_criteria` (forces generic LLM judging)
- Missing `deterministic_scoring` where applicable (math, coding, factual)

---

## Phase 4: Multi-Judge System (Medium Priority) -- DONE

### 4.1 Add Second Judge Model

**Current**: Single judge `qwen2.5:7b-instruct-q5_K_M` scores all 4,030 results.

**Problems**:
- 7B model can't reliably evaluate responses from 14B+ models on complex tasks
- 33% of scores are 10/10 (ceiling effect)
- Single judge creates systematic bias (models similar to judge score higher)

**Design**:

A. **Judge Tier Auto-Selection** (extend existing `judgeTierResolver.js`):
   - `basic` tier (7B judge): categories like general, dialogue, creative
   - `standard` tier (14B judge): coding, reasoning, math, factual
   - `advanced` tier (27B+ or cloud): multi-turn-reasoning, edge-cases, refactoring, debugging
   - Category → minimum tier mapping in `config/categories.js`

B. **Multi-Judge Consensus** (new: `src/services/benchmark/multiJudge.js`):
   - For `standard`+ tiers: score with 2 judges
   - If scores diverge by > 2 points (on 0-10 scale): escalate to `advanced` tier as tiebreaker
   - Final score = median of all judge scores
   - Store all judge scores in `quality_breakdown.judge_scores[]`

C. **Judge Agreement Metrics**:
   - Track inter-judge agreement rate per category
   - Flag categories where judges consistently disagree (indicates ambiguous prompts or scoring criteria)
   - Expose in analytics dashboard

**Phased rollout**:
1. First: Add a 14B judge model (e.g., qwen3:14b) alongside existing 7B
2. Score a sample of 100 results with both judges, measure agreement
3. If agreement > 80%: 7B is fine for those categories, save compute
4. If agreement < 60%: those categories REQUIRE the 14B judge
5. Build the category → judge tier mapping from empirical data

**Files**:
- New: `src/services/benchmark/multiJudge.js` (~150 lines)
- `src/services/scoring/judgeTierResolver.js` (extend tier logic)
- `config/categories.js` (add `minJudgeTier` per category)
- `src/services/benchmark/judging.js` (route to multi-judge when configured)
- `models/BenchmarkResult.js` (add `judge_scores[]` array field)

### 4.2 Judge Calibration Suite

**Purpose**: Validate that judge models are actually good at judging.

**Design**:
- Create 20 "gold standard" prompt-response pairs with known correct scores
- 5 clearly bad responses (expected: 0-3)
- 5 mediocre responses (expected: 4-6)
- 5 good responses (expected: 7-8)
- 5 excellent responses (expected: 9-10)
- Run each judge candidate against the calibration set
- Judge is valid if Pearson correlation with gold scores > 0.8
- Expose via existing `POST /api/benchmark/judge/calibrate` endpoint

**Files**:
- New: `data/judge-calibration-set.json` (20 gold pairs)
- Extend: `routes/benchmark/core.js` calibrate endpoint

---

## Phase 5: Score Differentiation (Low-Medium Priority)

### 5.1 Ceiling Detection & Harder Prompts

**Problem**: 42% of non-zero scores are 10/10. Top 15 models span only 91.5-98.1.

**Fix**: Adaptive difficulty.

A. **Detect ceiling models**: After a benchmark run, identify models scoring > 95 generalist.

B. **Level-up testing**: For ceiling models, run an additional "hard mode" batch:
   - Only level 4-5 prompts (expert difficulty)
   - Categories weighted toward reasoning, coding, math (harder to game)
   - Separate "elite score" displayed alongside generalist score

C. **Harder prompts for existing categories**:
   - Add level 6-8 prompts for core categories
   - Multi-step reasoning chains
   - Code problems requiring debugging + optimization
   - Math with multi-step proofs
   - Adversarial/tricky prompts that test understanding vs pattern matching

### 5.2 Granular Scoring Dimensions

**Current**: Single `quality_score` 0-10 → coarse.

**Enhancement**: Already have infrastructure for decomposed scoring (`decomposedJudge.js`).
Enable it more broadly:
- Every result gets scored on: accuracy, completeness, clarity, relevance (4 dimensions)
- `quality_score` = weighted average of dimensions
- Leaderboard can show per-dimension breakdowns
- Helps identify WHY models differ (e.g., Model A: accurate but unclear; Model B: clear but incomplete)

---

## Phase 6: Infrastructure & Automation (Ongoing)

### 6.1 Benchmark CI Integration

- Schedule weekly benchmark runs via cron/n8n
- Compare against previous run: flag regressions > 5 points
- Auto-generate changelog: "Model X improved +3 in reasoning, -2 in creative"
- Store historical trends in `BenchmarkBatch.timeline`

### 6.2 Benchmark Run Validation

Pre-flight checks before starting a batch:
- All target models are loaded and responsive on their hosts
- Judge model passes calibration (correlation > 0.8)
- Prompt coverage meets minimums (5+ per category)
- Available VRAM sufficient for largest model in batch
- Previous batch completed (no orphaned runs)

### 6.3 Leaderboard Enhancements

A. **Confidence intervals**: Show score +/- margin based on sample size
B. **Statistical significance**: Mark pairwise comparisons that ARE statistically significant
C. **Trend arrows**: Per-model score trend (improving/declining/stable)
D. **Filter by reliability**: Only show models with > X% non-empty responses
E. **Category heatmap**: Visual matrix of model x category scores

### 6.4 Data Retention & Cleanup

- Archive results from batches older than 90 days to cold storage
- Keep only latest 3 batches per model for active leaderboard
- Purge results from filtered/dead models after confirmation

---

## Execution Order

```
Phase 1 (Week 1) -------- Fix scoring bugs
  1.1 Empty-response model filtering       [~2 hours]
  1.2 Composite scorer quality floor        [~30 min]

Phase 2 (Week 1-2) ------ Root cause analysis
  2.1 Diagnose empty responses              [~1 hour]
  2.2 Fix empty responses                   [~2-4 hours, depends on cause]

Phase 3 (Week 2-3) ------ Prompt expansion
  3.1 Audit + expand to 5+ per category     [~4-6 hours]
  3.2 Prompt quality review                 [~2 hours]

  >>> RE-RUN FULL BENCHMARK <<<             [runtime: ~2-4 hours]

Phase 4 (Week 3-4) ------ Multi-judge
  4.1 Add second judge (14B)                [~4 hours]
  4.2 Judge calibration suite               [~3 hours]
  4.2b Empirical agreement measurement      [~2 hours runtime]

Phase 5 (Week 4+) ------- Score differentiation
  5.1 Ceiling detection + hard prompts      [~4 hours]
  5.2 Granular scoring dimensions           [~3 hours]

Phase 6 (Ongoing) ------- Infrastructure
  6.1 CI integration                        [~3 hours]
  6.2 Pre-flight validation                 [~2 hours]
  6.3 Leaderboard enhancements              [~6 hours]
  6.4 Data retention                        [~2 hours]
```

---

## Success Metrics

After completing Phases 1-4:

| Metric | Current | Target |
|--------|---------|--------|
| Dead models on leaderboard | 6 | 0 |
| Min prompts per category | 3 | 5+ |
| Judge models | 1 (7B) | 2+ (7B + 14B) |
| Perfect score rate (10/10) | 33% | < 20% |
| Top-15 score spread | 6.6 pts (91.5-98.1) | > 15 pts |
| Inter-judge agreement | N/A | > 75% |
| Score confidence interval (top tier) | unmeasured | +/- 5 pts |

---

## Files Index

**Modified (existing)**:
- `src/services/benchmark/generalistScore.js` — empty-response filtering, consistency bonus fix
- `src/services/scoring/compositeScorer.js` — quality floor tiers
- `src/services/benchmark/execution.js` — empty-response retry, format detection
- `src/services/benchmark/testExecution.js` — API endpoint selection
- `src/services/benchmark/judging.js` — multi-judge routing
- `src/services/scoring/judgeTierResolver.js` — category-based tier selection
- `config/categories.js` — minJudgeTier per category
- `models/BenchmarkResult.js` — judge_scores array
- `routes/benchmark/analytics.js` — filtered flag passthrough
- `public/js/leaderboard.js` — filtered model display

**New files**:
- `src/services/benchmark/multiJudge.js` — multi-judge consensus logic
- `scripts/diagnose-empty-responses.js` — empty-response diagnostic
- `scripts/audit-prompt-coverage.js` — prompt count auditor
- `data/judge-calibration-set.json` — gold standard judge test set
