# V3 Contract Snapshot - RAG & Ingestion API

**Version:** 3.0.0  
**Date:** 2025-12-02  
**Authority:** Agent A (RAG Architect & Contract Owner)  
**Implementation:** Agent B (Backend & Retrieval Engineer)  
**Consumer:** Agent C (n8n Ingestion Engineer)

---

## ⚠️ IMMUTABLE CONTRACT

This document defines the **V3 API contracts** for AgentX RAG capabilities. These contracts are **frozen** for V3 and must be implemented exactly as specified.

**Rules:**
- ❌ Do NOT rename fields
- ❌ Do NOT change types
- ❌ Do NOT remove required fields
- ✅ MAY add optional fields (with defaults)
- ✅ MAY extend responses (non-breaking)

**For contract changes:** Propose to Agent A and version as V3.1 or V4.

---

## 1. RagStore Interface (Internal)

Internal abstraction that backend must implement. Not exposed as HTTP, but defines semantic contracts.

### Method: `upsertDocumentWithChunks(metadata, text)`

**Purpose:** Ingest a document, split into chunks, embed, and store in vector database.

**Input:**
```typescript
{
  metadata: {
    source: string;        // e.g. "github", "confluence", "local"
    path: string;          // URL or file path
    title: string;         // Document title
    hash?: string;         // Content hash (for dedup)
    tags?: string[];       // Optional categorization
    timestamp?: Date;      // Ingestion time
  },
  text: string;            // Raw document text
}
```

**Output:**
```typescript
{
  documentId: string;      // Unique ID assigned to document
  chunkCount: number;      // Number of chunks created
  status: 'created' | 'updated' | 'unchanged';
}
```

**Behavior:**
- Split `text` into chunks (512-1024 tokens recommended)
- Generate embeddings for each chunk
- Store with metadata in vector DB
- If `hash` matches existing document, return `unchanged`
- If document exists but content differs, update and return `updated`
- Otherwise return `created`

---

### Method: `searchSimilarChunks(query, options)`

**Purpose:** Semantic search for relevant document chunks.

**Input:**
```typescript
{
  query: string;           // User query or message
  options: {
    topK?: number;         // Default: 5, Max: 20
    minScore?: number;     // Min similarity (0-1), Default: 0.0
    filters?: {
      source?: string;     // Filter by source
      tags?: string[];     // Filter by tags (OR logic)
    };
  }
}
```

**Output:**
```typescript
[
  {
    text: string;          // Chunk content
    score: number;         // Similarity score (0-1)
    metadata: {
      documentId: string;
      source: string;
      path: string;
      title: string;
      chunkIndex: number;  // Position in original doc
      tags?: string[];
    }
  },
  // ... more results
]
```

**Behavior:**
- Embed the `query`
- Query vector store with filters
- Return top K results sorted by score descending
- Each result includes chunk text + metadata

---

## 2. HTTP Endpoints

### 2.1 Document Ingestion (n8n → Backend)

**Endpoint:** `POST /api/rag/ingest`

**Purpose:** Called by n8n workflows to ingest documents into RAG system.

**Request Body:**
```json
{
  "source": "string",      // REQUIRED: "github", "confluence", "notion", etc.
  "path": "string",        // REQUIRED: URL or file path
  "title": "string",       // REQUIRED: Document title
  "text": "string",        // REQUIRED: Full document text
  "hash": "string",        // OPTIONAL: Content hash (MD5/SHA256)
  "tags": ["string"],      // OPTIONAL: Tags for filtering
  "metadata": {}           // OPTIONAL: Additional metadata (preserved)
}
```

**Response (200 OK):**
```json
{
  "status": "created" | "updated" | "unchanged",
  "documentId": "string",
  "chunkCount": number
}
```

**Response (400 Bad Request):**
```json
{
  "error": "Validation error",
  "details": {
    "field": "source",
    "message": "source is required"
  }
}
```

**Response (500 Internal Server Error):**
```json
{
  "error": "Internal server error",
  "message": "string"
}
```

**Validation Rules:**
- `source`, `path`, `title`, `text` are REQUIRED
- `text` must be non-empty string
- `source` must match pattern: `^[a-zA-Z0-9_-]+$`
- `tags` (if provided) must be array of strings

**Behavior:**
- Validate required fields
- Call `RagStore.upsertDocumentWithChunks()`
- Return result matching contract exactly
- ⚠️ **DO NOT** add extra fields to response (breaks n8n parsing)

---

### 2.2 Semantic Search (Debug/Tooling)

**Endpoint:** `POST /api/rag/search`

**Purpose:** Developer and n8n testing endpoint for semantic search.

**Request Body:**
```json
{
  "query": "string",       // REQUIRED: Search query
  "topK": number,          // OPTIONAL: Default 5, Max 20
  "minScore": number,      // OPTIONAL: Default 0.0
  "filters": {             // OPTIONAL: Filter criteria
    "source": "string",
    "tags": ["string"]
  }
}
```

**Response (200 OK):**
```json
{
  "query": "string",       // Echo back query
  "resultCount": number,   // Number of results
  "results": [
    {
      "text": "string",
      "score": number,
      "metadata": {
        "documentId": "string",
        "source": "string",
        "path": "string",
        "title": "string",
        "chunkIndex": number,
        "tags": ["string"]
      }
    }
  ]
}
```

**Response (400 Bad Request):**
```json
{
  "error": "Validation error",
  "details": {
    "field": "query",
    "message": "query is required"
  }
}
```

**Validation Rules:**
- `query` is REQUIRED non-empty string
- `topK` if provided must be 1-20
- `minScore` if provided must be 0.0-1.0

---

### 2.3 Enhanced Chat with RAG (V3 Extension)

**Endpoint:** `POST /api/chat` (EXTENDED, not replaced)

**Purpose:** Existing V1/V2 chat endpoint extended with optional RAG capabilities.

**Request Body (NEW OPTIONAL FIELDS):**
```json
{
  // === V1/V2 FIELDS (unchanged) ===
  "model": "string",
  "messages": [{"role": "string", "content": "string"}],
  "system": "string",
  "options": {},
  "conversationId": "string",
  
  // === V3 NEW FIELDS ===
  "useRag": boolean,       // OPTIONAL: Enable RAG (default: false)
  "ragTopK": number,       // OPTIONAL: Top K results (default: 5)
  "ragFilters": {          // OPTIONAL: RAG filters
    "source": "string",
    "tags": ["string"]
  }
}
```

**Response (NEW OPTIONAL FIELDS):**
```json
{
  // === V1/V2 FIELDS (unchanged) ===
  "status": "success",
  "data": {
    "message": "string",
    "conversationId": "string"
  },
  
  // === V3 NEW FIELDS ===
  "ragUsed": boolean,      // Was RAG enabled for this request
  "ragSources": [          // Array of retrieved chunks (if RAG used)
    {
      "text": "string",    // First 200 chars of chunk
      "score": number,
      "source": "string",
      "title": "string"
    }
  ]
}
```

**Behavior:**
- **If `useRag` is false or undefined:**
  - Execute exact V1/V2 pipeline
  - `ragUsed` = false
  - `ragSources` = []

- **If `useRag` is true:**
  - Extract last user message as query
  - Call `RagStore.searchSimilarChunks(query, { topK: ragTopK, filters: ragFilters })`
  - Inject chunks into system prompt:
    ```
    === Retrieved Context ===
    [Source: {title}]
    {chunk_text}
    
    [Source: {title}]
    {chunk_text}
    === End Context ===
    
    {original_system_prompt}
    ```
  - Call LLM with enhanced prompt
  - Return response with `ragUsed` = true and `ragSources` populated

**Backwards Compatibility:**
- Existing V1/V2 clients that don't send `useRag` get exact same behavior
- New `ragUsed` and `ragSources` fields are additive (old clients can ignore)
- No breaking changes to existing response structure

---

## 3. Database Schema Extensions

### 3.1 Conversation Model (Extended)

Add to existing Mongoose `ConversationSchema`:

```javascript
{
  // ... existing V1/V2 fields ...
  
  // V3 additions:
  ragUsed: { type: Boolean, default: false },
  ragSources: [{
    text: String,        // Truncated chunk preview
    score: Number,
    source: String,
    title: String,
    documentId: String
  }]
}
```

### 3.2 RAG Documents Collection (NEW)

```javascript
const RagDocumentSchema = new Schema({
  documentId: { type: String, unique: true, required: true },
  source: { type: String, required: true, index: true },
  path: { type: String, required: true },
  title: { type: String, required: true },
  hash: String,
  tags: [String],
  chunkCount: Number,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
```

**Note:** Actual vector embeddings stored in vector database (Qdrant/Chroma/etc), this is metadata.

---

## 4. Embeddings Service Interface

Internal service for generating embeddings. Implementation flexible.

```typescript
interface EmbeddingsService {
  /**
   * Generate embeddings for multiple texts in batch
   * @param texts Array of text strings to embed
   * @returns Array of embedding vectors (same length as input)
   */
  embedTextBatch(texts: string[]): Promise<number[][]>;
  
  /**
   * Get embedding dimension
   */
  getDimension(): number;
}
```

**Recommended Implementation:**
- Use Ollama local embeddings model (e.g., `nomic-embed-text`)
- Endpoint: `POST http://localhost:11434/api/embeddings`
- Fallback: OpenAI embeddings API

---

## 5. Error Handling Standards

All endpoints must follow consistent error format:

```json
{
  "error": "string",       // Short error type
  "message": "string",     // Human-readable message
  "details": {}            // Optional: additional context
}
```

**HTTP Status Codes:**
- `200 OK` - Success
- `400 Bad Request` - Validation error
- `404 Not Found` - Resource not found
- `500 Internal Server Error` - Server error
- `503 Service Unavailable` - Vector store/Ollama unavailable

---

## 6. Implementation Notes

### Chunking Strategy
- **Size:** 512-1024 tokens (OpenAI tokenizer)
- **Overlap:** 50-100 tokens between chunks
- **Method:** Sentence-aware splitting (preserve paragraph boundaries)

### Vector Store Requirements
- Support for metadata filtering
- Cosine similarity search
- Min 384-dimensional vectors (common embedding size)
- Recommended: Qdrant (local) or Chroma

### Performance Targets
- Ingestion: < 5 seconds for 10KB document
- Search: < 500ms for query
- Embeddings: < 200ms per batch of 10 texts

---

## 7. Testing Contract Compliance

### For Agent B (Backend):
```bash
# Test ingestion
curl -X POST http://localhost:3080/api/rag/ingest \
  -H "Content-Type: application/json" \
  -d '{"source":"test","path":"/doc","title":"Test","text":"Content"}'

# Expected: {"status":"created","documentId":"...","chunkCount":1}

# Test search
curl -X POST http://localhost:3080/api/rag/search \
  -H "Content-Type: application/json" \
  -d '{"query":"test query","topK":5}'

# Test chat with RAG
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"llama2","messages":[{"role":"user","content":"Hi"}],"useRag":true}'
```

### For Agent C (n8n):
- Ingestion workflow must send all required fields
- Parse response for `status`, `documentId`, `chunkCount` ONLY
- Do NOT assume extra fields exist

---

## 8. Version History

| Version | Date | Changes |
|---------|------|---------|
| 3.0.0 | 2025-12-02 | Initial V3 RAG contract |

---

## 9. Contract Governance

**Owned by:** Agent A  
**Implemented by:** Agent B  
**Consumed by:** Agent C  

**Change Process:**
1. Propose change to Agent A
2. Agent A reviews for backwards compatibility
3. If breaking: increment to V4
4. If additive: add optional fields or new endpoints
5. Update this document with version bump

**Emergency Contact:**
If contract ambiguity is discovered during implementation, Agent B must:
1. Document the ambiguity
2. Propose clarification to Agent A
3. Implement most conservative interpretation
4. Add validation to prevent edge cases

---

**Contract Status:** ✅ **ACTIVE - V3.0.0**
