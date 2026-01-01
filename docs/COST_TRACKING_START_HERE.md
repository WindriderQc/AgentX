# Cost Tracking UI Components - START HERE

**Date:** 2026-01-01
**Status:** Design Phase - Ready for Implementation
**All Code Provided:** HTML, JavaScript, and API specifications (no code written yet, just designs)

---

## Quick Navigation

### For Project Managers / Architects
Start with: **[COST_TRACKING_SUMMARY.txt](COST_TRACKING_SUMMARY.txt)**
- 1-page overview of all 4 components
- File modifications required
- Implementation phases
- Design decisions
- Performance targets

### For Frontend Developers
Start with: **[COST_TRACKING_QUICK_REF.md](COST_TRACKING_QUICK_REF.md)**
- Copy-paste HTML code snippets
- JavaScript integration (pseudo-code)
- API query examples
- Event wiring code
- File checklist

### For Full Specification Details
Start with: **[COST_TRACKING_UI_DESIGN.md](COST_TRACKING_UI_DESIGN.md)** (Primary)
- Complete 500+ line specification
- All 4 component details
- HTML structures (full)
- Chart.js configurations (complete)
- JavaScript functions (pseudo-code)
- API endpoint specification
- Data format examples
- Implementation checklist

### For Component-Level Details
Start with: **[COST_TRACKING_COMPONENT_DETAILS.md](COST_TRACKING_COMPONENT_DETAILS.md)**
- Visual mockups for each component
- Data flow diagrams
- Column specifications
- Row structures
- Color assignments
- Interaction behaviors
- Responsive layout details
- Accessibility considerations
- Browser compatibility
- Testing strategies

---

## 4 Components Designed

### Component 1: Cost Stats Cards
**Purpose:** Quick metrics overview at a glance

```
┌──────────────────┬──────────────────┬──────────────────┬──────────────────┐
│  Total Cost      │ Cost/Conversation│ Cost/1K Tokens   │ Tokens/Dollar    │
│  $12.45          │ $0.143           │ $0.0996          │ 10,040           │
│  Period spend    │ Average spend    │ Efficiency       │ Value metric     │
└──────────────────┴──────────────────┴──────────────────┴──────────────────┘
```

**Location:** Below existing Quick Stats section (line 66 in analytics.html)
**HTML:** Simple 4-column grid, reuses `.stat-card` class
**JS:** 1 refresh function, ~20 lines of code

---

### Component 2: Cost Trend Chart
**Purpose:** Time-based cost patterns with dual-axis visualization

```
Cost (USD) ──────────────────────────────────────────────── Conversations
$3 ┤     ╭─╮
   │    ╱   ╲
$2 ┤   ╱     ╲╭╮
   │  ╱       │ ╲
$1 ┤╱        ╱   ╲╭
   ├────────────────────
```

**Location:** New grid row after RAG Adoption section (after line 157)
**Type:** Line chart with dual Y-axes (left: Cost, right: Conversations)
**GroupBy Options:** by day, by model, by prompt version
**JS:** 1 refresh function with Chart.js config, ~60 lines of code

---

### Component 3: Cost Efficiency Table
**Purpose:** Compare models by cost-per-token and identify most efficient

```
┌─────────────┬──────────┬───────────┬─────────────┬─────────────┬──────────┐
│ Model       │ Total    │ Tokens    │ $/1K Tokens │ Tokens/$    │ Rank     │
├─────────────┼──────────┼───────────┼─────────────┼─────────────┼──────────┤
│ qwen:14b    │ $4.23    │ 45,000    │ $0.0940     │ 10,638      │ Best ★   │
│ llama2:7b   │ $3.12    │ 32,000    │ $0.0975     │ 10,256      │ 2/4      │
│ mixtral:8x7 │ $2.87    │ 28,000    │ $0.1025     │ 9,756       │ 3/4      │
└─────────────┴──────────┴───────────┴─────────────┴─────────────┴──────────┘
```

**Location:** New grid row after Cost Trends (full width)
**Columns:** 7 columns (Model, Cost, Tokens, $/1K, Tokens/$, Avg, Efficiency)
**Sorting:** By $/1K tokens ascending (most efficient first)
**JS:** 1 refresh function with row generation, ~80 lines of code

---

### Component 4: Cost Breakdown Chart
**Purpose:** Visualize cost distribution across models

```
                Chart + Sidebar Stats
   ╱───────╲      Model Breakdown
  │ 34%    │      ├─ qwen:14b:     $4.23 (34%)
  │ 25%    │      ├─ llama2:7b:    $3.12 (25%)
  │ 23%    │      ├─ dolphin:      $2.87 (23%)
  │ 18%    │      └─ neural-chat:  $2.23 (18%)
   ╲───────╱
```

**Location:** New grid row after Efficiency Table (full width)
**Type:** Pie or Donut chart (user can toggle)
**Sidebar:** Stats cards with progress bars
**Colors:** 8-color auto-cycling palette
**JS:** 1 refresh function with Chart.js config + sidebar rendering, ~80 lines of code

---

## What's Provided (Design Only)

- **HTML Structures:** Complete, ready to copy-paste
- **Chart.js Configurations:** Full specifications
- **JavaScript Functions:** Pseudo-code and pseudo-code outlines
- **API Specifications:** Complete query params and response formats
- **Data Formats:** Examples for all API responses
- **CSS Strategy:** Reuses existing classes (no new CSS needed)
- **Integration Points:** Where to add code in existing files
- **Visual Mockups:** ASCII art representations
- **Color Specifications:** Hex values and CSS variable mappings

---

## What's NOT Provided (Code to Write)

- Actual JavaScript code (pseudo-code only, logic given)
- Backend `/api/analytics/costs` endpoint (specifications given)
- Cost configuration model (structure specified, DB schema given)
- Cost calculation service (algorithm specified, helpers outlined)
- Unit/integration tests (testing strategy provided)

---

## Files to Modify

### 1. `/public/analytics.html`
**Task:** Add 4 HTML sections for new components

**Insertions:**
- After line 66: Component 1 (Cost Stats Cards)
- After line 157: Component 2 (Cost Trend Chart)
- New row: Component 3 (Cost Efficiency Table)
- New row: Component 4 (Cost Breakdown Chart)

**Lines to add:** ~150 lines of HTML

---

### 2. `/public/js/analytics.js`
**Task:** Add JavaScript logic for all 4 components

**Additions:**
- Add ~15 new entries to `elements` object
- Add ~2 new entries to `charts` object
- Add 4 refresh functions:
  - `refreshCostStats()` (~20 lines)
  - `refreshCostTrend()` (~60 lines)
  - `refreshEfficiencyTable()` (~80 lines)
  - `refreshCostBreakdown()` (~80 lines)
- Wire up event listeners (~15 lines)

**Lines to add:** ~250 lines of JavaScript

---

### 3. `/routes/analytics.js`
**Task:** Add new `/api/analytics/costs` endpoint

**Implementation:**
- Base query (totalCost, totalTokens, metrics)
- groupBy=day variant
- groupBy=model variant
- groupBy=promptVersion variant
- breakdown=model variant

**Lines to add:** ~200 lines of JavaScript

---

### 4. `/src/services/costService.js` (NEW FILE)
**Task:** Create cost calculation service

**Implementation:**
- Cost config model
- Cost calculation function
- Aggregation helpers

**Lines to create:** ~100 lines of JavaScript

---

## API Endpoint Specification

```
GET /api/analytics/costs
```

**Query Parameters:**
- `from` (ISO 8601 date, default: 7 days ago)
- `to` (ISO 8601 date, default: now)
- `groupBy` (optional: 'day', 'model', 'promptVersion')
- `breakdown` (optional: 'model')
- `model` (optional: filter by specific model)

**Authentication:** Session auth OR x-api-key header

**Response Formats:** 3 variants provided (base, with groupBy, with breakdown)

---

## Key Design Features

✓ **Reuses Existing Patterns**
- All CSS classes already exist (.stat-card, .section-card, etc.)
- Chart.js already loaded
- Design system colors already defined
- No new CSS classes needed

✓ **Dual-Axis Chart**
- Cost Trend shows both USD AND conversation count
- Identifies if costs scale with conversations

✓ **Model Ranking**
- Efficiency Table ranks models by $/1K tokens
- Visual badges (Best ★, Rank, Least Efficient)
- Green/yellow/red color coding

✓ **Responsive Layout**
- Desktop: 4 columns of stats cards
- Tablet: 2x2 grid
- Mobile: 1 column or horizontal scroll
- Charts responsive via Chart.js

✓ **Complete Data Specification**
- All API responses documented
- All field types specified
- All calculation formulas provided

---

## Implementation Timeline (Estimated)

| Phase | Component | Effort | Time |
|-------|-----------|--------|------|
| 1 | Backend setup | Medium | 4-6 hours |
| 2 | Cost Stats Cards | Low | 1-2 hours |
| 3 | Cost Trend Chart | Medium | 2-3 hours |
| 4 | Efficiency Table | Medium | 2-3 hours |
| 5 | Cost Breakdown | Medium | 2-3 hours |
| 6 | Testing & Polish | Medium | 3-4 hours |
| **Total** | **All Components** | **High** | **14-21 hours** |

---

## How to Use These Documents

### Step 1: Read the Summary
- **File:** [COST_TRACKING_SUMMARY.txt](COST_TRACKING_SUMMARY.txt)
- **Time:** 5 minutes
- **Outcome:** Understand all 4 components, design decisions, file changes

### Step 2: Read the Quick Reference
- **File:** [COST_TRACKING_QUICK_REF.md](COST_TRACKING_QUICK_REF.md)
- **Time:** 15 minutes
- **Outcome:** Copy-paste HTML and JS pseudo-code, understand API responses

### Step 3: Implement Component 1
- **File:** [COST_TRACKING_UI_DESIGN.md](COST_TRACKING_UI_DESIGN.md) § Component 1
- **Time:** 1-2 hours
- **Tasks:** Add HTML, add JS, test with mock API

### Step 4: Implement Component 2
- **File:** [COST_TRACKING_UI_DESIGN.md](COST_TRACKING_UI_DESIGN.md) § Component 2
- **Time:** 2-3 hours
- **Tasks:** Add HTML, add JS with Chart.js, test groupBy variants

### Step 5: Implement Components 3 & 4
- **File:** [COST_TRACKING_UI_DESIGN.md](COST_TRACKING_UI_DESIGN.md) § Components 3-4
- **Time:** 4-6 hours
- **Tasks:** Add HTML, add JS, test interactive features

### Step 6: Reference Details as Needed
- **File:** [COST_TRACKING_COMPONENT_DETAILS.md](COST_TRACKING_COMPONENT_DETAILS.md)
- **When:** Color specifications, layout details, accessibility, browser compat

---

## Color Palette (Ready to Use)

**Primary (Existing CSS Variables):**
```
--accent: #7cf0ff (Cyan - primary metrics)
--accent-2: #eeb0ff (Purple - secondary metrics)
--text: #e8edf5 (Primary text)
--muted: #93a0b5 (Secondary text)
```

**Additional (Use as-is):**
```
Green (Good): #4ade80
Yellow (Fair): #fbbf24
Red (Poor): #f87171
Blue (Info): #3b82f6
```

---

## Checklist: Before You Start Coding

- [ ] Read COST_TRACKING_SUMMARY.txt (5 min)
- [ ] Read COST_TRACKING_QUICK_REF.md (15 min)
- [ ] Understand all 4 components
- [ ] Review existing analytics.html structure
- [ ] Review existing analytics.js patterns
- [ ] Plan backend cost calculation
- [ ] Set up cost config database model

---

## Common Questions

**Q: Do I need to write new CSS?**
A: No. All components reuse existing `.stat-card`, `.section-card`, etc. classes.

**Q: Can I implement components in any order?**
A: It's recommended to do Components 1 → 2 → 3 → 4 for dependencies.

**Q: What if the backend `/api/analytics/costs` endpoint doesn't exist?**
A: Mock it with hardcoded data initially for frontend testing.

**Q: How do I calculate costs?**
A: Use the formula: `(promptTokens * promptRate + completionTokens * completionRate) / 1000`

**Q: What are the token stats captured?**
A: Already in Conversation model: `stats.usage.promptTokens` and `.completionTokens`

**Q: Do I need to modify the database schema?**
A: No new Conversation fields needed. Token data already captured in existing `stats` field.

**Q: What about cost configuration?**
A: Create a new `CostConfig` model with pricing by model. See COST_TRACKING_UI_DESIGN.md for details.

---

## Document Index

| Document | Purpose | Length | Read Time |
|----------|---------|--------|-----------|
| **COST_TRACKING_SUMMARY.txt** | High-level overview | 1 page | 5 min |
| **COST_TRACKING_QUICK_REF.md** | Developer quick ref | 15 pages | 20 min |
| **COST_TRACKING_UI_DESIGN.md** | Main specification | 50 pages | 60 min |
| **COST_TRACKING_COMPONENT_DETAILS.md** | Component details | 40 pages | 45 min |
| **COST_TRACKING_START_HERE.md** | This file | Navigation | 10 min |

---

## Next Steps

1. **Read:** [COST_TRACKING_SUMMARY.txt](COST_TRACKING_SUMMARY.txt) (5 minutes)
2. **Scan:** [COST_TRACKING_QUICK_REF.md](COST_TRACKING_QUICK_REF.md) (15 minutes)
3. **Plan:** Identify your team members (frontend dev, backend dev)
4. **Design:** Cost config model and pricing structure
5. **Start Coding:** Follow implementation phases 1-6
6. **Reference:** Use COST_TRACKING_UI_DESIGN.md for full details
7. **Test:** Use COST_TRACKING_COMPONENT_DETAILS.md for testing strategy

---

## Files Created in This Design Phase

```
/docs/
  ├─ COST_TRACKING_START_HERE.md (this file)
  ├─ COST_TRACKING_SUMMARY.txt (overview)
  ├─ COST_TRACKING_QUICK_REF.md (developer guide)
  ├─ COST_TRACKING_UI_DESIGN.md (main spec)
  └─ COST_TRACKING_COMPONENT_DETAILS.md (detailed specs)
```

All files are in `/home/yb/codes/AgentX/docs/`

---

**Ready to implement? Start with [COST_TRACKING_SUMMARY.txt](COST_TRACKING_SUMMARY.txt)!**

