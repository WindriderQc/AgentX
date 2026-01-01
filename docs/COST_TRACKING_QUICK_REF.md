# Cost Tracking UI Components - Quick Reference Guide

**Quick links:**
- [Full Design Specification](/docs/COST_TRACKING_UI_DESIGN.md)
- [Detailed Component Specs](/docs/COST_TRACKING_COMPONENT_DETAILS.md)

---

## 4-Component Overview

| Component | Purpose | Location | Key Metrics |
|-----------|---------|----------|-------------|
| **Cost Stats Cards** | Quick metrics overview | Below Quick Stats section | Total Cost, Cost/Conv, $/1K Tokens, Tokens/$ |
| **Cost Trend Chart** | Time-based cost patterns | New grid row (full width) | Cost over time (line chart), dual-axis |
| **Efficiency Table** | Model cost comparison | New grid row (full width) | Model ranking by efficiency, cost-per-token |
| **Cost Breakdown** | Cost distribution | New grid row (full width) | Pie/donut chart + sidebar stats |

---

## Component Placement in HTML

```html
<!-- /public/analytics.html insertion points -->

<div class="stats-row">
  [Existing Quick Stats: Conversations, Messages, Feedback, RAG]
</div>

<div class="cost-stats-row stats-row">
  ← Component 1: COST STATS CARDS (NEW)
</div>

<div class="analytics-grid">
  [Existing: Usage Trends + RAG Adoption]
</div>

<div class="analytics-grid full">
  [Existing: Feedback Distribution]
</div>

<div class="analytics-grid full">
  ← Component 2: COST TRENDS CHART (NEW)
</div>

<div class="analytics-grid full">
  ← Component 3: COST EFFICIENCY TABLE (NEW)
</div>

<div class="analytics-grid full">
  ← Component 4: COST BREAKDOWN CHART (NEW)
</div>

<div class="analytics-grid full">
  [Existing: RAG Metrics]
</div>
```

---

## Component 1: Cost Stats Cards - HTML Only

```html
<div class="cost-stats-row stats-row">
    <div class="stat-card" data-tooltip="Total spending in selected period">
        <div class="label">Total Cost</div>
        <div class="value" id="totalCost">—</div>
        <div class="sub">Period spend</div>
    </div>
    <div class="stat-card" data-tooltip="Average cost per conversation">
        <div class="label">Cost/Conversation</div>
        <div class="value" id="costPerConversation">—</div>
        <div class="sub">Average spend</div>
    </div>
    <div class="stat-card" data-tooltip="Cost per thousand tokens used">
        <div class="label">Cost/1K Tokens</div>
        <div class="value" id="costPer1kTokens">—</div>
        <div class="sub">Efficiency metric</div>
    </div>
    <div class="stat-card" data-tooltip="Tokens generated per dollar spent">
        <div class="label">Tokens/Dollar</div>
        <div class="value" id="tokensPer Dollar">—</div>
        <div class="sub">Value metric</div>
    </div>
</div>
```

### JS: Elements
```javascript
totalCost: document.getElementById('totalCost'),
costPerConversation: document.getElementById('costPerConversation'),
costPer1kTokens: document.getElementById('costPer1kTokens'),
tokensPer Dollar: document.getElementById('tokensPer Dollar'),
```

### JS: Refresh Function
```javascript
async function refreshCostStats() {
  const { from, to } = periodRange(elements.periodSelect.value);
  try {
    const res = await fetchJSON(
      `/api/analytics/costs?from=${from.toISOString()}&to=${to.toISOString()}`
    );
    elements.totalCost.textContent = '$' + res.data.totalCost.toFixed(2);
    elements.costPerConversation.textContent = '$' + res.data.avgCostPerConversation.toFixed(3);
    elements.costPer1kTokens.textContent = '$' + res.data.costPer1kTokens.toFixed(4);
    elements.tokensPer Dollar.textContent = Math.round(res.data.tokensPer Dollar);
  } catch (err) {
    logger.error('Cost stats error', err);
  }
}
```

### API Response
```javascript
{
  status: 'success',
  data: {
    totalCost: 12.45,
    totalTokens: 125000,
    conversations: 87,
    avgCostPerConversation: 0.143,
    costPer1kTokens: 0.0996,
    tokensPer Dollar: 10040.16
  }
}
```

---

## Component 2: Cost Trend Chart - HTML Only

```html
<div class="analytics-grid full">
    <div class="section-card">
        <div class="section-header">
            <h2><i class="fas fa-chart-line"></i> Cost Trends</h2>
            <select id="costTrendGroupSelect" style="background: rgba(0,0,0,0.3); border: 1px solid var(--panel-border); border-radius: 6px; padding: 6px 10px; color: var(--text); font-size: 12px;">
                <option value="day">By Day</option>
                <option value="model">By Model</option>
                <option value="promptVersion">By Prompt</option>
            </select>
        </div>
        <div class="section-body">
            <div class="chart-container">
                <canvas id="costTrendChart"></canvas>
            </div>
            <div class="chart-empty" id="costTrendEmpty">No cost data for this period.</div>
        </div>
    </div>
</div>
```

### JS: Elements & Charts
```javascript
costTrendGroupSelect: document.getElementById('costTrendGroupSelect'),
costTrendEmpty: document.getElementById('costTrendEmpty'),

// In charts object:
costTrend: null,
```

### JS: Refresh Function (Pseudo-code)
```javascript
async function refreshCostTrend() {
  const groupBy = elements.costTrendGroupSelect.value;
  const res = await fetchJSON(
    `/api/analytics/costs?from=...&to=...&groupBy=${groupBy}`
  );

  if (charts.costTrend) charts.costTrend.destroy();

  charts.costTrend = new Chart(
    document.getElementById('costTrendChart').getContext('2d'),
    {
      type: 'line',
      data: {
        labels: res.data.trends.map(t => t.date || t.model || ...),
        datasets: [
          {
            label: 'Cost (USD)',
            data: res.data.trends.map(t => t.cost),
            borderColor: '#7cf0ff',
            yAxisID: 'y'
          },
          {
            label: 'Conversations',
            data: res.data.trends.map(t => t.conversations),
            borderColor: '#eeb0ff',
            yAxisID: 'y1'
          }
        ]
      },
      options: { /* dual-axis config */ }
    }
  );
}
```

### API Query
```
GET /api/analytics/costs
  ?from=2026-01-01T00:00:00Z
  &to=2026-01-08T00:00:00Z
  &groupBy=day|model|promptVersion
```

---

## Component 3: Cost Efficiency Table - HTML Only

```html
<div class="analytics-grid full">
    <div class="section-card">
        <div class="section-header">
            <h2><i class="fas fa-bars"></i> Cost Efficiency by Model</h2>
            <button id="efficiencyRefreshBtn" style="background: rgba(0,0,0,0.3); border: 1px solid var(--panel-border); border-radius: 6px; padding: 6px 12px; color: var(--text); font-size: 12px; cursor: pointer;">
                <i class="fas fa-sync-alt"></i> Refresh
            </button>
        </div>
        <div class="section-body">
            <div style="overflow-x: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead style="background: rgba(0,0,0,0.2); position: sticky; top: 0;">
                        <tr>
                            <th style="padding: 8px; text-align: left; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);">Model</th>
                            <th style="padding: 8px; text-align: right; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);">Total Cost</th>
                            <th style="padding: 8px; text-align: right; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);">Tokens</th>
                            <th style="padding: 8px; text-align: right; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);">$/1K Tokens</th>
                            <th style="padding: 8px; text-align: right; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);">Tokens/$</th>
                            <th style="padding: 8px; text-align: right; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);">Avg Cost/Conv</th>
                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);">Efficiency</th>
                        </tr>
                    </thead>
                    <tbody id="efficiencyTableBody">
                        <tr><td colspan="7" style="padding: 16px; text-align: center; color: var(--muted);">Loading...</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="chart-empty" id="efficiencyEmpty" style="display: none;">No data</div>
        </div>
    </div>
</div>
```

### JS: Elements
```javascript
efficiencyRefreshBtn: document.getElementById('efficiencyRefreshBtn'),
efficiencyTableBody: document.getElementById('efficiencyTableBody'),
efficiencyEmpty: document.getElementById('efficiencyEmpty'),
```

### JS: Refresh Function (Pseudo-code)
```javascript
async function refreshEfficiencyTable() {
  const res = await fetchJSON(
    `/api/analytics/costs?from=...&to=...&breakdown=model`
  );

  const sorted = res.data.efficiency.sort((a, b) =>
    a.costPer1kTokens - b.costPer1kTokens
  );

  elements.efficiencyTableBody.innerHTML = sorted.map((row, idx) => {
    const badge = idx === 0 ? 'Best ★' : idx === sorted.length - 1 ? 'Least Efficient' : `${idx}/${sorted.length}`;
    return `<tr>
      <td>${row.model}</td>
      <td style="text-align: right;">$${row.totalCost.toFixed(2)}</td>
      <td style="text-align: right;">${formatNumber(row.totalTokens)}</td>
      <td style="text-align: right;">$${row.costPer1kTokens.toFixed(4)}</td>
      <td style="text-align: right;"><strong>${Math.round(row.tokensPer Dollar)}</strong></td>
      <td style="text-align: right;">$${row.avgCostPerConversation.toFixed(3)}</td>
      <td style="text-align: center;"><span style="...color...">${badge}</span></td>
    </tr>`;
  }).join('');
}
```

---

## Component 4: Cost Breakdown Chart - HTML Only

```html
<div class="analytics-grid full">
    <div class="section-card">
        <div class="section-header">
            <h2><i class="fas fa-doughnut"></i> Cost Distribution by Model</h2>
            <div style="display: flex; gap: 8px; align-items: center;">
                <label style="font-size: 12px; color: var(--muted);">
                    <input type="checkbox" id="costBreakdownPie" checked>
                    Pie Chart
                </label>
                <label style="font-size: 12px; color: var(--muted);">
                    <input type="checkbox" id="costBreakdownDonut">
                    Donut Style
                </label>
            </div>
        </div>
        <div class="section-body">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                <div class="chart-container">
                    <canvas id="costBreakdownChart"></canvas>
                </div>
                <div id="costBreakdownStats" style="display: flex; flex-direction: column; gap: 8px;">
                    <!-- Populated by JS -->
                </div>
            </div>
            <div class="chart-empty" id="costBreakdownEmpty" style="display: none;">No data</div>
        </div>
    </div>
</div>
```

### JS: Elements & Charts
```javascript
costBreakdownPie: document.getElementById('costBreakdownPie'),
costBreakdownDonut: document.getElementById('costBreakdownDonut'),
costBreakdownStats: document.getElementById('costBreakdownStats'),
costBreakdownEmpty: document.getElementById('costBreakdownEmpty'),

// In charts object:
costBreakdown: null,
```

### JS: Refresh Function (Pseudo-code)
```javascript
async function refreshCostBreakdown() {
  const res = await fetchJSON(`/api/analytics/costs?...&breakdown=model`);

  if (charts.costBreakdown) charts.costBreakdown.destroy();

  const isDonut = elements.costBreakdownDonut.checked;

  charts.costBreakdown = new Chart(
    document.getElementById('costBreakdownChart').getContext('2d'),
    {
      type: isDonut ? 'doughnut' : 'pie',
      data: {
        labels: res.data.breakdown.map(b => b.model),
        datasets: [{
          data: res.data.breakdown.map(b => b.cost),
          backgroundColor: colorPalette.slice(0, res.data.breakdown.length)
        }]
      }
    }
  );

  // Populate sidebar with stat cards
  elements.costBreakdownStats.innerHTML = res.data.breakdown.map((item, idx) => `
    <div style="padding: 12px; background: rgba(255,255,255,0.02); border-left: 3px solid ${colors[idx]};">
      <div style="display: flex; justify-content: space-between;">
        <strong>${item.model}</strong>
        <span style="color: var(--accent);">$${item.cost.toFixed(2)}</span>
      </div>
      <div style="background: rgba(255,255,255,0.1); height: 4px; border-radius: 2px; margin: 8px 0;">
        <div style="height: 100%; width: ${item.percentage}%; background: ${colors[idx]};"></div>
      </div>
      <div style="font-size: 11px; color: var(--muted);">
        ${item.conversations} conversations, ${formatNumber(item.tokens)} tokens
      </div>
    </div>
  `).join('');
}
```

---

## Event Wiring

Add to initialization (e.g., after chart setup):

```javascript
elements.periodSelect.addEventListener('change', () => {
  refreshCostStats();
  refreshCostTrend();
  refreshEfficiencyTable();
  refreshCostBreakdown();
});

elements.refreshBtn.addEventListener('click', () => {
  refreshCostStats();
  refreshCostTrend();
  refreshEfficiencyTable();
  refreshCostBreakdown();
});

elements.costTrendGroupSelect.addEventListener('change', refreshCostTrend);
elements.efficiencyRefreshBtn.addEventListener('click', refreshEfficiencyTable);
elements.costBreakdownPie.addEventListener('change', refreshCostBreakdown);
elements.costBreakdownDonut.addEventListener('change', refreshCostBreakdown);
```

---

## Backend Endpoint Needed

```
GET /api/analytics/costs
Query params: from, to, groupBy, breakdown, model
Auth: Session or API key
Returns: { status, data: { totalCost, totalTokens, ... } }
```

**Implementation:**
- Calculate: `cost = (promptTokens * promptRate + completionTokens * completionRate) / 1000`
- Requires: Cost config model with pricing per model
- Uses: Existing Conversation.stats.usage data

---

## Color Palette

```javascript
const colorPalette = [
  'rgba(124, 240, 255, 0.8)',       // Cyan (--accent)
  'rgba(238, 176, 255, 0.8)',       // Purple (--accent-2)
  'rgba(74, 222, 128, 0.8)',        // Green
  'rgba(251, 191, 36, 0.8)',        // Yellow
  'rgba(59, 130, 246, 0.8)',        // Blue
  'rgba(168, 85, 247, 0.8)',        // Violet
  'rgba(236, 72, 153, 0.8)',        // Pink
  'rgba(249, 115, 22, 0.8)'         // Orange
];
```

---

## Files to Modify

1. `/public/analytics.html` - Add HTML for all 4 components
2. `/public/js/analytics.js` - Add JS functions and event listeners
3. `/routes/analytics.js` - Add new `/api/analytics/costs` endpoint
4. Create `/src/services/costService.js` - Cost calculation logic

---

## Key Points

- All 4 components use existing CSS classes (no new CSS needed)
- All metrics calculated from Conversation.stats.usage (already captured)
- Backend needs cost config model to calculate actual costs
- Placeholder: Currently `estimatedCost: 0` in `/routes/analytics.js` line 425
- Charts use Chart.js 4.4.4 (already loaded)
- Icons via Font Awesome 6.4.0 (already loaded)
- Dark theme with cyan/purple accents matching design system

