# Documentation Discrepancy Audit

**Date:** December 31, 2025  
**Status:** ✅ ALL ISSUES RESOLVED - Retained as Historical Reference  
**Scope:** SBQC-Stack-Final documentation vs actual codebase implementation

---

## ⚠️ NOTICE: All Issues Resolved

**This document is now a historical reference.**

All discrepancies identified in this audit have been resolved as of December 31, 2025. This document is retained for:
- Historical record of documentation quality issues
- Reference for future audit methodology
- Impact analysis documentation
- QA learning and improvement

**For current status, see:** [00-AUDIT-SUMMARY.md](00-AUDIT-SUMMARY.md)

---

## 🔴 Critical Discrepancies (ALL FIXED)

### 1. API Endpoint Path Inconsistency (00-OVERVIEW.md)

**Documented in 00-OVERVIEW.md:**
```
GET  /api/conversations        ← WRONG
GET  /api/user/profile         ← WRONG
```

**Actually in Code (history.js & profile.js):**
```
GET  /api/history/conversations     ✅ CORRECT
GET  /api/profile                   ✅ CORRECT
```

**Impact:** Developers following docs will call wrong endpoints.

**Fix:** Update 00-OVERVIEW.md section "Key n8n Endpoints" to use `/api/history/*` instead of `/api/conversations`.

---

### 2. Missing Endpoint Documentation (04-N8N-WORKFLOWS.md)

**Documented endpoints in 04-N8N-WORKFLOWS.md are INCOMPLETE.** The following endpoints exist but are NOT documented:

| Endpoint | File | Status | Documented in 04? |
|----------|------|--------|------------------|
| `POST /api/chat` | api.js | ✅ Active | ✅ Yes |
| `POST /api/feedback` | api.js | ✅ Active | ⚠️ Partial |
| `GET /api/models/routing` | api.js | ✅ Active | ❌ **MISSING** |
| `POST /api/models/classify` | api.js | ✅ Active | ❌ **MISSING** |
| `GET /api/history/` | history.js | ✅ Active | ❌ **MISSING** |
| `GET /api/history/:id` | history.js | ✅ Active | ❌ **MISSING** |
| `PATCH /api/history/conversations/:id` | history.js | ✅ Active | ❌ **MISSING** |
| `GET /api/analytics/usage` | analytics.js | ✅ Active | ❌ **MISSING** |
| `GET /api/analytics/feedback` | analytics.js | ✅ Active | ❌ **MISSING** |
| `GET /api/analytics/rag/stats` | analytics.js | ✅ Active | ❌ **MISSING** |
| `GET /api/analytics/RAG/summary` | analytics.js | ✅ Active | ❌ **MISSING** |
| `POST /api/prompts/` | prompts.js | ✅ Active | ❌ **MISSING** |
| `GET /api/prompts/` | prompts.js | ✅ Active | ❌ **MISSING** |
| `GET /api/prompts/:name` | prompts.js | ✅ Active | ❌ **MISSING** |
| `POST /api/prompts/:name/ab-test` | prompts.js | ✅ Active | ❌ **MISSING** |
| `GET /api/dataset/conversations` | dataset.js | ✅ Active | ❌ **MISSING** |
| `GET /api/dataset/prompts` | dataset.js | ✅ Active | ❌ **MISSING** |
| `POST /api/dataset/prompts` | dataset.js | ✅ Active | ❌ **MISSING** |
| `GET /api/voice/health` | voice.js | ✅ Active | ❌ **MISSING** |
| `POST /api/voice/transcribe` | voice.js | ✅ Active | ❌ **MISSING** |
| `POST /api/voice/synthesize` | voice.js | ✅ Active | ❌ **MISSING** |
| `POST /api/voice/chat` | voice.js | ✅ Active | ❌ **MISSING** |
| `POST /api/rag/ingest` | rag.js | ✅ Active | ✅ Yes |
| `POST /api/rag/search` | rag.js | ✅ Active | ✅ Yes |
| `GET /api/rag/documents` | rag.js | ✅ Active | ❌ **MISSING** |

**Impact:** 21 active endpoints not documented. Developers won't know they exist.

**Fix:** Add comprehensive API reference section to 03-AGENTX-TASKS.md or 04-N8N-WORKFLOWS.md listing all endpoints with request/response schemas.

---

### 3. Webhook URL Format Inconsistency (04-N8N-WORKFLOWS.md)

**Documented webhook URLs use inconsistent naming:**

| Workflow | Documented URL | Issue |
|----------|-----------------|-------|
| N1.1 | `https://n8n.specialblend.icu/webhook/sbqc-n1-1-health-check` | Uses dashes ✅ |
| N2.1 | `https://n8n.specialblend.icu/webhook/sbqc-n2-1-nas-scan` | Uses dashes ✅ |
| N2.2 | `https://n8n.specialblend.icu/webhook/sbqc-n2-2-...` | Not in docs ❌ |
| N2.3 | `https://n8n.specialblend.icu/webhook/sbqc-n2-3-rag-ingest` | Not in docs ❌ |
| N3.1 | Not documented ❌ | Missing |
| N3.2 | `https://n8n.specialblend.icu/webhook/sbqc-ai-query` | ⚠️ Doesn't match pattern |
| N5.1 | `https://n8n.specialblend.icu/webhook/sbqc-n5-1-feedback-analysis` | Uses dashes ✅ |

**Impact:** N3.2 webhook URL doesn't match documented pattern (`sbqc-ai-query` vs `sbqc-n3-2-...`). Check JSON to verify actual path.

**Action Items:**
1. Verify N3.2.json webhook path
2. Ensure all webhook docs follow consistent naming: `sbqc-n{X}.{Y}-description`

---

### 4. DataAPI Endpoint References (04-N8N-WORKFLOWS.md)

**Documented DataAPI endpoints are OUTDATED:**

| Documented | Status | Notes |
|------------|--------|-------|
| `/api/v1/storage/scan` | ✅ Exists | Correct |
| `/api/v1/files?extension=` | ✅ Exists | Correct |
| `/api/v1/storage/folders` | ❓ Verify | Not checked |
| `/api/v1/n8n/nas/scan` | ❌ **REMOVED** | Migrated to AgentX `/api/n8n/*` |

**Impact:** N2.1 workflow docs reference `/api/v1/n8n/nas/scan` which no longer exists in DataAPI.

**Fix:** Update N2.1 section to show it POSTs to AgentX `/api/n8n/rag/ingest` (or appropriate n8n route), not DataAPI.

---

## 🟡 Moderate Discrepancies

### 5. Workflow Status Tags Inconsistency

**Problem:** Different docs use different status symbols:

| Doc | N3.2 Status | N5.1 Status |
|-----|------------|-----------|
| 00-OVERVIEW.md | `🔄 Built, not tested` | `🔄 Built, not tested` |
| 04-N8N-WORKFLOWS.md (headers) | `✅ Built (JSON ready) ⏳ Not yet imported/tested` | `✅ Built (JSON ready) ⏳ Not yet imported/tested` |

**Issue:** Inconsistent emoji usage and status descriptions across docs make it unclear if they're actually the same status.

**Recommendation:** Standardize on single status format. Suggest:
```
Status: ✅ Built | ⏳ Pending Import & Testing
```

---

### 6. Missing Webhook IDs in DocAPI Configuration (04-N8N-WORKFLOWS.md)

**Documented in section "Webhook IDs Needed":**

| Webhook Purpose | Env Variable | Status |
|-----------------|-------------|--------|
| Scan Complete | `N8N_WEBHOOK_SCAN_COMPLETE` | Not found in `.env.example` ❌ |
| Files Exported | `N8N_WEBHOOK_FILES_EXPORTED` | Not found in `.env.example` ❌ |
| Storage Alert | `N8N_WEBHOOK_STORAGE_ALERT` | Not found in `.env.example` ❌ |
| Generic Events | `N8N_WEBHOOK_GENERIC` | Not found in `.env.example` ❌ |

**Impact:** Docs ask to configure env vars that don't exist. Developers will be confused about whether these are required.

**Action Item:** Either:
1. Create these webhooks in n8n and document their IDs, OR
2. Remove this section if webhooks are not being used, OR
3. Update to clarify these are "optional advanced webhooks"

---

### 7. Design Principles Placement (04-N8N-WORKFLOWS.md)

**Found in section: "Design Principles"**

**Issue:** Design principles are good content, but:
- Not referenced in any other doc
- 01-ARCHITECTURE.md doesn't link to them
- Would be better in dedicated section with explicit "read this first" indicator

**Recommendation:** Add prominent reference in 01-ARCHITECTURE.md:
```markdown
> 📌 **Before reading workflows:** See Design Principles section in 04-N8N-WORKFLOWS.md
```

---

## 🟢 Minor/Cosmetic Issues

### 8. Testing Checklist Checkboxes (04-N8N-WORKFLOWS.md)

**Current state:**
```markdown
- [x] N1.1: Health check runs and logs results          ← checked
- [ ] N3.2: External AI gateway returns responses       ← unchecked
- [x] SMB mounts accessible from n8n                     ← checked
```

**Issue:** N1.1 shows `[x]` but docs say "Pending test" in status table.

**Fix:** Reconcile checklist with status table. Should be consistent.

---

### 9. Infrastructure IP Documentation (00-OVERVIEW.md & 01-ARCHITECTURE.md)

**Documented IPs:**
| Host | IP | Docs | Match |
|------|----|----|-------|
| UGBrutal | 192.168.2.12 | Both docs | ✅ |
| UGFrank | 192.168.2.99 | Both docs | ✅ |
| Docker | 192.168.2.33 | Both docs | ✅ |
| UGStation/n8n | 192.168.2.199 | Both docs | ✅ |

**Status:** ✅ All consistent.

---

### 10. Database Connection String (00-OVERVIEW.md)

**Documented:** `mongodb://192.168.2.33:27017`

**Issue:** No `.env.example` reference. Developers won't know to set `MONGODB_URI`.

**Fix:** Add note in 05-DEPLOYMENT.md showing exact env var name.

---

## Summary of Fixes Needed

### Priority 1 (Critical - Breaks Development)
- [ ] Fix API endpoint paths in 00-OVERVIEW.md (s/`/api/conversations`/`/api/history/conversations`/)
- [ ] Document all 21+ missing AgentX endpoints
- [ ] Clarify DataAPI vs AgentX routing (remove DataAPI n8n routes that moved to AgentX)

### Priority 2 (High - Confusion/Incomplete Docs)
- [ ] Standardize workflow status tags across all docs
- [ ] Verify/document all webhook URLs (especially N3.2 pattern mismatch)
- [ ] Clarify optional vs required webhook configuration
- [ ] Add API reference section to AGENTX-TASKS.md

### Priority 3 (Medium - Consistency)
- [ ] Reconcile testing checklist with status table
- [ ] Add cross-references between docs
- [ ] Document all env vars needed for deployment

### Priority 4 (Low - Nice to Have)
- [ ] Add "Design Principles" reading guide
- [ ] Improve emoji consistency
- [ ] Add examples to webhook URL section
