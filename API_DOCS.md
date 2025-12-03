# AgentX API Documentation

## Overview

This document describes the AgentX backend API endpoints for **V1 (Chat + Logs)** and **V2 (User Memory + Feedback)**.

All endpoints return JSON with a consistent structure:
```json
{
  "status": "success" | "error",
  "data": { ... },        // Present on success
  "message": "...",       // Present on error
  "details": { ... }      // Optional additional error info
}
```

**Base URL:** `http://localhost:3080`

---

## V1: Chat + Logs

### POST /api/chat

Primary chat endpoint with conversation logging and memory injection.

**Request:**
```json
{
  "userId": "user123",              // Optional, defaults to "default"
  "conversationId": "uuid-here",    // Optional, creates new if omitted
  "message": "What is recursion?",  // Required
  "model": "llama2",                // Required
  "target": "localhost:11434",      // Optional, defaults to "localhost:11434"
  "system": "You are a helpful...", // Optional system prompt
  "options": {                      // Optional LLM parameters
    "temperature": 0.7,
    "top_p": 0.9,
    "top_k": 40,
    "num_ctx": 2048,
    "repeat_penalty": 1.1
  }
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "conversationId": "550e8400-e29b-41d4-a716-446655440000",
    "messageId": "660e8400-e29b-41d4-a716-446655440001",
    "response": "Recursion is a programming technique...",
    "metadata": {
      "model": "llama2",
      "latency_ms": 1234,
      "tokens": {
        "prompt": 45,
        "completion": 120,
        "total": 165
      },
      "done": true,
      "done_reason": "stop"
    }
  }
}
```

**Behavior:**
- If `conversationId` is provided, continues existing conversation
- If omitted, creates a new conversation
- Automatically injects user memory/profile into system prompt
- Persists user message and assistant response with full metadata
- Returns conversation and message IDs for follow-up actions

---

### GET /api/conversations

Retrieve all conversations for a user.

**Query Parameters:**
- `userId` (optional, default: "default")
- `limit` (optional, default: 50)

**Request:**
```
GET /api/conversations?userId=user123&limit=20
```

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "user_id": "user123",
      "title": "What is recursion?",
      "model": "llama2",
      "system_prompt": "You are AgentX...",
      "target": "localhost:11434",
      "created_at": "2025-12-02T10:30:00.000Z",
      "updated_at": "2025-12-02T10:35:00.000Z"
    }
  ]
}
```

---

### GET /api/conversations/:id

Retrieve a specific conversation, optionally with full message history.

**Path Parameters:**
- `id` - Conversation UUID

**Query Parameters:**
- `includeMessages` (optional, default: true)

**Request:**
```
GET /api/conversations/550e8400-e29b-41d4-a716-446655440000?includeMessages=true
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "user_id": "user123",
    "title": "What is recursion?",
    "model": "llama2",
    "system_prompt": "You are AgentX...",
    "target": "localhost:11434",
    "created_at": "2025-12-02T10:30:00.000Z",
    "updated_at": "2025-12-02T10:35:00.000Z",
    "messages": [
      {
        "id": "660e8400-e29b-41d4-a716-446655440001",
        "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
        "role": "user",
        "content": "What is recursion?",
        "sequence_number": 1,
        "timestamp": "2025-12-02T10:30:15.000Z",
        "model": null,
        "temperature": null,
        "tokens_total": null,
        "latency_ms": null
      },
      {
        "id": "660e8400-e29b-41d4-a716-446655440002",
        "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
        "role": "assistant",
        "content": "Recursion is a programming technique...",
        "sequence_number": 2,
        "timestamp": "2025-12-02T10:30:16.234Z",
        "model": "llama2",
        "temperature": 0.7,
        "tokens_total": 165,
        "latency_ms": 1234
      }
    ]
  }
}
```

---

### PATCH /api/conversations/:id

Update conversation title.

**Path Parameters:**
- `id` - Conversation UUID

**Request:**
```json
{
  "title": "Learning about recursion"
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "user_id": "user123",
    "title": "Learning about recursion",
    "model": "llama2",
    "system_prompt": "You are AgentX...",
    "target": "localhost:11434",
    "created_at": "2025-12-02T10:30:00.000Z",
    "updated_at": "2025-12-02T10:40:00.000Z"
  }
}
```

---

## V2: User Memory / Profile

### GET /api/user/profile

Retrieve user profile and memory.

**Query Parameters:**
- `userId` (optional, default: "default")

**Request:**
```
GET /api/user/profile?userId=user123
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "id": 1,
    "user_id": "user123",
    "name": "Alice",
    "role": "Software Engineer",
    "language_preference": "en",
    "response_style": "detailed",
    "code_preference": "code-heavy",
    "custom_preferences": {
      "notes": "Prefers Python examples, interested in machine learning"
    },
    "created_at": "2025-12-01T08:00:00.000Z",
    "updated_at": "2025-12-02T10:00:00.000Z"
  }
}
```

**Profile Fields:**
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
- `target` (optional, default: "localhost:11434")

**Request:**
```
GET /api/ollama/models?target=localhost:11434
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
  "target": "localhost:11434",
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

The backend uses SQLite with the following main tables:

- **user_profiles** - User memory/preferences
- **conversations** - Chat sessions/threads
- **messages** - Individual messages in conversations
- **llm_metadata** - LLM call metadata (tokens, latency, etc.)
- **feedback** - User ratings and comments

See `schema.sql` for full details.

---

## Future Extensibility

The API is designed to support future enhancements:

### RAG Integration (Future)
The `/api/chat` endpoint can be extended to:
- Accept `context` or `documents` in the request
- Inject retrieved context into the system prompt
- Log which documents were used in `llm_metadata`

### Workflow Automation (Future)
Feedback and conversation data can be consumed by n8n or other automation tools:
- Export feedback for prompt improvement
- Trigger workflows based on conversation patterns
- Auto-update user profiles from conversation analysis

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
