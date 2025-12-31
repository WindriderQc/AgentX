# SBQC n8n Workflows

This directory contains all n8n workflow definitions for the SBQC Stack automation system.

## Overview

| Workflow | File | Status | Webhook |
|----------|------|--------|---------|
| System Health Check | N1.1.json | ✅ Active | `sbqc-n1-1-health-check` |
| Ops Diagnostic | N1.3.json | ✅ Active | `sbqc-ops-diagnostic` |
| NAS Scan | N2.1.json | ✅ Active | `sbqc-n2-1-nas-scan` |
| NAS Full Scan | N2.2.json | ✅ Active | `sbqc-n2-2-nas-full-scan` |
| RAG Ingest | N2.3.json | ✅ Active | `sbqc-n2-3-rag-ingest` |
| Model Monitor | N3.1.json | ⚠️ Fixed | `sbqc-n3-1-model-monitor` |
| AI Query | N3.2.json | 📋 Pending | `sbqc-ai-query` |
| Feedback Analysis | N5.1.json | 📋 Pending | `sbqc-n5-1-feedback-analysis` |

**n8n Instance:** http://192.168.2.199:5678  
**Public URL:** https://n8n.specialblend.icu

---

## Quick Start

### Deploy All Workflows
```bash
cd /home/yb/codes/AgentX
./scripts/deploy-n8n-workflows.sh
```

### Deploy Single Workflow
```bash
./scripts/deploy-n8n-workflows.sh N3.1.json
```

### Check API Connectivity
```bash
./scripts/deploy-n8n-workflows.sh --check
```

---

## Workflow Development Workflow

```
1. Edit JSON → 2. Validate → 3. Commit → 4. Deploy → 5. Test
```

### 1. Edit Workflow JSON

Edit the workflow file directly:
```bash
code AgentC/N3.1.json
# or
vim AgentC/N3.1.json
```

Or export from n8n UI and save here.

### 2. Validate JSON

```bash
# Validate syntax
jq empty AgentC/N3.1.json

# Pretty-print
jq '.' AgentC/N3.1.json > temp.json && mv temp.json AgentC/N3.1.json
```

### 3. Commit Changes

```bash
git add AgentC/N3.1.json
git commit -m "fix: N3.1 node reference issue in Format Results"
git push origin main
```

### 4. Deploy to n8n

```bash
# Deploy single workflow
./scripts/deploy-n8n-workflows.sh N3.1.json

# Or deploy all
./scripts/deploy-n8n-workflows.sh
```

### 5. Test in n8n UI

1. Open http://192.168.2.199:5678
2. Find the workflow
3. Click "Execute Workflow" (manual test)
4. Or trigger via webhook

---

## Common Workflow Patterns

### Node Reference (Fixed in N3.1)

❌ **Don't use `$node` with merged inputs:**
```javascript
const frank = $node["Ping UGFrank (99)"].json;  // Fails with merge
const brutal = $node["Ping UGBrutal (12)"].json;
```

✅ **Use `$input` instead:**
```javascript
const frank = $input.first().json;           // First input
const brutal = $input.all()[1]?.json || {};  // Second input
```

### Error Handling

Always set `continueOnFail: true` on HTTP nodes that might fail:
```json
{
  "parameters": {
    "url": "http://192.168.2.99:11434/api/tags",
    "options": {
      "timeout": 5000,
      "fullResponse": true
    }
  },
  "continueOnFail": true
}
```

### Webhook URLs

All webhooks follow this pattern:
```
https://n8n.specialblend.icu/webhook/{webhook-name}
```

Example:
```bash
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n3-1-model-monitor \
  -H "Content-Type: application/json" \
  -d '{"test":"manual trigger"}'
```

---

## Troubleshooting

### Workflow Won't Import

**Issue:** JSON validation errors

**Solution:**
```bash
# Check JSON syntax
jq empty AgentC/N3.1.json

# Common issues:
# - Trailing commas
# - Missing brackets
# - Invalid escape sequences
```

### Node Reference Errors

**Issue:** `Cannot assign to read only property 'name'`

**Solution:** Use `$input` instead of `$node` when dealing with merged inputs (see N3.1.json fix)

### Deployment Fails

**Issue:** 401 Unauthorized

**Solution:** 
```bash
# Set API key
export N8N_API_KEY="your-api-key"

# Or check if API is enabled in n8n UI
```

**Issue:** 404 Not Found

**Solution:** Check n8n API is enabled (Settings → API)

### Webhook Returns 404

**Issue:** Workflow not active or webhook path wrong

**Solution:**
1. Check workflow is active in n8n UI
2. Verify webhook path matches JSON: `"path": "sbqc-n3-1-model-monitor"`
3. Re-deploy workflow

---

## Workflow Structure

Each workflow JSON contains:

```json
{
  "name": "SBQC - N3.1 Model Health & Latency Monitor",
  "nodes": [
    {
      "parameters": { /* node config */ },
      "id": "NodeId",
      "name": "Node Name",
      "type": "n8n-nodes-base.nodeType",
      "position": [x, y]
    }
  ],
  "connections": {
    "Source Node": {
      "main": [
        [
          {
            "node": "Target Node",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "active": true
}
```

### Key Fields

- **name:** Workflow display name in n8n
- **nodes:** Array of all nodes in the workflow
- **connections:** Defines data flow between nodes
- **active:** Whether workflow runs on schedule/trigger
- **id:** Unique node identifier (used in connections and code)
- **name:** Display name (shown in UI)
- **position:** Canvas coordinates [x, y]

---

## Automated Deployment

### Git Hooks

#### Pre-commit Hook (Validation)

```bash
#!/bin/bash
# .git/hooks/pre-commit

echo "Validating n8n workflows..."
for workflow in AgentC/N*.json; do
    if ! jq empty "$workflow" 2>/dev/null; then
        echo "❌ Invalid JSON: $workflow"
        exit 1
    fi
done
echo "✓ All workflows valid"
```

#### Post-merge Hook (Auto-deploy)

```bash
#!/bin/bash
# .git/hooks/post-merge

changed=$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD | grep '^AgentC/N.*\.json$')
if [ -n "$changed" ]; then
    echo "Deploying updated workflows..."
    ./scripts/deploy-n8n-workflows.sh
fi
```

### CI/CD Integration

See `../docs/SBQC-Stack-Final/04-N8N-WORKFLOWS.md` for GitHub Actions example.

---

## Design Principles

From [04-N8N-WORKFLOWS.md](../docs/SBQC-Stack-Final/04-N8N-WORKFLOWS.md):

1. **n8n = Orchestration only** (no AI reasoning)
2. **AgentX = All AI logic** (reasoning, classification)
3. **DataAPI = Source of truth** (storage, scans)
4. **Ollama = Inference** (n8n never calls directly for chat)

### Anti-patterns

❌ n8n making decisions instead of AgentX  
❌ Large code blocks in Code nodes  
❌ Direct Ollama calls for reasoning  
❌ Silent failures (always log to integration sink)

---

## Documentation

- **Workflow Specs:** [04-N8N-WORKFLOWS.md](../docs/SBQC-Stack-Final/04-N8N-WORKFLOWS.md)
- **API Setup:** [N8N-API-SETUP.md](../docs/SBQC-Stack-Final/N8N-API-SETUP.md)
- **Deployment Guide:** [05-DEPLOYMENT.md](../docs/SBQC-Stack-Final/05-DEPLOYMENT.md)
- **System Architecture:** [01-ARCHITECTURE.md](../docs/SBQC-Stack-Final/01-ARCHITECTURE.md)

---

## Support

**Issues?** Check:
1. [N8N-API-SETUP.md](../docs/SBQC-Stack-Final/N8N-API-SETUP.md) - API configuration
2. [04-N8N-WORKFLOWS.md](../docs/SBQC-Stack-Final/04-N8N-WORKFLOWS.md) - Troubleshooting section
3. n8n logs: `ssh ubundocker && docker logs n8n`
4. Validation report: [VALIDATION-REPORT-2025-12-31-1622.md](../docs/SBQC-Stack-Final/VALIDATION-REPORT-2025-12-31-1622.md)

**n8n Documentation:** https://docs.n8n.io/
