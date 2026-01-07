# Feature Dashboard - 4 Tab Prompts (Distinct Steps)

**Context**: Build Feature Alignment Dashboard incrementally - one tab at a time.
**User Request**: "Build all 4 tabs, but make it distinct steps. Provide prompts for now."
**Timeline**: User wants FAST execution

---

## Tab 1: Feature Inventory Matrix

### External Agent Prompt

```
TASK: Build Feature Inventory Tab (Frontend)

CONTEXT:
- AgentX codebase has 18 HTML pages, 23 route files, 150+ API endpoints
- Need visibility into which features exist where (frontend/backend/docs/roadmap)
- Goal: Matrix view showing alignment status (✅ complete, ⚠️ partial, ❌ missing)

DELIVERABLES:

1. **HTML Component** (features.html - Tab 1):
   - Table with columns: Feature | Frontend | Backend | Docs | Roadmap | Status | Actions
   - Color-coded status badges:
     - ✅ Green = Exists and complete
     - ⚠️ Yellow = Partial (1-2 of 4 present)
     - ❌ Red = Missing (0 present)
     - 🔵 Blue = Planned (roadmap only)
   - Filters: Category dropdown (core, analytics, operations, experimental)
   - Search box (filter by feature name)
   - "Scan Codebase" button (triggers backend scan)
   - "Export Report" button (download CSV)

2. **JavaScript** (features-inventory.js):
   - `loadInventory()` - Fetch from `/api/features/inventory`
   - `renderTable(features)` - Populate table rows
   - `applyFilters()` - Category + search filtering
   - `scanCodebase()` - POST to `/api/features/inventory/scan`
   - `exportReport()` - Generate CSV from table data

3. **UI/UX Specifications**:
   - Responsive table (horizontal scroll on mobile)
   - Sortable columns (click header to sort)
   - Expandable rows (click row to see file paths, line numbers)
   - Empty state: "No features found. Click 'Scan Codebase' to populate."
   - Loading state: Spinner during scan (can take 5-10 seconds)

4. **Example Data Format**:
   ```json
   {
     "name": "Cost Tracking",
     "category": "analytics",
     "status": "partial",
     "frontend": { "exists": true, "pages": ["analytics.html"], "lines": [103, 202] },
     "backend": { "exists": true, "services": ["costCalculator.js"], "endpoints": ["/api/analytics/costs"] },
     "documentation": { "exists": true, "files": ["COST_TRACKING_*.md"], "completeness": 90 },
     "roadmap": { "status": "in-progress", "priority": "high" }
   }
   ```

5. **Wireframe** (ASCII):
   ```
   ┌─────────────────────────────────────────────────────────────────┐
   │  Feature Inventory                   [Scan] [Export] [Refresh]  │
   ├─────────────────────────────────────────────────────────────────┤
   │  [Search...] Category:[All ▼]                                   │
   ├─────────────────────────────────────────────────────────────────┤
   │  Feature       │Frontend│Backend│Docs│Roadmap│Status  │Actions │
   │────────────────────────────────────────────────────────────────│
   │  Cost Tracking │  ✅    │  ✅   │ ✅ │  ⚠️   │Partial │[View]  │
   │  Voice Input   │  ❌    │  ✅   │ ❌ │  ❌   │Orphaned│[View]  │
   │  RAG System    │  ✅    │  ✅   │ ✅ │  ✅   │Complete│[View]  │
   │  ...           │        │       │    │       │        │        │
   ├─────────────────────────────────────────────────────────────────┤
   │  Stats: ✅ 32 complete | ⚠️ 8 partial | ❌ 5 missing           │
   └─────────────────────────────────────────────────────────────────┘
   ```

6. **Accessibility**:
   - Keyboard navigation (Tab, Enter)
   - Screen reader labels for status badges
   - High contrast mode support
   - Focus indicators on interactive elements

OUTPUT FORMAT:
- features-inventory.html (tab 1 HTML)
- features-inventory.js (JavaScript module)
- features-inventory.css (styles)
- README.md (integration instructions)

SUCCESS CRITERIA:
- Table displays 45+ features with alignment status
- Filters work (category, search)
- Scan button triggers backend (shows progress)
- Export generates valid CSV
- Expandable rows show file paths + line numbers
```

---

## Tab 2: API Telemetry Dashboard

### External Agent Prompt

```
TASK: Build API Telemetry Tab (Frontend)

CONTEXT:
- AgentX has 150+ API endpoints across 23 route files
- Need real-time visibility into hits, latency, errors, unused endpoints
- Goal: Identify performance bottlenecks and orphaned endpoints

DELIVERABLES:

1. **HTML Component** (features.html - Tab 2):
   - Stats cards (top row):
     - Total Requests (24h)
     - Avg Latency (P50)
     - Error Rate (%)
     - Unused Endpoints (0 hits)
   - Main table with columns:
     - Endpoint | Method | Hits | Avg Latency | P95 | P99 | Errors | Last Called | Status
   - Color-coded latency:
     - 🟢 Green < 100ms
     - 🟡 Yellow 100-500ms
     - 🔴 Red > 500ms
     - ⚫ Gray (unused, 0 hits)
   - Charts (Chart.js):
     - Top 10 endpoints (bar chart, by hits)
     - Latency distribution (histogram, P50/P95/P99)
     - Error rate trends (line chart, last 24h)
   - Filters:
     - Time range: 1h / 6h / 24h / 7d
     - Status: All / Slow / Errors / Unused
     - Sort by: Hits / Latency / Errors

2. **JavaScript** (features-telemetry.js):
   - `loadTelemetry(timeRange)` - Fetch from `/api/features/telemetry?timeRange=24h`
   - `renderTable(endpoints)` - Populate endpoint stats table
   - `renderCharts(data)` - Create Chart.js visualizations
   - `applyFilters()` - Time range + status filtering
   - `refreshData()` - Auto-refresh every 30 seconds (optional toggle)

3. **UI/UX Specifications**:
   - Real-time updates (30s auto-refresh with countdown)
   - Responsive charts (resize on window change)
   - Expandable rows (click to see recent errors)
   - Empty state: "No telemetry data. Make API calls to populate."
   - Loading state: Skeleton loader during fetch

4. **Example Data Format**:
   ```json
   {
     "endpoint": "/api/analytics/costs",
     "method": "GET",
     "metrics": {
       "hitCount": 234,
       "avgLatency": 45,
       "p50Latency": 38,
       "p95Latency": 92,
       "p99Latency": 156,
       "errorCount": 2,
       "lastCalled": "2026-01-06T10:45:23Z"
     }
   }
   ```

5. **Wireframe** (ASCII):
   ```
   ┌───────────────────────────────────────────────────────────────┐
   │  API Telemetry               [1h][6h][24h▼][7d] [Auto-refresh]│
   ├───────────────────────────────────────────────────────────────┤
   │  Total Requests  Avg Latency   Error Rate   Unused Endpoints  │
   │     12,345          45ms          0.8%            8           │
   ├───────────────────────────────────────────────────────────────┤
   │  Endpoint                │Hits│Lat│P95│Errors│Last Call      │
   │──────────────────────────────────────────────────────────────│
   │  GET /api/chat           │1234│🟢42│89 │  1   │2min ago       │
   │  GET /api/models/all     │ 567│🟡156│312│  0   │5min ago       │
   │  POST /api/rag/ingest    │  89│🟢38│76 │  0   │1h ago         │
   │  GET /api/janitor/*      │  0 │⚫- │ - │  -   │Never          │
   ├───────────────────────────────────────────────────────────────┤
   │  📊 Charts:                                                   │
   │  [Top 10 Endpoints Bar Chart]                                 │
   │  [Latency Distribution Histogram]                             │
   │  [Error Rate Trends Line Chart]                               │
   └───────────────────────────────────────────────────────────────┘
   ```

6. **Chart Specifications**:
   - **Top 10 Bar Chart**: X-axis = endpoints, Y-axis = hits, color by latency status
   - **Latency Histogram**: Buckets = 0-50ms, 50-100ms, 100-200ms, 200-500ms, 500ms+
   - **Error Rate Line**: X-axis = time (hourly), Y-axis = error %, red line

7. **Unused Endpoints Section**:
   - Separate collapsible section at bottom
   - "Unused Endpoints (0 hits in 30 days)"
   - Table with: Endpoint | Last Known Call | Recommendation
   - Recommendations: "Consider deprecating" | "Mark headless" | "Add UI"

OUTPUT FORMAT:
- features-telemetry.html (tab 2 HTML)
- features-telemetry.js (JavaScript module)
- features-telemetry.css (styles)
- README.md (Chart.js integration guide)

SUCCESS CRITERIA:
- Table shows 150+ endpoints with real-time stats
- Charts render correctly (responsive)
- Auto-refresh works (30s interval)
- Unused endpoints section highlights orphans
- Performance: < 1s load time for full dashboard
```

---

## Tab 3: Feature Adoption Metrics

### External Agent Prompt

```
TASK: Build Feature Adoption Tab (Frontend)

CONTEXT:
- Track which users use which features (page views, button clicks, completions)
- Goal: Identify underutilized features and high-adoption winners
- Enable data-driven roadmap prioritization

DELIVERABLES:

1. **HTML Component** (features.html - Tab 3):
   - Stats cards (top row):
     - Total Features: 45
     - Adopted (>50% users): 32
     - Underutilized (<10% users): 8
     - Avg Engagement Time: 4.2min
   - Main table with columns:
     - Feature | Page | Users | Adoption Rate | Trend (7d) | Avg Duration | Status
   - Color-coded adoption:
     - 🟢 Green > 50% (widely adopted)
     - 🟡 Yellow 20-50% (moderate)
     - 🔴 Red < 10% (underutilized)
   - Charts (Chart.js):
     - Feature adoption over time (line chart, top 5 features)
     - Adoption rate distribution (donut chart, by category)
     - User engagement heatmap (day x hour)
   - Filters:
     - Time range: 7d / 30d / 90d
     - Category: All / Core / Analytics / Operations
     - Min adoption: 0% / 10% / 25% / 50%

2. **JavaScript** (features-adoption.js):
   - `loadAdoption(timeRange)` - Fetch from `/api/features/usage/adoption?timeRange=30d`
   - `renderTable(features)` - Populate adoption table
   - `renderCharts(data)` - Create Chart.js visualizations
   - `calculateTrend(feature)` - Compare current vs previous period (↑ ↓ →)
   - `applyFilters()` - Time range + category + min adoption

3. **UI/UX Specifications**:
   - Trend indicators (↑ +15%, ↓ -8%, → stable)
   - Expandable rows (click to see user breakdown)
   - Empty state: "No usage data. Add feature tracking to pages."
   - Loading state: Skeleton loader

4. **Example Data Format**:
   ```json
   {
     "feature": "RAG Document Upload",
     "page": "rag.html",
     "metrics": {
       "totalUsers": 100,
       "activeUsers": 45,
       "adoptionRate": 45,
       "trend": "+12",
       "avgDuration": 180,
       "lastWeekAdoption": 33
     },
     "category": "core"
   }
   ```

5. **Wireframe** (ASCII):
   ```
   ┌──────────────────────────────────────────────────────────────┐
   │  Feature Adoption          [7d][30d▼][90d] Category:[All▼]  │
   ├──────────────────────────────────────────────────────────────┤
   │  Total: 45  │ Adopted: 32  │ Under-used: 8  │ Avg: 4.2min   │
   ├──────────────────────────────────────────────────────────────┤
   │  Feature          │Page│Users│Adoption│Trend│Duration│Status│
   │─────────────────────────────────────────────────────────────│
   │  RAG Upload       │rag │ 45  │  🟢45% │↑+12%│ 3.0min │Strong│
   │  Cost Analytics   │ana │ 12  │  🔴12% │↓-5% │ 1.2min │Weak  │
   │  Model Comparison │mod │ 67  │  🟢67% │→+2% │ 5.4min │Strong│
   │  Voice Input      │-   │  0  │  ⚫0%  │  -  │   -    │Unused│
   ├──────────────────────────────────────────────────────────────┤
   │  📊 Charts:                                                  │
   │  [Adoption Trends - Line Chart (Top 5)]                      │
   │  [Category Distribution - Donut Chart]                       │
   │  [Engagement Heatmap - Day x Hour]                           │
   └──────────────────────────────────────────────────────────────┘
   ```

6. **Chart Specifications**:
   - **Adoption Trends**: Line chart, X-axis = date, Y-axis = adoption %, 5 lines (top features)
   - **Category Donut**: Slices = categories (core, analytics, ops), size = adoption sum
   - **Heatmap**: Grid = 7 days x 24 hours, color intensity = usage count

7. **Insights Section**:
   - Collapsible "Insights" panel at bottom
   - Auto-generated insights:
     - "RAG Upload adoption grew 12% this week (weekend spike)"
     - "Cost Analytics is underutilized - consider onboarding improvements"
     - "Voice Input has 0 usage - candidate for removal or marketing push"

8. **Feature Tracking Implementation Guide**:
   - Include README section: "How to Track Features in HTML"
   - Example code snippet:
     ```html
     <button data-feature="rag-upload" onclick="uploadFile()">Upload</button>
     <script>
       document.querySelectorAll('[data-feature]').forEach(el => {
         el.addEventListener('click', () => {
           trackFeatureUsage(el.dataset.feature, 'clicked');
         });
       });
     </script>
     ```

OUTPUT FORMAT:
- features-adoption.html (tab 3 HTML)
- features-adoption.js (JavaScript module)
- features-adoption.css (styles)
- README.md (tracking implementation guide)

SUCCESS CRITERIA:
- Table shows 45+ features with adoption rates
- Trend indicators work (compare vs previous period)
- Charts render (adoption trends, heatmap)
- Insights auto-generate based on data
- Guide helps developers add tracking to new features
```

---

## Tab 4: Admin Controls (Feature Flags + Actions)

### External Agent Prompt

```
TASK: Build Admin Controls Tab (Frontend)

CONTEXT:
- Centralized admin panel for feature flags, codebase scanning, and system actions
- Goal: Toggle features on/off, trigger scans, manage system health
- Target user: Solo developer (you) managing AgentX

DELIVERABLES:

1. **HTML Component** (features.html - Tab 4):
   - **Section 1: Feature Flags Table**
     - Columns: Flag Name | Enabled | Scope | Rollout % | Updated | Actions
     - Toggle switches (ON/OFF) for each flag
     - "Add Feature Flag" button
     - Edit/Delete actions per row
   - **Section 2: System Actions**
     - "Scan Codebase" button (triggers feature inventory scan)
     - "Clear Telemetry" button (resets API stats)
     - "Export Alignment Report" button (downloads CSV/JSON)
     - "Sync Roadmap" button (re-reads ROADMAP.md)
   - **Section 3: Recent Activity Log**
     - Last 10 admin actions with timestamps
     - Example: "Disabled 'voice-input' flag (Reason: No UI) - 2h ago"

2. **JavaScript** (features-admin.js):
   - `loadFlags()` - Fetch from `/api/features/flags`
   - `toggleFlag(flagName, enabled)` - PUT to `/api/features/flags/:name`
   - `addFlag()` - Show modal, POST to `/api/features/flags`
   - `editFlag(flagName)` - Show modal, PUT to update
   - `deleteFlag(flagName)` - Confirm, DELETE
   - `scanCodebase()` - POST to `/api/features/inventory/scan`, show progress
   - `clearTelemetry()` - POST to `/api/features/telemetry/clear`, confirm first
   - `exportReport()` - GET `/api/features/alignment-report`, download CSV

3. **UI/UX Specifications**:
   - Feature flag toggles: Instant feedback (optimistic UI update)
   - Confirmation modals for destructive actions (clear, delete)
   - Progress indicators for long-running actions (scan codebase = 5-10s)
   - Success/error toasts (top-right corner, auto-dismiss)
   - Activity log: Auto-refresh every 30s

4. **Example Data Format (Feature Flag)**:
   ```json
   {
     "name": "voice-input",
     "enabled": false,
     "description": "Voice input feature (speech-to-text)",
     "scope": "global",
     "config": {
       "rolloutPercentage": 0,
       "environment": "all"
     },
     "metadata": {
       "updatedAt": "2026-01-06T10:30:00Z",
       "updatedBy": "admin",
       "reason": "No UI implemented yet"
     }
   }
   ```

5. **Wireframe** (ASCII):
   ```
   ┌────────────────────────────────────────────────────────────────┐
   │  Admin Controls                          [Add Feature Flag]     │
   ├────────────────────────────────────────────────────────────────┤
   │  FEATURE FLAGS                                                  │
   │  Flag Name      │Enabled│Scope │Rollout│Updated  │Actions     │
   │──────────────────────────────────────────────────────────────  │
   │  voice-input    │ ⭘ OFF│global│  0%   │2h ago   │[Edit][Del] │
   │  cost-tracking  │ ● ON │global│ 100%  │1d ago   │[Edit][Del] │
   │  workflow-gen   │ ● ON │admin │ 100%  │3d ago   │[Edit][Del] │
   ├────────────────────────────────────────────────────────────────┤
   │  SYSTEM ACTIONS                                                 │
   │  [Scan Codebase] [Clear Telemetry] [Export Report] [Sync Road]│
   ├────────────────────────────────────────────────────────────────┤
   │  RECENT ACTIVITY                                                │
   │  • Disabled 'voice-input' (No UI) - 2h ago                     │
   │  • Scanned codebase (45 features found) - 4h ago               │
   │  • Exported alignment report - 1d ago                          │
   └────────────────────────────────────────────────────────────────┘
   ```

6. **Add Feature Flag Modal**:
   ```
   ┌─────────────────────────────────────┐
   │  Add Feature Flag            [X]    │
   ├─────────────────────────────────────┤
   │  Name: [________________]           │
   │  Description: [______________]      │
   │  Scope: [Global ▼]                  │
   │  Rollout %: [100] (0-100)           │
   │  Enabled: [✓] Yes  [ ] No           │
   │                                     │
   │        [Cancel]  [Create Flag]      │
   └─────────────────────────────────────┘
   ```

7. **System Actions Behavior**:
   - **Scan Codebase**:
     - Show progress modal: "Scanning... 2/3 sources complete"
     - Takes 5-10 seconds
     - Updates feature inventory tab when done
   - **Clear Telemetry**:
     - Confirm modal: "This will reset all API stats. Continue?"
     - Irreversible action warning
   - **Export Report**:
     - Downloads CSV with all features + alignment status
   - **Sync Roadmap**:
     - Re-reads ROADMAP.md, updates feature inventory roadmap fields

8. **Activity Log**:
   - Auto-refresh every 30s
   - Shows last 10 actions with:
     - Action type (icon)
     - Description
     - User (always "admin" for solo dev)
     - Timestamp (relative: "2h ago")

9. **Feature Flag Integration Guide**:
   - Include README section: "How to Use Feature Flags in Code"
   - Backend example:
     ```javascript
     const featureFlagService = require('./services/featureFlagService');

     if (await featureFlagService.isEnabled('voice-input', userId)) {
       // Show voice button
     }
     ```
   - Frontend example:
     ```javascript
     fetch('/api/features/flags/voice-input')
       .then(r => r.json())
       .then(flag => {
         if (flag.enabled) {
           document.querySelector('#voice-btn').style.display = 'block';
         }
       });
     ```

OUTPUT FORMAT:
- features-admin.html (tab 4 HTML)
- features-admin.js (JavaScript module)
- features-admin.css (styles)
- README.md (feature flag usage guide)

SUCCESS CRITERIA:
- Feature flags table displays all flags
- Toggle switches work instantly (optimistic UI)
- Add/Edit/Delete modals functional
- System actions execute with feedback
- Activity log shows recent actions
- Integration guide helps developers use flags
```

---

## Integration Notes (For Claude Code)

### Tab Order Priority

1. **Tab 1** (Inventory) - FIRST (foundation for other tabs)
2. **Tab 2** (Telemetry) - SECOND (immediate operational value)
3. **Tab 4** (Admin) - THIRD (enables quick fixes via flags)
4. **Tab 3** (Adoption) - FOURTH (nice-to-have analytics)

**Rationale**: Inventory + Telemetry give immediate visibility. Admin controls enable quick fixes. Adoption is valuable but not critical path.

### Backend Dependencies

Each tab requires corresponding backend APIs (already specified in IMPLEMENTATION_PLAN.md):
- Tab 1: `/api/features/inventory` (GET, POST /scan)
- Tab 2: `/api/features/telemetry` (GET with timeRange)
- Tab 3: `/api/features/usage/adoption` (GET with timeRange)
- Tab 4: `/api/features/flags` (GET, POST, PUT, DELETE)

**Action**: Build backend APIs in parallel with frontend tabs (or before).

### Shared Components

All tabs share:
- Navigation tabs (Bootstrap tabs or custom)
- Loading skeletons
- Error toasts
- Export functionality

**Action**: Create `features-common.js` with shared utilities.

### Data Flow

```
User Action (Tab) → Frontend JS → API Call → Backend Service → MongoDB → Response → Render
```

**Example**: User clicks "Scan Codebase" (Tab 1) → `scanCodebase()` → POST `/api/features/inventory/scan` → `featureInventoryService.scanCodebase()` → MongoDB update → Response with count → Re-render table

---

## Timeline Estimate (Per Tab)

**Tab 1** (Inventory): 2-3 days (most complex - scanning logic)
**Tab 2** (Telemetry): 1-2 days (charts + table, simpler logic)
**Tab 4** (Admin): 1-2 days (CRUD for flags, simple actions)
**Tab 3** (Adoption): 2 days (tracking implementation + charts)

**Total**: 6-9 days for all 4 tabs (assuming external agents or parallel work)

---

## Fast-Track Option

If user wants FASTER:
- **Build Tab 1 + 2 only** (3-5 days total)
- Defer Tab 3 + 4 to Phase 3 or later
- Still get 80% of value (visibility into features + APIs)

**Recommendation**: Ask user if they want all 4 now or Tab 1+2 first for speed.

---

**Usage**: Copy relevant tab prompt, send to external agent, collect output, integrate into features.html.
