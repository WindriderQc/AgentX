# External Agent Task: API Workspace Context Integration

**Date:** 2026-01-07
**Priority:** HIGH
**Estimated Effort:** 6-8 hours
**Context:** Workspace Loading Fix Follow-Up - Phase 2

---

## Task Overview

Add workspace context to API calls across 16 pages that were recently fixed to load `workspace.js`. While navigation now works, API calls still lack workspace headers/parameters, causing potential data leakage between workspaces.

**What Exists:**
- ✅ `workspace.js` loaded on all 16 pages (fixed 2026-01-07)
- ✅ `WorkspaceManager` global object available
- ✅ Helper methods: `addWorkspaceHeader()`, `addWorkspaceParam()`, `getCurrentSlug()`
- ✅ Backend middleware: `attachWorkspace`, `optionalWorkspaceContext`
- ❌ API calls do NOT include workspace context

**What You'll Build:**
- Enhance API client classes to auto-inject workspace headers
- Update all API calls on 16 pages to include workspace context
- Create workspace-aware fetch wrapper utilities
- Add integration tests to verify workspace isolation

---

## Problem Statement

### Current State (Broken)
```javascript
// analytics.js - NO workspace context
const data = await fetch('/api/analytics/usage');
// Returns data from ALL workspaces for this user
```

### Desired State (Fixed)
```javascript
// analytics.js - WITH workspace context
const data = await fetch('/api/analytics/usage',
  WorkspaceManager.addWorkspaceHeader({ credentials: 'include' })
);
// Returns data ONLY from current workspace
```

### Security Risk
Without workspace context, users can see data from ALL their workspaces mixed together, even when a specific workspace is selected. This breaks workspace isolation.

---

## Implementation Strategy

### Phase 1: Create Shared Utilities (1 hour)
1. Create `/public/js/utils/workspace-api.js` (NEW FILE)
2. Export workspace-aware fetch wrapper
3. Export enhanced ApiClient class
4. Export helper functions

### Phase 2: Update API Client Classes (2 hours)
1. Enhance `ApiClient` in `/public/js/utils/api-client.js`
2. Update `PromptsAPI` in `/public/js/api/promptsAPI.js`
3. Add workspace injection to all request methods

### Phase 3: Update Page-Specific API Calls (3-4 hours)
1. Analytics page - 8 endpoints
2. Dashboard page - 10 endpoints
3. Models page - 6 endpoints
4. Alerts page - 5 endpoints
5. Prompts page - 5 endpoints
6. Feature pages - Various endpoints

### Phase 4: Testing & Verification (1 hour)
1. Create test scenarios for workspace isolation
2. Verify data filtering works correctly
3. Test workspace switching updates API calls
4. Browser console verification

---

## Detailed Implementation Steps

### STEP 1: Create Workspace API Utilities (NEW FILE)

**File:** `/public/js/utils/workspace-api.js`

```javascript
/**
 * Workspace-Aware API Utilities
 *
 * Provides helper functions and classes to ensure all API calls
 * include proper workspace context headers.
 */

/**
 * Workspace-aware fetch wrapper
 * @param {string} url - API endpoint
 * @param {object} options - Fetch options
 * @returns {Promise<Response>}
 */
export async function workspaceFetch(url, options = {}) {
  // Ensure workspace context is added
  const wsOptions = window.WorkspaceManager
    ? window.WorkspaceManager.addWorkspaceHeader(options)
    : options;

  // Always include credentials
  wsOptions.credentials = wsOptions.credentials || 'include';

  return fetch(url, wsOptions);
}

/**
 * Workspace-aware fetch with JSON parsing
 * @param {string} url - API endpoint
 * @param {object} options - Fetch options
 * @returns {Promise<any>} - Parsed JSON response
 */
export async function workspaceFetchJSON(url, options = {}) {
  const response = await workspaceFetch(url, options);

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      message: response.statusText
    }));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Get current workspace headers
 * @returns {object} Headers object with workspace context
 */
export function getWorkspaceHeaders() {
  if (!window.WorkspaceManager) {
    return {};
  }

  const slug = window.WorkspaceManager.getCurrentSlug();
  return slug ? { 'X-Workspace-Slug': slug } : {};
}

/**
 * Add workspace query parameter to URL
 * @param {string} url - Base URL
 * @returns {string} URL with workspace parameter
 */
export function addWorkspaceParam(url) {
  if (!window.WorkspaceManager) {
    return url;
  }

  return window.WorkspaceManager.addWorkspaceParam(url);
}

/**
 * Enhanced ApiClient with automatic workspace injection
 */
export class WorkspaceApiClient {
  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl;
  }

  /**
   * Make workspace-aware API request
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;

    // Add workspace headers
    const headers = {
      'Content-Type': 'application/json',
      ...getWorkspaceHeaders(),
      ...(options.headers || {})
    };

    const fetchOptions = {
      ...options,
      headers,
      credentials: 'include'
    };

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        message: response.statusText
      }));
      throw new Error(error.message || `API error: ${response.status}`);
    }

    return response.json();
  }

  async get(endpoint, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const url = queryString ? `${endpoint}?${queryString}` : endpoint;
    return this.request(url, { method: 'GET' });
  }

  async post(endpoint, body = {}) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async put(endpoint, body = {}) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  }

  async delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  }
}
```

---

### STEP 2: Update Existing ApiClient Class

**File:** `/public/js/utils/api-client.js` (MODIFY)

**Current Implementation (lines ~1-100):**
```javascript
class ApiClient {
  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl;
  }

  async request(endpoint, options = {}) {
    // NO workspace context injected here
    const response = await fetch(`${this.baseUrl}${endpoint}`, options);
    // ... error handling
  }
}
```

**Updated Implementation:**
```javascript
class ApiClient {
  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;

    // ✅ INJECT WORKSPACE CONTEXT
    let fetchOptions = { ...options };
    if (window.WorkspaceManager) {
      fetchOptions = window.WorkspaceManager.addWorkspaceHeader(fetchOptions);
    }

    // Ensure credentials are always included
    fetchOptions.credentials = fetchOptions.credentials || 'include';

    const response = await fetch(url, fetchOptions);

    // ... rest of existing error handling
    return response;
  }

  // get(), post(), put(), delete() methods remain the same
}
```

**Changes:**
- Add workspace header injection in `request()` method
- Check for `window.WorkspaceManager` availability
- Preserve all existing error handling logic

---

### STEP 3: Update PromptsAPI Class

**File:** `/public/js/api/promptsAPI.js` (MODIFY)

**Find all fetch() calls (there are ~10+) and wrap with workspace headers:**

**Pattern to replace:**
```javascript
// BEFORE
const response = await fetch(url, {
  method: 'GET',
  credentials: 'include'
});
```

**Replace with:**
```javascript
// AFTER
let options = {
  method: 'GET',
  credentials: 'include'
};
if (window.WorkspaceManager) {
  options = window.WorkspaceManager.addWorkspaceHeader(options);
}
const response = await fetch(url, options);
```

**Or create helper method at class level:**
```javascript
class PromptsAPI {
  constructor(baseUrl = '/api/prompts') {
    this.baseUrl = baseUrl;
  }

  // Add helper method
  _fetch(url, options = {}) {
    let fetchOptions = { ...options, credentials: 'include' };
    if (window.WorkspaceManager) {
      fetchOptions = window.WorkspaceManager.addWorkspaceHeader(fetchOptions);
    }
    return fetch(url, fetchOptions);
  }

  async listAll() {
    const response = await this._fetch(`${this.baseUrl}`);
    // ... rest of logic
  }

  async getByName(promptName) {
    const url = `${this.baseUrl}/${encodeURIComponent(promptName)}`;
    const response = await this._fetch(url);
    // ... rest of logic
  }

  // Update all other methods to use this._fetch()
}
```

---

### STEP 4: Update Analytics Page

**File:** `/public/js/analytics.js` (MODIFY ~1,264 lines)

**Find these API calls:**

1. **Line ~100-150: Usage Analytics**
```javascript
// BEFORE
const response = await fetch(`/api/analytics/usage?${params}`, {
  credentials: 'include'
});

// AFTER
const response = await fetch(`/api/analytics/usage?${params}`,
  WorkspaceManager.addWorkspaceHeader({ credentials: 'include' })
);
```

2. **Line ~200-250: Feedback Analytics**
```javascript
// BEFORE
const response = await fetch(`/api/analytics/feedback?${params}`, {
  credentials: 'include'
});

// AFTER
const response = await fetch(`/api/analytics/feedback?${params}`,
  WorkspaceManager.addWorkspaceHeader({ credentials: 'include' })
);
```

3. **Line ~300-350: Cost Analytics**
```javascript
// BEFORE
const response = await fetch(`/api/analytics/costs?${params}`, {
  credentials: 'include'
});

// AFTER
const response = await fetch(`/api/analytics/costs?${params}`,
  WorkspaceManager.addWorkspaceHeader({ credentials: 'include' })
);
```

4. **Line ~400-450: RAG Stats**
```javascript
// BEFORE
const response = await fetch(`/api/analytics/rag-stats?${params}`, {
  credentials: 'include'
});

// AFTER
const response = await fetch(`/api/analytics/rag-stats?${params}`,
  WorkspaceManager.addWorkspaceHeader({ credentials: 'include' })
);
```

5. **Additional endpoints (search for `fetch('/api/`):**
- `/api/metrics/summary`
- `/api/metrics/database`
- `/api/rag/metrics`
- `/api/metrics/cache/clear` (POST)

**Pattern:** Find all `fetch()` calls, wrap options with `WorkspaceManager.addWorkspaceHeader()`

---

### STEP 5: Update Models Page

**File:** `/public/js/models.js` (MODIFY ~lines vary)

**API Calls to Update:**

1. **List Models**
```javascript
// BEFORE
const response = await fetch(`${window.location.origin}/api/custom-models`);

// AFTER
const response = await fetch(`${window.location.origin}/api/custom-models`,
  WorkspaceManager.addWorkspaceHeader({ credentials: 'include' })
);
```

2. **Register Model (POST)**
```javascript
// BEFORE
const response = await fetch('/api/custom-models', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(modelData)
});

// AFTER
const response = await fetch('/api/custom-models',
  WorkspaceManager.addWorkspaceHeader({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(modelData),
    credentials: 'include'
  })
);
```

3. **Deploy Model (POST)**
```javascript
// BEFORE
await fetch(`/api/custom-models/${modelId}/deploy`, {
  method: 'POST'
});

// AFTER
await fetch(`/api/custom-models/${modelId}/deploy`,
  WorkspaceManager.addWorkspaceHeader({
    method: 'POST',
    credentials: 'include'
  })
);
```

4. **Get Model Stats, History, Delete** - Same pattern

**Note:** Models page uses direct `fetch()` calls throughout - each needs workspace header wrapper

---

### STEP 6: Update Dashboard Page

**File:** `/public/js/dashboard.js` (MODIFY ~821 lines)

**Current Pattern:** Uses `API` helper from `./utils/index.js`

**Option A: Update API Helper (Recommended)**

Find the `API` module export in `/public/js/utils/index.js`:
```javascript
// BEFORE
export const API = {
  get: (url) => fetch(url, { credentials: 'include' }),
  post: (url, data) => fetch(url, {
    method: 'POST',
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  })
};

// AFTER
export const API = {
  get: (url, options = {}) => {
    const opts = WorkspaceManager.addWorkspaceHeader({
      ...options,
      credentials: 'include'
    });
    return fetch(url, opts);
  },
  post: (url, data, options = {}) => {
    const opts = WorkspaceManager.addWorkspaceHeader({
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...options
    });
    return fetch(url, opts);
  }
};
```

**Option B: Update Each Call in dashboard.js** (if API helper is not easily modifiable)

Find all `API.get()` and `API.post()` calls and replace:
```javascript
// BEFORE
const data = await API.get('/api/dashboard/summary');

// AFTER
const data = await fetch('/api/dashboard/summary',
  WorkspaceManager.addWorkspaceHeader({ credentials: 'include' })
);
```

---

### STEP 7: Update Alerts Dashboard

**File:** `/public/js/alerts-dashboard.js` (MODIFY ~763 lines)

**Current Pattern:** Uses `apiClient` from `./utils/api-client.js`

Since we're updating `ApiClient` class in Step 2, this page should automatically get workspace context IF it's using the updated class.

**Verification Steps:**
1. Confirm `alerts-dashboard.js` imports `ApiClient` from `./utils/api-client.js`
2. If yes → No changes needed (automatic from Step 2)
3. If no → Find direct `fetch()` calls and wrap with workspace headers

**Example import to look for:**
```javascript
import { ApiClient } from './utils/api-client.js';
const apiClient = new ApiClient('/api');
```

---

### STEP 8: Update Feature Pages (Bulk Update)

**Files:**
- `/public/js/features-inventory.js`
- `/public/js/features-telemetry.js`
- `/public/js/features-adoption.js`
- `/public/js/features-admin.js`
- `/public/js/feature-alignment.js`

**Pattern:** These pages likely have embedded `<script>` tags with API calls

**Search for:**
```javascript
fetch('/api/features/
fetch('/api/scanner/
```

**Replace with workspace-aware wrapper:**
```javascript
// At top of script block, import or use global
const wsFetch = (url, options) => {
  return fetch(url, WorkspaceManager.addWorkspaceHeader({
    credentials: 'include',
    ...options
  }));
};

// Then use wsFetch() instead of fetch()
const data = await wsFetch('/api/features/inventory');
```

---

### STEP 9: Update Remaining Pages

**Files:**
- `/public/backup.html` - Backup API calls
- `/public/alert-analytics.html` - Alert analytics
- `/public/benchmark.html` - Benchmark API (WARNING: 345KB file)
- `/public/performance.html` - Performance metrics

**Same pattern as Step 8** - Search for `fetch('/api/` and wrap with workspace headers

---

## Testing Instructions

### Test Environment Setup

1. **Create 2 Test Workspaces**
```
Workspace A: "Test Workspace Alpha"
Workspace B: "Test Workspace Beta"
```

2. **Create Test Data in Each Workspace**
- In Workspace A: Create 3 conversations, add custom model, create alert
- In Workspace B: Create 2 conversations, different custom model, different alert

### Test Scenarios

#### Scenario 1: Analytics Data Isolation

1. Select "Test Workspace Alpha"
2. Navigate to http://localhost:3080/analytics.html
3. Open DevTools → Network tab
4. Refresh page
5. **Verify:**
   - ✅ Request to `/api/analytics/usage` includes header `X-Workspace-Slug: test-workspace-alpha`
   - ✅ Response contains ONLY data from Workspace Alpha
   - ✅ Data count matches expected (3 conversations)

6. Switch to "Test Workspace Beta" (use dropdown)
7. **Verify:**
   - ✅ Page reloads
   - ✅ Request includes header `X-Workspace-Slug: test-workspace-beta`
   - ✅ Response contains ONLY data from Workspace Beta
   - ✅ Data count changes (2 conversations)

#### Scenario 2: Models Page Isolation

1. Select "Test Workspace Alpha"
2. Navigate to http://localhost:3080/models.html
3. **Verify:**
   - ✅ Custom models list shows ONLY models registered in Workspace Alpha
   - ✅ Network request includes `X-Workspace-Slug` header

4. Switch to "Test Workspace Beta"
5. **Verify:**
   - ✅ Custom models list updates to Workspace Beta models
   - ✅ Different model list displayed

#### Scenario 3: Dashboard Workspace Context

1. Navigate to http://localhost:3080/dashboard.html
2. **Verify:**
   - ✅ All API calls (`/api/dashboard/summary`, `/api/dashboard/stats`) include workspace header
   - ✅ Collection stats reflect current workspace only
   - ✅ Event log shows workspace-specific events

#### Scenario 4: Alerts Filtering

1. Navigate to http://localhost:3080/alerts.html
2. **Verify:**
   - ✅ Alert list filtered by current workspace
   - ✅ Acknowledging alert in Workspace A doesn't affect Workspace B alerts

#### Scenario 5: Cross-Page Workspace Persistence

1. Select "Test Workspace Alpha"
2. Navigate through: Chat → Analytics → Models → Dashboard
3. **Verify:**
   - ✅ Workspace dropdown shows "Test Workspace Alpha" on all pages
   - ✅ All API calls include correct workspace header
   - ✅ LocalStorage `agentx_current_workspace` persists

### Browser Console Verification

Run this in console on each page:
```javascript
// Check workspace context
console.log('Current workspace:', WorkspaceManager.currentWorkspace);

// Monitor next API call
const originalFetch = window.fetch;
window.fetch = function(...args) {
  console.log('Fetch URL:', args[0]);
  console.log('Fetch options:', args[1]);
  console.log('Workspace header:', args[1]?.headers?.['X-Workspace-Slug']);
  return originalFetch.apply(this, args);
};

// Then trigger an API call and check console output
```

### Automated Test Script (Optional)

```javascript
// test-workspace-isolation.js
async function testWorkspaceIsolation() {
  const workspaces = ['workspace-alpha', 'workspace-beta'];
  const results = [];

  for (const workspace of workspaces) {
    WorkspaceManager.switchWorkspace(workspace);

    const response = await fetch('/api/analytics/usage',
      WorkspaceManager.addWorkspaceHeader({ credentials: 'include' })
    );
    const data = await response.json();

    results.push({
      workspace,
      requestHeaders: response.headers,
      dataCount: data.length,
      isolated: data.every(item => item.workspaceId === workspace)
    });
  }

  console.table(results);
}
```

---

## Success Criteria

### Functional Requirements
- ✅ All 16 pages include workspace header in API calls
- ✅ Workspace switching updates API context immediately
- ✅ Data is properly isolated between workspaces
- ✅ No API calls leak data across workspaces

### Technical Requirements
- ✅ `WorkspaceManager.addWorkspaceHeader()` used consistently
- ✅ All `fetch()` calls include `credentials: 'include'`
- ✅ ApiClient class auto-injects workspace context
- ✅ No hardcoded workspace slugs in API calls

### Testing Requirements
- ✅ Manual test scenarios pass (5 scenarios)
- ✅ Browser console shows correct workspace headers
- ✅ Network tab confirms `X-Workspace-Slug` header present
- ✅ Data filtering verified with 2+ test workspaces

### Code Quality
- ✅ No duplicate workspace injection logic
- ✅ Consistent pattern across all pages
- ✅ Error handling preserved from original code
- ✅ No breaking changes to existing functionality

---

## Files Summary

### New Files to Create (1 file)
- `/public/js/utils/workspace-api.js` - Workspace-aware fetch utilities (~150 lines)

### Files to Modify (12+ files)

**Core API Classes:**
- `/public/js/utils/api-client.js` - Enhance request method
- `/public/js/api/promptsAPI.js` - Add workspace header injection
- `/public/js/utils/index.js` - Update API helper (if used by dashboard)

**Page-Specific JS:**
- `/public/js/analytics.js` - 8+ fetch calls
- `/public/js/models.js` - 6+ fetch calls
- `/public/js/dashboard.js` - 10+ API.get/post calls
- `/public/js/alerts-dashboard.js` - Uses ApiClient (automatic)
- `/public/js/prompts.js` - Uses PromptsAPI (update class)

**Feature Pages (embedded scripts):**
- `/public/js/features-inventory.js`
- `/public/js/features-telemetry.js`
- `/public/js/features-adoption.js`
- `/public/js/features-admin.js`
- `/public/js/feature-alignment.js` (or inline script)

**Admin Pages (embedded scripts):**
- `/public/backup.html` (or `/public/js/backup.js`)
- `/public/alert-analytics.html`
- `/public/benchmark.html` (inline script)
- `/public/performance.html` (inline script)

---

## Critical Gotchas

### 1. **WorkspaceManager Availability**
Always check `if (window.WorkspaceManager)` before using - some pages may load before workspace.js initializes

### 2. **Credentials Must Be Included**
Always set `credentials: 'include'` for session cookies to work

### 3. **Header vs Query Parameter**
Backend expects **header** (`X-Workspace-Slug`), not query param. Use `addWorkspaceHeader()`, not `addWorkspaceParam()`

### 4. **POST/PUT/DELETE Requests**
Don't forget to add workspace context to mutation requests, not just GET

### 5. **Error Handling**
Preserve existing error handling logic - don't break try/catch blocks

### 6. **URL Construction**
Some endpoints use `window.location.origin + '/api/...'` - ensure workspace header is still added

### 7. **Async Initialization**
If workspace.js hasn't loaded yet, calls will fail silently. Add initialization check:
```javascript
if (!window.WorkspaceManager) {
  console.warn('WorkspaceManager not loaded, retrying...');
  await new Promise(resolve => setTimeout(resolve, 500));
}
```

### 8. **Testing in Production**
Use different browser profiles or incognito windows to test multi-workspace scenarios

---

## Implementation Checklist

### Phase 1: Utilities (1 hour)
- [ ] Create `/public/js/utils/workspace-api.js`
- [ ] Export `workspaceFetch()` function
- [ ] Export `workspaceFetchJSON()` function
- [ ] Export `WorkspaceApiClient` class
- [ ] Export helper functions

### Phase 2: API Classes (2 hours)
- [ ] Update `ApiClient` in `/public/js/utils/api-client.js`
- [ ] Update `PromptsAPI` in `/public/js/api/promptsAPI.js`
- [ ] Update `API` helper in `/public/js/utils/index.js` (if exists)
- [ ] Test updated classes in isolation

### Phase 3: Core Pages (3 hours)
- [ ] Update `/public/js/analytics.js` (8 endpoints)
- [ ] Update `/public/js/models.js` (6 endpoints)
- [ ] Update `/public/js/dashboard.js` (10 endpoints)
- [ ] Update `/public/js/alerts-dashboard.js` (verify ApiClient usage)
- [ ] Update `/public/js/prompts.js` (PromptsAPI usage)

### Phase 4: Feature Pages (1 hour)
- [ ] Update features-inventory.js
- [ ] Update features-telemetry.js
- [ ] Update features-adoption.js
- [ ] Update features-admin.js
- [ ] Update feature-alignment (inline script)

### Phase 5: Admin Pages (1 hour)
- [ ] Update backup.html
- [ ] Update alert-analytics.html
- [ ] Update benchmark.html (careful - 345KB file)
- [ ] Update performance.html

### Phase 6: Testing (1 hour)
- [ ] Create 2 test workspaces
- [ ] Run Scenario 1: Analytics isolation
- [ ] Run Scenario 2: Models isolation
- [ ] Run Scenario 3: Dashboard context
- [ ] Run Scenario 4: Alerts filtering
- [ ] Run Scenario 5: Cross-page persistence
- [ ] Browser console verification
- [ ] Network tab header inspection

### Phase 7: Documentation
- [ ] Create completion report
- [ ] Document any deviations from spec
- [ ] List any remaining issues
- [ ] Update ROADMAP.md if needed

---

## Estimated Timeline

| Phase | Task | Duration | Cumulative |
|-------|------|----------|------------|
| 1 | Create utilities | 1 hour | 1 hour |
| 2 | Update API classes | 2 hours | 3 hours |
| 3 | Core pages integration | 3 hours | 6 hours |
| 4 | Feature pages | 1 hour | 7 hours |
| 5 | Admin pages | 1 hour | 8 hours |
| 6 | Testing | 1 hour | 9 hours |
| 7 | Documentation | 30 min | 9.5 hours |

**Total: 8-10 hours** (includes buffer for unexpected issues)

---

## Support Resources

**Documentation:**
- `WORKSPACE_LOADING_FIX_2026-01-07.md` - Context for this task
- `docs/architecture/MULTI_TENANCY.md` - Workspace architecture
- `CLAUDE.md` - Project conventions

**Reference Implementations:**
- `/public/index.html` - Chat page (already workspace-aware for some calls)
- `/public/workspace-settings.html` - Workspace management (reference)

**Backend Routes to Reference:**
- `/routes/analytics.js` - How backend expects workspace context
- `/routes/workspace.js` - Workspace middleware implementation

**Testing:**
- Server running at http://localhost:3080
- MongoDB connection active
- Use Chrome DevTools Network tab extensively

---

## Delivery

When complete, create a report:

**File:** `/WORKSPACE_API_INTEGRATION_COMPLETE.md`

**Include:**
1. Summary of changes (files modified, lines changed)
2. Test results (5 scenarios + pass/fail)
3. Known issues or limitations
4. Screenshots of Network tab showing workspace headers
5. Recommendations for Phase 2 improvements

---

**Task Created:** 2026-01-07
**Context:** Workspace Loading Fix Follow-Up
**Dependencies:** workspace.js integration (COMPLETE)
**Blocking:** None - can start immediately
**Priority:** HIGH - Security & data isolation
