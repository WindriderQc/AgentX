# Agent C Workflow Changes

**Last Updated:** December 31, 2025

## Summary of Changes

**Workflows Removed (Redundant):**
1. ❌ **N1.1b** - Datalake Janitor Orchestrator (duplicate of N2.1)
2. ❌ **N1.2** - DataAPI Webhook Receiver (DataAPI doesn't push events to n8n)
3. ❌ **N2.2** - File Hash Enrichment (hashing now done by DataAPI Scanner natively)

**Workflows Updated:**
- ✅ **N2.1** - Now triggers DataAPI Scanner with `compute_hashes: true` and `hash_max_size: 104857600` (100MB)
- ✅ **N2.3** - RAG Document Ingestion (Production-ready after Dec 31 fixes)

**Final Workflow Count: 7** (down from 10)

---

## Active Workflows

| ID | Name | Trigger | Purpose |
|----|------|---------|---------|
| N1.1 | System Health Check | Every 5 min | Monitor all services |
| N1.3 | Ops AI Diagnostic | Webhook | AI-powered system analysis |
| N2.1 | NAS File Scanner + Hash | Daily 2AM | Trigger DataAPI scan with hashing |
| N2.3 | RAG Document Ingestion | Weekly Sun 3AM / Manual | Feed docs to AgentX RAG ✅ |
| N3.1 | Model Health Monitor | Every 10 min | Track Ollama latency |
| N3.2 | External AI Gateway | Webhook | Public AI API endpoint |
| N5.1 | Feedback Analysis | Weekly Sun 3AM | Prompt optimization |

---

## Key Improvements

### 1. N2.1 Simplified
**Before:**
- n8n runs shell commands
- n8n parses output
- n8n batches files
- n8n sends to DataAPI
- Shell compatibility issues (bash vs sh)

**After:**
- n8n triggers DataAPI endpoint
- DataAPI Scanner does everything
- No shell commands needed
- Built-in progress tracking
- SHA256 hashing included

### 2. Eliminated Redundancies
- **N1.1b = N2.1** - Same schedule, same trigger, same endpoint
- **N1.2** - DataAPI never pushes events (internal EventEmitter only)
- **N2.2** - DataAPI Scanner computes hashes during scan (no post-processing needed)

### 3. DataAPI Scanner Capabilities
```javascript
// Full feature set available via POST /api/v1/storage/scan
{
  roots: ["/mnt/media", "/mnt/datalake"],
  extensions: ["mp4", "mkv", ...],
  batch_size: 1000,
  compute_hashes: true,        // ← Enables SHA256
  hash_max_size: 104857600     // ← Skip files >100MB
}
```

Scanner handles:
- ✅ Recursive directory walking
- ✅ File stat collection (size, mtime, extension)
- ✅ SHA256 computation (streaming, memory-efficient)
- ✅ Batch MongoDB upserts (1000/batch)
- ✅ Progress tracking in nas_scans collection
- ✅ Error handling and recovery

---

## N2.3 Production Fixes (December 31, 2025)

The RAG Document Ingestion workflow required several fixes to work in the n8n Docker environment.

### Environment Discovery
- **n8n Host:** 192.168.2.199 (Docker container running Alpine Linux)
- **Shell:** BusyBox (not GNU coreutils)
- **NAS Mount:** `/mnt/datalake/RAG` (bind-mounted into container)

### Issues & Fixes

#### 1. BusyBox `find` Incompatibility
**Problem:** GNU `find -printf` not available in BusyBox.
**Fix:** Use `find ... -exec stat -c "%n|%s|%Y" {} +` instead.

```bash
# Before (fails on Alpine/BusyBox)
find "/mnt/datalake/RAG" -type f -name "*.txt" -mtime -7 -printf "%p|%s|%T@\n"

# After (works on Alpine/BusyBox)
find "/mnt/datalake/RAG" -type f -name "*.txt" -mtime -7 -exec stat -c "%n|%s|%Y" {} + 2>/dev/null | head -100
```

#### 2. "Execute Once" Flag on Loop Nodes
**Problem:** The "Find Recent Files" and "Read File Content" nodes had "Execute Once" enabled by default, causing only the first item to be processed.
**Fix:** Set `"executeOnce": false` explicitly in workflow JSON.

#### 3. Parse File List Logic
**Problem:** Original code used `$input.first()`, only processing the first directory pattern.
**Fix:** Loop through `$input.all()` to aggregate files from all patterns (*.md, *.txt, *.pdf).

#### 4. Metadata Preservation
**Problem:** The `cat` command in "Read File Content" replaces input JSON with stdout, losing file metadata.
**Fix:** Reference the original file list from "Filter Skipped" node using `$("Filter Skipped").all()`.

#### 5. JSON Body Format for HTTP Request
**Problem:** Using `JSON.stringify($json)` in n8n HTTP node when `specifyBody: "json"` is set causes double-encoding.
**Fix:** Use expression `={{ $json }}` directly.

#### 6. Success Status Recognition
**Problem:** Summarize Results node expected `status: 'success'`, but AgentX returns `status: 'created'`.
**Fix:** Accept `created`, `updated`, or presence of `documentId` as success indicators.

### Final Working Configuration

```json
{
  "Find Recent Files": {
    "command": "find ... -exec stat -c \"%n|%s|%Y\" {} +",
    "executeOnce": false
  },
  "Read File Content": {
    "command": "cat ... | head -c 50000",
    "executeOnce": false
  },
  "Ingest to AgentX RAG": {
    "jsonBody": "={{ $json }}"
  }
}
```

### Verification
- Qdrant point count increased from 36 → 38+ after successful run
- Workflow completes end-to-end (green checkmarks on all nodes)
- Summary shows "Ingested 2/2 documents"

---

## Next Steps

1. **Delete from n8n:** Remove N1.1b, N1.2, N2.2 workflows
2. **Re-import N2.1:** Updated version with hashing enabled
3. **Monitor scan:** Wait for current scan to complete and verify hashes in MongoDB
4. **Enable schedules:**
   - N1.1 (every 5 min)
   - N2.1 (daily 2AM)
   - N3.1 (every 10 min)
   - N5.1 (weekly Sunday 3AM)

---

## Testing Commands

```bash
# Check scan status
curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/storage/scans

# Verify files have hashes
curl -H "x-api-key: KEY" "http://192.168.2.33:3003/api/v1/files/browse?limit=10&hasHash=true"

# Check duplicate detection (requires hashes)
curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/files/duplicates
```
