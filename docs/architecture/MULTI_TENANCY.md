# Multi-Tenancy & Workspaces (Week 4)

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Multi-Tenancy

> **Context:** Complete team collaboration with data isolation and role-based access control. For progress reports, see Week 4 documentation in `/docs/archive/progress-reports/`.

## Overview

**Complete team collaboration with data isolation and role-based access control.**

---

## Architecture

### Two-Model Design

| Model | Purpose |
|-------|---------|
| `Workspace` | Team workspace with settings, features, and metadata |
| `WorkspaceMember` | Junction table for user-workspace relationships with RBAC |

### Data Isolation Pattern

- All scoped models include `workspaceId` field (ObjectId, indexed)
- Queries filter by `workspaceId` for automatic isolation
- Backward compatible: `workspaceId` is optional for legacy data

### Isolated Resources

- Conversations (`/models/Conversation.js`)
- Prompts (`/models/PromptConfig.js`) - Independent versioning per workspace
- Custom Models (`/models/CustomModel.js`)
- API Keys (future)
- Alerts (future)

---

## Workspace Model

**File:** `/models/Workspace.js` (253 lines)

### Schema

```javascript
{
  // Identity
  name: String (required, 1-100 chars),
  slug: String (unique, URL-friendly, 3-50 chars, lowercase alphanumeric + hyphens),
  description: String (max 500 chars),

  // Ownership
  ownerId: ObjectId (ref: User, required, indexed),

  // Feature Settings
  settings: {
    allowedModels: [String],               // Empty = all allowed
    apiKeyEnabled: Boolean,                // API key access
    ragEnabled: Boolean,                   // RAG features
    customModelsEnabled: Boolean,          // Custom model creation
    benchmarkingEnabled: Boolean,          // Benchmarking
    alertsEnabled: Boolean,                // Alerts
    maxConversations: Number,              // 0 = unlimited
    maxApiKeys: Number,                    // Default: 10
    maxMembers: Number                     // 0 = unlimited
  },

  // Plan (future use)
  plan: String (enum: ['free', 'team', 'enterprise']),

  // Status
  status: String (enum: ['active', 'suspended', 'deleted'], indexed),

  // Timestamps
  createdAt: Date,
  updatedAt: Date,
  deletedAt: Date (for soft delete)
}
```

### Key Methods

| Method | Purpose |
|--------|---------|
| `hasFeature(feature)` | Check if feature is enabled |
| `isModelAllowed(modelName)` | Check model restrictions |
| `softDelete()` | Soft delete with status='deleted' |
| **Static:** `findForUser(userId)` | Get user's workspaces |
| **Static:** `createDefault(userId, userName)` | Create default workspace |
| **Static:** `getBySlug(slug)` | Get workspace with error handling |

---

## WorkspaceMember Model

**File:** `/models/WorkspaceMember.js` (355 lines)

### Schema

```javascript
{
  workspaceId: ObjectId (ref: Workspace, required, indexed),
  userId: ObjectId (ref: User, required, indexed),

  // Role-Based Access Control
  role: String (enum: ['owner', 'admin', 'member', 'viewer'], default: 'member'),

  // Granular Permissions (can override role defaults)
  permissions: {
    chat: Boolean (default: true),
    rag: Boolean (default: true),
    models: Boolean (default: false),
    benchmark: Boolean (default: false),
    alerts: Boolean (default: false),
    settings: Boolean (default: false)
  },

  // Status
  status: String (enum: ['active', 'suspended', 'pending']),

  // Invitation Tracking
  invitedBy: ObjectId (ref: User),
  invitedAt: Date,
  joinedAt: Date,

  // Timestamps
  createdAt: Date,
  updatedAt: Date
}
```

**Compound Index:** `{ workspaceId: 1, userId: 1 }` (unique)

### Role Hierarchy

| Role | Permissions |
|------|-------------|
| **Owner** | All permissions + ownership transfer + delete workspace |
| **Admin** | All permissions except ownership transfer |
| **Member** | Chat, RAG (no settings, models, benchmark, alerts) |
| **Viewer** | Read-only (no permissions) |

### Key Methods

| Method | Purpose |
|--------|---------|
| `hasPermission(permission)` | Check if member has specific permission |
| `isAdmin()` | Returns true for owner or admin |
| `isOwner()` | Returns true for owner only |
| `setRole(newRole)` | Update role and default permissions |
| **Static:** `getMember(workspaceId, userId)` | Get active member |
| **Static:** `isMember(workspaceId, userId)` | Check membership |
| **Static:** `getWorkspaceMembers(workspaceId)` | List all members |
| **Static:** `getUserWorkspaces(userId)` | List user's workspaces |
| **Static:** `inviteMember(workspaceId, userId, role, invitedBy)` | Invite new member |
| **Static:** `removeMember(workspaceId, userId)` | Remove member (cannot remove owner) |
| **Static:** `transferOwnership(workspaceId, fromUserId, toUserId)` | Transfer ownership (atomic transaction) |

---

## Workspace API Routes

**File:** `/routes/workspaces.js` (786 lines, 11 endpoints)

### Workspace CRUD

```bash
GET    /api/workspaces           # List user's workspaces
POST   /api/workspaces           # Create workspace (becomes owner)
GET    /api/workspaces/:slug     # Get workspace details
PATCH  /api/workspaces/:slug     # Update workspace (admin only)
DELETE /api/workspaces/:slug     # Delete workspace (owner only, soft delete)
```

### Member Management

```bash
GET    /api/workspaces/:slug/members          # List members
POST   /api/workspaces/:slug/members          # Invite member (admin only)
PATCH  /api/workspaces/:slug/members/:id      # Update role/permissions (admin only)
DELETE /api/workspaces/:slug/members/:id      # Remove member (admin only)
POST   /api/workspaces/:slug/leave            # Leave workspace (self-removal)
POST   /api/workspaces/:slug/transfer         # Transfer ownership (owner only)
```

### Statistics

```bash
GET    /api/workspaces/:slug/stats            # Get workspace statistics (admin only)
```

**Returns:** Member count, conversation count, API key count, custom model count, active alert count

---

## Workspace Middleware

**File:** `/src/middleware/workspace.js` (4 functions)

### 1. attachWorkspace

Extract workspace context:
```javascript
// Checks in order:
// 1. Query param: ?workspace=slug
// 2. Header: X-Workspace: slug
// 3. User's default workspace (future)

// Sets req.workspace to full workspace object
// Optional: Routes work without workspace context (backward compatible)
```

### 2. requireWorkspaceAccess

Verify membership:
```javascript
// Requires attachWorkspace to run first
// Checks if user is member of req.workspace
// Returns 403 if not a member
```

### 3. requireAdmin

Admin-only routes:
```javascript
// Checks if user is owner or admin
// Returns 403 if not admin
```

### 4. requireOwner

Owner-only routes:
```javascript
// Checks if user is owner
// Returns 403 if not owner
```

---

## Frontend Integration

### Workspace Switcher

**File:** `/public/js/workspace.js` (233 lines)

**Core Features:**
- **Auto-initialization** - Loads on page load
- **localStorage persistence** - Key: `agentx_current_workspace`
- **Helper methods:**
  - `addWorkspaceParam(url)` - Add `?workspace=slug` to URLs
  - `addWorkspaceHeader(options)` - Add `X-Workspace: slug` header
- **Custom events** - Broadcasts `workspaceChanged` event
- **UI updates** - Updates dropdown button and menu

**Usage Pattern:**
```javascript
// GET requests: Add query param
const url = WorkspaceManager.addWorkspaceParam('/api/history');
const res = await fetch(url);

// POST requests: Add header
const fetchOptions = WorkspaceManager.addWorkspaceHeader({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
});
const res = await fetch('/api/chat', fetchOptions);
```

### Settings UI

**File:** `/public/workspace-settings.html` (1,119 lines)

**Sections:**
1. **Workspace List Sidebar** - All accessible workspaces with role badges
2. **Workspace Details** - View/edit name, slug, description (admin only)
3. **Feature Toggles** - Enable/disable RAG, custom models, benchmarking, alerts (admin only)
4. **Members Table** - Invite, change roles, remove members (admin only)
5. **Statistics Dashboard** - Member count, conversations, API keys, models, alerts (admin only)
6. **Danger Zone** - Delete workspace with confirmation (owner only)

**Modals:**
- Create Workspace (name, slug, description)
- Invite Member (email, role selection)
- Delete Workspace (must type slug to confirm)

---

## Route Integration

**4 Route Files Updated (19 routes total):**

### 1. History Routes (`/routes/history.js`)

- Added `attachWorkspace` middleware
- Filter conversations by workspaceId
- Verify workspace access for single conversation GET

### 2. Prompt Routes (`/routes/prompts.js`)

- **Workspace-scoped versioning** - Version numbers independent per workspace
- Create prompt: Finds highest version IN CURRENT WORKSPACE
- List prompts: Filtered by workspaceId
- Update/delete: Verify workspace access

**Critical Pattern:**
```javascript
// Version numbering scoped to workspace
const query = { name };
if (req.workspace) {
  query.workspaceId = req.workspace._id;
}
const existing = await PromptConfig.findOne(query).sort({ version: -1 });
const newVersion = existing ? existing.version + 1 : 1;
```

**Result:** Workspace A can have "default_chat" v1, v2, v3 while Workspace B has "default_chat" v1, v2 (different content)

### 3. Benchmark Routes (`/routes/benchmark.js`)

- Pass workspaceId to benchmarkService
- Tag benchmark results with workspace

### 4. Custom Model Routes (`/routes/custom-models.js`)

- Filter models by workspaceId
- Verify workspace access on get/update
- Create with workspace context

---

## Data Isolation Testing

**File:** `/tests/integration/workspace-isolation.test.js` (386 lines, 21 tests)

### Test Coverage

- ✅ Conversation isolation (4 tests)
- ✅ Prompt isolation with independent versioning (4 tests)
- ✅ Custom model isolation (3 tests)
- ✅ Cross-workspace access prevention (3 tests)
- ✅ Member permissions enforcement (3 tests)
- ✅ Statistics isolation (2 tests)
- ✅ Settings isolation (2 tests)

**Result:** 21/21 passing (100%)

### Key Test: Multi-workspace Membership

```javascript
// User is member of both Workspace A and B
// Creates conversation in each workspace
// Queries correctly filter by workspace
const conversationsA = await Conversation.find({
  userId,
  workspaceId: workspaceA._id
});
const conversationsB = await Conversation.find({
  userId,
  workspaceId: workspaceB._id
});
expect(conversationsA).toHaveLength(1);
expect(conversationsB).toHaveLength(1);
// Different conversations
expect(conversationsA[0]._id).not.toBe(conversationsB[0]._id);
```

---

## Workspace Activity Audit Logs (Post-Week 4)

**Status:** ✅ COMPLETE (Backend + UI)

Comprehensive activity tracking system for workspace operations with before/after state capture.

### Backend Files

| File | Purpose |
|------|---------|
| `/models/WorkspaceAuditLog.js` (234 lines) | Data model |
| `/src/middleware/workspaceAudit.js` (175 lines) | Logging middleware |
| `/routes/workspace-audit.js` (170 lines) | API endpoints |

**UI:** `/public/workspace-audit.html` (550 lines)

### 15 Tracked Actions

| Category | Actions |
|----------|---------|
| **Member Management** | added, removed, role_changed, invited, invitation.revoked, invitation.accepted |
| **Settings** | settings.changed, ownership.transferred |
| **Models** | model.registered, model.deployed, model.deleted |
| **Prompts** | prompt.created, prompt.activated, prompt.deleted |

### Key Features

- Before/after state capture for all changes
- 90-day auto-expiration (TTL index)
- Graceful failure (never breaks main requests)
- Activity timeline UI with filtering
- CSV export (max 10,000 records)
- IP address tracking
- User attribution

### API Endpoints

```bash
GET /api/workspaces/:slug/audit-logs
  ?limit=20&skip=0&action=member.added&from=2026-01-01&to=2026-01-06

GET /api/workspaces/:slug/audit-logs/statistics
  ?from=2026-01-01&to=2026-01-06

GET /api/workspaces/:slug/audit-logs/export
  ?action=member.added&from=2026-01-01
```

### Integration Pattern

```javascript
// Capture before state
const beforeState = { field: entity.field };

// Perform operation
await entity.update(...);

// Log action (never throws)
req.workspace = workspace;
await logHelperFunction(req, 'action.name', entity, {
  before: beforeState,
  after: { field: entity.field }
});
```

### Documentation

- Backend guide: `/AUDIT_LOGGING_COMPLETE.md`
- UI guide: `/AUDIT_LOGS_UI_COMPLETE.md`

---

## Critical Patterns

### 1. Optional Workspace Filtering

```javascript
const query = { userId };
if (req.workspace) {
  query.workspaceId = req.workspace._id;
}
const conversations = await Conversation.find(query);
```

**Why:** Backward compatible - works with or without workspace context

### 2. Dual API Context Pattern

- **GET requests:** Query parameter (`?workspace=slug`)
- **POST/PUT/DELETE:** Header (`X-Workspace: slug`)

**Why:** Easier debugging for GETs, cleaner for mutations

### 3. Workspace-Scoped Versioning

```javascript
// Include workspaceId in version lookup
const query = { name };
if (req.workspace) {
  query.workspaceId = req.workspace._id;
}
const existing = await PromptConfig.findOne(query).sort({ version: -1 });
```

**Result:** Independent version numbers per workspace

### 4. Role-Based UI Rendering

```javascript
const isAdmin = member.role === 'owner' || member.role === 'admin';
const isOwner = member.role === 'owner';

element.style.display = isAdmin ? 'block' : 'none';
```

**Result:** Dynamic UI based on user's role in workspace

---

## Documentation

**Progress Reports:**
- `WEEK4_DAY1_PROGRESS.md` - Models and architecture (545 lines)
- `WEEK4_DAY2_PROGRESS.md` - API routes and middleware (580 lines)
- `WEEK4_DAY3_PROGRESS.md` - UI integration (990 lines)
- `WEEK4_DAY4_PROGRESS.md` - Settings UI and testing (630 lines)

**Total Implementation:** 4 days, 4,260+ lines, 28 files

---

## Related Documentation

- [Backend Overview](backend-overview.md) - Service architecture
- [API Reference](../SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md) - Workspace endpoints
- [Workspace Audit Logs](../../AUDIT_LOGGING_COMPLETE.md) - Activity tracking

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
