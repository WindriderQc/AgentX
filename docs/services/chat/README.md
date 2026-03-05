# Chat Service

**Agent:** ChatAgent
**Status:** Active

## Responsibility
Core conversational AI pipeline — chat requests, streaming responses, tool/slash commands, image generation, conversation persistence and search, user profile/memory injection, voice I/O, agent context loading.

## File Inventory

### Services (src/services/)
| File | Lines | Purpose |
|------|-------|---------|
| chatService.js | 628 | Core chat orchestration with RAG/memory integration |
| chat/chatPromptHelpers.js | 56 | Prompt building utilities |
| chat/ragContextBuilder.js | 106 | Build RAG context and citations |
| chat/conversationPersistence.js | 165 | Persist conversations to MongoDB |
| chat/imageGeneration.js | 104 | Image generation integration |
| conversationSearchService.js | 543 | Semantic search over conversations |
| conversationJudge.js | 390 | Quality judgment for conversations |
| toolService.js | - | Slash command parser (/dataapi, etc.) |
| toolExecutor.js | - | Tool execution engine |
| agentService.js | 410 | Agent context loading and tool management |
| voiceService.js | 337 | Voice input/output processing |

### Routes (routes/)
| File | Lines | Purpose |
|------|-------|---------|
| api.js | 540 | Primary chat and conversation endpoints |
| history.js | 536 | Conversation history and search |
| profile.js | - | User profile management |
| voice.js | - | Voice input/output endpoints |
| tools.js | - | Tool/command execution |
| agents.js | 653 | Agent lifecycle management |

### Models (models/)
| File | Lines | Purpose |
|------|-------|---------|
| Conversation.js | 219 | Chat history with feedback, cost, RAG sources |
| UserProfile.js | 38 | User memory and preferences |
| AgentX.js | 366 | Agent definitions with tools and capabilities |
| Feedback.js | 310 | Message and conversation feedback |

### Frontend (public/js/)
- chat.js, chat.v2.js — Main chat interface
- persona-selector.js — Agent persona selection
- profile.js — User profile UI

## APIs Exposed
- `POST /api/chat` — Send message (sync + streaming SSE)
- `GET /api/history/conversations` — List conversations
- `GET /api/history/conversations/:id` — Get conversation
- `DELETE /api/history/conversations/:id` — Delete conversation
- `PATCH /api/history/conversations/:id` — Update conversation
- `GET/POST /api/profile` — User profile CRUD
- `POST /api/voice/*` — Voice input/output
- `GET/POST /api/tools/*` — Tool execution
- `GET/POST/PUT/DELETE /api/agents/*` — Agent CRUD

## Dependencies (Consumed)
| Service | Interface | What |
|---------|-----------|------|
| Model Management | `modelRouter.routeRequest()` | Route LLM inference requests |
| RAG & Knowledge | `ragStore.search()` | Retrieve relevant context |
| Prompt & Config | `PromptConfig.getActivePrompt()` | Get active system prompt |

## Data Ownership
Exclusive write access to: Conversation, UserProfile, AgentX, Feedback.
No other service may write to these collections.

## Key Patterns
- Streaming via SSE (Server-Sent Events)
- Tool commands bypass LLM — handled BEFORE LLM processing
- User memory always appended to system prompt, not message history
- Singleton pattern: conversation state managed per-request
