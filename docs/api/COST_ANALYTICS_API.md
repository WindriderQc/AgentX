# Cost Analytics API Reference

Quick reference for cost-related analytics endpoints in AgentX.

---

## Endpoints Overview

| Endpoint | Method | Purpose | New in Phase 4 |
|----------|--------|---------|----------------|
| `/api/analytics/stats` | GET | General stats with cost data | Updated |
| `/api/analytics/usage` | GET | Usage metrics with cost breakdown | Updated |
| `/api/analytics/costs` | GET | Dedicated cost analytics | ✅ NEW |

---

## GET /api/analytics/stats

**Purpose:** General usage and performance statistics with cost data.

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from` | ISO date | 7 days ago | Start date |
| `to` | ISO date | now | End date |
| `groupBy` | string | 'model' | Grouping dimension: 'model' or 'day' |

### Example Request

```bash
curl "http://localhost:3080/api/analytics/stats?groupBy=model&from=2025-12-25"
```

### Example Response

```json
{
  "status": "success",
  "data": {
    "from": "2025-12-25T00:00:00.000Z",
    "to": "2026-01-01T16:52:41.123Z",
    "currency": "USD",
    "totals": {
      "promptTokens": 150000,
      "completionTokens": 50000,
      "totalTokens": 200000,
      "durationSec": 120.5,
      "messages": 100,
      "totalCost": 0.025000,
      "avgDurationSec": 1.205,
      "avgCostPerMessage": 0.000250,
      "costPerThousandTokens": 0.000125
    },
    "breakdown": [
      {
        "key": "llama3",
        "messageCount": 60,
        "usage": {
          "promptTokens": 90000,
          "completionTokens": 30000,
          "totalTokens": 120000
        },
        "performance": {
          "totalDurationSec": 72.3,
          "avgDurationSec": 1.205,
          "avgTokensPerSecond": 100.5
        },
        "cost": {
          "totalCost": 0.015000,
          "promptTokenCost": 0.009000,
          "completionTokenCost": 0.006000,
          "avgCostPerMessage": 0.000250,
          "costPerThousandTokens": 0.000125
        }
      },
      {
        "key": "qwen2",
        "messageCount": 40,
        "usage": {
          "promptTokens": 60000,
          "completionTokens": 20000,
          "totalTokens": 80000
        },
        "performance": {
          "totalDurationSec": 48.2,
          "avgDurationSec": 1.205,
          "avgTokensPerSecond": 98.3
        },
        "cost": {
          "totalCost": 0.010000,
          "promptTokenCost": 0.006000,
          "completionTokenCost": 0.004000,
          "avgCostPerMessage": 0.000250,
          "costPerThousandTokens": 0.000125
        }
      }
    ]
  }
}
```

### Cost Fields Explained

**In `totals`:**
- `totalCost` - Sum of all message costs
- `avgCostPerMessage` - Total cost divided by message count
- `costPerThousandTokens` - Cost per 1,000 tokens (useful for comparing models)

**In `breakdown[].cost`:**
- `totalCost` - Total cost for this group
- `promptTokenCost` - Cost from prompt tokens
- `completionTokenCost` - Cost from completion tokens
- `avgCostPerMessage` - Average cost per message in this group
- `costPerThousandTokens` - Cost per 1k tokens for this group

---

## GET /api/analytics/usage

**Purpose:** Conversation and message counts with cost breakdown.

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from` | ISO date | 7 days ago | Start date |
| `to` | ISO date | now | End date |
| `groupBy` | string | none | Grouping: 'model', 'promptVersion', or 'day' |

### Example Request

```bash
curl "http://localhost:3080/api/analytics/usage?groupBy=model"
```

### Example Response

```json
{
  "status": "success",
  "data": {
    "from": "2025-12-25T00:00:00.000Z",
    "to": "2026-01-01T16:52:41.123Z",
    "currency": "USD",
    "totalConversations": 25,
    "totalMessages": 100,
    "breakdown": [
      {
        "model": "llama3",
        "conversations": 15,
        "messages": 60,
        "totalCost": 0.015000,
        "avgCostPerConversation": 0.001000
      },
      {
        "model": "qwen2",
        "conversations": 10,
        "messages": 40,
        "totalCost": 0.010000,
        "avgCostPerConversation": 0.001000
      }
    ]
  }
}
```

### Cost Fields Explained

- `totalCost` - Sum of all conversation costs in this group
- `avgCostPerConversation` - Average cost per conversation (totalCost / conversations)

---

## GET /api/analytics/costs (NEW)

**Purpose:** Dedicated cost analytics endpoint with detailed breakdowns.

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from` | ISO date | 7 days ago | Start date |
| `to` | ISO date | now | End date |
| `groupBy` | string | 'model' | Grouping: 'model', 'day', or 'promptVersion' |
| `minCost` | number | 0 | Filter out entries below this cost |

### Example Requests

**By Model (default):**
```bash
curl "http://localhost:3080/api/analytics/costs"
```

**By Day:**
```bash
curl "http://localhost:3080/api/analytics/costs?groupBy=day&from=2025-12-01"
```

**By Prompt Version:**
```bash
curl "http://localhost:3080/api/analytics/costs?groupBy=promptVersion"
```

**With Minimum Cost Filter:**
```bash
curl "http://localhost:3080/api/analytics/costs?minCost=0.01"
```

### Example Response (groupBy=model)

```json
{
  "status": "success",
  "data": {
    "from": "2025-12-25T00:00:00.000Z",
    "to": "2026-01-01T16:52:41.123Z",
    "currency": "USD",
    "groupBy": "model",
    "minCost": 0,
    "summary": {
      "totalCost": 0.025000,
      "totalMessages": 100,
      "totalConversations": 25,
      "totalTokens": 200000,
      "promptTokenCost": 0.015000,
      "completionTokenCost": 0.010000,
      "avgCostPerMessage": 0.000250,
      "avgCostPerConversation": 0.001000,
      "costPer1kTokens": 0.000125
    },
    "breakdown": [
      {
        "key": "llama3",
        "messageCount": 60,
        "conversationCount": 15,
        "tokens": {
          "prompt": 120000,
          "completion": 40000,
          "total": 160000
        },
        "cost": {
          "total": 0.020000,
          "prompt": 0.012000,
          "completion": 0.008000,
          "avgPerMessage": 0.000333,
          "avgPerConversation": 0.001333,
          "per1kTokens": 0.000125
        }
      },
      {
        "key": "qwen2",
        "messageCount": 40,
        "conversationCount": 10,
        "tokens": {
          "prompt": 60000,
          "completion": 20000,
          "total": 80000
        },
        "cost": {
          "total": 0.005000,
          "prompt": 0.003000,
          "completion": 0.002000,
          "avgPerMessage": 0.000125,
          "avgPerConversation": 0.000500,
          "per1kTokens": 0.000063
        }
      }
    ]
  }
}
```

### Example Response (groupBy=day)

```json
{
  "status": "success",
  "data": {
    "from": "2025-12-25T00:00:00.000Z",
    "to": "2026-01-01T16:52:41.123Z",
    "currency": "USD",
    "groupBy": "day",
    "minCost": 0,
    "summary": {
      "totalCost": 0.025000,
      "totalMessages": 100,
      "totalConversations": 25,
      "totalTokens": 200000,
      "promptTokenCost": 0.015000,
      "completionTokenCost": 0.010000,
      "avgCostPerMessage": 0.000250,
      "avgCostPerConversation": 0.001000,
      "costPer1kTokens": 0.000125
    },
    "breakdown": [
      {
        "key": "2025-12-31",
        "messageCount": 50,
        "conversationCount": 12,
        "tokens": { "prompt": 100000, "completion": 33000, "total": 133000 },
        "cost": {
          "total": 0.013300,
          "prompt": 0.010000,
          "completion": 0.003300,
          "avgPerMessage": 0.000266,
          "avgPerConversation": 0.001108,
          "per1kTokens": 0.000100
        }
      },
      {
        "key": "2025-12-30",
        "messageCount": 50,
        "conversationCount": 13,
        "tokens": { "prompt": 100000, "completion": 17000, "total": 117000 },
        "cost": {
          "total": 0.011700,
          "prompt": 0.010000,
          "completion": 0.001700,
          "avgPerMessage": 0.000234,
          "avgPerConversation": 0.000900,
          "per1kTokens": 0.000100
        }
      }
    ]
  }
}
```

### Example Response (groupBy=promptVersion)

```json
{
  "status": "success",
  "data": {
    "from": "2025-12-25T00:00:00.000Z",
    "to": "2026-01-01T16:52:41.123Z",
    "currency": "USD",
    "groupBy": "promptVersion",
    "minCost": 0,
    "summary": {
      "totalCost": 0.025000,
      "totalMessages": 100,
      "totalConversations": 25,
      "totalTokens": 200000,
      "promptTokenCost": 0.015000,
      "completionTokenCost": 0.010000,
      "avgCostPerMessage": 0.000250,
      "avgCostPerConversation": 0.001000,
      "costPer1kTokens": 0.000125
    },
    "breakdown": [
      {
        "key": { "name": "default_chat", "version": 2 },
        "messageCount": 70,
        "conversationCount": 18,
        "tokens": { "prompt": 140000, "completion": 47000, "total": 187000 },
        "cost": {
          "total": 0.018700,
          "prompt": 0.014000,
          "completion": 0.004700,
          "avgPerMessage": 0.000267,
          "avgPerConversation": 0.001039,
          "per1kTokens": 0.000100
        }
      },
      {
        "key": { "name": "default_chat", "version": 1 },
        "messageCount": 30,
        "conversationCount": 7,
        "tokens": { "prompt": 60000, "completion": 20000, "total": 80000 },
        "cost": {
          "total": 0.008000,
          "prompt": 0.006000,
          "completion": 0.002000,
          "avgPerMessage": 0.000267,
          "avgPerConversation": 0.001143,
          "per1kTokens": 0.000100
        }
      }
    ]
  }
}
```

### Cost Fields Explained

**In `summary`:**
- `totalCost` - Sum of all costs across all groups
- `promptTokenCost` - Total cost from prompt tokens
- `completionTokenCost` - Total cost from completion tokens
- `avgCostPerMessage` - Average cost per message
- `avgCostPerConversation` - Average cost per conversation
- `costPer1kTokens` - Cost per 1,000 tokens (useful metric for comparing efficiency)

**In `breakdown[].cost`:**
- `total` - Total cost for this group
- `prompt` - Cost from prompt tokens
- `completion` - Cost from completion tokens
- `avgPerMessage` - Average cost per message in this group
- `avgPerConversation` - Average cost per conversation in this group
- `per1kTokens` - Cost per 1k tokens for this group

---

## Common Use Cases

### 1. Compare Model Costs

```bash
# Get cost breakdown by model
curl "http://localhost:3080/api/analytics/costs?groupBy=model"
```

**Use for:** Identifying which models are most cost-effective.

### 2. Track Daily Spending

```bash
# Get daily cost trends
curl "http://localhost:3080/api/analytics/costs?groupBy=day&from=2025-12-01"
```

**Use for:** Monitoring daily spending patterns and detecting anomalies.

### 3. Evaluate Prompt Versions

```bash
# Get cost by prompt version
curl "http://localhost:3080/api/analytics/costs?groupBy=promptVersion"
```

**Use for:** Determining if prompt improvements reduce token usage and cost.

### 4. Filter High-Cost Items

```bash
# Only show items costing more than $0.01
curl "http://localhost:3080/api/analytics/costs?minCost=0.01&groupBy=model"
```

**Use for:** Focusing on significant cost drivers.

### 5. Monthly Reports

```bash
# Get last 30 days of costs
curl "http://localhost:3080/api/analytics/costs?from=$(date -d '30 days ago' -I)"
```

**Use for:** Generating monthly cost reports.

---

## Cost Calculation Details

### Token Pricing

Costs are calculated based on token usage and pricing configuration:

```
promptTokenCost = (promptTokens / 1,000,000) × promptCostPer1M
completionTokenCost = (completionTokens / 1,000,000) × completionCostPer1M
totalCost = promptTokenCost + completionTokenCost
```

### Pricing Sources (Priority Order)

1. **Model-specific environment variable** (e.g., `OLLAMA_LLAMA3_PROMPT_COST_PER_1M`)
2. **Provider default environment variable** (e.g., `OLLAMA_DEFAULT_PROMPT_COST_PER_1M`)
3. **Database pricing configuration** (from `ModelPricingConfig` collection)
4. **Global fallback** (`DEFAULT_FALLBACK_PROMPT_COST_PER_1M`)

### When Costs are Zero

Cost fields will be `0` if:
- `COST_TRACKING_ENABLED=false` in environment
- No pricing configured for the model
- Conversation was created before Phase 3 implementation
- Message doesn't have token stats (shouldn't happen for assistant messages)

---

## Error Handling

### Common Errors

**Invalid Date Range:**
```json
{
  "status": "error",
  "message": "Invalid date format"
}
```

**Database Connection Error:**
```json
{
  "status": "error",
  "message": "Database connection failed"
}
```

### Graceful Degradation

- Missing cost data returns `0` instead of errors
- Invalid groupBy parameter defaults to 'model'
- Invalid minCost parameter defaults to 0

---

## Performance Considerations

### Indexes Used

The endpoints leverage these MongoDB indexes:
- `{ createdAt: 1 }` - Date range filtering
- `{ model: 1, 'totalCost.sum': 1 }` - Model cost queries
- `{ 'messages.cost.totalCost': 1 }` - Message cost aggregation

### Query Optimization Tips

1. **Use date ranges:** Smaller date ranges = faster queries
2. **Filter with minCost:** Reduces result set size
3. **Limit groupBy dimensions:** 'model' is faster than 'day' for large datasets
4. **Cache results:** Consider caching for frequently accessed date ranges

---

## Integration Examples

### JavaScript/Node.js

```javascript
const axios = require('axios');

async function getModelCosts() {
  const response = await axios.get('http://localhost:3080/api/analytics/costs', {
    params: {
      groupBy: 'model',
      from: '2025-12-01'
    }
  });

  return response.data.data.breakdown.map(item => ({
    model: item.key,
    totalCost: item.cost.total,
    avgPerMessage: item.cost.avgPerMessage
  }));
}
```

### Python

```python
import requests
from datetime import datetime, timedelta

def get_daily_costs(days=7):
    end_date = datetime.now()
    start_date = end_date - timedelta(days=days)

    response = requests.get('http://localhost:3080/api/analytics/costs', params={
        'groupBy': 'day',
        'from': start_date.isoformat(),
        'to': end_date.isoformat()
    })

    return response.json()['data']
```

### cURL with jq

```bash
# Get top 3 most expensive models
curl -s "http://localhost:3080/api/analytics/costs?groupBy=model" \
  | jq '.data.breakdown[:3] | .[] | {model: .key, cost: .cost.total}'
```

---

## Related Documentation

- **Implementation Guide:** `/docs/COST_TRACKING_IMPLEMENTATION_GUIDE.md`
- **Design Document:** `/docs/COST_TRACKING_DESIGN.md`
- **Phase 4 Report:** `/docs/PHASE4_COST_ANALYTICS_IMPLEMENTATION.md`
- **Schema Reference:** `/docs/COST_TRACKING_SCHEMA.md`
- **General Analytics API:** `/docs/api/reference.md`

---

## Support

For issues or questions:
1. Check if `COST_TRACKING_ENABLED=true` in your `.env`
2. Verify pricing is configured (environment variables or database)
3. Review logs for cost calculation errors
4. Ensure conversations have token stats (required for cost calculation)
