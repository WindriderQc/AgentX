# n8n Workflow Deployment Plan
**Date:** 2026-01-01
**n8n Instance:** http://192.168.2.199:5678
**Status:** 21 workflows already deployed

---

## 📊 Current State

**n8n API:** ✅ Accessible (HTTP 200)
**Deployed Workflows:** 21 workflows
**Available Locally:** 8 workflow files in `/AgentC/`

---

## 📋 Workflows to Deploy

| File | Workflow Name | Purpose | Status |
|------|---------------|---------|--------|
| N1.1.json | System Health Check | Monitor AgentX + Ollama health | Need to verify |
| N1.3.json | Ops Diagnostic | Operations diagnostics | Need to verify |
| N2.1.json | NAS Scan | NAS file scanning | Need to verify |
| N2.2.json | NAS Full Scan | Full NAS scan | Need to verify |
| N2.3.json | RAG Ingest | Document ingestion for RAG | **PRIORITY** |
| N3.1.json | Model Monitor | Monitor Ollama models | Need to verify |
| N3.2.json | AI Query | AI query execution | Need to verify |
| N5.1.json | Feedback Analysis | Analyze conversation feedback | **PRIORITY** |

---

## 🎯 Priority Workflows for AgentX

### High Priority (Core Features)

1. **N2.3 - RAG Ingest**
   - **Purpose:** Automated document ingestion for RAG system
   - **Integration:** Calls AgentX `/api/rag/ingest`
   - **Trigger:** Cron schedule or webhook
   - **Required ENV:** AGENTX_BASE_URL, AGENTX_API_KEY

2. **N5.1 - Feedback Analysis**
   - **Purpose:** Analyze negative feedback and suggest prompt improvements
   - **Integration:** Calls AgentX `/api/analytics/feedback` and `/api/prompts/:name/analyze-failures`
   - **Trigger:** Weekly cron or manual
   - **Required ENV:** AGENTX_BASE_URL, AGENTX_API_KEY, POSITIVE_RATE_THRESHOLD

### Medium Priority (Operations)

3. **N1.1 - System Health Check**
   - **Purpose:** Monitor AgentX and Ollama health
   - **Integration:** Health check endpoints
   - **Trigger:** Cron (every 5-15 minutes)

4. **N3.1 - Model Monitor**
   - **Purpose:** Track available Ollama models
   - **Integration:** Ollama `/api/tags`
   - **Trigger:** Cron or webhook

### Low Priority (Optional)

5-8. Other workflows (NAS scanning, diagnostics, etc.)

---

## 🔧 Deployment Steps

### Step 1: Verify Connectivity
```bash
./scripts/deploy-n8n-workflows.sh --check
```

**Expected:** "Connected to n8n API (21 workflows found)"

### Step 2: Check Required Environment Variables

n8n workflows need these credentials configured:

```bash
# AgentX Connection
AGENTX_BASE_URL=http://192.168.2.33:3080  # or localhost:3080
AGENTX_API_KEY=<your-api-key>

# Ollama Connection
OLLAMA_HOST=http://192.168.2.99:11434

# Optional: Analytics Thresholds
POSITIVE_RATE_THRESHOLD=0.7
MIN_FEEDBACK_COUNT=50
```

**Action:** Set these as n8n environment variables or credentials

### Step 3: Deploy Priority Workflows

```bash
# Deploy RAG Ingest
./scripts/deploy-n8n-workflows.sh N2.3.json

# Deploy Feedback Analysis
./scripts/deploy-n8n-workflows.sh N5.1.json

# Deploy Health Check
./scripts/deploy-n8n-workflows.sh N1.1.json

# Deploy Model Monitor
./scripts/deploy-n8n-workflows.sh N3.1.json
```

### Step 4: Configure Workflow Credentials in n8n UI

For each deployed workflow:

1. Open n8n UI: http://192.168.2.199:5678
2. Navigate to workflow
3. Open each node that requires credentials
4. Add credentials:
   - **HTTP Request nodes** → Add AgentX base URL + API key header
   - **Ollama nodes** → Add Ollama host URL
5. Save workflow
6. Activate workflow

### Step 5: Test Workflows

#### Test N2.3 (RAG Ingest)
```bash
# Trigger manual execution via webhook
curl -X POST http://192.168.2.199:5678/webhook/sbqc-n2-3-rag-ingest \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test Document",
    "text": "This is a test document for RAG ingestion.",
    "tags": ["test"]
  }'
```

**Expected:** Document appears in AgentX RAG store

#### Test N5.1 (Feedback Analysis)
```bash
# Trigger via webhook
curl -X POST http://192.168.2.199:5678/webhook/sbqc-n5-1-feedback-analysis
```

**Expected:** Workflow analyzes recent feedback and generates report

---

## ⚠️ Important Notes

### Workflow Import Behavior

**The deployment script creates NEW workflows each time**, not updates. This means:
- Running script multiple times = multiple copies
- Must manually delete old versions in n8n UI
- Or manually update workflows using n8n API

### Recommended Approach

**Option A: Manual Import (Safer)**
1. Open n8n UI: http://192.168.2.199:5678
2. Click "Add workflow" → "Import from File"
3. Upload JSON from `/AgentC/`
4. Configure credentials
5. Activate

**Option B: Script Deploy + Manual Cleanup**
1. Run deployment script
2. Configure credentials in n8n UI
3. Delete any duplicate workflows
4. Activate

**Option C: Update Existing Workflows**
1. Export existing workflow from n8n
2. Compare with local JSON
3. Manually merge changes
4. Save in n8n UI

---

## 🧪 Testing Checklist

After deployment:

- [ ] **N2.3 RAG Ingest**
  - [ ] Cron schedule configured
  - [ ] Webhook trigger works
  - [ ] Documents appear in AgentX RAG store
  - [ ] Deduplication works (same doc twice = single entry)

- [ ] **N5.1 Feedback Analysis**
  - [ ] Can fetch feedback from AgentX
  - [ ] LLM analysis generates suggestions
  - [ ] Report format is correct
  - [ ] Workflow completes without errors

- [ ] **N1.1 Health Check**
  - [ ] AgentX health endpoint responds
  - [ ] Ollama health endpoint responds
  - [ ] Alerts on failures (if configured)

- [ ] **N3.1 Model Monitor**
  - [ ] Lists available Ollama models
  - [ ] Updates on schedule
  - [ ] Tracks model changes

---

## 🚨 Troubleshooting

### Issue: "Cannot reach n8n at URL"
**Solution:** Check n8n service is running:
```bash
curl http://192.168.2.199:5678
# Should return HTTP 200
```

### Issue: "Authentication failed"
**Solution:** Set N8N_API_KEY environment variable:
```bash
export N8N_API_KEY=your-key
./scripts/deploy-n8n-workflows.sh --check
```

### Issue: "Workflow import creates duplicates"
**Solution:** This is expected behavior. Delete old versions manually in n8n UI or use workflow ID to update existing ones via API.

### Issue: "Credentials not configured error"
**Solution:** Each workflow node needs credentials set in n8n UI:
1. Open workflow
2. Click node with red warning
3. Add credential (HTTP Auth, API Key, etc.)
4. Save and activate

---

## 📝 Next Steps

**Immediate (This Session):**
1. ⏳ Verify n8n has 21 workflows (check if ours are already there)
2. ⏳ If missing, deploy N2.3 (RAG Ingest) + N5.1 (Feedback Analysis)
3. ⏳ Configure credentials in n8n UI
4. ⏳ Test RAG ingestion with sample document

**Short-term (This Week):**
- Deploy N1.1 (Health Check) for monitoring
- Deploy N3.1 (Model Monitor)
- Set up cron schedules
- Test all webhook triggers

**Long-term:**
- Monitor workflow execution logs
- Optimize RAG ingestion schedule
- Expand feedback analysis features
- Add alerting/notifications

---

## 🎯 Success Criteria

**Task 2 Complete When:**
- ✅ At least 2 priority workflows deployed (N2.3 + N5.1)
- ✅ Credentials configured in n8n UI
- ✅ Test execution successful (RAG ingest works)
- ✅ Documentation updated with deployment status

---

## 📚 References

- n8n Instance: http://192.168.2.199:5678
- AgentX API Docs: `/docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md`
- n8n Deployment Guide: `/docs/onboarding/n8n-deployment.md`
- RAG API Contract: `/docs/api/contracts/v3-snapshot.md`
- Analytics API Contract: `/docs/api/contracts/v4-contract.md`
