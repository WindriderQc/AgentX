# Agent C — n8n Workflow Developer Plan (v2)

**Created:** December 26, 2025  
**Status:** Active  
**Role:** n8n Workflow Developer for SBQC Stack  
**Source of Truth:** SBQC-Stack-Final documentation

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

### Phase 1: SBQC Ops Agent (Priority 1) — ✅ IMPLEMENTED

| ID | Name | Trigger | Status | JSON |
|----|------|---------|--------|------|
| N1.1 | System Health Check | Schedule (5 min) | ✅ Done | `N1.1.json` |
| N1.1b | Datalake Janitor Orchestrator | Schedule (Daily) | ✅ Done | `N1.1b.json` |
| N1.2 | DataAPI Webhook Receiver | Webhook receiver | ✅ Done | `N1.2.json` |
| N1.3 | Ops AI Diagnostic | Webhook trigger | ✅ Done | `N1.3.json` |

### Phase 2: Datalake Janitor (Priority 2) — ✅ IMPLEMENTED

| ID | Name | Trigger | Status | JSON |
|----|------|---------|--------|------|
| N2.1 | NAS File Scanner | Schedule (daily 2AM) | ✅ Done | `N2.1.json` |
| N2.2 | File Hash Enrichment | Event: scan_complete | ✅ Done | `N2.2.json` |
| N2.3 | RAG Document Ingestion | Event/Manual | ❌ Pending | — |

### Phase 3: AI-Aware Workflows (Priority 3) — 🔄 PARTIAL

| ID | Name | Trigger | Status | Notes |
|----|------|---------|--------|-------|
| N3.1 | Model Health & Latency Monitor | Schedule (10 min) | ✅ Done | `N3.1.json` |
| N3.2 | External AI Trigger Gateway | Webhook | ❌ Pending | AgentX decides everything |

### Phase 4: RAG Ingestion — ❌ NOT STARTED

| ID | Name | Trigger | Status | Notes |
|----|------|---------|--------|-------|
| N4.1 | Docs → RAG Pipeline | Manual/Schedule | ❌ Pending | Feeds AgentX memory |

### Phase 5: Self-Improving Loop (Priority 5) — ❌ NOT STARTED

| ID | Name | Trigger | Status | Notes |
|----|------|---------|--------|-------|
| N5.1 | Feedback → Prompt Optimization | Weekly | ❌ Pending | Human gate before deploy |

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

### Next Sprint

3. **Build N2.3 (RAG Ingestion)** — file metadata → RAG
4. **Build N3.2 (AI Gateway)** — external trigger → AgentX
5. **Build N5.1 (Feedback Loop)** — weekly prompt analysis

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

| File | Purpose |
|------|---------|
| `N1.1.json` | System Health Check workflow |
| `N1.2.json` | Ops AI Diagnostic workflow (should be renamed N1.3) |
| `N2.1.json` | NAS File Scanner workflow |
| `testpack.json` | Combined test workflow |
| `n8n.workflows_testing.md` | Import & test instructions |
| `plan pursue.md` | Original discussion (this analysis source) |
| `AGENT_C_PLAN_v2.md` | This document |

---

## ✅ Definition of Done for Agent C

Agent C work is complete when:

- [ ] All Priority 1 workflows (N1.x) are active and logging
- [ ] N2.1 runs end-to-end with real data
- [ ] Batch insert endpoint exists and is documented
- [ ] Scan progress can be polled
- [ ] All events use correlation ID (scan_id)
- [ ] n8n credentials are properly configured
- [ ] Test pack produces PASS/FAIL summary

---

## 🎯 Next Concrete Action

**Priority 1:** Implement `POST /api/v1/storage/scan/:scan_id/batch` in DataAPI

This unblocks N2.1 from 404 failures and establishes the pattern for all future batch operations.

---

## References

- [00-OVERVIEW.md](../SBQC-Stack-Final/00-OVERVIEW.md) — Architecture overview
- [02-DATAAPI-TASKS.md](../SBQC-Stack-Final/02-DATAAPI-TASKS.md) — DataAPI implementation tasks
- [04-N8N-WORKFLOWS.md](../SBQC-Stack-Final/04-N8N-WORKFLOWS.md) — Workflow specifications
- [06-AGENT-PROMPTS.md](../SBQC-Stack-Final/06-AGENT-PROMPTS.md) — Agent behavioral contracts
