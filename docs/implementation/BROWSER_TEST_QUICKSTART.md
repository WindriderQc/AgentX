# Browser Testing Quick Start Guide

**Status:** Server verification ✅ COMPLETE | Browser testing ⏳ READY TO START
**Date:** January 1, 2026

---

## Pre-Flight Check ✅

All server-side verifications passed:

- ✅ Server running on port 3080 (4 worker processes)
- ✅ All component files accessible (HTTP 200)
- ✅ HTML contains all Phase 1.5 elements
- ✅ JavaScript modules export correctly
- ✅ CSS sections integrated (2,858 lines total)
- ✅ API endpoints ready (authentication working)
- ✅ 11/11 automated tests passing (PerformanceMetricsDashboard)

---

## Quick Start (5 Minutes)

### Step 1: Open Browser
```bash
# Open your preferred browser
google-chrome http://localhost:3080/prompts.html
# or
firefox http://localhost:3080/prompts.html
# or just navigate to http://localhost:3080/prompts.html
```

### Step 2: Check Console (Immediate)
1. Open DevTools (F12 or Cmd+Option+I)
2. Go to Console tab
3. Look for errors (should be none)
4. Look for these success messages:
   - "Prompts loaded successfully"
   - "PerformanceMetricsDashboard initialized"
   - "OnboardingWizard checking..."

### Step 3: Visual Inspection (30 seconds)
- [ ] Page renders without broken layout
- [ ] Quick stats show numbers (not "—")
- [ ] Performance Metrics Dashboard visible below stats
- [ ] Search bar and filters visible
- [ ] Prompt list displays (or empty state if no prompts)

### Step 4: Quick Feature Test (2 minutes)

**Test Onboarding Wizard:**
```javascript
// In browser console:
localStorage.removeItem('agentx_onboarding_completed');
location.reload();
```
- Wizard should open automatically
- Walk through Step 1 (Welcome) → Click Next
- Step 2 (Create) → Enter name "test_wizard" and system prompt → Click Next
- Step 3-4 → Click Next
- Step 5 → Click "Get Started"
- Verify prompt appears in list

**Test Keyboard Shortcuts:**
- Press `?` → Shortcuts help should appear
- Press `Esc` → Help closes
- Press `n` → Create prompt modal opens
- Press `Esc` → Modal closes

**Test Advanced Filters:**
- Click "More Filters" → Panel slides down
- Click "Apply Filters" → Toast notification appears
- Click "Clear All Filters" → Toast notification appears

**Test Export/Import:**
- Click "Export" → JSON file downloads
- Click "Import" → File picker opens

### Step 5: Check Performance Dashboard (1 minute)
- Wait for dashboard to load metrics
- Click time range buttons (7d, 30d, 90d)
- Verify metrics update
- Click collapse button → Dashboard hides
- Click expand button → Dashboard shows

---

## Common Issues & Solutions

### Issue: "Authentication required" errors
**Solution:** Make sure you're logged in at http://localhost:3080 first

### Issue: Components not rendering
**Solution:** Check browser console for module loading errors. Verify files are accessible.

### Issue: Onboarding wizard doesn't auto-open
**Solution:** Run in console:
```javascript
localStorage.removeItem('agentx_onboarding_completed');
location.reload();
```

### Issue: Metrics dashboard shows "No data"
**Solution:** This is expected if no feedback exists. Create conversations and add feedback first.

### Issue: Advanced filters don't show tags
**Solution:** Tags only appear if prompts have tags. Add tags to prompts first.

---

## Full Testing Checklist

For comprehensive testing, see: `/docs/implementation/phase-1.5-testing-report.md`

**Test Suites:**
1. Performance Metrics Dashboard (7 tests)
2. Onboarding Wizard (9 tests)
3. Keyboard Shortcuts (6 tests)
4. Advanced Filtering (9 tests)
5. Export/Import (10 tests)
6. Responsive Design (3 tests)
7. Cross-Browser Compatibility (4 tests)
8. Performance Testing (4 tests)
9. Security Testing (3 tests)
10. Accessibility Testing (3 tests)
11. Integration Testing (2 tests)
12. Regression Testing (1 test)

**Total: 61 test cases**

---

## Critical Paths to Test

These are the most important user journeys:

### Path 1: First-Time User (5 minutes)
1. Clear localStorage
2. Reload page
3. Onboarding wizard opens
4. Complete wizard
5. Create first prompt
6. Prompt appears in list

### Path 2: Advanced Filtering (3 minutes)
1. Create 5+ prompts with different tags/authors
2. Open advanced filters
3. Select tags
4. Apply filters
5. Verify filtering works
6. Clear filters

### Path 3: Export/Import (3 minutes)
1. Export all prompts
2. Delete one prompt
3. Import exported file
4. Choose "Skip duplicates"
5. Verify deleted prompt restored

### Path 4: Keyboard Workflow (2 minutes)
1. Press `/` → Search focuses
2. Type search term
3. Press `Esc` → Clear search
4. Press `n` → Create modal opens
5. Press `Esc` → Modal closes
6. Press `?` → Help appears

---

## Performance Benchmarks

Expected performance metrics:

| Metric | Target | Critical Threshold |
|--------|--------|--------------------|
| Page Load | < 2s | < 5s |
| Component Init | < 500ms | < 1s |
| Filter Apply | < 50ms | < 200ms |
| Export (100 prompts) | < 1s | < 3s |
| Import (100 prompts) | < 5s | < 15s |
| Metrics Dashboard Load | < 100ms | < 500ms |

---

## Browser Compatibility Matrix

Recommended browsers:

| Browser | Version | Status |
|---------|---------|--------|
| Chrome | 90+ | ✅ Recommended |
| Firefox | 88+ | ✅ Recommended |
| Safari | 14+ | ⚠️ Test date inputs |
| Edge | 90+ | ✅ Recommended |

---

## Reporting Issues

If you find bugs, document:

1. **Steps to reproduce**
2. **Expected behavior**
3. **Actual behavior**
4. **Browser & version**
5. **Console errors** (screenshot or copy)
6. **Network tab** (if API related)

Create issues in: `/docs/implementation/phase-1.5-issues.md` (or your issue tracker)

---

## Success Criteria

Phase 1.5 is COMPLETE when:

- ✅ All 5 optional enhancements implemented
- ✅ Server-side verification passed
- ⏳ All critical paths tested in browser
- ⏳ No critical bugs found
- ⏳ Works in 2+ browsers
- ⏳ Mobile responsive verified

---

## Next Steps

1. **NOW:** Open http://localhost:3080/prompts.html
2. Run Quick Start tests (5 minutes)
3. If all pass → Run full test suite (30-45 minutes)
4. Document any issues found
5. Mark Phase 1.5 as COMPLETE ✅

---

**Ready to test!** Open your browser and start with the Quick Start section above.
