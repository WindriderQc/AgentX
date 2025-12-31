# AgentX API Reference

**Version:** 1.0.0 (SBQC Final Stack)
**Base URL:** `/api`

---

## 🔐 Authentication

### Auth Methods
1.  **Session:** Standard cookie-based auth (for browser).
2.  **API Key:** Header `x-api-key: <YOUR_KEY>` or `Authorization: Bearer <YOUR_KEY>` (for n8n/tools).

### Endpoints

#### `POST /auth/register`
Register a new user.
*   **Body:** `{ "email": "user@example.com", "password": "...", "name": "..." }`
*   **Rate Limit:** 5 req / 15 min.

#### `POST /auth/login`
Login and create session.
*   **Body:** `{ "email": "...", "password": "..." }`
*   **Rate Limit:** 5 req / 15 min.

#### `POST /auth/logout`
Destroy session.

#### `GET /auth/me`
Get current user info.

---

## 💬 Chat & Conversation

#### `POST /chat`
Send a message to the AI.
*   **Auth:** Optional (defaults to guest/default user if missing).
*   **Body:**
    ```json
    {
      "message": "Hello",
      "model": "llama3",
      "useRag": true,         // Enable RAG
      "ragTopK": 5,           // RAG context window
      "conversationId": "..." // Optional: Continue chat
    }
    ```
*   **Response:** `{ "response": "...", "conversationId": "...", "ragUsed": true, "ragSources": [...] }`

#### `GET /history`
List user conversations.

#### `GET /history/:id`
Get a specific conversation.

#### `POST /feedback`
Rate a message.
*   **Body:** `{ "conversationId": "...", "messageId": "...", "rating": 1 }` (1=Up, -1=Down)

---

## 📚 RAG (V3)

#### `POST /rag/ingest`
Ingest a document.
*   **Auth:** Required (API Key/Admin).
*   **Body:**
    ```json
    {
      "source": "nas",
      "path": "/docs/guide.md",
      "title": "Guide",
      "text": "Full text content...",
      "tags": ["guide"],
      "hash": "sha256..."
    }
    ```

#### `POST /rag/search`
Debug search.
*   **Body:** `{ "query": "...", "topK": 5 }`

---

## 📊 Analytics (V4)

All endpoints require **Authentication**.

#### `GET /analytics/usage`
Conversation/Message counts.
*   **Query:** `?from=...&to=...&groupBy=model`

#### `GET /analytics/feedback`
Feedback stats.
*   **Query:** `?groupBy=promptVersion`

#### `GET /analytics/rag-stats`
RAG vs Non-RAG performance.

---

## 💾 Dataset & Prompts (V4)

All endpoints require **Authentication**.

#### `GET /dataset/conversations`
Export conversation data.
*   **Query:** `?minFeedback=-1&limit=100`

#### `GET /dataset/prompts`
List prompt configurations.

#### `POST /dataset/prompts`
Propose a new prompt version.

#### `PATCH /dataset/prompts/:id/activate`
Activate a prompt version.

---

## 📈 System Metrics

#### `GET /metrics/system`
System health, memory, uptime.

#### `GET /metrics/cache`
Embedding cache stats (hit rate, size).

#### `GET /metrics/database`
MongoDB collection stats.

---

## 🤖 Model Routing

#### `GET /models/routing`
Get current routing configuration.

#### `POST /models/classify`
Preview how a query would be routed.

---

## 🎤 Voice I/O

#### `POST /voice/transcribe`
Speech-to-Text.

#### `POST /voice/synthesize`
Text-to-Speech.
