# Qdrant Vector Database Deployment Guide

**AgentX Integration Guide**  
**Date:** December 4, 2025  
**Target:** Production vector storage migration from in-memory to persistent Qdrant

---

## Overview

This guide covers deploying Qdrant as a persistent vector database for AgentX's RAG (Retrieval-Augmented Generation) system. Qdrant replaces the in-memory vector store with a production-grade, persistent solution.

**Benefits:**
- ✅ Persistent storage (survives restarts)
- ✅ Scalable to millions of vectors
- ✅ Fast similarity search (<50ms for 1M vectors)
- ✅ Built-in backup and restore
- ✅ REST API and gRPC support
- ✅ Filtering and metadata support

---

## Prerequisites

- **Docker** (recommended) or native binary
- **512MB RAM minimum** (2GB+ recommended for production)
- **Storage**: ~1GB for 100K documents (varies by embedding model)
- **Network**: Port 6333 (HTTP) and 6334 (gRPC)

---

## Installation Methods

### Option 1: Docker (Recommended)

**Single-node deployment:**

```bash
# Pull Qdrant image
docker pull qdrant/qdrant:latest

# Create persistent volume
docker volume create qdrant_storage

# Run Qdrant container
docker run -d \
  --name qdrant \
  --restart unless-stopped \
  -p 6333:6333 \
  -p 6334:6334 \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant:latest
```

**With Docker Compose:**

```yaml
# docker-compose.yml
version: '3.8'

services:
  qdrant:
    image: qdrant/qdrant:latest
    container_name: qdrant
    restart: unless-stopped
    ports:
      - "6333:6333"  # HTTP API
      - "6334:6334"  # gRPC API
    volumes:
      - qdrant_storage:/qdrant/storage
    environment:
      - QDRANT__SERVICE__GRPC_PORT=6334
    healthcheck:
      test: ["CMD", "wget", "--spider", "http://localhost:6333/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  qdrant_storage:
    driver: local
```

**Start with Docker Compose:**
```bash
docker-compose up -d
```

### Option 2: Native Binary

**Linux/macOS:**
```bash
# Download latest release
curl -L https://github.com/qdrant/qdrant/releases/latest/download/qdrant-x86_64-unknown-linux-gnu.tar.gz -o qdrant.tar.gz

# Extract
tar -xzf qdrant.tar.gz

# Run Qdrant
./qdrant
```

**Configuration file** (`config/production.yaml`):
```yaml
service:
  host: 0.0.0.0
  http_port: 6333
  grpc_port: 6334

storage:
  storage_path: ./storage
  snapshots_path: ./snapshots
  on_disk_payload: true

cluster:
  enabled: false
```

Run with config:
```bash
./qdrant --config-path config/production.yaml
```

### Option 3: Kubernetes

**Helm chart:**
```bash
helm repo add qdrant https://qdrant.github.io/qdrant-helm
helm install qdrant qdrant/qdrant --namespace qdrant --create-namespace
```

---

## AgentX Configuration

### Environment Variables

Add to `.env`:
```bash
# Vector Store Configuration
VECTOR_STORE_TYPE=qdrant           # Use Qdrant (default: in-memory)
QDRANT_URL=http://localhost:6333  # Qdrant HTTP endpoint
QDRANT_API_KEY=                    # Optional: API key for Qdrant Cloud
QDRANT_COLLECTION=agentx_embeddings # Collection name
```

**Remote Qdrant:**
```bash
QDRANT_URL=http://192.168.2.50:6333  # Remote Qdrant server
```

**Qdrant Cloud:**
```bash
QDRANT_URL=https://your-cluster.qdrant.io
QDRANT_API_KEY=your-api-key-here
```

### Verify Qdrant Connection

```bash
# Test Qdrant health
curl http://localhost:6333/healthz

# Check collections
curl http://localhost:6333/collections
```

Expected response:
```json
{
  "result": {
    "collections": []
  },
  "status": "ok",
  "time": 0.000123
}
```

---

## Data Migration

### Migrate from In-Memory to Qdrant

AgentX includes a migration script to transfer existing embeddings:

```bash
# Run migration script
node scripts/migrate-vector-store.js --from in-memory --to qdrant

# With custom collection name
node scripts/migrate-vector-store.js --from in-memory --to qdrant --collection my_embeddings

# Dry run (preview without migrating)
node scripts/migrate-vector-store.js --from in-memory --to qdrant --dry-run
```

**Migration process:**
1. Exports all vectors from in-memory store
2. Creates Qdrant collection with proper schema
3. Batch uploads vectors to Qdrant
4. Validates migration (compare counts)
5. Creates backup of in-memory data

**Expected output:**
```
[Migration] Starting vector store migration...
[Migration] Source: in-memory (1,234 vectors)
[Migration] Target: qdrant (http://localhost:6333)
[Migration] Creating collection 'agentx_embeddings'...
[Migration] Collection created with dimension: 768
[Migration] Migrating vectors in batches of 100...
[Migration] Batch 1/13 uploaded (100 vectors)
[Migration] Batch 2/13 uploaded (100 vectors)
...
[Migration] Batch 13/13 uploaded (34 vectors)
[Migration] Migration complete! Migrated 1,234 vectors
[Migration] Validation: Source=1234, Target=1234 ✓
```

### Manual Migration (Alternative)

```javascript
// scripts/manual-migrate.js
const { getVectorStore } = require('../src/services/vectorStore');

async function migrate() {
  // 1. Initialize both stores
  const inMemoryStore = getVectorStore({ type: 'in-memory' });
  const qdrantStore = getVectorStore({ 
    type: 'qdrant',
    qdrantUrl: process.env.QDRANT_URL 
  });

  // 2. Get all vectors from in-memory
  const vectors = await inMemoryStore.listAll();
  console.log(`Found ${vectors.length} vectors to migrate`);

  // 3. Ensure collection exists
  await qdrantStore.ensureCollection('agentx_embeddings', 768);

  // 4. Batch upload to Qdrant
  const batchSize = 100;
  for (let i = 0; i < vectors.length; i += batchSize) {
    const batch = vectors.slice(i, i + batchSize);
    await qdrantStore.addBatch(batch);
    console.log(`Migrated ${Math.min(i + batchSize, vectors.length)}/${vectors.length}`);
  }

  console.log('Migration complete!');
}

migrate().catch(console.error);
```

---

## Collection Schema

Qdrant collection for AgentX embeddings:

```json
{
  "name": "agentx_embeddings",
  "vectors": {
    "size": 768,
    "distance": "Cosine"
  },
  "payload_schema": {
    "text": { "type": "keyword" },
    "source": { "type": "keyword" },
    "title": { "type": "keyword" },
    "documentId": { "type": "keyword" },
    "metadata": { "type": "json" },
    "timestamp": { "type": "integer" }
  }
}
```

**Create collection manually:**
```bash
curl -X PUT http://localhost:6333/collections/agentx_embeddings \
  -H 'Content-Type: application/json' \
  -d '{
    "vectors": {
      "size": 768,
      "distance": "Cosine"
    }
  }'
```

---

## Performance Tuning

### Indexing Parameters

```bash
# Configure HNSW index (defaults are good for most cases)
curl -X PUT http://localhost:6333/collections/agentx_embeddings \
  -H 'Content-Type: application/json' \
  -d '{
    "vectors": {
      "size": 768,
      "distance": "Cosine"
    },
    "hnsw_config": {
      "m": 16,
      "ef_construct": 100
    }
  }'
```

**HNSW Parameters:**
- `m`: Number of connections (default: 16, higher = better recall, more memory)
- `ef_construct`: Construction parameter (default: 100, higher = better index, slower build)

### Query Parameters

```javascript
// In RAG queries, tune topK and ef
const results = await qdrantStore.search(embedding, {
  topK: 5,           // Number of results
  ef: 128,           // Search accuracy (default: 128, higher = better recall, slower)
  filters: {
    source: 'docs'   // Optional metadata filtering
  }
});
```

### Batch Upload Optimization

```javascript
// Upload in larger batches for initial ingestion
const batchSize = 1000; // Increase from default 100
for (let i = 0; i < vectors.length; i += batchSize) {
  await qdrantStore.addBatch(vectors.slice(i, i + batchSize));
}
```

---

## Backup and Restore

### Create Snapshot

```bash
# Create snapshot of collection
curl -X POST http://localhost:6333/collections/agentx_embeddings/snapshots

# Response:
# { "result": { "name": "agentx_embeddings-2025-12-04-10-30-00.snapshot" } }
```

### List Snapshots

```bash
curl http://localhost:6333/collections/agentx_embeddings/snapshots
```

### Download Snapshot

```bash
# Download snapshot file
curl -O http://localhost:6333/collections/agentx_embeddings/snapshots/agentx_embeddings-2025-12-04-10-30-00.snapshot
```

### Restore from Snapshot

```bash
# Upload snapshot to new Qdrant instance
curl -X PUT http://new-qdrant:6333/collections/agentx_embeddings/snapshots/upload \
  --data-binary @agentx_embeddings-2025-12-04-10-30-00.snapshot
```

### Automated Backups

```bash
#!/bin/bash
# backup-qdrant.sh

QDRANT_URL="http://localhost:6333"
COLLECTION="agentx_embeddings"
BACKUP_DIR="/backups/qdrant"
DATE=$(date +%Y-%m-%d)

# Create snapshot
SNAPSHOT=$(curl -s -X POST $QDRANT_URL/collections/$COLLECTION/snapshots | jq -r '.result.name')

# Download snapshot
curl -o $BACKUP_DIR/$COLLECTION-$DATE.snapshot \
  $QDRANT_URL/collections/$COLLECTION/snapshots/$SNAPSHOT

# Keep last 7 days
find $BACKUP_DIR -name "*.snapshot" -mtime +7 -delete

echo "Backup complete: $SNAPSHOT"
```

**Cron schedule (daily at 2 AM):**
```cron
0 2 * * * /path/to/backup-qdrant.sh >> /var/log/qdrant-backup.log 2>&1
```

---

## Monitoring

### Health Check

```bash
# Qdrant health
curl http://localhost:6333/healthz

# Collection info
curl http://localhost:6333/collections/agentx_embeddings
```

**Response:**
```json
{
  "result": {
    "status": "green",
    "vectors_count": 12345,
    "indexed_vectors_count": 12345,
    "points_count": 12345,
    "segments_count": 3,
    "disk_data_size": 104857600,
    "ram_data_size": 52428800
  }
}
```

### Metrics Endpoint

```bash
# Prometheus metrics
curl http://localhost:6333/metrics
```

### Integration with AgentX Metrics

AgentX metrics dashboard automatically includes Qdrant stats:

```bash
# Get Qdrant stats via AgentX
curl http://localhost:3080/api/metrics/system

# Returns:
# {
#   "cache": { "hitRate": "75.5%" },
#   "database": { "status": "connected" },
#   "vectorStore": {
#     "type": "qdrant",
#     "url": "http://localhost:6333",
#     "collection": "agentx_embeddings",
#     "vectorCount": 12345,
#     "status": "healthy"
#   }
# }
```

---

## Troubleshooting

### Connection Issues

**Problem:** Cannot connect to Qdrant

```bash
# Check if Qdrant is running
docker ps | grep qdrant

# Check Qdrant logs
docker logs qdrant

# Test connection
curl -v http://localhost:6333/healthz
```

**Fix:** Ensure Qdrant is running and port 6333 is accessible

### Collection Not Found

**Problem:** `Collection 'agentx_embeddings' not found`

```bash
# Create collection manually
curl -X PUT http://localhost:6333/collections/agentx_embeddings \
  -H 'Content-Type: application/json' \
  -d '{"vectors": {"size": 768, "distance": "Cosine"}}'
```

### Slow Queries

**Problem:** Search queries take >1 second

**Diagnosis:**
```bash
# Check collection stats
curl http://localhost:6333/collections/agentx_embeddings

# Look for:
# - indexed_vectors_count < vectors_count (indexing in progress)
# - segments_count > 10 (too fragmented)
```

**Fix:**
```bash
# Optimize collection (triggers re-indexing)
curl -X POST http://localhost:6333/collections/agentx_embeddings/points/optimize
```

### Memory Issues

**Problem:** Qdrant consuming too much memory

**Fix:** Enable on-disk payload storage

```yaml
# config/production.yaml
storage:
  on_disk_payload: true  # Store payloads on disk, not RAM
```

Or create collection with on-disk vectors:
```json
{
  "vectors": {
    "size": 768,
    "distance": "Cosine",
    "on_disk": true
  }
}
```

---

## Production Checklist

- [ ] Qdrant deployed with persistent storage
- [ ] Collection `agentx_embeddings` created (dimension: 768)
- [ ] Environment variable `VECTOR_STORE_TYPE=qdrant` set
- [ ] Migration from in-memory completed and validated
- [ ] Health check endpoint responding
- [ ] Backup strategy implemented (snapshots)
- [ ] Monitoring configured (Prometheus/Grafana)
- [ ] Firewall rules updated (port 6333)
- [ ] Test queries returning expected results
- [ ] Performance benchmarks acceptable (<50ms search)

---

## Next Steps

### After Deployment

1. **Validate Migration:** Run test queries and compare results with in-memory
2. **Monitor Performance:** Track query latency and cache hit rates
3. **Optimize Indexes:** Tune HNSW parameters based on usage patterns
4. **Schedule Backups:** Set up automated snapshot creation
5. **Scale Up:** Consider clustering for high availability

### Scaling Qdrant

**Horizontal scaling (cluster mode):**
```yaml
# docker-compose-cluster.yml
version: '3.8'

services:
  qdrant-1:
    image: qdrant/qdrant:latest
    environment:
      - QDRANT__CLUSTER__ENABLED=true
      - QDRANT__CLUSTER__NODE_ID=1
    ports:
      - "6333:6333"

  qdrant-2:
    image: qdrant/qdrant:latest
    environment:
      - QDRANT__CLUSTER__ENABLED=true
      - QDRANT__CLUSTER__NODE_ID=2
      - QDRANT__CLUSTER__BOOTSTRAP_URI=qdrant-1:6335
    ports:
      - "6343:6333"
```

---

## Resources

- **Qdrant Docs:** https://qdrant.tech/documentation/
- **GitHub:** https://github.com/qdrant/qdrant
- **Docker Hub:** https://hub.docker.com/r/qdrant/qdrant
- **Cloud:** https://qdrant.to/cloud (managed service)

---

*Qdrant deployment guide for AgentX v1.0.0*  
*Updated: December 4, 2025*  
*For questions, refer to Qdrant documentation or AgentX issues*
