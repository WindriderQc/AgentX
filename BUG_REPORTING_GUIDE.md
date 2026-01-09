# 🐛 Bug Reporting Guide - For Testing Phase

**Quick reference for reporting bugs during AgentX testing**

---

## 📝 How to Report a Bug

### Option 1: Console Error (Most Common)

**Steps:**
1. Open browser console (F12 → Console tab)
2. See red error message
3. Take screenshot OR copy error text
4. Send to external agent with context

**Example:**
```
Bug found: Console error on Analytics page

Error message:
Uncaught TypeError: Cannot read property 'map' of undefined
    at renderChart (analytics.js:234)
    at loadAnalytics (analytics.js:156)

Steps to reproduce:
1. Go to Analytics page
2. Click "Monthly Stats" tab
3. Error appears, chart doesn't render

Browser: Chrome 120
```

---

### Option 2: UI Issue

**Steps:**
1. Take screenshot of issue
2. Describe what's wrong
3. Describe what you expected
4. Send to external agent

**Example:**
```
Bug found: Navigation overlaps content

Screenshot: [attach image]

What's wrong: Top navigation bar covers the page header
What expected: Page header should be below navigation

Page: /dashboard.html
Browser: Firefox
```

---

### Option 3: API Error

**Steps:**
1. Open Network tab (F12 → Network)
2. See failed request (red)
3. Click on it, check Response tab
4. Send details to agent

**Example:**
```
Bug found: API call failing

Endpoint: GET /api/conversations
Status: 500 Internal Server Error

Response body:
{
  "status": "error",
  "message": "Cannot read property 'workspaceId' of undefined"
}

Steps to reproduce:
1. Log in
2. Go to Chat page
3. Page loads but shows "No conversations"
4. Check Network tab, see 500 error
```

---

### Option 4: Feature Not Working

**Steps:**
1. Describe what you tried to do
2. Describe what happened
3. Describe what should happen
4. Send to agent

**Example:**
```
Bug found: Can't create new workspace

Steps to reproduce:
1. Click "Workspaces" in navigation
2. Click "Create New Workspace"
3. Fill in form (name: "Test Workspace")
4. Click "Create"
5. Form submits but nothing happens
6. No new workspace appears

Expected: New workspace should be created and appear in list

Browser console: No errors
Network tab: POST /api/workspaces returns 200 OK
```

---

## 🎯 Good Bug Report Template

Copy-paste and fill in:

```markdown
## Bug: [Short description]

**Type:** Console Error / UI Issue / API Error / Feature Not Working

**Page/Feature:** [which page or feature]

**Steps to Reproduce:**
1. Step 1
2. Step 2
3. Step 3

**What Happened:**
[Description of the bug]

**What Expected:**
[What should have happened]

**Error Message:** (if applicable)
[Paste error message or attach screenshot]

**Browser:** Chrome / Firefox / Safari / Edge

**Additional Info:**
[Anything else that might help]
```

---

## 💡 Quick Tips

### Before Reporting:

1. **Hard Refresh:** Try Ctrl+F5 (clears cache)
2. **Check Console:** F12 → Console tab (look for errors)
3. **Check Network:** F12 → Network tab (look for failed requests)
4. **Try Different Browser:** Sometimes browser-specific

### Include This Info:

- ✅ Page/feature where bug occurs
- ✅ Steps to reproduce
- ✅ Error message (if any)
- ✅ Screenshot (if UI issue)
- ✅ Browser name

### Don't Need:

- ❌ Technical deep-dive (agent will investigate)
- ❌ Suggested fix (agent will determine best approach)
- ❌ Perfect formatting (just get info to agent fast)

---

## 🚀 Fast Reporting

**Minimum info needed:**
```
Bug: [what's broken]
Page: [where]
Error: [console error text or screenshot]
```

**Agent will handle the rest!**

---

## 🔥 Critical Bugs (Report Immediately)

**P0 - Drop Everything:**
- Site completely down
- Cannot log in
- Data being deleted/corrupted
- Security issue (passwords visible, etc.)

**P1 - High Priority:**
- Main features broken (chat, workspaces, etc.)
- Multiple pages affected
- Blocking your testing

**P2 - Normal:**
- Single feature broken
- Minor inconvenience
- Workaround available

**P3 - Low:**
- Cosmetic issues
- Minor UI polish
- Text/typos

**Default assumption:** Treat as P1 unless you specify otherwise

---

## 📸 Screenshots

**Best Practices:**

1. **Full Page:** Capture entire page if possible
2. **Console Visible:** Include browser console if error
3. **Network Tab:** Include if API error
4. **Highlight Issue:** Circle or arrow to problem area (optional)

**Tools:**
- Windows: Win+Shift+S (snipping tool)
- Mac: Cmd+Shift+4 (screenshot)
- Linux: Screenshot tool or Shift+PrtScn
- Browser: F12 → right-click element → Screenshot node

---

## 🎯 Testing Workflow

**Systematic Testing:**

1. **Start with Core Features:**
   - Login
   - Chat (with/without RAG)
   - Workspaces
   - Navigation

2. **Test Each Page:**
   - Open page
   - Check console (F12)
   - Try main features
   - Report any issues

3. **Test Edge Cases:**
   - Empty data (no conversations)
   - Long text inputs
   - Special characters
   - Mobile view (resize browser)

4. **Test Workflows:**
   - Create → Edit → Delete
   - Switch workspaces
   - Multiple tabs open
   - Refresh page

---

## ⚡ Quick Commands

**Browser Console:**
```javascript
// Check for errors
// (Open Console tab, look for red text)

// Check workspace
console.log(WorkspaceManager.getActiveSlug());

// Test API manually
fetch('/api/conversations', {
  headers: {
    'X-Workspace-Slug': WorkspaceManager.getActiveSlug()
  }
}).then(r => r.json()).then(console.log);
```

**Server Logs:**
```bash
# Check recent errors
pm2 logs agentx --lines 50

# Monitor in real-time
pm2 logs agentx --lines 0
```

---

## 📋 Testing Checklist

Use this to systematically test AgentX:

### Core Features
- [ ] Login works
- [ ] Navigation menu loads
- [ ] Workspace switcher works
- [ ] Can switch between workspaces

### Chat Page
- [ ] Chat page loads
- [ ] Can send message (without RAG)
- [ ] Can send message (with RAG)
- [ ] Message appears in list
- [ ] Can view conversation history
- [ ] Can create new conversation
- [ ] Can delete conversation

### Workspaces
- [ ] Can view workspace list
- [ ] Can create new workspace
- [ ] Can switch workspace
- [ ] Can edit workspace settings
- [ ] Can invite members
- [ ] Can manage member roles

### Dashboard/Operations
- [ ] Dashboard page loads
- [ ] Stats/metrics display
- [ ] Charts render correctly
- [ ] No console errors

### Alerts
- [ ] Alerts page loads
- [ ] Dashboard tab works
- [ ] Analytics tab works
- [ ] Tab switching smooth
- [ ] Can create new alert
- [ ] Can view alert list

### Models
- [ ] Models page loads
- [ ] Can view model list
- [ ] Can add custom model
- [ ] Can configure model

### Analytics
- [ ] Analytics page loads
- [ ] Charts render
- [ ] Date filters work
- [ ] Data displays correctly

### Backup
- [ ] Backup page loads
- [ ] Can see backup list
- [ ] Backup buttons work

### Mobile/Responsive
- [ ] Resize browser to mobile (375px)
- [ ] Navigation works on mobile
- [ ] Pages readable on mobile
- [ ] No horizontal scroll

---

## 🎊 After Each Fix

**Agent will report:**
```
✅ Fixed: [description]
Root cause: [explanation]
Files modified: [list]
```

**You should:**
1. Hard refresh (Ctrl+F5)
2. Test the fixed feature
3. Confirm: "✅ Verified, works now!" or report if still broken
4. Continue testing other features

---

## 💪 Let's Test This Thing!

**Your job:**
- Find bugs (they exist!)
- Report them clearly
- Verify fixes
- Keep testing

**Agent's job:**
- Fix every bug
- Fast turnaround
- No regressions

**Together:** Get AgentX to 100% bug-free! 🚀

---

**Start testing and drop bugs as you find them!**

**No bug too small. Report everything.** 🐛🔨
