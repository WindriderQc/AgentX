# Cost Tracking UI Components - Design Specification

**Document Date:** 2026-01-01
**Version:** 1.0
**Status:** Design Phase (Ready for Implementation)

## Overview

This specification defines four cost tracking UI components to be added to the existing Analytics Dashboard (`/public/analytics.html`). These components will provide comprehensive visibility into API costs, token usage costs, and cost efficiency metrics across models and time periods.

**Note:** Current analytics.js contains a placeholder for estimated costs (`estimatedCost: { $literal: 0 }`) that will need to be connected to a real cost calculation service. This design accounts for future cost data integration.

---

## Architecture & Integration Points

### Data Sources

1. **Backend Endpoint (Existing):** `/api/analytics/stats`
   - Returns: `totalTokens`, `promptTokens`, `completionTokens`, `avgDurationSec`, breakdown by model
   - Current response includes placeholder `estimatedCost: 0`

2. **New Endpoint Needed:** `/api/analytics/costs`
   - Returns cost metrics grouped by model, date, and time period
   - Requires cost database (pricing model) configuration

3. **Cost Configuration Model** (to be created)
   - Pricing structure: Model → Price per 1K prompt tokens / completion tokens
   - Example: Ollama models (local) = $0, GPT-4 = $0.03/1K prompt, $0.06/1K completion

### Design System Consistency

All components follow existing AgentX patterns:
- **Color scheme:** Dark theme (CSS variables: `--accent: #7cf0ff`, `--accent-2: #eeb0ff`)
- **Component structure:** `.section-card` + `.section-header` + `.section-body`
- **Chart library:** Chart.js 4.4.4 (already loaded)
- **Icons:** Font Awesome 6.4.0 (already loaded)
- **Fonts:** Space Grotesk (already loaded)

---

## Component 1: Cost Stats Cards

### Purpose
Display key cost metrics at a glance for quick monitoring and trend awareness.

### Location in HTML
**Insert after:** Line 66 (after existing Quick Stats section)
**Insert before:** Line 110 (before Usage + Feedback Charts)

### HTML Structure

```html
<!-- Cost Stats Cards Section -->
<div class="cost-stats-row stats-row">
    <div class="stat-card" data-tooltip="Total spending across all conversations in the selected period">
        <div class="label">Total Cost</div>
        <div class="value" id="totalCost">—</div>
        <div class="sub">Period spend</div>
    </div>
    <div class="stat-card" data-tooltip="Average cost per conversation (total cost ÷ conversations)">
        <div class="label">Cost/Conversation</div>
        <div class="value" id="costPerConversation">—</div>
        <div class="sub">Average spend</div>
    </div>
    <div class="stat-card" data-tooltip="Cost per thousand tokens (total cost ÷ total tokens × 1000)">
        <div class="label">Cost/1K Tokens</div>
        <div class="value" id="costPer1kTokens">—</div>
        <div class="sub">Efficiency metric</div>
    </div>
    <div class="stat-card" data-tooltip="Number of tokens generated per dollar spent (total tokens ÷ total cost)">
        <div class="label">Tokens/Dollar</div>
        <div class="value" id="tokensPer Dollar">—</div>
        <div class="sub">Value metric</div>
    </div>
</div>
```

### Data Format Expected from API

```javascript
// From /api/analytics/costs endpoint (to be created)
{
  status: 'success',
  data: {
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-08T00:00:00Z',
    totalCost: 12.45,                    // USD
    totalTokens: 125000,                 // sum of all prompt + completion tokens
    conversations: 87,
    avgCostPerConversation: 0.143,       // totalCost / conversations
    costPer1kTokens: 0.0996,             // (totalCost / totalTokens) * 1000
    tokensPer Dollar: 10040.16,          // totalTokens / totalCost
    costTrend: {
      previousPeriod: 8.34,              // comparison for trend indicator
      delta: 4.11,
      percentChange: 49.3
    }
  }
}
```

### JavaScript Integration Points

**Add to `elements` object in `/public/js/analytics.js`:**

```javascript
// Cost Stats Elements
totalCost: document.getElementById('totalCost'),
costPerConversation: document.getElementById('costPerConversation'),
costPer1kTokens: document.getElementById('costPer1kTokens'),
tokensPer Dollar: document.getElementById('tokensPer Dollar'),
```

**Update function:** New `refreshCostStats()` function

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

### Styling

Reuse existing `.stat-card` styles from analytics.html (lines 46-66). No additional CSS needed.

### Tooltip Information

- **Total Cost:** Shows raw USD spending, useful for budgeting awareness
- **Cost/Conversation:** Helps identify if conversations are becoming more or less expensive
- **Cost/1K Tokens:** Industry-standard metric for comparing model efficiency
- **Tokens/Dollar:** Inverse metric showing value proposition (higher is better)

---

## Component 2: Cost Trend Chart

### Purpose
Visualize cost trends over time, showing spending patterns and enabling period-over-period comparison.

### Location in HTML
**Insert:** New row in analytics-grid after RAG Adoption section (after line 157)

### HTML Structure

```html
<!-- Cost Trends Section -->
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

### Data Format Expected from API

```javascript
// From /api/analytics/costs endpoint with groupBy parameter
{
  status: 'success',
  data: {
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-08T00:00:00Z',
    groupBy: 'day',  // 'day' | 'model' | 'promptVersion'
    trends: [
      {
        date: '2026-01-01',           // when groupBy='day'
        // OR
        model: 'qwen:14b',            // when groupBy='model'
        // OR
        promptName: 'default_chat',   // when groupBy='promptVersion'
        promptVersion: 3,

        // Always included:
        cost: 2.34,                   // USD for this period/group
        tokens: 23450,                // total tokens used
        conversations: 12,            // number of conversations
        avgCost: 0.195,               // cost per conversation
        costPer1k: 0.0998
      },
      // ... more rows
    ]
  }
}
```

### Chart.js Configuration

```javascript
const costTrendChart = new Chart(
  document.getElementById('costTrendChart').getContext('2d'),
  {
    type: 'line',
    data: {
      labels: ['2026-01-01', '2026-01-02', ...],  // dates OR model names
      datasets: [
        {
          label: 'Cost (USD)',
          data: [2.34, 2.87, 1.95, ...],
          borderColor: '#7cf0ff',                   // --accent
          backgroundColor: 'rgba(124, 240, 255, 0.05)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#7cf0ff',
          pointBorderColor: 'rgba(12, 15, 26, 0.8)',
          pointBorderWidth: 2,
          yAxisID: 'y'
        },
        {
          label: 'Conversations',           // secondary axis
          data: [12, 15, 8, ...],
          borderColor: '#eeb0ff',                   // --accent-2
          backgroundColor: 'rgba(238, 176, 255, 0.05)',
          borderWidth: 2,
          fill: false,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: '#eeb0ff',
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          labels: {
            color: 'var(--text)',
            font: { family: 'Space Grotesk', size: 12 },
            padding: 16
          },
          display: true,
          position: 'top'
        },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          titleColor: '#7cf0ff',
          bodyColor: 'var(--text)',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 10,
          displayColors: true,
          callbacks: {
            label: function(context) {
              if (context.dataset.yAxisID === 'y') {
                return context.dataset.label + ': $' + context.parsed.y.toFixed(2);
              }
              return context.dataset.label + ': ' + context.parsed.y + ' conversations';
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: 'rgba(255, 255, 255, 0.03)'
          },
          ticks: {
            color: 'var(--muted)',
            font: { size: 11 }
          }
        },
        y: {
          type: 'linear',
          position: 'left',
          title: {
            display: true,
            text: 'Cost (USD)',
            color: '#7cf0ff',
            font: { weight: 'bold', size: 12 }
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.03)'
          },
          ticks: {
            color: 'var(--muted)',
            font: { size: 11 },
            callback: function(value) {
              return '$' + value.toFixed(2);
            }
          }
        },
        y1: {
          type: 'linear',
          position: 'right',
          title: {
            display: true,
            text: 'Conversations',
            color: '#eeb0ff',
            font: { weight: 'bold', size: 12 }
          },
          grid: {
            drawOnChartArea: false
          },
          ticks: {
            color: 'var(--muted)',
            font: { size: 11 }
          }
        }
      }
    }
  }
);
```

### JavaScript Integration Points

**Add to `elements` object:**

```javascript
costTrendGroupSelect: document.getElementById('costTrendGroupSelect'),
costTrendEmpty: document.getElementById('costTrendEmpty'),
```

**Add to `charts` object:**

```javascript
costTrend: null,
```

**New function:**

```javascript
async function refreshCostTrend() {
  const { from, to } = periodRange(elements.periodSelect.value);
  const groupBy = elements.costTrendGroupSelect.value;

  try {
    const res = await fetchJSON(
      `/api/analytics/costs?from=${from.toISOString()}&to=${to.toISOString()}&groupBy=${groupBy}`
    );

    if (!res.data.trends || res.data.trends.length === 0) {
      if (charts.costTrend) charts.costTrend.destroy();
      elements.costTrendEmpty.style.display = 'block';
      return;
    }

    elements.costTrendEmpty.style.display = 'none';

    // Extract labels based on groupBy
    let labels = res.data.trends.map(item => {
      if (groupBy === 'day') return item.date;
      if (groupBy === 'model') return item.model;
      if (groupBy === 'promptVersion')
        return `${item.promptName} v${item.promptVersion}`;
      return '';
    });

    const costData = res.data.trends.map(item => item.cost);
    const conversationData = res.data.trends.map(item => item.conversations);

    // Recreate chart
    if (charts.costTrend) charts.costTrend.destroy();

    charts.costTrend = new Chart(
      document.getElementById('costTrendChart').getContext('2d'),
      {
        // ... (config as above, with data populated)
      }
    );
  } catch (err) {
    logger.error('Cost trend error', err);
  }
}
```

**Event listeners:**

```javascript
elements.periodSelect.addEventListener('change', refreshCostTrend);
elements.costTrendGroupSelect.addEventListener('change', refreshCostTrend);
```

### Styling

Reuse existing `.chart-container` and `.chart-empty` styles. No additional CSS needed.

### Tooltip Information

- Chart shows dual axes: Cost (USD) on left, Conversation count on right
- Useful for identifying peak usage periods and cost spikes
- By-model grouping reveals which models are most expensive
- By-prompt grouping shows if specific prompt versions drive costs

---

## Component 3: Cost Efficiency Table

### Purpose
Compare cost-per-token and tokens-per-dollar metrics across models for data-driven model selection.

### Location in HTML
**Insert:** New row in analytics-grid after Cost Trends (after Component 2)

### HTML Structure

```html
<!-- Cost Efficiency Table Section -->
<div class="analytics-grid full">
    <div class="section-card">
        <div class="section-header">
            <h2><i class="fas fa-bars"></i> Cost Efficiency by Model</h2>
            <div style="display: flex; gap: 8px;">
                <button id="efficiencyRefreshBtn" style="background: rgba(0,0,0,0.3); border: 1px solid var(--panel-border); border-radius: 6px; padding: 6px 12px; color: var(--text); font-size: 12px; cursor: pointer;">
                    <i class="fas fa-sync-alt"></i> Refresh
                </button>
            </div>
        </div>
        <div class="section-body">
            <div style="overflow-x: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead style="background: rgba(0,0,0,0.2); position: sticky; top: 0;">
                        <tr>
                            <th style="padding: 8px; text-align: left; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);">Model</th>
                            <th style="padding: 8px; text-align: right; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);" data-tooltip="Total USD spent on this model">
                                Total Cost
                            </th>
                            <th style="padding: 8px; text-align: right; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);" data-tooltip="Total tokens (prompt + completion) used">
                                Tokens
                            </th>
                            <th style="padding: 8px; text-align: right; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);" data-tooltip="USD per thousand tokens used">
                                $/1K Tokens
                            </th>
                            <th style="padding: 8px; text-align: right; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);" data-tooltip="Number of tokens per dollar spent">
                                Tokens/$
                            </th>
                            <th style="padding: 8px; text-align: right; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);" data-tooltip="Average cost per conversation">
                                Avg Cost/Conv
                            </th>
                            <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--panel-border); font-weight: 600; color: var(--text);" data-tooltip="Cost efficiency indicator: higher is better">
                                Efficiency
                            </th>
                        </tr>
                    </thead>
                    <tbody id="efficiencyTableBody">
                        <tr>
                            <td colspan="7" style="padding: 16px; text-align: center; color: var(--muted);">
                                Loading...
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div class="chart-empty" id="efficiencyEmpty" style="display: none;">
                No cost efficiency data available.
            </div>
        </div>
    </div>
</div>
```

### Data Format Expected from API

```javascript
// From /api/analytics/costs endpoint with breakdown by model
{
  status: 'success',
  data: {
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-08T00:00:00Z',
    efficiency: [
      {
        model: 'qwen:14b',
        totalCost: 4.23,
        totalTokens: 45000,
        promptTokens: 15000,
        completionTokens: 30000,
        conversations: 22,
        costPer1kTokens: 0.0940,
        tokensPer Dollar: 10638.30,
        avgCostPerConversation: 0.192,
        rank: 1,                      // 1 = most efficient (lowest cost)
        percentBetter: 15.3            // % better than next model
      },
      // ... more models
    ]
  }
}
```

### Table Row Structure (HTML Template)

Each row represents one model:

```html
<tr style="border-bottom: 1px solid var(--panel-border); transition: background 0.2s; hover: background: rgba(255, 255, 255, 0.02);">
    <td style="padding: 8px; color: var(--text); font-weight: 500;">
        <i class="fas fa-cube" style="color: var(--accent); margin-right: 6px; font-size: 11px;"></i>
        qwen:14b
    </td>
    <td style="padding: 8px; text-align: right; color: var(--accent);">
        <strong>$4.23</strong>
    </td>
    <td style="padding: 8px; text-align: right; color: var(--text);">
        45,000
    </td>
    <td style="padding: 8px; text-align: right; color: var(--text);">
        $0.0940
    </td>
    <td style="padding: 8px; text-align: right; color: #4ade80;">
        <strong>10,638</strong>
    </td>
    <td style="padding: 8px; text-align: right; color: var(--text);">
        $0.192
    </td>
    <td style="padding: 8px; text-align: center;">
        <span style="background: rgba(76, 222, 128, 0.2); color: #4ade80; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600;">
            Best ★
        </span>
    </td>
</tr>
```

### JavaScript Integration Points

**Add to `elements` object:**

```javascript
efficiencyRefreshBtn: document.getElementById('efficiencyRefreshBtn'),
efficiencyTableBody: document.getElementById('efficiencyTableBody'),
efficiencyEmpty: document.getElementById('efficiencyEmpty'),
```

**New function:**

```javascript
async function refreshEfficiencyTable() {
  const { from, to } = periodRange(elements.periodSelect.value);

  try {
    const res = await fetchJSON(
      `/api/analytics/costs?from=${from.toISOString()}&to=${to.toISOString()}&breakdown=model`
    );

    if (!res.data.efficiency || res.data.efficiency.length === 0) {
      elements.efficiencyEmpty.style.display = 'block';
      elements.efficiencyTableBody.innerHTML =
        '<tr><td colspan="7" style="padding: 16px; text-align: center; color: var(--muted);">No data</td></tr>';
      return;
    }

    elements.efficiencyEmpty.style.display = 'none';

    // Sort by efficiency (ascending cost per 1k tokens)
    const sorted = res.data.efficiency.sort((a, b) =>
      a.costPer1kTokens - b.costPer1kTokens
    );

    // Create rows
    elements.efficiencyTableBody.innerHTML = sorted.map((row, idx) => {
      const efficiencyLabel = idx === 0 ? 'Best ★' :
                              idx === sorted.length - 1 ? 'Least Efficient' :
                              `${idx}/${sorted.length}`;
      const efficiencyColor = idx === 0 ? '#4ade80' :
                              idx === sorted.length - 1 ? '#f87171' :
                              '#fbbf24';

      return `
        <tr style="border-bottom: 1px solid var(--panel-border); transition: background 0.2s;">
          <td style="padding: 8px; color: var(--text); font-weight: 500;">
            <i class="fas fa-cube" style="color: var(--accent); margin-right: 6px; font-size: 11px;"></i>
            ${row.model}
          </td>
          <td style="padding: 8px; text-align: right; color: var(--accent);">
            <strong>$${row.totalCost.toFixed(2)}</strong>
          </td>
          <td style="padding: 8px; text-align: right; color: var(--text);">
            ${formatNumber(row.totalTokens)}
          </td>
          <td style="padding: 8px; text-align: right; color: var(--text);">
            $${row.costPer1kTokens.toFixed(4)}
          </td>
          <td style="padding: 8px; text-align: right; color: #4ade80;">
            <strong>${Math.round(row.tokensPer Dollar).toLocaleString()}</strong>
          </td>
          <td style="padding: 8px; text-align: right; color: var(--text);">
            $${row.avgCostPerConversation.toFixed(3)}
          </td>
          <td style="padding: 8px; text-align: center;">
            <span style="background: rgba(${efficiencyColor === '#4ade80' ? '76, 222, 128' : efficiencyColor === '#f87171' ? '248, 113, 113' : '251, 191, 36'}, 0.2); color: ${efficiencyColor}; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600;">
              ${efficiencyLabel}
            </span>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    logger.error('Efficiency table error', err);
    elements.efficiencyTableBody.innerHTML =
      '<tr><td colspan="7" style="padding: 16px; text-align: center; color: #f87171;">Error loading data</td></tr>';
  }
}
```

**Event listeners:**

```javascript
elements.periodSelect.addEventListener('change', refreshEfficiencyTable);
elements.efficiencyRefreshBtn.addEventListener('click', refreshEfficiencyTable);
```

### Styling

**Add custom CSS for table hover and badge effects:**

```css
/* In styles.css or analytics-specific stylesheet */

.efficiency-table tbody tr:hover {
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
}

.efficiency-badge {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.efficiency-badge.best {
  background: rgba(76, 222, 128, 0.2);
  color: #4ade80;
}

.efficiency-badge.good {
  background: rgba(59, 130, 246, 0.2);
  color: #3b82f6;
}

.efficiency-badge.fair {
  background: rgba(251, 191, 36, 0.2);
  color: #fbbf24;
}

.efficiency-badge.poor {
  background: rgba(248, 113, 113, 0.2);
  color: #f87171;
}
```

---

## Component 4: Cost Breakdown Chart

### Purpose
Show cost distribution across models (pie/donut chart) and enable quick identification of which models consume the most budget.

### Location in HTML
**Insert:** New grid row after Cost Efficiency Table (after Component 3)

### HTML Structure

```html
<!-- Cost Breakdown Section -->
<div class="analytics-grid full">
    <div class="section-card">
        <div class="section-header">
            <h2><i class="fas fa-doughnut"></i> Cost Distribution by Model</h2>
            <div style="display: flex; gap: 8px; align-items: center;">
                <label style="font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px;">
                    <input type="checkbox" id="costBreakdownPie" checked style="cursor: pointer;">
                    Pie Chart
                </label>
                <label style="font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px;">
                    <input type="checkbox" id="costBreakdownDonut" style="cursor: pointer;">
                    Donut Style
                </label>
            </div>
        </div>
        <div class="section-body">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start;">
                <div style="position: relative;">
                    <div class="chart-container" style="position: relative; height: 300px;">
                        <canvas id="costBreakdownChart"></canvas>
                    </div>
                    <div id="costBreakdownLegend" style="display: none;">
                        <!-- Legend populated by JS -->
                    </div>
                </div>
                <div id="costBreakdownStats" style="display: flex; flex-direction: column; gap: 8px;">
                    <!-- Stats populated by JS -->
                </div>
            </div>
            <div class="chart-empty" id="costBreakdownEmpty" style="display: none;">
                No cost breakdown data available.
            </div>
        </div>
    </div>
</div>
```

### Data Format Expected from API

```javascript
// From /api/analytics/costs endpoint with breakdown by model
{
  status: 'success',
  data: {
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-08T00:00:00Z',
    breakdown: [
      {
        model: 'qwen:14b',
        cost: 4.23,
        percentage: 34.0,
        conversations: 22,
        tokens: 45000,
        color: '#7cf0ff'        // optional, can auto-generate
      },
      {
        model: 'llama2:7b',
        cost: 3.12,
        percentage: 25.0,
        conversations: 18,
        tokens: 32000,
        color: '#eeb0ff'
      },
      {
        model: 'dolphin-mixtral:8x7b',
        cost: 2.87,
        percentage: 23.0,
        conversations: 15,
        tokens: 28000,
        color: '#4ade80'
      },
      {
        model: 'neural-chat:7b',
        cost: 2.23,
        percentage: 18.0,
        conversations: 12,
        tokens: 20000,
        color: '#fbbf24'
      }
    ],
    totalCost: 12.45,
    totalConversations: 87,
    totalTokens: 125000
  }
}
```

### Chart.js Configuration

```javascript
const costBreakdownChart = new Chart(
  document.getElementById('costBreakdownChart').getContext('2d'),
  {
    type: 'doughnut',  // 'pie' or 'doughnut' based on checkbox
    data: {
      labels: ['qwen:14b', 'llama2:7b', 'dolphin-mixtral:8x7b', 'neural-chat:7b'],
      datasets: [{
        data: [4.23, 3.12, 2.87, 2.23],           // cost values
        backgroundColor: [
          'rgba(124, 240, 255, 0.8)',             // --accent
          'rgba(238, 176, 255, 0.8)',             // --accent-2
          'rgba(74, 222, 128, 0.8)',              // green
          'rgba(251, 191, 36, 0.8)'               // yellow
        ],
        borderColor: 'rgba(12, 15, 26, 0.8)',     // --bg
        borderWidth: 2,
        hoverOffset: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: false  // We'll use custom legend below chart
        },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          titleColor: '#7cf0ff',
          bodyColor: 'var(--text)',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: function(context) {
              const value = context.parsed;
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const percentage = ((value / total) * 100).toFixed(1);
              return `$${value.toFixed(2)} (${percentage}%)`;
            }
          }
        }
      }
    }
  }
);
```

### JavaScript Integration Points

**Add to `elements` object:**

```javascript
costBreakdownPie: document.getElementById('costBreakdownPie'),
costBreakdownDonut: document.getElementById('costBreakdownDonut'),
costBreakdownStats: document.getElementById('costBreakdownStats'),
costBreakdownEmpty: document.getElementById('costBreakdownEmpty'),
```

**Add to `charts` object:**

```javascript
costBreakdown: null,
```

**New function:**

```javascript
async function refreshCostBreakdown() {
  const { from, to } = periodRange(elements.periodSelect.value);

  try {
    const res = await fetchJSON(
      `/api/analytics/costs?from=${from.toISOString()}&to=${to.toISOString()}&breakdown=model`
    );

    if (!res.data.breakdown || res.data.breakdown.length === 0) {
      if (charts.costBreakdown) charts.costBreakdown.destroy();
      elements.costBreakdownEmpty.style.display = 'block';
      return;
    }

    elements.costBreakdownEmpty.style.display = 'none';

    // Generate colors if not provided
    const colors = [
      'rgba(124, 240, 255, 0.8)',
      'rgba(238, 176, 255, 0.8)',
      'rgba(74, 222, 128, 0.8)',
      'rgba(251, 191, 36, 0.8)',
      'rgba(59, 130, 246, 0.8)',
      'rgba(168, 85, 247, 0.8)',
      'rgba(236, 72, 153, 0.8)',
      'rgba(249, 115, 22, 0.8)'
    ];

    // Create chart
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
            backgroundColor: res.data.breakdown.map((_, i) => colors[i % colors.length]),
            borderColor: 'rgba(12, 15, 26, 0.8)',
            borderWidth: 2,
            hoverOffset: 4
          }]
        },
        options: {
          // ... (config as above)
        }
      }
    );

    // Populate stats panel
    elements.costBreakdownStats.innerHTML = res.data.breakdown
      .sort((a, b) => b.cost - a.cost)
      .map((item, idx) => {
        const color = colors[idx % colors.length];
        return `
          <div style="padding: 12px; background: rgba(255, 255, 255, 0.02); border-left: 3px solid ${color}; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">
              <strong style="color: var(--text);">${item.model}</strong>
              <span style="color: var(--accent); font-weight: 600;">$${item.cost.toFixed(2)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
              <div style="flex: 1;">
                <div style="height: 4px; background: rgba(255, 255, 255, 0.1); border-radius: 2px; overflow: hidden;">
                  <div style="height: 100%; width: ${item.percentage}%; background: ${color}; transition: width 0.3s;"></div>
                </div>
              </div>
              <span style="font-size: 11px; color: var(--muted); white-space: nowrap;">
                ${item.percentage.toFixed(1)}%
              </span>
            </div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 6px; display: flex; justify-content: space-between;">
              <span>${item.conversations} conversations</span>
              <span>${formatNumber(item.tokens)} tokens</span>
            </div>
          </div>
        `;
      }).join('');
  } catch (err) {
    logger.error('Cost breakdown error', err);
  }
}
```

**Event listeners:**

```javascript
elements.periodSelect.addEventListener('change', refreshCostBreakdown);
elements.costBreakdownPie.addEventListener('change', refreshCostBreakdown);
elements.costBreakdownDonut.addEventListener('change', refreshCostBreakdown);
```

### Styling

No additional CSS needed. Reuse existing chart container styles.

---

## API Endpoint Specification: `/api/analytics/costs`

This endpoint does not currently exist and must be created. It should support the data requirements for all four cost tracking components.

### Endpoint Signature

```
GET /api/analytics/costs
```

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from` | ISO 8601 date | 7 days ago | Start of date range |
| `to` | ISO 8601 date | now | End of date range |
| `groupBy` | string | — | Optional: `'day'`, `'model'`, or `'promptVersion'` |
| `breakdown` | string | — | Optional: `'model'` for efficiency metrics |
| `model` | string | — | Optional: Filter by specific model |

### Authentication

Required: API key or session auth (via existing middleware)

### Response Format

Base response (no groupBy/breakdown):

```javascript
{
  status: 'success',
  data: {
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-08T00:00:00Z',
    // Component 1: Cost Stats
    totalCost: 12.45,
    totalTokens: 125000,
    promptTokens: 40000,
    completionTokens: 85000,
    conversations: 87,
    avgCostPerConversation: 0.143,
    costPer1kTokens: 0.0996,
    tokensPer Dollar: 10040.16,
    costTrend: {
      previousPeriod: 8.34,
      delta: 4.11,
      percentChange: 49.3
    }
  }
}
```

With `groupBy=day`:

```javascript
{
  // ... base fields
  trends: [
    {
      date: '2026-01-01',
      cost: 2.34,
      tokens: 23450,
      conversations: 12,
      avgCost: 0.195,
      costPer1k: 0.0998
    },
    // ... more days
  ]
}
```

With `breakdown=model`:

```javascript
{
  // ... base fields
  efficiency: [
    {
      model: 'qwen:14b',
      totalCost: 4.23,
      totalTokens: 45000,
      promptTokens: 15000,
      completionTokens: 30000,
      conversations: 22,
      costPer1kTokens: 0.0940,
      tokensPer Dollar: 10638.30,
      avgCostPerConversation: 0.192
    },
    // ... more models
  ],
  breakdown: [  // For pie chart
    {
      model: 'qwen:14b',
      cost: 4.23,
      percentage: 34.0,
      conversations: 22,
      tokens: 45000
    },
    // ... more models
  ]
}
```

### Implementation Notes

1. **Cost Calculation:** Requires a cost configuration model/service:
   - Map models → pricing tiers
   - Calculate: `cost = (promptTokens * promptPrice + completionTokens * completionPrice) / 1000`

2. **Caching:** Consider caching daily cost calculations (expensive aggregations)

3. **Error Handling:** Return 400 if invalid date range or 500 if cost config missing

4. **Performance:** Index queries by model, date, createdAt for fast aggregations

---

## Integration Checklist

### Phase 1: Backend Development

- [ ] Create cost configuration model (pricing by model)
- [ ] Implement `/api/analytics/costs` endpoint
- [ ] Add tests for cost calculations
- [ ] Validate against existing token data in Conversation model

### Phase 2: Frontend - Cost Stats Cards

- [ ] Add HTML elements (Component 1)
- [ ] Add to elements object in analytics.js
- [ ] Implement refreshCostStats() function
- [ ] Wire up period select event listener
- [ ] Test with mock data

### Phase 3: Frontend - Cost Trend Chart

- [ ] Add HTML elements (Component 2)
- [ ] Add Chart.js instance to charts object
- [ ] Implement refreshCostTrend() function with all groupBy variants
- [ ] Test dual-axis chart rendering
- [ ] Verify tooltip formatting

### Phase 4: Frontend - Cost Efficiency Table

- [ ] Add HTML elements (Component 3)
- [ ] Implement refreshEfficiencyTable() function with row generation
- [ ] Add efficiency badge color coding
- [ ] Test table sorting and hover states
- [ ] Validate responsive overflow handling

### Phase 5: Frontend - Cost Breakdown Chart

- [ ] Add HTML elements (Component 4)
- [ ] Implement refreshCostBreakdown() with pie/donut toggle
- [ ] Create stats panel with progress bars
- [ ] Test chart type switching
- [ ] Validate color assignment for many models

### Phase 6: Testing & Refinement

- [ ] Integration tests for all endpoints
- [ ] Load test cost calculations with large datasets
- [ ] UI/UX testing with real cost data
- [ ] Documentation updates
- [ ] Performance optimization if needed

---

## Visual Layout

```
┌─ Analytics Page ────────────────────────────────────────────┐
│                                                             │
│  Header: AgentX Analytics | [Period] [Refresh]            │
│                                                             │
│  ┌─ Quick Stats ────────────────────────────────────────┐  │
│  │ [Conversations] [Messages] [Feedback] [RAG Usage]   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ COST STATS CARDS (New) ────────────────────────────┐  │
│  │ [Total Cost] [Cost/Conv] [Cost/1K Tokens] [Token/$] │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Usage Trends ──┐  ┌─ RAG Adoption ──────────────────┐  │
│  │  [Chart]        │  │ [Donut] [Stats]                │  │
│  └─────────────────┘  └─────────────────────────────────┘  │
│                                                             │
│  ┌─ Feedback Distribution ─────────────────────────────┐  │
│  │ [Bar Chart by Model/Prompt]                         │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ COST TRENDS CHART (New) ───────────────────────────┐  │
│  │ [Dual-Axis Line Chart] [By Day/Model/Prompt Select] │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ COST EFFICIENCY TABLE (New) ───────────────────────┐  │
│  │ Model │ Total │ Tokens │ $/1K │ Tokens/$ │ Avg │ ★ │  │
│  │  ...  │  ...  │  ...   │ ...  │   ...    │ ... │ ... │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ COST BREAKDOWN (New) ──────────────────────────────┐  │
│  │  [Donut Chart] │ ┌─ Cost Stats Sidebar ────────┐   │  │
│  │                │ │ Model 1: $X.XX (%)  [Bar]   │   │  │
│  │                │ │ Model 2: $Y.YY (%)  [Bar]   │   │  │
│  │                │ │ Model 3: $Z.ZZ (%)  [Bar]   │   │  │
│  │                │ └─────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ RAG Metrics ──────────────────────────────────────┐  │
│  │ [Existing metrics...]                               │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Color Palette

All colors use existing CSS variables from AgentX design system:

| Color | Variable | Use |
|-------|----------|-----|
| Cyan | `--accent: #7cf0ff` | Primary metrics, charts line 1 |
| Purple | `--accent-2: #eeb0ff` | Secondary metrics, charts line 2 |
| Green | (no var) `#4ade80` | Positive/efficient indicators |
| Yellow | (no var) `#fbbf24` | Warning/fair performance |
| Red | (no var) `#f87171` | Negative/inefficient indicators |
| Text | `--text: #e8edf5` | Primary text |
| Muted | `--muted: #93a0b5` | Secondary text |
| Panel | `--panel: rgba(18, 23, 38, 0.78)` | Card backgrounds |

---

## Performance Considerations

1. **Data Aggregation:** Cost calculations involve multiple aggregations across messages
   - Consider caching daily cost summaries
   - Use MongoDB indexes on `model`, `createdAt`, `promptName`

2. **Chart Rendering:** Multiple Chart.js instances on single page
   - Destroy and recreate rather than update() to avoid memory leaks
   - Lazy-load charts if page becomes sluggish

3. **Table Rendering:** Large models list
   - Implement pagination if >20 models
   - Use virtual scrolling for very large datasets

4. **API Calls:** Refresh all components on period change
   - Batch requests if possible
   - Add loading indicators during fetch

---

## Future Enhancements

1. **Cost Forecasting:** Use historical data to predict next period costs
2. **Budget Alerts:** Notify when spending exceeds threshold
3. **Cost Optimization Suggestions:** Recommend cheaper models based on performance
4. **Cost Attribution:** Track costs by user or conversation type
5. **Export:** CSV/JSON export of cost reports
6. **Cost Comparison:** A/B test cost impact of prompt changes
7. **Real-time Tracking:** WebSocket updates for live cost monitoring
8. **Cost Anomaly Detection:** Flag unusual cost spikes automatically

---

## Notes for Developers

1. **No Breaking Changes:** All components use existing HTML structure patterns
2. **Graceful Degradation:** If cost endpoint unavailable, components show "No data"
3. **Tooltip Support:** All metrics have data-tooltip attributes for help text
4. **Accessibility:** Use semantic HTML, proper ARIA labels where needed
5. **Mobile:** Tables will scroll horizontally, charts remain responsive

