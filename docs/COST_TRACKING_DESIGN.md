# AgentX Cost Tracking Schema & Pricing Design

**Document Status:** Design Specification (Pre-Implementation)
**Last Updated:** 2026-01-01
**Version:** 1.0

---

## Executive Summary

This document defines a **production-ready cost tracking system** for AgentX that enables:
- **Per-model pricing** with flexible configuration (prompt vs completion token costs)
- **Historical cost calculation** for conversations created before pricing was configured
- **Cost aggregation** across all analytics endpoints
- **Multi-currency support** (future-proof, USD default)
- **Environment-based configuration** with MongoDB fallback for model-specific pricing

---

## 1. Research Summary: Industry Pricing Models

### 1.1 Ollama Models (Local - $0 Direct Cost)
Ollama runs local open-source models (Llama 3, Mistral, Qwen, etc.). While free to run, we track:
- **Computational cost** (GPU time, energy) via token-based metrics
- **Embedding cost** (nomic-embed-text for RAG)
- **Use case:** Internal R&D, cost control comparison

### 1.2 Commercial LLM Pricing Patterns

| Provider | Prompt Tokens | Completion Tokens | Notes |
|----------|---------------|-------------------|-------|
| OpenAI (GPT-4o) | $5/$1M | $15/$1M | Asymmetric (completion ~3x) |
| OpenAI (GPT-4 Turbo) | $10/$1M | $30/$1M | Higher tier, larger contexts |
| Anthropic (Claude 3 Opus) | $15/$1M | $75/$1M | Thinking models cost 3x+ |
| Anthropic (Claude 3 Haiku) | $0.25/$1M | $1.25/$1M | Small/fast models, 5x ratio |
| Google (Gemini 1.5 Pro) | $7.50/$1M | $30/$1M | 4x ratio for completions |

**Key Insight:** Completion tokens cost **3-5x more** than prompt tokens across all providers.

### 1.3 Embedding Costs

| Provider | Cost | Notes |
|----------|------|-------|
| OpenAI (text-embedding-3-small) | $0.02/$1M | 1536-dim vectors |
| Cohere | $0.10/$1M | Higher quality |
| Local (Ollama nomic-embed-text) | $0 | 768-dim, no latency |

---

## 2. Environment Variable Schema

### 2.1 Configuration Variables

Add to `.env.example` and document in `05-DEPLOYMENT.md`:

```bash
# =====================================================
# COST TRACKING CONFIGURATION
# =====================================================

# Enable cost tracking (true/false, default: true)
COST_TRACKING_ENABLED=true

# Currency (USD/EUR/GBP, default: USD)
COST_CURRENCY=USD

# Default pricing (per million tokens, fallback if model not found)
# Format: COST_PER_1M_TOKENS for local models
# Local Ollama models (free inference, but track computational cost)
OLLAMA_DEFAULT_PROMPT_COST_PER_1M=0.00
OLLAMA_DEFAULT_COMPLETION_COST_PER_1M=0.00

# Model-specific pricing (format: MODEL_NAME_PROMPT/COMPLETION_COST_PER_1M)
# Example: costs per million tokens
# Ollama models
OLLAMA_LLAMA3_PROMPT_COST_PER_1M=0.00
OLLAMA_LLAMA3_COMPLETION_COST_PER_1M=0.00

OLLAMA_MISTRAL_PROMPT_COST_PER_1M=0.00
OLLAMA_MISTRAL_COMPLETION_COST_PER_1M=0.00

OLLAMA_QWEN_PROMPT_COST_PER_1M=0.00
OLLAMA_QWEN_COMPLETION_COST_PER_1M=0.00

OLLAMA_DEEPSEEK_R1_PROMPT_COST_PER_1M=0.00
OLLAMA_DEEPSEEK_R1_COMPLETION_COST_PER_1M=0.00

# OpenAI models (if integrated in future)
OPENAI_GPT4_PROMPT_COST_PER_1M=5.00
OPENAI_GPT4_COMPLETION_COST_PER_1M=15.00

# Anthropic models (if integrated in future)
ANTHROPIC_CLAUDE3_OPUS_PROMPT_COST_PER_1M=15.00
ANTHROPIC_CLAUDE3_OPUS_COMPLETION_COST_PER_1M=75.00

# Embedding costs (per million tokens)
EMBEDDING_COST_PER_1M=0.00

# For internal bookkeeping: assign computational cost to local models
# Set to 0.0001 = $0.1 per million tokens to track internal compute
OLLAMA_COMPUTATIONAL_COST_PER_1M=0.00

# Historic data handling (see section 3.4)
# Default cost when pricing not configured for a model
# Use this for conversations created before pricing setup
DEFAULT_FALLBACK_PROMPT_COST_PER_1M=0.00
DEFAULT_FALLBACK_COMPLETION_COST_PER_1M=0.00
```

### 2.2 Environment Variable Parsing Logic

**Naming Convention:**
```
{PROVIDER}_{MODEL_NAME}_{TOKEN_TYPE}_COST_PER_1M

Where:
  {PROVIDER} = OLLAMA, OPENAI, ANTHROPIC, etc.
  {MODEL_NAME} = Normalized model name (spaces → underscores, lowercase)
  {TOKEN_TYPE} = PROMPT or COMPLETION
  Per million tokens (1M = 1,000,000)
```

**Examples:**
```
OLLAMA_LLAMA3_PROMPT_COST_PER_1M=0.00
OLLAMA_DEEPSEEK_R1_COMPLETION_COST_PER_1M=0.00
OPENAI_GPT4_TURBO_PROMPT_COST_PER_1M=10.00
```

**Fallback Resolution Order:**
1. Check model-specific env var: `{PROVIDER}_{MODEL_NAME}_PROMPT_COST_PER_1M`
2. Check default for provider: `{PROVIDER}_DEFAULT_PROMPT_COST_PER_1M`
3. Check global default: `DEFAULT_FALLBACK_PROMPT_COST_PER_1M`
4. Return 0.00 (no cost if nothing configured)

---

## 3. Database Schema

### 3.1 New Model: ModelPricingConfig

**File:** `/models/ModelPricingConfig.js`

**Purpose:** Persist pricing configurations to MongoDB as alternative to environment variables (supports multi-tenant, dynamic pricing updates without redeployment)

```javascript
{
  _id: ObjectId,

  // Identifying model
  provider: String,          // 'ollama', 'openai', 'anthropic', etc.
  modelName: String,         // Exact model name as used in chat API
  displayName: String,       // User-friendly name (e.g. "Llama 3")

  // Pricing (per million tokens)
  pricing: {
    promptTokenCost: Number,     // $/1M tokens
    completionTokenCost: Number, // $/1M tokens
    embeddingCost: Number        // $/1M tokens (if applicable)
  },

  // Metadata
  isActive: Boolean,         // true = use in calculations, false = deprecated
  currency: String,          // 'USD' (default), 'EUR', 'GBP'
  source: String,            // 'environment', 'manual', 'provider-api'
  notes: String,             // e.g. "Updated Jan 2026 per provider pricing"
  effectiveDate: Date,       // When this pricing became effective
  expiryDate: Date,          // Optional: when to stop using this pricing

  // Audit trail
  createdAt: Date,
  updatedAt: Date,
  createdBy: String,         // 'system', user ID, or 'api-key'

  // Index for fast lookups
  // db.modelpricing.createIndex({ provider: 1, modelName: 1, isActive: 1 })
}
```

**Indexes:**
```javascript
ModelPricingConfig.index({ provider: 1, modelName: 1, isActive: 1 }, { unique: false });
ModelPricingConfig.index({ isActive: 1, effectiveDate: -1 });
```

### 3.2 Updates to Conversation Model

**File:** `/models/Conversation.js`

Add cost fields to MessageSchema:

```javascript
const MessageSchema = new mongoose.Schema({
  // ... existing fields ...

  // V4.1: Cost tracking
  cost: {
    // Actual cost calculated at message generation time
    promptTokenCost: Number,       // $ for prompt tokens
    completionTokenCost: Number,   // $ for completion tokens
    totalCost: Number,             // $ total for this message

    // Pricing source (for auditing)
    pricingSource: {
      provider: String,            // 'ollama', 'openai', etc.
      modelName: String,           // Model used
      promptCostPer1M: Number,     // Cost per 1M tokens (snapshot)
      completionCostPer1M: Number  // Cost per 1M tokens (snapshot)
    },

    // Metadata
    calculatedAt: Date,            // When cost was calculated
    currency: { type: String, default: 'USD' }
  }
});

// Add to ConversationSchema
{
  // ... existing fields ...

  // Total cost summary for conversation
  totalCost: {
    sum: Number,                   // Total $ for entire conversation
    currency: { type: String, default: 'USD' },
    lastUpdated: Date              // When totals were recalculated
  }
}
```

**Indexes:**
```javascript
ConversationSchema.index({ 'totalCost.sum': 1 });
ConversationSchema.index({ 'messages.cost.totalCost': 1 });
```

### 3.3 Cost Calculation: Message-Level

When storing a message (after LLM response):

```
promptTokenCost = (stats.usage.promptTokens / 1_000_000) * pricingConfig.promptTokenCost
completionTokenCost = (stats.usage.completionTokens / 1_000_000) * pricingConfig.completionTokenCost
totalCost = promptTokenCost + completionTokenCost
```

### 3.4 Historical Data Handling

**Problem:** Messages created before cost tracking was implemented have no pricing info.

**Solution - Three Tiers:**

**Tier 1: Explicit Configuration** (Best)
- If message has `stats.usage` (token counts exist)
- AND pricing is configured for the model
- Calculate exact cost retroactively

**Tier 2: Default Pricing** (Good)
- If `DEFAULT_FALLBACK_PROMPT_COST_PER_1M` is set
- Apply uniform cost across all historical messages
- Mark with `pricingSource.source: 'default-fallback'`

**Tier 3: No Cost** (Acceptable)
- If no pricing configured
- Set all costs to 0
- Mark with `pricingSource.source: 'unconfigured'`

**Migration Script:** `/scripts/migrate-costs.js` (optional, for backfilling)

```javascript
// Pseudocode
for each conversation:
  for each message where message.cost is null:
    if (message.stats.usage && modelPricing exists):
      calculate cost from message.stats
    else if (DEFAULT_FALLBACK_COST set):
      apply default cost
    else:
      cost = 0
    save message
```

---

## 4. Cost Calculation Service

### 4.1 New Service: `/src/services/costCalculator.js`

**Responsibilities:**
- Load pricing from environment variables (cached)
- Load pricing from MongoDB (with fallback to environment)
- Calculate costs for messages
- Aggregate costs for conversations/queries

**API:**

```javascript
// Initialize on app startup
initializeCostCalculator()
  // Load all active ModelPricingConfig from DB
  // Cache pricing map for fast lookups
  // Fall back to environment variables

// Get pricing for a model
const pricing = getPricingForModel(provider, modelName)
  // Returns: { promptCostPer1M, completionCostPer1M, source }
  // Checks DB first, then environment, then fallback

// Calculate cost for a single message
const cost = calculateMessageCost(model, stats)
  // stats = { usage: { promptTokens, completionTokens, totalTokens } }
  // Returns: { promptTokenCost, completionTokenCost, totalCost, pricingSource }

// Calculate conversation total (sum all messages)
const totalCost = calculateConversationCost(conversation)
  // Returns: { sum, messageCount, currency }

// Batch cost calculation (for analytics aggregations)
const stats = calculateCostStats(conversations, dateRange)
  // Returns: { totalCost, avgCostPerConversation, costByModel, breakdown }
```

### 4.2 Implementation: Pricing Lookup

**Flow:**

```
User model: "llama3"
  ↓
Normalize: provider="ollama", modelName="llama3"
  ↓
Check: OLLAMA_LLAMA3_PROMPT_COST_PER_1M env var? → Yes: use it
       OLLAMA_LLAMA3_PROMPT_COST_PER_1M env var? → No:
         Check ModelPricingConfig DB for (ollama, llama3, isActive=true)? → Yes: use it
           Check OLLAMA_DEFAULT_PROMPT_COST_PER_1M env var? → Yes: use it
             Check DEFAULT_FALLBACK_PROMPT_COST_PER_1M env var? → Yes: use it
               Return 0.00 (unconfigured)
```

**Caching:**
- Cache pricing map in memory (updated on app startup)
- TTL: 1 hour (allow dynamic updates via database)
- Manual refresh endpoint: `POST /api/admin/pricing/refresh` (admin only)

---

## 5. Integration Points

### 5.1 Chat Service Integration

**File:** `/src/services/chatService.js`

**When:**
- After Ollama returns response with stats
- Before saving message to MongoDB

**Action:**
```javascript
// In handleChatRequest, after getting response:
const messageCost = costCalculator.calculateMessageCost(
  effectiveModel,
  response.stats
);

// Add to message object before saving
message.cost = messageCost;

// Recalculate conversation totals
conversation.totalCost = costCalculator.calculateConversationCost(conversation);
```

### 5.2 Analytics Endpoints Integration

**File:** `/routes/analytics.js`

**Endpoint `/api/analytics/stats`** - Add cost breakdown:

```javascript
const statsAgg = await Conversation.aggregate([
  { $match: dateFilter },
  { $unwind: '$messages' },
  { $match: { 'messages.role': 'assistant', 'messages.stats': { $exists: true } } },
  { $group: {
      _id: groupKey,
      messageCount: { $sum: 1 },
      // ... existing token metrics ...

      // NEW: Cost metrics
      totalCost: { $sum: '$messages.cost.totalCost' },
      promptTokenCost: { $sum: '$messages.cost.promptTokenCost' },
      completionTokenCost: { $sum: '$messages.cost.completionTokenCost' }
    }
  },
  { $project: {
      // ... existing projections ...

      cost: {
        totalCost: '$totalCost',
        promptTokenCost: '$promptTokenCost',
        completionTokenCost: '$completionTokenCost',
        avgCostPerMessage: {
          $cond: [{ $gt: ['$messageCount', 0] },
                  { $divide: ['$totalCost', '$messageCount'] },
                  0]
        },
        costPerThousandTokens: {
          $cond: [{ $gt: ['$usage.totalTokens', 0] },
                  { $divide: ['$totalCost', { $divide: ['$usage.totalTokens', 1000] }] },
                  0]
        }
      }
    }
  }
]);
```

**Endpoint `/api/analytics/feedback/summary`** - Add cost context:

```javascript
// After existing feedback aggregation, add cost metrics:
const costAgg = await Conversation.aggregate([
  { $match: dateFilter },
  { $group: {
      _id: null,
      totalCost: { $sum: '$totalCost.sum' },
      costByModel: {
        $push: {
          model: '$model',
          cost: '$totalCost.sum'
        }
      }
    }
  }
]);

// Include in response:
response.cost = {
  total: costAgg[0].totalCost,
  avgPerConversation: costAgg[0].totalCost / overall.totalFeedback,
  byModel: costAgg[0].costByModel
};
```

**New Endpoint: `/api/analytics/cost`** - Dedicated cost analytics:

```javascript
GET /api/analytics/cost

Query params:
  - from: ISO date
  - to: ISO date
  - groupBy: 'model' | 'day' | 'promptVersion' (default: 'model')
  - minCost: number (optional, filter groups below threshold)

Response:
{
  "status": "success",
  "data": {
    "from": "2026-01-01T00:00:00Z",
    "to": "2026-01-07T00:00:00Z",
    "currency": "USD",
    "summary": {
      "totalCost": 12.45,
      "totalMessages": 324,
      "totalTokens": 456000,
      "avgCostPerMessage": 0.0384,
      "costPerMillionTokens": 27.30,
      "costPerThousandTokens": 0.0273
    },
    "breakdown": [
      {
        "key": "llama3",                    // model or date or prompt name
        "messageCount": 150,
        "totalCost": 7.50,
        "promptTokens": 200000,
        "completionTokens": 100000,
        "avgCostPerMessage": 0.050,
        "costBreakdown": {
          "promptTokenCost": 0.00,
          "completionTokenCost": 0.00
        }
      },
      {
        "key": "mistral",
        "messageCount": 174,
        "totalCost": 4.95,
        "promptTokens": 256000,
        "completionTokens": 144000,
        "avgCostPerMessage": 0.0285,
        "costBreakdown": {
          "promptTokenCost": 0.00,
          "completionTokenCost": 0.00
        }
      }
    ],
    "insights": {
      "mostExpensiveModel": "llama3",
      "leastExpensiveModel": "mistral",
      "mostCostEfficient": {
        "model": "mistral",
        "costPerThousandTokens": 0.0193
      },
      "costTrend": "stable",
      "projectedMonthly": 177.86
    }
  }
}
```

---

## 6. JSON Response Format Specification

### 6.1 Message Cost Fields

When returning messages in chat API responses:

```json
{
  "id": "msg_123",
  "role": "assistant",
  "content": "...",
  "timestamp": "2026-01-01T12:00:00Z",
  "stats": {
    "usage": {
      "promptTokens": 50,
      "completionTokens": 100,
      "totalTokens": 150
    },
    "performance": {
      "totalDurationSec": 2.5,
      "tokensPerSecond": 60
    }
  },
  "cost": {
    "promptTokenCost": 0.00025,
    "completionTokenCost": 0.00075,
    "totalCost": 0.001,
    "currency": "USD",
    "pricingSource": {
      "provider": "ollama",
      "modelName": "llama3",
      "promptCostPer1M": 0.00,
      "completionCostPer1M": 0.00
    },
    "calculatedAt": "2026-01-01T12:00:05Z"
  }
}
```

### 6.2 Conversation Cost Summary

When returning conversation details:

```json
{
  "_id": "conv_456",
  "userId": "user_123",
  "model": "llama3",
  "title": "Coding assistance",
  "messageCount": 12,
  "createdAt": "2026-01-01T10:00:00Z",
  "updatedAt": "2026-01-01T12:30:00Z",
  "totalCost": {
    "sum": 0.0450,
    "currency": "USD",
    "lastUpdated": "2026-01-01T12:30:00Z",
    "breakdown": {
      "promptTokens": 0.0150,
      "completionTokens": 0.0300
    }
  },
  "messages": [ /* messages with cost fields */ ]
}
```

### 6.3 Analytics Stats Response (with costs)

```json
{
  "status": "success",
  "data": {
    "from": "2025-12-25T00:00:00Z",
    "to": "2026-01-01T00:00:00Z",
    "currency": "USD",
    "totals": {
      "promptTokens": 500000,
      "completionTokens": 250000,
      "totalTokens": 750000,
      "messages": 324,
      "avgDurationSec": 2.3,
      "cost": {
        "promptTokenCost": 2.50,
        "completionTokenCost": 3.75,
        "totalCost": 6.25,
        "avgCostPerMessage": 0.0193,
        "costPerMillionTokens": 8.33
      }
    },
    "breakdown": [
      {
        "key": "llama3",
        "messageCount": 150,
        "usage": {
          "promptTokens": 200000,
          "completionTokens": 100000,
          "totalTokens": 300000
        },
        "performance": {
          "totalDurationSec": 345,
          "avgDurationSec": 2.3,
          "avgTokensPerSecond": 60
        },
        "cost": {
          "promptTokenCost": 0.00,
          "completionTokenCost": 0.00,
          "totalCost": 0.00,
          "avgCostPerMessage": 0.00,
          "costPerThousandTokens": 0.00
        }
      },
      {
        "key": "mistral",
        "messageCount": 174,
        "usage": {
          "promptTokens": 300000,
          "completionTokens": 150000,
          "totalTokens": 450000
        },
        "performance": {
          "totalDurationSec": 402,
          "avgDurationSec": 2.3,
          "avgTokensPerSecond": 62
        },
        "cost": {
          "promptTokenCost": 0.00,
          "completionTokenCost": 0.00,
          "totalCost": 0.00,
          "avgCostPerMessage": 0.00,
          "costPerThousandTokens": 0.00
        }
      }
    ]
  }
}
```

---

## 7. Default Configuration

### 7.1 Default .env Values

```bash
# Cost tracking
COST_TRACKING_ENABLED=true
COST_CURRENCY=USD

# Default pricing (0 for local Ollama models - no direct cost)
OLLAMA_DEFAULT_PROMPT_COST_PER_1M=0.00
OLLAMA_DEFAULT_COMPLETION_COST_PER_1M=0.00

# Fallback
DEFAULT_FALLBACK_PROMPT_COST_PER_1M=0.00
DEFAULT_FALLBACK_COMPLETION_COST_PER_1M=0.00

# Computational cost (optional: set to 0.0001 to track internal compute)
OLLAMA_COMPUTATIONAL_COST_PER_1M=0.00
```

### 7.2 Empty MongoDB

If `ModelPricingConfig` is empty (first deployment), system automatically:
1. Falls back entirely to environment variables
2. Logs warning if no pricing configured
3. Sets all costs to 0.00 (neutral, no error)
4. Provides admin endpoint to manually add pricing later

---

## 8. Implementation Roadmap

### Phase 1: Core Infrastructure (Week 1)
- [ ] Add `ModelPricingConfig` model
- [ ] Create `costCalculator.js` service
- [ ] Update `Conversation` model with cost fields
- [ ] Add environment variables to `.env.example`

### Phase 2: Chat Integration (Week 1-2)
- [ ] Integrate cost calculation in `chatService.js`
- [ ] Save costs with messages
- [ ] Update conversation total costs

### Phase 3: Analytics Integration (Week 2)
- [ ] Add cost fields to `/api/analytics/stats`
- [ ] Create `/api/analytics/cost` endpoint
- [ ] Update `/api/analytics/feedback/summary`

### Phase 4: Backfill & Admin (Week 2-3)
- [ ] Create `/scripts/migrate-costs.js` for historical data
- [ ] Create admin endpoints for pricing management
- [ ] Update documentation

### Phase 5: Frontend (Week 3)
- [ ] Display costs in analytics dashboard
- [ ] Add cost charts to conversation history
- [ ] Show cost breakdown in conversation details

---

## 9. API Reference: Cost-Related Endpoints

### 9.1 Get Model Pricing

```
GET /api/admin/pricing/:provider/:modelName
Authorization: admin-only (future auth layer)

Response:
{
  "provider": "ollama",
  "modelName": "llama3",
  "pricing": {
    "promptTokenCost": 0.00,
    "completionTokenCost": 0.00
  },
  "source": "environment",
  "isActive": true
}
```

### 9.2 Create/Update Model Pricing

```
POST /api/admin/pricing
Authorization: admin-only

Body:
{
  "provider": "openai",
  "modelName": "gpt-4",
  "pricing": {
    "promptTokenCost": 5.00,
    "completionTokenCost": 15.00
  },
  "effectiveDate": "2026-01-01T00:00:00Z",
  "notes": "Updated per Jan 2026 OpenAI pricing"
}

Response: ModelPricingConfig document
```

### 9.3 List All Model Pricing

```
GET /api/admin/pricing?isActive=true&provider=ollama

Response:
{
  "status": "success",
  "data": [
    { modelName: "llama3", pricing: {...} },
    { modelName: "mistral", pricing: {...} },
    { modelName: "deepseek-r1", pricing: {...} }
  ]
}
```

### 9.4 Refresh Pricing Cache

```
POST /api/admin/pricing/refresh
Authorization: admin-only

Response:
{
  "status": "success",
  "message": "Pricing cache refreshed",
  "modelsLoaded": 12
}
```

### 9.5 Cost Analytics

```
GET /api/analytics/cost?from=2026-01-01&to=2026-01-07&groupBy=model

Response: (as specified in section 5.2)
```

---

## 10. Considerations & Edge Cases

### 10.1 Missing Token Counts
**Problem:** Older messages may not have `stats.usage`

**Solution:**
```javascript
if (!message.stats?.usage) {
  // Skip cost calculation
  cost = { totalCost: 0, source: 'no-token-data' };
}
```

### 10.2 Multi-User Cost Attribution
**Current State:** System doesn't require auth, all conversations are shared

**Future:** If auth is added:
```javascript
// Each message includes userId for cost attribution
message.cost.userId = conversation.userId;

// Analytics can group by user
$group: { _id: '$userId', totalCost: { $sum: '$messages.cost.totalCost' } }
```

### 10.3 Thinking Model Premium
**Problem:** Thinking models (DeepSeek-R1, o1) cost 3-5x more

**Solution:**
```javascript
// Store "thinking tokens" separately in stats
stats.usage.thinkingTokens = 5000;

// Apply different rate for thinking tokens
if (isThinkingModel(model)) {
  thinkingCost = (stats.usage.thinkingTokens / 1M) * thinkingTokenRate;
  completionCost = ((stats.usage.completionTokens - thinkingTokens) / 1M) * regularRate;
}
```

### 10.4 Embedding Costs
**For RAG queries:**
```javascript
// When embedding a query for search
const embeddingStats = {
  queryTokens: 150,
  embeddingModel: 'nomic-embed-text'
};

const embeddingCost = (embeddingStats.queryTokens / 1M)
  * costCalculator.getEmbeddingCost('nomic-embed-text');

// Add to conversation if tracked
conversation.ragCost = (conversation.ragCost || 0) + embeddingCost;
```

### 10.5 Free Tier vs. Paid Models
**Future consideration:**
```javascript
// Separate free and paid model tracking
const pricingTier = model.startsWith('free-') ? 'free' : 'paid';

// Analytics can report separately
$group: {
  _id: { model: '$model', tier: getTier('$model') },
  cost: { $sum: '$messages.cost.totalCost' }
}
```

---

## 11. Testing Strategy

### 11.1 Unit Tests
- Cost calculation accuracy (prompt + completion)
- Pricing lookup resolution order
- Rounding precision (money to 4 decimal places)
- Cache invalidation

### 11.2 Integration Tests
- Cost saved with messages
- Conversation totals accurate
- Historical data migration
- Analytics aggregations include costs

### 11.3 Load Test Scenario
```bash
# Generate 10K messages across 5 models
# Verify cost calculations don't impact response time
# Measure aggregation query performance
npm run test:load:cost-tracking
```

---

## 12. Documentation Updates

### Files to Update:
1. `.env.example` - Add all COST_* variables
2. `docs/05-DEPLOYMENT.md` - Environment reference section
3. `docs/api/reference.md` - New cost endpoints
4. `docs/architecture/analytics.md` - Cost tracking architecture
5. `models/Conversation.js` - Inline JSDoc comments for cost fields
6. `src/services/costCalculator.js` - Service documentation

---

## 13. Summary Table: Decision Matrix

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Pricing Granularity** | Per-token (prompt vs completion) | Matches industry standard, accounts for asymmetry |
| **Configuration Storage** | Env variables + MongoDB | Flexible: quick updates via DB, no redeployment needed |
| **Pricing Units** | Per 1 million tokens | Matches OpenAI, Anthropic conventions |
| **Historical Data** | Three-tier fallback | Graceful degradation, don't break existing data |
| **Caching** | In-memory with 1hr TTL | Fast lookups, allows dynamic updates |
| **Default Value** | $0.00 for local models | Honest cost tracking (Ollama is free) |
| **Currency** | USD only (v1) | Simplify first release, support others v2 |
| **Rounding** | 4 decimal places | Sufficient precision ($0.0001 resolution) |
| **Thinking Models** | Tracked in completion tokens for v1 | v2: separate thinking token pricing |

---

## Appendix A: Example Configuration

### Local Development (.env)
```bash
COST_TRACKING_ENABLED=true
COST_CURRENCY=USD

OLLAMA_DEFAULT_PROMPT_COST_PER_1M=0.00
OLLAMA_DEFAULT_COMPLETION_COST_PER_1M=0.00
DEFAULT_FALLBACK_PROMPT_COST_PER_1M=0.00
DEFAULT_FALLBACK_COMPLETION_COST_PER_1M=0.00
```

### Production with Multiple Providers (.env)
```bash
COST_TRACKING_ENABLED=true
COST_CURRENCY=USD

# Local models (cost: free inference)
OLLAMA_LLAMA3_PROMPT_COST_PER_1M=0.00
OLLAMA_LLAMA3_COMPLETION_COST_PER_1M=0.00

OLLAMA_MISTRAL_PROMPT_COST_PER_1M=0.00
OLLAMA_MISTRAL_COMPLETION_COST_PER_1M=0.00

# Future OpenAI integration
OPENAI_GPT4_PROMPT_COST_PER_1M=5.00
OPENAI_GPT4_COMPLETION_COST_PER_1M=15.00

# Internal bookkeeping (computational cost)
OLLAMA_COMPUTATIONAL_COST_PER_1M=0.0001

# Fallback for unknown models
DEFAULT_FALLBACK_PROMPT_COST_PER_1M=0.00
DEFAULT_FALLBACK_COMPLETION_COST_PER_1M=0.00
```

---

## Appendix B: Migration Checklist

When deploying cost tracking to existing deployment:

- [ ] Add fields to Conversation model
- [ ] Create ModelPricingConfig collection
- [ ] Set environment variables in .env
- [ ] Deploy backend code with costCalculator service
- [ ] Run `npm run seed:pricing` (if implemented) to load initial pricing
- [ ] Run `scripts/migrate-costs.js` to backfill historical messages
- [ ] Verify analytics endpoints include cost fields
- [ ] Update frontend to display costs
- [ ] Monitor error logs for missing pricing configurations
- [ ] Announce new cost tracking in release notes

---

**End of Design Specification**
