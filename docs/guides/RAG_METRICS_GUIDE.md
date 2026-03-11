# RAG Metrics Guide

Use this guide to monitor RAG ingestion health, retrieval behavior, and vector-store readiness.

## Primary Checks

System health:

```bash
curl http://localhost:3080/health/detailed
```

RAG metrics and status surfaces:

```bash
curl http://localhost:3080/api/rag/metrics
curl http://localhost:3080/api/rag/documents
```

Qdrant health, if enabled:

```bash
curl http://localhost:6333/healthz
```

## What To Watch

- Ingestion success or repeated failures
- Empty or unexpectedly small document counts
- Vector-store mode mismatches (`memory` in places where persistence is expected)
- Slow retrieval caused by cold embeddings cache or vector-store issues

## Related Documentation

- [RAG System Architecture](../architecture/RAG_SYSTEM.md)
- [Qdrant Deployment](../operations/QDRANT_DEPLOYMENT.md)
- [n8n Workflows](../integrations/N8N_WORKFLOWS.md)
- [Critical Gotchas](../operations/CRITICAL_GOTCHAS.md)