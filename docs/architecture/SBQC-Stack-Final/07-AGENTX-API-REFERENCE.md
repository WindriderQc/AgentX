# AgentX API Reference

**Version:** 1.1
**Base URL:** `http://192.168.2.33:3080`
**Last Updated:** January 3, 2026

> **Quick Links:** [Chat](#chat--conversations) • [Analytics](#analytics--metrics) • [Performance](#performance-monitoring) • [RAG](#rag-retrieval-augmented-generation) • [Voice](#voice-io) • [Models](#model-management) • [n8n Integration](#n8n-integration)

---

## Authentication

Most endpoints use **session-based auth** or **optional auth** (works with or without login).

Some administrative endpoints require **API key authentication**:
```http
x-api-key: your-api-key-here
```

---

## Chat & Conversations

### `POST /api/chat`

Send a message to the AI with optional RAG search, model routing, and memory injection.

**Auth:** Optional (works with or without user session)

**Request Body:**
```json
{
  "message": "What is the meaning of life?",
  "model": "qwen2.5:7b-instruct-q4_0",
  "useRag": true,
  "autoRoute": true,
  "taskType": "general",
  "conversationId": "abc123",
  "persona": "sbqc_ops"
}
```

**Parameters:**
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `message` | string | ✅ Yes | - | User's message |
| `model` | string | No | `qwen2.5:7b-instruct-q4_0` | Ollama model to use |
| `useRag` | boolean | No | `false` | Search knowledge base before answering |
| `autoRoute` | boolean | No | `false` | Auto-route to specialist models |
| `taskType` | string | No | `general` | `code`, `reasoning`, `creative`, `general` |
| `conversationId` | string | No | (new) | Continue existing conversation |
| `persona` | string | No | `null` | System persona (`sbqc_ops`, `datalake_janitor`, etc.) |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "response": "The meaning of life is...",
    "conversationId": "abc123",
    "messageId": "msg_xyz",
    "model": "qwen2.5:7b-instruct-q4_0",
    "tokens": { "prompt": 45, "completion": 120 },
    "latency": 1234,
    "ragUsed": true,
    "routedTo": "front-door"
  }
}
```

---

### `GET /api/history/`

List all conversations for current user.

**Auth:** Optional

**Query Params:**
- `limit` (number): Max conversations to return (default: 50)

**Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "id": "conv_abc123",
      "title": "Discussion about RAG",
      "date": "2025-12-31T10:30:00Z",
      "model": "qwen2.5:7b-instruct-q4_0",
      "messageCount": 12
    }
  ]
}
```

---

### `GET /api/history/:id`

Get full conversation with all messages.

**Auth:** Optional (user must own conversation)

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "conv_abc123",
    "title": "Discussion about RAG",
    "userId": "default",
    "model": "qwen2.5:7b-instruct-q4_0",
    "promptName": "agentx-main",
    "promptVersion": "v1.2.0",
    "messages": [
      {
        "role": "user",
        "content": "What is RAG?",
        "timestamp": "2025-12-31T10:30:00Z"
      },
      {
        "role": "assistant",
        "content": "RAG stands for Retrieval Augmented Generation...",
        "timestamp": "2025-12-31T10:30:05Z"
      }
    ],
    "createdAt": "2025-12-31T10:30:00Z",
    "updatedAt": "2025-12-31T10:35:00Z"
  }
}
```

---

### `PATCH /api/history/conversations/:id`

Update conversation title.

**Auth:** Optional (user must own conversation)

**Request Body:**
```json
{
  "title": "New conversation title"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "message": "Conversation updated"
}
```

---

## User Profile & Feedback

### `GET /api/profile`

Get current user's profile and preferences.

**Auth:** Optional

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "userId": "default",
    "name": "Yanik",
    "role": "Developer",
    "language": "en",
    "responseStyle": "balanced",
    "codePreference": "code-heavy",
    "customPreferences": {
      "theme": "dark"
    }
  }
}
```

---

### `POST /api/profile`

Create or update user profile.

**Auth:** Optional

**Request Body:**
```json
{
  "name": "Yanik",
  "role": "Developer",
  "language": "en",
  "responseStyle": "concise",
  "codePreference": "code-heavy",
  "customPreferences": {}
}
```

---

### `POST /api/feedback`

Submit feedback (rating + comment) for a message.

**Auth:** None required

**Request Body:**
```json
{
  "messageId": "msg_xyz",
  "rating": 1,
  "comment": "Very helpful!"
}
```

**Parameters:**
- `rating`: `-1` (👎), `0` (neutral), `1` (👍)

---

## Analytics & Metrics

### `GET /api/analytics/usage`

Get conversation and message usage statistics.

**Auth:** Required (API key or session)

**Query Params:**
- `from` (ISO date): Start date (default: 7 days ago)
- `to` (ISO date): End date (default: now)
- `groupBy` (string): `model`, `promptVersion`, or `day`

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "from": "2025-12-24T00:00:00Z",
    "to": "2025-12-31T00:00:00Z",
    "totalConversations": 145,
    "totalMessages": 892,
    "breakdown": [
      {
        "model": "qwen2.5:7b-instruct-q4_0",
        "conversations": 120,
        "messages": 750
      }
    ]
  }
}
```

---

### `GET /api/analytics/feedback`

Get feedback metrics with positive/negative rates.

**Auth:** Required

**Query Params:** Same as `/usage`

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "totalFeedback": 234,
    "positive": 198,
    "negative": 36,
    "positiveRate": 0.846,
    "breakdown": [
      {
        "promptName": "agentx-main",
        "promptVersion": "v1.2.0",
        "positive": 150,
        "negative": 20,
        "positiveRate": 0.882
      }
    ]
  }
}
```

---

### `GET /api/analytics/rag/stats`

Get RAG performance statistics.

**Auth:** Required

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "totalQueries": 456,
    "avgLatency": 234,
    "documentsIndexed": 1234,
    "vectorStoreSize": "4.5 GB"
  }
}
```

---

## RAG (Retrieval Augmented Generation)

### `POST /api/rag/ingest`

Ingest documents into vector store for RAG search.

**Auth:** None required (can be called by n8n)

**Request Body:**
```json
{
  "documents": [
    {
      "path": "/mnt/datalake/RAG/doc1.txt",
      "content": "Full document text here...",
      "metadata": {
        "source": "n8n-workflow",
        "type": "text/plain"
      }
    }
  ]
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "ingested": 1,
    "failed": 0,
    "totalChunks": 45
  }
}
```

---

### `POST /api/rag/search`

Search the RAG knowledge base (test endpoint).

**Auth:** None required

**Request Body:**
```json
{
  "query": "How does RAG work?",
  "limit": 5
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "results": [
      {
        "content": "RAG combines retrieval with generation...",
        "score": 0.92,
        "metadata": { "source": "doc1.txt" }
      }
    ]
  }
}
```

---

### `GET /api/rag/documents`

List all documents ingested in vector store.

**Auth:** None required

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "documents": [
      {
        "id": "doc_abc123",
        "path": "/mnt/datalake/RAG/doc1.txt",
        "chunks": 45,
        "ingestedAt": "2025-12-31T10:00:00Z"
      }
    ],
    "total": 1234
  }
}
```

---

## Model Management

### `GET /api/models/routing`

Get current model routing configuration and available models.

**Auth:** None required

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "frontDoor": {
      "model": "qwen2.5:7b-instruct-q4_0",
      "host": "192.168.2.99:11434",
      "available": true
    },
    "specialists": {
      "code": {
        "model": "qwen2.5-coder:14b",
        "host": "192.168.2.12:11434",
        "available": true
      },
      "reasoning": {
        "model": "deepseek-r1:8b",
        "host": "192.168.2.12:11434",
        "available": true
      },
      "creative": {
        "model": "gemma3:12b-it-qat",
        "host": "192.168.2.12:11434",
        "available": false
      }
    }
  }
}
```

---

### `POST /api/models/classify`

Preview query classification (for testing routing logic).

**Auth:** None required

**Request Body:**
```json
{
  "message": "Write a Python function to sort a list"
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "taskType": "code",
    "confidence": 0.95,
    "suggestedModel": "qwen2.5-coder:14b"
  }
}
```

---

## Prompt Management

### `GET /api/prompts/`

List all prompt configurations.

**Auth:** Required

**Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "name": "agentx-main",
      "versions": [
        {
          "version": "v1.2.0",
          "active": true,
          "weight": 0.8,
          "content": "You are a helpful AI assistant..."
        }
      ]
    }
  ]
}
```

---

### `GET /api/prompts/:name`

Get specific prompt configuration.

**Auth:** Required

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "name": "agentx-main",
    "currentVersion": "v1.2.0",
    "versions": [...]
  }
}
```

---

### `POST /api/prompts/`

Create new prompt configuration.

**Auth:** Required

**Request Body:**
```json
{
  "name": "my-custom-prompt",
  "version": "v1.0.0",
  "content": "You are a specialized assistant...",
  "active": true
}
```

---

### `POST /api/prompts/:name/ab-test`

Configure A/B test for prompt versions.

**Auth:** Required

**Request Body:**
```json
{
  "versions": [
    { "version": "v1.0.0", "weight": 0.5 },
    { "version": "v2.0.0", "weight": 0.5 }
  ]
}
```

---

## Dataset Export

### `GET /api/dataset/conversations`

Export conversations for training data.

**Auth:** Required (API key)

**Query Params:**
- `format` (string): `json` or `jsonl`
- `limit` (number): Max conversations (default: 1000)

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "conversations": [...],
    "total": 1234,
    "format": "json"
  }
}
```

---

### `GET /api/dataset/prompts`

List all prompt versions for export.

**Auth:** Required (API key)

---

### `POST /api/dataset/prompts`

Create new prompt version for dataset.

**Auth:** Required (API key)

---

## Voice I/O

### `GET /api/voice/health`

Check voice service status (Whisper + TTS).

**Auth:** None required

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "whisper": {
      "available": true,
      "backend": "openai-fallback"
    },
    "tts": {
      "available": true,
      "backend": "openai"
    }
  }
}
```

---

### `POST /api/voice/transcribe`

Convert audio to text (Speech-to-Text).

**Auth:** None required

**Request:** `multipart/form-data`
- `audio` (file): Audio file (mp3, wav, m4a, etc.)
- `language` (string, optional): Language code (e.g., `en`)

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "text": "Hello, how are you?",
    "language": "en",
    "duration": 2.5
  }
}
```

---

### `POST /api/voice/synthesize`

Convert text to audio (Text-to-Speech).

**Auth:** None required

**Request Body:**
```json
{
  "text": "Hello, world!",
  "voice": "alloy",
  "format": "mp3"
}
```

**Response (200 OK):**
- Binary audio file (Content-Type: audio/mpeg)

---

### `POST /api/voice/chat`

Voice chat endpoint (audio in, audio out).

**Auth:** Optional

**Request:** `multipart/form-data`
- `audio` (file): User's audio message
- `model` (string, optional): Model to use
- `conversationId` (string, optional): Continue conversation

**Response (200 OK):**
- Binary audio file with AI response

---

## n8n Integration

### `GET /api/n8n/diagnostic`

Connection test for n8n workflows.

**Auth:** Required (n8n API key)

**Response (200 OK):**
```json
{
  "status": "success",
  "message": "AgentX is online",
  "timestamp": "2025-12-31T10:00:00Z",
  "services": {
    "ollama": "online",
    "mongodb": "online",
    "qdrant": "online"
  }
}
```

---

### `GET /api/n8n/health`

Health check endpoint for monitoring.

**Auth:** Required (n8n API key)

**Response (200 OK):**
```json
{
  "status": "healthy",
  "uptime": 123456,
  "version": "1.0.0"
}
```

---

### `POST /api/n8n/rag/ingest`

Trigger RAG ingestion workflow.

**Auth:** Required (n8n API key)

**Request Body:**
```json
{
  "documents": [...],
  "source": "n8n-workflow-N2.3"
}
```

---

### `POST /api/n8n/chat/complete`

Trigger chat completion webhook.

**Auth:** Required (n8n API key)

---

### `POST /api/n8n/analytics`

Trigger analytics webhook.

**Auth:** Required (n8n API key)

---

### `POST /api/n8n/trigger/:webhookId`

Generic webhook trigger.

**Auth:** Required (n8n API key)

**URL Params:**
- `webhookId` (string): n8n webhook ID

---

### `POST /api/n8n/event/:eventType`

Event trigger for specific event types.

**Auth:** Required (n8n API key)

**URL Params:**
- `eventType` (string): Event type (`scan_complete`, `rag_ingest`, etc.)

---

## Error Responses

All endpoints follow consistent error format:

**400 Bad Request:**
```json
{
  "status": "error",
  "message": "Missing required field: message"
}
```

**401 Unauthorized:**
```json
{
  "status": "error",
  "message": "Authentication required"
}
```

**403 Forbidden:**
```json
{
  "status": "error",
  "message": "Access denied"
}
```

**404 Not Found:**
```json
{
  "status": "error",
  "message": "Resource not found"
}
```

**500 Internal Server Error:**
```json
{
  "status": "error",
  "message": "Internal server error",
  "details": "Error details..."
}
```

---

## Model Management

### `GET /api/custom-models`

List all registered custom models.

**Auth:** Optional

**Query Params:**
- `status` (string): Filter by status (`ready`, `deployed`, `training`, `failed`)
- `baseModel` (string): Filter by base model
- `tag` (string): Filter by tag

**Response (200 OK):**
```json
{
  "success": true,
  "count": 5,
  "models": [
    {
      "modelId": "my-custom-model:latest",
      "baseModel": "llama2:7b",
      "status": "deployed",
      "parameters": {
        "num_ctx": 4096,
        "num_gpu": 1
      }
    }
  ]
}
```

### `POST /api/custom-models`

Register a new custom model with optional tuning parameters.

**Auth:** Optional

**Request Body:**
```json
{
  "modelId": "my-tuned-model:v1",
  "displayName": "My Tuned Model",
  "baseModel": "llama2:7b",
  "modelfileContent": "FROM llama2:7b\nSYSTEM You are a helpful assistant.",
  "parameters": {
    "num_ctx": 8192,
    "num_gpu": 1,
    "num_thread": 8,
    "keep_alive": "5m"
  },
  "tags": ["production", "tuned"]
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "model": { ... }
}
```

### `POST /api/custom-models/:id/deploy`

Deploy a custom model to the Ollama instance. This compiles the Modelfile with the configured parameters.

**Auth:** Optional

**Request Body:**
```json
{
  "ollamaHost": "http://localhost:11434" // Optional override
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "deployment": { "status": "success" }
}
```

---

## Performance Monitoring

### `GET /api/performance/dashboard`

Get system health overview with key performance metrics.

**Auth:** Optional

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "system_status": "healthy",
    "avg_response_time": 150,
    "throughput": 12.5,
    "error_rate": 0.5,
    "uptime": 99.8,
    "p95_latency": 450,
    "last_load_test": {
      "name": "basic-load-20260103",
      "p95": 460,
      "rps_max": 25
    },
    "baseline_comparison": {
      "active_baseline": "v1.0-baseline",
      "regression_detected": false
    }
  }
}
```

### `GET /api/performance/load-tests`

List Artillery load test results history.

**Auth:** Optional

**Query Parameters:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 20 | Max results to return |
| `scenario` | string | - | Filter by scenario name |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "tests": [
      {
        "id": "507f1f77bcf86cd799439011",
        "name": "basic-load-20260103-153800",
        "scenario": "basic-load",
        "summary": {
          "duration": 180,
          "scenarios_completed": 1250,
          "error_rate": 0.4,
          "rps_mean": 12.5,
          "rps_max": 25
        },
        "latency": {
          "min": 45,
          "max": 2300,
          "median": 150,
          "p95": 460,
          "p99": 890
        },
        "timestamp": "2026-01-03T15:38:00Z"
      }
    ],
    "total": 15
  }
}
```

### `POST /api/performance/load-tests`

Import Artillery JSON report into the performance dashboard.

**Auth:** Optional

**Request Body:**
```json
{
  "name": "basic-load-20260103-153800",
  "scenario": "basic-load",
  "raw_report": {
    "aggregate": {
      "counters": { "vusers.completed": 1250 },
      "rates": { "http.request_rate": 12.5 },
      "latency": {
        "min": 45,
        "max": 2300,
        "median": 150,
        "p95": 460,
        "p99": 890
      }
    }
  }
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "name": "basic-load-20260103-153800",
    "parsed": true,
    "summary": {
      "duration": 180,
      "scenarios_completed": 1250,
      "error_rate": 0.4
    }
  }
}
```

### `GET /api/performance/latency-trends`

Get time-series latency data for charting.

**Auth:** Optional

**Query Parameters:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | number | 24 | Time range (1, 6, 24, 168) |
| `endpoint` | string | - | Filter by endpoint path |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "trends": [
      {
        "timestamp": "2026-01-03T14:00:00Z",
        "p50": 120,
        "p95": 420,
        "p99": 850,
        "requests": 450
      }
    ],
    "period": "24h",
    "endpoint": null
  }
}
```

### `GET /api/performance/throughput`

Get requests per second trends over time.

**Auth:** Optional

**Query Parameters:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | number | 24 | Time range |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "trends": [
      {
        "timestamp": "2026-01-03T14:00:00Z",
        "rps": 12.5,
        "requests_total": 45000
      }
    ]
  }
}
```

### `GET /api/performance/percentiles`

Get latency percentile breakdown with histogram.

**Auth:** Optional

**Query Parameters:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | number | 24 | Time range |
| `endpoint` | string | - | Filter by endpoint |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "p50": 120,
    "p75": 250,
    "p90": 380,
    "p95": 450,
    "p99": 890,
    "p999": 1500,
    "histogram": [
      { "bucket": "0-100ms", "count": 5000 },
      { "bucket": "100-200ms", "count": 3000 },
      { "bucket": "200-500ms", "count": 1500 },
      { "bucket": "500-1000ms", "count": 400 },
      { "bucket": "1000ms+", "count": 100 }
    ]
  }
}
```

### `GET /api/performance/baselines`

List all performance baselines.

**Auth:** Optional

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "baselines": [
      {
        "id": "507f1f77bcf86cd799439012",
        "name": "v1.0-baseline",
        "description": "Production baseline",
        "active": true,
        "metrics": {
          "avg_response_time": 150,
          "p95_latency": 450,
          "error_rate": 0.5,
          "throughput_rps": 12.5
        },
        "created_at": "2026-01-03T10:00:00Z"
      }
    ],
    "active": {
      "id": "507f1f77bcf86cd799439012",
      "name": "v1.0-baseline"
    }
  }
}
```

### `POST /api/performance/baselines`

Create a new performance baseline.

**Auth:** Optional

**Request Body:**
```json
{
  "name": "v1.0-baseline",
  "description": "Production baseline",
  "metrics": {
    "avg_response_time": 150,
    "p95_latency": 450,
    "error_rate": 0.5,
    "throughput_rps": 12.5
  },
  "endpoints": [
    {
      "path": "/api/chat",
      "method": "POST",
      "avg_latency": 200,
      "p95_latency": 500
    }
  ],
  "activate": true
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "507f1f77bcf86cd799439012",
    "name": "v1.0-baseline",
    "active": true,
    "created_at": "2026-01-03T10:00:00Z"
  }
}
```

### `GET /api/performance/baseline-compare`

Compare current metrics against active baseline for regression detection.

**Auth:** Optional

**Query Parameters:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseline_id` | string | active | Baseline to compare against |

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "baseline": {
      "id": "507f1f77bcf86cd799439012",
      "name": "v1.0-baseline"
    },
    "comparison": {
      "avg_response_time": {
        "baseline": 150,
        "current": 145,
        "diff_ms": -5,
        "diff_percent": -3.33
      },
      "p95_latency": {
        "baseline": 450,
        "current": 460,
        "diff_ms": 10,
        "diff_percent": 2.22
      },
      "error_rate": {
        "baseline": 0.5,
        "current": 0.4,
        "diff_percent": -20.0
      },
      "throughput_rps": {
        "baseline": 12.5,
        "current": 13.2,
        "diff_percent": 5.6
      }
    },
    "regression_detected": false,
    "regressions": [],
    "thresholds": {
      "p95_latency_increase": 20,
      "error_rate_increase": 50
    }
  }
}
```

**Regression Detection:**
- P95 latency increase > 20% → Regression
- Error rate increase > 50% → Regression
- Throughput decrease > 20% → Regression

---

## Rate Limiting

Currently no rate limiting is enforced. Future versions may implement:
- 100 requests/minute for chat endpoints
- 1000 requests/minute for other endpoints

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-12-31 | Initial comprehensive API documentation |
