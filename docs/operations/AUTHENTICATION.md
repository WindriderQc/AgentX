# Authentication Quick Reference

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Authentication

> **Context:** Operational guide for AgentX authentication. For detailed implementation, see [AUTHENTICATION_IMPLEMENTATION_DETAILS.md](../AUTHENTICATION_IMPLEMENTATION_DETAILS.md).

## Dual Auth System

AgentX supports two authentication modes:

| Mode | Use Case | Mechanism |
|------|----------|-----------|
| **Session Auth** | Web users | Cookie-based (MongoDB session store) |
| **API Key Auth** | Automation (n8n) | Header-based (`x-api-key`) |

---

## Middleware

**Location:** `/src/middleware/auth.js`

### Middleware Chain

```javascript
app.use(session(...));           // Session setup
app.use(attachUser);             // Extract user from session → res.locals.user
router.get('/protected', requireAuth, handler);  // Block if !user
router.post('/n8n', apiKeyAuth, handler);        // Require x-api-key header
```

### Key Middleware Functions

| Function | Purpose |
|----------|---------|
| `attachUser` | Extract user from session, set `res.locals.user` |
| `requireAuth` | Block request if user not authenticated |
| `apiKeyAuth` | Validate `x-api-key` header for automation |

---

## API Key Validation

```javascript
const apiKey = req.header('x-api-key');
if (apiKey === process.env.AGENTX_API_KEY) {
  req.authSource = 'api-key';
  res.locals.user = { userId: 'api-client' };
}
```

### Usage in Requests

```bash
# For n8n workflows and automation
curl -H "x-api-key: ${AGENTX_API_KEY}" http://localhost:3080/api/rag/ingest
```

---

## Session Configuration

**Store:** MongoDB via `connect-mongodb-session`

**Key Settings:**
- Sessions persist across server restarts
- Configured in `app.js` session middleware
- Cookie settings match environment (secure in production)

---

## Related Documentation

- [AUTHENTICATION_IMPLEMENTATION_DETAILS.md](../AUTHENTICATION_IMPLEMENTATION_DETAILS.md) - Full implementation guide
- [API Reference](../architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md) - Authentication endpoints
- [Multi-Tenancy](../architecture/MULTI_TENANCY.md) - Workspace-level permissions

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
