# Custom Dashboards - Next Steps & Enhancement Roadmap

**Status:** ✅ Core implementation complete (Week 4 Day 4)
**Tests:** 3/3 passing
**Documentation:** CUSTOM_DASHBOARDS_COMPLETE.md

## Current Implementation ✅

| Component | Status | File |
|-----------|--------|------|
| Backend Model | ✅ Complete | `models/CustomDashboard.js` |
| API Routes | ✅ Complete | `routes/dashboards.js` |
| Frontend UI | ✅ Complete | `public/custom-dashboard.html` |
| Widget Engine | ✅ Complete | `public/js/dashboard-builder.js` |
| Navigation | ✅ Integrated | Updated `nav.js` |
| Tests | ✅ Passing | `tests/integration/dashboard.integration.test.js` |

**Features Working:**
- Dashboard CRUD (create, read, update, delete)
- Workspace scoping (data isolation)
- Widget types: `metric` (counts), `chart` (line/bar)
- Data sources: `conversations`, `prompts`, `alerts`
- Security: Owner-based access control

## Priority 1: Enhanced Widget Library

### 1.1 Add Table Widget
**Purpose:** Display tabular data (e.g., recent conversations, top prompts)

**Implementation:**
```javascript
// In dashboard-builder.js
function renderTableWidget(container, config) {
  const { dataSource, columns, limit = 10 } = config;

  // Fetch data from API
  const data = await fetchWidgetData({
    type: 'table',
    source: dataSource,
    limit
  });

  // Render table with pagination
  const table = createTable(data, columns);
  container.appendChild(table);
}
```

**API Enhancement (routes/dashboards.js):**
```javascript
case 'table':
  // Return array of documents with specified fields
  const docs = await db.collection(dataSource)
    .find(filters)
    .sort({ createdAt: -1 })
    .limit(config.limit || 10)
    .project(config.columns)
    .toArray();
  return docs;
```

**Effort:** 1 day

### 1.2 Add Heatmap Widget
**Purpose:** Show activity patterns (e.g., conversations by day/hour)

**Implementation:**
```javascript
// Heatmap aggregation
const heatmapData = await db.collection('conversations')
  .aggregate([
    { $match: filters },
    {
      $group: {
        _id: {
          day: { $dayOfWeek: '$createdAt' },
          hour: { $hour: '$createdAt' }
        },
        count: { $sum: 1 }
      }
    }
  ]).toArray();
```

**Frontend:** Use library like `cal-heatmap` or Chart.js matrix

**Effort:** 2 days

### 1.3 Add Pie/Donut Chart Widget
**Purpose:** Show distribution (e.g., conversations by model, alerts by severity)

**Effort:** 1 day

## Priority 2: Advanced Layout & UX

### 2.1 Drag-and-Drop Grid Layout
**Current:** Static grid positions
**Target:** User can drag/resize widgets

**Recommended Library:** [GridStack.js](https://gridstackjs.com/)

**Implementation:**
```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/gridstack@latest/dist/gridstack.min.css" />
<script src="https://cdn.jsdelivr.net/npm/gridstack@latest/dist/gridstack-all.js"></script>
```

```javascript
// Initialize grid
const grid = GridStack.init({
  cellHeight: 80,
  verticalMargin: 10,
  animate: true
});

// Save layout on change
grid.on('change', (event, items) => {
  const layout = items.map(item => ({
    widgetId: item.id,
    x: item.x,
    y: item.y,
    width: item.w,
    height: item.h
  }));

  saveDashboardLayout(dashboardId, layout);
});
```

**Effort:** 2-3 days

### 2.2 Widget Configuration Modal
**Current:** Config in JSON
**Target:** Visual form for widget settings

**Features:**
- Data source dropdown
- Chart type selector
- Date range picker
- Filter builder
- Preview button

**Effort:** 3-4 days

## Priority 3: Sharing & Collaboration

### 3.1 Public Dashboard Links
**Purpose:** Share dashboards with external users (no login required)

**Architecture:**
```javascript
// Backend: Generate share token
POST /api/dashboards/:id/share
{
  "expiresIn": "30d",  // Optional expiration
  "allowedDomains": ["*.example.com"]  // Optional domain restriction
}

// Response
{
  "shareUrl": "https://agentx.local/d/abc123...",
  "token": "abc123...",
  "expiresAt": "2026-02-06T00:00:00Z"
}

// Public route (no auth required)
GET /d/:token
  - Validate token (not expired, not revoked)
  - Return dashboard config + read-only data
  - No edit capabilities
```

**Security:**
- Rate limit public endpoints
- Log access for audit
- Allow token revocation
- Optional password protection

**Effort:** 3-4 days

### 3.2 Dashboard Templates
**Purpose:** Pre-built dashboards for common use cases

**Templates:**
1. **Workspace Overview** - Conversations, models, prompts summary
2. **Alert Monitoring** - Active alerts, alert trends, MTTR
3. **Model Performance** - Response times, throughput, cost per model
4. **User Activity** - Active users, conversation volume, feedback rates

**Implementation:**
```javascript
// Seed templates
const templates = [
  {
    name: 'Workspace Overview',
    description: 'High-level workspace metrics',
    layout: [
      { type: 'metric', source: 'conversations', aggregation: 'count', x: 0, y: 0 },
      { type: 'chart', source: 'conversations', groupBy: 'date', x: 0, y: 1 }
    ]
  }
];

// API endpoint
GET /api/dashboards/templates
POST /api/dashboards/from-template/:templateId
```

**Effort:** 2 days

## Priority 4: Data & Filtering

### 4.1 Advanced Filters
**Current:** Basic time range
**Target:** Complex filter builder

**Features:**
- Multiple conditions (AND/OR)
- Field-specific filters (model, user, status)
- Saved filter sets
- Filter presets (Today, This Week, Last 30 Days)

**Effort:** 3-4 days

### 4.2 Real-time Data Updates
**Current:** Manual refresh
**Target:** Auto-refresh with WebSocket/SSE

**Implementation:**
```javascript
// Option 1: Polling (simple)
setInterval(() => {
  refreshDashboard();
}, 30000); // 30 seconds

// Option 2: Server-Sent Events (better)
const eventSource = new EventSource('/api/dashboards/stream');
eventSource.onmessage = (event) => {
  const update = JSON.parse(event.data);
  updateWidget(update.widgetId, update.data);
};
```

**Effort:** 2-3 days

### 4.3 Data Export
**Purpose:** Export dashboard data to CSV/PDF

**Implementation:**
```javascript
// Export to CSV
GET /api/dashboards/:id/export?format=csv

// Export to PDF (use puppeteer)
GET /api/dashboards/:id/export?format=pdf
```

**Effort:** 2 days

## Priority 5: Integration & Extensibility

### 5.1 Webhook Widgets
**Purpose:** Display data from external sources

**Architecture:**
```javascript
// User configures webhook
{
  type: 'webhook',
  url: 'https://external-api.com/metrics',
  method: 'GET',
  headers: { 'Authorization': 'Bearer ...' },
  transformResponse: 'data => data.metrics.total' // Optional JS transform
}

// Backend fetches and caches data
const response = await fetch(config.url, {
  method: config.method,
  headers: config.headers
});
const data = await response.json();
```

**Security:**
- Whitelist allowed domains
- Rate limit external requests
- Cache responses (TTL)

**Effort:** 3-4 days

### 5.2 Custom Queries (SQL/NoSQL)
**Purpose:** Advanced users write custom aggregations

**Implementation:**
```javascript
{
  type: 'custom',
  query: {
    collection: 'conversations',
    pipeline: [
      { $match: { createdAt: { $gte: new Date('2026-01-01') } } },
      { $group: { _id: '$model', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]
  }
}
```

**Security:**
- Validate pipeline stages (no $out, $merge)
- Read-only operations
- Timeout limits
- Admin-only feature

**Effort:** 2-3 days

## Testing Checklist

### Unit Tests
- [ ] Widget data aggregation functions
- [ ] Layout validation
- [ ] Filter parsing
- [ ] Share token generation

### Integration Tests
- [x] Dashboard CRUD (3/3 passing) ✓
- [ ] Widget data fetching (all types)
- [ ] Public share links
- [ ] Permission enforcement

### E2E Tests
- [ ] Create dashboard and add widgets
- [ ] Drag-and-drop layout
- [ ] Share dashboard publicly
- [ ] Export to CSV/PDF

## Documentation Updates Needed

1. **User Manual**
   - How to create custom dashboards
   - Widget configuration guide
   - Sharing dashboards

2. **API Reference**
   - Dashboard endpoints
   - Widget data format
   - Filter syntax

3. **Developer Guide**
   - Adding new widget types
   - Custom data sources
   - Extending aggregations

## Immediate Recommended Next Steps

### Phase 1: Core Enhancements (Week 5)
1. ✅ Verify current implementation (DONE - tests passing)
2. Add table widget (1 day)
3. Add pie chart widget (1 day)
4. Implement GridStack.js for drag-and-drop (2-3 days)

**Total:** 4-5 days

### Phase 2: Sharing & Polish (Week 6)
1. Public dashboard links (3-4 days)
2. Dashboard templates (2 days)
3. Export to CSV (1 day)
4. Documentation (1 day)

**Total:** 7-9 days

### Phase 3: Advanced Features (Week 7+)
1. Real-time updates (2-3 days)
2. Advanced filters (3-4 days)
3. Webhook widgets (3-4 days)
4. Custom queries (2-3 days)

**Total:** 10-14 days

## Integration with Existing Features

### Workspace Isolation ✅
- Dashboards already scoped to `workspaceId`
- Access control via `createdBy` check
- **Recommendation:** Add role-based access (view vs edit)

### Alert Integration ⚠️
- Currently supports `alerts` as data source
- **Recommendation:** Add alert trend widgets to default template

### RAG Metrics ⚠️
- Not yet integrated
- **Recommendation:** Add RAG widget type (document count, search performance)

### Model Registry ⚠️
- Not yet integrated
- **Recommendation:** Add model performance widget (latency, throughput by model)

## Configuration Examples

### Metric Widget (Conversation Count)
```json
{
  "type": "metric",
  "title": "Total Conversations",
  "dataSource": "conversations",
  "aggregation": "count",
  "filters": {
    "createdAt": { "$gte": "{{startOfMonth}}" }
  },
  "format": "number"
}
```

### Chart Widget (Conversations Over Time)
```json
{
  "type": "chart",
  "title": "Conversations This Month",
  "dataSource": "conversations",
  "chartType": "line",
  "groupBy": "day",
  "aggregation": "count",
  "filters": {
    "createdAt": { "$gte": "{{startOfMonth}}" }
  }
}
```

### Table Widget (Recent Alerts)
```json
{
  "type": "table",
  "title": "Recent Alerts",
  "dataSource": "alerts",
  "columns": ["title", "severity", "status", "createdAt"],
  "limit": 10,
  "sort": { "createdAt": -1 }
}
```

## Questions for Product Direction

1. **Target Users:** Who primarily creates dashboards? Workspace admins or all members?
2. **Use Cases:** What are the most important metrics to visualize?
3. **Sharing:** Is public sharing a priority or internal-only?
4. **Customization:** How much technical knowledge can we assume? (JSON config vs visual builder)
5. **Integration:** Which external data sources are most valuable? (GitHub, Jira, Prometheus?)

## Success Metrics

Track these metrics to measure dashboard adoption:

- Dashboards created per workspace
- Active dashboards (viewed in last 7 days)
- Widgets per dashboard (average)
- Most popular widget types
- Share link clicks
- Export downloads

---

**Status:** Core implementation complete, ready for Phase 1 enhancements
**Next Action:** Choose between table widget OR GridStack.js drag-and-drop (both high value)
