# Quick Manual Testing Guide

**Start testing NOW while automated tests are being written!**

## 🚀 Quick Start (2 Minutes)

### Step 1: Open Browser
```
http://localhost:3080/prompts.html
```

### Step 2: Verify Navigation
- ✅ Check top nav bar has "Prompts" link with code icon
- ✅ Click through: Chat → Operations → n8n Monitor → Benchmark → Analytics → Prompts
- ✅ Verify all pages have Prompts link

## 🎯 Feature Testing (10 Minutes)

### Test 1: Onboarding Wizard (2 min)
1. Open browser console (F12)
2. Run: `localStorage.removeItem('agentx_onboarding_completed'); location.reload();`
3. **Expected:** Wizard modal opens automatically
4. Click "Next" through steps 1-5
5. On Step 2, enter:
   - Name: `test_manual`
   - Description: `Manual test prompt`
   - System Prompt: `You are a test assistant.`
6. Click "Get Started" on final step
7. **Expected:** Page reloads, new prompt appears in list

### Test 2: Keyboard Shortcuts (1 min)
1. Press `?` key
2. **Expected:** Shortcuts help modal appears
3. Press `Esc`
4. **Expected:** Modal closes
5. Press `n` key
6. **Expected:** Create prompt modal opens
7. Press `Esc`
8. Press `/` key
9. **Expected:** Search input gets focus

### Test 3: Performance Metrics Dashboard (2 min)
1. Look below the quick stats cards
2. **Expected:** Performance Metrics Dashboard displays
3. Click "30d" button
4. **Expected:** Time range changes, metrics update
5. Click collapse button (chevron)
6. **Expected:** Dashboard content hides
7. Click expand button
8. **Expected:** Dashboard content shows

### Test 4: Advanced Filtering (3 min)
1. Click "More Filters" button
2. **Expected:** Panel slides down
3. Enter text in search box: `default`
4. **Expected:** Prompts filter in real-time
5. Click "Apply Filters" in advanced panel
6. **Expected:** Toast notification appears
7. Click "Clear All Filters"
8. **Expected:** All prompts show again

### Test 5: Export/Import (2 min)
1. Click "Export" button (top right)
2. **Expected:** JSON file downloads (`agentx-prompts-YYYY-MM-DD.json`)
3. Open downloaded file, verify it's valid JSON
4. Click "Import" button
5. **Expected:** File picker opens
6. Select the exported file
7. **Expected:** Import modal shows summary
8. Click "Import" in modal
9. **Expected:** Toast: "Imported X prompts (Y skipped)"

## ✅ Quick Validation Checklist

Copy this to check off as you test:

```
[ ] Navigation shows Prompts link on all pages
[ ] Prompts page loads without errors (check console)
[ ] Onboarding wizard opens automatically
[ ] Onboarding wizard creates prompt successfully
[ ] Keyboard shortcut ? opens help
[ ] Keyboard shortcut n opens create modal
[ ] Keyboard shortcut / focuses search
[ ] Performance dashboard displays
[ ] Performance dashboard time range selector works
[ ] Advanced filters panel toggles
[ ] Search works across name/description/author
[ ] Export downloads JSON file
[ ] Import validates and imports prompts
[ ] Toast notifications appear for actions
[ ] No JavaScript errors in console
```

## 🐛 Common Issues

**Wizard doesn't open:**
- Clear localStorage: `localStorage.clear(); location.reload();`
- Or click "Show Tutorial" button manually

**Metrics dashboard shows "No data":**
- This is normal if no feedback exists
- Dashboard will populate once conversations have feedback

**Import fails:**
- Ensure JSON is valid (check with JSONLint)
- Ensure prompts have required fields: name, systemPrompt

**Search doesn't work:**
- Check console for errors
- Verify prompts are loaded (check network tab)

## 📊 Success Criteria

**All tests pass when:**
1. No console errors
2. All UI elements render correctly
3. All interactions work as expected
4. Toast notifications appear appropriately
5. Data persists after reload (where applicable)

## 🚀 Next Steps

After manual testing:
1. Document any bugs found
2. Run automated E2E tests (when ready)
3. Test on different browsers (Chrome, Firefox, Safari)
4. Test responsive design (mobile/tablet)

---

**Testing Status:**
- ✅ Server-side verification complete
- ⏳ Manual testing in progress
- ⏳ Automated E2E tests being written
- ⏳ Cross-browser testing pending

**Happy Testing! 🎉**
