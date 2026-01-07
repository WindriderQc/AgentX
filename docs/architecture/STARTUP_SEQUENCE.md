# Startup Sequence

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Startup Sequence

> **Context:** Bootstrap order and graceful degradation strategy for AgentX server initialization.

## Bootstrap Order

**File:** `/server.js`

### Sequence

1. **Load environment variables** from `.env`
2. **Define global error handlers** (unhandledRejection, uncaughtException)
3. **`startServer()` async function:**
   - Check MongoDB connection (mongoose.connection.readyState)
   - **Initialize default prompt** via `ensureDefaultPromptConfig()` (see below)
   - Check Ollama availability (fetch /api/tags)
   - Update `systemHealth` object (exported from app.js)
4. **Initialize Express middleware:**
   - Security headers (custom, not helmet for LAN compatibility)
   - CORS (origin whitelist or wildcard based on NODE_ENV)
   - Session store (MongoDB-backed with connect-mongodb-session)
   - Body parsers (50MB limit for large document ingestion)
   - Request logging middleware
5. **Mount routes:**
   - Auth routes first (`/api/auth`)
   - API routes (`/api/*`)
   - Static files AFTER API routes (precedence)
6. **Start HTTP listener**
7. **Log startup banner + health status**

---

## Graceful Degradation

Server starts even if services are unavailable:

| Service | If Unavailable | Behavior |
|---------|---------------|----------|
| MongoDB | Logs warning, continues | Conversations not saved |
| Ollama | Chat returns 503 | Health shows degraded |
| Vector store | RAG disabled | Chat works without context |

---

## Default Prompt Initialization

**Implementation:** `/config/db-mongodb.js` → `ensureDefaultPromptConfig()`

### Behavior on Startup

```javascript
// Checks if active 'default_chat' prompt exists
const activePrompt = await PromptConfig.findOne({ 
  name: 'default_chat', 
  status: 'active' 
});

if (!activePrompt) {
  // Creates default prompt if missing
  new PromptConfig({
    name: 'default_chat',
    version: 1,
    systemPrompt: 'You are AgentX, a concise and capable local assistant. Keep answers brief and actionable.',
    description: 'Initial default system prompt',
    status: 'active',
    author: 'system'
  });
}
```

---

## Chat Interface Usage

When user opens chat interface at `http://localhost:3080`:

1. `chatService.js` → `getActivePrompt('default_chat')`
2. Uses `PromptConfig.getActive()` which implements A/B testing with traffic weights
3. If multiple active versions exist, selects one proportionally to `trafficWeight`
4. Falls back to hardcoded default if database lookup fails

**Current Limitation:** No user guidance on setup or self-improvement. System prompt is hardcoded and basic.

---

## Related Documentation

- [Backend Overview](backend-overview.md) - Service initialization details
- [Authentication](../operations/AUTHENTICATION.md) - Auth middleware setup
- [RAG System](RAG_SYSTEM.md) - Vector store initialization
- [Critical Gotchas](../operations/CRITICAL_GOTCHAS.md) - Session persistence

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
