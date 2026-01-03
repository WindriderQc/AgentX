# SBQC Workflow Patterns Quick Reference

Common patterns and templates for n8n workflows in the SBQC stack.

## Pattern Categories

- [Triggers](#triggers)
- [Data Flow](#data-flow)
- [Conditional Logic](#conditional-logic)
- [Error Handling](#error-handling)
- [Integration](#integration)
- [Complete Workflows](#complete-workflows)

---

## Triggers

### Dual Trigger Pattern (Schedule + Manual)

**Use Case:** Most SBQC workflows - automated execution with manual testing capability

```json
{
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [{"field": "minutes", "minutes": 10}]
        }
      },
      "id": "schedule",
      "name": "Schedule (10 min)",
      "type": "n8n-nodes-base.scheduleTrigger",
      "position": [-600, -100]
    },
    {
      "parameters": {
        "path": "sbqc-workflow-name",
        "webhookId": "sbqc-workflow-name"
      },
      "id": "webhook",
      "name": "Webhook (Manual)",
      "type": "n8n-nodes-base.webhook",
      "position": [-600, 100]
    },
    {
      "parameters": {},
      "id": "merge",
      "name": "Merge Triggers",
      "type": "n8n-nodes-base.merge",
      "position": [-350, 0]
    }
  ],
  "connections": {
    "Schedule (10 min)": {
      "main": [[{"node": "Merge Triggers", "type": "main", "index": 0}]]
    },
    "Webhook (Manual)": {
      "main": [[{"node": "Merge Triggers", "type": "main", "index": 1}]]
    }
  }
}
```

### Cron Schedule Pattern

**Common Schedules:**
- Daily 2 AM: `"0 2 * * *"`
- Hourly: `"0 * * * *"`
- Every 6 hours: `"0 */6 * * *"`
- Weekly Sunday 3 AM: `"0 3 * * 0"`
- Weekdays 9 AM: `"0 9 * * 1-5"`

```json
{
  "parameters": {
    "rule": {
      "interval": [
        {
          "field": "cronExpression",
          "expression": "0 2 * * *"
        }
      ]
    }
  }
}
```

---

## Data Flow

### Fan-Out (Parallel Execution)

**Use Case:** Execute multiple independent checks simultaneously

```json
{
  "connections": {
    "Trigger": {
      "main": [[
        {"node": "Task A", "type": "main", "index": 0},
        {"node": "Task B", "type": "main", "index": 0},
        {"node": "Task C", "type": "main", "index": 0}
      ]]
    }
  }
}
```

**Visual:**
```
           ┌──> Task A ──┐
Trigger ───┼──> Task B ──┤
           └──> Task C ──┘
```

### Fan-In (Merge Results)

**Use Case:** Collect results from parallel operations

```json
{
  "nodes": [
    {
      "parameters": {
        "mode": "combine",
        "combineBy": "combineAll"
      },
      "type": "n8n-nodes-base.merge",
      "name": "Merge Results"
    }
  ],
  "connections": {
    "Task A": {
      "main": [[{"node": "Merge Results", "type": "main", "index": 0}]]
    },
    "Task B": {
      "main": [[{"node": "Merge Results", "type": "main", "index": 1}]]
    },
    "Task C": {
      "main": [[{"node": "Merge Results", "type": "main", "index": 2}]]
    }
  }
}
```

### Sequential Chain

**Use Case:** Each step depends on previous step's output

```json
{
  "connections": {
    "Step 1": {
      "main": [[{"node": "Step 2", "type": "main", "index": 0}]]
    },
    "Step 2": {
      "main": [[{"node": "Step 3", "type": "main", "index": 0}]]
    },
    "Step 3": {
      "main": [[{"node": "Step 4", "type": "main", "index": 0}]]
    }
  }
}
```

**Visual:**
```
Step 1 → Step 2 → Step 3 → Step 4
```

---

## Conditional Logic

### Simple IF Branch

**Use Case:** Take different actions based on condition

```json
{
  "nodes": [
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "typeValidation": "strict"
          },
          "combinator": "and",
          "conditions": [
            {
              "id": "check",
              "leftValue": "={{ $json.status }}",
              "rightValue": "error",
              "operator": {
                "type": "string",
                "operation": "equals"
              }
            }
          ]
        }
      },
      "type": "n8n-nodes-base.if",
      "name": "Check Status"
    }
  ],
  "connections": {
    "Check Status": {
      "main": [
        [{"node": "Handle Error", "type": "main", "index": 0}],
        [{"node": "Success Path", "type": "main", "index": 0}]
      ]
    }
  }
}
```

**Visual:**
```
          ┌──> True: Handle Error
Check ────┤
          └──> False: Success Path
```

### Multiple Conditions (AND)

```json
{
  "conditions": {
    "combinator": "and",
    "conditions": [
      {
        "leftValue": "={{ $json.status }}",
        "rightValue": "ok",
        "operator": {"type": "string", "operation": "equals"}
      },
      {
        "leftValue": "={{ $json.responseTime }}",
        "rightValue": 2000,
        "operator": {"type": "number", "operation": "lt"}
      }
    ]
  }
}
```

### Multiple Conditions (OR)

```json
{
  "conditions": {
    "combinator": "or",
    "conditions": [
      {
        "leftValue": "={{ $json.status }}",
        "rightValue": "error",
        "operator": {"type": "string", "operation": "equals"}
      },
      {
        "leftValue": "={{ $json.status }}",
        "rightValue": "timeout",
        "operator": {"type": "string", "operation": "equals"}
      }
    ]
  }
}
```

### Numeric Comparison

```json
{
  "conditions": {
    "conditions": [
      {
        "leftValue": "={{ $json.diskUsagePercent }}",
        "rightValue": 80,
        "operator": {"type": "number", "operation": "gt"}
      }
    ]
  }
}
```

### Boolean Check

```json
{
  "conditions": {
    "boolean": [
      {
        "value1": "={{ $json.hasError }}",
        "value2": true
      }
    ]
  }
}
```

---

## Error Handling

### Continue On Fail (Non-Blocking)

**Use Case:** Logging nodes that shouldn't break workflow

```json
{
  "parameters": {
    "method": "POST",
    "url": "http://192.168.2.33:3003/integrations/events/n8n"
  },
  "continueOnFail": true
}
```

### With Timeout

```json
{
  "parameters": {
    "url": "http://api.example.com",
    "options": {
      "timeout": 5000
    }
  },
  "continueOnFail": true
}
```

### Graceful Degradation Pattern

```json
{
  "parameters": {
    "jsCode": "const data = $input.first().json;\n\n// Check if request failed\nif (data.error) {\n  return [{\n    json: {\n      status: 'degraded',\n      service: 'API',\n      error: data.error,\n      fallback: true\n    }\n  }];\n}\n\n// Normal processing\nreturn [{\n  json: {\n    status: 'ok',\n    service: 'API',\n    data: data\n  }\n}];"
  }
}
```

---

## Integration

### DataAPI Event Logging

**Standard pattern for all SBQC workflows**

```json
{
  "parameters": {
    "method": "POST",
    "url": "http://192.168.2.33:3003/integrations/events/n8n",
    "authentication": "genericCredentialType",
    "genericAuthType": "httpHeaderAuth",
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={{ { \"workflow_id\": \"SBQC-N[X.Y]\", \"event_type\": \"event_name\", \"data\": $json } }}",
    "options": {
      "timeout": 5000
    }
  },
  "credentials": {
    "httpHeaderAuth": {
      "id": "PIrrA2wpOppzVodi",
      "name": "Header Auth account"
    }
  },
  "continueOnFail": true
}
```

### DataAPI Health Check

```json
{
  "parameters": {
    "url": "http://192.168.2.33:3003/health",
    "authentication": "genericCredentialType",
    "genericAuthType": "httpHeaderAuth",
    "options": {
      "timeout": 5000
    }
  },
  "credentials": {
    "httpHeaderAuth": {
      "id": "PIrrA2wpOppzVodi",
      "name": "Header Auth account"
    }
  },
  "continueOnFail": true
}
```

### AgentX Chat API Call

```json
{
  "parameters": {
    "method": "POST",
    "url": "http://192.168.2.33:3080/api/chat",
    "authentication": "genericCredentialType",
    "genericAuthType": "httpHeaderAuth",
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={{ JSON.stringify({ message: $json.prompt, model: 'qwen2.5:7b-instruct-q4_0', useRag: false, persona: 'sbqc_ops' }) }}",
    "options": {
      "timeout": 120000
    }
  },
  "credentials": {
    "httpHeaderAuth": {
      "id": "PIrrA2wpOppzVodi",
      "name": "Header Auth account"
    }
  }
}
```

### Ollama API Call

```json
{
  "parameters": {
    "url": "http://192.168.2.99:11434/api/tags",
    "authentication": "genericCredentialType",
    "genericAuthType": "httpHeaderAuth",
    "options": {
      "timeout": 5000,
      "fullResponse": true
    }
  },
  "credentials": {
    "httpHeaderAuth": {
      "id": "PIrrA2wpOppzVodi",
      "name": "Header Auth account"
    }
  },
  "continueOnFail": true
}
```

---

## Complete Workflows

### Minimal Health Check

```json
{
  "name": "SBQC - N1.X Service Health Check",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [{"field": "minutes", "minutes": 5}]
        }
      },
      "id": "trigger",
      "name": "Schedule (5 min)",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.1,
      "position": [-400, 0]
    },
    {
      "parameters": {
        "url": "http://192.168.2.33:3003/health"
      },
      "id": "check",
      "name": "Check Health",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [-100, 0],
      "continueOnFail": true
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://192.168.2.33:3003/integrations/events/n8n",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { workflow_id: 'N1.X', event_type: 'health', data: $json } }}"
      },
      "id": "log",
      "name": "Log Result",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [200, 0],
      "continueOnFail": true
    }
  ],
  "connections": {
    "Schedule (5 min)": {
      "main": [[{"node": "Check Health", "type": "main", "index": 0}]]
    },
    "Check Health": {
      "main": [[{"node": "Log Result", "type": "main", "index": 0}]]
    }
  },
  "settings": {
    "executionOrder": "v1"
  },
  "tags": [
    {"name": "SBQC", "id": "sbqc"},
    {"name": "Priority-1", "id": "p1"}
  ]
}
```

### Alert on Threshold

```json
{
  "name": "SBQC - N3.X Threshold Alert",
  "nodes": [
    {
      "id": "trigger",
      "name": "Schedule",
      "type": "n8n-nodes-base.scheduleTrigger",
      "position": [-400, 0]
    },
    {
      "id": "check",
      "name": "Check Metric",
      "type": "n8n-nodes-base.httpRequest",
      "position": [-100, 0]
    },
    {
      "parameters": {
        "conditions": {
          "conditions": [
            {
              "leftValue": "={{ $json.value }}",
              "rightValue": 80,
              "operator": {"type": "number", "operation": "gt"}
            }
          ]
        }
      },
      "id": "check-threshold",
      "name": "Above Threshold?",
      "type": "n8n-nodes-base.if",
      "position": [150, 0]
    },
    {
      "id": "alert",
      "name": "Send Alert",
      "type": "n8n-nodes-base.httpRequest",
      "position": [400, -100]
    },
    {
      "id": "noop",
      "name": "OK (No-op)",
      "type": "n8n-nodes-base.noOp",
      "position": [400, 100]
    }
  ],
  "connections": {
    "Schedule": {
      "main": [[{"node": "Check Metric", "type": "main", "index": 0}]]
    },
    "Check Metric": {
      "main": [[{"node": "Above Threshold?", "type": "main", "index": 0}]]
    },
    "Above Threshold?": {
      "main": [
        [{"node": "Send Alert", "type": "main", "index": 0}],
        [{"node": "OK (No-op)", "type": "main", "index": 0}]
      ]
    }
  }
}
```

### Parallel Aggregation

```json
{
  "name": "SBQC - N1.X Multi-Service Health",
  "nodes": [
    {"id": "trigger", "name": "Trigger", "position": [-500, 0]},
    {"id": "check-a", "name": "Check Service A", "position": [-200, -150]},
    {"id": "check-b", "name": "Check Service B", "position": [-200, 0]},
    {"id": "check-c", "name": "Check Service C", "position": [-200, 150]},
    {
      "parameters": {
        "mode": "combine",
        "combineBy": "combineAll"
      },
      "id": "merge",
      "name": "Merge Results",
      "type": "n8n-nodes-base.merge",
      "position": [100, 0]
    },
    {
      "parameters": {
        "jsCode": "const results = $input.all();\nconst allHealthy = results.every(r => r.json.status === 'ok');\nreturn [{\n  json: {\n    timestamp: new Date().toISOString(),\n    overall: allHealthy ? 'healthy' : 'degraded',\n    services: results.map(r => r.json)\n  }\n}];"
      },
      "id": "aggregate",
      "name": "Aggregate Status",
      "type": "n8n-nodes-base.code",
      "position": [350, 0]
    }
  ],
  "connections": {
    "Trigger": {
      "main": [[
        {"node": "Check Service A", "type": "main", "index": 0},
        {"node": "Check Service B", "type": "main", "index": 0},
        {"node": "Check Service C", "type": "main", "index": 0}
      ]]
    },
    "Check Service A": {
      "main": [[{"node": "Merge Results", "type": "main", "index": 0}]]
    },
    "Check Service B": {
      "main": [[{"node": "Merge Results", "type": "main", "index": 1}]]
    },
    "Check Service C": {
      "main": [[{"node": "Merge Results", "type": "main", "index": 2}]]
    },
    "Merge Results": {
      "main": [[{"node": "Aggregate Status", "type": "main", "index": 0}]]
    }
  }
}
```

---

## Code Node Patterns

### Access Input Data

```javascript
// Single input
const data = $input.first().json;

// All inputs
const allData = $input.all();

// Specific node output
const healthCheck = $('Check Health').first().json;

// Multiple items
const items = $items();
```

### Safe Data Access

```javascript
function safeGet(nodeName) {
  try {
    const items = $items(nodeName);
    return items && items[0] ? items[0].json : null;
  } catch (e) {
    return null;
  }
}

const data = safeGet('Some Node');
if (!data) {
  return [{ json: { error: 'No data available' } }];
}
```

### Array Processing

```javascript
const items = $input.all();

const results = items.map(item => {
  const data = item.json;
  return {
    json: {
      id: data.id,
      processed: true,
      timestamp: new Date().toISOString()
    }
  };
});

return results;
```

### Filtering

```javascript
const items = $input.all();

const filtered = items.filter(item => {
  return item.json.status === 'active' && item.json.score > 0.7;
});

return filtered;
```

### Aggregation

```javascript
const items = $input.all();

const total = items.reduce((sum, item) => {
  return sum + (item.json.value || 0);
}, 0);

return [{
  json: {
    count: items.length,
    total: total,
    average: total / items.length
  }
}];
```

---

## Common Mistakes to Avoid

### ❌ Wrong: Using node ID in connections
```json
"connections": {
  "abc-123": {  // Don't use ID
    "main": [[{"node": "def-456"}]]  // Don't use ID
  }
}
```

### ✅ Correct: Using node name
```json
"connections": {
  "Check Health": {  // Use name
    "main": [[{"node": "Log Result"}]]  // Use name
  }
}
```

### ❌ Wrong: Missing webhookId
```json
{
  "type": "n8n-nodes-base.webhook",
  "parameters": {
    "path": "my-webhook"
  }
  // Missing webhookId property!
}
```

### ✅ Correct: Including webhookId
```json
{
  "type": "n8n-nodes-base.webhook",
  "parameters": {
    "path": "my-webhook"
  },
  "webhookId": "my-webhook"
}
```

### ❌ Wrong: Unquoted expressions
```json
{
  "jsonBody": "{ \"key\": $json.value }"  // Will fail
}
```

### ✅ Correct: n8n expression syntax
```json
{
  "jsonBody": "={{ { \"key\": $json.value } }}"  // Correct
}
```

### ❌ Wrong: No error handling
```json
{
  "type": "n8n-nodes-base.httpRequest",
  "parameters": {
    "url": "http://api.example.com"
  }
  // Will stop workflow on failure
}
```

### ✅ Correct: With error handling
```json
{
  "type": "n8n-nodes-base.httpRequest",
  "parameters": {
    "url": "http://api.example.com"
  },
  "continueOnFail": true
}
```

---

## Testing Workflows

### Import via n8n UI
1. Open n8n at http://192.168.2.199:5678
2. Click "+" → "Import from File"
3. Paste JSON or upload file
4. Click "Import"

### Import via API
```bash
curl -X POST http://192.168.2.199:5678/api/v1/workflows \
  -H "Content-Type: application/json" \
  -d @workflow.json
```

### Manual Trigger via Webhook
```bash
curl -X POST http://192.168.2.199:5678/webhook/sbqc-n1-1-test \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

### View Execution History
```bash
# Get workflow executions
curl -X GET http://192.168.2.199:5678/api/v1/executions \
  -H "Content-Type: application/json"
```

---

## Resources

- **AgentC Workflows**: `/home/yb/codes/AgentX/AgentC/*.json`
- **Persona System**: `/home/yb/codes/AgentX/personas/README.md`
- **n8n Docs**: https://docs.n8n.io/
- **SBQC Stack**: DataAPI, AgentX, MongoDB, Ollama, n8n

---

*Last updated: 2026-01-02*
*Maintained by: SBQC Workflow Architect (N6.1)*
