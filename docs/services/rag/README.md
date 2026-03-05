# RAG & Knowledge Service

**Agent:** RAGAgent
**Status:** Active

## Responsibility
Document ingestion, vector store management (Qdrant or in-memory), embedding generation with LRU caching, file watching for auto-updates, codebase synchronization, semantic search, and contextual compression.

## File Inventory

### Services (src/services/)
| File | Lines | Purpose |
|------|-------|---------|
| ragStore.js | 684 | RAG document management with chunking/embedding |
| ragFileWatcher.js | 637 | File system watcher for RAG document auto-updates |
| ragCompression.js | - | RAG context compression (30-50% token savings) |
| ragCodebaseSyncService.js | - | Codebase RAG synchronization |
| embeddings.js | - | Ollama embedding generation with LRU cache |
| tokenCounter.js | - | Token counting for cost tracking |
| vectorStore/QdrantVectorStore.js | 411 | Qdrant vector DB backend |
| vectorStore/InMemoryVectorStore.js | 199 | In-memory vector store (dev/test) |
| vectorStore/VectorStoreAdapter.js | 94 | Adapter pattern for store backends |
| vectorStore/factory.js | 39 | Factory for creating vector stores |

### Routes (routes/)
| File | Lines | Purpose |
|------|-------|---------|
| rag.js | 935 | RAG document ingestion and search endpoints |

### Models (models/)
| File | Lines | Purpose |
|------|-------|---------|
| RagManifest.js | 35 | RAG document manifest |
| EmbeddingCacheStats.js | 28 | Embedding cache statistics |

### Frontend (public/js/)
- databases.js, database-viewer.js, file-browser-simple.js

## APIs Exposed
- `POST /api/rag/ingest` — Ingest documents
- `POST /api/rag/search` — Semantic search
- `GET /api/rag/status` — Store status
- `GET /api/rag/manifest` — Document manifest

### Internal API
```javascript
const { getRagStore } = require('./src/services/ragStore');
const store = getRagStore();

store.search(query, options)     // Semantic search
store.ingest(document, metadata) // Document ingestion
store.getStatus()                // Store health

const { getEmbeddingsService } = require('./src/services/embeddings');
const embedder = getEmbeddingsService();

embedder.embed(text)             // Generate embedding vector
```

## Dependencies (Consumed)
| Service | Interface | What |
|---------|-----------|------|
| (none — leaf service) | Ollama API | Embedding model inference |
| (none — leaf service) | Qdrant API | Vector storage and search |

## Data Ownership
Exclusive write access to: RagManifest, EmbeddingCacheStats, Qdrant collections.

## Key Patterns
- Singleton: `getRagStore()` — single vector store per process
- Singleton: `getEmbeddingsService()` — shared LRU cache (50-80% hit rate)
- Chunking: 800 char chunks with 100 char overlap
- In-memory store is NOT persistent — use Qdrant for production
- Embedding cache cold starts — first queries after restart are slow
