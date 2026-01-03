# AI Architect Quick Reference - Workflow Templates

**For:** SBQC Architect AI System
**Purpose:** Rapid workflow generation using proven templates
**Location:** `/home/yb/codes/AgentX/AgentC/templates/workflow-templates.json`

---

## Template Selection - 30 Second Guide

| User Request Contains... | Use Template | Complexity |
|-------------------------|--------------|------------|
| "webhook", "endpoint", "API" | `1_basic_webhook` | Low (3 nodes) |
| "schedule", "every", "daily", "hourly" | `2_scheduled_job` | Low (4 nodes) |
| "validate", "check if", "approval", "if/else" | `3_conditional_flow` | Medium (7 nodes) |
| "fetch from multiple", "combine", "parallel" | `4_multi_step_api` | High (9 nodes) |
| "production", "critical", "must not fail" | `5_error_handling` | High (12 nodes) |

---

## Quick Template Access

```javascript
// Read all templates
const templates = require('./workflow-templates.json');

// Get specific template
const basicWebhook = templates.templates['1_basic_webhook'].workflow;

// Copy and customize
let myWorkflow = JSON.parse(JSON.stringify(basicWebhook));
```

---

## Required Customizations Checklist

For EVERY template, you MUST customize:

### 1. Identity
```json
{
  "name": "SBQC - N{X}.{Y} Descriptive Name",
  // In code nodes:
  "workflow_id": "N{X}.{Y}"
}
```

### 2. Webhook (if applicable)
```json
{
  "parameters": {
    "path": "unique-kebab-case-path",
    "httpMethod": "GET" | "POST"
  },
  "webhookId": "sbqc-unique-id"
}
```

### 3. Credentials
```json
{
  "credentials": {
    "httpHeaderAuth": {
      "id": "PIrrA2wpOppzVodi",  // Use this ID for SBQC
      "name": "Header Auth account"
    }
  }
}
```

### 4. Code Nodes
Search for `"// CUSTOMIZE"` comments and replace logic.

---

## Standard SBQC Endpoints

```javascript
// Copy these exactly:

// AgentX Chat (for AI queries)
"url": "http://192.168.2.33:3080/api/chat"

// DataAPI Integration Sink (for logging)
"url": "http://192.168.2.33:3003/integrations/events/n8n"
"jsonBody": {
  "workflow_id": "N{X}.{Y}",
  "event_type": "your_event_type",
  "data": "$json"
}

// Health Endpoints
"url": "http://192.168.2.33:3003/health"  // DataAPI
"url": "http://192.168.2.33:3080/health"  // AgentX

// Ollama (monitoring only, never for chat)
"url": "http://192.168.2.99:11434/api/tags"  // UGFrank
"url": "http://192.168.2.12:11434/api/tags"  // UGBrutal
```

---

## Code Node Patterns

### Access Input Data
```javascript
// Single input (no merge)
const data = $input.first().json;

// Multiple inputs (after merge)
const inputs = $input.all();
const first = inputs[0]?.json || {};
const second = inputs[1]?.json || {};

// Webhook body
const body = $input.first().json.body || {};
```

### Return Data
```javascript
// Always return array with json objects
return [{
  json: {
    key: "value"
  }
}];
```

### Error Handling
```javascript
// Check for API errors
if (response.error) {
  return [{
    json: {
      error: true,
      message: response.error.message,
      // ... error details
    }
  }];
}
```

---

## HTTP Request Node Settings

### Always Include
```json
{
  "continueOnFail": true,  // REQUIRED - prevents workflow stopping
  "options": {
    "timeout": 10000  // 10 seconds (adjust as needed)
  }
}
```

### For External APIs (may be unreliable)
```json
{
  "continueOnFail": true,
  "options": {
    "timeout": 10000,
    "retry": {
      "maxRetries": 3,
      "retryInterval": 1000
    }
  }
}
```

---

## Position Coordinates Guide

Use clean, grid-aligned positions for visual clarity:

```javascript
// Horizontal spacing: 250 pixels
// Vertical spacing: 200 pixels for branches

// Linear flow (left to right)
[250, 300]   // Start
[500, 300]   // Step 2
[750, 300]   // Step 3
[1000, 300]  // End

// Branching flow
[750, 300]   // IF node
[1000, 200]  // Success path (top)
[1000, 400]  // Error path (bottom)
[1250, 300]  // Merge point

// Parallel flows
[500, 300]   // Split point
[750, 200]   // Branch 1 (top)
[750, 400]   // Branch 2 (bottom)
[1000, 300]  // Merge
```

---

## Common Node Types Reference

```javascript
// Triggers
"n8n-nodes-base.webhook"          // HTTP endpoint
"n8n-nodes-base.scheduleTrigger"  // Time-based

// Processing
"n8n-nodes-base.code"             // JavaScript code
"n8n-nodes-base.if"               // Conditional branching
"n8n-nodes-base.merge"            // Combine multiple inputs

// Actions
"n8n-nodes-base.httpRequest"      // Call APIs
"n8n-nodes-base.respondToWebhook" // Send HTTP response
"n8n-nodes-base.noOp"             // Placeholder (do nothing)
```

---

## Validation Checklist

Before deploying, verify:

- [ ] All `YOUR_WORKFLOW_ID` replaced with actual ID (e.g., "N1.1")
- [ ] All `YOUR_CREDENTIAL_ID` replaced with "PIrrA2wpOppzVodi"
- [ ] All example URLs replaced with actual endpoints
- [ ] All "CUSTOMIZE" comments addressed
- [ ] `continueOnFail: true` on all HTTP nodes
- [ ] Unique webhook paths (no duplicates)
- [ ] Valid JSON syntax: `jq empty workflow.json`
- [ ] Tags added: `[{"name": "SBQC", "id": "sbqc"}]`

---

## Quick Generation Template

```javascript
// AI Architect workflow generation pattern:

function generateWorkflow(userRequest) {
  // 1. Analyze request and select template
  const templateKey = selectTemplate(userRequest);
  const template = readTemplate(templateKey);

  // 2. Extract workflow structure
  let workflow = JSON.parse(JSON.stringify(template.workflow));

  // 3. Customize identity
  workflow.name = `SBQC - ${workflowId} ${descriptiveName}`;

  // 4. Update webhook/schedule based on trigger type
  if (hasTrigger(workflow, 'webhook')) {
    updateWebhook(workflow, webhookPath);
  } else if (hasTrigger(workflow, 'schedule')) {
    updateSchedule(workflow, scheduleConfig);
  }

  // 5. Customize code nodes
  workflow.nodes.forEach(node => {
    if (node.type === 'n8n-nodes-base.code') {
      node.parameters.jsCode = customizeCode(
        node.parameters.jsCode,
        userRequest
      );
    }
  });

  // 6. Update credentials
  updateCredentials(workflow, 'PIrrA2wpOppzVodi');

  // 7. Add tags
  workflow.tags = [
    { "name": "SBQC", "id": "sbqc" },
    { "name": extractPriority(workflowId), "id": "priority" }
  ];

  return workflow;
}
```

---

## Template Complexity Map

```
Basic Webhook (3 nodes) ─────────┐
                                 │
Scheduled Job (4 nodes) ─────────┤
                                 ├─→ Simple workflows
Conditional Flow (7 nodes) ──────┤
                                 │
Multi-step API (9 nodes) ────────┤
                                 ├─→ Complex workflows
Error Handling (12 nodes) ───────┘
```

**Combine templates for complex requirements:**
- Schedule + Error Handling = Robust scheduled job
- Multi-step + Conditional = Complex orchestration
- Basic + Error Handling = Simple but reliable endpoint

---

## Example Generation Flow

**User:** "Create a workflow that checks system health every 5 minutes"

**AI Analysis:**
1. Trigger: Schedule (every 5 minutes) → Use template `2_scheduled_job`
2. Action: Check health → HTTP requests
3. Processing: Aggregate results → Code node
4. Output: Log to DataAPI → HTTP request

**AI Actions:**
```javascript
// 1. Load template
const template = templates.templates['2_scheduled_job'].workflow;

// 2. Customize
template.name = "SBQC - N1.1 System Health Check (5 min)";

// 3. Update schedule
template.nodes[0].parameters.rule.interval = [
  { "field": "minutes", "minutesInterval": 5 }
];

// 4. Update API calls
template.nodes[1].parameters.url = "http://192.168.2.33:3003/health";

// 5. Customize processing logic
template.nodes[2].parameters.jsCode = `
  const response = $input.first().json;
  return [{
    json: {
      status: response.status === 'ok' ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      details: response
    }
  }];
`;

// 6. Update logging
template.nodes[3].parameters.jsonBody = {
  workflow_id: "N1.1",
  event_type: "health_check",
  data: "$json"
};
```

---

## Anti-Patterns to Avoid

### DON'T:
```javascript
// ❌ Don't hardcode credentials
"headers": {
  "X-API-Key": "secret-key-here"
}

// ❌ Don't skip error handling
{
  "continueOnFail": false  // Will stop workflow on error!
}

// ❌ Don't use $node with merged inputs
const data = $node["Previous Node"].json;  // Fails with merge!

// ❌ Don't call Ollama directly for chat
"url": "http://192.168.2.99:11434/api/chat"  // Use AgentX instead!
```

### DO:
```javascript
// ✓ Use credentials
"credentials": {
  "httpHeaderAuth": {
    "id": "PIrrA2wpOppzVodi"
  }
}

// ✓ Always handle errors
{
  "continueOnFail": true
}

// ✓ Use $input for data access
const data = $input.first().json;

// ✓ Route AI requests through AgentX
"url": "http://192.168.2.33:3080/api/chat"
```

---

## Deployment Quick Command

```bash
# After generating workflow JSON:
cd /home/yb/codes/AgentX
./scripts/deploy-n8n-workflows.sh AgentC/N{X}.{Y}.json
```

---

## Testing Quick Command

```bash
# For webhooks:
curl -X POST https://n8n.specialblend.icu/webhook/your-path \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'

# For scheduled workflows:
# Trigger manually in n8n UI: Execute Workflow button
```

---

## Quick Links

- **Templates:** `/home/yb/codes/AgentX/AgentC/templates/workflow-templates.json`
- **Examples:** `/home/yb/codes/AgentX/AgentC/templates/USAGE_EXAMPLES.md`
- **Full docs:** `/home/yb/codes/AgentX/AgentC/templates/README.md`
- **Production workflows:** `/home/yb/codes/AgentX/AgentC/N*.json`

---

## Emergency Reference

**Workflow won't deploy?**
```bash
jq empty workflow.json  # Check JSON syntax
```

**Webhook returns 404?**
- Check workflow is active in n8n UI
- Verify webhook path matches JSON

**Credentials error?**
- Use credential ID: `PIrrA2wpOppzVodi`
- Set in: `credentials.httpHeaderAuth.id`

**Node data access error?**
- Single input: `$input.first().json`
- Multiple inputs: `$input.all()[0].json`
- Never use: `$node["Name"]` with merges

---

**Last updated:** 2026-01-02
**Version:** 1.0.0
**Quick help:** Read `/home/yb/codes/AgentX/AgentC/templates/INDEX.md`
