# V4 Analytics & Dataset API - Contract Documentation

**Version:** 1.0  
**Status:** Implemented ✅  
**Date:** 2024  
**Implementation:** Agent B  
**Specification:** specs/V4_ANALYTICS_ARCHITECTURE.md (Agent A)  

## Overview

V4 adds prompt versioning, analytics aggregations, and dataset export capabilities to AgentX. This enables automated prompt evolution loops where Agent C (n8n) can:

1. Monitor prompt performance via analytics endpoints
2. Identify failing prompts based on feedback metrics
3. Export training datasets filtered by quality
4. Generate and propose improved prompt versions
5. Activate new prompts for A/B testing

## Architecture Changes

### New Models

#### PromptConfig
```javascript
{
  name: String,              // "default_chat"
  version: Number,           // 1, 2, 3...
  systemPrompt: String,      // Actual prompt text
  description: String,       // Why this version exists
  status: enum,              // 'active' | 'deprecated' | 'proposed'
  author: String,            // 'system' | 'human' | 'n8n'
  createdAt: Date,
  updatedAt: Date
}

// Indexes:
// - Unique: (name, version)
// - Compound: (name, status)
```

#### Conversation (Extended)
```javascript
{
  // ... existing fields ...
  promptConfigId: ObjectId,  // Reference to PromptConfig
  promptName: String,        // Snapshot: "default_chat"
  promptVersion: Number      // Snapshot: 5
}

// New indexes:
// - createdAt
// - model + createdAt
// - promptConfigId
// - promptName + promptVersion
// - ragUsed
// - messages.feedback.rating
```

### Boot Logic

On server start, `config/db-mongodb.js` ensures a default prompt exists:
- Checks for active `default_chat` prompt
- Creates v1 if none exist with status='active'
- Logs active prompt info

### Chat Endpoint Changes

`POST /api/chat` now:
1. Fetches active PromptConfig via `PromptConfig.getActive('default_chat')`
2. Uses `activePrompt.systemPrompt` as base (overridable by req.body.system)
3. Stores `promptConfigId`, `promptName`, `promptVersion` in conversation

---

## API Endpoints

### 1. Analytics: Usage Stats

**Endpoint:** `GET /api/analytics/usage`

**Purpose:** Track conversation and message volumes

**Query Parameters:**
- `from` (ISO date, default: 7 days ago) - Start of date range
- `to` (ISO date, default: now) - End of date range
- `groupBy` (optional) - Breakdown dimension: `model` | `promptVersion` | `day`

**Response:**
```json
{
  "status": "success",
  "data": {
    "from": "2024-01-15T00:00:00.000Z",
    "to": "2024-01-22T00:00:00.000Z",
    "totalConversations": 142,
    "totalMessages": 458,
    "breakdown": [
      {
        "model": "llama3.2:latest",
        "conversations": 89,
        "messages": 312
      },
      {
        "model": "mistral:latest",
        "conversations": 53,
        "messages": 146
      }
    ]
  }
}
```

**Breakdown by `promptVersion`:**
```json
{
  "breakdown": [
    {
      "promptName": "default_chat",
      "promptVersion": 2,
      "conversations": 78,
      "messages": 256
    },
    {
      "promptName": "default_chat",
      "promptVersion": 1,
      "conversations": 64,
      "messages": 202
    }
  ]
}
```

**Breakdown by `day`:**
```json
{
  "breakdown": [
    {
      "date": "2024-01-15",
      "conversations": 18,
      "messages": 62
    },
    {
      "date": "2024-01-16",
      "conversations": 23,
      "messages": 81
    }
  ]
}
```

---

### 2. Analytics: Feedback Stats

**Endpoint:** `GET /api/analytics/feedback`

**Purpose:** Track user satisfaction via thumbs up/down ratings

**Query Parameters:**
- `from` (ISO date, default: 7 days ago)
- `to` (ISO date, default: now)
- `groupBy` (optional) - `promptVersion` | `model`

**Response:**
```json
{
  "status": "success",
  "data": {
    "from": "2024-01-15T00:00:00.000Z",
    "to": "2024-01-22T00:00:00.000Z",
    "totalFeedback": 87,
    "positive": 64,
    "negative": 23,
    "positiveRate": 0.7356,
    "breakdown": [
      {
        "promptName": "default_chat",
        "promptVersion": 2,
        "total": 52,
        "positive": 43,
        "negative": 9,
        "positiveRate": 0.8269
      },
      {
        "promptName": "default_chat",
        "promptVersion": 1,
        "total": 35,
        "positive": 21,
        "negative": 14,
        "positiveRate": 0.6
      }
    ]
  }
}
```

**Use Case for Agent C:**
- Monitor `positiveRate` per `promptVersion`
- If `positiveRate < 0.7` for N days → trigger prompt improvement workflow
- Compare v1 vs v2 to validate A/B test success

---

### 3. Analytics: RAG Performance

**Endpoint:** `GET /api/analytics/rag-stats`

**Purpose:** Compare response quality with/without RAG context

**Query Parameters:**
- `from` (ISO date, default: 7 days ago)
- `to` (ISO date, default: now)

**Response:**
```json
{
  "status": "success",
  "data": {
    "from": "2024-01-15T00:00:00.000Z",
    "to": "2024-01-22T00:00:00.000Z",
    "totalConversations": 142,
    "ragConversations": 58,
    "noRagConversations": 84,
    "ragUsageRate": 0.4085,
    "feedback": {
      "rag": {
        "total": 34,
        "positive": 29,
        "positiveRate": 0.8529
      },
      "noRag": {
        "total": 53,
        "positive": 35,
        "positiveRate": 0.6604
      }
    }
  }
}
```

**Use Case for Agent C:**
- If `rag.positiveRate > noRag.positiveRate` → recommend RAG for more queries
- If `rag.positiveRate < noRag.positiveRate` → investigate document quality

---

### 4. Dataset: Conversation Export

**Endpoint:** `GET /api/dataset/conversations`

**Purpose:** Export conversation examples for training/evaluation

**Query Parameters:**
- `limit` (number, default: 50, max: 500)
- `cursor` (string, conversationId for pagination)
- `minFeedback` (number) - Filter by rating:
  - `1` = positive feedback only
  - `-1` = negative feedback only
  - `0` = any feedback present
- `promptVersion` (number) - Filter by specific version
- `model` (string) - Filter by model name

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "id": "67a1b2c3d4e5f6789abcdef0",
      "model": "llama3.2:latest",
      "promptName": "default_chat",
      "promptVersion": 2,
      "ragUsed": true,
      "input": "What is the capital of France?",
      "output": "The capital of France is Paris.",
      "feedback": {
        "rating": 1,
        "comment": "Accurate and concise",
        "timestamp": "2024-01-20T14:32:15.000Z"
      },
      "metadata": {
        "conversationLength": 2,
        "createdAt": "2024-01-20T14:32:10.000Z",
        "ragSourceCount": 3
      }
    }
  ],
  "nextCursor": "67a1b2c3d4e5f6789abcdef9"
}
```

**Pagination:**
- Send `cursor` from previous response as query param
- `nextCursor: null` indicates last page

**Use Case for Agent C:**
- Export positive examples: `?minFeedback=1&limit=100`
- Export negative examples for error analysis: `?minFeedback=-1`
- Filter by prompt version: `?promptVersion=2`
- Build fine-tuning dataset from high-quality conversations

---

### 5. Dataset: Create Prompt (Proposal)

**Endpoint:** `POST /api/dataset/prompts`

**Purpose:** Create new prompt configuration (typically from n8n auto-generation)

**Request Body:**
```json
{
  "name": "default_chat",
  "version": 3,
  "systemPrompt": "You are AgentX v3, optimized for accuracy and brevity based on user feedback analysis.",
  "description": "Improved version based on 87% positive feedback from v2 users",
  "status": "proposed",
  "author": "n8n"
}
```

**Required Fields:**
- `name` (string) - Prompt family name
- `version` (number) - Incremental version number
- `systemPrompt` (string) - The actual prompt text

**Optional Fields:**
- `description` (string, default: "Auto-generated version N")
- `status` (string, default: "proposed") - `proposed` | `active` | `deprecated`
- `author` (string, default: "n8n") - Creator identifier

**Response:**
```json
{
  "status": "success",
  "data": {
    "_id": "67a1b2c3d4e5f6789abcdef1",
    "name": "default_chat",
    "version": 3,
    "systemPrompt": "You are AgentX v3...",
    "description": "Improved version based on feedback",
    "status": "proposed",
    "author": "n8n",
    "createdAt": "2024-01-22T10:15:30.000Z",
    "updatedAt": "2024-01-22T10:15:30.000Z"
  }
}
```

**Error Cases:**
- `400` - Missing required fields (name, version, systemPrompt)
- `409` - Version already exists for this prompt name

**Use Case for Agent C:**
1. Analyze feedback metrics via `/api/analytics/feedback`
2. If performance degraded, use LLM to generate improved prompt
3. POST new version with `status: 'proposed'`
4. Wait for human approval or automated validation
5. Activate via PATCH endpoint (see below)

---

### 6. Dataset: List Prompts

**Endpoint:** `GET /api/dataset/prompts`

**Purpose:** List all prompt configurations with filtering

**Query Parameters:**
- `name` (string) - Filter by prompt name
- `status` (string) - Filter by status: `active` | `deprecated` | `proposed`

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "_id": "67a1b2c3d4e5f6789abcdef0",
      "name": "default_chat",
      "version": 2,
      "systemPrompt": "You are AgentX v2...",
      "description": "Improved conciseness",
      "status": "active",
      "author": "human",
      "createdAt": "2024-01-15T08:00:00.000Z",
      "updatedAt": "2024-01-20T10:30:00.000Z"
    },
    {
      "_id": "67a1b2c3d4e5f6789abcdef1",
      "name": "default_chat",
      "version": 1,
      "systemPrompt": "You are AgentX, an efficient local AI assistant.",
      "description": "Initial default system prompt",
      "status": "deprecated",
      "author": "system",
      "createdAt": "2024-01-10T12:00:00.000Z",
      "updatedAt": "2024-01-15T08:00:00.000Z"
    }
  ]
}
```

**Use Case for Agent C:**
- List active prompts: `?status=active`
- List pending proposals: `?status=proposed`
- Audit full version history: `?name=default_chat`

---

### 7. Dataset: Activate Prompt

**Endpoint:** `PATCH /api/dataset/prompts/:id/activate`

**Purpose:** Activate a prompt (sets status='active', deprecates others with same name)

**URL Parameters:**
- `id` (string) - PromptConfig _id to activate

**Response:**
```json
{
  "status": "success",
  "data": {
    "_id": "67a1b2c3d4e5f6789abcdef1",
    "name": "default_chat",
    "version": 3,
    "systemPrompt": "You are AgentX v3...",
    "description": "Improved version based on feedback",
    "status": "active",
    "author": "n8n",
    "createdAt": "2024-01-22T10:15:30.000Z",
    "updatedAt": "2024-01-22T10:45:12.000Z"
  }
}
```

**Behavior:**
1. Finds prompt by ID
2. Sets ALL other prompts with same `name` and status='active' → 'deprecated'
3. Sets target prompt status='active'
4. Returns activated prompt

**Use Case for Agent C:**
1. Create new prompt via POST endpoint (status='proposed')
2. Run validation tests
3. If successful, activate: `PATCH /api/dataset/prompts/<id>/activate`
4. Monitor analytics to compare with previous version

---

## Agent C (n8n) Integration Guide

### Prompt Evolution Workflow

**1. Monitor Phase** (runs every 6 hours)
```
Trigger: Schedule (every 6h)
↓
HTTP Request: GET /api/analytics/feedback?groupBy=promptVersion
↓
Check: activePrompt.positiveRate < 0.7 AND totalFeedback > 30
↓
If YES → Trigger Improvement Workflow
```

**2. Dataset Collection Phase**
```
HTTP Request: GET /api/dataset/conversations?minFeedback=-1&promptVersion=<activeVersion>&limit=50
↓
Extract negative examples (input, output, feedback.comment)
↓
Build context document with failure patterns
```

**3. Prompt Generation Phase**
```
Call LLM API (e.g., Ollama, OpenAI) with prompt:
---
System: You are a prompt engineer. Analyze these failed interactions and suggest an improved system prompt.

Context:
- Current prompt version: 2
- Positive rate: 68% (target: >75%)
- Common issues: [analyzed from negative feedback]

Failed Examples:
<paste negative conversation exports>

Generate an improved system prompt that addresses these issues while maintaining the core AgentX personality.
---
↓
LLM returns improved prompt text
```

**4. Proposal Creation Phase**
```
HTTP Request: POST /api/dataset/prompts
Body: {
  "name": "default_chat",
  "version": 3,
  "systemPrompt": "<LLM-generated prompt>",
  "description": "Auto-improved: addressed negative feedback from v2",
  "status": "proposed",
  "author": "n8n"
}
↓
Store proposed prompt ID
```

**5. Validation Phase** (optional)
```
Run test conversations with proposed prompt
↓
Calculate test metrics
↓
If testPositiveRate > currentPositiveRate → proceed to activation
```

**6. Activation Phase**
```
HTTP Request: PATCH /api/dataset/prompts/<proposedId>/activate
↓
Log activation event
↓
Send notification to admin
```

**7. A/B Testing Phase** (next cycle)
```
Wait 24-48 hours
↓
HTTP Request: GET /api/analytics/feedback?groupBy=promptVersion
↓
Compare v2 vs v3 metrics
↓
If v3.positiveRate > v2.positiveRate → Success!
If v3.positiveRate < v2.positiveRate → Rollback (activate v2 again)
```

---

## Testing

Run the comprehensive test suite:
```bash
./test-v4-analytics.sh [BASE_URL] [OLLAMA_HOST]

# Example:
./test-v4-analytics.sh http://localhost:3080 192.168.2.99:11434
```

Tests include:
- ✅ Health check
- ✅ Chat with prompt versioning
- ✅ Usage analytics (overall, by model, by promptVersion, by day)
- ✅ Feedback analytics (overall, by promptVersion, by model)
- ✅ RAG performance comparison
- ✅ Conversation dataset export with filters
- ✅ Prompt listing (all, by status)
- ✅ Prompt creation (proposal)
- ✅ Date range filtering

---

## Database Schema

### Collections

1. **promptconfigs**
   - Stores all prompt versions
   - Indexed on (name, version) unique and (name, status)

2. **conversations** (extended)
   - Links to active prompt via promptConfigId
   - Snapshots promptName + promptVersion for historical queries
   - Indexed on createdAt, model, promptVersion, feedback.rating for aggregations

---

## Notes for Agent C

### Best Practices

1. **Rate Limiting**: Don't poll analytics too frequently (every 6-24h is reasonable)

2. **Minimum Sample Size**: Only trigger improvements when `totalFeedback > 30` to avoid noise

3. **Prompt Versioning**: Always increment version numbers. Never reuse versions.

4. **Status Workflow**: 
   - Create → `proposed` (for review)
   - Test → `proposed` (validation phase)
   - Deploy → `active` (via PATCH activate)
   - Archive → `deprecated` (automatic when new version activated)

5. **Rollback Strategy**: Keep previous version for 7 days before marking deprecated

6. **Feedback Loop**: Monitor new version for 24-48h before declaring success

### Error Handling

- **500 Errors**: Database connectivity issues, retry with exponential backoff
- **409 Errors**: Version conflict, increment version number and retry
- **400 Errors**: Validation failure, check required fields

### Performance

- Analytics endpoints use database indexes for fast aggregation
- Conversation export uses cursor pagination for large datasets
- Typical response times: <100ms for analytics, <500ms for exports

---

## Changelog

### v1.0 (2024-01-22)
- ✅ Implemented PromptConfig model with versioning
- ✅ Extended Conversation model with prompt tracking
- ✅ Added 6 database indexes for analytics performance
- ✅ Implemented 3 analytics endpoints (usage, feedback, rag-stats)
- ✅ Implemented 4 dataset endpoints (conversations export, prompts CRUD)
- ✅ Added boot logic for default prompt initialization
- ✅ Updated chat endpoint to use active PromptConfig
- ✅ Created comprehensive test suite

---

## Support

For issues or questions about V4 APIs:
1. Check this contract document
2. Review `specs/V4_ANALYTICS_ARCHITECTURE.md` (Agent A's specification)
3. Run `./test-v4-analytics.sh` to verify endpoint behavior
4. Check MongoDB indexes: `db.conversations.getIndexes()`
5. Monitor server logs for V4-tagged messages: `[V4]`

---

**End of V4 Contract Documentation**
