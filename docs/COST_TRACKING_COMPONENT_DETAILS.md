# Cost Tracking UI Components - Detailed Component Specifications

**Document Date:** 2026-01-01
**Reference:** See `/docs/COST_TRACKING_UI_DESIGN.md` for primary specification

---

## Component 1: Cost Stats Cards - Detailed Specification

### Visual Mockup

```
┌─────────────────────────────────────────────────────────────┐
│                    COST STATS CARDS                         │
├─────────────────┬──────────────────┬──────────────┬─────────┤
│  Total Cost     │  Cost/Conversat. │  Cost/1K Tk  │ Token/$ │
│  $ 12.45        │  $ 0.143         │  $ 0.0996    │ 10,040  │
│  Period spend   │  Average spend   │  Efficiency  │ Value   │
└─────────────────┴──────────────────┴──────────────┴─────────┘
```

### Component Properties

| Property | Value | Notes |
|----------|-------|-------|
| **Container Class** | `.stats-row` | Same as existing Quick Stats |
| **Card Class** | `.stat-card` | Reuse existing styling |
| **Layout** | 4 columns, responsive grid | Mobile: 2x2 or 1x4 |
| **Card Height** | ~80px | Consistent with other stat cards |
| **Border Radius** | 12px | Consistent with design system |
| **Background** | rgba(255,255,255,0.02) | Semi-transparent panel |
| **Border** | 1px solid var(--panel-border) | Subtle divider |

### Data Refresh Triggers

1. **Automatic:** Page load
2. **User-initiated:** Period select dropdown change
3. **Manual:** Refresh button click

### Error States

- **No data for period:** Display "—" with gray color
- **API failure:** Show "Error" with red color, log to console
- **Zero cost:** Display "$0.00" (valid state for free models)

### Tooltip Triggers

Hover over card → Show data-tooltip attribute via browser tooltip

### Sample Data Scenarios

**Scenario A: High-cost period**
```
Total Cost: $45.67
Cost/Conv: $0.52
Cost/1K Tokens: $0.364
Tokens/$: 2,747
Trend: Up 23% from previous period
```

**Scenario B: Free/low-cost period**
```
Total Cost: $0.00
Cost/Conv: $0.00
Cost/1K Tokens: $0.00
Tokens/$: —
Trend: No cost data
```

### CSS Classes Applied

```css
.cost-stats-row {}          /* Container wrapper */
.stat-card {}               /* Individual card */
.stat-card .label {}        /* "Total Cost" text */
.stat-card .value {}        /* "$12.45" text */
.stat-card .sub {}          /* "Period spend" text */
```

---

## Component 2: Cost Trend Chart - Detailed Specification

### Visual Mockup (By Day grouping)

```
Cost Trends                                    [Refresh] [By Day ▼]

 $50 ┤
 $40 ┤        ╭╮
 $30 ┤  ╭╮   ╱ ╲    ╭╮
 $20 ┤ ╱  ╲ ╱   ╲  ╱  ╲
 $10 ┤╱    ╲╱     ╲╱    ╲
  $0 ┤─────────────────────────────
     Jan1  Jan2  Jan3  Jan4  Jan5

     12 ┤ conversations (right axis)
     10 ┤ ╱╲  ╱╲  ╱╲
      8 ┤╱  ╲╱  ╲╱  ╲
      6 ┤
```

### Chart Configuration Details

| Property | Value | Notes |
|----------|-------|-------|
| **Type** | Line chart | Dual-axis (left/right) |
| **X-Axis** | Dates, Models, or Prompts | Dynamic based on groupBy |
| **Y-Axis (Left)** | Cost (USD) | $0 to max + 10% padding |
| **Y-Axis (Right)** | Conversations | 0 to max + 10% padding |
| **Line 1** | Cost trend | Color: `--accent (#7cf0ff)` |
| **Line 2** | Conversation count | Color: `--accent-2 (#eeb0ff)` |
| **Point Markers** | 4px circles | Filled with line color |
| **Hover Action** | Show tooltip with values | Format: `$X.XX (Y conversations)` |
| **Legend** | Top-center above chart | Show both datasets |

### GroupBy Variants

**By Day:**
- X-axis: ISO 8601 dates (YYYY-MM-DD)
- One data point per day
- Useful for: Daily spending trends, identifying peak usage days

**By Model:**
- X-axis: Model names (e.g., "qwen:14b", "llama2:7b")
- One bar per model (aggregated across period)
- Useful for: Comparing model costs

**By Prompt:**
- X-axis: Prompt names + versions (e.g., "default_chat v3")
- One bar per prompt version
- Useful for: Identifying which prompts are most expensive

### Interaction Behavior

1. **GroupBy Selector Change:**
   - Destroy existing chart
   - Fetch new data with groupBy parameter
   - Render new chart
   - Update X-axis labels
   - Show loading indicator during fetch

2. **Period Selector Change:**
   - Same as above

3. **Hover:**
   - Show multi-line tooltip
   - Highlight line on hover
   - Show all values for that X-axis point

4. **Legend Click:**
   - Toggle line visibility (standard Chart.js behavior)

### Sample Data Rendering

**Input (groupBy=model):**
```javascript
trends: [
  { model: 'qwen:14b', cost: 4.23, conversations: 22 },
  { model: 'llama2:7b', cost: 3.12, conversations: 18 },
  { model: 'dolphin-mixtral:8x7b', cost: 2.87, conversations: 15 }
]
```

**Output:**
- X-axis: ['qwen:14b', 'llama2:7b', 'dolphin-mixtral:8x7b']
- Cost data: [4.23, 3.12, 2.87]
- Conversations data: [22, 18, 15]

### Tooltip Format

```
2026-01-01
Cost: $2.34
Conversations: 12
```

### Error Handling

- **No data:** Show "No cost data for this period." message
- **Invalid groupBy:** Default to 'day'
- **API error:** Log to console, show generic error message

---

## Component 3: Cost Efficiency Table - Detailed Specification

### Visual Mockup

```
Cost Efficiency by Model                                    [Refresh]

┌────────────────────────┬─────────┬──────────┬──────────┬────────────┬──────────┬────────────┐
│ Model                  │ Total   │ Tokens   │ $/1K     │ Tokens/$   │ Avg      │ Efficiency │
│                        │ Cost    │          │ Tokens   │            │ Cost/Conv│            │
├────────────────────────┼─────────┼──────────┼──────────┼────────────┼──────────┼────────────┤
│ 🟦 qwen:14b           │ $4.23   │ 45,000   │ $0.0940  │ 10,638     │ $0.192   │ Best ★     │
│ 🟪 llama2:7b          │ $3.12   │ 32,000   │ $0.0975  │ 10,256     │ $0.173   │ 2/4        │
│ 🟩 dolphin-mixtral    │ $2.87   │ 28,000   │ $0.1025  │ 9,756      │ $0.191   │ 3/4        │
│ 🟨 neural-chat:7b     │ $2.23   │ 20,000   │ $0.1115  │ 8,982      │ $0.186   │ Least Eff. │
└────────────────────────┴─────────┴──────────┴──────────┴────────────┴──────────┴────────────┘
```

### Column Specifications

| Column | Format | Alignment | Width | Notes |
|--------|--------|-----------|-------|-------|
| Model | Text + Icon | Left | 200px | Cube icon + model name |
| Total Cost | Currency | Right | 100px | Bold, cyan color |
| Tokens | Comma-separated number | Right | 100px | Gray text |
| $/1K Tokens | Currency (4 decimals) | Right | 120px | Gray text |
| Tokens/$ | Comma-separated number (bold) | Right | 120px | Green text, high = good |
| Avg Cost/Conv | Currency (3 decimals) | Right | 120px | Gray text |
| Efficiency | Badge | Center | 120px | Best/Rank/Least Efficient |

### Badge Styles

| Badge Type | Background Color | Text Color | Icon | When |
|------------|------------------|-----------|------|------|
| **Best ★** | rgba(76, 222, 128, 0.2) | #4ade80 (green) | ★ | Rank 1 (lowest cost) |
| **Good** | rgba(59, 130, 246, 0.2) | #3b82f6 (blue) | — | Rank 2-3 |
| **Fair** | rgba(251, 191, 36, 0.2) | #fbbf24 (yellow) | — | Middle ranks |
| **Least Eff.** | rgba(248, 113, 113, 0.2) | #f87171 (red) | — | Last rank |
| **Rank N/M** | rgba(0,0,0,0.2) | var(--muted) | — | Specific position |

### Row Interaction

1. **Hover:** Background fades to rgba(255,255,255,0.02)
2. **Click:** (Optional) Open model detail view
3. **Sort:** Click column header to sort (not included in MVP)

### Sorting Logic

Default: Sort by `costPer1kTokens` ascending (most efficient first)

Models with zero cost (Ollama local):
- Display as "$0.0000" and rank first
- Mark as "Built-in" badge instead of rank

### Responsive Behavior

- **Desktop (>1024px):** Full table, all columns visible
- **Tablet (768-1024px):** Horizontal scroll, lock first 2 columns
- **Mobile (<768px):** Stack layout or horizontal scroll

### Empty State

```
┌─────────────────────────────────────────────────────────────┐
│                   No cost data available                    │
│            Select a different time period                   │
└─────────────────────────────────────────────────────────────┘
```

### Data Filtering

Optional filters (for future enhancement):
- Show only models with >N conversations
- Hide zero-cost models
- Highlight models trending up/down

---

## Component 4: Cost Breakdown Chart - Detailed Specification

### Visual Mockup (Donut Chart + Stats Sidebar)

```
Cost Distribution by Model                    [○ Pie] [◎ Donut]

┌──────────────────────────┬──────────────────────────────────┐
│                          │ qwen:14b                         │
│        ╱────────╲        │ $4.23        34.0%  ████████   │
│     ╱──          ──╲     │ 22 conversations, 45,000 tokens  │
│   ╱                  ╲   │                                  │
│  │                    │  │ llama2:7b                        │
│  │  ╱──╲              │  │ $3.12        25.0%  ██████      │
│  │ │    │ 34%         │  │ 18 conversations, 32,000 tokens  │
│  │  ╲──╱              │  │                                  │
│  │  25%               │  │ dolphin-mixtral:8x7b             │
│  │  ╱───╲             │  │ $2.87        23.0%  █████       │
│   ╲│     │23%        ╱   │ 15 conversations, 28,000 tokens  │
│     ╲    │          ╱    │                                  │
│       ╲──╱──────╱        │ neural-chat:7b                   │
│        18%              │ $2.23        18.0%  ████         │
│                          │ 12 conversations, 20,000 tokens  │
└──────────────────────────┴──────────────────────────────────┘
```

### Chart Properties

| Property | Value | Notes |
|----------|-------|-------|
| **Type** | Doughnut or Pie | Toggle via checkbox |
| **Data** | Cost breakdown by model | Order: descending by cost |
| **Colors** | Auto-generated palette | 8 colors cycling |
| **Hover Behavior** | Offset effect on hovered segment | Highlight + show tooltip |
| **Tooltip Format** | `$X.XX (Y%)` | Model name in legend |
| **Legend** | Hidden (shown in sidebar) | Custom rendering below |

### Color Palette (Generated)

```javascript
[
  'rgba(124, 240, 255, 0.8)',       // Cyan
  'rgba(238, 176, 255, 0.8)',       // Purple
  'rgba(74, 222, 128, 0.8)',        // Green
  'rgba(251, 191, 36, 0.8)',        // Yellow
  'rgba(59, 130, 246, 0.8)',        // Blue
  'rgba(168, 85, 247, 0.8)',        // Violet
  'rgba(236, 72, 153, 0.8)',        // Pink
  'rgba(249, 115, 22, 0.8)'         // Orange
]
```

When more than 8 models: Cycle through colors with darker variants

### Stats Sidebar Structure

For each model (sorted by cost descending):

```
┌─ Model Name ────────────────────┐
│ $X.XX  ← Total cost (right)     │
│ ████████ 34.0%  ← Progress bar  │
│ N conversations, M tokens      │
└─────────────────────────────────┘
```

**Sidebar Card Properties:**
- Border-left: 3px solid (matching chart color)
- Background: rgba(255,255,255,0.02)
- Padding: 12px
- Gap between cards: 8px
- Progress bar height: 4px

**Progress Bar:**
- Background: rgba(255,255,255,0.1) (subtle)
- Fill: Model's assigned color
- Width: `(cost / totalCost) * 100%`
- Border-radius: 2px

### Layout Configuration

**Desktop (>1000px):**
- Grid: 2 columns
- Left column: Chart (600px max)
- Right column: Sidebar stats (flex: 1)
- Gap: 20px

**Tablet (768-1000px):**
- Stack vertically
- Chart on top
- Stats below

**Mobile (<768px):**
- Full-width stack
- Chart height: 250px
- Stats: Full-width cards

### Interaction Behaviors

1. **Chart Segment Click:**
   - (Optional) Highlight matching stat card in sidebar
   - Scroll sidebar to that model

2. **Stat Card Hover:**
   - Highlight corresponding chart segment
   - Add shadow to card

3. **Chart Type Toggle:**
   - Destroy chart
   - Re-render as pie or doughnut
   - Preserve color assignments

4. **Period Change:**
   - Fetch new data
   - Animate chart transition
   - Update sidebar stats

### Sample Data Mapping

**Input:**
```javascript
breakdown: [
  { model: 'qwen:14b', cost: 4.23, percentage: 34.0, conversations: 22, tokens: 45000 },
  { model: 'llama2:7b', cost: 3.12, percentage: 25.0, conversations: 18, tokens: 32000 },
  { model: 'dolphin-mixtral:8x7b', cost: 2.87, percentage: 23.0, conversations: 15, tokens: 28000 },
  { model: 'neural-chat:7b', cost: 2.23, percentage: 18.0, conversations: 12, tokens: 20000 }
]
```

**Chart Data:**
```javascript
labels: ['qwen:14b', 'llama2:7b', 'dolphin-mixtral:8x7b', 'neural-chat:7b']
data: [4.23, 3.12, 2.87, 2.23]
backgroundColor: [colors[0], colors[1], colors[2], colors[3]]
```

**Sidebar Rendering:**
- Card 1 (qwen:14b): $4.23, 34%, with cyan border
- Card 2 (llama2:7b): $3.12, 25%, with purple border
- Card 3 (dolphin-mixtral:8x7b): $2.87, 23%, with green border
- Card 4 (neural-chat:7b): $2.23, 18%, with yellow border

### Empty State

If no models with costs:
```
┌──────────────────────────┬──────────────────────────────────┐
│      No cost data        │ Select a different time period   │
│      available           │ or enable cost tracking          │
└──────────────────────────┴──────────────────────────────────┘
```

### Donut vs Pie Toggle

**Pie Chart:**
- Full circle: 360 degrees
- Center: Empty
- Use case: Classic cost distribution

**Donut Chart:**
- Hollow center
- More modern appearance
- Better label placement inside center

**Center Label (Donut only):**
```
Total Cost
$12.45
```

---

## Data Flow Diagrams

### Component Initialization Flow

```
Page Load
    ↓
[Check Auth] ← Yes → [Load Analytics Page]
    ↓                      ↓
   No → [Redirect to Login]  [Fetch all data]
                            ↓
                   [refreshCostStats()]
                   [refreshCostTrend()]
                   [refreshEfficiencyTable()]
                   [refreshCostBreakdown()]
                            ↓
                   [All 4 components render]
                   [Set event listeners]
```

### Period Change Flow

```
User changes period (dropdown)
    ↓
[periodSelect.change event]
    ↓
All listeners fire:
  ├→ [refreshCostStats()]
  ├→ [refreshCostTrend()]
  ├→ [refreshEfficiencyTable()]
  └→ [refreshCostBreakdown()]
    ↓
For each:
  [Fetch from /api/analytics/costs]
    ↓
  [Destroy existing chart/table]
    ↓
  [Render new component with fresh data]
    ↓
  [Show loading state while fetching]
```

### Error Handling Flow

```
Fetch from /api/analytics/costs
    ↓
[Response received]
    ├→ 200 OK → [Parse JSON] → [Render component]
    ├→ 401 Unauthorized → [Redirect to login.html]
    ├→ 400 Bad Request → [Log error] → [Show "No data" message]
    ├→ 500 Server Error → [Log error] → [Show "Error loading data" message]
    └→ Network Error → [Show "Connection failed" message]
```

---

## Accessibility Considerations

### Screen Readers

- **Stat Cards:** Use semantic `<div>` with aria-label
  ```html
  <div class="stat-card" aria-label="Total Cost: 12.45 USD">
  ```

- **Chart Canvas:** Add description via aria-label
  ```html
  <canvas aria-label="Cost trends over time, showing $2.34 to $3.87 range"></canvas>
  ```

- **Table:** Use semantic `<table>` with proper thead/tbody
  ```html
  <thead role="columnheader">
    <tr>
      <th scope="col">Model</th>
      <th scope="col">Total Cost</th>
      ...
    </tr>
  </thead>
  ```

### Keyboard Navigation

- Tab through stat cards
- Period/GroupBy selects: Arrow keys to change
- Table rows: Tab to navigate, Enter to expand
- Chart: No keyboard interaction needed (visual only)

### Color Contrast

- Text on background: WCAG AA compliant (4.5:1 minimum)
- Chart colors: Distinguishable for colorblind users
- Status badges: Use icons + color (not color alone)

---

## Testing Strategy

### Unit Tests

**For each component:**
1. Test data fetch with valid response
2. Test data fetch with empty response
3. Test data fetch with API error
4. Test UI rendering with sample data
5. Test event handlers (refresh, period change, etc.)

### Integration Tests

1. Test full page load with all 4 components
2. Test period change triggers all refreshes
3. Test chart switching (pie ↔ donut)
4. Test table sorting/filtering
5. Test responsive layout at different breakpoints

### Visual Tests

1. Compare rendered components against mockups
2. Verify color accuracy
3. Verify alignment and spacing
4. Test dark mode compatibility

### Performance Tests

1. Render with >100 models (efficiency table)
2. Render with 12+ months of daily data (trend chart)
3. Measure time to first interaction
4. Measure memory usage with all charts active

---

## Browser Compatibility

| Browser | Version | Status | Notes |
|---------|---------|--------|-------|
| Chrome | 90+ | ✓ Supported | Full support |
| Firefox | 88+ | ✓ Supported | Full support |
| Safari | 14+ | ✓ Supported | Full support |
| Edge | 90+ | ✓ Supported | Full support |
| Mobile Chrome | Latest | ✓ Supported | Responsive layout |
| Mobile Safari | 14+ | ✓ Supported | Responsive layout |

**Chart.js version:** 4.4.4 (already loaded)
**No polyfills required** for modern browsers

