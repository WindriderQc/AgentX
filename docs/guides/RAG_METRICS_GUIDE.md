# RAG Ingestion Metrics Guide

## Overview

This guide explains how to monitor and track RAG (Retrieval-Augmented Generation) ingestion metrics in AgentX after triggering document ingestion.

## Where to See Ingestion Results

### 1. Analytics Dashboard (Recommended)

Navigate to **Analytics Page** → **RAG Vector Store Metrics** section

**URL**: `http://localhost:3080/analytics.html`

The dashboard displays:

- **Total Documents**: Number of documents ingested across all sources
- **Total Chunks**: Number of text chunks (vectors) stored in Qdrant
- **Avg Chunks/Doc**: Average chunking efficiency per document
- **Store Health**: Real-time connection status to Qdrant

#### Documents by Source Table
Shows a breakdown of:
- Source name
- Number of documents per source
- Total chunks per source
- Average chunks per document

#### Timeline Information
- **Oldest Document**: When the first document was ingested
- **Newest Document**: Most recent ingestion timestamp

### 2. API Endpoints

#### GET `/api/rag/metrics`

Returns comprehensive RAG system metrics:

```json
{
  "status": "success",
  "healthy": true,
  "stats": {
    "documentCount": 10,
    "chunkCount": 150,
    "totalDocuments": 10,
    "totalChunks": 150,
    "avgChunksPerDoc": "15.00",
    "sourceBreakdown": {
      "github": {
        "count": 5,
        "chunks": 75
      },
      "confluence": {
        "count": 5,
        "chunks": 75
      }
    },
    "oldestDocument": "2025-01-01T10:00:00.000Z",
    "newestDocument": "2025-12-31T15:30:00.000Z"
  },
  "timestamp": "2025-12-31T16:00:00.000Z"
}
```

#### GET `/api/rag/documents`

Lists all ingested documents with their metadata:

```json
{
  "stats": {
    "documentCount": 10,
    "chunkCount": 150
  },
  "count": 10,
  "documents": [
    {
      "documentId": "abc123...",
      "source": "github",
      "path": "/repo/README.md",
      "title": "Project README",
      "chunkCount": 12,
      "tags": ["documentation"],
      "createdAt": "2025-12-31T10:00:00.000Z",
      "updatedAt": "2025-12-31T10:00:00.000Z"
    }
  ]
}
```

#### GET `/api/rag/collections/:collection/info`

Get detailed Qdrant collection information:

```json
{
  "status": "success",
  "collection": "agentx_embeddings",
  "info": {
    "status": "green",
    "vectors_count": 150,
    "indexed_vectors_count": 150,
    "points_count": 150,
    "segments_count": 1,
    "config": {
      "params": {
        "vectors": {
          "size": 768,
          "distance": "Cosine"
        }
      }
    }
  }
}
```

### 3. Enhanced Logging

After each ingestion, detailed logs are written with:

```
RAG document ingested: {
  status: 'created',          // or 'updated' or 'unchanged'
  documentId: 'abc123...',
  chunkCount: 12,
  processingTimeMs: 1234,     // Processing duration
  textLength: 5000,           // Original text length
  source: 'github',
  title: 'Project README'
}
```

**Log Location**: 
- Console output when running `npm run dev`
- `logs/` directory for production deployments

### 4. Direct Qdrant Access

For advanced debugging, you can query Qdrant directly:

**Qdrant Web UI**: `http://localhost:6333/dashboard`

**Qdrant REST API**:
```bash
# Get collection info
curl http://localhost:6333/collections/agentx_embeddings

# Count points
curl -X POST http://localhost:6333/collections/agentx_embeddings/points/count \
  -H "Content-Type: application/json" \
  -d '{}'

# Scroll through points
curl -X POST http://localhost:6333/collections/agentx_embeddings/points/scroll \
  -H "Content-Type: application/json" \
  -d '{"limit": 10, "with_payload": true, "with_vector": false}'
```

## Understanding Ingestion Status

### Status Types

- **`created`**: New document successfully ingested
- **`updated`**: Existing document updated with new content
- **`unchanged`**: Document hash matches existing, no changes made

### Key Metrics to Monitor

1. **Chunk Count**: Should be proportional to document length
   - ~800 characters per chunk (configurable)
   - More chunks = more granular search results

2. **Processing Time**: 
   - Typical: 100-500ms per document
   - Slow (>1s): May indicate Ollama embedding service issues

3. **Source Distribution**: Track which sources contribute most documents

4. **Health Status**: 
   - ✓ Healthy: Qdrant connected and responsive
   - ✗ Offline: Qdrant connection issues

## Troubleshooting

### No Metrics Showing

1. **Check Qdrant is running**:
   ```bash
   docker ps | grep qdrant
   # OR
   curl http://localhost:6333/healthz
   ```

2. **Verify environment variables**:
   ```bash
   echo $QDRANT_URL
   echo $QDRANT_COLLECTION
   ```

3. **Check logs for errors**:
   ```bash
   tail -f logs/agentx.log
   ```

### Ingestion Succeeds but No Vectors

- Check embedding service (Ollama) is running
- Verify `OLLAMA_HOST` environment variable
- Review logs for embedding generation errors

### Dashboard Not Updating

- Click the **Refresh** button in the RAG Metrics section
- Check browser console for JavaScript errors
- Verify authentication (must be logged in)

## Best Practices

1. **Monitor Regularly**: Check metrics after bulk ingestions
2. **Track Trends**: Compare chunk counts over time for consistency
3. **Source Tagging**: Use descriptive source names for better analytics
4. **Health Checks**: Set up alerts if `healthy: false`
5. **Clean Up**: Remove outdated documents to keep metrics meaningful

## Related Documentation

- [AgentX RAG Architecture](./architecture/RAG_ARCHITECTURE.md)
- [Qdrant Deployment Guide](./QDRANT_DEPLOYMENT.md)
- [V3 Contract Snapshot](../specs/V3_CONTRACT_SNAPSHOT.md)
