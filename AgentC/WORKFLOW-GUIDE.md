# n8n Workflow Development & Deployment Guide

## Critical Rules for Workflow JSONs

### 1. Node Connections MUST Use Node Names, NOT IDs

**❌ WRONG:**
```json
{
  "nodes": [
    {"id": "CallAgentX", "name": "Call AgentX Chat"}
  ],
  "connections": {
    "CallAgentX": {  // ← Using node ID
      "main": [[{"node": "FormatResponse", "type": "main", "index": 0}]]
    }
  }
}
```

**✅ CORRECT:**
```json
{
  "nodes": [
    {"id": "CallAgentX", "name": "Call AgentX Chat"}
  ],
  "connections": {
    "Call AgentX Chat": {  // ← Using node name
      "main": [[{"node": "Format Response", "type": "main", "index": 0}]]
    }
  }
}
```

**Why:** n8n references connections by the `name` field, not the `id` field. Using IDs will result in workflows with disconnected nodes.

**Fix Tool:** Use `/home/yb/codes/AgentX/scripts/fix-workflow-connections.jq` to convert ID-based connections to name-based connections:
```bash
jq -f scripts/fix-workflow-connections.jq AgentC/your-workflow.json > AgentC/your-workflow-fixed.json
```

### 2. Webhook Nodes MUST Have webhookId and httpMethod

**Critical:** Every webhook node MUST include:
- `webhookId`: A unique identifier for the webhook (e.g., "sbqc-n32-ai-gateway")
- `httpMethod`: The HTTP method (GET, POST, PUT, DELETE, etc.)

**❌ WRONG:**
```json
{
  "parameters": {
    "path": "my-webhook",
    "responseMode": "responseNode",
    "options": {}
  },
  "type": "n8n-nodes-base.webhook"
}
```

**✅ CORRECT:**
```json
{
  "parameters": {
    "httpMethod": "POST",
    "path": "my-webhook",
    "responseMode": "responseNode",
    "options": {}
  },
  "type": "n8n-nodes-base.webhook",
  "webhookId": "sbqc-my-webhook"
}
```

**Why:**
- Without `webhookId`, n8n won't register the webhook endpoint
- Without `httpMethod`, the webhook defaults to GET only
- Missing either will cause 404 "webhook not registered" errors

### 3. Webhook Response Modes

**Two modes for webhook responses:**

#### responseMode: "onReceived"
- Responds immediately with webhook data
- Does NOT wait for workflow to complete
- No "Respond to Webhook" node needed
- Use for: Fire-and-forget workflows

```json
{
  "parameters": {
    "httpMethod": "POST",
    "path": "my-webhook",
    "responseMode": "onReceived"
  }
}
```

#### responseMode: "responseNode"
- Waits for workflow to complete
- REQUIRES a "Respond to Webhook" node
- Returns data from the Respond to Webhook node
- Use for: API endpoints that need to return data

```json
{
  "parameters": {
    "httpMethod": "POST",
    "path": "my-webhook",
    "responseMode": "responseNode"
  }
}
```

**Common Mistake:** Using `responseMode: "onReceived"` with a "Respond to Webhook" node. This will cause the webhook to return `{"message": "Workflow was started"}` instead of your actual data.

### 4. Workflow File Structure

**Required fields for deployment:**
```json
{
  "name": "Workflow Name",
  "nodes": [...],
  "connections": {...},
  "settings": {"executionOrder": "v1"}
}
```

**Optional but recommended:**
```json
{
  "staticData": null,
  "meta": {"templateCredsSetupCompleted": true},
  "tags": [
    {"name": "SBQC", "id": "sbqc"},
    {"name": "Priority-3", "id": "p3"}
  ]
}
```

**Fields that will be STRIPPED by deployment:**
- `id` (workflow ID - assigned by n8n)
- `versionId`, `versionCounter`
- `createdAt`, `updatedAt`
- `active` (workflows are deployed inactive)
- `pinData`, `shared`

## Deployment Process

### Step 1: Create/Modify Workflow JSON

1. Edit workflow file in `/home/yb/codes/AgentX/AgentC/`
2. Ensure connections use node names (not IDs)
3. Set correct webhook responseMode
4. Update version number in any version-tracking nodes

### Step 2: Deploy to n8n

```bash
cd /home/yb/codes/AgentX
./scripts/deploy-n8n-workflows.sh <workflow-filename.json>
```

**Example:**
```bash
./scripts/deploy-n8n-workflows.sh N3.2.json
# or from AgentC directory:
./scripts/deploy-n8n-workflows.sh N0.0-test-deployment.json
```

**What happens:**
- Script checks for existing workflow with same name
- If exists: Deletes old workflow, creates new one (DELETE+POST)
- If new: Creates workflow (POST)
- Returns new workflow ID
- Workflow is created in INACTIVE state

**Why DELETE+POST instead of PUT?**
- n8n's PUT endpoint doesn't properly preserve workflow structure
- DELETE+POST ensures clean deployment with all connections intact

### Step 3: Activate Workflow

After deployment, activate using n8n API:

```bash
cd /home/yb/codes/AgentX
source .env
WORKFLOW_ID="<id-from-deployment>"
curl -X POST \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows/$WORKFLOW_ID/activate"
```

**Important:** Workflows MUST be activated before they can receive webhook requests or run on schedule.

### Step 4: Test Workflow

**For webhook workflows:**
```bash
# Test GET webhook
curl -s https://n8n.specialblend.icu/webhook/<webhook-path>

# Test POST webhook
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"message": "test"}' \
  https://n8n.specialblend.icu/webhook/<webhook-path>
```

**For scheduled workflows:**
- Check n8n UI for execution history
- Or manually trigger via webhook if one is configured

## Common Issues & Solutions

### Issue: "The requested webhook is not registered"
**Causes:**
1. Workflow is not activated
2. Webhook node is missing `webhookId` field
3. Webhook node is missing `httpMethod` field

**Solutions:**
1. Activate workflow using the activation API endpoint
2. Add `webhookId` to webhook node (e.g., "webhookId": "sbqc-my-workflow")
3. Add `httpMethod` to webhook parameters (e.g., "httpMethod": "POST")
4. Redeploy and reactivate workflow after fixing JSON

### Issue: Webhook returns "Workflow was started" instead of data
**Cause:** responseMode is "onReceived" but should be "responseNode"
**Solution:** Change webhook node responseMode to "responseNode"

### Issue: "This webhook is not registered for POST/GET requests"
**Cause:** httpMethod doesn't match the request method
**Solution:**
- Check what method your code/client is using (GET/POST/etc)
- Update webhook node parameters to include matching `httpMethod`
- Example: `"httpMethod": "POST"` for POST requests
- Redeploy and reactivate workflow

### Issue: Nodes appear disconnected in n8n UI
**Cause:** Connections use node IDs instead of names
**Solution:** Run fix-workflow-connections.jq script and redeploy

### Issue: Deployment returns "workflow not found"
**Cause:** Script is doubling the path (e.g., AgentC/AgentC/file.json)
**Solution:** Run script from AgentX root directory and use relative path without "AgentC/" prefix

### Issue: API returns "X-N8N-API-KEY header required"
**Cause:** .env file not loaded or N8N_API_KEY not set
**Solution:** Ensure `/home/yb/codes/AgentX/.env` contains N8N_API_KEY

## Workflow Development Checklist

Before deploying a new/modified workflow:

- [ ] Connections reference node names, not IDs
- [ ] All webhook nodes have required fields:
  - [ ] `webhookId` field present (e.g., "sbqc-workflow-name")
  - [ ] `httpMethod` in parameters (e.g., "POST", "GET")
  - [ ] `path` configured correctly
- [ ] Webhook responseMode matches workflow design:
  - [ ] "responseNode" if using "Respond to Webhook" node
  - [ ] "onReceived" if no response node needed
- [ ] Version number updated (if workflow tracks version)
- [ ] All HTTP Request nodes use correct credentials
- [ ] Error-prone nodes have `continueOnFail: true`
- [ ] Logging nodes have `continueOnFail: true`
- [ ] Workflow name follows naming convention (N#.# format)
- [ ] Tags added for organization

After deployment:

- [ ] Workflow activated via API
- [ ] Webhook/schedule tested and working
- [ ] Execution logged in n8n UI
- [ ] Changes committed to git

## Environment Configuration

**n8n API:**
- Production URL: `https://n8n.specialblend.icu`
- API Base: `https://n8n.specialblend.icu/api/v1`
- Auth: `X-N8N-API-KEY` header (from .env)

**Related Services:**
- DataAPI: `http://192.168.2.33:3003`
- AgentX: `http://192.168.2.33:3080`

## File Locations

- Workflows: `/home/yb/codes/AgentX/AgentC/*.json`
- Deploy script: `/home/yb/codes/AgentX/scripts/deploy-n8n-workflows.sh`
- Connection fix: `/home/yb/codes/AgentX/scripts/fix-workflow-connections.jq`
- Environment: `/home/yb/codes/AgentX/.env`

## Version History

**N0.0 - Deployment Test Workflow:**
- v2.0.0: Enhanced with comprehensive status output
- v2.1.0: Fixed node name mismatch in connections
- v2.2.0: Fixed responseMode (onReceived → responseNode) + added webhookId

**N3.2 - External AI Gateway:**
- v2.0: Connections fixed to use node names
- v2.1: Added webhookId and httpMethod (POST) to webhook node
- Deployed with proper responseNode mode

**N5.1 - Feedback Analysis:**
- v2.0: Connections fixed to use node names
- v2.1: Added webhookId to webhook node
- continueOnFail added to logging nodes

**Guide Updates:**
- 2026-01-03: Added critical webhookId and httpMethod requirements
- 2026-01-03: Documented connection name vs ID issue and fix script
- 2026-01-03: Added comprehensive deployment and troubleshooting guide
