# AgentX Backend Implementation

## Overview

This backend implements **V1 (Chat + Logs)**, **V2 (User Memory + Feedback)**, **V3 (RAG)**, and **V4 (Analytics)** for the AgentX project.

### Technology Stack

- **Node.js** with Express
- **MongoDB** (via Mongoose) for data persistence
- **Ollama** for LLM integration
- **n8n** for workflow automation and dataset ingestion

---

## Features Implemented

### ✅ V1: Chat + Logs

1. **Enhanced Chat Endpoint (`POST /api/chat`)**
   - Persistent conversation management
   - Automatic message logging
   - Full metadata capture (tokens, latency, model parameters)
   - User memory injection into system prompts
   - Conversation history context
   - Persona switching support

2. **Conversation Retrieval**
   - `GET /api/history/conversations` - List user's conversations
   - `GET /api/history/conversations/:id` - Get conversation with full message history
   - `PATCH /api/history/conversations/:id` - Update conversation title

### ✅ V2: User Memory + Feedback

3. **User Profile Management**
   - `GET /api/profile` - Retrieve user preferences
   - `POST /api/profile` - Create/update profile
   - Fields:
     - Name, role, language preference
     - Response style (concise/detailed/balanced)
     - Code preference (code-heavy/conceptual/balanced)
     - Custom preferences (JSON for extensibility)
   - Automatic memory injection into chat system prompts

4. **Feedback System**
   - `POST /api/feedback` - Submit ratings and comments
   - Designed for consumption by V4 Analytics and n8n workflows

### ✅ V3: RAG (Retrieval-Augmented Generation)

5. **RAG Integration**
   - `POST /api/chat` supports `useRag: true`
   - `POST /api/rag/ingest` - Ingest documents (Contract with n8n)
   - `POST /api/rag/search` - Debug/Test search
   - Vector Store abstraction (currently In-Memory or Qdrant)

### ✅ V4: Analytics & Improvement

6. **Analytics & Datasets**
   - `GET /api/analytics/usage` - Usage metrics
   - `GET /api/analytics/feedback` - Feedback metrics
   - `GET /api/dataset/conversations` - Export for training
   - `POST /api/dataset/prompts` - Auto-generate prompt versions via n8n

---

## Database Schema

MongoDB database with the following Mongoose models:

- **UserProfile** - User memory and preferences
- **Conversation** - Chat sessions/threads (embedded messages)
- **PromptConfig** - Versioned system prompts

See `docs/architecture/database.md` for full details.

---

## File Structure

```
AgentX/
├── server.js              # Express server entry point
├── routes/                # API route modules
├── models/                # Mongoose models
├── config/                # Database configuration and logger
├── docs/                  # Onboarding, architecture, API, reports, archive
├── specs/                 # Architecture specs
├── public/                # Frontend files
├── src/                   # Service utilities (services/, utils/, middleware/)
├── scripts/               # Utility scripts
├── tests/                 # Test suite
└── package.json           # Dependencies
```

---

## Design Decisions

### Why MongoDB?

- **Flexible Schema** - Ideal for evolving chat metadata and user profiles
- **JSON Native** - Seamless integration with Node.js and LLM responses
- **Mongoose** - Strong typing and validation layer

### Why Service Layer?

- `src/services/chatService.js` encapsulates core logic
- `src/services/ragStore.js` abstracts vector database
- `src/services/toolExecutor.js` handles tool execution
- Allows testing logic independently of HTTP routes

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
- `502` - Bad Gateway (Ollama or upstream service failure)

---

## Collaboration with Frontend

### For Agent C (Frontend & UX Integrator)

1. **Base URL**: `http://localhost:3080` (or as configured)

2. **User Session Management**:
   - Generate `userId` client-side or use auth session
   - Pass `userId` in API calls where required (mostly handled by session/cookie now)

3. **Key Endpoints**:
   - Chat: `POST /api/chat`
   - History: `GET /api/history/conversations`
   - Profile: `GET /api/profile`
   - Feedback: `POST /api/feedback`

---

## Notes for Deployment

### Environment Variables

See `.env.example` for full list. Key variables:

```bash
PORT=3080
MONGODB_URI=mongodb://localhost:27017/agentx
OLLAMA_HOST=http://localhost:11434
# Optional
OLLAMA_HOST_2=...
DATAAPI_BASE_URL=...
```
