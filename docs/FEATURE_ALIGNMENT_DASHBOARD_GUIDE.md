# Feature Alignment Dashboard User Guide

**Last Updated:** 2026-01-07

The Feature Alignment Dashboard provides comprehensive visibility into feature coverage across the AgentX codebase, helping you identify which features are complete, which need UI development, and orphan endpoints that need resolution.

---

## Quick Start

### Accessing the Dashboard

1. Navigate to **http://localhost:3080/feature-alignment.html**
2. Or click **"Alignment"** in the navigation bar (between "Admin" and "Workspaces")

### Dashboard Overview

The dashboard displays:
- **225 features** scanned across the codebase
- **254 backend endpoints** mapped
- **10 orphan endpoints** (7 false positives, 3 API-only)
- **165 complete features** (73%) with full UI implementation
- **5 medium-priority features** (23-69 points) to consider for UI development
- **55 low-priority features** (API-only or deferred)

---

## Dashboard Sections

### 1. Overview Stats Panel

**Displays:**
- Total Features: 225
- Complete Features: 165 (green badge)
- Medium Priority: 5 (yellow badge)
- Low Priority: 55 (blue badge)
- Backend API Coverage: 254 endpoints
- Frontend Coverage: 23 HTML pages

**Pie Chart:**
- Visual breakdown of feature status distribution
- Hover to see exact counts

---

### 2. Orphan Endpoints Table

**What are Orphan Endpoints?**
Orphan endpoints are backend API routes that appear to have no frontend or documentation references.

**Categorization:**
- ✅ **False Positives (7):** Endpoints that ARE used but scanner missed them
  - `/api/feedback` - Used in chat UI (thumbs up/down)
  - `/register`, `/logout`, `/me` - Authentication routes
  - `/api/dashboard/health`, `/api/dashboard/stats`, `/api/dashboard/scans` - Dashboard APIs
- 🔵 **API-Only (3):** Programmatic access by design
  - `/api/models/routing` - Internal model router
  - `/api/models/classify` - Query classification
  - `/api/models/health` - Model health check

**Filters:**
- **Hide False Positives:** Checkbox (default: checked) to show only genuine orphans

**Actions:**
- **View Code:** Link to source file
- **Link to Feature:** Associate endpoint with existing feature
- **Mark as Internal:** Exclude from orphan list

---

### 3. Features Priority Table

**Columns:**
1. **Feature Name:** Click to view details
2. **Priority Score:** 0-100 points with color-coded bar
   - Red (70-100): High priority - build UI immediately
   - Yellow (40-69): Medium priority - consider for next sprint
   - Blue (0-39): Low priority - defer or API-only
   - Green (negative): Complete - already has UI
3. **Category:** Complete | Medium | Low | API-Only
4. **Endpoints:** Count with hover tooltip showing full list
5. **Has UI?:** ✅ Yes / ❌ No
6. **Actions:** View Details | Plan UI | Mark API-Only

**Filters:**
- **Category:** All | Complete | Medium | Low | API-Only
- **Priority Range:** All | High (70+) | Medium (40-69) | Low (0-39)
- **Endpoint Count:** All | 1-5 | 6-10 | 11+
- **Search:** Text input for feature name

**Sorting:**
- Click column headers to sort ascending/descending
- Default: Sorted by priority score (high to low)

---

### 4. Feature Details Modal

**Triggered By:** Click "View Details" button on any feature

**Modal Sections:**

**A. Header**
- Feature Name
- Priority Score with colored badge

**B. Score Breakdown (7 Criteria)**
Shows how the priority score was calculated:

1. **n8n Workflow Usage (±30pts):**
   - Positive: Feature called BY n8n workflows (needs monitoring UI)
   - Negative: Feature IS an n8n endpoint (API-only by design)

2. **Endpoint Count (0-20pts):**
   - 1-2 endpoints: 5 points
   - 3-5 endpoints: 10 points
   - 6-10 endpoints: 15 points
   - 11+ endpoints: 20 points

3. **Documentation (0-20pts):**
   - Documented in specs/ or docs/: +10pts
   - Has API contract doc: +5pts
   - Mentioned in ROADMAP or plans: +5pts

4. **Security (0-15pts):**
   - Requires authentication: +10pts
   - Admin-only endpoints: +5pts

5. **Recent Activity (0-15pts):**
   - Modified in last 7 days: 15pts
   - Last 30 days: 10pts
   - Last 90 days: 5pts

6. **False Positive Penalty (-15pts):**
   - Has frontend references but marked as orphan

7. **UI Detection (-20pts):**
   - Has frontend files (not truly headless)

**C. Endpoints**
- List all backend endpoints with HTTP method + path
- Shows source file for each

**D. Frontend Integration**
- HTML pages using this feature
- JavaScript files with references
- If none: "No UI detected"

**E. Documentation**
- List all doc files mentioning this feature
- Show file paths as clickable links

**F. Recommendation**
Based on priority score:
- **90-100pts (Critical):** "Build UI immediately - production dependency"
- **70-89pts (High):** "Build UI in current sprint"
- **40-69pts (Medium):** "Consider for next sprint"
- **20-39pts (Low):** "Consider API-only or defer"
- **0-19pts (API-Only):** "No UI needed - internal/automation API"
- **Negative (Complete):** "Already has UI"

---

### 5. Actionable Recommendations Panel

**Top 5 Medium-Priority Features:**
Lists features scored 40-69 points that may need UI development.

**For Each Feature:**
- Feature name
- Priority score
- Brief rationale (why it scored medium)
- Button: "Start Planning"

**If No Medium-Priority Features:**
Shows message: "All features either complete or API-only. No UI development needed at this time."

**Quick Actions:**
- **Export Report:** Download `feature-alignment-actions.md`
- **Re-scan Codebase:** Re-run scanner (optional)

---

## Understanding Priority Scores

### Score Ranges

| Score | Category | Meaning | Action |
|-------|----------|---------|--------|
| 90-100 | Critical | Production dependency, no UI | Build immediately |
| 70-89 | High | Important feature, needs UI | Current sprint |
| 40-69 | Medium | Consider UI development | Next sprint |
| 20-39 | Low | Defer or mark API-only | Backlog |
| 0-19 | API-Only | Internal/automation API | No UI needed |
| Negative | Complete | Already has UI | No action |

### Common Score Patterns

**High Score Example (75pts):**
- Feature with 6+ endpoints (+15pts)
- Well-documented in specs (+15pts)
- Requires authentication (+10pts)
- Called by n8n workflows (+30pts)
- Modified in last 14 days (+10pts)
= **80 points** → **High priority, build UI**

**Low Score Example (15pts):**
- Single endpoint (+5pts)
- Documented in code comments only (+0pts)
- No auth required (+0pts)
- Not used by workflows (+0pts)
- Last modified 6 months ago (+0pts)
- IS an n8n webhook endpoint (-30pts)
= **-25 points** → **API-only, no UI needed**

---

## Common Workflows

### Workflow 1: Reviewing System Coverage

**Goal:** Understand overall feature coverage

1. Open dashboard
2. Check Overview Stats Panel
   - See that 73% of features are complete (165/225)
3. Review pie chart to visualize distribution
4. Filter Features Priority Table by "Complete" to see what's done
5. Filter by "Medium" to see what needs attention

**Outcome:** Clear picture of system completeness

---

### Workflow 2: Prioritizing Next UI Development

**Goal:** Decide which feature to build UI for next

1. Go to Actionable Recommendations Panel
2. Review Top 5 medium-priority features
3. Click "View Details" on highest-scored feature
4. Review score breakdown to understand why it's prioritized
5. Check endpoints and documentation
6. Click "Start Planning" to create implementation task

**Outcome:** Data-driven decision on next UI to build

---

### Workflow 3: Resolving Orphan Endpoints

**Goal:** Clean up detected orphan endpoints

1. Go to Orphan Endpoints Table
2. Uncheck "Hide False Positives" to see all 10
3. Review false positives (✅ badges)
   - Note: These are actually used but scanner missed them
4. Review API-only endpoints (🔵 badges)
   - These are intentionally programmatic
5. For genuine orphans:
   - Click "View Code" to investigate
   - Click "Link to Feature" if it belongs to existing feature
   - Click "Mark as Internal" if it's intentional API

**Outcome:** Clean endpoint inventory with accurate categorization

---

### Workflow 4: Finding Features by Endpoint Count

**Goal:** Find complex features (many endpoints = complex)

1. Go to Features Priority Table
2. Filter by Endpoint Count: "11+"
3. Sort by Priority Score
4. Review top results - these are large, well-documented features
5. Click "View Details" to see all endpoints

**Outcome:** Identify complex features that may benefit from comprehensive UI

---

## Troubleshooting

### Dashboard Doesn't Load

**Symptoms:** Blank page or loading spinner

**Solutions:**
1. Check console for errors (F12 → Console tab)
2. Verify `reports/feature-alignment.json` exists:
   ```bash
   ls -la /home/yb/codes/AgentX/reports/feature-alignment.json
   ```
3. Re-run scanner if file is missing:
   ```bash
   cd /home/yb/codes/AgentX
   node scripts/feature-alignment-scan.js
   ```
4. Check that symlink exists:
   ```bash
   ls -la /home/yb/codes/AgentX/public/reports/feature-alignment.json
   ```

---

### Priority Scores Seem Wrong

**Symptoms:** Feature you know is important has low score

**Explanation:** Priority algorithm uses objective criteria:
- Endpoint count
- Documentation
- n8n usage
- Recent activity

A feature may be important but score low if:
- It has few endpoints (simple API)
- It lacks documentation
- It hasn't been modified recently
- It's not called by n8n workflows

**Solution:** Review score breakdown in modal to understand why it scored that way

---

### False Positives Still Showing

**Symptoms:** Endpoints marked as orphan but you know they're used

**Explanation:** Scanner has known limitations:
- Misses `API.get()` wrapper patterns (only detects `fetch()`)
- Misses HTML form actions
- Misses dynamic route construction

**Solution:**
1. Click "Link to Feature" to manually associate endpoint
2. Wait for Scanner Phase 1 improvements (in development)
3. See `EXTERNAL_AGENT_NEXT_SCANNER_IMPROVEMENTS.md` for planned fixes

---

### Feature Not Listed

**Symptoms:** You know a feature exists but don't see it in dashboard

**Possible Causes:**
1. **No backend endpoints:** Feature is frontend-only
2. **Filtered out:** Check active filters in Features Priority Table
3. **Scanner missed it:** May need better detection patterns

**Solution:**
1. Clear all filters (set to "All")
2. Use search box to find feature by name
3. If still not found, check scanner output:
   ```bash
   cat reports/feature-alignment.json | grep "feature-name"
   ```

---

## Advanced Usage

### Exporting Data

**Export Report:**
1. Click "Export Report" button in Recommendations Panel
2. Downloads `feature-alignment-actions.md`
3. Contains:
   - Executive summary
   - Top 10 high-priority features
   - Orphan endpoint categorization
   - Recommended actions

**Export to CSV (Coming Soon):**
- Export Features Priority Table to CSV
- Import into spreadsheet for custom analysis

---

### Re-scanning

**When to Re-scan:**
- After adding new features
- After scanner improvements
- Weekly/monthly for trend analysis

**How to Re-scan:**
```bash
cd /home/yb/codes/AgentX
node scripts/feature-alignment-scan.js
```

**Results:**
- Overwrites `reports/feature-alignment.json`
- Dashboard auto-updates on next page load
- Compare to previous scan to see changes

---

### Trend Analysis (Coming Soon)

**Goal:** Track feature coverage over time

**Metrics to Track:**
- Complete features count (target: 100%)
- Orphan endpoints count (target: 0)
- Medium-priority features (target: <10)

**Implementation:**
- Save scan results with timestamps
- Build comparison dashboard
- Show "Features Completed" trend line

---

## Scanner Accuracy

### Current Limitations (Phase 0)

**Detection Gaps:**
- Misses `API.get('/endpoint')` wrapper patterns (only detects `fetch()`)
- Misses `<form action="/endpoint">` in HTML
- Misses authentication routes (`/login`, `/logout`, `/register`)
- Includes backup directories in scan

**False Positive Rate:** 60% (6 out of 10 orphans are false positives)

### Planned Improvements (Phase 1)

**Scanner Phase 1 will add:**
1. API helper wrapper detection (`API.get`, `axios.get`, `$.get`)
2. HTML form action parsing
3. Auth route pattern recognition
4. Confidence scoring for evidence
5. Backup directory exclusion

**Expected Improvement:** False positive rate <20% (0-1 out of 10)

**Status:** See `EXTERNAL_AGENT_NEXT_SCANNER_IMPROVEMENTS.md` for implementation plan

---

## FAQs

### Q: Why are there 10 orphan endpoints when most are false positives?

**A:** The scanner has detection gaps (Phase 0). It looks for `fetch('/api/endpoint')` but misses `API.get('/api/endpoint')`. Scanner Phase 1 improvements will fix this.

### Q: Should I build UI for all medium-priority features?

**A:** No. Review each feature individually. Medium priority (40-69 pts) means "worth considering" not "must build." Factors to consider:
- User demand
- Development effort
- Strategic importance
- Alternative solutions (CLI, API-only)

### Q: What if a feature scores high but shouldn't have UI?

**A:** Click "Mark as API-Only" to exclude from recommendations. Some features are intentionally API-only (n8n workflows, internal services).

### Q: How often should I check this dashboard?

**A:**
- **Weekly:** Review during sprint planning
- **After major features:** Re-scan and check coverage
- **Monthly:** Track progress toward 100% coverage

### Q: Can I customize priority scoring?

**A:** Not yet. The 7-criteria algorithm is fixed. Future versions may allow:
- Custom weights for criteria
- Additional scoring factors
- Team-specific priorities

---

## Related Documentation

- **Priority Algorithm:** [docs/FEATURE_ALIGNMENT_PRIORITY_ALGORITHM.md](FEATURE_ALIGNMENT_PRIORITY_ALGORITHM.md)
- **Orphan Analysis:** [ORPHAN_ENDPOINTS_ANALYSIS.md](../ORPHAN_ENDPOINTS_ANALYSIS.md)
- **Scanner Improvements:** [EXTERNAL_AGENT_NEXT_SCANNER_IMPROVEMENTS.md](../EXTERNAL_AGENT_NEXT_SCANNER_IMPROVEMENTS.md)
- **Implementation Plan:** [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)
- **Roadmap:** [ROADMAP.md](../ROADMAP.md) (Track 8)

---

## Support

**Issues or Questions?**
1. Check console for errors (F12 → Console)
2. Review scanner output: `reports/feature-alignment.json`
3. Check scanner logs during scan execution
4. Refer to troubleshooting section above

**Feature Requests:**
- Scanner accuracy improvements
- Custom priority scoring
- Trend analysis over time
- Export to additional formats

---

**Dashboard Version:** 1.0 (2026-01-07)
**Scanner Version:** 1.0 (Phase 0)
**Next Update:** Scanner Phase 1 improvements (~3 hours development)
