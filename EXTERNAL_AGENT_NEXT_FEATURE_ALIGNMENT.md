# External Agent Next Task: Feature Alignment Dashboard + Prioritization

## Context

You just completed the **Feature Alignment Matrix Scanner** - excellent work! ✨

**Scanner Results:**
- ✅ 217 features detected across codebase
- ✅ 253 backend endpoints mapped
- ✅ 10 orphan endpoints identified (no frontend/doc references)
- ✅ 49 headless-documented features (documented but no UI)
- ✅ 157 complete features
- ✅ 11 partial features

**Output:** `reports/feature-alignment.json`

---

## Next Task: Build Feature Alignment Dashboard + Action Report

### Objective

Create an **interactive HTML dashboard** and **actionable report** that helps prioritize which headless features need UI development.

---

## Part 1: Feature Alignment Dashboard UI

**File:** `/public/feature-alignment.html`

**Requirements:**

### 1. Overview Stats Panel
- Total features (217)
- Status breakdown pie chart (157 complete, 49 headless, 11 partial)
- Backend API coverage (253 endpoints)
- Frontend coverage (24 HTML pages)

### 2. Orphan Endpoints Table (10 endpoints)
Display orphan endpoints grouped by category:

**Model Management (3):**
- GET /api/models/routing
- POST /api/models/classify
- GET /api/models/health

**Feedback (1):**
- POST /api/feedback

**Authentication (3):**
- POST /register
- POST /logout
- GET /me

**Dashboard (3):**
- GET /api/dashboard/health
- GET /api/dashboard/stats
- GET /api/dashboard/scans

**For each endpoint:**
- HTTP method + path
- Route file (if detected)
- "Add to Feature" button → opens modal to link to existing feature
- "Mark as Internal" button → exclude from orphan list

### 3. Headless Features List (49 features)
**Filterable table with columns:**
- Feature name
- Documented in (file links)
- Backend endpoints (count + list)
- Status (headless-documented)
- Priority score (calculated - see Part 2)
- Actions: "Add UI", "Mark as API-only", "View Details"

**Filters:**
- By documentation file
- By endpoint count (1-5, 6-10, 11+)
- By priority (High/Medium/Low)
- Search by feature name

### 4. Feature Details Modal
When clicking a feature, show:
- Feature name
- All endpoints used by this feature
- Documentation references (with line numbers)
- Backend service files involved
- Suggested UI implementation location
- Related features (features using same endpoints)

### 5. Actionable Next Steps Panel
**Generate recommendations:**
- Top 5 high-priority headless features to build UI for
- Endpoints that should be linked to existing features
- Features that can be marked as API-only (e.g., n8n internal endpoints)

---

## Part 2: Priority Score Algorithm

Implement in `/src/services/featureAlignmentPriority.js`

**Calculate priority score (0-100) for each headless feature based on:**

### Scoring Criteria (Total: 100 points)

1. **n8n Workflow Usage (30 points)**
   - Scan n8n workflow definitions (routes/operations.js WORKFLOWS array)
   - If feature endpoint is called by n8n workflow: +30 points
   - Rationale: n8n workflows = production usage, needs monitoring UI

2. **Endpoint Count (20 points)**
   - 1-2 endpoints: 5 points
   - 3-5 endpoints: 10 points
   - 6-10 endpoints: 15 points
   - 11+ endpoints: 20 points
   - Rationale: More endpoints = more complex feature = higher value UI

3. **Documentation Thoroughness (20 points)**
   - Feature documented in specs/ or docs/: +10 points
   - Feature has API contract doc: +5 points
   - Feature mentioned in ROADMAP.md or implementation plans: +5 points
   - Rationale: Well-documented = intentional feature, not orphan code

4. **Security/Admin Requirement (15 points)**
   - Feature requires authentication (requireAuth middleware): +10 points
   - Feature has admin-only endpoints: +5 points
   - Rationale: Auth-required features need admin UI for management

5. **Recent Activity (15 points)**
   - Check git log for recent commits to route file:
     - Last 7 days: 15 points
     - Last 30 days: 10 points
     - Last 90 days: 5 points
   - Rationale: Active development = current priority

**Priority Levels:**
- 70-100 points: **HIGH** (Build UI immediately)
- 40-69 points: **MEDIUM** (Next sprint)
- 0-39 points: **LOW** (Consider API-only or defer)

---

## Part 3: Actionable Report

**File:** `reports/feature-alignment-actions.md`

**Generate markdown report with:**

### Section 1: Executive Summary
- Total features vs documented features
- Orphan endpoint count and impact
- Recommended actions count

### Section 2: High-Priority Headless Features (Top 10)
For each feature:
```markdown
## [Feature Name] (Score: 85/100)

**Status:** headless-documented
**Priority:** HIGH

**Endpoints:**
- POST /api/feature/action
- GET /api/feature/status

**Usage:**
- ✅ Called by n8n workflow: N3.1 Model Health Monitor
- ✅ Documented in: specs/V4_FEATURE.md
- ✅ Recent activity: 3 commits in last 7 days

**Why build UI:**
This feature is actively used by n8n workflows for production monitoring, but lacks a dashboard for manual inspection. Building UI would enable operators to troubleshoot issues without accessing raw API endpoints.

**Suggested UI location:** /public/feature-dashboard.html

**Estimated effort:** 2-3 days (5 endpoints, complex data visualization)

**Next steps:**
1. Create feature-dashboard.html with stats panel
2. Add real-time refresh for monitoring
3. Link from Operations Center dashboard
```

### Section 3: Orphan Endpoints Resolution
For each orphan endpoint, suggest:
- Link to existing feature? (which one)
- Create new feature?
- Mark as internal/deprecated?

### Section 4: Quick Wins
Features that can be marked as API-only (low score, internal use only)

---

## Part 4: Integration

### 1. Add to Navigation
Update `/public/js/nav.js` (if exists) or navigation component:
```javascript
{
  name: 'Feature Alignment',
  path: '/feature-alignment.html',
  icon: 'fa-diagram-project',
  section: 'admin'
}
```

### 2. API Endpoints (optional)
If you want real-time updates:
- POST `/api/features/alignment/scan` - Re-run scanner
- PATCH `/api/features/alignment/orphan/:id/link` - Link orphan to feature
- PATCH `/api/features/alignment/feature/:id/priority` - Override priority

### 3. Documentation
Update `/docs/FEATURE_ALIGNMENT.md`:
- How to use the dashboard
- How priority scores are calculated
- How to mark features as API-only
- How to add new features to scanner

---

## Technical Specifications

### Frontend Stack
- Use existing AgentX styles (styles.css)
- Chart.js for pie charts (status distribution)
- DataTables or native table with sorting/filtering
- Fetch API for loading feature-alignment.json

### Data Source
- Load `/reports/feature-alignment.json` on page load
- Calculate priority scores client-side (or pre-calculate in scanner)
- Cache results in localStorage (5min TTL)

### UI/UX Guidelines
- Match existing dashboard.html design language
- Use color coding:
  - 🟢 Complete features
  - 🟡 Partial features
  - 🔴 Headless-documented features
  - ⚫ Orphan endpoints
- Responsive design (mobile-friendly tables)
- Export to CSV/PDF buttons

---

## Success Criteria

✅ **Dashboard loads and displays all 217 features**
✅ **Orphan endpoints table shows 10 endpoints with actions**
✅ **Headless features table shows 49 features sorted by priority**
✅ **Priority algorithm correctly scores based on 5 criteria**
✅ **Actionable report generated with top 10 recommendations**
✅ **User can filter, search, and drill down into feature details**
✅ **Report identifies at least 5 high-priority features for UI development**

---

## Testing Checklist

- [ ] Dashboard loads without errors
- [ ] Feature count matches scanner (217)
- [ ] Orphan endpoints list shows correct endpoints
- [ ] Priority scores calculated for all headless features
- [ ] Filters work (status, priority, search)
- [ ] Modal shows detailed feature info
- [ ] Report file generated with markdown formatting
- [ ] Top 10 list makes sense (validated by human)
- [ ] Can mark endpoints as internal
- [ ] Can link orphan endpoints to features

---

## Bonus: Advanced Features (Optional)

If time permits:

1. **Trend Analysis**
   - Compare current scan to previous scans
   - Show "New orphan endpoints" since last scan
   - Track "Features completed" over time

2. **n8n Workflow Visualization**
   - Show which workflows use which endpoints
   - Highlight critical paths (workflows with no UI monitoring)

3. **Auto-Linking Suggestions**
   - Use fuzzy matching to suggest linking orphan endpoints to features
   - Example: `/api/feedback` → link to "Feedback System" feature

4. **Export Feature Inventory**
   - Generate OpenAPI spec from aligned features
   - Export to CSV for stakeholder review

---

## Estimated Effort

- Feature Alignment Dashboard HTML: **4-6 hours**
- Priority scoring algorithm: **2-3 hours**
- Actionable report generator: **2-3 hours**
- Testing and polish: **2 hours**

**Total:** 10-14 hours

---

## Output Files Expected

1. `/public/feature-alignment.html` - Interactive dashboard
2. `/public/js/feature-alignment.js` - Dashboard logic
3. `/src/services/featureAlignmentPriority.js` - Priority calculator
4. `/reports/feature-alignment-actions.md` - Actionable report
5. `/tests/services/featureAlignmentPriority.test.js` - Priority tests
6. `/docs/FEATURE_ALIGNMENT.md` - User documentation

---

## Questions to Clarify

Before starting, consider:

1. Should priority scores be calculated at scan time or dashboard load time?
2. Do you want real-time re-scanning via API, or is it OK to re-run npm script?
3. Should the dashboard allow editing (linking orphans, marking API-only) or just viewing?
4. What's the target audience? (Devs, PMs, Operations team?)

---

## Next Steps After This Task

Once feature alignment dashboard is complete:

1. **Review top 10 high-priority features**
2. **Create UI implementation tasks** for high-priority items
3. **Update ROADMAP.md** with feature alignment findings
4. **Use dashboard to track progress** as UIs are built

---

**This task completes Initiative 3 (Feature Alignment Dashboard) from the implementation plan!** 🎯

Good luck! Let me know if you need clarification on any requirements.
