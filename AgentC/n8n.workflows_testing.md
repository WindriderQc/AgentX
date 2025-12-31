````md
# SBQC n8n Workflows - Import + Test Instructions

**Last updated:** 2025-01-01
**Workflow Count:** 5 active workflows

## Active Workflow Files

| File | Name | Status | Purpose |
|------|------|--------|---------|
| `N1.1.json` | System Health Check | OK | Monitor all services every 5 min |
| `N1.3.json` | Ops AI Diagnostic | Pending | AI-powered system analysis |
| `N2.1.json` | NAS File Scanner | OK | Trigger DataAPI scan |
| `N2.2.json` | NAS Full/Other Scan | 🔄 Pending test | Weekly scan for non-standard file types |
| `N2.3.json` | RAG Document Ingestion | **WORKING** | Feed docs to AgentX Qdrant |
| `N3.1.json` | Model Health Monitor | 🔄 Pending test | Track Ollama latency |
| `N3.2.json` | External AI Gateway | 🔄 Built, not tested | Webhook to route queries through AgentX |
| `N5.1.json` | Feedback Analysis | 🔄 Built, not tested | Weekly prompt optimization analysis |

## Removed / Deprecated

| File | Reason |
|------|--------|
| **N1.1b.json** | Duplicate of N2.1 - deleted |
| **N1.2.json** | DataAPI never pushes events to n8n |

Reference architecture: `docs/SBQC-Stack-Final/`

---

## 0) Preconditions (don’t skip)

### Services reachable (LAN)
From the **n8n host** (192.168.2.199), these must respond:

- DataAPI: `http://192.168.2.33:3003/health`
- AgentX: `http://192.168.2.33:3080/health`
- Ollama UGFrank: `http://192.168.2.99:11434/api/tags`
- Ollama UGBrutal: `http://192.168.2.12:11434/api/tags`

Quick test on n8n host:
```bash
curl -s http://192.168.2.33:3003/health
curl -s http://192.168.2.33:3080/health
curl -s http://192.168.2.99:11434/api/tags | head
curl -s http://192.168.2.12:11434/api/tags | head
````

### NAS mounts exist (for N2.1)

On the **n8n host**, these should exist and be readable:

* `/mnt/media`
* `/mnt/datalake`

Verify:

```bash
ls -la /mnt/smb
ls -la /mnt/media | head
ls -la /mnt/datalake | head
```

> If n8n runs in **Docker**, you must mount `/mnt/smb` into the container (`- /mnt/smb:/mnt/smb:ro`). 

### DataAPI endpoints needed (for N2.1)

N2.1 assumes:

* `POST /api/v1/storage/scan` exists
* **`POST /api/v1/files/bulk` exists** (your plan says it may still be pending) 

If `/api/v1/files/bulk` is not implemented yet:

* N2.1 will still create a scan + run `find`,
* then fail at the bulk insert node (expected).

---

## 1) Import the Workflows (3 JSONs)

In n8n UI:

1. **Workflows**
2. **Import from File** (or “Paste JSON” depending on UI)
3. Import each JSON:

   * `SBQC - N1.1 System Health Check (5 min)`
   * `SBQC - N1.2 Ops AI Diagnostic (Webhook)`
   * `SBQC - N2.1 NAS File Scanner (Daily 2AM)`

After import:

* Leave them **inactive** until tests pass.

---

## 2) Test Workflow N1.1 (System Health Check)

### What it does

* Hits 4 endpoints in parallel
* Aggregates into one status object
* If degraded → logs event to DataAPI sink:

  * `POST http://192.168.2.33:3003/integrations/events/n8n`

### Manual test

1. Open workflow `SBQC - N1.1...`
2. Click **Execute Workflow**

Expected results:

* If all services are up → `overall: "healthy"` and `alert: false`
* If any down → `overall: "degraded"` and `alert: true`, plus a POST to DataAPI sink.

### Verify sink received event

On DataAPI host (or from anywhere that can hit Mongo / your logs):

* Check DataAPI logs or Mongo collection `SBQC.integration_events` (per your DataAPI tasks) 

Quick “smoke” test of sink:

```bash
curl -X POST -H "Content-Type: application/json" \
  http://192.168.2.33:3003/integrations/events/n8n \
  -d '{"workflow_id":"manual-test","event_type":"health_probe","data":{"ok":true}}'
```

---

## 3) Test Workflow N1.2 (Ops AI Diagnostic Webhook)

### What it does

* Webhook receives a payload
* Runs live probes (DataAPI / AgentX / Ollama 99 / Ollama 12)
* Builds a snapshot
* Calls AgentX chat:

  * `POST http://192.168.2.33:3080/api/chat`
  * `persona: "sbqc_ops"`
  * model target: Qwen on UGFrank (192.168.2.99:11434)
* Returns JSON response to caller

### Enable the webhook test URL

In the workflow editor:

* Click the Webhook node
* Use **Test URL** first (easiest for validation)

### Call it (from your PC or any shell)

Replace with your n8n test webhook URL shown in the node.

```bash
curl -X POST "https://n8n.specialblend.icu/webhook-test/sbqc-ops-diagnostic" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual-check","note":"testing ops diagnostic"}'
```

Expected response structure:

```json
{
  "status": "success",
  "snapshot": { ... live probes ... },
  "agentx": { ... AgentX /api/chat response ... }
}
```

### If AgentX rejects persona

If `persona: "sbqc_ops"` isn’t implemented yet in AgentX prompt configs, you’ll still get a response but it may ignore persona. That’s fine for now: we’re verifying the plumbing first. 

---

## 4) Test Workflow N2.1 (NAS File Scanner)

### What it does

* Creates scan record in DataAPI (`/api/v1/storage/scan`)
* Executes `find` on `/mnt/media` and `/mnt/datalake`
* Parses output lines `path|size|mtime`
* Batches into 100-file chunks
* POSTs each chunk to DataAPI `/api/v1/files/bulk` (if available)
* Logs `scan_complete` to DataAPI sink
* Optionally PATCHes scan status (only if your API supports it)

### Run a small test first (recommended)

Before running against the full NAS, create a tiny test folder on the n8n host:

```bash
mkdir -p /mnt/media/_sbqc_test
echo "hi" > /mnt/media/_sbqc_test/test1.txt
dd if=/dev/zero of=/mnt/media/_sbqc_test/test2.bin bs=1K count=5
```

Then (temporary) edit the `Execute: find files` node to restrict roots:

* Set `ROOTS=(/mnt/media/_sbqc_test)` for the first run.

Run the workflow manually:

1. Open workflow `SBQC - N2.1...`
2. Click **Execute Workflow**

Expected:

* The `find` node returns a small stdout.
* The parser creates 1 batch.
* The bulk POST attempts to insert.

### Verify in DataAPI

* Confirm scan record exists (if your endpoint supports listing):

```bash
curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/storage/scans
```

(Or check Mongo `SBQC.nas_scans`)

* Confirm file docs inserted (depends on your DataAPI implementation of `/files/bulk`)

---

## 5) Auth (if your endpoints require API keys)

Your docs indicate storage/files endpoints typically require `x-api-key`, while the integration sink is open.

If your DataAPI endpoints **do require** `x-api-key`, update these nodes:

* **N1.1**

  * DataAPI Health (only if your /health is protected — usually it’s not)
  * Log to DataAPI Sink (only if you decide to protect it)

* **N2.1**

  * Create Scan Record (DataAPI)
  * POST Batch to DataAPI /files/bulk
  * OPTIONAL: Mark Scan Completed

In each affected HTTP Request node:

* Add Header:

  * `x-api-key: <YOUR_KEY>`

Best practice: create a reusable n8n **Credential** “Header Auth” and attach it to those nodes. 

---

## 6) Troubleshooting (the usual gremlins)

### A) Execute Command “stdout maxBuffer length exceeded”

This happens when `find` outputs too many lines.

Fixes (still “Option A”):

* Limit scan scope (by extension group, root, or directory slices)
* Split into 2 workflows (Media vs Datalake)
* Add constraints like `-size -2G` or exclude huge trees
* Prefer chunking by directory depth (scan top-level folders one at a time)

### B) n8n Docker can’t see /mnt/smb

If n8n runs in Docker, the host path must be mounted into the container:

```yaml
volumes:
  - /mnt/smb:/mnt/smb:ro
```

And restart n8n. 

### C) Ollama endpoints timeout

* Check firewall rules / routing
* Confirm Ollama listens on `0.0.0.0` (not only 127.0.0.1)
* Test from n8n host directly:

```bash
curl -v http://192.168.2.99:11434/api/tags
```

### D) AgentX /api/chat fails

* Confirm AgentX has access to Ollama host/port
* Confirm model exists on target host
* Check AgentX logs (pm2)

---

## 7) When tests pass → Activate

Recommended activation order:

1. Activate **N1.2** (webhook only; safe)
2. Activate **N1.1** (scheduled; gives you monitoring)
3. Activate **N2.1** only after you confirm `/api/v1/files/bulk` can handle your expected volume

---

## 8) “Known Optional” parts (safe to ignore for now)

* N2.1 “Mark Scan Completed” PATCH is optional; if DataAPI doesn’t support it, it’ll just fail silently (continueOnFail true).
* N1.2 persona `sbqc_ops` can be added later; the workflow still validates the integration even without it. 

```