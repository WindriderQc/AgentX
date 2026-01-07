# External Agent Task: Fix default_chat 404 Bug

**Date:** 2026-01-07
**Priority:** HIGH
**Bug Severity:** HIGH
**Estimated Effort:** 1-2 hours
**Bug Report:** `/docs/bugs/agentx/2026-01-07__agentx__prompts__default-chat-404.md`

---

## Bug Summary

**Issue:** `GET /api/prompts/default_chat?workspace=testing-workspace` returns HTTP 404 instead of 200 with empty array

**Symptom:**
```javascript
// Console error in chat UI:
GET http://192.168.2.33:3080/api/prompts/default_chat?workspace=testing-workspace 404 (Not Found)
```

**Expected:** Should return `{ status: 'success', data: [] }` with HTTP 200

---

## Root Cause (Discovered by Explore Agent)

The bug is **NOT in the prompts route handler** - it's in the **workspace middleware** blocking the request before the route handler runs.

### Failure Chain:

1. Request: `GET /api/prompts/default_chat?workspace=testing-workspace`
2. `attachWorkspace` middleware runs (from `/routes/prompts.js:71`)
3. Middleware extracts `workspaceSlug = "testing-workspace"` from query param
4. Middleware calls `Workspace.getBySlug("testing-workspace")`
5. **If workspace doesn't exist in database**, `getBySlug` throws error with `statusCode: 404`
6. Middleware catches error and returns:
   ```json
   { "status": "error", "message": "Workspace not found" }
   ```
   with HTTP **404 status**
7. **Route handler never executes** → Graceful fallback in prompts route (line 99) never runs

###The Problem:

**File:** `/src/middleware/workspace.js` (lines 105-122)

```javascript
// Line 105-106: Load workspace
const workspace = await Workspace.getBySlug(workspaceSlug);
req.workspace = workspace;

// ... later in catch block (lines 118-122):
if (error.statusCode === 404) {
  return res.status(404).json({
    status: 'error',
    message: 'Workspace not found'
  });
}
```

**Why this is wrong for prompts routes:**

The `attachWorkspace` middleware is **too strict** for read-only routes like prompts. It enforces that if a workspace slug is provided, it MUST exist and be valid. This is correct for workspace-specific operations (creating conversations, managing settings), but incorrect for read-only queries that should gracefully degrade when workspace context is invalid.

---

## Solution

**Create new middleware: `optionalWorkspaceContext`**

This middleware:
- ✅ Allows requests without workspace context (sets `req.workspace = null`)
- ✅ Loads workspace if valid slug provided
- ✅ Sets `req.workspace = null` if workspace slug provided but invalid (doesn't reject)
- ✅ Lets route handler decide what to do with null workspace
- ✅ Never returns 404 for missing workspace (route handler's responsibility)

---

## Implementation Steps

### Step 1: Create New Middleware Function

**File:** `/src/middleware/workspace.js`

**Add after `attachWorkspace` function:**

```javascript
/**
 * optionalWorkspaceContext middleware
 *
 * Loads workspace context if provided but doesn't reject request if workspace is invalid.
 * Use this for read-only routes that should gracefully handle missing workspace context.
 *
 * Behavior:
 * - If workspace slug not provided → req.workspace = null (continue)
 * - If workspace slug provided and valid → req.workspace = loaded workspace (continue)
 * - If workspace slug provided but invalid → req.workspace = null (continue, don't reject)
 *
 * Route handler must handle null workspace appropriately.
 */
async function optionalWorkspaceContext(req, res, next) {
  try {
    // Extract workspace slug from query, header, or default
    // (same logic as attachWorkspace)
    let workspaceSlug = req.query.workspace || req.header('X-Workspace');

    // If user exists, check for default workspace
    if (!workspaceSlug && res.locals.user) {
      // Future: Get user's default workspace from UserProfile
      // For now, just continue without workspace
      req.workspace = null;
      return next();
    }

    // If no workspace slug provided, continue without workspace
    if (!workspaceSlug) {
      req.workspace = null;
      return next();
    }

    // Try to load workspace
    try {
      const workspace = await Workspace.getBySlug(workspaceSlug);
      req.workspace = workspace;
    } catch (error) {
      // If workspace not found or any error, set null and continue
      // Route handler will decide if null workspace is acceptable
      req.workspace = null;
      logger.warn('Optional workspace context: workspace not found', {
        slug: workspaceSlug,
        error: error.message
      });
    }

    next();

  } catch (error) {
    // Unexpected error in middleware itself
    logger.error('optionalWorkspaceContext middleware error', {
      error: error.message,
      stack: error.stack
    });

    // Continue with null workspace rather than rejecting
    req.workspace = null;
    next();
  }
}
```

### Step 2: Export New Middleware

**File:** `/src/middleware/workspace.js` (at bottom)

**Update exports:**

```javascript
module.exports = {
  attachWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  requireOwner,
  optionalWorkspaceContext  // NEW EXPORT
};
```

### Step 3: Update Prompts Routes

**File:** `/routes/prompts.js`

**Update imports (line 10):**

```javascript
const { attachWorkspace } = require('../src/middleware/workspace');  // OLD

// Change to:
const { attachWorkspace, optionalWorkspaceContext } = require('../src/middleware/workspace');  // NEW
```

**Update GET routes to use new middleware:**

**Route 1: GET /api/prompts (line 18)**

```javascript
// OLD:
router.get('/', optionalAuth, attachWorkspace, async (req, res) => {

// NEW:
router.get('/', optionalAuth, optionalWorkspaceContext, async (req, res) => {
```

**Route 2: GET /api/prompts/:name (line 71)**

```javascript
// OLD:
router.get('/:name', optionalAuth, attachWorkspace, async (req, res) => {

// NEW:
router.get('/:name', optionalAuth, optionalWorkspaceContext, async (req, res) => {
```

**Keep POST/PATCH/DELETE routes using `attachWorkspace`** (they should enforce valid workspace)

---

### Step 4: Update Route Handler Logic (Optional Enhancement)

**File:** `/routes/prompts.js`

The existing graceful handling in lines 95-100 should now work:

```javascript
if (prompts.length === 0) {
    // The chat UI polls for default_chat during init; returning a 404 is noisy and not actionable.
    // Treat "missing default" as a valid state.
    if (name === 'default_chat') {
        return res.json({ status: 'success', data: [] });
    }
    return res.status(404).json({ status: 'error', message: 'Prompt not found' });
}
```

**Optional enhancement** - Add explicit null workspace handling:

```javascript
// At the start of GET /api/prompts/:name handler (after line 72):
const name = req.params.name;

// If workspace context was requested but failed to load, log warning
if (req.query.workspace && !req.workspace) {
    logger.warn('Workspace context requested but not found', {
        slug: req.query.workspace,
        promptName: name
    });
    // Continue with legacy prompt lookup (no workspaceId filter)
}

const query = { name };

// Rest of existing code...
```

---

## Testing

### Test 1: Invalid Workspace Slug

**Request:**
```bash
curl -X GET "http://localhost:3080/api/prompts/default_chat?workspace=nonexistent-workspace"
```

**Expected Before Fix:**
```json
HTTP 404
{ "status": "error", "message": "Workspace not found" }
```

**Expected After Fix:**
```json
HTTP 200
{ "status": "success", "data": [] }
```

**Or if legacy default_chat exists:**
```json
HTTP 200
{
  "status": "success",
  "data": [
    {
      "_id": "...",
      "name": "default_chat",
      "version": 1,
      "systemPrompt": "...",
      "isActive": true,
      ...
    }
  ]
}
```

---

### Test 2: No Workspace Context

**Request:**
```bash
curl -X GET "http://localhost:3080/api/prompts/default_chat"
```

**Expected (Before and After - should work):**
```json
HTTP 200
{ "status": "success", "data": [] }
```

**Or returns legacy prompt if exists**

---

### Test 3: Valid Workspace Slug

**Request:**
```bash
curl -X GET "http://localhost:3080/api/prompts/default_chat?workspace=valid-workspace-slug"
```

**Expected (Before and After - should work):**
```json
HTTP 200
{
  "status": "success",
  "data": [ /* workspace-specific prompts */ ]
}
```

---

### Test 4: Chat UI Integration

**Steps:**
1. Open chat page: `http://localhost:3080/index.html`
2. Open browser DevTools → Network tab
3. Look for request: `GET /api/prompts/default_chat?workspace=...`

**Expected After Fix:**
- ✅ No 404 errors in console
- ✅ Request returns 200 with empty array or prompt data
- ✅ Chat UI loads without errors

---

### Test 5: POST/PATCH/DELETE Still Enforce Workspace

**Verify that mutation operations still require valid workspace:**

**Request:**
```bash
curl -X POST "http://localhost:3080/api/prompts?workspace=nonexistent" \
  -H "Content-Type: application/json" \
  -d '{"name": "test", "systemPrompt": "test"}'
```

**Expected (Should still get 404):**
```json
HTTP 404
{ "status": "error", "message": "Workspace not found" }
```

**Why:** POST route still uses `attachWorkspace`, not `optionalWorkspaceContext`

---

## Verification Checklist

After implementing:

- [ ] New middleware `optionalWorkspaceContext` created in `/src/middleware/workspace.js`
- [ ] Middleware exported in module.exports
- [ ] Imported in `/routes/prompts.js`
- [ ] GET `/api/prompts` uses `optionalWorkspaceContext`
- [ ] GET `/api/prompts/:name` uses `optionalWorkspaceContext`
- [ ] POST/PATCH/DELETE routes still use `attachWorkspace` (unchanged)
- [ ] Test 1 passes: Invalid workspace → 200 with empty array
- [ ] Test 2 passes: No workspace → 200 with legacy prompts
- [ ] Test 3 passes: Valid workspace → 200 with workspace prompts
- [ ] Test 4 passes: Chat UI loads without 404 errors
- [ ] Test 5 passes: POST still enforces valid workspace
- [ ] No console errors in browser
- [ ] No server errors in logs

---

## Bug Report Updates

After fix verified, update bug report:

**File:** `/docs/bugs/agentx/2026-01-07__agentx__prompts__default-chat-404.md`

**Fill in "Fix Summary" section:**

```markdown
## Fix Summary (filled after fix)
- Root cause: `attachWorkspace` middleware too strict for read-only routes. Rejected requests when workspace slug provided but invalid, preventing route handler's graceful fallback logic from executing.
- Fix: Created new middleware `optionalWorkspaceContext` that loads workspace if valid but sets `req.workspace = null` (instead of rejecting) if workspace invalid or missing. Updated GET routes in `/routes/prompts.js` to use new middleware while keeping POST/PATCH/DELETE using strict `attachWorkspace`.
- Tests added/updated: Manual testing confirmed invalid workspace slugs now return 200 with empty array for `default_chat`, chat UI loads without 404 errors.
- Rule added/updated: Rule: For read-only routes that should gracefully handle missing workspace context, use `optionalWorkspaceContext` middleware instead of `attachWorkspace`. Reserve `attachWorkspace` for mutation operations that require valid workspace.
- Verified by: Manual testing all 5 test scenarios, chat UI integration test, server logs clean.
```

---

## Expected Impact

### Before Fix:
- ❌ Chat UI shows 404 errors in console
- ❌ Users with invalid/missing workspaces can't load default prompt
- ❌ Noisy error logs

### After Fix:
- ✅ Chat UI loads cleanly without 404 errors
- ✅ Graceful degradation when workspace invalid (falls back to legacy prompts)
- ✅ Proper separation: GET routes lenient, POST/PATCH/DELETE routes strict
- ✅ Clean logs (warnings for invalid workspace, not errors)

---

## Alternative Solutions (NOT Recommended)

**Option 1: Remove workspace filtering from prompts entirely**
- Too drastic - loses multi-tenancy benefits
- Would require significant refactoring

**Option 2: Modify `attachWorkspace` to be lenient**
- Would affect all routes using it (unintended consequences)
- Mutation operations need strict workspace validation

**Option 3: Check workspace validity in route handler**
- Duplicates logic across multiple routes
- Harder to maintain

**Why `optionalWorkspaceContext` is best:**
- ✅ Surgical fix (only affects read-only routes that need it)
- ✅ Clear intent (name indicates optional context)
- ✅ Reusable (other routes can use if needed)
- ✅ Maintains strict validation for mutations

---

## Success Criteria

- [x] New middleware `optionalWorkspaceContext` created
- [x] Middleware correctly handles 3 cases: no slug, valid slug, invalid slug
- [x] GET prompts routes use new middleware
- [x] POST/PATCH/DELETE prompts routes unchanged (still use `attachWorkspace`)
- [x] Chat UI loads without 404 errors
- [x] Invalid workspace slug → 200 with empty array (not 404)
- [x] Valid workspace slug → 200 with workspace-specific prompts
- [x] Server logs clean (warnings only, not errors)
- [x] Bug report updated with fix summary

---

**Good luck! This is a straightforward middleware refactor with clear test cases.**

---

**Task Specification Version:** 1.0
**Created:** 2026-01-07
**Priority:** HIGH (blocks chat UI initialization)
