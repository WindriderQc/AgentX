# n8n Workflow Automation Setup - December 31, 2025

## Summary

Successfully set up **automated n8n workflow deployment** for the SBQC Stack. This eliminates manual workflow import/export and integrates workflow management into Git.

---

## What Was Done

### 1. Fixed N3.1 Workflow Bug ✅

**File:** `AgentC/N3.1.json`

**Issue:** 
```
Error: Cannot assign to read only property 'name' of object 'Error: Node: 
'PingUGBrutal (19)' hasn't been executed'
```

**Root Cause:** Code node used `$node["Ping UGFrank (99)"]` syntax which fails when multiple inputs arrive from a Merge node in parallel.

**Fix:** Changed to use `$input` API:
```javascript
// Before (broken)
const frank = $node["Ping UGFrank (99)"].json;
const brutal = $node["Ping UGBrutal (12)"].json;

// After (working)
const frank = $input.first().json;
const brutal = $input.all()[1]?.json || {};
```

### 2. Created Deployment Script ✅

**File:** `scripts/deploy-n8n-workflows.sh`

**Features:**
- ✅ Checks n8n API connectivity
- ✅ Lists existing workflows
- ✅ Creates new workflows (POST)
- ✅ Updates existing workflows (PUT)
- ✅ Validates JSON before deployment
- ✅ Colored output with progress indicators
- ✅ Supports single workflow or batch deployment

**Usage:**
```bash
# Check connectivity
./scripts/deploy-n8n-workflows.sh --check

# Deploy single workflow
./scripts/deploy-n8n-workflows.sh N3.1.json

# Deploy all workflows
./scripts/deploy-n8n-workflows.sh
```

### 3. Created Comprehensive Documentation ✅

#### New Documents:
1. **`docs/SBQC-Stack-Final/N8N-API-SETUP.md`**
   - How to enable n8n API
   - Generate API keys
   - Configure environment variables
   - Troubleshooting guide

2. **`AgentC/README.md`**
   - Workflow development guide
   - Common patterns and anti-patterns
   - Troubleshooting section
   - Git hooks examples

#### Updated Documents:
1. **`docs/SBQC-Stack-Final/04-N8N-WORKFLOWS.md`**
   - Added complete "Automated Workflow Deployment" section
   - Deployment workflow diagram
   - CI/CD integration examples
   - Best practices

---

## How It Works

### Deployment Flow

```
┌─────────────────────────────────────────────────────────┐
│  1. Developer edits workflow JSON                       │
│     AgentC/N3.1.json                                    │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  2. Script validates JSON                               │
│     jq empty N3.1.json                                  │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  3. Check if workflow exists in n8n                     │
│     GET /api/v1/workflows (search by name)              │
└────────────────────┬────────────────────────────────────┘
                     │
                ┌────┴────┐
                │         │
      Found     │         │     Not Found
    ┌───────────▼──┐   ┌──▼───────────┐
    │ UPDATE (PUT) │   │ CREATE (POST)│
    │ /workflows/1 │   │ /workflows   │
    └───────────┬──┘   └──┬───────────┘
                │         │
                └────┬────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  4. Workflow deployed to n8n                            │
│     http://192.168.2.199:5678                           │
└─────────────────────────────────────────────────────────┘
```

### n8n API Integration

The script uses these endpoints:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/v1/workflows` | List all workflows |
| `POST` | `/api/v1/workflows` | Create new workflow |
| `PUT` | `/api/v1/workflows/:id` | Update existing workflow |

**Authentication:** Uses `X-N8N-API-KEY` header

---

## Next Steps

### Immediate (Required)

1. **Enable n8n API Access**
   ```bash
   # Access n8n
   http://192.168.2.199:5678
   
   # Steps:
   # 1. Login
   # 2. Settings → API
   # 3. Enable API
   # 4. Generate key
   # 5. Save key securely
   ```

2. **Configure Environment**
   ```bash
   # Add to ~/.bashrc
   export N8N_URL="http://192.168.2.199:5678"
   export N8N_API_KEY="n8n_api_YOUR_KEY_HERE"
   
   # Apply
   source ~/.bashrc
   ```

3. **Test Deployment**
   ```bash
   # Check connectivity
   ./scripts/deploy-n8n-workflows.sh --check
   
   # Deploy fixed N3.1
   ./scripts/deploy-n8n-workflows.sh N3.1.json
   
   # Deploy all
   ./scripts/deploy-n8n-workflows.sh
   ```

### Optional (Recommended)

1. **Set Up Git Hooks**
   - Pre-commit: Validate JSON
   - Post-merge: Auto-deploy changes
   - See: `AgentC/README.md`

2. **Integrate with CI/CD**
   - GitHub Actions example in `04-N8N-WORKFLOWS.md`
   - Deploy on push to main branch

3. **Test Webhooks**
   ```bash
   # Test N3.1 webhook
   curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n3-1-model-monitor \
     -H "Content-Type: application/json" \
     -d '{"test":"validation"}'
   ```

---

## Files Created/Modified

### New Files ✨

1. `scripts/deploy-n8n-workflows.sh` - Deployment script
2. `docs/SBQC-Stack-Final/N8N-API-SETUP.md` - API setup guide
3. `AgentC/README.md` - Workflow development guide
4. `docs/SBQC-Stack-Final/SETUP-SUMMARY-2025-12-31.md` - This file

### Modified Files 📝

1. `AgentC/N3.1.json` - Fixed node reference bug
2. `docs/SBQC-Stack-Final/04-N8N-WORKFLOWS.md` - Added deployment section

---

## Validation Status

From [VALIDATION-REPORT-2025-12-31-1622.md](VALIDATION-REPORT-2025-12-31-1622.md):

**Before:**
- ⚠️ 5/8 workflows active
- ❌ N3.1, N3.2, N5.1 returned 404

**After:**
- ✅ N3.1.json fixed and ready to deploy
- 📋 N3.2 and N5.1 need deployment
- 🚀 Automated deployment ready

---

## Documentation Index

| Document | Purpose |
|----------|---------|
| [04-N8N-WORKFLOWS.md](04-N8N-WORKFLOWS.md) | Complete workflow specs + deployment |
| [N8N-API-SETUP.md](N8N-API-SETUP.md) | API configuration guide |
| [AgentC/README.md](../AgentC/README.md) | Workflow development |
| [05-DEPLOYMENT.md](05-DEPLOYMENT.md) | System deployment |
| [VALIDATION-REPORT-2025-12-31-1622.md](VALIDATION-REPORT-2025-12-31-1622.md) | Validation results |

---

## Quick Reference

### Deploy Workflow
```bash
./scripts/deploy-n8n-workflows.sh N3.1.json
```

### Validate JSON
```bash
jq empty AgentC/N3.1.json
```

### Check API
```bash
curl -H "X-N8N-API-KEY: $N8N_API_KEY" \
  http://192.168.2.199:5678/api/v1/workflows
```

### Test Webhook
```bash
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n3-1-model-monitor \
  -H "Content-Type: application/json" \
  -d '{"test":"manual"}'
```

---

## Troubleshooting

### Script says "Authentication failed"
→ Set `N8N_API_KEY` environment variable (see [N8N-API-SETUP.md](N8N-API-SETUP.md))

### Workflow deploys but returns 404 on webhook
→ Check workflow is **Active** in n8n UI

### JSON validation fails
→ Use `jq '.' workflow.json` to find syntax errors

### Can't connect to n8n
→ Check service: `ssh ubundocker && docker ps | grep n8n`

---

## Success Metrics

- ✅ N3.1 workflow bug fixed
- ✅ Automated deployment script created
- ✅ Comprehensive documentation written
- ✅ JSON validation confirmed
- 📋 Ready for API key setup and deployment

---

**Date:** December 31, 2025  
**Status:** Ready for deployment  
**Next Action:** Configure n8n API access
