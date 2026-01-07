# RAG System Architecture

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → RAG System

> **Context:** Three-layer RAG design with Qdrant integration. For complete architecture details, see [V3_RAG_ARCHITECTURE.md](../../specs/V3_RAG_ARCHITECTURE.md).

## Overview

Three-layer design: **Ingestion** → **Storage** → **Retrieval**

```
Document → Chunks → Embeddings → Vector Store → Semantic Search → Context Injection
```

---

## Layer 1: Ingestion

**Flow:** Document → Chunks → Embeddings → Vector Store

- PDF, HTML, Markdown extraction
- SHA256 hashing for deduplication
- Chunk sizing optimized for context windows

---

## Layer 2: Storage

**Factory Pattern:** Switchable between memory and Qdrant

**Configuration:**
```bash
VECTOR_STORE_TYPE=memory  # Dev, non-persistent
VECTOR_STORE_TYPE=qdrant  # Production, persistent
```

**Services:**
- `ragStore.js` - Vector store singleton (in-memory or Qdrant)
- `embeddings.js` - Embedding generation with LRU cache

---

## Layer 3: Retrieval

**Semantic Search → Context Injection**

In chatService: `useRag=true` triggers semantic search, appends top-K results to system prompt.

**Pattern:** RAG context is ALWAYS appended to system prompt, never injected as user message.

---

## Qdrant Deployment

**Complete Guide:** [docs/QDRANT_DEPLOYMENT.md](../QDRANT_DEPLOYMENT.md) (600+ lines)

**Production Status:** ✅ **OPERATIONAL** (as of 2026-01-05)
- Running via PM2 (process ID 5, port 6333, 128MB RAM)
- Health check: `curl http://localhost:6333/healthz` → "healthz check passed"
- Auto-start on reboot: `pm2 save` (configured)

### Quick Start

```bash
# Start via PM2 (recommended)
pm2 start ecosystem.config.js --only qdrant
pm2 save

# Or run directly
./qdrant --config-path qdrant_config.yaml

# Or via Docker
docker run -d --name qdrant -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant:latest
```

### Configuration

```bash
VECTOR_STORE_TYPE=qdrant                    # Enable in production
QDRANT_URL=http://localhost:6333           # Local instance
QDRANT_COLLECTION=agentx_embeddings        # Collection name
```

---

## System Integration

| Component | Integration |
|-----------|-------------|
| Health monitoring | Added to `systemHealth` object |
| Startup checks | Validates Qdrant connection |
| API endpoint | `/health/detailed` includes Qdrant status |
| UI monitoring | n8n Workflow Monitor shows Qdrant health |

---

## Backup & Recovery

- **Backup script:** `/home/yb/codes/DataAPI/scripts/backup-qdrant.sh`
- **Backup location:** `/home/yb/backups/qdrant/`
- **API endpoint:** `POST /api/backup/qdrant`

---

## Migration

```bash
node scripts/migrate-vector-store.js --from in-memory --to qdrant
```

---

## Related Documentation

- [V3_RAG_ARCHITECTURE.md](../../specs/V3_RAG_ARCHITECTURE.md) - Full architecture specification
- [QDRANT_DEPLOYMENT.md](../QDRANT_DEPLOYMENT.md) - Deployment guide
- [N8N Workflows](../integrations/N8N_WORKFLOWS.md) - Document ingestion workflows
- [RAG Metrics Guide](../RAG_METRICS_GUIDE.md) - Monitoring and metrics

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
