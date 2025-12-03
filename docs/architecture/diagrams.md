# AgentX Backend Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (Agent C)                         │
│                    (To be implemented)                               │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            │ HTTP/JSON
                            │
┌───────────────────────────▼─────────────────────────────────────────┐
│                         API LAYER (server.js)                        │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  LEGACY ENDPOINTS (Unchanged)                                        │
│  ├─ GET  /api/ollama/models      → Ollama proxy                    │
│  ├─ POST /api/ollama/chat        → Ollama proxy (no logging)       │
│  └─ GET  /health                 → Health check                     │
│                                                                      │
│  V1: CHAT + LOGS                                                    │
│  ├─ POST  /api/chat               → Enhanced chat with logging      │
│  ├─ GET   /api/conversations      → List conversations             │
│  ├─ GET   /api/conversations/:id  → Get conversation + messages    │
│  └─ PATCH /api/conversations/:id  → Update conversation title      │
│                                                                      │
│  V2: USER MEMORY + FEEDBACK                                         │
│  ├─ GET  /api/user/profile        → Get user profile               │
│  ├─ POST /api/user/profile        → Create/update profile          │
│  ├─ POST /api/feedback            → Submit feedback                │
│  ├─ GET  /api/feedback/message/:id     → Get message feedback      │
│  └─ GET  /api/feedback/conversation/:id → Get conversation feedback│
│                                                                      │
└───────────────────────┬──────────────────────┬──────────────────────┘
                        │                      │
                        │                      │
        ┌───────────────▼──────────┐  ┌────────▼─────────┐
        │   DATABASE LAYER         │  │   OLLAMA API     │
        │      (db.js)             │  │  (External LLM)  │
        └───────────────┬──────────┘  └──────────────────┘
                        │
                        │
        ┌───────────────▼──────────────────────────────────┐
        │         SQLite DATABASE (agentx.db)              │
        ├──────────────────────────────────────────────────┤
        │                                                  │
        │  ┌──────────────────┐                          │
        │  │  user_profiles   │  User memory & prefs     │
        │  │  ─────────────   │                          │
        │  │  • user_id       │                          │
        │  │  • name          │                          │
        │  │  • role          │                          │
        │  │  • preferences   │                          │
        │  └────────┬─────────┘                          │
        │           │ 1:N                                 │
        │           │                                     │
        │  ┌────────▼─────────┐                          │
        │  │  conversations   │  Chat sessions/threads   │
        │  │  ─────────────   │                          │
        │  │  • id (UUID)     │                          │
        │  │  • user_id       │                          │
        │  │  • title         │                          │
        │  │  • model         │                          │
        │  │  • system_prompt │                          │
        │  └────────┬─────────┘                          │
        │           │ 1:N                                 │
        │           │                                     │
        │  ┌────────▼─────────┐                          │
        │  │     messages     │  User/assistant messages │
        │  │  ─────────────   │                          │
        │  │  • id (UUID)     │                          │
        │  │  • conversation_id                          │
        │  │  • role          │                          │
        │  │  • content       │                          │
        │  │  • sequence_num  │                          │
        │  └────────┬─────────┘                          │
        │           │ 1:1                                 │
        │           ├─────────────┐                      │
        │           │             │                      │
        │  ┌────────▼─────────┐ ┌▼───────────────┐      │
        │  │  llm_metadata    │ │   feedback     │      │
        │  │  ─────────────   │ │ ────────────   │      │
        │  │  • message_id    │ │ • message_id   │      │
        │  │  • model         │ │ • rating       │      │
        │  │  • tokens        │ │ • comment      │      │
        │  │  • latency_ms    │ │                │      │
        │  │  • parameters    │ │                │      │
        │  └──────────────────┘ └────────────────┘      │
        │                                                  │
        └──────────────────────────────────────────────────┘
```

## Data Flow: Chat Request

```
┌─────────┐
│ CLIENT  │
└────┬────┘
     │
     │ POST /api/chat
     │ { userId, message, model }
     │
┌────▼─────────────────────────────────────────┐
│ 1. Retrieve User Profile                     │
│    → db.getOrCreateUserProfile(userId)       │
│    ← { name, role, preferences }             │
└────┬─────────────────────────────────────────┘
     │
┌────▼─────────────────────────────────────────┐
│ 2. Build Enhanced System Prompt              │
│    • Base: "You are AgentX..."              │
│    • Add: User memory/preferences            │
└────┬─────────────────────────────────────────┘
     │
┌────▼─────────────────────────────────────────┐
│ 3. Get/Create Conversation                   │
│    If conversationId:                        │
│      → db.getConversation(id)               │
│    Else:                                     │
│      → db.createConversation({...})         │
└────┬─────────────────────────────────────────┘
     │
┌────▼─────────────────────────────────────────┐
│ 4. Retrieve Conversation History             │
│    → db.getConversationMessages(convId)     │
│    ← [messages]                              │
└────┬─────────────────────────────────────────┘
     │
┌────▼─────────────────────────────────────────┐
│ 5. Build LLM Payload                         │
│    [                                         │
│      { role: "system", content: enhanced },  │
│      ...history,                             │
│      { role: "user", content: message }      │
│    ]                                         │
└────┬─────────────────────────────────────────┘
     │
┌────▼─────────────────────────────────────────┐
│ 6. Store User Message                        │
│    → db.createMessage({                      │
│        conversation_id,                      │
│        role: "user",                         │
│        content: message                      │
│      })                                      │
└────┬─────────────────────────────────────────┘
     │
┌────▼─────────────────────────────────────────┐
│ 7. Call Ollama LLM                           │
│    → POST http://localhost:11434/api/chat    │
│    ← { message, tokens, ... }                │
└────┬─────────────────────────────────────────┘
     │
┌────▼─────────────────────────────────────────┐
│ 8. Store Assistant Message                   │
│    → db.createMessage({                      │
│        conversation_id,                      │
│        role: "assistant",                    │
│        content: response                     │
│      })                                      │
└────┬─────────────────────────────────────────┘
     │
┌────▼─────────────────────────────────────────┐
│ 9. Store LLM Metadata                        │
│    → db.createLLMMetadata({                  │
│        message_id,                           │
│        tokens, latency, model, params        │
│      })                                      │
└────┬─────────────────────────────────────────┘
     │
┌────▼─────────────────────────────────────────┐
│ 10. Update Conversation Timestamp            │
│     → db.touchConversation(convId)          │
└────┬─────────────────────────────────────────┘
     │
┌────▼─────────────────────────────────────────┐
│ 11. Return Response                          │
│     {                                        │
│       conversationId,                        │
│       messageId,                             │
│       response,                              │
│       metadata: { tokens, latency, ... }     │
│     }                                        │
└────┬─────────────────────────────────────────┘
     │
┌────▼────┐
│ CLIENT  │
└─────────┘
```

## Memory Injection Flow

```
┌─────────────────────┐
│   User Profile      │
│   ─────────────     │
│   name: "Alice"     │
│   role: "Developer" │
│   style: "detailed" │
│   code: "heavy"     │
└─────────┬───────────┘
          │
          │ buildMemoryContext()
          │
          ▼
┌────────────────────────────────────────┐
│   Enhanced System Prompt               │
│   ─────────────────────                │
│   "You are AgentX...                   │
│                                        │
│   User Profile:                        │
│   User's name: Alice                   │
│   User's role: Developer               │
│   The user prefers detailed responses  │
│   The user prefers code-heavy examples"│
└────────┬───────────────────────────────┘
         │
         │ Sent to LLM
         │
         ▼
    ┌────────────┐
    │   OLLAMA   │
    │    LLM     │
    └────────────┘
```

## Feedback Flow

```
┌──────────┐
│ Assistant│
│ Message  │
└────┬─────┘
     │ messageId
     │
┌────▼──────────────────────────┐
│  User Action                  │
│  (Click thumbs up/down)       │
└────┬──────────────────────────┘
     │
     │ POST /api/feedback
     │ { messageId, rating, comment }
     │
┌────▼──────────────────────────┐
│  1. Validate Message Exists   │
│     → db.getMessage(id)       │
└────┬──────────────────────────┘
     │
┌────▼──────────────────────────┐
│  2. Store Feedback            │
│     → db.createFeedback({     │
│          message_id,          │
│          conversation_id,     │
│          rating,              │
│          comment              │
│        })                     │
└────┬──────────────────────────┘
     │
┌────▼──────────────────────────┐
│  3. Return Confirmation       │
│     { id, created_at, ... }   │
└────┬──────────────────────────┘
     │
┌────▼──────────────────────────┐
│  Future: n8n Automation       │
│  • Query feedback API         │
│  • Analyze patterns           │
│  • Improve prompts            │
│  • Update profiles            │
└───────────────────────────────┘
```

## File Organization

```
AgentX/
│
├── server.js              ← API endpoints & routing
│   ├── Legacy endpoints
│   ├── V1: Chat + logs
│   └── V2: Memory + feedback
│
├── db.js                  ← Database access layer
│   ├── User profile ops
│   ├── Conversation ops
│   ├── Message ops
│   ├── Metadata ops
│   └── Feedback ops
│
├── schema.sql             ← Database structure
│   ├── 5 tables
│   ├── Indexes
│   └── Relationships
│
├── data/
│   └── agentx.db         ← SQLite database (auto-created)
│
│   ├── Documentation (docs/)
│   │   ├── api/reference.md         ← API reference
│   │   ├── architecture/            ← Architecture guide & diagrams
│   │   ├── reports/                 ← Implementation reports
│   │   └── onboarding/              ← Quick start & guides
│
└── test-backend.sh        ← Automated tests
```

## Technology Stack

```
┌─────────────────────────────────┐
│         APPLICATION             │
├─────────────────────────────────┤
│  Node.js v18+                   │
│  Express v4.19                  │
│  ES6+ (async/await)             │
└─────────────────────────────────┘
                │
┌───────────────▼─────────────────┐
│         DATABASE                │
├─────────────────────────────────┤
│  SQLite3 v5.1.7                 │
│  Async wrapper (promisified)    │
│  WAL mode (better concurrency)  │
└─────────────────────────────────┘
                │
┌───────────────▼─────────────────┐
│        EXTERNAL APIs            │
├─────────────────────────────────┤
│  Ollama (localhost:11434)       │
│  node-fetch v2.7                │
└─────────────────────────────────┘
```

## Extension Points

```
Current Implementation
         │
         ├──► RAG Integration
         │    • Add vector store
         │    • Retrieve documents
         │    • Inject context
         │    • Track sources
         │
         ├──► Workflow Automation (n8n)
         │    • Query feedback API
         │    • Aggregate analytics
         │    • Trigger workflows
         │    • Auto-update profiles
         │
         ├──► Multi-Model Support
         │    • Add remote APIs
         │    • Model routing
         │    • Cost tracking
         │    • Performance comparison
         │
         └──► Advanced Features
              • Conversation branches
              • Message editing
              • Export/import
              • Analytics dashboard
```

---

**This diagram shows the complete architecture of the AgentX backend implementation.**

For detailed endpoint documentation, see `../api/reference.md`.
For implementation details, see `backend-overview.md`.
