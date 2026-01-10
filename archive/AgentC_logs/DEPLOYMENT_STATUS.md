# n8n Workflow Deployment Status

**Last Updated**: January 2, 2026 @ 15:10 EST

## 🔄 Pending Deployments

The following workflows have been updated in git but need manual deployment to n8n:

| Workflow | File | Changes | Priority |
|----------|------|---------|----------|
| **N1.1** | N1.1.json | 🔴 Security fix: Removed exposed API key | **CRITICAL** |
| **N2.3** | N2.3.json | Error handling: Added `continueOnFail` to logging | HIGH |
| **N3.1** | N3.1.json | Error handling: Added `continueOnFail` to logging | HIGH |

---

## 📋 Manual Deployment Steps

### Option A: Via n8n UI (Recommended)

1. Open http://192.168.2.199:5678
2. For each workflow:
   - Open the existing workflow
   - Click **"⋮" menu** → **"Import from File"**
   - Select the updated JSON file from `/home/yb/codes/AgentX/AgentC/`
   - Verify nodes are configured correctly
   - Click **"Save"** and **"Activate"**

### Option B: API Deployment (When Fixed)

```bash
cd /home/yb/codes/AgentX

# Deploy individual workflows
./scripts/deploy-n8n-workflows.sh N1.1.json
./scripts/deploy-n8n-workflows.sh N2.3.json
./scripts/deploy-n8n-workflows.sh N3.1.json

# Or deploy all at once
./scripts/deploy-n8n-workflows.sh
```

**Note**: n8n API authentication currently requires troubleshooting. The API returns:
```json
{"message":"'X-N8N-API-KEY' header required"}
```

Despite having `N8N_API_KEY` set in `.env`, the API is rejecting requests.

---

## ✅ Verification After Deployment

### Test N1.1 (System Health Check)
```bash
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n1-1-health-check \
  -H "Content-Type: application/json" \
  -d '{"test":"post-deployment"}'
```

**Expected**: Workflow executes without errors. Check DataAPI logs for event.

### Test N2.3 (RAG Ingest)
```bash
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n2-3-rag-ingest \
  -H "Content-Type: application/json" \
  -d '{"source":"test","test":true}'
```

**Expected**: Workflow completes even if DataAPI logging fails.

### Test N3.1 (Model Monitor)
```bash
curl https://n8n.specialblend.icu/webhook/sbqc-n3-1-model-monitor
```

**Expected**: Returns Ollama health data, continues even if logging fails.

---

## 🔧 n8n API Authentication Troubleshooting

### Current Issue
- API endpoint: `http://192.168.2.199:5678/api/v1/workflows`
- Error: `'X-N8N-API-KEY' header required`
- API key is set in `.env` but rejected

### Possible Causes
1. n8n API feature not enabled in settings
2. API key format or generation issue
3. n8n version doesn't support this API endpoint
4. Authentication method changed in recent n8n version

### To Fix
1. Check n8n version: Visit http://192.168.2.199:5678 → Settings → About
2. Verify API is enabled: Settings → API → Enable public API
3. Regenerate API key if needed: Settings → API → Create new API key
4. Update `.env` with new key

---

## 📊 Deployment Priority

**Priority 1 (Today)**:
- [ ] N1.1 - **CRITICAL** security fix (API key removed)

**Priority 2 (This Week)**:
- [ ] N2.3 - Error handling improvement
- [ ] N3.1 - Error handling improvement

**Low Priority** (When API fixed):
- [ ] All other workflows (no critical changes pending)

---

## 🚨 Important: API Key Rotation

After N1.1 is deployed, **rotate the DataAPI API key**:

```bash
# 1. Generate new key
NEW_KEY=$(openssl rand -hex 32)
echo "New key: $NEW_KEY"

# 2. Update DataAPI
cd /home/yb/codes/DataAPI
sed -i "s/DATAAPI_API_KEY=.*/DATAAPI_API_KEY=$NEW_KEY/" .env
pm2 restart dataapi

# 3. Update n8n credential store
# Go to: http://192.168.2.199:5678 → Settings → Credentials
# Find: "Header Auth account" (PIrrA2wpOppzVodi)
# Edit: Update x-api-key value
# Save

# 4. Verify workflows work
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n1-1-health-check
```

---

## 📝 Deployment Log

| Date | Workflow | Version | Deployed By | Status | Notes |
|------|----------|---------|-------------|--------|-------|
| 2026-01-02 | N1.1 | da1de2e | Pending | ⏳ Awaiting manual deployment | Security fix |
| 2026-01-02 | N2.3 | f3edb33 | Pending | ⏳ Awaiting manual deployment | Error handling |
| 2026-01-02 | N3.1 | f3edb33 | Pending | ⏳ Awaiting manual deployment | Error handling |

---

## 🔗 Related Documentation

- [AgentC/README.md](README.md) - Workflow development guide
- [../scripts/deploy-n8n-workflows.sh](../scripts/deploy-n8n-workflows.sh) - Deployment script
- [WORKFLOW_CHANGES.md](WORKFLOW_CHANGES.md) - Recent workflow changes
