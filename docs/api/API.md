# SBQC API Documentation

## Overview

The SBQC (System Brain Query Control) API provides webhook endpoints for interacting with the AgentX AI system through n8n workflow automation.

**Base URL:** `https://n8n.specialblend.icu`

---

## N3.2 - External AI Gateway

The main entry point for AI conversations. Provides a clean, validated interface to AgentX.

### Endpoint

```
POST /webhook/sbqc-ai-query
```

### Request

**Headers:**
```
Content-Type: application/json
```

**Body Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | string | ✅ Yes | - | The question or prompt for the AI |
| `model` | string | No | `qwen2.5:7b-instruct-q4_0` | Which AI model to use |
| `useRag` | boolean | No | `true` | Enable RAG (Retrieval-Augmented Generation) |
| `persona` | string | No | `null` | Which persona/prompt template to use |
| `conversationId` | string | No | `null` | Continue an existing conversation |
| `autoRoute` | boolean | No | `true` | Let AgentX choose the best model |
| `taskType` | string | No | `null` | Task type hint for routing (e.g., "code", "chat") |

**Example Request:**

```bash
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is the capital of France?",
    "model": "qwen2.5:7b-instruct-q4_0",
    "useRag": false
  }'
```

### Response

**Success Response (200 OK):**

```json
{
  "success": true,
  "response": "The capital of France is Paris.",
  "model": "qwen2.5:7b-instruct-q4_0",
  "conversationId": "69587676b64e8e4f3fd291e7",
  "ragUsed": false,
  "tokens": {
    "promptTokens": 26,
    "completionTokens": 11,
    "totalTokens": 37
  },
  "latency": 327352649,
  "timestamp": "2026-01-03T01:52:54.426Z"
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the request succeeded |
| `response` | string | The AI's response text |
| `model` | string | Which model was used |
| `conversationId` | string | ID for continuing the conversation |
| `ragUsed` | boolean | Whether RAG was activated |
| `tokens` | object | Token usage statistics |
| `tokens.promptTokens` | number | Tokens in the prompt |
| `tokens.completionTokens` | number | Tokens in the response |
| `tokens.totalTokens` | number | Total tokens used |
| `latency` | number | Response time in nanoseconds |
| `timestamp` | string | ISO 8601 timestamp |

**Error Response (400 Bad Request):**

```json
{
  "success": false,
  "error": "Missing required field: message",
  "status": 400,
  "timestamp": "2026-01-03T01:52:54.426Z"
}
```

---

## N0.0 - Deployment Test

Health check endpoint to verify deployment is working.

### Endpoint

```
GET /webhook/test-deployment
```

### Response

```json
{
  "status": "success",
  "workflow": "N0.0 - Deployment Test",
  "version": "2.2.0",
  "deployed_at": "2026-01-03T02:00:00.000Z",
  "message": "Deployment test successful! All workflows operational.",
  "environment": {
    "n8n": "https://n8n.specialblend.icu",
    "n8n_lan": "http://192.168.2.199:5678",
    "dataapi": "http://<dataapi-host>:3003",
    "agentx": "http://<agentx-host>:3080"
  },
  "workflows": {
    "production": [
      {
        "id": "N1.1",
        "name": "System Health Check",
        "status": "active",
        "schedule": "*/5 * * * *"
      }
      // ... more workflows
    ]
  }
}
```

---

## N0.1 - Health Dashboard

Comprehensive health check for all SBQC components.

### Endpoint

```
GET /webhook/sbqc-health
```

### Response

```json
{
  "timestamp": "2026-01-03T02:31:02.858Z",
  "version": "1.0.0",
  "overall_status": "healthy",
  "checks": [
    {
      "component": "n8n_workflows",
      "status": "pass",
      "message": "9 workflows expected",
      "details": [...]
    },
    {
      "component": "agentx_api",
      "status": "pass",
      "message": "AgentX API reachable",
      "endpoint": "http://<agentx-host>:3080"
    }
  ],
  "summary": {
    "total_checks": 4,
    "passed": 4,
    "failed": 0,
    "health_percentage": 100
  }
}
```

---

## N5.1 - Feedback Analysis

Trigger manual feedback analysis (normally runs weekly).

### Endpoint

```
GET /webhook/sbqc-n5-1-feedback-analysis
```

### Response

```json
{
  "message": "Workflow was started"
}
```

**Note:** This is a long-running workflow (60-120s). Returns immediately while processing in background. Results are logged to DataAPI and admin is notified if issues are found.

---

## Error Codes

| Status Code | Description |
|-------------|-------------|
| 200 | Success |
| 400 | Bad Request - Invalid parameters |
| 404 | Not Found - Webhook not registered or workflow inactive |
| 500 | Internal Server Error - Workflow execution failed |
| 503 | Service Unavailable - AgentX or DataAPI unreachable |

---

## Rate Limiting

Currently no rate limiting is enforced. For production use, consider implementing rate limiting at the network level or adding it to the N3.2 workflow.

**Recommended limits:**
- N3.2 AI Gateway: 60 requests per minute per IP
- Health endpoints: 600 requests per minute
- Feedback analysis: 10 requests per hour

---

## Authentication

**Current:** No authentication required (public webhooks)

**For production:** Consider adding:
1. API Key authentication via `X-API-Key` header
2. IP whitelisting
3. OAuth 2.0 for user-specific access
4. Rate limiting per key

---

## Best Practices

### 1. Handle Timeouts

AI responses can take 2-30 seconds depending on model and task complexity. Set appropriate client timeouts (60s recommended).

```javascript
fetch('https://n8n.specialblend.icu/webhook/sbqc-ai-query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: "Hello" }),
  signal: AbortSignal.timeout(60000) // 60 second timeout
})
```

### 2. Reuse Conversation IDs

For multi-turn conversations, pass the `conversationId` from previous responses:

```javascript
const firstResponse = await chat("What's 2+2?");
const followUp = await chat("What's that times 3?", {
  conversationId: firstResponse.conversationId
});
```

### 3. Enable RAG for Context-Aware Responses

Use `useRag: true` (default) when you want the AI to search your document store for relevant context.

### 4. Monitor Health

Regularly poll the health endpoint to detect issues early:

```bash
# Check health every minute
watch -n 60 'curl -s https://n8n.specialblend.icu/webhook/sbqc-health | jq .overall_status'
```

---

## OpenAPI Specification

See [openapi.yaml](./openapi.yaml) for the full OpenAPI 3.0 specification suitable for code generation and API clients.

---

## Support

For issues or questions:
- Check the [WORKFLOW-GUIDE.md](../AgentC/WORKFLOW-GUIDE.md) for troubleshooting
- Review workflow execution logs in n8n UI
- Check AgentX and DataAPI health endpoints
