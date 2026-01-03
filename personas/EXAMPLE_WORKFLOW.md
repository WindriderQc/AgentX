# Example: Using SBQC Workflow Architect (N6.1)

This document demonstrates how to use the SBQC Workflow Architect persona to generate n8n workflows.

## Example 1: Simple Health Check Workflow

### User Request
> "Create a workflow that checks if DataAPI is responding every 10 minutes and logs the result."

### Generated Workflow

```json
{
  "name": "SBQC - N1.4 DataAPI Health Monitor (10 min)",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "minutes",
              "minutes": 10
            }
          ]
        }
      },
      "id": "schedule-trigger",
      "name": "Schedule (Every 10 min)",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.1,
      "position": [-600, -100]
    },
    {
      "parameters": {
        "path": "sbqc-n1-4-dataapi-health",
        "options": {}
      },
      "id": "webhook-trigger",
      "name": "Webhook (Manual)",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [-600, 100],
      "webhookId": "sbqc-n1-4-dataapi-health"
    },
    {
      "parameters": {},
      "id": "merge-triggers",
      "name": "Merge Triggers",
      "type": "n8n-nodes-base.merge",
      "typeVersion": 3,
      "position": [-350, 0]
    },
    {
      "parameters": {
        "url": "http://192.168.2.33:3003/health",
        "options": {
          "timeout": 5000
        }
      },
      "id": "check-health",
      "name": "Check DataAPI Health",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [100, 0],
      "continueOnFail": true
    },
    {
      "parameters": {
        "jsCode": "const response = $input.first().json;\nconst isHealthy = response.status === 'ok' || response.ok === true;\n\nreturn [{\n  json: {\n    timestamp: new Date().toISOString(),\n    service: 'DataAPI',\n    endpoint: 'http://192.168.2.33:3003/health',\n    status: isHealthy ? 'healthy' : 'unhealthy',\n    details: response\n  }\n}];"
      },
      "id": "format-result",
      "name": "Format Health Status",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [350, 0]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://192.168.2.33:3003/integrations/events/n8n",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { \"workflow_id\": \"SBQC-N1.4-health\", \"event_type\": \"health_check\", \"data\": $json } }}",
        "options": {
          "timeout": 5000
        }
      },
      "id": "log-result",
      "name": "Log to DataAPI Sink",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [600, 0],
      "credentials": {
        "httpHeaderAuth": {
          "id": "PIrrA2wpOppzVodi",
          "name": "Header Auth account"
        }
      },
      "continueOnFail": true
    }
  ],
  "connections": {
    "Schedule (Every 10 min)": {
      "main": [
        [
          {
            "node": "Merge Triggers",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Webhook (Manual)": {
      "main": [
        [
          {
            "node": "Merge Triggers",
            "type": "main",
            "index": 1
          }
        ]
      ]
    },
    "Merge Triggers": {
      "main": [
        [
          {
            "node": "Check DataAPI Health",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Check DataAPI Health": {
      "main": [
        [
          {
            "node": "Format Health Status",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Format Health Status": {
      "main": [
        [
          {
            "node": "Log to DataAPI Sink",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "settings": {
    "executionOrder": "v1"
  },
  "active": false,
  "staticData": null,
  "tags": [
    {
      "name": "SBQC",
      "id": "sbqc"
    },
    {
      "name": "Priority-1",
      "id": "p1"
    },
    {
      "name": "Health",
      "id": "health"
    }
  ],
  "meta": {
    "templateCredsSetupCompleted": true
  }
}
```

### Testing

```bash
# Import workflow to n8n via API
curl -X POST http://192.168.2.199:5678/api/v1/workflows \
  -H "Content-Type: application/json" \
  -d @workflow.json

# Trigger manually via webhook
curl -X POST http://192.168.2.199:5678/webhook/sbqc-n1-4-dataapi-health
```

---

## Example 2: Conditional Alert Workflow

### User Request
> "Create a workflow that runs daily at 3 AM, checks MongoDB disk usage, and sends an alert if usage is above 80%."

### Key Features
- Cron schedule (daily 3 AM)
- Manual webhook for testing
- MongoDB disk usage query
- Conditional logic (IF node)
- Alert only when threshold exceeded
- Event logging

### Workflow Structure
```
Schedule (3 AM) ──┐
                  ├──> Merge Triggers ──> Check MongoDB Disk
Webhook ──────────┘                           │
                                              ▼
                                       Calculate Usage %
                                              │
                                              ▼
                                       IF > 80% ?
                                        │      │
                                  True  │      │  False
                                        │      │
                                        ▼      ▼
                                    Send Alert  Success (No-op)
                                        │
                                        ▼
                                   Log Event
```

---

## Example 3: Complex Parallel Workflow

### User Request
> "Create a workflow that monitors all SBQC services (DataAPI, AgentX, both Ollama hosts, MongoDB) in parallel every 5 minutes, aggregates the results, and alerts if any service is down."

### Key Features
- 5-minute schedule
- Parallel health checks (5 services simultaneously)
- Merge node to collect all results
- Code node for aggregation and analysis
- Conditional alerting
- Comprehensive error handling

### Workflow Pattern
```
                    ┌──> DataAPI Health ──┐
                    ├──> AgentX Health ───┤
Trigger ──> Split ──┼──> MongoDB Health ──┼──> Merge ──> Aggregate ──> IF Any Down?
                    ├──> Ollama 99 ───────┤                               │      │
                    └──> Ollama 12 ───────┘                         True  │      │  False
                                                                           │      │
                                                                           ▼      ▼
                                                                      Alert  Healthy
```

---

## Example 4: Data Processing Pipeline

### User Request
> "Create a workflow that receives file scan results via webhook, processes duplicates, flags files for deletion, and returns a summary."

### Key Features
- Webhook trigger (POST endpoint)
- Data validation
- Business logic in code nodes
- Multiple HTTP requests to DataAPI
- Response mode with results

### Processing Steps
1. Receive webhook with scan results
2. Validate input data structure
3. Query DataAPI for existing duplicates
4. Compare and identify new duplicates
5. Flag duplicates for Janitor review
6. Generate summary report
7. Return JSON response

---

## Best Practices Demonstrated

### 1. Dual Triggers
All workflows include both:
- Scheduled trigger for automation
- Manual webhook for testing/debugging

### 2. Error Handling
- `continueOnFail: true` on logging nodes
- Appropriate timeouts for all HTTP requests
- Graceful degradation when services unavailable

### 3. Proper Logging
- All significant events logged to DataAPI sink
- Includes workflow_id, event_type, and data
- Non-blocking (continueOnFail)

### 4. Clean Positioning
- Triggers on left (-600)
- Main flow left-to-right
- Vertical spacing for branches
- Readable visual layout

### 5. SBQC Conventions
- Naming: `SBQC - N[X.Y] [Description]`
- Tags: SBQC, Priority, Domain
- WebhookId matches path
- executionOrder: v1

---

## Customization Examples

### Changing Schedule
```json
{
  "parameters": {
    "rule": {
      "interval": [
        {
          "field": "cronExpression",
          "expression": "0 */6 * * *"  // Every 6 hours
        }
      ]
    }
  }
}
```

### Adding Authentication
```json
{
  "parameters": {
    "authentication": "genericCredentialType",
    "genericAuthType": "httpHeaderAuth",
    "httpHeaderAuth": {
      "name": "Authorization",
      "value": "Bearer YOUR_TOKEN"
    }
  }
}
```

### Custom Code Logic
```json
{
  "parameters": {
    "jsCode": "// Access input data\nconst data = $input.first().json;\n\n// Access specific node output\nconst healthCheck = $('Check Health').first().json;\n\n// Access all items\nconst allItems = $input.all();\n\n// Return result\nreturn [{ json: { result: 'processed' } }];"
  }
}
```

---

## Tips for Getting Best Results

### 1. Be Specific
❌ "Create a health check workflow"
✅ "Create a workflow that checks DataAPI /health endpoint every 10 minutes and logs to DataAPI sink"

### 2. Specify Triggers
❌ "Run this workflow regularly"
✅ "Run this workflow daily at 2 AM using a cron schedule, with a manual webhook for testing"

### 3. Define Conditions
❌ "Alert if there's a problem"
✅ "Alert if response time > 2 seconds OR status code != 200"

### 4. Include Endpoints
❌ "Call the API"
✅ "POST to http://192.168.2.33:3003/api/v1/storage/scan with JSON body"

### 5. Mention Error Handling
❌ Default behavior
✅ "Use continueOnFail for logging nodes, but fail fast on critical API calls"

---

## Common Patterns Quick Reference

### Pattern: Health Check
```
Schedule/Webhook → HTTP Request → Format → Log
```

### Pattern: Conditional Alert
```
Trigger → Check → IF → [True: Alert + Log] / [False: No-op]
```

### Pattern: Parallel Checks
```
Trigger → [Check A, Check B, Check C] → Merge → Aggregate → Decision
```

### Pattern: Data Pipeline
```
Webhook → Validate → Process → Store → Respond
```

### Pattern: Periodic Cleanup
```
Cron → Query → Filter → Flag → Summarize → Log
```

---

## Validation Checklist

When reviewing generated workflows:

- [ ] Name follows `SBQC - N[X.Y] [Description]` format
- [ ] All node IDs are unique
- [ ] All connections reference existing nodes
- [ ] WebhookId matches path parameter
- [ ] Positions create readable layout
- [ ] Credentials specified where needed
- [ ] Error handling appropriate
- [ ] Event logging included
- [ ] Tags present (SBQC, Priority, Domain)
- [ ] Valid JSON syntax

---

## Next Steps

1. **Import to n8n**: Copy JSON and import via n8n UI or API
2. **Configure Credentials**: Set up HTTP Header Auth credential
3. **Test Manually**: Trigger via webhook endpoint
4. **Activate**: Enable workflow for scheduled execution
5. **Monitor**: Check execution history and logs
6. **Iterate**: Refine based on results and feedback

---

For more examples and documentation, see:
- `/home/yb/codes/AgentX/AgentC/` - Existing workflow library
- `/home/yb/codes/AgentX/personas/README.md` - Persona system docs
- n8n Documentation: https://docs.n8n.io/
