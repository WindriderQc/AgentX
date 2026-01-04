# Qdrant Deployment Details (Archived from CLAUDE.md)

**Archived:** 2026-01-04
**Reason:** Duplicates comprehensive guide in `/docs/QDRANT_DEPLOYMENT.md`
**Original Location:** CLAUDE.md lines 221-267

---

### Qdrant Deployment

**Complete Guide:** `/docs/QDRANT_DEPLOYMENT.md` (comprehensive 600+ line guide)

**Quick Start:**
```bash
# Using included binary
./qdrant --config-path qdrant_config.yaml

# Or with Docker
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 \
  -v qdrant_storage:/qdrant/storage qdrant/qdrant:latest

# Verify
curl http://localhost:6333/healthz
```

**Configuration Files:**
- `qdrant_config.yaml` - Local binary configuration
- `qdrant.tar.gz` - Pre-packaged binary (78MB)
- `qdrant_data/` - Persistent storage directory
- `.qdrant-initialized` - Marker file for init status

**Migration Process:**
```bash
# Export from in-memory, import to Qdrant
node scripts/migrate-vector-store.js --from in-memory --to qdrant

# Validates migration (compares counts)
# Creates backup of in-memory data
```

**Collection Schema:**
- **Dimension:** 768 (nomic-embed-text)
- **Distance:** Cosine similarity
- **Indexing:** HNSW (automatic after 10K vectors)

**Backup Strategy (documented):**
- Snapshot API: `POST /collections/{name}/snapshots`
- Automated script: `backup-qdrant.sh` (cron schedule provided)
- Retention: 7 days default

**Performance:**
- Search latency: <50ms for 1M vectors
- Persistent across restarts
- Scales to millions of vectors
