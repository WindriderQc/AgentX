# AgentX API Reference Compatibility Page

This file remains as a stable landing page for older links, but the canonical endpoint reference now lives in the SBQC stack reference.

## Canonical Sources

- [SBQC Stack AgentX API Reference](../architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md) - Main endpoint documentation for current AgentX routes.
- [SBQC API Documentation](./API.md) - n8n-facing webhook and SBQC bridge endpoints.
- [OpenAPI Specification](./openapi.yaml) - Machine-readable API schema.

## Specialized API Guides

- [API README](./README.md) - API documentation hub and topic map.
- [Benchmark API Enhanced](./BENCHMARK_API_ENHANCED.md) - Benchmark-specific endpoints.
- [Cost Analytics API](./COST_ANALYTICS_API.md) - Cost tracking and analytics.
- [Performance API](./PERFORMANCE_API.md) - Performance metrics and monitoring.
- [Workspace API Guide](./WORKSPACE_API_GUIDE.md) - Multi-tenant workspace behavior.
- [Contract Snapshots](./contracts/v3-snapshot.md) and [V4 Contract](./contracts/v4-contract.md) - Historical contract snapshots.

## Why This File Is Short

Historically this file duplicated endpoint descriptions that also existed in the stack-level API reference. Keeping two full endpoint references caused drift. This page now exists only to preserve compatibility and route readers to the maintained source of truth.
- `name` - User's name
- `role` - User's role/profession
- `language_preference` - ISO language code (e.g., "en", "fr", "es")
- `response_style` - "concise" | "detailed" | "balanced"
- `code_preference` - "code-heavy" | "conceptual" | "balanced"
- `custom_preferences` - JSON object for extensible preferences

---

### POST /api/user/profile

Create or update user profile.

**Request:**
```json
{
  "userId": "user123",
  "name": "Alice",
  "role": "Senior Software Engineer",
  "language_preference": "en",
  "response_style": "detailed",
  "code_preference": "code-heavy",
  "custom_preferences": {
    "notes": "Prefers Python and TypeScript examples",
    "interests": ["machine learning", "web development"]
  }
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "id": 1,
    "user_id": "user123",
    "name": "Alice",
    "role": "Senior Software Engineer",
    "language_preference": "en",
    "response_style": "detailed",
    "code_preference": "code-heavy",
    "custom_preferences": {
      "notes": "Prefers Python and TypeScript examples",
      "interests": ["machine learning", "web development"]
    },
    "created_at": "2025-12-01T08:00:00.000Z",
    "updated_at": "2025-12-02T10:45:00.000Z"
  }
}
```

**Notes:**
- All fields except `userId` are optional
- Partial updates supported - only provided fields are updated
- Profile is auto-injected into chat system prompts

---

## V2: Feedback

### POST /api/feedback

Submit feedback on an assistant message.

**Request:**
```json
{
  "messageId": "660e8400-e29b-41d4-a716-446655440002",
  "rating": 1,
  "comment": "Great explanation, very clear!"
}
```

**Fields:**
- `messageId` (required) - UUID of the assistant message
- `rating` (required) - Integer: -1 (thumbs down), 0 (neutral), 1 (thumbs up)
- `comment` (optional) - User's text feedback

**Response:**
```json
{
  "status": "success",
  "data": {
    "id": 1,
    "message_id": "660e8400-e29b-41d4-a716-446655440002",
    "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
    "rating": 1,
    "comment": "Great explanation, very clear!",
    "created_at": "2025-12-02T10:50:00.000Z"
  }
}
```

---

### GET /api/feedback/message/:messageId

Retrieve all feedback for a specific message.

**Path Parameters:**
- `messageId` - Message UUID

**Request:**
```
GET /api/feedback/message/660e8400-e29b-41d4-a716-446655440002
```

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "id": 1,
      "message_id": "660e8400-e29b-41d4-a716-446655440002",
      "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
      "rating": 1,
      "comment": "Great explanation, very clear!",
      "created_at": "2025-12-02T10:50:00.000Z"
    }
  ]
}
```

---

### GET /api/feedback/conversation/:conversationId

Retrieve all feedback for a conversation.

**Path Parameters:**
- `conversationId` - Conversation UUID

**Request:**
```
GET /api/feedback/conversation/550e8400-e29b-41d4-a716-446655440000
```

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "id": 1,
      "message_id": "660e8400-e29b-41d4-a716-446655440002",
      "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
      "rating": 1,
      "comment": "Great explanation, very clear!",
      "created_at": "2025-12-02T10:50:00.000Z"
    },
    {
      "id": 2,
      "message_id": "660e8400-e29b-41d4-a716-446655440004",
      "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
      "rating": -1,
      "comment": "Response was too technical",
      "created_at": "2025-12-02T10:55:00.000Z"
    }
  ]
}
```

---

## Legacy Endpoints

These endpoints remain for backward compatibility with the existing frontend:

### GET /api/ollama/models

Proxy to retrieve available Ollama models.

**Query Parameters:**
- `target` (optional, default: configured OLLAMA_HOST)

**Request:**
```
GET /api/ollama/models?target=http://192.168.1.100:11434
```

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "name": "llama2",
      "size": 3825819519,
      "modified_at": "2025-12-01T10:00:00.000Z"
    },
    {
      "name": "codellama",
      "size": 3825819519,
      "modified_at": "2025-12-01T10:00:00.000Z"
    }
  ]
}
```

---

### POST /api/ollama/chat

Legacy chat endpoint without logging (direct Ollama proxy).

**Request:**
```json
{
  "target": "ollama-host:11434",
  "model": "llama2",
  "messages": [
    { "role": "system", "content": "You are helpful" },
    { "role": "user", "content": "Hello" }
  ],
  "system": "You are helpful",
  "options": {
    "temperature": 0.7
  }
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "model": "llama2",
    "created_at": "2025-12-02T10:00:00.000Z",
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "done": true,
    "done_reason": "stop",
    "total_duration": 1234567890,
    "load_duration": 123456,
    "prompt_eval_count": 20,
    "eval_count": 15,
    "eval_duration": 987654321
  }
}
```

---

## Error Handling

All endpoints return errors in this format:

```json
{
  "status": "error",
  "message": "Description of what went wrong",
  "details": { }  // Optional additional context
}
```

**Common HTTP Status Codes:**
- `400` - Bad Request (missing required fields, invalid input)
- `404` - Not Found (conversation, message, user not found)
- `500` - Internal Server Error (database or LLM errors)

---

## Data Flow Examples

### Example 1: New Conversation with Memory

1. **Create/Update User Profile:**
```bash
curl -X POST http://localhost:3080/api/user/profile \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "name": "Alice",
    "role": "Developer",
    "response_style": "detailed",
    "code_preference": "code-heavy"
  }'
```

2. **Start Chat (Memory Auto-Injected):**
```bash
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "message": "How do I implement a binary tree?",
    "model": "llama2"
  }'
```

Response includes `conversationId` for continuation.

3. **Continue Conversation:**
```bash
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "conversationId": "550e8400-e29b-41d4-a716-446655440000",
    "message": "Can you show me in Python?",
    "model": "llama2"
  }'
```

4. **Provide Feedback:**
```bash
curl -X POST http://localhost:3080/api/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "messageId": "660e8400-e29b-41d4-a716-446655440002",
    "rating": 1,
    "comment": "Perfect example!"
  }'
```

---

### Example 2: Retrieve Conversation History

```bash
# List all conversations
curl http://localhost:3080/api/conversations?userId=alice

# Get specific conversation with messages
curl http://localhost:3080/api/conversations/550e8400-e29b-41d4-a716-446655440000

# Get all feedback for conversation
curl http://localhost:3080/api/feedback/conversation/550e8400-e29b-41d4-a716-446655440000
```

---

## Database Schema

The backend uses MongoDB (Mongoose) with the following main models:

- **UserProfile** - User memory/preferences
- **Conversation** - Chat sessions/threads (contains embedded `messages` and RAG metadata)
- **PromptConfig** - System prompt versioning

---

## V3: RAG (Retrieval-Augmented Generation)

### POST /api/chat (Extended)

The chat endpoint supports RAG via optional parameters:
```json
{
  "useRag": true,
  "ragTopK": 5,
  "ragFilters": { "source": "manual" }
}
```

### POST /api/rag/documents (or /api/rag/ingest)

Ingest a document into the vector store.

**Request:**
```json
{
  "source": "my-docs",
  "path": "file.txt",
  "title": "My Document",
  "text": "Full content of the document...",
  "metadata": { "custom": "value" }
}
```

**Response:**
```json
{
  "status": "success",
  "documentId": "uuid...",
  "chunkCount": 5
}
```

---

## V4: Analytics & Improvement

### GET /api/analytics/usage

Returns conversation and message counts.

**Query Parameters:**
- `from`, `to` (ISO dates)
- `groupBy` ('model', 'promptVersion', 'day')

### GET /api/analytics/feedback

Returns feedback metrics.

**Query Parameters:**
- `from`, `to` (ISO dates)
- `groupBy` ('model', 'promptVersion')

### GET /api/analytics/stats

Returns aggregated usage and performance statistics.

**Query Parameters:**
- `from`, `to` (ISO dates)
- `groupBy` ('model', 'day', default: 'model')

**Response:**
```json
{
  "status": "success",
  "data": {
    "from": "...",
    "to": "...",
    "totals": {
      "promptTokens": 1000,
      "completionTokens": 500,
      "totalTokens": 1500,
      "durationSec": 10.5,
      "messages": 5,
      "avgDurationSec": 2.1
    },
    "breakdown": [
      {
        "messageCount": 5,
        "usage": { "totalTokens": 1500, ... },
        "performance": { "avgTokensPerSecond": 45.5, ... }
      }
    ]
  }
}
```

### Multi-Model Support
The current design supports multiple Ollama targets and models. Future enhancements could:
- Add support for remote LLM APIs (OpenAI, Anthropic, etc.)
- Model routing based on conversation type
- Cost tracking per model

---

## Testing

Start the server:
```bash
npm install
npm start
```

Test with curl:
```bash
# Health check
curl http://localhost:3080/health

# Create profile
curl -X POST http://localhost:3080/api/user/profile \
  -H "Content-Type: application/json" \
  -d '{"userId": "test", "name": "Test User"}'

# Start chat
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test",
    "message": "Hello!",
    "model": "llama2"
  }'
```

---

## Notes for Frontend Integration

1. **User Sessions:** Frontend should maintain a `userId` (can be generated client-side, stored in localStorage)

2. **Conversation Management:** 
   - Store `conversationId` to continue threads
   - Display conversation list from `/api/conversations`
   - Allow renaming via `PATCH /api/conversations/:id`

3. **Memory UI:**
   - Provide settings panel for user profile
   - Show "memory injected" indicator in chat
   - Allow "remember this" actions that update profile

4. **Feedback:**
   - Add thumbs up/down buttons to each assistant message
   - Store `messageId` from chat response
   - Submit feedback immediately on click

5. **Error Handling:**
   - Check `status` field in all responses
   - Display `message` to user on errors
   - Retry logic for network failures

6. **Model Selection:**
   - Fetch available models from `/api/ollama/models`
   - Allow model switching mid-conversation (creates context)
