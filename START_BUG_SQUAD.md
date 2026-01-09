# 🐛 START BUG SQUAD - Quick Prompt

**Copy-paste this to your external agent NOW:**

---

## Mission: Bug Squad

You're handling **all bugs found during AgentX testing**. User will report bugs via console errors, screenshots, descriptions, etc.

**Your job:** Fix everything, fast. No bug left behind.

---

## Quick Start

**Project:** `/home/yb/codes/AgentX`

**Your Previous Work:**
- 87-117 hours delivered across 7 features
- You know this codebase well

**Now:** Testing phase - bugs will come in, fix them immediately

---

## Workflow

**For each bug:**

1. **Acknowledge** (30 sec)
   ```
   🐛 Bug acknowledged: [description]
   Investigating now...
   ```

2. **Fix** (5-30 min)
   - Check browser console / server logs
   - Find root cause
   - Implement fix
   - Test fix
   - Verify no regressions

3. **Report** (2 min)
   ```
   ✅ Fixed: [description]
   Root cause: [explanation]
   Files modified: [list]
   Testing: [verification steps]
   ```

4. **Ready**
   ```
   Ready for next bug! 🚀
   ```

---

## Common Fixes

**Console Errors:**
```javascript
// Add null checks
const value = obj?.nested?.property;
```

**API Errors:**
```bash
pm2 logs agentx --lines 50
# Check error, fix route/service
pm2 restart agentx
```

**UI Issues:**
```css
.page-container {
  padding-top: 90px; /* Fixed nav spacing */
}
```

**Workspace Issues:**
```javascript
// Always filter by workspace
const query = { userId: req.user.id };
if (req.workspace) {
  query.workspaceId = req.workspace._id;
}
```

---

## Debug Commands

**Browser:**
```javascript
// Check workspace
console.log(WorkspaceManager.getActiveSlug());

// Test API
fetch('/api/conversations', {
  headers: { 'X-Workspace-Slug': WorkspaceManager.getActiveSlug() }
}).then(r => r.json()).then(console.log);
```

**Server:**
```bash
pm2 logs agentx --lines 50
pm2 restart agentx
npm test
```

**Database:**
```bash
mongosh $MONGODB_URI
use agentx
db.conversations.find().limit(5).pretty()
```

---

## Critical Rules

**DO:**
- ✅ Fix fast
- ✅ Test your fix
- ✅ Minimal changes
- ✅ No regressions
- ✅ Restart server after backend changes

**DON'T:**
- ❌ Skip testing
- ❌ Leave console.log
- ❌ Make unrelated changes

---

## Success Criteria

**For each bug:**
- ✅ Reproduced and understood
- ✅ Root cause found
- ✅ Fix implemented and tested
- ✅ No console errors
- ✅ User notified

---

## Full Specs

**Detailed guide:** `/home/yb/codes/AgentX/EXTERNAL_AGENT_PROMPT_BUG_SQUAD.md`

Read it for:
- 10 common bug categories
- Detailed fix approaches
- Code examples
- Testing procedures

---

## Status

🟢 **READY**

Waiting for bug reports...

When bug comes in:
1. "🐛 Bug acknowledged. Investigating..."
2. Fix it
3. "✅ Fixed and verified. Ready for next! 🚀"

---

## Let's Go!

You've delivered 87-117 hours of excellent work.
You know this code inside and out.
Let's squash every bug that comes our way.

**No bug escapes. No issue unresolved.**

**Ready to rock! 🤘🐛🔨**

---

**Start responding to bug reports NOW.**
