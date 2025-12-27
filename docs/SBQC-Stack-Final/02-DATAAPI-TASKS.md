# 02 - DataAPI Tasks

**Repository:** https://github.com/WindriderQc/DataAPI  
**Running at:** http://192.168.2.33:3003  
**Database:** MongoDB `SBQC` @ 192.168.2.33:27017

---

## Phase 0: Validation & Testing (Priority 1)

Before adding new features, validate that existing endpoints work correctly.

### Task D0.1: Integration Event Sink Validation
**Context:** `routes/integrations.js`

> ⚠️ **NOTE:** DataAPI does NOT have `/api/v1/n8n/*` routes. Those were migrated to AgentX.
> DataAPI provides `/api/v1/storage/*`, `/api/v1/files/*`, and `/integrations/events/n8n`.

```bash
# Test command - Integration event sink (receives events FROM n8n):
curl -X POST -H "Content-Type: application/json" \
  http://192.168.2.33:3003/integrations/events/n8n \
  -d '{"workflow_id": "test", "event_type": "health_probe", "data": {}}'
```

**Acceptance Criteria:**
- [ ] Event is logged to `SBQC.integration_events`
- [ ] Response includes `{ok: true, id: "..."}`
- [ ] Works without API key (open endpoint for n8n to POST to)

---

### Task D0.2: Storage Scan Validation
**Context:** `controllers/storageController.js`, `routes/api.routes.js`

```bash
# Test commands (use API key OR session auth):
curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/storage/scans
curl -X POST -H "x-api-key: KEY" -H "Content-Type: application/json" \
  http://192.168.2.33:3003/api/v1/storage/scan \
  -d '{"roots": ["/tmp/test"], "extensions": ["txt"]}'
```

**Acceptance Criteria:**
- [ ] List scans returns recent scans
- [ ] Create scan record works  
- [ ] Get scan status via `/api/v1/storage/status/:scan_id`
- [ ] Scan records persist to MongoDB `SBQC.nas_scans`

---

### Task D0.3: File Browser Validation
**Context:** `controllers/fileBrowserController.js`

```bash
# Test commands (use API key OR session auth):
curl -H "x-api-key: KEY" "http://192.168.2.33:3003/api/v1/files/browse?extension=mp4&limit=10"
curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/files/stats
curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/files/duplicates
curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/files/tree
curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/files/cleanup-recommendations
```

**Acceptance Criteria:**
- [ ] Query files by extension works
- [ ] File stats aggregation returns by extension/size
- [ ] Duplicate detection works (needs data first)

---

## Phase 1: SBQC Ops Agent Support (Priority 1)

> **Architecture Note:** DataAPI provides data storage/retrieval. n8n workflow triggering
> is handled by AgentX at `/api/n8n/*`. DataAPI only RECEIVES events at `/integrations/events/n8n`.

### Task D1.1: Add System Health Aggregation Endpoint
**New Endpoint:** `GET /api/v1/system/health`

Returns aggregated health of all connected systems for SBQC Ops agent.

**Implementation:**
```javascript
// routes/api.routes.js - Add new endpoint

router.get('/system/health', requireEitherAuth, async (req, res) => {
  const results = {
    dataapi: { status: 'ok', timestamp: new Date() },
    mongodb: { status: 'unknown' },
    ollama_99: { status: 'unknown' },
    ollama_12: { status: 'unknown' }
  };
  
  // Check MongoDB
  try {
    await req.app.locals.dbs.mainDb.command({ ping: 1 });
    results.mongodb = { status: 'connected' };
  } catch (e) {
    results.mongodb = { status: 'error', message: e.message };
  }
  
  // Check Ollama hosts (optional, if env vars set)
  // ... fetch with timeout to :11434/api/tags
  
  res.json({ status: 'success', data: results });
});
```

**Acceptance Criteria:**
- [ ] Endpoint returns aggregated health status
- [ ] Includes MongoDB ping result
- [ ] Optional: Includes Ollama host status

---

### Task D1.2: Add Storage Summary Endpoint
**New Endpoint:** `GET /api/v1/storage/summary`

Quick summary for SBQC Ops agent to report on.

**Response Schema:**
```json
{
  "status": "success",
  "data": {
    "totalFiles": 150234,
    "totalSize": "1.2 TB",
    "lastScan": "2025-12-25T02:00:00Z",
    "scanStatus": "completed",
    "duplicatesFound": 342,
    "potentialSavings": "45 GB"
  }
}
```

**Acceptance Criteria:**
- [ ] Aggregates nas_files collection stats
- [ ] Reports last scan info
- [ ] Calculates duplicate savings (if dedupe implemented)

---

## Phase 2: Datalake Janitor Features (Priority 2)

### Task D2.1: Add SHA256 Hashing to File Records
**Context:** File scanning workflow

**Schema Update:** Add `hash` field to nas_files documents

```javascript
// When processing files, compute hash
const crypto = require('crypto');
const fs = require('fs');

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
```

**New Endpoint:** `POST /api/v1/files/enrich`

Accepts file paths, computes hashes, updates records.

**Acceptance Criteria:**
- [ ] Hash computed for files during enrichment
- [ ] Hash stored in `nas_files.hash` field
- [ ] Endpoint allows batch enrichment

---

### Task D2.2: Enhanced Duplicate Detection
**Endpoint Enhancement:** `GET /api/v1/files/duplicates`

**Current:** Basic duplicate detection  
**Enhanced:** Group by hash, show all copies, calculate savings

**Response Schema:**
```json
{
  "status": "success",
  "data": {
    "groups": [
      {
        "hash": "abc123...",
        "size": 1500000,
        "count": 3,
        "files": [
          {"path": "/mnt/nas/a.mp4", "modified": "2025-01-01"},
          {"path": "/mnt/nas/copy/a.mp4", "modified": "2025-06-01"},
          {"path": "/mnt/nas/backup/a.mp4", "modified": "2024-12-01"}
        ],
        "canonical": "/mnt/nas/a.mp4",
        "suggestion": "delete 2 copies, save 3MB"
      }
    ],
    "totalGroups": 45,
    "potentialSavings": "2.5 GB"
  }
}
```

**Acceptance Criteria:**
- [ ] Groups files by hash
- [ ] Identifies canonical copy (oldest or user-defined)
- [ ] Calculates savings

---

### Task D2.3: Add File Metadata Extraction
**New Endpoint:** `POST /api/v1/files/extract-metadata`

Extract EXIF, duration, dimensions for media files.

**Implementation Notes:**
- Use `exiftool` or `sharp` for images
- Use `ffprobe` for video/audio
- Store in `nas_files.metadata` subdocument

**Acceptance Criteria:**
- [ ] Images: dimensions, camera, date taken
- [ ] Videos: duration, resolution, codec
- [ ] Audio: duration, bitrate, artist/album

---

### Task D2.4: Dedupe Suggestions Endpoint
**New Endpoint:** `GET /api/v1/files/dedupe/suggestions`

Returns actionable delete suggestions based on duplicate analysis.

**Query Params:**
- `minSavings`: Minimum size to suggest (default: 10MB)
- `strategy`: `oldest`, `newest`, `shortest-path`
- `dryRun`: If true, don't mark files

**Acceptance Criteria:**
- [ ] Returns list of files safe to delete
- [ ] Preserves canonical copy
- [ ] Supports dry-run mode

---

### Task D2.5: RAG Embedding Storage for File Metadata
**New Endpoint:** `POST /api/v1/files/embed`

Generate embeddings for file paths/metadata for semantic search.

**Implementation:**
- Call Ollama nomic-embed-text for file descriptions
- Store vectors in `nas_chunks` collection (or integrate with AgentX RAG)

**Acceptance Criteria:**
- [ ] Embeddings generated for file metadata
- [ ] Searchable via semantic query
- [ ] Integrates with AgentX RAG store OR uses own vector store

---

## Phase 3: Multi-Model Support (Priority 3)

### Task D3.1: Model Registry Endpoint
**New Endpoint:** `GET /api/v1/ollama/models`

Aggregates models from all Ollama hosts.

**Response:**
```json
{
  "status": "success",
  "data": {
    "hosts": {
      "192.168.2.99:11434": {
        "status": "online",
        "models": ["qwen2.5:7b", "whisper"]
      },
      "192.168.2.12:11434": {
        "status": "online",
        "models": ["llama3.3:70b-q4", "deepseek-r1:32b", "gemma3:12b", "nomic-embed-text"]
      }
    }
  }
}
```

**Acceptance Criteria:**
- [ ] Queries all configured Ollama hosts
- [ ] Returns unified model list
- [ ] Handles offline hosts gracefully

---

## Task Summary Table

| ID | Task | Priority | Depends On | Complexity |
|----|------|----------|------------|------------|
| D0.1 | Health validation | 1 | - | Low |
| D0.2 | Storage scan validation | 1 | - | Low |
| D0.3 | File browser validation | 1 | D0.2 | Low |
| D0.4 | Integration sink validation | 1 | - | Low |
| D0.5 | Webhook trigger validation | 1 | n8n setup | Medium |
| D1.1 | System health aggregation | 1 | D0.1 | Medium |
| D1.2 | Storage summary | 1 | D0.3 | Medium |
| D2.1 | SHA256 hashing | 2 | D0.2 | Medium |
| D2.2 | Enhanced duplicates | 2 | D2.1 | Medium |
| D2.3 | Metadata extraction | 2 | D0.2 | High |
| D2.4 | Dedupe suggestions | 2 | D2.2 | Medium |
| D2.5 | RAG embedding | 2 | AgentX RAG | High |
| D3.1 | Model registry | 3 | - | Medium |

---

## Agent Instructions

When working on DataAPI tasks:

1. **Read existing code first** - Check the relevant controller/route files
2. **Follow patterns** - Use `n8nAuth` middleware for n8n endpoints
3. **Standardized responses** - Always use `{status: "success/error", data/message}`
4. **Test with curl** - Validate endpoints manually before moving on
5. **Update documentation** - Add to `N8N_INTEGRATION.md` for new endpoints
