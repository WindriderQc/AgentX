# AgentX Troubleshooting Guide

Use this guide when AgentX is slow, failing requests, or behaving differently than expected.

## Start Here

1. Confirm AgentX is reachable.
2. Check MongoDB and Ollama availability.
3. Reproduce the issue with the smallest possible input.
4. Check logs before changing configuration.
5. Use the related documents at the bottom for deeper subsystem-specific debugging.

## Quick Checks

Health checks:

```bash
curl http://localhost:3080/health
curl http://localhost:3080/health/detailed
```

If you run AgentX with PM2:

```bash
pm2 status
pm2 logs agentx --lines 200
```

Local dependency checks:

```bash
curl http://localhost:11434/api/tags
mongosh --eval "db.runCommand({ ping: 1 })"
```

## Common Failure Patterns

### Chat requests fail or hang

- Verify `OLLAMA_HOST` points at a healthy Ollama instance.
- Confirm at least one chat model is installed.
- If `autoRoute=true`, check model routing behavior before assuming the selected model was used.

### RAG results are missing or stale

- Confirm ingestion completed successfully.
- Check vector store mode (`memory` vs `qdrant`).
- If production data matters, make sure you are not using the in-memory vector store.

### Login, sessions, or workspace behavior looks wrong

- Confirm MongoDB is reachable.
- Check session persistence and auth configuration.
- Verify workspace context is attached where mutations require it.

### Benchmarks look inconsistent

- Check judge-model availability and benchmark batch status.
- Review benchmark scoring references before trusting outlier results.

## Escalation Path

If the basic checks do not explain the issue, go to the most specific reference:

- [Critical Gotchas](../operations/CRITICAL_GOTCHAS.md)
- [Authentication](../operations/AUTHENTICATION.md)
- [RAG System Architecture](../architecture/RAG_SYSTEM.md)
- [Model Routing](../architecture/MODEL_ROUTING.md)
- [Self-Healing Quick Start](./SELF_HEALING_QUICK_START.md)
- [Deployment](../operations/DEPLOYMENT.md)

## Documentation Entry Points

- [Documentation Index](../INDEX.md)
- [User Manual](../user-manual/README.md)
- [Operations README](../operations/README.md)