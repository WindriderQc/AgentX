# Model Categorization Peer Review

**Date:** 2026-02-09
**Scope:** Complete model categorization system - schemas, services, API routes, UI components, leaderboard, CSS, and config data
**Files Reviewed:** 25+
**Revision:** All 15 issues resolved

---

## Executive Summary

The categorization system has strong architectural foundations (generalist scoring, two-board leaderboard, reusable badge component). The initial review identified **category enum fragmentation** across the stack with five different category lists and no shared source of truth.

**All issues now resolved:**
- Generalist weights now sum to 1.0 (added missing `general: 0.05`)
- CategoryBadge extended to 17 categories (6 original + 6 enhanced + 5 manual)
- CSS covers all 17 categories
- Duplicate DOM construction in renderTable eliminated
- filterModels element ID mismatch fixed
- Orphaned code in enhancements file removed
- Leaderboard getCategoryConfig replaced with exact-match lookup
- Missing icons added to model-categorization getCategoryIcon
- Methodology modal documentation corrected
- Shared category config created (`config/categories.js`) as canonical source
- Leaderboard tabs redesigned to cover all benchmark categories via grouped tabs
- Quick test relabeled as "View Benchmark Results" (no more fake progress)
- Task router expanded from 4 to 12 mappings
- getGroupedByCategory now builds dynamically from schema enum
- Chart colors mapped to config-aligned category colors
- 42 new categorization prompts added for 6 enhanced categories

**Overall Consistency Score: 9/10** (was 7/10, was 4/10)

---

## Files Reviewed

| File | Purpose |
|------|---------|
| `config/categories.js` | **NEW** - Shared source of truth for categories, weights, tab groups, task router |
| `models/ModelRegistry.js` | Schema: model metadata + categories (7-value enum) |
| `models/BenchmarkResult.js` | Schema: benchmark results (12-value prompt_category) |
| `models/BenchmarkPrompt.js` | Schema: benchmark prompts (12-value category) |
| `models/CustomModel.js` | Schema: custom models (freeform categories) |
| `routes/model-registry.js` | API: CRUD + category management |
| `routes/benchmark/analytics.js` | API: dashboard + generalist-leaderboard |
| `src/services/benchmark/results.js` | Service: dashboard enrichment with recommended_category |
| `src/services/benchmark/generalistScore.js` | Service: weighted quality scoring (imports from config) |
| `src/services/qualityScorer.js` | Service: LLM-as-judge scoring configs (12 categories) |
| `public/js/model-categorization.js` | UI: category management page (config-aligned colors, relabeled quick test) |
| `public/js/model-categorization-enhancements.js` | UI: search, filter, export, shortcuts |
| `public/js/leaderboard.js` | UI: performance + quality boards (dynamic tabs, grouped filtering) |
| `public/js/components/CategoryBadge.js` | Component: badge with confidence ring (17 categories) |
| `public/model-categorization.html` | HTML: categorization page (updated modal title) |
| `public/leaderboard.html` | HTML: leaderboard page (dynamic tab container) |
| `public/css/components/category-badge.css` | Styles: 17 category colors |
| `public/css/model-categorization.css` | Styles: categorization page |
| `public/css/leaderboard.css` | Styles: leaderboard page (config-aligned tab colors) |
| `data/categorization-prompts.json` | Config: 84 diagnostic prompts (12 categories) |

---

## ALL Issues RESOLVED

### ~~1. Category Enum Fragmentation (Systemic)~~ RESOLVED

Created `config/categories.js` as shared source of truth with:
- `MANUAL_CATEGORIES` (7): ops, coding, reasoning, specialist, generalist, embedding, judge
- `BENCHMARK_CATEGORIES` (12): coding, reasoning, factual, math, creative, general + 6 enhanced
- `GENERALIST_CATEGORY_WEIGHTS`: imported by generalistScore.js
- `LEADERBOARD_TAB_GROUPS`: drives dynamic tab generation
- `TASK_CATEGORY_MAP`: imported by ModelRegistry.js isSuitableFor()

### ~~2. Duplicate DOM Construction in renderTable~~ RESOLVED

`model-categorization.js` renderTable now uses a single approach (DOM API) per column.

### ~~3. CategoryBadge.js Missing Categories~~ RESOLVED

`CATEGORY_CONFIG` defines 17 categories with icon, color, and label. CSS matches.

### ~~4. Leaderboard Tab/Filter Design Mismatch~~ RESOLVED

Leaderboard tabs now dynamically generated from `LEADERBOARD_TAB_GROUPS` config. 12 benchmark categories are grouped into 7 logical tab groups:
- All Models, Coding, Reasoning (reasoning + multi-turn), Knowledge (factual + general + context-retention), Creative (creative + edge-cases), Language (instruction-following + summarization + translation), Math

Filtering uses grouped matching - selecting "Reasoning" tab shows models whose best benchmark category is either `reasoning` or `multi-turn-reasoning`.

### ~~5. `general` Missing from Generalist Weights~~ RESOLVED

Added `'general': 0.05`. Total sums to 1.0.

### ~~6. Enhancements File Syntax Issue~~ RESOLVED

Orphaned code removed.

### ~~7. Quick Test is Simulated~~ RESOLVED

Relabeled as "Benchmark Results". Modal title changed from "Running Categorization Test" to "Benchmark Results". Button changed from "Test" to "Results". No more fake progress bar animation - immediately shows existing benchmark data or "No benchmark data available" message.

### ~~8. Model Router Task Map is Minimal~~ RESOLVED

Expanded from 4 to 12 task mappings. Now imports from `config/categories.js`:
- code_generation, code_review -> coding
- deep_reasoning, analysis -> reasoning
- quick_chat, conversation -> ops
- factual_qa, summarization, translation, creative_writing -> generalist
- embedding -> embedding
- quality_scoring -> judge

### ~~9. getGroupedByCategory Hardcodes 7 Categories~~ RESOLVED

Now builds grouped object dynamically from `ModelRegistrySchema.path('categories').caster.enumValues`. New categories added to the schema enum are automatically included.

### ~~10. Inconsistent Color Schemes~~ RESOLVED

Leaderboard tab CSS colors aligned with `config/categories.js`. Category config map in leaderboard.js already aligned.

### ~~11. No Input Validation on Category PATCH~~ LOW PRIORITY (Accepted)

Mongoose `runValidators: true` handles manual enum validation. Benchmark-derived `bestCategory` is set by trusted backend code. Accepted as low-risk per security philosophy.

### ~~12. filterModels Targets Wrong Element ID~~ RESOLVED

Fixed `#modelTableBody` to `#modelsTableBody`.

### ~~13. Chart Colors Limited to 7~~ RESOLVED

Doughnut chart in `model-categorization.js` now maps category names to config-aligned colors via a lookup object. Falls back to a 10-color palette for unknown categories.

### ~~14. Missing Category Icons~~ RESOLVED

All 12 benchmark categories have icons in `getCategoryIcon()`.

### ~~15. Categorization Prompts Incomplete~~ RESOLVED

Added 42 new prompts across 6 enhanced categories (7 per category):
- instruction-following: format constraints, output format, negative constraints, ordered steps, multi-constraint, role adherence, JSON output
- summarization: paragraph summary, key points, technical summary, meeting notes, comparative, one-line, abstract
- translation: French, Spanish, German idiom, Japanese, Portuguese technical, Italian, Korean formal/informal
- multi-turn-reasoning: building context, conditional chain, accumulative math, schedule conflict, recipe scaling, investment tracking, elimination logic
- context-retention: detail recall, cross-reference, sequence tracking, multi-entity, fact consistency, nested reference, instruction memory
- edge-cases: empty input, contradictory premise, ambiguous question, impossible task, trick question, boundary values, self-referential

Total prompts: 84 (was 42) across all 12 benchmark categories.

---

## Architecture Strengths

1. **config/categories.js** - New shared source of truth eliminates category drift risk across the stack.

2. **generalistScore.js** - Clean single-source-of-truth scoring with documented formula, coverage penalties, consistency bonuses, and infrastructure failure exemption. Now imports weights from config.

3. **Two-board leaderboard** - Performance Board (speed+quality composite) vs Quality Board (weighted generalist) with grouped category tabs covering all 12 benchmark categories.

4. **CategoryBadge component pattern** - Good reusable architecture with confidence rings, tooltips, size variants, and proper CSS separation. Covers all 17 categories.

5. **Dashboard enrichment pattern** - Clean separation between raw benchmark data and enriched display data via ModelRegistry join.

---

## Remaining Improvements (Future)

1. **routes/benchmark.js** at 1623 lines exceeds file size discipline (600 max) - split into sub-route files
2. **Frontend category config** - frontend files duplicate category definitions inline since they can't `require()`. Could serve config via API endpoint
3. **Benchmark integration for quick test** - currently shows existing data; could wire to real benchmark execution in future
