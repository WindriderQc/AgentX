# V3: RAG + n8n Ingestion - Architecture & Contracts

**Version:** 3.0.0 (Snapshot)
**Date:** 2024-10-24
**Author:** Agent A (RAG Architect)

---

## 1. Architecture Overview

AgentX V3 introduces a **Retrieval-Augmented Generation (RAG)** pipeline to the existing local AI assistant. This allows the system to ingest external documents (via n8n workflows) and retrieve relevant context to answer user queries more accurately.

The architecture decouples **Ingestion** (getting data in) from **Retrieval** (getting data out) and **Generation** (using data).

### High-Level Flow

1.  **Ingestion (Agent C):**
    *   **Source**: Files (PDFs, MDs), APIs, Web.
    *   **Process**: n8n workflows read sources -> extract text -> format to JSON.
    *   **Transport**: `POST /api/rag/ingest` (AgentX Backend).

2.  **Storage (Agent B):**
    *   **Process**: Receive payload -> Chunk text -> Compute Embeddings -> Upsert to Vector Store.
    *   **Store**: A Vector Database (e.g., Qdrant, Chroma).

3.  **Retrieval & Chat (Agent B):**
    *   **User Request**: `POST /api/chat` with `useRag: true`.
    *   **Process**:
        1.  Embed user query.
        2.  `RagStore.searchSimilarChunks(queryVector)`.
        3.  Inject top-K chunks into the System Prompt.
        4.  Send to LLM (Ollama).
    *   **Response**: Return answer + metadata (`ragUsed`, `ragSources`).

---

## 2. RAG Model (Conceptual)

### Core Entities

#### `Document`
Represents a unique logical source file or object.
*   **Purpose**: Tracking lineage and managing updates.
*   **Key Fields**: `documentId` (unique), `source` (e.g., "docs-folder"), `path` (e.g., "guides/readme.md"), `hash` (content signature).

#### `Chunk`
A slice of text from a `Document`, enriched with vector embeddings.
*   **Purpose**: The unit of retrieval.
*   **Key Fields**:
    *   `chunkId`: Unique ID.
    *   `documentId`: Link to parent.
    *   `text`: The actual text snippet.
    *   `embedding`: Vector representation (e.g., 384-dim or 768-dim array).
    *   `metadata`: JSON object containing `source`, `path`, `tags`, etc.

---

## 3. RagStore Interface (Abstract)

Agent B must implement a module/class `RagStore` that adheres to this interface. This abstracts the underlying vector database implementation.

```typescript
interface RagStore {
  /**
   * Upserts a document and its chunks.
   * - Should idempotent-ly update if documentId exists.
   * - Should handle chunking (or accept pre-chunked data if we move chunking to API layer,
   *   but for V3, backend handles chunking logic for consistency).
   */
  upsertDocument(
    metadata: {
      source: string;
      path: string;
      title?: string;
      tags?: string[];
      hash?: string;
    },
    fullText: string
  ): Promise<{
    documentId: string;
    chunkCount: number;
    status: 'created' | 'updated' | 'unchanged';
  }>;

  /**
   * Searches for similar text chunks.
   */
  search(
    queryText: string,
    options?: {
      topK?: number; // default 5
      filters?: {
        source?: string;
        tags?: string[]; // exact match one-of
      };
    }
  ): Promise<ChunkResult[]>;
}

interface ChunkResult {
  text: string;
  score: number; // 0.0 to 1.0 similarity
  metadata: {
    documentId: string;
    chunkId: string;
    source: string;
    path: string;
    tags?: string[];
    [key: string]: any;
  };
}
```

---

## 4. V3 Contract Snapshot (Source of Truth)

### A. Ingestion Endpoint (Internal/n8n)

**Path**: `POST /api/rag/ingest`
**Purpose**: Receives raw text from n8n for processing and storage.

**Request Body**:
```json
{
  "source": "docs-folder",           // Required: Origin identifier
  "path": "guides/agentx-v3.md",     // Required: Unique path within source
  "title": "AgentX V3 design",       // Optional: Display title
  "text": "Full plain-text content...", // Required: The content to chunk
  "tags": ["agentx", "design"],      // Optional: Categorization
  "hash": "sha256-hash-value"        // Optional: For deduplication checks
}
```

**Response Body**:
```json
{
  "status": "created",               // "created" | "updated" | "unchanged"
  "documentId": "doc_generated_id",
  "chunkCount": 12
}
```

### B. Search Debug Endpoint (Dev Tools)

**Path**: `POST /api/rag/search`
**Purpose**: Debugging retrieval without invoking the LLM.

**Request Body**:
```json
{
  "query": "How does V3 ingestion work?",
  "topK": 5,                         // Optional, default 5
  "filters": {                       // Optional
    "source": "docs-folder",
    "tags": ["agentx"]
  }
}
```

**Response Body**:
```json
{
  "results": [
    {
      "text": "Matching snippet text...",
      "score": 0.87,
      "metadata": {
        "documentId": "doc_123",
        "chunkId": "chunk_01",
        "path": "guides/agentx-v3.md",
        "source": "docs-folder",
        "tags": ["agentx", "design"]
      }
    }
  ]
}
```

### C. Chat Extension (RAG Options)

**Path**: `POST /api/chat` (Update)
**Purpose**: Standard chat interaction, now with optional RAG capabilities.

**Request Extension** (Fields added to V1/V2 request):
```json
{
  "message": "user message...",
  // ... existing V1/V2 fields (target, model, system, etc.)

  "useRag": true,                    // Optional: Enable RAG
  "ragTopK": 5,                      // Optional: Override default chunk count
  "ragFilters": {                    // Optional: Restrict search space
    "tags": ["agentx"],
    "source": "docs-folder"
  }
}
```

**Response Extension** (Fields added to V1/V2 response):
```json
{
  "status": "success",
  "data": { ... },                   // Existing Ollama response
  "conversationId": "...",           // Existing ID

  // NEW FIELDS
  "ragUsed": true,                   // Boolean: Was RAG actually performed?
  "ragSources": [                    // Array of sources used (if any)
    {
      "documentId": "doc_123",
      "chunkId": "chunk_01",
      "score": 0.87,
      "metadata": { "title": "..." }
    }
  ]
}
```

**Behavior Spec**:
1.  **`useRag: false` (or missing)**: Execute standard V2 logic. `ragUsed` in response is `false` or omitted.
2.  **`useRag: true`**:
    *   Compute embedding for user's message (or the last message in `messages`).
    *   Call `RagStore.search`.
    *   If results found:
        *   Format results into a "Context Block".
        *   Prepend/Inject this block into the `system` prompt (or a new context message).
        *   Prompt Template:
            ```text
            [CONTEXT START]
            ...snippets...
            [CONTEXT END]

            Based on the context above, answer the user: ...
            ```
    *   Execute LLM call.
    *   Return response with `ragUsed: true` and `ragSources`.

---

## 5. Task Lists & Acceptance Criteria

### Agent B (Backend & Retrieval)

*   [ ] **Install Dependencies**: Add necessary packages for the chosen vector store (e.g., `chromadb`) and an embedding library (e.g., `xenova/transformers` or use Ollama's embedding API).
*   [ ] **Implement `RagStore`**: Create the service layer implementing the interface defined above.
*   [ ] **Implement `/api/rag/ingest`**:
    *   Validate input payload against V3 Contract.
    *   Call `RagStore.upsertDocument`.
    *   Return correct JSON response.
*   [ ] **Implement `/api/rag/search`**:
    *   Validate input.
    *   Call `RagStore.search`.
    *   Return results.
*   [ ] **Update `/api/chat`**:
    *   Parse `useRag`, `ragTopK`, `ragFilters`.
    *   Implement the context injection logic.
    *   Ensure regression testing: calling without `useRag` must behave exactly as V2.
    *   Include `ragUsed` and `ragSources` in the response.

### Agent C (n8n Ingestion)

*   [ ] **Configure n8n Workflow**:
    *   Trigger: File Watcher / Cron / Webhook.
    *   Read File: Get text content from source.
*   [ ] **Transform Data**:
    *   Clean text if necessary.
    *   Prepare JSON payload matching the **Ingestion Contract** (`source`, `path`, `text`, etc.).
*   [ ] **HTTP Request**:
    *   Target: `POST http://host.docker.internal:3000/api/rag/ingest` (or appropriate AgentX URL).
    *   Auth: (None for now, or match existing).
*   [ ] **Error Handling**:
    *   Handle non-200 responses.
    *   Log status/chunkCount from response.
