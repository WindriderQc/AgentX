# Workflow Template Usage Examples

This document shows practical examples of how to use the workflow templates for common SBQC tasks.

## Example 1: Create a Simple Status Endpoint

**Requirement:** Create a webhook endpoint that returns system status information.

**Template to use:** `1_basic_webhook`

**Steps:**

1. Extract the template:
```bash
jq '.templates["1_basic_webhook"].workflow' workflow-templates.json > N0.5-status-endpoint.json
```

2. Customize the workflow:
```json
{
  "name": "N0.5 - System Status Endpoint",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "GET",
        "path": "system-status",  // CHANGED from "my-webhook-endpoint"
        ...
      },
      "webhookId": "sbqc-system-status"  // CHANGED
    },
    {
      "parameters": {
        "jsCode": "const result = {\n  status: 'operational',\n  version: '2.2.0',\n  services: {\n    agentx: 'healthy',\n    dataapi: 'healthy',\n    n8n: 'healthy'\n  },\n  timestamp: new Date().toISOString()\n};\n\nreturn [{ json: result }];"
      }
    }
  ]
}
```

3. Deploy:
```bash
./scripts/deploy-n8n-workflows.sh N0.5-status-endpoint.json
```

4. Test:
```bash
curl https://n8n.specialblend.icu/webhook/system-status
```

---

## Example 2: Scheduled Database Backup Check

**Requirement:** Check database backup status every day at 3 AM and log results.

**Template to use:** `2_scheduled_job`

**Key customizations:**

```json
{
  "name": "N2.5 - Daily Backup Verification",
  "nodes": [
    {
      "name": "Schedule Trigger",
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "cronExpression",
              "expression": "0 3 * * *"  // 3 AM daily
            }
          ]
        }
      }
    },
    {
      "name": "Check Backup Status",
      "parameters": {
        "method": "GET",
        "url": "http://192.168.2.33:3003/admin/backup/status"
        // ... authentication ...
      }
    },
    {
      "name": "Process Results",
      "parameters": {
        "jsCode": "const response = $input.first().json;\n\nif (response.error) {\n  return [{\n    json: {\n      status: 'error',\n      alert: true,\n      message: 'Backup check failed',\n      error: response.error\n    }\n  }];\n}\n\nconst lastBackup = new Date(response.lastBackup);\nconst hoursSinceBackup = (Date.now() - lastBackup) / 1000 / 60 / 60;\n\nreturn [{\n  json: {\n    status: hoursSinceBackup < 24 ? 'ok' : 'warning',\n    alert: hoursSinceBackup >= 24,\n    lastBackup: response.lastBackup,\n    hoursSinceBackup: hoursSinceBackup,\n    backupSize: response.size,\n    timestamp: new Date().toISOString()\n  }\n}];"
      }
    },
    {
      "name": "Log to DataAPI",
      "parameters": {
        "jsonBody": "={{ {\n  workflow_id: 'N2.5',\n  event_type: 'backup_verification',\n  severity: $json.alert ? 'warning' : 'info',\n  data: $json\n} }}"
      }
    }
  ]
}
```

---

## Example 3: User Registration with Validation

**Requirement:** Accept user registration data, validate it, create user in database, send confirmation email.

**Template to use:** `3_conditional_flow`

**Key customizations:**

```json
{
  "name": "N4.1 - User Registration",
  "nodes": [
    {
      "name": "Webhook Trigger",
      "parameters": {
        "httpMethod": "POST",
        "path": "user-registration"
      }
    },
    {
      "name": "Validate Input",
      "parameters": {
        "jsCode": "const input = $input.first().json;\nconst data = input.body;\n\nconst errors = [];\n\n// Email validation\nif (!data.email || !data.email.match(/^[^@]+@[^@]+\\.[^@]+$/)) {\n  errors.push('Invalid email address');\n}\n\n// Password validation\nif (!data.password || data.password.length < 8) {\n  errors.push('Password must be at least 8 characters');\n}\n\n// Username validation\nif (!data.username || data.username.length < 3) {\n  errors.push('Username must be at least 3 characters');\n}\n\nif (errors.length > 0) {\n  return [{\n    json: {\n      valid: false,\n      error: true,\n      errors: errors\n    }\n  }];\n}\n\nreturn [{\n  json: {\n    valid: true,\n    error: false,\n    data: {\n      email: data.email,\n      username: data.username,\n      password: data.password // Should be hashed!\n    }\n  }\n}];"
      }
    },
    {
      "name": "IF Valid",
      "type": "n8n-nodes-base.if"
    },
    {
      "name": "Create User",
      "parameters": {
        "method": "POST",
        "url": "http://192.168.2.33:3003/users",
        "jsonBody": "={{ $json.data }}"
      }
    },
    {
      "name": "Send Confirmation Email",
      "parameters": {
        "method": "POST",
        "url": "http://192.168.2.33:3003/email/send",
        "jsonBody": "={{ {\n  to: $json.data.email,\n  subject: 'Welcome!',\n  template: 'registration_confirmation',\n  data: { username: $json.data.username }\n} }}"
      }
    },
    {
      "name": "Format Error Response",
      "parameters": {
        "jsCode": "const input = $input.first().json;\nreturn [{\n  json: {\n    success: false,\n    message: 'Validation failed',\n    errors: input.errors\n  }\n}];"
      }
    }
  ]
}
```

---

## Example 4: Multi-Source Data Aggregation

**Requirement:** Fetch user profile from database, get recent activity from logs, get AI recommendations from AgentX, merge into complete profile.

**Template to use:** `4_multi_step_api`

**Key customizations:**

```json
{
  "name": "N4.2 - Complete User Profile",
  "nodes": [
    {
      "name": "Webhook Trigger",
      "parameters": {
        "httpMethod": "GET",
        "path": "user-profile/{{ $parameter.path }}",
        "options": {
          "responseMode": "responseNode"
        }
      }
    },
    {
      "name": "Prepare Parameters",
      "parameters": {
        "jsCode": "const userId = $input.first().json.params.path;\nreturn [{ json: { userId: userId } }];"
      }
    },
    {
      "name": "Fetch User Data",
      "parameters": {
        "url": "http://192.168.2.33:3003/users/{{ $json.userId }}"
      }
    },
    {
      "name": "Fetch Activity Logs",
      "parameters": {
        "url": "http://192.168.2.33:3003/logs/user/{{ $json.userId }}/recent?limit=10"
      }
    },
    {
      "name": "Get AI Recommendations",
      "parameters": {
        "method": "POST",
        "url": "http://192.168.2.33:3080/api/chat",
        "jsonBody": "={{ {\n  message: 'Generate personalized recommendations for user ' + $json.userId,\n  model: 'qwen2.5:7b-instruct-q4_0',\n  useRag: true\n} }}"
      }
    },
    {
      "name": "Merge All Data",
      "type": "n8n-nodes-base.merge"
    },
    {
      "name": "Format Complete Profile",
      "parameters": {
        "jsCode": "const inputs = $input.all();\n\nconst userData = inputs[0]?.json || {};\nconst activityData = inputs[1]?.json || {};\nconst recommendations = inputs[2]?.json?.body?.response || 'No recommendations';\n\nreturn [{\n  json: {\n    user: {\n      id: userData.id,\n      name: userData.name,\n      email: userData.email,\n      createdAt: userData.createdAt\n    },\n    recentActivity: activityData.logs || [],\n    activitySummary: {\n      totalActions: activityData.logs?.length || 0,\n      lastActive: activityData.logs?.[0]?.timestamp || null\n    },\n    recommendations: recommendations,\n    timestamp: new Date().toISOString()\n  }\n}];"
      }
    }
  ]
}
```

---

## Example 5: Critical API Gateway with Full Error Handling

**Requirement:** Production API gateway for external clients that must never fail and log all errors.

**Template to use:** `5_error_handling`

**Key customizations:**

```json
{
  "name": "N3.3 - Production API Gateway",
  "nodes": [
    {
      "name": "Webhook Trigger",
      "parameters": {
        "httpMethod": "POST",
        "path": "api/v1/execute"
      }
    },
    {
      "name": "Initialize Context",
      "parameters": {
        "jsCode": "const input = $input.first().json;\nreturn [{\n  json: {\n    workflowId: 'N3.3',\n    executionId: $execution.id,\n    startTime: Date.now(),\n    requestData: input.body || input,\n    clientId: input.body?.clientId || 'anonymous'\n  }\n}];"
      }
    },
    {
      "name": "Call Backend Service",
      "parameters": {
        "method": "POST",
        "url": "http://backend-service.local/process",
        "options": {
          "timeout": 30000,
          "retry": {\n            "maxRetries": 3,\n            "retryInterval": 2000\n          }
        }
      },
      "continueOnFail": true
    },
    {
      "name": "Check for Error",
      "parameters": {
        "jsCode": "const response = $input.first().json;\n\nif (response.error) {\n  return [{\n    json: {\n      hasError: true,\n      errorType: response.error.code || 'UNKNOWN_ERROR',\n      errorMessage: response.error.message || 'Service unavailable',\n      statusCode: response.statusCode || 500,\n      isRetryable: response.statusCode >= 500\n    }\n  }];\n}\n\nreturn [{\n  json: {\n    hasError: false,\n    data: response,\n    statusCode: 200\n  }\n}];"
      }
    },
    {
      "name": "IF Success",
      "type": "n8n-nodes-base.if"
    },
    {
      "name": "Handle Success",
      "parameters": {
        "jsCode": "const response = $input.first().json;\nreturn [{\n  json: {\n    success: true,\n    data: response.data,\n    processingTime: Date.now() - response.startTime,\n    timestamp: new Date().toISOString()\n  }\n}];"
      }
    },
    {
      "name": "Handle Error - Graceful Degradation",
      "parameters": {
        "jsCode": "const error = $input.first().json;\n\n// Provide fallback response\nreturn [{\n  json: {\n    success: false,\n    error: {\n      type: error.errorType,\n      message: error.errorMessage,\n      retryable: error.isRetryable\n    },\n    fallback: {\n      message: 'Service temporarily unavailable. Please try again later.',\n      supportContact: 'support@example.com'\n    },\n    timestamp: new Date().toISOString()\n  }\n}];"
      }
    },
    {
      "name": "Log Error to DataAPI",
      "parameters": {
        "jsonBody": "={{ {\n  workflow_id: 'N3.3',\n  event_type: 'api_gateway_error',\n  severity: $json.error.retryable ? 'warning' : 'critical',\n  data: $json\n} }}",
        "continueOnFail": true
      }
    },
    {
      "name": "Respond with Appropriate Status",
      "parameters": {
        "respondWith": "json",\n        "responseBody": "={{ $json }}",
        "options": {
          "responseCode": "={{ $json.success ? 200 : ($json.error.retryable ? 503 : 500) }}"
        }
      }
    }
  ]
}
```

---

## AI Architect Usage Pattern

When the SBQC Architect AI needs to create a new workflow:

1. **Analyze the requirement** and determine which template best fits
2. **Extract the template** from the JSON file
3. **Customize** based on specific requirements:
   - Update workflow name and ID
   - Set webhook paths or schedule
   - Customize code node logic
   - Configure API endpoints
   - Set up proper error handling
4. **Validate** the generated JSON
5. **Deploy** using the deployment script

### Example AI Prompt Flow

```
User: "Create a workflow that checks Ollama model availability every hour and alerts if a model is missing"

AI Analysis:
- Pattern: Scheduled job (hourly check)
- External API: Ollama tags endpoint
- Processing: Check for expected models
- Action: Alert if missing
- Template: 2_scheduled_job

AI generates workflow based on template with customizations:
- Schedule: Every hour
- API call: Ollama tags endpoint
- Logic: Compare available vs expected models
- Alert: Log to DataAPI if mismatch
```

---

## Template Selection Guide

**Choose based on workflow characteristics:**

| Template | When to Use |
|----------|-------------|
| **1_basic_webhook** | Simple data in/out, no external calls, quick response |
| **2_scheduled_job** | Time-based triggers, periodic checks, scheduled tasks |
| **3_conditional_flow** | Need validation, branching logic, different paths |
| **4_multi_step_api** | Multiple external services, data aggregation, parallel calls |
| **5_error_handling** | Production critical, must never fail, comprehensive logging |

**Can combine patterns:**
- Scheduled job + Error handling
- Multi-step API + Conditional flow
- Basic webhook + Error handling

---

## Common Pitfalls and Solutions

### Pitfall 1: Forgetting to Update Credential IDs
**Problem:** Workflow fails with "Credential not found"

**Solution:**
```bash
# List credentials in n8n
curl http://n8n.example.com/api/v1/credentials -H "X-N8N-API-KEY: $N8N_API_KEY"

# Update all instances of YOUR_CREDENTIAL_ID in workflow JSON
```

### Pitfall 2: Not Setting continueOnFail
**Problem:** Entire workflow stops on single API failure

**Solution:** Always set `continueOnFail: true` on HTTP nodes:
```json
{
  "type": "n8n-nodes-base.httpRequest",
  "continueOnFail": true
}
```

### Pitfall 3: Wrong Node Data Access
**Problem:** "Cannot read property 'json' of undefined"

**Solution:** Use correct accessor:
```javascript
// Single input
const data = $input.first().json;

// Multiple merged inputs
const all = $input.all();
const first = all[0]?.json;
```

### Pitfall 4: Missing Error Logging
**Problem:** Errors occur but not tracked

**Solution:** Always add logging node with continueOnFail:
```json
{
  "name": "Log to DataAPI",
  "continueOnFail": true,
  "jsonBody": "={{ { workflow_id: 'N1.1', event_type: 'error', data: $json } }}"
}
```

---

## Testing Your Customized Workflow

1. **Validate JSON syntax:**
```bash
jq empty my-workflow.json
```

2. **Check structure:**
```bash
jq '.nodes | length' my-workflow.json
jq '.connections | keys' my-workflow.json
```

3. **Deploy to n8n:**
```bash
./scripts/deploy-n8n-workflows.sh my-workflow.json
```

4. **Test in n8n UI:**
- Open workflow
- Click "Execute Workflow" for manual test
- Check execution log for errors

5. **Test webhook (if applicable):**
```bash
curl -X POST https://n8n.specialblend.icu/webhook/your-path \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

---

## Resources

- **Template Library**: `workflow-templates.json`
- **Template Validator**: `./validate-templates.sh`
- **n8n API Docs**: https://docs.n8n.io/api/
- **SBQC Workflows**: `/home/yb/codes/AgentX/AgentC/N*.json`
