---
doc_type: permanent
authority: canonical
status: active
owner: rag
last_verified: 2026-10-01
---

# AgentX RAG — API Contract

> Default Compose URL: `http://127.0.0.1:3182`. A direct `npm start` uses port 3082 unless `PORT` is set.

**Envelope:** `{ "ok": true, "data": { ... }, "meta": { "durationMs": 42, "observedAt": "2026-08-28T12:00:00.000Z" } }`
**Errors:** `{ "ok": false, "error": "CODE", "detail": "..." }`

All `/api/rag` success and error envelopes include a fresh `meta.observedAt`
receipt. Health and status expose dependency state but omit internal service
URLs and provider endpoints.

## Health & Status

### GET /health

Readiness check (not behind `/api/rag`). Returns 503 when MongoDB or the
configured vector store is unavailable. The embedding model remains an
optional capability and is reported by `/api/rag/status`.

```bash
curl http://127.0.0.1:3182/health
# => { "ok": true, "status": "ok", "service": "agentx-rag", "db": "connected", "vectorStore": { "healthy": true, "type": "qdrant" } }
```

### GET /api/rag/status

Full health with dependency matrix and cache stats.

```bash
curl http://127.0.0.1:3182/api/rag/status
```

```json
{
  "ok": true,
  "data": {
    "documentCount": 12, "chunkCount": 340, "vectorDimension": 768,
    "vectorStore": { "healthy": true, "type": "qdrant" },
    "cache": { "hits": 50, "misses": 12, "size": 62 },
    "dependencies": {
      "mongodb": { "healthy": true },
      "embedding": { "healthy": true, "provider": "core-proxy", "model": "nomic-embed-text:v1.5" },
      "qdrant": { "healthy": true }
    },
    "healthy": true
  }
}
```

## Ingestion

### POST /api/rag/ingest

Ingest a text document (chunk + embed + store). `POST /api/rag/documents` is an alias.

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| text | string | yes | -- | Max 2,000,000 chars |
| source | string | no | `"api"` | For filtering |
| tags | string[] | no | `[]` | For filtering |
| chunkSize | int | no | 500 | 50-10,000 |
| chunkOverlap | int | no | 50 | 0 to chunkSize/2 |
| documentId | string | no | MD5 auto | Stable ID; re-ingest replaces |
| scope | string | no | -- | Supply together with sensitivity; see classification below |
| sensitivity | string | no | -- | Supply together with scope; see classification below |

Classification uses `scope`: `project`, `ecosystem`, `workflow`, `owner`,
`household`, `private_domain`; and `sensitivity`: `normal`, `private`,
`highly_private`. Both fields must be supplied together with valid values.
Re-ingesting an existing identity with a different classification returns
409 `MEMORY_CLASSIFICATION_CONFLICT`; ingestion does not implicitly relabel it.
These labels describe content, not authentication or an access grant.

An explicit `chunkOverlap: 0` disables overlap. If you reduce `chunkSize`
below 100, also supply an overlap no greater than half that size.

Ingestion is idempotent at the source/content boundary:

- A supplied `documentId` is an opaque, caller-owned source identity. Repeating
  that ID with unchanged content returns `status: "unchanged"` without another
  embedding pass. Changed content replaces that ID; distinct supplied IDs are
  never collapsed, even when their content matches.
- Without `documentId`, the backward-compatible automatic ID is derived from
  the supplied source spelling plus exact extracted text. Source-label identity
  additionally trims surrounding whitespace and applies Unicode NFC so an
  equivalent retry can reuse the existing automatic row. Different text creates
  a separate automatic revision, and different source labels remain distinct.
  New identity metadata uses a SHA-256 content digest; the historical automatic
  document ID format remains unchanged for backward compatibility.
- Approved filesystem ingestion may use its existing source-file hash as the
  unchanged-content proof for the same path ID. Existing rows are not merged or
  deleted by ingestion.

```bash
curl -X POST http://127.0.0.1:3182/api/rag/ingest \
  -H 'Content-Type: application/json' \
  -d '{ "text": "Content...", "source": "my-source", "tags": ["docs"] }'
# => { "ok": true, "data": { "documentId": "abc123", "chunkCount": 7, "status": "created" } }
```

A new document returns `created`, a replaced document `updated`, and an exact
repeat `unchanged`. The batch route below instead reports successful mutations
as `ok` and unchanged documents as `unchanged`.

An exact repeat returns the existing document and its passage count:

```json
{ "ok": true, "data": { "documentId": "abc123", "chunkCount": 7, "status": "unchanged", "unchanged": true, "deduplicated": false } }
```

**Errors:** 400 (validation), 409 `MEMORY_CLASSIFICATION_CONFLICT`, 503 `VECTOR_STORE_UNAVAILABLE`, 503 `EMBEDDING_SERVICE_UNAVAILABLE`

### POST /api/rag/ingest/batch

Bulk ingest up to 50 documents sequentially (configurable via `BATCH_MAX_DOCS`).

Each document uses the same fields, defaults, and validation as a single
import. Invalid input rejects the entire batch before any document is written;
the error identifies its index. Runtime failures after validation are reported
per document, so earlier successful imports may remain.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| documents | array | yes | Max 50 items |
| documents[].text | string | yes | Same validation as /ingest |
| documents[].source | string | no | |
| documents[].tags | string[] | no | |
| documents[].documentId | string | no | |

```bash
curl -X POST http://127.0.0.1:3182/api/rag/ingest/batch \
  -H 'Content-Type: application/json' \
  -d '{ "documents": [{ "text": "First...", "source": "batch" }, { "text": "Second...", "source": "batch" }] }'
```

```json
{ "ok": true, "data": { "total": 2, "succeeded": 2, "failed": 0, "results": [
  { "index": 0, "documentId": "abc123", "status": "ok", "chunkCount": 3 },
  { "index": 1, "documentId": "def456", "status": "ok", "chunkCount": 5 }
] } }
```

### POST /api/rag/ingest-scan

Async approved-corpus scan + ingestion. Returns 202 with jobId. Max 1
concurrent scan. The product policy defaults to the container-local
`/data/imports` directory, `.md` and `.txt`, and 1 MiB per file. No host path is
mounted by default. Environment/request values may narrow but cannot widen the
policy. Roots and files are realpath-checked before reads.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| limit | int | 5000 | Capped at 5000 |
| roots | string[] | configured | Restrict to specific dirs |

```bash
curl -X POST http://127.0.0.1:3182/api/rag/ingest-scan \
  -H 'Content-Type: application/json' -d '{ "limit": 100 }'
# => 202 { "ok": true, "data": { "jobId": "uuid", "status": "running" } }
```

**Errors:** 409 `SCAN_ALREADY_RUNNING`, 400 `INVALID_ROOTS`, 503 `MONGODB_UNAVAILABLE`

### GET /api/rag/ingest-scan/:jobId

Poll scan progress. Status: `running` | `completed` | `failed` | `cancelled`.

```bash
curl http://127.0.0.1:3182/api/rag/ingest-scan/uuid
```

```json
{ "ok": true, "data": {
  "jobId": "uuid", "status": "running",
  "progress": { "scanned": 50, "ingested": 30, "skipped": 20 },
  "startedAt": "2026-04-03T12:00:00.000Z", "completedAt": null
} }
```

### DELETE /api/rag/ingest-scan/:jobId

Request cooperative cancellation of a running scan. **Errors:** 404, 400 `JOB_NOT_RUNNING`

The response is immediate, but the job keeps `completedAt: null` until the
worker exits, and `POST /api/rag/ingest-scan` returns 409 during that interval.
The document already in flight may finish and persist its result; no further
document starts. The final summary and progress keep that document's outcome. A
later failure is recorded without replacing `cancelled`, and a late worker
callback never rewrites a finished job or releases another scan's slot.
Cancellation does not roll back accepted writes.

```bash
curl -X DELETE http://127.0.0.1:3182/api/rag/ingest-scan/uuid
# => { "ok": true, "data": { "jobId": "uuid", "status": "cancelled" } }
```

### GET /api/rag/ingestion/policy

Returns the public read-only import contract: container-local root, approved
roots, extension/size limits, and deterministic exclusions. It contains no
secrets or document contents.

```bash
curl http://127.0.0.1:3182/api/rag/ingestion/policy
```

## Search

### POST /api/rag/search

Semantic vector search across chunks.

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| query | string | yes | -- | Max 10,000 chars |
| topK | int | no | 5 | 1-20 |
| minScore | number | no | 0.0 | 0-1 |
| filters | object | no | -- | `{ source, tags }` |
| expand | bool | no | false | LLM query expansion; adds inference work; not combined with `hybrid` |
| hybrid | bool | no | false | Semantic + keyword retrieval; takes precedence over `expand` |
| rerank | bool | no | false | LLM judge re-ranking; adds inference work |
| compress | bool | no | false | Extract query-relevant sentences after retrieval; fail-soft |
| followLinks | bool or number | no | false | Follow retrieved Markdown links; true adds up to 2 notes, numeric values are truncated/clamped to 0-3 |

Optional search stages have variable costs depending on the corpus, model and
available inference host; these options do not promise fixed added latency.

```bash
curl -X POST http://127.0.0.1:3182/api/rag/search \
  -H 'Content-Type: application/json' \
  -d '{ "query": "How does the alert system work?", "topK": 5, "minScore": 0.3 }'
```

```json
{ "ok": true, "data": {
  "results": [{ "text": "The alert system monitors...", "score": 0.87,
    "metadata": { "source": "docs", "documentId": "abc123", "chunkIndex": 2 } }],
  "count": 1,
  "applied": { "hybrid": false, "expand": false }
} }
```

`applied` reports the retrieval modes that ran. Hybrid search and query
expansion do not compose: when both are requested, hybrid runs and
`applied.expand` is `false`. When the keyword half of a hybrid search fails,
the vector results are returned and `applied.keywordSearchFailed` is `true`.

**Errors:** 400 (validation), 503 `VECTOR_STORE_UNAVAILABLE`, 503 `EMBEDDING_SERVICE_UNAVAILABLE`

When `compress` is enabled, result objects may also include `compressedText`,
`originalText`, `wasCompressed`, and `compressionRatio`. Compression falls back
to the original text when inference is unavailable.

## Documents

### GET /api/rag/documents

List indexed documents with filtering and pagination. Each row is one document,
not one source group; multiple document rows may carry the same `source`
provenance label.

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| source | string | -- | Exact provenance-label filter |
| tags | string | -- | Comma-separated |
| limit | int | 50 | Max 200 |
| offset | int | 0 | |

```bash
curl "http://127.0.0.1:3182/api/rag/documents?source=docs&limit=20"
# => { "ok": true, "data": { "documents": [...], "total": 1, "limit": 20, "offset": 0 } }
```

### GET /api/rag/documents/:id

Document metadata. **Errors:** 404

```bash
curl http://127.0.0.1:3182/api/rag/documents/abc123
# => { "ok": true, "data": { "documentId": "abc123", "source": "docs", "chunkCount": 7, "metadata": { "tags": ["api"], "hash": "md5" } } }
```

### GET /api/rag/documents/:id/chunks

All chunks for a document. **Errors:** 404

```bash
curl http://127.0.0.1:3182/api/rag/documents/abc123/chunks
# => { "ok": true, "data": { "documentId": "abc123", "chunks": [{ "chunkIndex": 0, "text": "...", "metadata": {} }] } }
```

### DELETE /api/rag/documents/:id

Delete a document and all its chunks. The JSON body must contain the exact
case-sensitive phrase `DELETE <full document ID>` in `confirmation`. This
destructive-action confirmation is an additional safety gate; it does not
replace or grant operator authorization at the deployment boundary.

**Errors:** 400 `CONFIRMATION_REQUIRED`, 404 when no chunk carries that ID

```bash
curl -X DELETE http://127.0.0.1:3182/api/rag/documents/abc123 \
  -H 'Content-Type: application/json' \
  -d '{ "confirmation": "DELETE abc123" }'
# => { "ok": true, "data": { "documentId": "abc123", "filesReset": 1 } }
```

Deleting a document also clears the index state of the scanned file records
(`nas_files`) that produced it; `filesReset` counts them (`null` when MongoDB
was unavailable). A file still under an ingest root is therefore ingested
again by the next scan. To keep a file out of the index, exclude it through
the ingestion policy instead.

When confirmation is missing or does not match the decoded route ID exactly,
the store is not called. The error includes
`confirmation: { "field": "confirmation", "expected": "DELETE abc123" }`.

## Manifests & Cleanup

### POST /api/rag/manifests

Store a folder scan snapshot. Used by ingest-scan.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| source | string | yes | Source identifier |
| root | string | yes | Root directory path |
| scanId | string | no | Scan identifier |
| files | array | yes | `[{ path, size }]` |

```bash
curl -X POST http://127.0.0.1:3182/api/rag/manifests \
  -H 'Content-Type: application/json' \
  -d '{ "source": "local-import", "root": "/data/imports", "files": [{ "path": "/data/imports/f.txt", "size": 1024 }] }'
# => { "ok": true, "data": { "manifestId": "...", "source": "local-import", "stats": { "fileCount": 1, "totalBytes": 1024 } } }
```

### GET /api/rag/manifests/latest

Most recent manifest. Optional `?source=X` filter. Returns `data: null` if none exists.

```bash
curl "http://127.0.0.1:3182/api/rag/manifests/latest?source=local-import"
```

### GET /api/rag/deletion-preview

Compare manifest vs indexed docs. Omit `source` for multi-source aggregate.

```bash
curl "http://127.0.0.1:3182/api/rag/deletion-preview?source=local-import"
# => { "ok": true, "data": { "source": "local-import", "manifestFiles": 50, "indexedDocs": 55, "stale": [...], "fresh": 50 } }
```

### POST /api/rag/cleanup

Delete stale documents. Dry-run by default.

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| source | string | yes | -- | Source to clean |
| dryRun | bool | no | true | Set false to delete |
| manifestId | string | no | latest | Specific manifest |
| maxDeletes | int | no | 100 | Safety cap (max 500) |
| confirmation | string | when dryRun is false | -- | Exact phrase: `DELETE STALE DOCUMENTS FROM <trimmed source>` |

Inspect `deletion-preview` and a dry-run before deleting. A dry-run needs no
confirmation and leaves documents intact:

```bash
curl -X POST http://127.0.0.1:3182/api/rag/cleanup \
  -H 'Content-Type: application/json' \
  -d '{ "source": "local-import", "dryRun": true, "maxDeletes": 100 }'
```

After reviewing that result, an explicitly confirmed deletion uses:

```bash
curl -X POST http://127.0.0.1:3182/api/rag/cleanup \
  -H 'Content-Type: application/json' \
  -d '{ "source": "local-import", "dryRun": false, "maxDeletes": 100, "confirmation": "DELETE STALE DOCUMENTS FROM local-import" }'
# => { "ok": true, "data": { "dryRun": false, "deleted": ["doc1"], "errors": [], "filesReset": 1, "stats": { "attempted": 1, "succeeded": 1, "failed": 0, "elapsedMs": 150 } } }
```

## Embedding Migration

### GET /api/rag/embedding-migration/status

Check dimension mismatch between current model and stored vectors.

```bash
curl http://127.0.0.1:3182/api/rag/embedding-migration/status
# => { "ok": true, "data": { "currentModel": "nomic-embed-text:v1.5", "currentDimension": 768, "storedDimension": 768, "dimensionMatch": true, "migrationNeeded": false, "documentCount": 12, "chunkCount": 340 } }
```

### POST /api/rag/embedding-migration/reindex

Re-embed all documents in place with the current model. Requires the exact
`confirmation` phrase `REINDEX ALL DOCUMENTS`. Returns async 202 + jobId.
When dimensions already match, the no-op guard returns `MIGRATION_NOT_NEEDED`
unless the JSON boolean `force: true` explicitly requests regeneration.
For an intentional same-dimension regeneration, after checking status:

```bash
curl -X POST http://127.0.0.1:3182/api/rag/embedding-migration/reindex \
  -H 'Content-Type: application/json' \
  -d '{ "confirmation": "REINDEX ALL DOCUMENTS", "force": true }'
# => 202 { "ok": true, "data": { "jobId": "reindex-...", "status": "running" } }
```

**Errors:** 400 `CONFIRMATION_REQUIRED`, 400 `MIGRATION_NOT_NEEDED`, 409 `REINDEX_ALREADY_RUNNING`

Reindex re-embeds in place, so it only suits a model with the same dimension.
A model with another dimension uses a new collection:
`scripts/migrate-embedding-collection.js` copies every document from a source
collection into a target one (see "Switching the embedding model" in
`docs/OPERATIONS.md`).

Job tracking is in process memory and is lost on restart. Poll per-document
failures: a completed job can contain failed documents. Documents without the
original-text payload must be re-ingested from their approved sources before
they can be reindexed.

### GET /api/rag/embedding-migration/reindex/:jobId

Poll reindex progress.

```bash
curl http://127.0.0.1:3182/api/rag/embedding-migration/reindex/reindex-123
# => { "ok": true, "data": { "jobId": "reindex-123", "status": "running", "progress": { "total": 12, "processed": 5, "succeeded": 5, "failed": 0, "errors": [] } } }
```

## Metrics & Telemetry

### GET /api/rag/metrics

Totals, per-source breakdown, last ingest timestamp.

```bash
curl http://127.0.0.1:3182/api/rag/metrics
# => { "ok": true, "data": { "totals": { "documents": 12, "chunks": 340 }, "bySource": [...], "lastIngest": { "timestamp": "...", "source": "docs" } } }
```

### GET /api/rag/telemetry/ingest

Recent ingest telemetry. Params: `?limit=50&source=X&status=success|failed`

```bash
curl "http://127.0.0.1:3182/api/rag/telemetry/ingest?limit=10"
# => { "ok": true, "data": { "jobs": [{ "jobId": "...", "source": "api", "status": "success", "totalTimeMs": 230 }], "count": 1 } }
```

### GET /api/rag/telemetry/ingest/summary

Aggregate ingest stats (all-time + last 24h).

```bash
curl http://127.0.0.1:3182/api/rag/telemetry/ingest/summary
# => { "ok": true, "data": { "totalIngests": 150, "successRate": 97.33, "avgTotalTimeMs": 450, "last24h": { "total": 12, "success": 11, "failed": 1 }, "lastIngestAt": "..." } }
```

## Cache

### POST /api/rag/cache/clear

Clear in-memory embedding cache.

```bash
curl -X POST http://127.0.0.1:3182/api/rag/cache/clear
# => { "ok": true, "data": { "cleared": true } }
```

## Qdrant Snapshots

These endpoints proxy collection-level Qdrant snapshots. Snapshot names may
contain letters, numbers, dots, underscores, and hyphens only.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/rag/snapshots` | POST | Create a snapshot of the configured collection |
| `/api/rag/snapshots` | GET | List collection snapshots |
| `/api/rag/snapshots/:name/download` | GET | Stream snapshot bytes to Core |
| `/api/rag/snapshots/:name` | DELETE | Delete a named snapshot |
| `/api/rag/snapshots/:name/restore` | POST | Controlled offline rehearsal only |

Every snapshot route is an internal Core↔RAG contract.
Responses expose logical snapshot metadata only, never Qdrant URLs, storage
roots, or filesystem paths. Restore returns `OFFLINE_RESTORE_REQUIRED` by
default and remains disabled until a controlled offline rehearsal is explicitly
enabled. Snapshot operations return 502 when Qdrant cannot complete the request. Delete
returns 404 when Qdrant reports that the named snapshot does not exist.

## Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `VECTOR_STORE_UNAVAILABLE` | 503 | Qdrant unreachable |
| `EMBEDDING_SERVICE_UNAVAILABLE` | 503 | Embedding provider (Ollama) down |
| `SCAN_ALREADY_RUNNING` | 409 | Ingest-scan already in progress |
| `REINDEX_ALREADY_RUNNING` | 409 | Reindex migration in progress |
| `CONFIRMATION_REQUIRED` | 400 | Endpoint-specific destructive confirmation is missing or invalid |
| `MONGODB_UNAVAILABLE` | 503 | MongoDB not connected |
| `INVALID_ROOTS` | 400 | Scan roots outside configured paths |
| `JOB_NOT_RUNNING` | 400 | Cannot cancel non-running job |
| Validation messages | 400 | Missing/invalid fields |
