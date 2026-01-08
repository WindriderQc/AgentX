# Workspace API Integration Guide

**For Developers:** How to make workspace-aware API calls in AgentX

---

## 🎯 Quick Start

### Option 1: Use Existing API Clients (Recommended)
```javascript
// Already workspace-aware - no changes needed!
import { apiClient } from './utils/api-client.js';
const data = await apiClient.get('/models');
```

### Option 2: Use Workspace Utilities
```javascript
import { workspaceFetchJSON } from './utils/workspace-api.js';
const data = await workspaceFetchJSON('/api/models');
```

### Option 3: Add Helper to Your Module
```javascript
function getWorkspaceHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (window.WorkspaceManager?.addWorkspaceHeader) {
        Object.assign(headers, window.WorkspaceManager.addWorkspaceHeader({}));
    }
    return headers;
}

const response = await fetch('/api/endpoint', {
    headers: getWorkspaceHeaders()
});
```

---

## 📚 Available Utilities

### workspaceFetch(url, options)
Workspace-aware fetch wrapper
```javascript
const response = await workspaceFetch('/api/models', {
    method: 'POST',
    body: JSON.stringify({ name: 'gpt-4' })
});
```

### workspaceFetchJSON(url, options)
Fetch with automatic JSON parsing
```javascript
const models = await workspaceFetchJSON('/api/models');
// Returns parsed JSON directly
```

### getWorkspaceHeaders()
Get headers object with workspace context
```javascript
const headers = getWorkspaceHeaders();
// Returns: { 'X-Workspace-Slug': 'current-workspace' }
```

### WorkspaceApiClient
Full-featured API client class
```javascript
import { WorkspaceApiClient } from './utils/workspace-api.js';

const client = new WorkspaceApiClient('/api');
const data = await client.get('/models');
await client.post('/models', { name: 'gpt-4' });
await client.put('/models/123', { status: 'active' });
await client.delete('/models/123');
```

---

## 🏗️ Architecture

### How It Works
1. User selects workspace in UI
2. `WorkspaceManager.switchWorkspace(slug)` sets active workspace
3. All API calls include `X-Workspace-Slug` header
4. Backend middleware validates and filters by workspace

### Header Structure
```javascript
{
  'X-Workspace-Slug': 'production',
  'Content-Type': 'application/json'
}
```

### Backend Validation
```javascript
// Backend middleware extracts workspace
const workspaceSlug = req.headers['x-workspace-slug'];

// Filters data by workspace
const data = await Model.find({ workspace: workspaceSlug });
```

---

## ✅ Integration Checklist

When adding new API endpoints:

- [ ] Use existing `apiClient` or `API` utilities (auto workspace-aware)
- [ ] OR import `workspaceFetch`/`workspaceFetchJSON` from workspace-api.js
- [ ] OR add `getWorkspaceHeaders()` helper to your module
- [ ] Test with multiple workspaces to verify isolation
- [ ] Check Network tab for `X-Workspace-Slug` header

---

## 🚫 Common Mistakes

### ❌ DON'T: Use bare fetch without headers
```javascript
const response = await fetch('/api/models'); // No workspace context!
```

### ✅ DO: Use workspace-aware utilities
```javascript
const response = await workspaceFetch('/api/models'); // Workspace-aware
```

### ❌ DON'T: Hardcode workspace slug
```javascript
const headers = { 'X-Workspace-Slug': 'production' }; // Hard-coded!
```

### ✅ DO: Get from WorkspaceManager
```javascript
const headers = window.WorkspaceManager.addWorkspaceHeader({}); // Dynamic
```

### ❌ DON'T: Use query params for workspace
```javascript
fetch('/api/models?workspace=prod'); // Security risk!
```

### ✅ DO: Use headers
```javascript
workspaceFetch('/api/models'); // Secure via headers
```

---

## 🧪 Testing Workspace Isolation

### Manual Testing
1. Create 2 test workspaces: `alpha` and `beta`
2. Add different data to each workspace
3. Switch between workspaces in UI
4. Verify data changes based on active workspace
5. Check Network tab for correct headers

### Automated Testing
```javascript
// Example test
describe('Workspace API Integration', () => {
  it('should include workspace header', async () => {
    window.WorkspaceManager.switchWorkspace('test-workspace');
    const response = await workspaceFetch('/api/models');
    expect(response.headers.get('X-Workspace-Slug')).toBe('test-workspace');
  });
});
```

---

## 📖 Real-World Examples

### Example 1: Fetching Models List
```javascript
import { workspaceFetchJSON } from './utils/workspace-api.js';

async function loadModels() {
  try {
    const models = await workspaceFetchJSON('/api/models');
    renderModels(models);
  } catch (error) {
    console.error('Failed to load models:', error);
  }
}
```

### Example 2: Creating a New Resource
```javascript
import { WorkspaceApiClient } from './utils/workspace-api.js';

const api = new WorkspaceApiClient('/api');

async function createModel(modelData) {
  const newModel = await api.post('/models', modelData);
  return newModel;
}
```

### Example 3: Page-Level Helper
```javascript
// In your page JS file
function getWorkspaceHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (window.WorkspaceManager?.addWorkspaceHeader) {
    Object.assign(headers, window.WorkspaceManager.addWorkspaceHeader({}));
  }
  return headers;
}

async function loadData() {
  const response = await fetch('/api/analytics', {
    headers: getWorkspaceHeaders()
  });
  return response.json();
}
```

### Example 4: Inline Script (HTML)
```html
<script>
  function getWorkspaceHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (window.WorkspaceManager?.addWorkspaceHeader) {
      Object.assign(headers, window.WorkspaceManager.addWorkspaceHeader({}));
    }
    return headers;
  }

  async function loadStats() {
    const response = await fetch('/api/stats', {
      headers: getWorkspaceHeaders()
    });
    const data = await response.json();
    renderStats(data);
  }
</script>
```

---

## 🔧 Troubleshooting

### Issue: No workspace header in requests
**Solution:** Check if `WorkspaceManager` is initialized before making API calls
```javascript
// Wait for WorkspaceManager to initialize
await WorkspaceManager.init();
// Then make API calls
const data = await workspaceFetch('/api/models');
```

### Issue: Getting data from all workspaces
**Solution:** Verify header is present in Network tab
1. Open DevTools → Network tab
2. Click on API request
3. Check Headers section for `X-Workspace-Slug`
4. If missing, check `WorkspaceManager.getCurrentWorkspace()`

### Issue: 403 Forbidden errors
**Solution:** User may not have access to selected workspace
```javascript
// Check workspace membership
const workspaces = await fetch('/api/workspaces').then(r => r.json());
console.log('Available workspaces:', workspaces);
```

---

## 📝 API Reference

### WorkspaceManager Methods

#### `getCurrentWorkspace()`
```javascript
const slug = WorkspaceManager.getCurrentWorkspace();
// Returns: 'production'
```

#### `switchWorkspace(slug)`
```javascript
await WorkspaceManager.switchWorkspace('staging');
// Switches active workspace and reloads data
```

#### `addWorkspaceHeader(options)`
```javascript
const options = { method: 'POST' };
const withHeader = WorkspaceManager.addWorkspaceHeader(options);
// Returns: { method: 'POST', headers: { 'X-Workspace-Slug': '...' } }
```

#### `addWorkspaceParam(url)`
```javascript
const url = WorkspaceManager.addWorkspaceParam('/api/models');
// Returns: '/api/models?workspace=production' (legacy support)
```

---

## 🎓 Best Practices

1. **Always use workspace-aware utilities** - Don't reinvent the wheel
2. **Check WorkspaceManager availability** - Use optional chaining (`?.`)
3. **Include credentials** - Use `credentials: 'include'` for session cookies
4. **Handle errors gracefully** - Workspace may not be set on initial load
5. **Test with multiple workspaces** - Verify data isolation works
6. **Document workspace requirements** - Note in function JSDoc if workspace-dependent

---

## 🔗 Related Documentation

- [WORKSPACE_API_INTEGRATION_COMPLETE.md](../WORKSPACE_API_INTEGRATION_COMPLETE.md) - Full implementation report
- [MULTI_TENANCY.md](./architecture/MULTI_TENANCY.md) - Architecture overview
- [workspace-api.js](../public/js/utils/workspace-api.js) - Source code with JSDoc

---

**Last Updated:** January 7, 2026  
**Maintainer:** AgentX Team
