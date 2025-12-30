# Agent C Workflow Changes - December 30, 2025

## Summary of Changes

**Workflows Removed (Redundant):**
1. ❌ **N1.1b** - Datalake Janitor Orchestrator (duplicate of N2.1)
2. ❌ **N1.2** - DataAPI Webhook Receiver (DataAPI doesn't push events to n8n)
3. ❌ **N2.2** - File Hash Enrichment (hashing now done by DataAPI Scanner natively)

**Workflows Updated:**
- ✅ **N2.1** - Now triggers DataAPI Scanner with `compute_hashes: true` and `hash_max_size: 104857600` (100MB)

**Final Workflow Count: 7** (down from 10)

---

## Active Workflows

| ID | Name | Trigger | Purpose |
|----|------|---------|---------|
| N1.1 | System Health Check | Every 5 min | Monitor all services |
| N1.3 | Ops AI Diagnostic | Webhook | AI-powered system analysis |
| N2.1 | NAS File Scanner + Hash | Daily 2AM | Trigger DataAPI scan with hashing |
| N2.3 | RAG Document Ingestion | Weekly/Manual | Feed docs to AgentX RAG |
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
