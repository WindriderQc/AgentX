# Week 4 Day 4 Progress - Custom Dashboard Builder

**Date:** 2026-01-06
**Status:** 🚧 **IN PROGRESS**
**Duration:** Starting...

---

## 🎯 Objective

Implement the "Custom Dashboard" feature allowing users to create personalized views of their data using drag-and-drop widgets.

---

## Plan of Action

### 1. Backend: Dashboard Model & API
- [ ] Create `CustomDashboard` model (Schema: Title, Layout, Widgets)
- [ ] Create API endpoints:
    - `POST /api/dashboards` (Create)
    - `GET /api/dashboards` (List)
    - `GET /api/dashboards/:id` (Get)
    - `PATCH /api/dashboards/:id` (Update)
    - `DELETE /api/dashboards/:id` (Delete)

### 2. Frontend: Dashboard Builder
- [ ] Create `custom-dashboard.html`
- [ ] Implement Grid Layout (CSS Grid based)
- [ ] Widget Configuration Modal (Type: Chart/Metric, Source: Collection, Options)
- [ ] Widget Rendering Logic (using Chart.js)

### 3. Integration
- [ ] Connect Dashboard to Analytics API (reuse existing aggregation endpoints or create generic query endpoint)
- [ ] Ensure Workspace Isolation (all dashboards scoped to `workspaceId`)

---

## Technical Details

**Model:** `CustomDashboard`
```javascript
const CustomDashboardSchema = new mongoose.Schema({
  workspaceId: { type: ObjectId, ref: 'Workspace', required: true },
  name: { type: String, required: true },
  description: String,
  layout: [{
    id: String,
    x: Number,
    y: Number,
    w: Number,
    h: Number,
    type: String, // 'chart', 'metric', 'table'
    title: String,
    config: Object // Query & visual settings
  }],
  isPublic: { type: Boolean, default: false }, // Shared within workspace
  createdBy: { type: ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
```

**Route Scoping:**
All routes must use `attachWorkspace` and ensure `workspaceId` is part of every query.
