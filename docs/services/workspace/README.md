# Workspace & Access Service

**Agent:** WorkspaceAgent
**Status:** Active

## Responsibility
Multi-tenancy, workspace CRUD, membership with 4-tier RBAC (Owner/Admin/Member/Viewer), invitations, authentication (session + API keys), audit logging, security middleware (rate limiting, CSRF).

## File Inventory

### Middleware (src/middleware/)
| File | Lines | Purpose |
|------|-------|---------|
| workspace.js | 384 | Workspace context attachment and validation |
| workspaceAudit.js | 236 | Workspace-level audit logging |
| auth.js | 238 | Session auth and user attachment |
| n8nAuth.js | 99 | n8n webhook authentication |
| rateLimiter.js | 204 | Request rate limiting |
| auditLogger.js | 345 | Action audit logging |

### Routes (routes/)
| File | Lines | Purpose |
|------|-------|---------|
| workspaces.js | 1,183 | Workspace CRUD and settings |
| invitations.js | - | Workspace invite management |
| workspace-audit.js | - | Workspace audit logs |
| auth.js | - | Login, register, logout |
| api-keys.js | - | API key management |
| audit-logs.js | - | Audit log queries |

### Models (models/)
| File | Lines | Purpose |
|------|-------|---------|
| Workspace.js | 252 | Workspace with settings and feature toggles |
| WorkspaceMember.js | 354 | 4-tier RBAC membership |
| WorkspaceInvitation.js | 198 | Invite tokens |
| WorkspaceAuditLog.js | 279 | Workspace-specific audit logs |
| APIKey.js | 266 | API key management |
| AuditLog.js | 309 | System audit trail |

### Helpers (src/helpers/)
- userHelpers.js — User profile loading/creation
- passwordValidator.js — Password validation

### Frontend
- workspace.js

## APIs Exposed
- `GET/POST/PUT/DELETE /api/workspaces/*` — Workspace management
- `POST /api/invitations/*` — Invitation management
- `GET /api/workspace-audit/*` — Audit log queries
- `POST /api/auth/login` — Authentication
- `POST /api/auth/register` — Registration
- `POST /api/auth/logout` — Logout
- `GET/POST/DELETE /api/keys/*` — API key management

### Cross-Cutting Middleware (consumed by all services)
```javascript
const { attachWorkspace, optionalWorkspaceContext } = require('./src/middleware/workspace');
const { requireAuth, optionalAuth } = require('./src/middleware/auth');
const { apiKeyAuth } = require('./src/middleware/auth');

// Strict enforcement (mutations)
router.post('/resource', requireAuth, attachWorkspace, handler);
// Lenient loading (reads)
router.get('/resource', optionalAuth, optionalWorkspaceContext, handler);
```

## Dependencies (Consumed)
| Service | Interface | What |
|---------|-----------|------|
| Alerting | `emailService` | Invitation emails |

## Data Ownership
Exclusive write: Workspace, WorkspaceMember, WorkspaceInvitation, WorkspaceAuditLog, APIKey, AuditLog.

## Key Patterns
- Data isolation: `query.workspaceId = req.workspace._id`
- 4-tier RBAC: Owner > Admin > Member > Viewer
- Middleware is owned by WorkspaceAgent but consumed by all routes
- attachWorkspace (strict) vs optionalWorkspaceContext (lenient)
