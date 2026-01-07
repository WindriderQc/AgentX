# Critical Gotchas & Known Issues

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Critical Gotchas

> **Context:** Common pitfalls and non-obvious behaviors in AgentX. Read this before debugging production issues.

## Overview

These are the 8 most common issues and their solutions. Understanding these will save significant debugging time.

---

## 1. In-Memory Vector Store is NOT Persistent

**Problem:** Data lost on server restart

**Solution:** Use Qdrant (`VECTOR_STORE_TYPE=qdrant`) for production

**Related:** [RAG System Architecture](../architecture/RAG_SYSTEM.md)

---

## 2. Embedding Cache Cold Starts

**Problem:** First queries after restart are slow (no cache hits)

**Solution:** Cache rebuilds organically, no pre-warming mechanism exists

---

## 3. Tool Commands Bypass LLM

**Problem:** Slash commands (e.g., `/dataapi`) execute BEFORE any LLM processing

**Solution:** Understand that tool results are not passed through the model

---

## 4. RAG Context Injection Location

**Pattern:** RAG context is ALWAYS appended to system prompt, never injected as user message

**Why:** Maintains clean conversation history while providing grounding context

**Related:** [RAG System Architecture](../architecture/RAG_SYSTEM.md)

---

## 5. Model Auto-Routing Override

**Critical:** When `autoRoute=true`, user's model selection is IGNORED

**Why:** Routing decision takes precedence for optimal task-model matching

**Related:** [Model Routing](../architecture/MODEL_ROUTING.md)

---

## 6. Prompt Data Snapshots

**Pattern:** Conversations snapshot prompt data (name, version) rather than reference

**Why:** Enables historical analysis even after original prompts change/delete

---

## 7. PM2 Cluster Mode

**Pattern:** `ecosystem.config.js` runs in cluster mode with `instances: 'max'`

**Implication:** In-memory state (cache, vector store) is NOT shared across workers

**Solution:** Each worker maintains its own cache/store, or use external services (Qdrant, Redis)

---

## 8. Session Store Persistence

**Pattern:** Sessions stored in MongoDB via `connect-mongodb-session`

**Implication:** Sessions persist across server restarts

**Config:** See `app.js` session middleware setup

**Related:** [Authentication](AUTHENTICATION.md)

---

## Related Documentation

- [RAG System Architecture](../architecture/RAG_SYSTEM.md) - Vector store details
- [Model Routing](../architecture/MODEL_ROUTING.md) - Auto-routing behavior
- [Startup Sequence](../architecture/STARTUP_SEQUENCE.md) - Initialization order
- [Troubleshooting](../TROUBLESHOOTING_README.md) - Problem resolution

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
