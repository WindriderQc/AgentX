# n8n to AgentX RAG Integration Guide

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → n8n RAG Integration

> **Context:** Complete integration guide for n8n workflows to interact with AgentX RAG system, including document ingestion, manifests, and archiving.

---

## Overview

AgentX provides multiple endpoints and tools for RAG operations that can be integrated with n8n workflows for automated document management.

---

## Integration Architecture

```
n8n Workflows
    ↓
AgentX API Endpoints
    ↓
RAG Store (Qdrant/In-Memory)
```

---

## API Endpoints for n8n

### 1. Document Ingestion

**Endpoint:** `POST /api/rag/ingest`

**Purpose:** Ingest a single document into the RAG system

**Authentication:** API Key via `x-api-key` header

**Request Body:**
```json
{
  "source": "agentx-docs",
  "path": "docs/architecture/RAG_SYSTEM.md",
  "title": "RAG System Architecture",
  "text": "...markdown content...",
  "hash": "sha256-hash-of-content",
  "tags": ["architecture", "documentation"],
  "metadata": {
    "size": 12345,
    "modified": "2026-01-14T12:00:00.000Z"
  }
}
```

**Response:**
```json
{
  "status": "created",
  "documentId": "doc_abc123",
  "chunkCount": 15
}
```

**Status Values:**
- `created` - New document ingested
- `updated` - Existing document updated (based on hash)
- `skipped` - Document unchanged (same hash)

---

### 2. RAG Search

**Endpoint:** `POST /api/rag/search`

**Purpose:** Semantic search for debugging and validation

**Request Body:**
```json
{
  "query": "How does RAG ingestion work?",
  "topK": 5,
  "minScore": 0.7,
  "filters": {
    "source": "agentx-docs"
  }
}
```

**Response:**
```json
{
  "query": "How does RAG ingestion work?",
  "resultCount": 5,
  "results": [
    {
      "score": 0.92,
      "text": "...",
      "metadata": {
        "source": "agentx-docs",
        "path": "docs/architecture/RAG_SYSTEM.md",
        "title": "RAG System Architecture"
      }
    }
  ]
}
```

---

### 3. List Documents

**Endpoint:** `GET /api/rag/documents?source=agentx-docs&tags=architecture`

**Purpose:** List all documents in RAG store with optional filtering

**Response:**
```json
{
  "status": "success",
  "count": 42,
  "stats": {
    "totalDocuments": 42,
    "totalChunks": 630
  },
  "data": [
    {
      "documentId": "doc_abc123",
      "source": "agentx-docs",
      "path": "docs/architecture/RAG_SYSTEM.md",
      "title": "RAG System Architecture",
      "chunkCount": 15,
      "createdAt": "2026-01-14T12:00:00.000Z",
      "updatedAt": "2026-01-14T12:00:00.000Z"
    }
  ]
}
```

---

### 4. Delete Document

**Endpoint:** `DELETE /api/rag/documents/:documentId`

**Purpose:** Remove a document from RAG store

**Response:**
```json
{
  "message": "Document deleted successfully",
  "documentId": "doc_abc123"
}
```

---

### 5. RAG Metrics

**Endpoint:** `GET /api/rag/metrics`

**Purpose:** Get comprehensive RAG system health and statistics

**Response:**
```json
{
  "status": "success",
  "healthy": true,
  "stats": {
    "totalDocuments": 42,
    "totalChunks": 630,
    "avgChunksPerDoc": "15.00",
    "sourceBreakdown": {
      "agentx-docs": {
        "count": 42,
        "chunks": 630
      }
    },
    "oldestDocument": "2025-12-01T00:00:00.000Z",
    "newestDocument": "2026-01-14T12:00:00.000Z"
  },
  "timestamp": "2026-01-14T12:00:00.000Z"
}
```

---

### 6. Manifest Management

#### Store Manifest

**Endpoint:** `POST /api/rag/manifests`

**Authentication:** n8n API Key required (n8nAuth middleware)

**Purpose:** Store folder scan results for deletion detection

**Request Body:**
```json
{
  "source": "agentx-docs",
  "root": "/home/user/AgentX",
  "scanId": "scan_20260114_120000",
  "generatedAt": "2026-01-14T12:00:00.000Z",
  "files": [
    {
      "path": "/home/user/AgentX/docs/INDEX.md",
      "sha256": "abc123...",
      "size": 12345,
      "mtime": "2026-01-14T10:00:00.000Z"
    }
  ]
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "source": "agentx-docs",
    "root": "/home/user/AgentX",
    "scanId": "scan_20260114_120000",
    "generatedAt": "2026-01-14T12:00:00.000Z",
    "fileCount": 42,
    "totalBytes": 524288,
    "updatedAt": "2026-01-14T12:00:00.000Z"
  }
}
```

#### Get Latest Manifest

**Endpoint:** `GET /api/rag/manifests/latest?source=agentx-docs&root=/home/user/AgentX`

**Response:**
```json
{
  "status": "success",
  "data": {
    "source": "agentx-docs",
    "root": "/home/user/AgentX",
    "scanId": "scan_20260114_120000",
    "generatedAt": "2026-01-14T12:00:00.000Z",
    "fileCount": 42,
    "totalBytes": 524288,
    "updatedAt": "2026-01-14T12:00:00.000Z"
  }
}
```

#### Preview Deletions

**Endpoint:** `GET /api/rag/deletion-preview?source=agentx-docs&root=/home/user/AgentX`

**Purpose:** Identify documents in RAG that no longer exist in filesystem

**Response:**
```json
{
  "status": "success",
  "data": {
    "source": "agentx-docs",
    "root": "/home/user/AgentX",
    "manifest": {
      "scanId": "scan_20260114_120000",
      "generatedAt": "2026-01-14T12:00:00.000Z",
      "fileCount": 42
    },
    "summary": {
      "ragDocuments": 45,
      "manifestFiles": 42,
      "candidates": 3
    },
    "candidates": [
      {
        "documentId": "doc_xyz789",
        "title": "Deleted File.md",
        "source": "agentx-docs",
        "path": "docs/old/deleted.md",
        "reason": "missing_from_manifest",
        "chunkCount": 10
      }
    ]
  }
}
```

---

## Existing n8n Workflows

### N2.3 RAG Document Ingestion

**File:** `AgentC/N2.3.json`

**Triggers:**
- Scheduled: Weekly on Sunday at 3 AM
- Webhook: Manual trigger via POST to `/sbqc-n2-3-rag-ingest`

**Configuration:**
```javascript
{
  path: '/mnt/datalake/RAG',
  pattern: '*.md',  // Also *.txt, *.pdf
  source: 'nas-docs'
}
```

**Flow:**
1. Configure directories to scan
2. Find recent files (modified in last 7 days)
3. Parse file list
4. Read file content (first 50KB)
5. Prepare RAG payload
6. POST to `/api/rag/ingest`
7. Summarize results
8. Log event to DataAPI

**Limitations:**
- Only scans `/mnt/datalake/RAG` directory
- Only ingests files modified in last 7 days
- Limited to 100 files per pattern
- Only reads first 50KB of each file

---

## New Scripts for Complete Coverage

### 1. Archive All Markdown Files

**Script:** `scripts/archive-md-files.sh`

**Purpose:** Create a tar.gz archive of ALL .md files with folder hierarchy preserved

**Usage:**
```bash
./scripts/archive-md-files.sh
```

**Features:**
- Scans entire AgentX codebase
- Excludes node_modules, .git, coverage, dist, build
- Preserves folder hierarchy
- Creates manifest file listing all archived files
- Keeps last 10 archives
- Outputs JSON for n8n integration

**Output:**
```json
{
  "status": "success",
  "archive": {
    "path": "/mnt/datalake/backups/md-archives/agentx-markdown-20260114_120000.tar.gz",
    "name": "agentx-markdown-20260114_120000.tar.gz",
    "size": "2.3M",
    "fileCount": 156,
    "manifest": "/mnt/datalake/backups/md-archives/agentx-markdown-20260114_120000.manifest.txt",
    "timestamp": "20260114_120000"
  }
}
```

### 2. Update RAG from All Markdown Files

**Script:** `scripts/update-rag-from-md.js`

**Purpose:** Ingest ALL markdown files from AgentX codebase into RAG

**Usage:**
```bash
# Full ingestion
node scripts/update-rag-from-md.js

# Dry run (see what would be ingested)
node scripts/update-rag-from-md.js --dry-run

# Custom source name
node scripts/update-rag-from-md.js --source=agentx-complete

# Limit for testing
node scripts/update-rag-from-md.js --limit=10
```

**Environment Variables:**
```bash
AGENTX_BASE_URL=http://localhost:3080
AGENTX_API_KEY=your-api-key-here
```

**Features:**
- Scans entire AgentX codebase
- Computes SHA256 for deduplication
- Auto-tags based on directory structure
- Respects .gitignore patterns
- Outputs JSON for n8n integration

**Output:**
```json
{
  "status": "success",
  "timestamp": "2026-01-14T12:00:00.000Z",
  "source": "agentx-docs",
  "stats": {
    "found": 156,
    "processed": 156,
    "success": 150,
    "failed": 0,
    "skipped": 6,
    "errors": []
  },
  "dryRun": false
}
```

---

## Recommended n8n Integration Workflows

### Workflow 1: Complete MD Archive & RAG Update

**Trigger:** Manual webhook or scheduled (weekly)

**Nodes:**
1. **Webhook Trigger** - POST `/sbqc-archive-and-rag-update`
2. **Execute Command** - Run `scripts/archive-md-files.sh`
3. **Execute Command** - Run `scripts/update-rag-from-md.js`
4. **Store Manifest** - POST `/api/rag/manifests`
5. **Log Event** - POST to DataAPI
6. **Respond** - Return summary JSON

### Workflow 2: RAG Cleanup (Delete Missing Files)

**Trigger:** Manual webhook (safe operation)

**Nodes:**
1. **Webhook Trigger** - POST `/sbqc-rag-cleanup`
2. **Preview Deletions** - GET `/api/rag/deletion-preview`
3. **IF Node** - Check if candidates > 0
4. **Loop Over Candidates** - Delete each via DELETE `/api/rag/documents/:id`
5. **Summarize** - Count deleted items
6. **Log Event** - POST to DataAPI
7. **Respond** - Return summary

### Workflow 3: RAG Health Monitoring

**Trigger:** Scheduled (daily)

**Nodes:**
1. **Schedule Trigger** - Cron: 0 6 * * *
2. **Get Metrics** - GET `/api/rag/metrics`
3. **IF Node** - Check if healthy === false
4. **Alert** - Send notification if unhealthy
5. **Log Event** - POST to DataAPI

---

## Environment Configuration

### AgentX Environment Variables

```bash
# Vector Store Configuration
VECTOR_STORE_TYPE=qdrant              # or 'memory' for dev
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=agentx_embeddings

# Backup Configuration
BACKUP_DIR=/mnt/datalake/backups

# API Configuration
AGENTX_API_KEY=your-secure-api-key
```

### n8n Environment Variables

```bash
# AgentX Integration
AGENTX_BASE_URL=http://192.168.2.33:3080
AGENTX_API_KEY=your-secure-api-key

# Folder Paths
DOCS_FOLDER_PATH=/mnt/datalake/RAG
AGENTX_PROJECT_ROOT=/home/user/AgentX
```

---

## Authentication

### API Key Authentication

All RAG endpoints (except read-only operations) require API key authentication:

```bash
curl -H "x-api-key: YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -X POST http://localhost:3080/api/rag/ingest \
     -d '{ "source": "test", "path": "test.md", "title": "Test", "text": "Content" }'
```

### n8n Authentication Setup

1. Create HTTP Header Auth credential in n8n
2. Set header name: `x-api-key`
3. Set header value: `YOUR_API_KEY`
4. Attach to all HTTP Request nodes calling AgentX

---

## Monitoring & Troubleshooting

### Check RAG Health

```bash
curl http://localhost:3080/api/rag/metrics
```

### Check Qdrant Status

```bash
curl http://localhost:6333/healthz
curl http://localhost:6333/collections/agentx_embeddings
```

### View Recent Ingestions

```bash
curl "http://localhost:3080/api/rag/documents?source=agentx-docs" | jq
```

### Test Search

```bash
curl -X POST http://localhost:3080/api/rag/search \
  -H "Content-Type: application/json" \
  -d '{"query": "RAG system", "topK": 3}'
```

---

## Best Practices

1. **Always compute SHA256 hash** - Enables deduplication
2. **Use consistent source names** - Group related documents
3. **Tag appropriately** - Enables filtered searches
4. **Include metadata** - Helps with debugging and auditing
5. **Monitor manifests** - Detect orphaned documents
6. **Regular cleanup** - Remove deleted files from RAG
7. **Test with dry-run** - Verify before full ingestion
8. **Use archive scripts** - Backup before major updates

---

## Migration Path

### From N2.3 Only → Complete Coverage

1. **Initial Archive**
   ```bash
   ./scripts/archive-md-files.sh
   ```

2. **Full RAG Update**
   ```bash
   node scripts/update-rag-from-md.js --source=agentx-complete
   ```

3. **Store Manifest** (via n8n or API)
   ```bash
   curl -X POST http://localhost:3080/api/rag/manifests \
     -H "x-api-key: YOUR_KEY" \
     -H "Content-Type: application/json" \
     -d @manifest.json
   ```

4. **Preview Cleanup**
   ```bash
   curl "http://localhost:3080/api/rag/deletion-preview?source=nas-docs&root=/mnt/datalake/RAG"
   ```

5. **Delete Orphans** (if needed)

---

## Related Documentation

- [RAG System Architecture](../architecture/RAG_SYSTEM.md)
- [N8N Workflows](N8N_WORKFLOWS.md)
- [n8n Ingestion Report](../reports/n8n-ingestion.md)
- [API Reference](../SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md)

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
