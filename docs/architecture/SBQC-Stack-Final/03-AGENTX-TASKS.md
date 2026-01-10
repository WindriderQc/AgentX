# 03 - AgentX Tasks

**Repository:** https://github.com/WindriderQc/AgentX  
**Running at:** http://192.168.2.33:3080  
**Database:** MongoDB `agentx` @ 192.168.2.33:27017  
**Version:** 1.3.1

📖 **See Also:**  
→ [07-AGENTX-API-REFERENCE.md](07-AGENTX-API-REFERENCE.md) - Complete API documentation with all 40+ endpoints  
→ [05-DEPLOYMENT.md](05-DEPLOYMENT.md#environment-variables-reference) - Environment configuration guide

---

## Current State Summary

AgentX is **fully implemented** with all 5 priorities complete:

### Core Features
- ✅ V1: Chat + Conversations + Memory
- ✅ V2: User Profiles + Feedback
- ✅ V3: RAG (ingest, search, chat integration)
- ✅ V4: Analytics + Dataset Export
- ✅ n8n integration routes (`/api/n8n/*`)
- ✅ Frontend UI

### Priority Features (All Complete)
- ✅ **Priority 1:** SBQC Ops Agent - 8 tools, `sbqc_ops` persona
- ✅ **Priority 2:** Datalake Janitor - 12 tools, `datalake_janitor` persona
- ✅ **Priority 3:** Multi-Model Routing - `modelRouter.js`, task-based routing
- ✅ **Priority 4:** Voice I/O - `voiceService.js`, `/api/voice/*` routes
- ✅ **Priority 5:** Self-Improving Loop - A/B testing, feedback analytics

### New Files Created
| File | Purpose |
|------|---------|
| `src/services/modelRouter.js` | Multi-model routing with task classification |
| `src/services/voiceService.js` | STT (Whisper) + TTS with fallbacks |
| `routes/voice.js` | Voice API endpoints |
| `routes/prompts.js` | Prompt CRUD and A/B testing |
| `models/Feedback.js` | Feedback storage with aggregation methods |

### Test Coverage
- `tests/services/modelRouter.test.js`
- `tests/services/voiceService.test.js`
- `tests/integration/prompts.test.js`
- `tests/integration/voice.test.js`
- `tests/integration/analytics-feedback.test.js`

---

## Phase 0: Validation & Testing (Priority 1)

### Task A0.1: Chat Endpoint Validation
**Context:** `routes/api.js`, `src/services/chatService.js`

```bash
# Test basic chat:
curl -X POST http://192.168.2.33:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "message": "Hello, how are you?",
    "target": "192.168.2.99:11434"
  }'
```

**Acceptance Criteria:**
- [ ] Chat works with Qwen on UGFrank (192.168.2.99)
- [ ] Chat works with Llama on UGBrutal (192.168.2.12)
- [ ] Conversation is persisted to MongoDB
- [ ] Response includes `conversationId`

---

### Task A0.2: User Profile & Memory Validation
**Context:** `routes/profile.js`, `models/UserProfile.js`

> 📖 **Full API docs:** [07-AGENTX-API-REFERENCE.md#user-profile--feedback](07-AGENTX-API-REFERENCE.md#user-profile--feedback)

```bash
# Get profile:
curl http://192.168.2.33:3080/api/profile?userId=testuser

# Update profile:
curl -X POST http://192.168.2.33:3080/api/profile \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "testuser",
    "displayName": "Test User",
    "preferences": {"language": "en", "style": "concise"},
    "memory": "User prefers code examples in Python."
  }'
```

**Acceptance Criteria:**
- [ ] Profile CRUD works
- [ ] Memory is injected into system prompt during chat
- [ ] Preferences are respected

---

### Task A0.3: RAG Validation
**Context:** `routes/rag.js`, `src/services/ragStore.js`, `src/services/embeddings.js`

```bash
# Ingest document:
curl -X POST http://192.168.2.33:3080/api/rag/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "source": "test",
    "title": "Test Document",
    "text": "This is a test document about retrieval-augmented generation.",
    "path": "test.txt"
  }'

# Search:
curl -X POST http://192.168.2.33:3080/api/rag/search \
  -H "Content-Type: application/json" \
  -d '{"query": "What is RAG?", "topK": 5}'

# Chat with RAG:
curl -X POST http://192.168.2.33:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "message": "What is retrieval-augmented generation?",
    "useRag": true,
    "ragTopK": 3,
    "target": "192.168.2.99:11434"
  }'
```

**Acceptance Criteria:**
- [ ] Document ingestion works (uses Ollama embeddings)
- [ ] Search returns relevant chunks
- [ ] Chat with `useRag: true` includes RAG context
- [ ] Response includes `ragUsed: true` and `ragSources`

---

### Task A0.4: Feedback Validation
**Context:** `routes/api.js`

```bash
# Submit feedback (need a valid messageId from a conversation):
curl -X POST http://192.168.2.33:3080/api/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "<CONV_ID>",
    "messageId": "<MSG_ID>",
    "rating": 1,
    "comment": "Great answer!"
  }'
```

**Acceptance Criteria:**
- [ ] Feedback is stored on the message
- [ ] Rating is 1 (positive) or -1 (negative)
- [ ] Can retrieve feedback via analytics endpoints

---

### Task A0.5: Analytics & Dataset Validation
**Context:** `routes/analytics.js`, `routes/dataset.js`

```bash
# Usage stats:
curl http://192.168.2.33:3080/api/analytics/usage

# Feedback stats:
curl http://192.168.2.33:3080/api/analytics/feedback

# RAG stats:
curl http://192.168.2.33:3080/api/analytics/rag-stats

# Export conversations:
curl http://192.168.2.33:3080/api/dataset/conversations?limit=10
```

**Acceptance Criteria:**
- [ ] Usage returns conversation/message counts
- [ ] Feedback returns positive/negative rates
- [ ] RAG stats compares RAG vs non-RAG performance
- [ ] Dataset export returns training-ready format

---

### Task A0.6: n8n Routes Validation
**Context:** `routes/n8n.js`

```bash
# Diagnostic:
curl -H "x-api-key: YOUR_KEY" http://192.168.2.33:3080/api/n8n/diagnostic

# Trigger event:
curl -X POST -H "x-api-key: YOUR_KEY" -H "Content-Type: application/json" \
  http://192.168.2.33:3080/api/n8n/event/rag_ingest \
  -d '{"documentId": "test", "source": "n8n"}'
```

**Acceptance Criteria:**
- [ ] Diagnostic endpoint responds
- [ ] Event triggers work for rag_ingest, chat_complete, etc.
- [ ] API key authentication works

---

## Phase 1: SBQC Ops Agent Support (Priority 1)

### Task A1.1: SBQC Ops Agent Persona
**New Feature:** Create a specialized agent persona for infrastructure monitoring.

**Implementation:**
1. Add a PromptConfig entry for "sbqc_ops" persona
2. Define system prompt with infrastructure focus
3. Enable via `persona` parameter in chat

```javascript
// Example PromptConfig document:
{
  name: "sbqc_ops",
  systemPrompt: `You are SBQC Ops, an AI infrastructure monitoring agent.
Your responsibilities:
- Monitor system health (DataAPI, AgentX, Ollama hosts, MongoDB)
- Report on storage status and file scans
- Suggest maintenance actions
- Log all actions to the integration sink

You have access to these HTTP tools:
- GET DataAPI /api/v1/storage/scans - List storage scans
- GET DataAPI /api/v1/system/health - Aggregated system health (to be built)
- GET DataAPI /api/v1/storage/summary - Storage overview (to be built)
- POST DataAPI /integrations/events/n8n - Log actions
- GET AgentX /api/n8n/health - Check AgentX n8n API health

Always respond in a structured format suitable for automation.`,
  isActive: false,
  version: 1
}
```

**Acceptance Criteria:**
- [ ] SBQC Ops persona exists in PromptConfig
- [ ] Can be activated via chat parameters
- [ ] System prompt includes tool descriptions

---

### Task A1.2: Tool Execution Framework (MCP-Style)
**New Feature:** Allow the chat to execute HTTP calls to DataAPI.

**Approach:** Extend chat with tool use pattern

```javascript
// In chatService.js, add tool detection and execution:

const AVAILABLE_TOOLS = {
  'dataapi.health': {
    method: 'GET',
    url: `${process.env.DATAAPI_BASE_URL}/health`,
    headers: { 'x-api-key': process.env.DATAAPI_API_KEY }
  },
  'dataapi.storage_summary': {
    method: 'GET',
    url: `${process.env.DATAAPI_BASE_URL}/api/v1/storage/summary`,
    headers: { 'x-api-key': process.env.DATAAPI_API_KEY }
  },
  'dataapi.storage_scans': {
    method: 'GET',
    url: `${process.env.DATAAPI_BASE_URL}/api/v1/storage/scans`,
    headers: { 'x-api-key': process.env.DATAAPI_API_KEY }
  }
  // ... more tools
};

// Detect tool calls in assistant response
// Execute tool and inject result back into conversation
```

**Acceptance Criteria:**
- [ ] Agent can request tool execution via structured output
- [ ] Tools execute and return results
- [ ] Results are injected into next message

---

### Task A1.3: Health Dashboard Data Endpoint
**New Endpoint:** `GET /api/dashboard/health`

Aggregates health info for a frontend dashboard.

**Response:**
```json
{
  "status": "success",
  "data": {
    "agentx": {"status": "ok", "uptime": 86400, "memory": {}},
    "mongodb": {"status": "connected", "collections": 4},
    "ollama": {
      "192.168.2.99": {"status": "online", "models": 2},
      "192.168.2.12": {"status": "online", "models": 4}
    },
    "dataapi": {"status": "ok"},
    "lastCheck": "2025-12-26T10:00:00Z"
  }
}
```

---

## Phase 2: Datalake Janitor Integration (Priority 2)

### Task A2.1: File Search Tool for Chat
**New Feature:** Allow chat to search files via RAG or direct query.

**Chat Parameter:** `tools: ["file.search"]`

```javascript
// Tool definition:
{
  name: "file.search",
  description: "Search for files by name, type, or content metadata",
  parameters: {
    query: "search string",
    extension: "optional file extension filter",
    minSize: "optional minimum size",
    maxSize: "optional maximum size"
  },
  execute: async (params) => {
    // Call DataAPI /api/v1/files/browse
    // Return results
  }
}
```

**Acceptance Criteria:**
- [ ] Agent can search files via natural language
- [ ] Results are formatted for readability
- [ ] Supports filters

---

### Task A2.2: Dedupe Suggestion Tool
**New Feature:** Allow chat to get and act on dedupe suggestions.

**Tool:** `dedupe.suggest`

```javascript
{
  name: "dedupe.suggest",
  description: "Get duplicate file cleanup suggestions",
  parameters: {
    minSavings: "minimum bytes to consider",
    limit: "max suggestions to return"
  },
  execute: async (params) => {
    // Call DataAPI /api/v1/files/dedupe/suggestions
  }
}
```

**Tool:** `dedupe.approve`

```javascript
{
  name: "dedupe.approve",
  description: "Approve deletion of duplicate files",
  parameters: {
    groupId: "dedupe group to approve",
    filesToDelete: ["paths to delete"]
  },
  execute: async (params) => {
    // Mark files for deletion (soft delete first)
    // Log action to integration sink
  }
}
```

**Acceptance Criteria:**
- [ ] Agent can get dedupe suggestions
- [ ] Agent can approve deletions (with confirmation)
- [ ] All actions are logged

---

### Task A2.3: File RAG Integration
**Enhancement:** Ingest file metadata into RAG for semantic file search.

**Approach:**
1. n8n workflow exports file metadata to AgentX RAG
2. Each file becomes a document with path, name, size, type
3. Users can ask "find videos about cooking" → semantic search

**Acceptance Criteria:**
- [ ] File metadata can be ingested via `/api/rag/ingest`
- [ ] Semantic search returns relevant files
- [ ] Chat can use this for natural language file queries

---

## Phase 3: Multi-Model Routing (Priority 3)

### Task A3.1: Model Router Service
**New Service:** `src/services/modelRouter.js`

Routes requests to appropriate Ollama host based on model/task.

```javascript
const MODEL_ROUTING = {
  // Quick queries → UGFrank (99)
  'qwen2.5:7b': '192.168.2.99:11434',
  'qwen2.5:3b': '192.168.2.99:11434',
  
  // Heavy tasks → UGBrutal (12)
  'llama3.3:70b': '192.168.2.12:11434',
  'deepseek-r1:32b': '192.168.2.12:11434',
  'gemma3:12b': '192.168.2.12:11434',
  
  // Embeddings always on 12
  'nomic-embed-text': '192.168.2.12:11434'
};

function getTargetForModel(model) {
  return MODEL_ROUTING[model] || process.env.OLLAMA_HOST;
}

function getTargetForTask(taskType) {
  switch(taskType) {
    case 'quick_chat': return '192.168.2.99:11434';
    case 'code_generation': return '192.168.2.12:11434';
    case 'reasoning': return '192.168.2.12:11434';
    case 'vision': return '192.168.2.12:11434';
    default: return '192.168.2.99:11434';
  }
}
```

**Acceptance Criteria:**
- [ ] Router determines target based on model name
- [ ] Router determines target based on task type
- [ ] Fallback to default if unknown

---

### Task A3.2: Front-Door Routing
**Enhancement:** Qwen as front-door that routes complex queries.

**Concept:**
1. All queries first go to Qwen 2.5 7B (fast)
2. Qwen classifies: simple (answer directly) or complex (route to specialist)
3. Complex queries are forwarded with classification

**Implementation:**
```javascript
// In chatService.js:

async function classifyQuery(message) {
  const classificationPrompt = `Classify this query:
- simple: Can be answered quickly with general knowledge
- code: Requires code generation or review
- reasoning: Requires deep analysis or multi-step thinking
- vision: Involves image analysis (if image attached)

Query: ${message}
Classification:`;

  const result = await callOllama('qwen2.5:7b', classificationPrompt, '192.168.2.99:11434');
  return result.trim().toLowerCase();
}
```

**Acceptance Criteria:**
- [ ] Queries are classified before routing
- [ ] Simple queries answered by Qwen directly
- [ ] Complex queries routed to specialist models

---

### Task A3.3: Model Health Monitoring
**New Feature:** Track model availability and latency.

**Storage:** MongoDB `agentx.model_health`

**Data:**
```json
{
  "host": "192.168.2.12:11434",
  "model": "llama3.3:70b",
  "status": "available",
  "lastCheck": "2025-12-26T10:00:00Z",
  "avgLatency": 2500,
  "errorRate": 0.01
}
```

**Acceptance Criteria:**
- [ ] Regular health checks (via n8n or internal scheduler)
- [ ] Latency tracking per model
- [ ] Failover if model unavailable

---

## Phase 4: Voice I/O (Priority 4)

### Task A4.1: Whisper Integration
**New Endpoint:** `POST /api/voice/transcribe`

Accepts audio, returns transcription via Whisper.

**Implementation:**
```javascript
// routes/voice.js

router.post('/transcribe', upload.single('audio'), async (req, res) => {
  const audioBuffer = req.file.buffer;
  
  // Call Ollama Whisper or external Whisper API
  const transcription = await whisperTranscribe(audioBuffer);
  
  res.json({
    status: 'success',
    data: { text: transcription }
  });
});
```

**Acceptance Criteria:**
- [ ] Audio upload works
- [ ] Whisper model processes audio
- [ ] Text returned

---

### Task A4.2: Voice Chat Flow
**Enhancement:** Combine transcribe → chat → TTS

**New Endpoint:** `POST /api/voice/chat`

**Flow:**
1. Receive audio
2. Transcribe with Whisper
3. Send to chat API
4. (Optional) Convert response to speech
5. Return text + audio

**Acceptance Criteria:**
- [ ] Full voice → text → response flow works
- [ ] TTS is optional (can return text only first)

---

## Phase 5: Self-Improving Loop (Priority 5)

### Task A5.1: Feedback Aggregation Dashboard
**Enhancement:** Aggregate feedback for analysis.

**New Endpoint:** `GET /api/analytics/feedback/summary`

```json
{
  "status": "success",
  "data": {
    "overall": {
      "totalFeedback": 500,
      "positiveRate": 0.78
    },
    "byModel": {
      "qwen2.5:7b": {"positive": 120, "negative": 30, "rate": 0.80},
      "llama3.3:70b": {"positive": 200, "negative": 50, "rate": 0.80}
    },
    "byPromptVersion": {
      "1": {"positive": 150, "negative": 50},
      "2": {"positive": 170, "negative": 30}
    },
    "lowPerformingPrompts": [
      {"name": "code_review", "version": 1, "positiveRate": 0.55}
    ]
  }
}
```

**Acceptance Criteria:**
- [ ] Aggregates feedback across dimensions
- [ ] Identifies low-performing prompts
- [ ] Supports date range filtering

---

### Task A5.2: Prompt A/B Testing
**Enhancement:** Track prompt version performance.

**Approach:**
1. Multiple prompt versions in PromptConfig
2. Randomly assign version to new conversations
3. Track feedback by version
4. Report winning version

**Acceptance Criteria:**
- [ ] Multiple prompt versions can coexist
- [ ] Traffic split is configurable
- [ ] Analytics report per-version performance

---

### Task A5.3: n8n Prompt Optimization Workflow
**Integration:** n8n workflow that analyzes feedback and suggests improvements.

**Workflow:**
1. Schedule: Weekly
2. Call `/api/analytics/feedback/summary`
3. Identify underperforming prompts
4. (Optional) Use AI to suggest improvements
5. Create new prompt version draft
6. Alert admin for review

**Acceptance Criteria:**
- [ ] Automated analysis runs
- [ ] Suggestions generated
- [ ] Human approval required before activation

---

## Task Summary Table

| ID | Task | Priority | Depends On | Complexity |
|----|------|----------|------------|------------|
| A0.1 | Chat validation | 1 | - | Low |
| A0.2 | Profile validation | 1 | - | Low |
| A0.3 | RAG validation | 1 | Ollama up | Medium |
| A0.4 | Feedback validation | 1 | A0.1 | Low |
| A0.5 | Analytics validation | 1 | A0.4 | Low |
| A0.6 | n8n routes validation | 1 | - | Low |
| A1.1 | SBQC Ops persona | 1 | A0.1 | Medium |
| A1.2 | Tool execution | 1 | A1.1, D1.1 | High |
| A1.3 | Health dashboard | 1 | A1.2 | Medium |
| A2.1 | File search tool | 2 | D0.3 | Medium |
| A2.2 | Dedupe tool | 2 | D2.4 | Medium |
| A2.3 | File RAG | 2 | A0.3 | Medium |
| A3.1 | Model router | 3 | - | Medium |
| A3.2 | Front-door routing | 3 | A3.1 | High |
| A3.3 | Model health | 3 | A3.1 | Medium |
| A4.1 | Whisper integration | 4 | - | Medium |
| A4.2 | Voice chat flow | 4 | A4.1 | High |
| A5.1 | Feedback dashboard | 5 | A0.5 | Medium |
| A5.2 | A/B testing | 5 | A5.1 | High |
| A5.3 | Optimization workflow | 5 | A5.2, n8n | High |

---

## Agent Instructions

When working on AgentX tasks:

1. **Check existing patterns** - Review `routes/api.js` and `src/services/chatService.js`
2. **Use proper logging** - Import and use `config/logger.js`
3. **Follow API contract** - Match documented response schemas
4. **Test with frontend** - Verify changes work in browser UI
5. **Update docs** - Keep `docs/api/reference.md` current
