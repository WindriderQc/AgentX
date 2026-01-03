# SBQC Workflow Templates Library

This directory contains reusable workflow templates for the SBQC Architect AI system.

## Overview

The **workflow-templates.json** file provides 5 production-ready workflow patterns that can be adapted for different use cases. Each template includes:

- Complete node configurations with working parameters
- Detailed inline comments explaining what to customize
- Proper error handling with `continueOnFail`
- Integration with DataAPI logging
- Clean visual layout with position coordinates
- Best practices from existing SBQC workflows

## Available Templates

### 1. Basic Webhook Workflow
**Pattern:** Webhook → Process → Respond

**Use for:**
- Simple API endpoints
- Quick data transformations
- Status checks
- Simple integrations

**Example:** N0.0 Deployment Test, N0.1 Health Dashboard

---

### 2. Scheduled Job Pattern
**Pattern:** Schedule → Fetch Data → Process → Log to DataAPI

**Use for:**
- Regular health checks
- Periodic data syncs
- Scheduled reports
- Automated maintenance

**Example:** N1.1 System Health Check (every 5 minutes)

---

### 3. Conditional Flow Pattern
**Pattern:** Webhook → Validate → IF (success/fail) → Different Actions → Merge → Respond

**Use for:**
- Input validation workflows
- Approval processes
- Quality checks
- Multi-path business logic

**Example:** N3.2 External AI Gateway (validation + error handling)

---

### 4. Multi-step API Pattern
**Pattern:** Webhook → Prepare → Call API 1 + Call API 2 (parallel) → Process each → Merge → Respond

**Use for:**
- Data enrichment from multiple sources
- Multi-service orchestration
- Parallel API calls with result aggregation
- Complex data pipelines

**Example:** N1.1 System Health (parallel health checks of 4 services)

---

### 5. Error Handling Pattern
**Pattern:** Webhook → Init → Risky Operation → Check Error → IF → Success/Error paths → Log → Respond

**Use for:**
- Production workflows requiring robustness
- External API calls that may fail
- Critical workflows needing error logging
- Workflows with retry logic

**Example:** All production workflows with `continueOnFail: true`

---

## Quick Start

### For AI Architect
```bash
# Read the templates
cat /home/yb/codes/AgentX/AgentC/templates/workflow-templates.json | jq '.templates["1_basic_webhook"]'

# Use as reference when generating new workflows
# Copy the structure and customize for specific use case
```

### For Developers

1. **Browse templates:**
   ```bash
   cd /home/yb/codes/AgentX/AgentC/templates
   jq '.templates | keys' workflow-templates.json
   ```

2. **Extract a specific template:**
   ```bash
   jq '.templates["3_conditional_flow"].workflow' workflow-templates.json > my-workflow.json
   ```

3. **Customize the workflow:**
   - Replace all `YOUR_WORKFLOW_ID` with your workflow identifier
   - Update `YOUR_CREDENTIAL_ID` with actual credential IDs
   - Replace example URLs with real endpoints
   - Customize code node logic (search for "CUSTOMIZE" comments)
   - Update webhook paths and methods

4. **Deploy:**
   ```bash
   # Validate JSON
   jq empty my-workflow.json

   # Deploy to n8n
   /home/yb/codes/AgentX/scripts/deploy-n8n-workflows.sh my-workflow.json
   ```

---

## Customization Guide

### Required Changes
Every template requires these customizations:

1. **Workflow Identification**
   - `workflow_id`: Set to your workflow ID (e.g., "N1.1", "N3.2")
   - `name`: Set descriptive workflow name
   - Webhook `path`: Set unique webhook endpoint path

2. **Credentials**
   - Replace `YOUR_CREDENTIAL_ID` with actual n8n credential IDs
   - Set up credentials in n8n UI: Settings > Credentials > New Credential

3. **Endpoints**
   - Replace example API URLs with real service endpoints
   - Update DataAPI URL if different from default (192.168.2.33:3003)

4. **Business Logic**
   - Search for "CUSTOMIZE" comments in code nodes
   - Replace placeholder logic with your specific requirements
   - Update validation rules, data transformations, etc.

### Optional Enhancements

- **Tags**: Add workflow tags for organization
- **Schedule**: Adjust schedule intervals for scheduled jobs
- **Timeouts**: Tune timeout values based on expected response times
- **Retry Logic**: Configure retry attempts and intervals
- **Position Coordinates**: Adjust node positions for better visual layout

---

## Best Practices

### Error Handling
```json
{
  "continueOnFail": true,  // Prevents workflow from stopping on error
  "options": {
    "timeout": 10000,      // Set appropriate timeout
    "retry": {             // Configure retry logic
      "maxRetries": 3
    }
  }
}
```

### Node Data Access
```javascript
// Single input
const data = $input.first().json;

// Multiple merged inputs
const inputs = $input.all();
const first = inputs[0]?.json;
const second = inputs[1]?.json;

// Current node data
const current = $json;

// Workflow metadata
const workflowId = $workflow.id;
const executionId = $execution.id;
```

### Response Format
```javascript
// Always return consistent format
return [{
  json: {
    success: true/false,
    message: "...",
    data: {...},
    error: null/{...},
    timestamp: new Date().toISOString()
  }
}];
```

### Logging to DataAPI
```json
{
  "url": "http://192.168.2.33:3003/integrations/events/n8n",
  "jsonBody": {
    "workflow_id": "YOUR_WORKFLOW_ID",
    "event_type": "workflow_event",
    "data": {...}
  },
  "continueOnFail": true  // Don't let logging failures stop workflow
}
```

---

## Template Structure

Each template in the JSON file contains:

```json
{
  "name": "Template Name",
  "description": "What this template does",
  "use_cases": ["case 1", "case 2"],
  "workflow": {
    "name": "...",
    "nodes": [...],
    "connections": {...},
    "settings": {...},
    "tags": [...]
  }
}
```

---

## Integration with SBQC Stack

### Design Principles
From SBQC architecture:

1. **n8n = Orchestration only** (no AI reasoning)
2. **AgentX = All AI logic** (reasoning, classification)
3. **DataAPI = Source of truth** (storage, scans)
4. **Ollama = Inference** (n8n never calls directly for chat)

### Typical Integration Points

- **AgentX Chat API**: `http://192.168.2.33:3080/api/chat`
- **DataAPI Integration Sink**: `http://192.168.2.33:3003/integrations/events/n8n`
- **DataAPI Health**: `http://192.168.2.33:3003/health`
- **Ollama Tags** (for monitoring only): `http://192.168.2.99:11434/api/tags`

---

## Examples from Production

### N0.0 - Deployment Test
Uses: **Basic Webhook** pattern
- Simple GET webhook
- Returns deployment status
- No external calls

### N1.1 - System Health Check
Uses: **Scheduled Job** + **Multi-step API** patterns
- Scheduled every 5 minutes
- Parallel health checks (4 APIs)
- Merges results
- Conditional logging on degradation

### N3.2 - External AI Gateway
Uses: **Conditional Flow** + **Error Handling** patterns
- Validates incoming requests
- Routes to AgentX on success
- Handles errors gracefully
- Logs all events to DataAPI

---

## Troubleshooting

### Template Won't Import
**Issue:** JSON syntax errors

**Solution:**
```bash
# Validate JSON
jq empty workflow.json

# Pretty print to find issues
jq '.' workflow.json
```

### Credentials Not Found
**Issue:** `YOUR_CREDENTIAL_ID` not replaced

**Solution:**
1. Create credentials in n8n UI
2. Copy credential ID from URL or API
3. Replace all instances in workflow JSON

### Webhook Returns 404
**Issue:** Workflow not active or path incorrect

**Solution:**
1. Activate workflow in n8n UI
2. Verify webhook path in workflow JSON
3. Test with: `curl http://n8n.example.com/webhook/your-path`

### Node Reference Errors
**Issue:** Using `$node` with merged inputs

**Solution:**
Use `$input.first()` or `$input.all()` instead of `$node` when dealing with merged data.

---

## Resources

- **SBQC Workflows Guide**: `/home/yb/codes/AgentX/AgentC/WORKFLOW-GUIDE.md`
- **n8n Documentation**: https://docs.n8n.io/
- **Existing Workflows**: `/home/yb/codes/AgentX/AgentC/N*.json`
- **Deployment Script**: `/home/yb/codes/AgentX/scripts/deploy-n8n-workflows.sh`

---

## Contributing

When adding new templates:

1. Follow existing template structure
2. Include comprehensive comments with "CUSTOMIZE" markers
3. Set sensible position coordinates for visual layout
4. Test template thoroughly before adding
5. Document use cases and examples
6. Update this README with new template info

---

## Version History

- **1.0.0** (2026-01-02): Initial release with 5 core templates
  - Basic Webhook
  - Scheduled Job
  - Conditional Flow
  - Multi-step API
  - Error Handling
