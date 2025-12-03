# AgentX Backend Implementation

## Overview

This backend implements **V1 (Chat + Logs)** and **V2 (User Memory + Feedback)** for the AgentX project.

### Technology Stack

- **Node.js** with Express
- **SQLite3** for data persistence
- **Ollama** for LLM integration
- Architecture designed for easy RAG and workflow automation extension

---

## Features Implemented

### ✅ V1: Chat + Logs

1. **Enhanced Chat Endpoint (`POST /api/chat`)**
   - Persistent conversation management
   - Automatic message logging
   - Full metadata capture (tokens, latency, model parameters)
   - User memory injection into system prompts
   - Conversation history context

2. **Conversation Retrieval**
   - `GET /api/conversations` - List user's conversations
   - `GET /api/conversations/:id` - Get conversation with full message history
   - `PATCH /api/conversations/:id` - Update conversation title

### ✅ V2: User Memory + Feedback

3. **User Profile Management**
   - `GET /api/user/profile` - Retrieve user preferences
   - `POST /api/user/profile` - Create/update profile
   - Fields:
     - Name, role, language preference
     - Response style (concise/detailed/balanced)
     - Code preference (code-heavy/conceptual/balanced)
     - Custom preferences (JSON for extensibility)
   - Automatic memory injection into chat system prompts

4. **Feedback System**
   - `POST /api/feedback` - Submit ratings and comments
   - `GET /api/feedback/message/:id` - Get feedback for a message
   - `GET /api/feedback/conversation/:id` - Get all feedback for a conversation
   - Rating: -1 (thumbs down), 0 (neutral), 1 (thumbs up)
   - Designed for consumption by future analytics/automation tools

---

## Database Schema

SQLite database with the following tables:

- **user_profiles** - User memory and preferences
- **conversations** - Chat sessions/threads
- **messages** - Individual messages (user and assistant)
- **llm_metadata** - LLM call metadata (tokens, latency, parameters)
- **feedback** - User ratings and comments

See `schema.sql` for full details.

---

## Getting Started

### Installation

```bash
npm install
```

### Running the Server

```bash
npm start
```

Server starts on `http://localhost:3080` (configurable via PORT env var).

### Database Location

Database is automatically created at `./data/agentx.db` (configurable via DB_PATH env var).

---

## API Documentation

See `../api/reference.md` for complete endpoint documentation with request/response examples.

### Quick Examples

#### 1. Create User Profile

```bash
curl -X POST http://localhost:3080/api/user/profile \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "name": "Alice",
    "role": "Senior Developer",
    "response_style": "detailed",
    "code_preference": "code-heavy"
  }'
```

#### 2. Start a Chat (with automatic memory injection)

```bash
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "message": "Explain recursion",
    "model": "llama2"
  }'
```

Response includes `conversationId` and `messageId` for continuation.

#### 3. Continue Conversation

```bash
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "conversationId": "YOUR_CONVERSATION_ID",
    "message": "Show me a Python example",
    "model": "llama2"
  }'
```

#### 4. Provide Feedback

```bash
curl -X POST http://localhost:3080/api/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "messageId": "YOUR_MESSAGE_ID",
    "rating": 1,
    "comment": "Great explanation!"
  }'
```

#### 5. Retrieve Conversation History

```bash
curl http://localhost:3080/api/conversations/YOUR_CONVERSATION_ID
```

---

## Architecture Highlights

### Memory Injection

User profiles are automatically retrieved and injected into system prompts:

```javascript
// Example injected context
User Profile:
User's name: Alice
User's role: Senior Developer
The user prefers detailed, comprehensive responses.
The user prefers code-heavy responses with practical examples.
```

This happens transparently on every chat request.

### Conversation Context

The `/api/chat` endpoint automatically:
1. Retrieves conversation history
2. Builds proper message array for LLM
3. Includes user memory in system prompt
4. Stores all messages and metadata

### Extensibility for RAG

The architecture supports future RAG integration:

- `system_prompt` field in conversations can include retrieved context
- `custom_preferences` in profiles can store document references
- `llm_metadata` can be extended to track which documents were used

Example future enhancement:
```javascript
// In chat endpoint
const retrievedDocs = await retrieveRelevantDocs(message, userId);
enhancedSystem += `\n\nRelevant Context:\n${retrievedDocs}`;
```

### Extensibility for Automation

Feedback and conversation data is structured for external consumption:

- n8n workflows can query feedback for prompt improvement
- Analytics can track model performance via metadata
- Auto-update profiles based on conversation patterns

---

## File Structure

```
AgentX/
├── server.js           # Main Express server with all endpoints
├── db.js              # Database access layer (SQLite operations)
├── schema.sql         # Database schema definition
├── package.json       # Dependencies
├── API_DOCS.md        # Comprehensive API documentation
├── data/              # Auto-created for SQLite database
│   └── agentx.db
└── public/            # Frontend files (existing)
```

---

## Design Decisions

### Why SQLite?

- **Zero configuration** - No separate database server needed
- **Portable** - Single file, easy to backup
- **Sufficient for local use** - Perfect for AgentX's local-first architecture
- **Easy migration** - Can move to PostgreSQL/MySQL later if needed

### Why async/await everywhere?

- Consistent error handling
- Better readability
- Prepares for future async operations (RAG, external APIs)

### Why separate `/api/chat` from `/api/ollama/chat`?

- `/api/chat` - New enhanced endpoint with logging, memory, persistence
- `/api/ollama/chat` - Legacy endpoint, kept for backward compatibility
- Frontend can migrate gradually

---

## Error Handling

All endpoints return consistent error format:

```json
{
  "status": "error",
  "message": "Description of error",
  "details": {}  // Optional
}
```

Common status codes:
- `400` - Bad request (missing required fields)
- `404` - Resource not found
- `500` - Internal server error

---

## Future Enhancements (Out of Scope for V1/V2)

### RAG Integration

Add to `/api/chat`:
```javascript
// Retrieve relevant documents
const docs = await vectorStore.search(message, userId);

// Inject into system prompt
enhancedSystem += `\n\nRelevant Documents:\n${formatDocs(docs)}`;

// Log which docs were used
await db.createLLMMetadata({
  ...metadata,
  retrieved_docs: docs.map(d => d.id)
});
```

### Workflow Automation

Create webhook endpoint for n8n:
```javascript
app.post('/api/webhooks/feedback-analysis', async (req, res) => {
  // Aggregate feedback
  // Identify patterns
  // Trigger prompt improvements
  // Auto-update user profiles
});
```

### Multi-Model Support

Add model routing:
```javascript
const modelConfig = {
  'coding': 'codellama',
  'general': 'llama2',
  'creative': 'mistral'
};

// Auto-select based on message type
const model = detectModelNeeded(message) || userModel;
```

---

## Testing

### Manual Testing

Use the curl examples in `API_DOCS.md` or tools like Postman.

### Health Check

```bash
curl http://localhost:3080/health
```

Should return:
```json
{
  "status": "ok",
  "port": 3080
}
```

---

## Collaboration with Frontend

### For Agent C (Frontend & UX Integrator)

1. **Base URL**: `http://localhost:3080`

2. **User Session Management**:
   - Generate `userId` client-side (UUID or username)
   - Store in localStorage
   - Pass in all API calls

3. **Conversation Flow**:
   - First message: Call `/api/chat` without `conversationId`
   - Response includes `conversationId`
   - Store and include in subsequent messages
   - Display conversation list from `/api/conversations`

4. **Memory UI**:
   - Settings panel for profile management
   - Call `GET /api/user/profile` to populate form
   - `POST /api/user/profile` to save changes
   - Show "memory active" indicator when profile exists

5. **Feedback UI**:
   - Add thumbs up/down buttons to each assistant message
   - Store `messageId` from chat response
   - Call `/api/feedback` on click
   - Optional: Show feedback summary in conversation view

6. **Error Handling**:
   - Always check `status` field in responses
   - Display `message` to user on errors
   - Implement retry logic for network failures

---

## Notes for Deployment

### Environment Variables

```bash
PORT=3080              # Server port
DB_PATH=/path/to/db    # Database location
```

### Production Considerations

1. **Database backup**: Regular backup of `agentx.db`
2. **Logging**: Add proper logging middleware (e.g., morgan)
3. **Rate limiting**: Add rate limits to prevent abuse
4. **CORS**: Configure CORS properly for production
5. **HTTPS**: Use HTTPS in production
6. **Monitoring**: Add health checks and metrics

---

## Support for Agent A's Architecture

This implementation follows the contracts defined by Agent A:

✅ Clean separation of concerns (routing, data access, LLM integration)
✅ Extensible schema with JSON fields for future flexibility
✅ Consistent API response format
✅ Proper error handling and validation
✅ Memory injection transparent to frontend
✅ Feedback system ready for automation consumption
✅ RAG-ready architecture (just add retrieval step)

---

## Questions or Issues?

See `../api/reference.md` for detailed endpoint documentation.
Check `database.md` for database structure.
Review `db.js` for data access patterns.

Backend is complete and ready for frontend integration! 🚀
