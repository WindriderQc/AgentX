# Model Categorization Peer Review

**Date:** 2026-02-09
**Scope:** Complete model categorization system - schemas, services, API routes, UI components, leaderboard, CSS, and config data
**Files Reviewed:** 25+
**Revision:** Applied fixes for issues #1-8, #12, #14

---

## Executive Summary

The categorization system has strong architectural foundations (generalist scoring, two-board leaderboard, reusable badge component). The initial review identified **category enum fragmentation** across the stack with five different category lists and no shared source of truth.

**Fixes applied this revision:**
- Generalist weights now sum to 1.0 (added missing `general: 0.05`)
- CategoryBadge extended to 17 categories (6 original + 6 enhanced + 5 manual)
- CSS covers all 17 categories
- Duplicate DOM construction in renderTable eliminated
- filterModels element ID mismatch fixed (`#modelTableBody` -> `#modelsTableBody`)
- Orphaned code in enhancements file removed
- Leaderboard getCategoryConfig replaced with exact-match lookup (was fuzzy `.includes()`)
- Missing icons added to model-categorization getCategoryIcon
- Methodology modal documentation corrected (stddev threshold, general weight)

**Overall Consistency Score: 7/10** (was 4/10)

---

## Files Reviewed

| File | Purpose |
|------|---------|
| `models/ModelRegistry.js` | Schema: model metadata + categories (7-value enum) |
| `models/BenchmarkResult.js` | Schema: benchmark results (12-value prompt_category) |
| `models/BenchmarkPrompt.js` | Schema: benchmark prompts (12-value category) |
| `models/CustomModel.js` | Schema: custom models (freeform categories) |
| `routes/model-registry.js` | API: CRUD + category management |
| `routes/benchmark/analytics.js` | API: dashboard + generalist-leaderboard |
| `src/services/benchmark/results.js` | Service: dashboard enrichment with recommended_category |
| `src/services/benchmark/generalistScore.js` | Service: weighted quality scoring (12 categories) |
| `src/services/qualityScorer.js` | Service: LLM-as-judge scoring configs (12 categories) |
| `public/js/model-categorization.js` | UI: category management page (7 categories) |
| `public/js/model-categorization-enhancements.js` | UI: search, filter, export, shortcuts |
| `public/js/leaderboard.js` | UI: performance + quality boards |
| `public/js/components/CategoryBadge.js` | Component: badge with confidence ring (17 categories) |
| `public/model-categorization.html` | HTML: categorization page |
| `public/leaderboard.html` | HTML: leaderboard page (5 category tabs) |
| `public/css/components/category-badge.css` | Styles: 17 category colors |
| `public/css/model-categorization.css` | Styles: categorization page |
| `public/css/leaderboard.css` | Styles: leaderboard page |
| `data/categorization-prompts.json` | Config: 42 diagnostic prompts (6 categories) |

---

## RESOLVED Issues

### ~~1. Category Enum Fragmentation (Systemic)~~ PARTIALLY RESOLVED

CategoryBadge, CSS, leaderboard getCategoryConfig, and generalistScore now cover all categories from both systems. Two intentionally separate category namespaces remain:

- **Manual Assignment** (7): ops, coding, reasoning, specialist, generalist, embedding, judge
- **AI Benchmark** (12): coding, reasoning, factual, math, creative, general + 6 enhanced

These are architecturally distinct (one is human-assigned, the other is benchmark-derived) so full unification into a single enum is not necessary. However, a shared `src/config/categories.js` would still reduce drift risk.

**Remaining work:** Create `src/config/categories.js` as canonical source (optional, lower priority).

### ~~2. Duplicate DOM Construction in renderTable~~ RESOLVED

`model-categorization.js` renderTable now uses a single approach (DOM API) per column:
- Checkbox column: DOM API only (removed innerHTML duplicate)
- Manual categories column: DOM API only (removed innerHTML duplicate)
- Actions column: DOM API only (removed innerHTML duplicate)

### ~~3. CategoryBadge.js Missing Categories~~ RESOLVED

`CATEGORY_CONFIG` now defines 17 categories:
- 6 original AI benchmark + 6 enhanced AI benchmark + 5 manual assignment

All categories have icon, color, and label. CSS matches.

### ~~4. Leaderboard Tab/Filter Design Mismatch~~ OPEN

`leaderboard.html` tabs still cover only 5 categories (ops, coding, reasoning, specialist, generalist). Models whose best benchmark category is `math`, `factual`, `creative`, or any enhanced category are invisible to tab filters. This is a design decision that needs user input on whether to:
- Add tabs for all benchmark categories
- Filter on manual `categories[]` instead
- Create a mapping from benchmark categories to tab groups

### ~~5. `general` Missing from Generalist Weights~~ RESOLVED

Added `'general': 0.05` to `GENERALIST_CATEGORY_WEIGHTS`. Total now sums to 1.0. Methodology modal documentation updated to match code (stddev threshold corrected from <10 to <15).

### ~~6. Enhancements File Syntax Issue~~ RESOLVED

Removed orphaned duplicate code (console.logs and closing brackets) at end of `model-categorization-enhancements.js`. File now ends cleanly after `setupResponsiveHelpers()`.

### ~~7. Quick Test is Simulated~~ OPEN

`model-categorization.js` openQuickTest still runs a client-side progress animation with no actual benchmark execution. Reads pre-existing `bestCategory` and presents it as result. Should connect to real benchmark runner or be relabeled as "View Existing Results".

---

## REMAINING Issues

### 8. Model Router Task Map is Minimal (MODERATE)

`ModelRegistry.js:560-565` has only 4 hardcoded task-to-category mappings. Doesn't leverage benchmark scores or the full category space.

### 9. getGroupedByCategory Hardcodes 7 Categories (MODERATE)

`ModelRegistry.js:308-315` initializes grouped object with exactly 7 keys. Models with categories outside this set are silently dropped. Should build dynamically from schema enum.

### ~~10. Inconsistent Color Schemes~~ RESOLVED

Leaderboard `getCategoryConfig()` now uses a proper lookup map with colors aligned to CategoryBadge and CSS. Coding = `#7c9fff` consistently across all three systems.

### 11. No Input Validation on Category PATCH (MODERATE)

`bestCategory` stored as unvalidated string can hold any of 12 benchmark categories. Users can't manually assign categories their models are benchmarked against. Mongoose `runValidators: true` catches manual enum violations but not benchmark-derived values.

### ~~12. filterModels Targets Wrong Element ID~~ RESOLVED

Changed `#modelTableBody` to `#modelsTableBody` in `model-categorization-enhancements.js`.

### 13. Chart Colors Limited to 7 (MINOR)

`model-categorization.js:539-541` provides exactly 7 hardcoded colors for doughnut chart. Extra categories get Chart.js defaults. Low priority since chart is driven by model stats data.

### ~~14. Missing Category Icons~~ RESOLVED

Added `factual`, `math`, `creative`, `general` to `getCategoryIcon()` in `model-categorization.js`.

### 15. Categorization Prompts Incomplete (MINOR)

`data/categorization-prompts.json` has 42 prompts across only 6 categories. Missing prompts for the 6 enhanced categories (instruction-following, summarization, etc.). This is content work.

---

## Architecture Strengths

1. **generalistScore.js** - Clean single-source-of-truth scoring with documented formula, coverage penalties, consistency bonuses, and infrastructure failure exemption.

2. **Two-board leaderboard** - Performance Board (speed+quality composite) vs Quality Board (weighted generalist) is a thoughtful distinction.

3. **CategoryBadge component pattern** - Good reusable architecture with confidence rings, tooltips, size variants, and proper CSS separation. Now covers all 17 categories.

4. **BenchmarkResult schema instrumentation** - Hardware snapshots, judge confidence, truncation detection, warmup tracking is production-grade.

5. **Dashboard enrichment pattern** - Clean separation between raw benchmark data and enriched display data via ModelRegistry join.

---

## Recommended Next Steps

1. **Design leaderboard tab strategy** - Decide how to handle benchmark categories in tab filters (issue #4)
2. **Create shared category constants** (`src/config/categories.js`) - Optional but reduces future drift risk
3. **Connect or relabel quick test** - UX honesty (issue #7)
4. **Expand categorization prompts** - Add prompts for 6 enhanced categories (issue #15)
5. **Build getGroupedByCategory dynamically** - Use schema enum instead of hardcoded keys (issue #9)
