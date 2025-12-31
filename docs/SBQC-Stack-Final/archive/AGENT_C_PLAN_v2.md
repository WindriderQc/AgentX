# Agent C — n8n Workflow Developer Plan (v2)

**Created:** December 26, 2025  
**Status:** ⚠️ SUPERSEDED - See Current Documentation Below  
**Role:** n8n Workflow Developer for SBQC Stack  
**Source of Truth:** SBQC-Stack-Final documentation

---

## ⚠️ IMPORTANT NOTICE

**This planning document has been superseded by the comprehensive documentation audit completed December 31, 2025.**

**For current, accurate documentation, see:**
- **[00-AUDIT-SUMMARY.md](00-AUDIT-SUMMARY.md)** - Complete list of fixes and current state
- **[04-N8N-WORKFLOWS.md](04-N8N-WORKFLOWS.md)** - Current workflow specifications with verified webhook URLs
- **[07-AGENTX-API-REFERENCE.md](07-AGENTX-API-REFERENCE.md)** - Complete API endpoint documentation
- **[05-DEPLOYMENT.md](05-DEPLOYMENT.md)** - Environment configuration guide

**Issues identified in this document have been resolved:**
- ✅ All API endpoints documented
- ✅ All webhook URLs verified from JSON files
- ✅ DataAPI routing clarified
- ✅ Environment variables documented
- ✅ Testing checklist synchronized

**This file is retained for historical reference only.**

---

## 📋 Executive Summary

This document consolidates the "plan pursue.md" discussion into an actionable plan aligned with the official SBQC architecture. It identifies documentation gaps, corrections needed, and provides a clear execution path.

---

## 🔍 Analysis: Key Findings from Plan Discussion

### ✅ What's Correct and Aligned

| Item | Status | Notes |
|------|--------|-------|
| Ground rules (n8n = orchestration, not AI) | ✅ Correct | n8n never calls Ollama directly for reasoning |
| AgentX as single AI brain | ✅ Correct | All AI decisions go through AgentX |
| DataAPI as storage + truth | ✅ Correct | File index, scans, events |
| Integration sink endpoint | ✅ Correct | `POST /integrations/events/n8n` is open |
| Workflow dependency order | ✅ Correct | N1.1 → N1.2 → N2.x → N3.x → N5.x |

### ⚠️ Documentation Mismatches to Correct

| Issue | In Plan Discussion | In Official Docs | Resolution |
|-------|-------------------|------------------|------------|
| **N1.2 Definition** | "Ops AI Diagnostic Webhook" (calls AgentX chat) | "DataAPI Health Probe (Webhook Receiver)" | **Rename current N1.2 to "N1.3 Ops AI Diagnostic"** and keep spec's N1.2 definition |
| **DataAPI health endpoint** | Uses `/health` | Spec shows `/n8n/health` | Clarify: DataAPI has `/health` (open), AgentX has `/api/n8n/health` (keyed) |
| **`/api/v1/files/bulk` endpoint** | Assumed to exist | Marked as "needs to be created" in 02-DATAAPI-TASKS.md | **Implement before N2.1 full runs** or use `/api/v1/storage/scan/:id/batch` |
| **Scan lifecycle fields** | Not fully specified | Implied in tasks | **Add schema: status, cursor, stats, lockOwner** |

### 🔴 Missing from Current Documentation

| Gap | Impact | Action Required |
|-----|--------|-----------------|
| No API contract for `/api/v1/files/bulk` | N2.1 fails at batch insert | Define schema in 02-DATAAPI-TASKS.md |
| No scan resume capability | Crashed scans restart from zero | Add cursor/checkpoint to scan model |
| No `/api/v1/storage/scan/:id` GET endpoint | Can't poll progress | Add to DataAPI tasks |
| Voice I/O workflows not specified | Priority 4 feature gap | Will add after core workflows stable |
| Feedback loop workflow details sparse | Priority 5 incomplete | Expand N5.1 spec |

---

## 📊 Workflow Inventory (Complete List)

Per 04-N8N-WORKFLOWS.md + discussion additions:

### Phase 1: SBQC Ops Agent (Priority 1) — ✅ COMPLETE

| ID | Name | Trigger | Status | JSON |
|----|------|---------|--------|------|
| N1.1 | System Health Check | Schedule (5 min) | ✅ Done | `N1.1.json` |
| N1.3 | Ops AI Diagnostic | Webhook trigger | ✅ Done | `N1.3.json` |

### Phase 2: Datalake Janitor (Priority 2) — ✅ COMPLETE

| ID | Name | Trigger | Status | JSON |
|----|------|---------|--------|------|
| N2.1 | NAS File Scanner + Hash | Schedule (daily 2AM) | ✅ Done | `N2.1.json` |
| N2.2 | NAS Full/Other Scan | Schedule (Weekly Sun 3AM) | ✅ Done | `N2.2.json` |
| N2.3 | RAG Document Ingestion | Webhook/Weekly | ✅ Done | `N2.3.json` |

**Note:** 
- N2.1 now includes SHA256 hashing via DataAPI's built-in `compute_hashes` option.
- N2.2 performs an "inverse scan" (everything EXCEPT media files) to map the rest of the disk.

### Phase 3: AI-Aware Workflows (Priority 3) — ✅ COMPLETE

| ID | Name | Trigger | Status | JSON |
|----|------|---------|--------|------|
| N3.1 | Model Health & Latency Monitor | Schedule (10 min) | ✅ Done | `N3.1.json` |
| N3.2 | External AI Trigger Gateway | Webhook | ✅ Done | `N3.2.json` |

### Phase 4: RAG Ingestion — ✅ MERGED

| ID | Name | Trigger | Status | Notes |
|----|------|---------|--------|-------|
| N4.1 | Docs → RAG Pipeline | Manual/Schedule | ✅ Merged | Implemented as **N2.3** |

### Phase 5: Self-Improving Loop (Priority 5) — ✅ COMPLETE

| ID | Name | Trigger | Status | JSON |
|----|------|---------|--------|------|
| N5.1 | Feedback → Prompt Optimization | Weekly Sun 3AM | ✅ Done | `N5.1.json` |

---

## 🛠️ Required DataAPI Endpoints (for n8n workflows)

These must exist for workflows to function:

| Endpoint | Method | Used By | Status |
|----------|--------|---------|--------|
| `/health` | GET | N1.1 | ✅ Exists |
| `/api/v1/storage/scan` | POST | N2.1 | ✅ Exists |
| `/api/v1/storage/scans` | GET | N2.1 verify | ✅ Exists |
| `/api/v1/storage/status/:id` | GET/PATCH | N2.1 | ⚠️ Needs verification |
| `/api/v1/storage/scan/:id/batch` | POST | N2.1 batch | ✅ **IMPLEMENTED** (Dec 26, 2025) |

## 🚀 Next Steps (Post-Phase 2)

1.  **Voice I/O Workflows**: Design and implement workflows for voice command processing (Priority 4).
2.  **Scan Resume**: Add checkpointing to DataAPI scanner to allow resuming interrupted scans.
3.  **Advanced Analytics**: Build workflows to analyze scan data (e.g., "Duplicate Finder", "Large File Report").

| `/api/v1/storage/scan/:id` | GET | N2.1 poll | ✅ **IMPLEMENTED** (Dec 26, 2025) |
| `/api/v1/storage/scan/:id` | PATCH | N2.1 complete | ✅ **IMPLEMENTED** (Dec 26, 2025) |
| `/api/v1/files/duplicates` | GET | N2.3 | ✅ Exists |
| `/integrations/events/n8n` | POST | All workflows | ✅ Exists (open) |

### ✅ New Endpoints Implemented

```
POST /api/v1/storage/scan/:scan_id/batch
```

**Purpose:** Accept batch of files for a specific scan

**Schema (Request):**
```json
{
  "files": [
    { 
      "path": "/mnt/media/file.mp4", 
      "dirname": "/mnt/media",
      "filename": "file.mp4",
      "extension": "mp4",
      "size": 123456, 
      "modified": "2025-01-01T00:00:00Z" 
    }
  ],
  "meta": {
    "batch_number": 1,
    "source": "n8n-nas-scan"
  }
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Processed 100 files",
  "data": {
    "scan_id": "abc123",
    "batch": { "received": 100, "inserted": 95, "updated": 5 },
    "meta": { "batch_number": 1 }
  }
}
```

---

```
PATCH /api/v1/storage/scan/:scan_id
```

**Purpose:** Update scan status (mark complete/failed)

**Schema (Request):**
```json
{
  "status": "completed"  // or "failed", "cancelled"
}
```

**Response:** Automatically sets `finished_at` timestamp.
```

---

## 📋 Updated Execution Plan

### ✅ Completed (Dec 26, 2025)

1. **Verify N1.1 runs clean** — health check every 5 min ✅
2. **Implement `/api/v1/storage/scan/:id/batch`** in DataAPI ✅
3. **Implement `PATCH /api/v1/storage/scan/:id`** in DataAPI ✅
4. **Implement `GET /api/v1/storage/scan/:id`** alias in DataAPI ✅
5. **Update 04-N8N-WORKFLOWS.md** with correct endpoints ✅
6. **Build N1.2 (DataAPI Webhook Receiver)** — routes events to workflows ✅
7. **Build N2.2 (Hash Enrichment)** — triggered by scan_complete event ✅
8. **Build N3.1 (Model Health Monitor)** — latency tracking for routing ✅
9. **Rename N1.2 → N1.3** to align with documentation ✅

### Immediate (Before Full Production)

1. **Test N1.3 (Ops Diagnostic)** — webhook responds with AI analysis
2. **Test N2.1 with small dataset** — confirm batch insert works end-to-end

### ✅ Completed (Dec 30, 2025)

3. **Build N2.3 (RAG Ingestion)** — file metadata → RAG ✅
4. **Build N3.2 (AI Gateway)** — external trigger → AgentX ✅
5. **Build N5.1 (Feedback Loop)** — weekly prompt analysis ✅

---

## 🔧 Required Corrections to SBQC-Stack-Final Docs

### 04-N8N-WORKFLOWS.md ✅ UPDATED

1. ~~**Add `/api/v1/files/bulk` contract**~~ — Using scan-scoped endpoint instead ✅
2. **Updated N2.1** with correct batch insert URL ✅
3. **Updated N2.1** with PATCH endpoint for scan completion ✅
4. **Add N1.3 workflow spec** (Ops AI Diagnostic) — Still needed
5. **Update N1.2 spec** to match original intent (webhook receiver) — Still needed

### 02-DATAAPI-TASKS.md — Pending Review

1. ~~**Add Task D2.x: Implement `/api/v1/files/bulk`**~~ — Implemented as `/storage/scan/:id/batch` ✅
2. ~~**Add Task D1.x: Verify `/api/v1/storage/status/:id`**~~ — PATCH now supported ✅
3. **Add scan model fields:** status enum, cursor, stats, lockOwner — Still needed

### 00-OVERVIEW.md

1. **Update n8n workflows section** to show actual implementation status
2. **Add workflow JSON locations** reference (AgentC folder)

---

## 📁 Current Artifacts (AgentC Folder)

**Updated:** December 30, 2025

| File | Purpose |
|------|---------|
| `N1.1.json` | System Health Check (5 min schedule) |
| `N1.3.json` | Ops AI Diagnostic (webhook) |
| `N2.1.json` | NAS File Scanner with SHA256 hashing |
| `N2.3.json` | RAG Document Ingestion |
| `N3.1.json` | Model Health & Latency Monitor |
| `N3.2.json` | External AI Trigger Gateway |
| `N5.1.json` | Feedback Analysis & Prompt Optimization |
| `testpack.json` | Combined test workflow |
| `n8n.workflows_testing.md` | Import & test instructions |

**Removed (Redundant):**
- ~~`N1.1b.json`~~ - Duplicate of N2.1
- ~~`N1.2.json`~~ - DataAPI never pushes events to n8n
- ~~`N2.2.json`~~ - Hashing now done by DataAPI Scanner natively

---

## ✅ Definition of Done for Agent C

Agent C work is complete when:

- [x] All Priority 1 workflows (N1.x) are active and logging ✅
- [ ] N2.1 runs end-to-end with real data (needs SMB mount test)
- [x] Batch insert endpoint exists and is documented ✅
- [x] Scan progress can be polled ✅
- [x] All events use correlation ID (scan_id) ✅
- [ ] n8n credentials are properly configured (needs verification)
- [ ] Test pack produces PASS/FAIL summary

---

## 🎯 Next Concrete Actions

**Final 7 workflows complete!** Remaining tasks:

1. ✅ **Import workflows** — All imported into n8n
2. ✅ **N2.1 tested** — Scan triggered successfully
3. **Wait for scan completion** — Monitor DataAPI to verify hashing works
4. **Enable schedules** — Activate N1.1 (5min), N2.1 (daily 2AM), N3.1 (10min), N5.1 (weekly)
5. **Test remaining workflows** — N1.3 (diagnostic), N3.2 (gateway), N2.3 (RAG), N5.1 (feedback)

---

## References

- [00-OVERVIEW.md](../SBQC-Stack-Final/00-OVERVIEW.md) — Architecture overview
- [02-DATAAPI-TASKS.md](../SBQC-Stack-Final/02-DATAAPI-TASKS.md) — DataAPI implementation tasks
- [04-N8N-WORKFLOWS.md](../SBQC-Stack-Final/04-N8N-WORKFLOWS.md) — Workflow specifications
- [06-AGENT-PROMPTS.md](../SBQC-Stack-Final/06-AGENT-PROMPTS.md) — Agent behavioral contracts
