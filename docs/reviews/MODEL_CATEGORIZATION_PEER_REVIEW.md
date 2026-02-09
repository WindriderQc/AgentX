# Model Categorization Peer Review

**Date:** 2026-02-09
**Scope:** Complete model categorization system - schemas, services, API routes, UI components, leaderboard, CSS, and config data
**Files Reviewed:** 25+

---

## Executive Summary

The categorization system has strong architectural foundations (generalist scoring, two-board leaderboard, reusable badge component) but suffers from **category enum fragmentation** across the stack. Five different category lists exist with no shared source of truth, causing silent data mismatches between benchmarks (12 categories), the model registry (7 categories), the UI (6-7 categories), and the leaderboard tabs (5 categories).

**Overall Consistency Score: 4/10**

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
| `src/services/benchmark/generalistScore.js` | Service: weighted quality scoring (11 categories) |
| `src/services/qualityScorer.js` | Service: LLM-as-judge scoring configs (12 categories) |
| `public/js/model-categorization.js` | UI: category management page (7 categories) |
| `public/js/model-categorization-enhancements.js` | UI: search, filter, export, shortcuts |
| `public/js/leaderboard.js` | UI: performance + quality boards |
| `public/js/components/CategoryBadge.js` | Component: badge with confidence ring (6 categories) |
| `public/model-categorization.html` | HTML: categorization page |
| `public/leaderboard.html` | HTML: leaderboard page (5 category tabs) |
| `public/css/components/category-badge.css` | Styles: 11 category colors |
| `public/css/model-categorization.css` | Styles: categorization page |
| `public/css/leaderboard.css` | Styles: leaderboard page |
| `data/categorization-prompts.json` | Config: 42 diagnostic prompts (6 categories) |

---

## CRITICAL Issues

### 1. Category Enum Fragmentation (Systemic)

No single source of truth for category definitions. Five different lists:

| Location | Categories | Count |
|----------|-----------|-------|
| `ModelRegistry.js:128` | ops, coding, reasoning, specialist, generalist, embedding, judge | 7 |
| `BenchmarkResult.js:53` | coding, reasoning, factual, math, creative, general + 6 enhanced | 12 |
| `CategoryBadge.js:8` | coding, reasoning, factual, math, creative, general | 6 |
| `category-badge.css` | coding, reasoning, factual, math, creative, generalist, specialist, ops, embedding, judge, general | 11 |
| `generalistScore.js:39` | coding, reasoning, factual, creative, instruction-following, math, summarization, multi-turn-reasoning, context-retention, translation, edge-cases | 11 |
| `leaderboard.html:58` tabs | ops, coding, reasoning, specialist, generalist | 5 |

**Impact:** `syncBenchmarkStats()` writes `bestCategory` from 12-category space, but ModelRegistry only allows 7 manual categories. Leaderboard filters on `recommended_category` (from `bestCategory`) but tabs only cover 5 options. Models with best category `math` or `factual` fall through all filters.

**Fix:** Create `src/config/categories.js` as canonical source. All schemas, UI, and services import from there.

### 2. Duplicate DOM Construction in renderTable

`model-categorization.js:120-251` builds each row twice for several columns:

- **Lines 125-132:** Creates innerHTML checkbox, then creates another `selectCheckbox` programmatically. Two checkboxes per row.
- **Lines 214-248:** Sets innerHTML with save/test buttons, then creates same buttons via DOM API. Duplicate buttons.

**Fix:** Use one approach per column (innerHTML template OR DOM API), not both.

---

## MAJOR Issues

### 3. CategoryBadge.js Missing 5+ Categories

`CategoryBadge.js:8-15` only defines 6 AI benchmark categories. Missing:
- Manual: generalist, specialist, ops, embedding, judge
- Enhanced: instruction-following, summarization, translation, multi-turn-reasoning, context-retention, edge-cases

All missing categories fall back to `general` config (line 112), rendering wrong icon/label/color. Meanwhile `category-badge.css` already defines 11 category colors.

**Fix:** Extend `CATEGORY_CONFIG` to match the CSS definitions (11+ categories).

### 4. Leaderboard Tab/Filter Design Mismatch

`leaderboard.html:58-77` has 5 filter tabs (ops, coding, reasoning, specialist, generalist). `filterByCategory()` at `leaderboard.js:219` filters on `recommended_category` from `benchmarkStats.bestCategory`, which comes from 12-category benchmark space.

Models whose best benchmark category is `math`, `factual`, `creative`, `general`, or any enhanced category are invisible to all tab filters.

**Fix:** Either add tabs for all benchmark categories, filter on manual `categories[]` instead, or create a mapping from benchmark categories to tab groups.

### 5. `general` Missing from Generalist Weights

`generalistScore.js:39-56` has 11 categories summing to **0.95**, not 1.0. The `general` category is absent despite being a valid prompt_category.

The methodology modal in `leaderboard.html:269` states "Quality Assurance (10%): Edge-Cases (5%), General (5%)" but code only has `edge-cases: 0.05`. Documentation and code disagree.

**Fix:** Add `'general': 0.05` to weights (total = 1.0) or update methodology docs.

### 6. Enhancements File Syntax Issue

`model-categorization-enhancements.js:417-420` has orphaned closing code after `setupResponsiveHelpers()` ends at line 415:

```javascript
    console.log('...');
    console.log(`...`);
    }, 200);
});
```

This appears to be a duplicate of the DOMContentLoaded setTimeout closure from line 278. May cause parse errors or be dead code.

**Fix:** Remove lines 417-420.

### 7. Quick Test is Simulated

`model-categorization.js:400-448` runs a purely client-side progress animation. No benchmark prompts are executed. At completion, it reads pre-existing `bestCategory` data and presents it as a new result.

**Fix:** Connect to real benchmark runner or relabel as "View Existing Results".

---

## MODERATE Issues

### 8. Model Router Task Map is Minimal

`ModelRegistry.js:560-565` has only 4 hardcoded task-to-category mappings. Doesn't leverage benchmark scores, model capabilities, or the full category space.

### 9. getGroupedByCategory Hardcodes 7 Categories

`ModelRegistry.js:308-315` initializes grouped object with exactly 7 keys. Models with categories outside this set are silently dropped.

**Fix:** Build grouped object dynamically from the schema enum or shared config.

### 10. Inconsistent Color Schemes

Three different color systems:
- `CategoryBadge.js`: coding = #7c9fff (blue)
- `leaderboard.js getCategoryConfig()`: coding = #9b59b6 (purple)
- `category-badge.css`: coding = #7c9fff (blue)

The leaderboard uses completely different colors than the badge component for the same categories.

**Fix:** Unify color definitions through shared config or CSS variables.

### 11. No Input Validation on Category PATCH

`PATCH /api/models/registry/:name` uses `runValidators: true`, so Mongoose rejects categories not in the 7-value enum. But `bestCategory` can hold any of 12 benchmark categories (stored as unvalidated string). Users can't manually assign categories their models are benchmarked against.

---

## MINOR Issues

### 12. filterModels Targets Wrong Element ID

`model-categorization-enhancements.js:138` queries `#modelTableBody` but HTML uses `#modelsTableBody`. Search/filter silently broken.

### 13. Chart Colors Limited to 7

`model-categorization.js:539-541` provides exactly 7 colors for doughnut chart. Extra categories get Chart.js defaults.

### 14. Missing Category Icons

`model-categorization.js:268-280` icon map lacks `general`, `math`, `creative`, `factual`. These render as `fa-question`.

### 15. Categorization Prompts Incomplete

`data/categorization-prompts.json` has 42 prompts across only 6 categories. Missing prompts for the 6 enhanced categories (instruction-following, summarization, etc.).

---

## Architecture Strengths

1. **generalistScore.js** - Clean single-source-of-truth scoring with documented formula, coverage penalties, consistency bonuses, and infrastructure failure exemption.

2. **Two-board leaderboard** - Performance Board (speed+quality composite) vs Quality Board (weighted generalist) is a thoughtful distinction.

3. **CategoryBadge component pattern** - Good reusable architecture with confidence rings, tooltips, size variants, and proper CSS separation.

4. **BenchmarkResult schema instrumentation** - Hardware snapshots, judge confidence, truncation detection, warmup tracking is production-grade.

5. **Dashboard enrichment pattern** - Clean separation between raw benchmark data and enriched display data via ModelRegistry join.

---

## Recommended Fix Order

1. **Create shared category constants** (`src/config/categories.js`) - unblocks everything else
2. **Fix duplicate DOM in renderTable** - functional bug, visible to users
3. **Extend CategoryBadge** to 11+ categories - quick win, high visual impact
4. **Fix `general` weight** in generalistScore.js - data correctness
5. **Fix enhancements file syntax** - potential parse error
6. **Fix filterModels element ID** - search is broken
7. **Redesign leaderboard tab filtering** - requires design decision on category mapping
8. **Unify color schemes** - visual consistency
9. **Connect or relabel quick test** - UX honesty
10. **Expand categorization prompts** - content work, lower urgency
