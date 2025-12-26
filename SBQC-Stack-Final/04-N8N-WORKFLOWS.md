# 04 - n8n Workflow Specifications

**n8n Instance:** https://n8n.specialblend.icu (http://192.168.2.199:5678)  
**SMB Mounts:** To be configured on the n8n host

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

**Trigger:** Schedule (every 5 minutes)

**Purpose:** Monitor all system components and alert on failures.

```
┌─────────────────┐
│  Schedule       │
│  (Every 5 min)  │
└────────┬────────┘
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

**Trigger:** Webhook (receives events from DataAPI)

**Purpose:** Receive and process events pushed from DataAPI.

**Webhook URL:** `https://n8n.specialblend.icu/webhook/<WEBHOOK_ID>`

```
┌─────────────────┐
│  Webhook        │
│  (POST)         │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Switch         │
│  (event type)   │
└────────┬────────┘
         │
    ┌────┴────────────┬─────────────────┐
    │                 │                 │
    ▼                 ▼                 ▼
┌─────────┐   ┌─────────────┐   ┌────────────┐
│ scan_   │   │ files_      │   │ storage_   │
│ complete│   │ exported    │   │ alert      │
└────┬────┘   └──────┬──────┘   └─────┬──────┘
     │               │                 │
     ▼               ▼                 ▼
  [Process]      [Process]        [Alert Admin]
```

**Switch Node Logic:**
```javascript
// Route based on event field
$input.first().json.event
```

---

## Priority 2 Workflows

### Workflow N2.1: NAS File Scanner

**Trigger:** Schedule (Daily at 2:00 AM)

**Purpose:** Scan NAS directories and index files to DataAPI.

```
┌─────────────────┐
│  Schedule       │
│  (Daily 2AM)    │
└────────┬────────┘
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
│  find /mnt/smb/Media -type f        │
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
│  - POST /n8n/nas/files      │
└────────────────┬────────────┘
                 │
                 ▼
┌─────────────────────────────┐
│  Update Scan Status         │
│  PATCH /n8n/nas/scan/:id    │
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
  "roots": ["/mnt/smb/Media", "/mnt/smb/Datalake"],
  "extensions": ["mp4", "mkv", "avi", "jpg", "png", "pdf"],
  "metadata": {
    "initiator": "n8n-daily-scan",
    "purpose": "index-all-media"
  }
}
```

**Execute Command (find):**
```bash
find /mnt/smb/Media -type f \( -name "*.mp4" -o -name "*.mkv" -o -name "*.jpg" \) -printf "%p|%s|%T@\n"
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
URL: http://192.168.2.33:3003/api/v1/files/bulk
Body:
{
  "files": {{ $json.files }},
  "scanId": "{{ $('Create Scan Record').first().json.data.scanId }}"
}
```

> **Note:** This endpoint needs to be created - see Task D2.1 in DataAPI tasks.

---

### Workflow N2.2: File Enrichment (Hashing)

**Trigger:** Webhook (triggered after scan completes)

**Purpose:** Compute SHA256 hashes for new files.

```
┌─────────────────┐
│  Webhook        │
│  (scan_complete)│
└────────┬────────┘
         │
         ▼
┌─────────────────────────────┐
│  Query New Files            │
│  GET /n8n/nas/files         │
│  ?scanId=X&hasHash=false    │
└────────────────┬────────────┘
                 │
                 ▼
┌─────────────────────────────┐
│  Loop: For Each File        │
│  Execute: sha256sum <path>  │
│  Update: PATCH file record  │
└─────────────────────────────┘
```

**Note:** This can be slow for many files. Consider:
- Running on a dedicated worker
- Limiting to files under a certain size
- Using n8n's "Split in Batches" with concurrency

---

### Workflow N2.3: RAG Document Ingestion

**Trigger:** Manual or Webhook

**Purpose:** Ingest documents into AgentX RAG for semantic search.

```
┌─────────────────────┐
│  Manual Trigger     │
│  (or File Watcher)  │
└────────┬────────────┘
         │
         ▼
┌─────────────────────────────┐
│  Read Files from Directory  │
│  (e.g., /mnt/smb/Docs/*.md) │
└────────────────┬────────────┘
                 │
                 ▼
┌─────────────────────────────┐
│  For Each File:             │
│  POST AgentX /api/rag/ingest│
│  {                          │
│    "source": "nas-docs",    │
│    "path": "<filepath>",    │
│    "title": "<filename>",   │
│    "text": "<content>"      │
│  }                          │
└─────────────────────────────┘
```

**AgentX Ingest:**
```
Method: POST
URL: http://192.168.2.33:3080/api/rag/ingest
Authentication: Predefined Credential (AgentX API Key)
Body:
{
  "source": "nas-docs",
  "path": "{{ $json.path }}",
  "title": "{{ $json.filename }}",
  "text": "{{ $json.content }}",
  "tags": ["nas", "documents"]
}
```

---

## Priority 3 Workflows

### Workflow N3.1: Model Health Monitor

**Trigger:** Schedule (every 10 minutes)

**Purpose:** Track model availability and latency.

```
┌─────────────────┐
│  Schedule       │
│  (Every 10 min) │
└────────┬────────┘
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

### Workflow N3.2: AI Chat Trigger

**Trigger:** Webhook (external apps can trigger AI responses)

**Purpose:** Allow external systems to get AI responses via n8n.

```
┌─────────────────┐
│  Webhook        │
│  /ai-query      │
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

**Trigger:** Schedule (Weekly, Sunday 3AM)

**Purpose:** Analyze feedback and suggest prompt improvements.

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

## Webhook IDs Needed

Create these webhooks in n8n and add IDs to DataAPI `.env`:

| Webhook Purpose | n8n Path | Env Variable |
|----------------|----------|--------------|
| Scan Complete | `/webhook/scan-complete` | `N8N_WEBHOOK_SCAN_COMPLETE` |
| Files Exported | `/webhook/files-exported` | `N8N_WEBHOOK_FILES_EXPORTED` |
| Storage Alert | `/webhook/storage-alert` | `N8N_WEBHOOK_STORAGE_ALERT` |
| Generic Events | `/webhook/generic` | `N8N_WEBHOOK_GENERIC` |

---

## SMB Mount Setup

On the n8n host (192.168.2.199), configure SMB mounts:

```bash
# /etc/fstab entries
//nas.local/Media /mnt/smb/Media cifs credentials=/etc/samba/creds,uid=1000,gid=1000 0 0
//nas.local/Datalake /mnt/smb/Datalake cifs credentials=/etc/samba/creds,uid=1000,gid=1000 0 0

# Create mount points
sudo mkdir -p /mnt/smb/Media /mnt/smb/Datalake

# Create credentials file
sudo nano /etc/samba/creds
# username=YOUR_NAS_USER
# password=YOUR_NAS_PASS

# Mount
sudo mount -a
```

---

## Testing Checklist

- [ ] N1.1: Health check runs and logs results
- [ ] N1.2: Webhook receives test event from DataAPI
- [ ] N2.1: File scanner completes and updates DataAPI
- [ ] N2.3: RAG ingestion works for test documents
- [ ] SMB mounts accessible from n8n container/host
