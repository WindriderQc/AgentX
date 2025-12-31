# AgentX API Reference

**Version:** 1.0  
**Base URL:** `http://192.168.2.33:3080`  
**Last Updated:** December 31, 2025

> **Quick Links:** [Chat](#chat--conversations) • [Analytics](#analytics--metrics) • [RAG](#rag-retrieval-augmented-generation) • [Voice](#voice-io) • [Models](#model-management) • [n8n Integration](#n8n-integration)

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

## Rate Limiting

Currently no rate limiting is enforced. Future versions may implement:
- 100 requests/minute for chat endpoints
- 1000 requests/minute for other endpoints

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-12-31 | Initial comprehensive API documentation |
