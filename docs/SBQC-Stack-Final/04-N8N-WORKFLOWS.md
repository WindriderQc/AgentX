# 04 - n8n Workflow Specifications

**n8n Instance:** https://n8n.specialblend.icu (http://192.168.2.199:5678)  
**SMB Mounts:** To be configured on the n8n host

---

## Design Principles (Non-Negotiable)

These rules ensure the system stays maintainable and doesn't rot:

### Role Separation
- **n8n** = Orchestration, scheduling, glue, and audit. Never "thinks".
- **AgentX** = The only AI brain. All reasoning goes through AgentX.
- **DataAPI** = Storage + truth. Source of file/scan data.
- **Ollama** = Inference only. n8n never calls Ollama directly for reasoning.

### Design Smells (Stop If You See These)
- ❌ n8n making decisions instead of AgentX
- ❌ Ollama called directly from n8n for reasoning
- ❌ Large file logic inside Code nodes
- ❌ Missing integration event logs
- ❌ Silent failures (no sink logging)

### Workflow Dependency Order
Build and test in this order:
1. N1.1 System Health → N1.3 Ops Diagnostic
2. N2.1 NAS Scan → N2.2 Inverse Scan → N2.3 RAG Ingest
3. N3.1 Model Health → N3.2 AI Gateway
4. N5.1 Feedback Analysis

### Scan Lifecycle State Machine
```
queued → running → ingesting → hashing(optional) → done | failed
```

### Event-Driven Architecture
All workflows should emit events to the integration sink:
- `scan.started`, `scan.batch_ingested`, `scan.done`, `scan.failed`
- `health_probe`, `ops_alert`
- `rag.ingested`, `feedback.analyzed`

---

## Important Endpoint Notes

> **DataAPI (port 3003):** Storage/file data endpoints
> - `/api/v1/storage/*` - Scan management
> - `/api/v1/files/*` - File browsing
> - `/integrations/events/n8n` - Receive events FROM n8n
>
> **AgentX (port 3080):** AI orchestration + n8n triggers  
> - `/api/n8n/*` - Trigger n8n webhooks, health checks
> - `/api/chat`, `/api/rag/*` - AI features

---

## Credential Setup

### Credential 1: DataAPI Header Auth
- **Type:** Header Auth
- **Name:** `DataAPI API Key`
- **Header Name:** `x-api-key`
- **Header Value:** `<YOUR_N8N_API_KEY>`

### Credential 2: AgentX Header Auth
- **Type:** Header Auth
- **Name:** `AgentX API Key`
- **Header Name:** `x-api-key`
- **Header Value:** `<YOUR_AGENTX_N8N_KEY>`

---

## Priority 1 Workflows

### Workflow N1.1: System Health Check

**Trigger:** Schedule (every 5 minutes) OR Webhook (Manual Test)

**Purpose:** Monitor all system components and alert on failures.

**Webhook URL:** `https://n8n.specialblend.icu/webhook/sbqc-n1-1-health-check`

```
┌─────────────────┐   ┌─────────────────┐
│  Schedule       │   │  Webhook        │
│  (Every 5 min)  │   │  (Manual Test)  │
└────────┬────────┘   └────────┬────────┘
         │                     │
         ▼                     ▼
┌─────────────────────────────────────────────────────────┐
│  Merge Triggers                                         │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│  HTTP Request (Parallel)                                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │
│  │ DataAPI      │ │ AgentX       │ │ Ollama 99    │    │
│  │ /n8n/health  │ │ /health      │ │ /api/tags    │    │
│  └──────────────┘ └──────────────┘ └──────────────┘    │
│  ┌──────────────┐                                       │
│  │ Ollama 12    │                                       │
│  │ /api/tags    │                                       │
│  └──────────────┘                                       │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
                   ┌─────────────────┐
                   │  Merge Results  │
                   └────────┬────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  IF any failed  │
                   └────────┬────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
     ┌────────────────┐         ┌────────────────┐
     │  Log to        │         │  Send Alert    │
     │  DataAPI Sink  │         │  (Email/Slack) │
     └────────────────┘         └────────────────┘
```

**HTTP Request Nodes Configuration:**

**DataAPI Health:**
```
Method: GET
URL: http://192.168.2.33:3003/health
Continue On Fail: true
```

**AgentX Health:**
```
Method: GET
URL: http://192.168.2.33:3080/health
Continue On Fail: true
```

**Ollama 99:**
```
Method: GET
URL: http://192.168.2.99:11434/api/tags
Continue On Fail: true
Timeout: 5000
```

**Ollama 12:**
```
Method: GET
URL: http://192.168.2.12:11434/api/tags
Continue On Fail: true
Timeout: 5000
```

**Merge & Evaluate:**
```javascript
// Code node to aggregate results
const results = {
  dataapi: $('DataAPI Health').first().json.status === 'success' ? 'ok' : 'error',
  agentx: $('AgentX Health').first().json.status === 'ok' ? 'ok' : 'error',
  ollama_99: $('Ollama 99').first().json.models ? 'ok' : 'error',
  ollama_12: $('Ollama 12').first().json.models ? 'ok' : 'error',
  timestamp: new Date().toISOString()
};

const hasErrors = Object.values(results).includes('error');

return [{
  json: {
    ...results,
    overall: hasErrors ? 'degraded' : 'healthy',
    alert: hasErrors
  }
}];
```

---

### Workflow N1.2: DataAPI Health Probe (Webhook Receiver)

> **❌ DEPRECATED:** This workflow has been removed. DataAPI does not push events to n8n (uses internal EventEmitter only). n8n workflows call DataAPI endpoints directly.

---

### Workflow N1.1b: Datalake Janitor Orchestrator

> **❌ DEPRECATED:** This workflow has been removed. It was a duplicate of N2.1.

---

## Priority 2 Workflows

### Workflow N2.1: NAS File Scanner

**Trigger:** Schedule (Daily at 2:00 AM) OR Webhook (Manual Trigger)

**Purpose:** Scan NAS directories and index files to DataAPI.

**Webhook URL:** `https://n8n.specialblend.icu/webhook/sbqc-n2-1-nas-scan`

```
┌─────────────────┐   ┌─────────────────┐
│  Schedule       │   │  Webhook        │
│  (Daily 2AM)    │   │  (Manual Test)  │
└────────┬────────┘   └────────┬────────┘
         │                     │
         ▼                     ▼
┌─────────────────────────────────────────────────────────┐
│  Merge Triggers                                         │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
┌─────────────────────┐
│  Create Scan Record │
│  POST /n8n/nas/scan │
└────────┬────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Execute Command                    │
│  find /mnt/media -type f        │
│  -name "*.mp4" -o -name "*.mkv"     │
│  -o -name "*.jpg" -o -name "*.png"  │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────┐
│  Split Into Batches │
│  (100 files each)   │
└────────┬────────────┘
         │
         ▼ (Loop)
┌─────────────────────────────┐
│  For Each Batch:            │
│  - Get file stats (size,    │
│    modified, extension)     │
│  - POST /storage/scan/:id/  │
│         batch               │
└────────────────┬────────────┘
                 │
                 ▼
┌─────────────────────────────┐
│  Update Scan Status         │
│  PATCH /storage/scan/:id    │
│  {status: "completed"}      │
└────────────────┬────────────┘
                 │
                 ▼
┌─────────────────────────────┐
│  Trigger Enrichment         │
│  (Optional: call enrich     │
│   endpoint for hashing)     │
└─────────────────────────────┘
```

**Create Scan Record:**
```
Method: POST
URL: http://192.168.2.33:3003/api/v1/storage/scan
Body:
{
  "roots": ["/mnt/media", "/mnt/datalake"],
  "extensions": ["mp4", "mkv", "avi", "jpg", "png", "pdf"],
  "metadata": {
    "initiator": "n8n-daily-scan",
    "purpose": "index-all-media"
  }
}
```

**Execute Command (find):**
```bash
find /mnt/media -type f \( -name "*.mp4" -o -name "*.mkv" -o -name "*.jpg" \) -printf "%p|%s|%T@\n"
```

Output format: `path|size|modified_timestamp`

**Process Files (Code Node):**
```javascript
const lines = $input.first().json.stdout.split('\n').filter(l => l);
const files = lines.map(line => {
  const [path, size, modified] = line.split('|');
  const parts = path.split('/');
  const filename = parts.pop();
  const dirname = parts.join('/');
  const ext = filename.split('.').pop().toLowerCase();
  
  return {
    path,
    size: parseInt(size),
    modified: new Date(parseFloat(modified) * 1000).toISOString(),
    dirname,
    filename,
    extension: ext
  };
});

// Split into batches of 100
const batches = [];
for (let i = 0; i < files.length; i += 100) {
  batches.push(files.slice(i, i + 100));
}

return batches.map(batch => ({ json: { files: batch } }));
```

**Bulk Insert Files:**
```
Method: POST
URL: http://192.168.2.33:3003/api/v1/storage/scan/{{ $('Create Scan Record').first().json.data.scan_id }}/batch
Headers:
  - x-api-key: <DATAAPI_API_KEY>
  - Content-Type: application/json
Body:
{
  "files": {{ $json.files }},
  "meta": {
    "batch_number": {{ $runIndex + 1 }},
    "source": "n8n-nas-scan"
  }
}
```

> **✓ Implemented:** This endpoint was added in DataAPI v1.x and supports upsert operations with `bulkWrite`.

**Mark Scan Complete:**
```
Method: PATCH
URL: http://192.168.2.33:3003/api/v1/storage/scan/{{ $('Create Scan Record').first().json.data.scan_id }}
Headers:
  - x-api-key: <DATAAPI_API_KEY>
  - Content-Type: application/json
Body:
{
  "status": "completed"
}
```

Response: Automatically sets `finished_at` timestamp.

---

### Workflow N2.2: NAS Full/Other Scan (Weekly)

**Status:** Pending test  
**Trigger:** Schedule (Weekly Sunday 3AM) OR Webhook (Manual)  
**Webhook Path:** `sbqc-n2-2-nas-full-scan`

**Purpose:** Inverse scan - finds files that are NOT standard media types. Useful for discovering forgotten files, unusual content, and cleanup candidates.

**Logic:**
1. **Trigger DataAPI Scanner** with `exclude_extensions` to skip common media files
2. **Log Event** to integration sink

**Key Configuration:**
```json
{
  "roots": ["/mnt/media", "/mnt/datalake"],
  "exclude_extensions": ["mp4","mkv","avi","mov","mp3","flac","wav","jpg","jpeg","png","gif","webp","pdf","txt","md"],
  "compute_hashes": true,
  "hash_max_size": 104857600
}
```

This surfaces files like: executables, archives (.zip, .tar), database files, config files, scripts, and other non-standard content that may need attention.

---

### Workflow N2.3: RAG Document Ingestion ✅ PRODUCTION-READY

**Status:** Working as of December 31, 2025  
**Trigger:** Schedule (Weekly Sunday 3AM) OR Webhook (Manual)  
**Webhook URL:** `https://n8n.specialblend.icu/webhook/sbqc-n2-3-rag-ingest`

**Purpose:** Scan NAS directories for documents and ingest them into AgentX RAG for semantic search.

```
┌─────────────────┐   ┌─────────────────┐
│  Schedule       │   │  Webhook        │
│  (Sun 3AM)      │   │  (Manual)       │
└────────┬────────┘   └────────┬────────┘
         │                     │
         ▼                     ▼
┌─────────────────────────────────────────────────────────┐
│  Merge Triggers                                         │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  Configure Directories                  │
│  [*.md, *.txt, *.pdf] from             │
│  /mnt/datalake/RAG                      │
└────────────────────────────┬────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  Find Recent Files (Execute Command)   │
│  find ... -mtime -7 -exec stat ...     │
│  ⚠️ executeOnce: false                 │
└────────────────────────────┬────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  Parse File List (aggregate all items) │
└────────────────────────────┬────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  Filter Skipped (skip: false)          │
└────────────────────────────┬────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  Read File Content (cat file)          │
│  ⚠️ executeOnce: false                 │
└────────────────────────────┬────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  Prepare RAG Payload                    │
│  (merge content with original metadata) │
└────────────────────────────┬────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  POST AgentX /api/rag/ingest           │
│  Body: ={{ $json }}                    │
└────────────────────────────┬────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  Summarize Results                      │
│  (count created/updated/failed)         │
└────────────────────────────┬────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  Log Event (DataAPI)                    │
│  POST /integrations/events/n8n          │
└─────────────────────────────────────────┘
```

#### Critical Configuration Notes

> **⚠️ Alpine/BusyBox Compatibility:**  
> n8n runs in Docker on Alpine Linux. Use `stat` instead of `find -printf`:
> ```bash
> find "/mnt/datalake/RAG" -type f -name "*.txt" -mtime -7 -exec stat -c "%n|%s|%Y" {} + 2>/dev/null | head -100
> ```

> **⚠️ Execute Once Flag:**  
> Both "Find Recent Files" and "Read File Content" nodes MUST have `executeOnce: false`.
> This is set in the JSON but can also be toggled in the n8n UI (Settings tab).

> **⚠️ Metadata Preservation:**  
> The "Prepare RAG Payload" node must reference `$("Filter Skipped").all()` to get original file metadata,
> since the `cat` command replaces input JSON with stdout.

#### HTTP Request Configuration

**Ingest to AgentX RAG:**
```
Method: POST
URL: http://192.168.2.33:3080/api/rag/ingest
Authentication: Header Auth (x-api-key)
Specify Body: JSON
JSON Body: ={{ $json }}
```

**Log Event (DataAPI):**
```
Method: POST
URL: http://192.168.2.33:3003/integrations/events/n8n
Authentication: Header Auth (x-api-key)
JSON Body: ={{ { "workflow_id": "N2.3", "event_type": "rag_ingest_complete", "data": $json } }}
```

---

## Priority 3 Workflows

### Workflow N3.1: Model Health Monitor

**Trigger:** Schedule (every 10 minutes) OR Webhook (Manual Test)

**Purpose:** Track model availability and latency.

**Webhook URL:** `https://n8n.specialblend.icu/webhook/sbqc-n3-1-model-monitor`

**Webhook URL:** `https://n8n.specialblend.icu/webhook/sbqc-n3-1-model-monitor`

```
┌─────────────────┐   ┌─────────────────┐
│  Schedule       │   │  Webhook        │
│  (Every 10 min)  │   │  (Manual Test)  │
└────────┬────────┘   └────────┬────────┘
         │                     │
         ▼                     ▼
┌─────────────────────────────────────────────────────────┐
│  Merge Triggers                                         │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  For Each Ollama Host:                  │
│  GET /api/tags                          │
│  Measure latency                        │
└────────────────────────────┬────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  Store Results to DataAPI               │
│  POST /integrations/events/n8n          │
│  {event: "model_health", data: {...}}   │
└─────────────────────────────────────────┘
```

---

### Workflow N3.2: External AI Trigger Gateway

**Status:** ✅ Built | ⏳ Pending Import & Testing

**Trigger:** Webhook (external apps can trigger AI responses)

**Purpose:** Allow external systems (apps, scripts, other n8n workflows) to get AI responses via a gateway webhook.

**Webhook URL:** `https://n8n.specialblend.icu/webhook/sbqc-ai-query`

> ⚠️ **Note:** Webhook path in JSON is `sbqc-ai-query` (not following standard sbqc-nX.Y pattern)

```
┌─────────────────┐
│  Webhook        │
│  /sbqc-ai-query │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────┐
│  POST AgentX /api/chat      │
│  {                          │
│    "model": "qwen2.5:7b",   │
│    "message": query,        │
│    "useRag": true           │
│  }                          │
└────────────────┬────────────┘
                 │
                 ▼
┌─────────────────────────────┐
│  Return Response            │
│  to Webhook Caller          │
└─────────────────────────────┘
```

---

## Priority 5 Workflows

### Workflow N5.1: Feedback Analysis & Prompt Optimization

**Status:** ✅ Built | ⏳ Pending Import & Testing

**Trigger:** Schedule (Weekly, Sunday 3AM) OR Webhook (Manual)

**Purpose:** Analyze feedback data, identify underperforming prompts (< 70% positive rate) and slow models, suggest improvements via AI analysis.

**Webhook URL:** `https://n8n.specialblend.icu/webhook/sbqc-n5-1-feedback-analysis`

```
┌─────────────────────┐
│  Schedule           │
│  (Weekly Sun 3AM)   │
└────────┬────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│  GET AgentX /api/analytics/feedback     │
│  ?groupBy=promptVersion                 │
└────────────────────────────┬────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  Code: Identify Underperformers         │
│  (positiveRate < 0.7)                   │
└────────────────────────────┬────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│  IF underperformers exist:              │
│  - GET negative feedback examples       │
│  - Call AI to suggest improvements      │
│  - Create draft prompt version          │
│  - Send report to admin                 │
└─────────────────────────────────────────┘
```

---

### Workflow N1.3: Ops AI Diagnostic (Webhook)

**Trigger:** Webhook (Manual or triggered by N1.2 on error)

**Purpose:** Perform deep AI analysis of system health when issues are detected.

**Webhook URL:** `https://n8n.specialblend.icu/webhook/sbqc-ops-diagnostic`

```
┌─────────────────┐
│  Webhook        │
│  (POST)         │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│  HTTP Request (Parallel Probes)                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │
│  │ DataAPI      │ │ AgentX       │ │ Ollama 99    │    │
│  │ /health      │ │ /health      │ │ /api/tags    │    │
│  └──────────────┘ └──────────────┘ └──────────────┘    │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
                   ┌─────────────────┐
                   │  Merge & Format │
                   └────────┬────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  AgentX Chat    │
                   │  (AI Analysis)  │
                   └────────┬────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  Respond to     │
                   │  Webhook        │
                   └─────────────────┘
```

---

## Priority 3 Workflows


---

## Webhook IDs Needed (Optional)

> ⚠️ **Note:** These webhook environment variables are **OPTIONAL** and used for future DataAPI → n8n event pushing functionality. Currently, all n8n workflows pull data from DataAPI directly rather than waiting for DataAPI to push events.

If you want DataAPI to push events to n8n, create these webhooks in n8n and add IDs to DataAPI `.env`:

| Webhook Purpose | n8n Path | Env Variable | Status |
|----------------|----------|--------------|--------|
| Scan Complete | `/webhook/scan-complete` | `N8N_WEBHOOK_SCAN_COMPLETE` | Optional |
| Files Exported | `/webhook/files-exported` | `N8N_WEBHOOK_FILES_EXPORTED` | Optional |
| Storage Alert | `/webhook/storage-alert` | `N8N_WEBHOOK_STORAGE_ALERT` | Optional |
| Generic Events | `/webhook/generic` | `N8N_WEBHOOK_GENERIC` | Optional |

**Current Architecture:** n8n polls DataAPI endpoints on schedule (every 5 minutes, hourly, etc.)  
**Future Enhancement:** DataAPI could push events to these webhooks for real-time triggers

---

## SMB Mount Setup

On the n8n host (192.168.2.199), configure SMB mounts:

```bash
# /etc/fstab entries
//nas.local/Media /mnt/media cifs credentials=/etc/samba/creds,uid=1000,gid=1000 0 0
//nas.local/Datalake /mnt/datalake cifs credentials=/etc/samba/creds,uid=1000,gid=1000 0 0

# Create mount points
sudo mkdir -p /mnt/media /mnt/datalake

# Create credentials file
sudo nano /etc/samba/creds
# username=YOUR_NAS_USER
# password=YOUR_NAS_PASS

# Mount
sudo mount -a
```

---

## Testing Checklist

### Priority 1 - Foundation
- [x] N1.1: Health check runs and logs results
- [x] N1.2: Webhook receives test event from DataAPI *(No longer needed - AgentX handles triggers)*
- [x] N1.3: Ops AI Diagnostic analyzes system health

### Priority 2 - File Operations
- [x] N2.1: Media scan completes and updates DataAPI
- [x] N2.2: NAS Full/Other scan (inverse scan) finds non-media files
- [x] N2.3: RAG ingestion works for test documents (FIXED 2025-01)

### Priority 3 - Monitoring & External
- [x] N3.1: Model health monitor tracks Ollama latency
- [ ] N3.2: External AI gateway returns responses to webhook callers *(Built, pending import & testing)*

### Priority 5 - Optimization
- [ ] N5.1: Feedback analysis identifies underperformers *(Built, pending import & testing)*

### Infrastructure
- [x] SMB mounts accessible from n8n container/host
