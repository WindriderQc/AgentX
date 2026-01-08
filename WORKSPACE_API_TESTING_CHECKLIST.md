# Workspace API Integration - Testing Checklist

**Purpose:** Verify workspace isolation across all updated files  
**Status:** Ready for Testing  
**Environment:** Staging/Development

---

## 🔧 Pre-Test Setup

### 1. Create Test Workspaces
```bash
# Via UI or API
POST /api/workspaces
{
  "name": "Test Workspace Alpha",
  "slug": "test-workspace-alpha",
  "description": "Testing workspace isolation"
}

POST /api/workspaces
{
  "name": "Test Workspace Beta", 
  "slug": "test-workspace-beta",
  "description": "Testing workspace isolation"
}
```

### 2. Add Test Data to Each Workspace
**Alpha Workspace:**
- 3 custom models
- 5 prompts
- 2 feature flags
- Run a storage scan

**Beta Workspace:**
- 2 different custom models
- 3 different prompts
- 3 different feature flags
- Run a different storage scan

---

## ✅ Phase 1-5: Core Files (Original)

### Analytics Page (`/analytics.html`)
- [ ] Open Network tab, navigate to analytics page
- [ ] Verify `X-Workspace-Slug: test-workspace-alpha` in all requests
- [ ] Switch to beta workspace
- [ ] Verify slug changes to `test-workspace-beta`
- [ ] Confirm analytics data changes based on workspace

### Models Page (`/models.html`)
- [ ] View models list in alpha workspace
- [ ] Note model names/IDs
- [ ] Switch to beta workspace
- [ ] Confirm different models displayed
- [ ] Create a new model in beta
- [ ] Switch to alpha - verify new model NOT visible

### Dashboard (`/dashboard.html`)
- [ ] Load dashboard in alpha workspace
- [ ] Check all API calls have workspace header
- [ ] Verify stats are workspace-specific
- [ ] Switch to beta workspace
- [ ] Confirm stats change

### Alerts Dashboard (`/alerts-dashboard.html`)
- [ ] Create test alert in alpha workspace
- [ ] Verify alert appears in list
- [ ] Switch to beta workspace
- [ ] Verify alpha alert NOT visible
- [ ] Create alert in beta
- [ ] Switch back to alpha - verify beta alert NOT visible

### Prompts Page (`/prompts.html`)
- [ ] List all prompts in alpha workspace
- [ ] Create new prompt version
- [ ] Switch to beta workspace
- [ ] Verify new prompt NOT visible
- [ ] Create different prompt in beta
- [ ] Switch to alpha - confirm isolation

### Features Admin (`/features-admin.html`)
- [ ] Toggle feature flag in alpha workspace
- [ ] Check flag status
- [ ] Switch to beta workspace
- [ ] Verify flag has independent state
- [ ] Toggle flag in beta
- [ ] Switch to alpha - verify state unchanged

### Feature Adoption (`/features-adoption.html`)
- [ ] Load adoption metrics in alpha
- [ ] Note adoption percentages
- [ ] Switch to beta workspace
- [ ] Verify different adoption data

### Feature Alignment (`/feature-alignment.html`)
- [ ] Load feature alignment report in alpha
- [ ] Note feature count
- [ ] Switch to beta workspace
- [ ] Verify different feature data

### Benchmark (`/benchmark.html`)
- [ ] Start benchmark test in alpha workspace
- [ ] View results
- [ ] Switch to beta workspace
- [ ] Verify alpha results NOT visible
- [ ] Start benchmark in beta
- [ ] Confirm independent results

### Performance (`/performance.html`)
- [ ] Load performance dashboard in alpha
- [ ] Note latency metrics
- [ ] Switch to beta workspace
- [ ] Verify different metrics
- [ ] Check all 5 chart endpoints have workspace headers

---

## ✅ Phase 7: Additional Files

### Storage Tool (`/storage-tool.html`)
**Critical Test - 7 Endpoints**

#### Start Scan
- [ ] Start storage scan in alpha workspace
- [ ] Check Network tab: `POST /api/v1/storage/scan` has workspace header
- [ ] Note scan ID

#### Monitor Scan Status
- [ ] Watch scan progress
- [ ] Check Network tab: `GET /api/v1/storage/status/{id}` has workspace header
- [ ] Verify scan results

#### Switch Workspace Mid-Scan
- [ ] Switch to beta workspace while alpha scan running
- [ ] Verify alpha scan NOT visible in beta
- [ ] Start new scan in beta
- [ ] Switch back to alpha
- [ ] Verify alpha scan still visible/running

#### Stop Scan
- [ ] Stop scan in alpha workspace
- [ ] Check Network tab: `POST /api/v1/storage/stop/{id}` has workspace header
- [ ] Verify scan stopped

#### Recent Scans
- [ ] View recent scans list in alpha
- [ ] Check Network tab: `GET /api/v1/storage/scans` has workspace header
- [ ] Note scan count
- [ ] Switch to beta workspace
- [ ] Verify different scans list

#### Generate Export
- [ ] Generate export in alpha workspace
- [ ] Check Network tab: `POST /api/v1/files/export` has workspace header
- [ ] Wait for export completion

#### Export List
- [ ] View exports list in alpha
- [ ] Check Network tab: `GET /api/v1/files/exports` has workspace header
- [ ] Note export files
- [ ] Switch to beta workspace
- [ ] Verify different export list

#### Delete Export
- [ ] Delete export in alpha workspace
- [ ] Check Network tab: `DELETE /api/v1/files/exports/{filename}` has workspace header
- [ ] Switch to beta
- [ ] Verify alpha export NOT affected in beta's list

### Database Viewer (`/database-viewer.html`)
- [ ] Open database viewer in alpha workspace
- [ ] Select a collection (e.g., `models`)
- [ ] Check Network tab for workspace header
- [ ] Verify only alpha workspace data shown
- [ ] Switch to beta workspace
- [ ] View same collection
- [ ] Verify different data displayed

### Ollama Comparison (`/models-ollama-compare.html`)
- [ ] Open Ollama comparison in alpha workspace
- [ ] Load Ollama hosts
- [ ] Check Network tab: `GET /api/ollama-hosts` has workspace header
- [ ] Note available hosts
- [ ] Switch to beta workspace
- [ ] Verify hosts list (should be workspace-specific if configured)

---

## 🔍 Network Tab Verification

For EVERY test above, verify in Chrome DevTools Network tab:

### Required Headers in Request
```
X-Workspace-Slug: test-workspace-alpha
Content-Type: application/json
```

### Check Response
- Response should contain ONLY workspace-specific data
- No cross-workspace data leakage
- Proper HTTP status codes (200, 201, 204)

---

## 🚨 Security Tests

### Test 1: Manual Header Manipulation
- [ ] Open DevTools → Network → Request
- [ ] Edit and resend with different workspace slug
- [ ] Backend should reject (403 Forbidden) if user not member
- [ ] OR return empty data if user not in workspace

### Test 2: Missing Workspace Header
- [ ] Temporarily disable WorkspaceManager
- [ ] Make API call without header
- [ ] Backend should handle gracefully (default workspace or error)

### Test 3: Invalid Workspace Slug
- [ ] Manually set slug to non-existent workspace
- [ ] Make API call
- [ ] Verify backend returns 404 or empty result

### Test 4: Workspace Switching Speed Test
- [ ] Rapidly switch between workspaces
- [ ] Verify no race conditions
- [ ] Confirm correct data loads each time

---

## 📊 Test Matrix

| Page | Workspace Alpha | Workspace Beta | Isolation Verified |
|------|----------------|----------------|-------------------|
| analytics.html | ⏳ | ⏳ | ⏳ |
| models.html | ⏳ | ⏳ | ⏳ |
| dashboard.html | ⏳ | ⏳ | ⏳ |
| alerts-dashboard.html | ⏳ | ⏳ | ⏳ |
| prompts.html | ⏳ | ⏳ | ⏳ |
| features-admin.html | ⏳ | ⏳ | ⏳ |
| features-adoption.html | ⏳ | ⏳ | ⏳ |
| feature-alignment.html | ⏳ | ⏳ | ⏳ |
| benchmark.html | ⏳ | ⏳ | ⏳ |
| performance.html | ⏳ | ⏳ | ⏳ |
| storage-tool.html | ⏳ | ⏳ | ⏳ |
| database-viewer.html | ⏳ | ⏳ | ⏳ |
| models-ollama-compare.html | ⏳ | ⏳ | ⏳ |

**Legend:** ⏳ Pending | ✅ Passed | ❌ Failed

---

## 🐛 Issue Reporting Template

If you find an issue:

```markdown
## Issue: [Brief Description]

**File:** /public/[filename]
**Endpoint:** [API endpoint]
**Workspace:** [alpha/beta]

**Expected:**
[What should happen]

**Actual:**
[What actually happened]

**Steps to Reproduce:**
1. [Step 1]
2. [Step 2]
3. [Step 3]

**Network Request:**
- URL: [request URL]
- Headers: [copy headers]
- Response: [copy response]

**Screenshots:**
[If applicable]
```

---

## ✅ Sign-Off

After completing all tests:

- [ ] All API calls include workspace headers
- [ ] Data isolation confirmed across all pages
- [ ] No cross-workspace data leakage observed
- [ ] Security tests passed
- [ ] Performance acceptable (< 500ms per request)
- [ ] No console errors
- [ ] UI updates correctly on workspace switch

**Tested By:** _____________  
**Date:** _____________  
**Build:** _____________  
**Environment:** _____________  

---

## 📞 Support

**Issues during testing?**
- Check `/docs/WORKSPACE_API_GUIDE.md` for troubleshooting
- Review `/WORKSPACE_API_INTEGRATION_COMPLETE.md` for implementation details
- Contact: AgentX Development Team

---

**Ready to Test!** 🧪  
Comprehensive checklist for 18 files and 60+ API endpoints.

---

**Last Updated:** January 7, 2026
