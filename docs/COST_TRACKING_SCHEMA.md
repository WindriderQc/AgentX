# Cost Tracking: Database & API Schema Reference

**Visual & detailed schema reference for developers**

---

## 1. MongoDB Collections

### 1.1 Model: ModelPricingConfig

**Collection Name:** `modelpricing` or `modelpricingconfigs`

**Purpose:** Store per-model pricing configuration with versioning support

```
┌─────────────────────────────────────┐
│   ModelPricingConfig Document       │
├─────────────────────────────────────┤
│ _id              │ ObjectId          │ Auto-generated
│ provider         │ String            │ 'ollama', 'openai', 'anthropic'
│ modelName        │ String            │ 'llama3', 'gpt-4', 'claude-opus'
│ displayName      │ String            │ User-friendly (opt.)
│                  │                   │
│ pricing          │ Object            │
│   └─ prompt      │ Number            │ $/1M tokens
│   └─ completion  │ Number            │ $/1M tokens
│   └─ embedding   │ Number            │ $/1M tokens (opt.)
│                  │                   │
│ isActive         │ Boolean           │ true = use in calcs
│ currency         │ String            │ 'USD', 'EUR', etc.
│ source           │ String            │ 'environment','manual','api'
│ notes            │ String            │ Human-readable reason (opt.)
│                  │                   │
│ effectiveDate    │ Date              │ When pricing starts
│ expiryDate       │ Date              │ When pricing ends (opt.)
│                  │                   │
│ createdAt        │ Date              │ Document creation time
│ updatedAt        │ Date              │ Last modification time
│ createdBy        │ String            │ 'system', user ID, or 'api'
└─────────────────────────────────────┘

INDEXES:
  { provider: 1, modelName: 1, isActive: 1 } - Primary lookup
  { isActive: 1, effectiveDate: -1 } - Query active pricing by date
```

**MongoDB Creation:**
```javascript
db.createCollection('modelpricingconfigs');

db.modelpricingconfigs.createIndex({
  provider: 1,
  modelName: 1,
  isActive: 1
});

db.modelpricingconfigs.createIndex({
  isActive: 1,
  effectiveDate: -1
});
```

**Sample Documents:**
```json
{
  "_id": ObjectId("..."),
  "provider": "ollama",
  "modelName": "llama3",
  "displayName": "Llama 3 8B",
  "pricing": {
    "promptTokenCost": 0.00,
    "completionTokenCost": 0.00,
    "embeddingCost": null
  },
  "isActive": true,
  "currency": "USD",
  "source": "environment",
  "notes": "Local model - free inference",
  "effectiveDate": ISODate("2026-01-01T00:00:00Z"),
  "expiryDate": null,
  "createdAt": ISODate("2026-01-01T10:00:00Z"),
  "updatedAt": ISODate("2026-01-01T10:00:00Z"),
  "createdBy": "system"
}
```

---

### 1.2 Updated Model: Conversation

**Collection Name:** `conversations`

**New/Updated Fields:** (showing changes only)

```
┌─────────────────────────────────────┐
│   Conversation Document             │
├─────────────────────────────────────┤
│ ... (existing fields)               │
│                                     │
│ totalCost (NEW)      │ Object       │ Conversation-level cost
│   └─ sum             │ Number       │ Total $ for conversation
│   └─ currency        │ String       │ 'USD', 'EUR', etc.
│   └─ lastUpdated     │ Date         │ When totals were recalc'd
│   └─ breakdown       │ Object       │ Optional detail
│       └─ prompt      │ Number       │ Total $ prompt tokens
│       └─ completion  │ Number       │ Total $ completion tokens
│       └─ embedding   │ Number       │ Total $ embeddings (opt.)
│                                     │
│ messages (UPDATED)   │ Array        │ Array of messages
│   └─ [n].cost (NEW)  │ Object       │ Cost for this message
│       └─ prompt      │ Number       │ $ for prompt tokens
│       └─ completion  │ Number       │ $ for completion tokens
│       └─ total       │ Number       │ Total $ for message
│       └─ currency    │ String       │ 'USD', etc.
│       └─ calculated  │ Date         │ When calculated
│       └─ pricing     │ Object       │ Pricing snapshot
│           └─ prov    │ String       │ Provider (ollama, etc.)
│           └─ model   │ String       │ Model name
│           └─ prom1M  │ Number       │ $/1M tokens (prompt)
│           └─ comp1M  │ Number       │ $/1M tokens (completion)
│           └─ source  │ String       │ Pricing source (env,db,etc)
└─────────────────────────────────────┘

INDEXES:
  { 'totalCost.sum': 1 } - Sort by cost
  { 'messages.cost.totalCost': 1 } - Find expensive messages
```

**Mongoose Schema Update:**
```javascript
// In MessageSchema
cost: {
  promptTokenCost: Number,
  completionTokenCost: Number,
  totalCost: Number,
  currency: { type: String, default: 'USD' },
  pricingSource: {
    provider: String,
    modelName: String,
    promptCostPer1M: Number,
    completionCostPer1M: Number,
    source: { type: String, enum: ['environment', 'database', 'default'] }
  },
  calculatedAt: Date
}

// In ConversationSchema
totalCost: {
  sum: Number,
  currency: { type: String, default: 'USD' },
  breakdown: {
    promptTokens: Number,
    completionTokens: Number,
    embeddingTokens: Number
  },
  lastUpdated: Date
}
```

**Sample Document (snippet):**
```json
{
  "_id": ObjectId("..."),
  "model": "llama3",
  "totalCost": {
    "sum": 0.0450,
    "currency": "USD",
    "breakdown": {
      "promptTokens": 0.0150,
      "completionTokens": 0.0300,
      "embeddingTokens": 0.0000
    },
    "lastUpdated": ISODate("2026-01-01T12:30:00Z")
  },
  "messages": [
    {
      "_id": ObjectId("..."),
      "role": "assistant",
      "content": "...",
      "stats": {
        "usage": {
          "promptTokens": 100,
          "completionTokens": 200,
          "totalTokens": 300
        }
      },
      "cost": {
        "promptTokenCost": 0.0005,
        "completionTokenCost": 0.0015,
        "totalCost": 0.0020,
        "currency": "USD",
        "pricingSource": {
          "provider": "ollama",
          "modelName": "llama3",
          "promptCostPer1M": 0.00,
          "completionCostPer1M": 0.00,
          "source": "environment"
        },
        "calculatedAt": ISODate("2026-01-01T12:00:05Z")
      }
    },
    {
      "_id": ObjectId("..."),
      "role": "user",
      "content": "...",
      "cost": null  // User messages have no cost
    }
  ]
}
```

---

## 2. API Request/Response Schemas

### 2.1 Get Analytics Stats (with Costs)

**Endpoint:** `GET /api/analytics/stats`

**Query Parameters:**
```
from         string (ISO date)  Optional. Default: 7 days ago
to           string (ISO date)  Optional. Default: now
groupBy      string             Optional. Default: 'model'
             Values: 'model', 'day', 'promptVersion'
```

**Response Schema:**
```json
{
  "status": "success",
  "data": {
    "from": "2025-12-25T00:00:00.000Z",
    "to": "2026-01-01T00:00:00.000Z",
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
        "costPerThousandTokens": 0.0083,
        "costPerMillionTokens": 8.33
      }
    },

    "breakdown": [
      {
        "key": "llama3",                    // model name or date
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

**cURL Example:**
```bash
curl "http://localhost:3080/api/analytics/stats" \
  -H "Content-Type: application/json"

curl "http://localhost:3080/api/analytics/stats?from=2026-01-01&to=2026-01-07&groupBy=day"
```

---

### 2.2 Get Cost Analytics (New Endpoint)

**Endpoint:** `GET /api/analytics/cost`

**Query Parameters:**
```
from         string (ISO date)     Optional. Default: 7 days ago
to           string (ISO date)     Optional. Default: now
groupBy      string                Optional. Default: 'model'
             Values: 'model', 'day', 'promptVersion'
minCost      number                Optional. Filter results >= minCost
currency     string                Optional. Default: 'USD'
```

**Response Schema:**
```json
{
  "status": "success",
  "data": {
    "from": "2025-12-25T00:00:00.000Z",
    "to": "2026-01-01T00:00:00.000Z",
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
        "key": "llama3",
        "messageCount": 150,
        "totalCost": 7.50,
        "promptTokens": 200000,
        "completionTokens": 100000,
        "avgCostPerMessage": 0.0500,
        "costBreakdown": {
          "promptTokenCost": 3.00,
          "completionTokenCost": 4.50
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
          "promptTokenCost": 1.28,
          "completionTokenCost": 3.67
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
      "costTrend": "stable",              // "up", "down", "stable"
      "projectedMonthly": 177.86
    }
  }
}
```

**cURL Example:**
```bash
curl "http://localhost:3080/api/analytics/cost" \
  -H "Content-Type: application/json"

curl "http://localhost:3080/api/analytics/cost?from=2026-01-01&to=2026-01-07&groupBy=model&minCost=1.00"
```

---

### 2.3 Chat Completion Response (with Costs)

**Endpoint:** `POST /api/chat`

**Response Schema (Message):**
```json
{
  "id": "msg_abc123",
  "role": "assistant",
  "content": "...",
  "timestamp": "2026-01-01T12:00:00.000Z",

  "stats": {
    "usage": {
      "promptTokens": 50,
      "completionTokens": 100,
      "totalTokens": 150
    },
    "performance": {
      "totalDuration": 2500000000,      // nanoseconds
      "totalDurationSec": 2.5,
      "loadDuration": 1000000000,
      "evalDuration": 1500000000,
      "tokensPerSecond": 60
    }
  },

  "cost": {
    "promptTokenCost": 0.00025,         // $ for prompt tokens
    "completionTokenCost": 0.00075,     // $ for completion tokens
    "totalCost": 0.001,                 // Total $
    "currency": "USD",

    "pricingSource": {
      "provider": "ollama",
      "modelName": "llama3",
      "promptCostPer1M": 5.00,
      "completionCostPer1M": 15.00,
      "source": "environment"            // environment | database | default
    },

    "calculatedAt": "2026-01-01T12:00:05.000Z"
  }
}
```

---

### 2.4 Conversation Response (with Total Cost)

**Endpoint:** `GET /api/conversations/:id` (or list endpoint)

**Response Schema:**
```json
{
  "_id": "conv_xyz789",
  "userId": "user_123",
  "model": "llama3",
  "title": "Python debugging help",
  "createdAt": "2026-01-01T10:00:00.000Z",
  "updatedAt": "2026-01-01T12:30:00.000Z",

  "totalCost": {
    "sum": 0.0450,
    "currency": "USD",
    "breakdown": {
      "promptTokens": 0.0150,
      "completionTokens": 0.0300,
      "embeddingTokens": 0.0000
    },
    "lastUpdated": "2026-01-01T12:30:00.000Z"
  },

  "messages": [
    {
      "_id": "msg_abc1",
      "role": "user",
      "content": "...",
      "timestamp": "2026-01-01T10:00:00.000Z",
      "cost": null
    },
    {
      "_id": "msg_abc2",
      "role": "assistant",
      "content": "...",
      "timestamp": "2026-01-01T10:00:05.000Z",
      "stats": { /* ... */ },
      "cost": {
        "promptTokenCost": 0.00025,
        "completionTokenCost": 0.00075,
        "totalCost": 0.001,
        "currency": "USD",
        "pricingSource": { /* ... */ },
        "calculatedAt": "2026-01-01T10:00:05.000Z"
      }
    }
  ]
}
```

---

### 2.5 Admin: Get Model Pricing

**Endpoint:** `GET /api/admin/pricing/:provider/:modelName`

**Authorization:** Admin only (future auth layer)

**Response Schema:**
```json
{
  "status": "success",
  "data": {
    "_id": "pricing_def456",
    "provider": "ollama",
    "modelName": "llama3",
    "displayName": "Llama 3 8B",

    "pricing": {
      "promptTokenCost": 0.00,
      "completionTokenCost": 0.00,
      "embeddingCost": null
    },

    "isActive": true,
    "currency": "USD",
    "source": "environment",
    "notes": "Local inference - no direct cost",

    "effectiveDate": "2026-01-01T00:00:00.000Z",
    "expiryDate": null,

    "createdAt": "2026-01-01T10:00:00.000Z",
    "updatedAt": "2026-01-01T10:00:00.000Z",
    "createdBy": "system"
  }
}
```

---

### 2.6 Admin: Create Model Pricing

**Endpoint:** `POST /api/admin/pricing`

**Authorization:** Admin only

**Request Schema:**
```json
{
  "provider": "openai",
  "modelName": "gpt-4",
  "displayName": "GPT-4 (8K context)",

  "pricing": {
    "promptTokenCost": 5.00,
    "completionTokenCost": 15.00
  },

  "currency": "USD",
  "notes": "Updated per Jan 2026 OpenAI pricing page",
  "effectiveDate": "2026-01-01T00:00:00Z"
}
```

**Response Schema:** (Same as GET, with newly created _id)

---

### 2.7 Admin: List Model Pricing

**Endpoint:** `GET /api/admin/pricing?isActive=true&provider=ollama`

**Query Parameters:**
```
isActive     boolean     Optional. Filter by active status
provider     string      Optional. Filter by provider
modelName    string      Optional. Filter by model name
```

**Response Schema:**
```json
{
  "status": "success",
  "data": [
    {
      "_id": "pricing_abc1",
      "provider": "ollama",
      "modelName": "llama3",
      "pricing": { /* ... */ }
      // ... full document
    },
    {
      "_id": "pricing_abc2",
      "provider": "ollama",
      "modelName": "mistral",
      "pricing": { /* ... */ }
      // ... full document
    }
  ],
  "count": 2
}
```

---

### 2.8 Admin: Refresh Pricing Cache

**Endpoint:** `POST /api/admin/pricing/refresh`

**Authorization:** Admin only

**Request Body:** (empty or options)
```json
{
  "force": true  // Optional: bypass cache freshness check
}
```

**Response Schema:**
```json
{
  "status": "success",
  "message": "Pricing cache refreshed successfully",
  "timestamp": "2026-01-01T12:30:00.000Z",
  "modelsLoaded": 12,
  "source": "database",
  "cacheHit": false,
  "nextRefreshIn": "1 hour"
}
```

---

## 3. Environment Variables Schema

### Variables Summary Table

```
┌──────────────────────────────────────┬───────────┬──────────────────────┐
│ Variable                             │ Type      │ Example              │
├──────────────────────────────────────┼───────────┼──────────────────────┤
│ COST_TRACKING_ENABLED                │ Boolean   │ true                 │
│ COST_CURRENCY                        │ String    │ USD                  │
│                                      │           │                      │
│ OLLAMA_DEFAULT_PROMPT_COST_PER_1M    │ Number    │ 0.00                 │
│ OLLAMA_DEFAULT_COMPLETION_COST_PER_1M│ Number    │ 0.00                 │
│ OLLAMA_LLAMA3_PROMPT_COST_PER_1M     │ Number    │ 0.00                 │
│ OLLAMA_LLAMA3_COMPLETION_COST_PER_1M │ Number    │ 0.00                 │
│ OLLAMA_MISTRAL_PROMPT_COST_PER_1M    │ Number    │ 0.00                 │
│ OLLAMA_MISTRAL_COMPLETION_COST_PER_1M│ Number    │ 0.00                 │
│ OLLAMA_DEEPSEEK_R1_PROMPT_COST_PER_1M│ Number    │ 0.00                 │
│ OLLAMA_DEEPSEEK_R1_COMPLETION_COST..│ Number    │ 0.00                 │
│                                      │           │                      │
│ OPENAI_GPT4_PROMPT_COST_PER_1M       │ Number    │ 5.00                 │
│ OPENAI_GPT4_COMPLETION_COST_PER_1M   │ Number    │ 15.00                │
│                                      │           │                      │
│ ANTHROPIC_CLAUDE3_OPUS_PROMPT...    │ Number    │ 15.00                │
│ ANTHROPIC_CLAUDE3_OPUS_COMPLETION.. │ Number    │ 75.00                │
│                                      │           │                      │
│ EMBEDDING_COST_PER_1M                │ Number    │ 0.00                 │
│ OLLAMA_COMPUTATIONAL_COST_PER_1M    │ Number    │ 0.0001               │
│ DEFAULT_FALLBACK_PROMPT_COST_PER_1M │ Number    │ 0.00                 │
│ DEFAULT_FALLBACK_COMPLETION_COST..  │ Number    │ 0.00                 │
└──────────────────────────────────────┴───────────┴──────────────────────┘
```

---

## 4. Query Examples

### 4.1 MongoDB Aggregation: Total Cost by Model

```javascript
db.conversations.aggregate([
  { $unwind: '$messages' },
  { $group: {
      _id: '$model',
      totalCost: { $sum: '$messages.cost.totalCost' },
      messageCount: { $sum: 1 }
    }
  },
  { $project: {
      _id: 0,
      model: '$_id',
      totalCost: { $round: ['$totalCost', 4] },
      avgCostPerMessage: {
        $round: [{ $divide: ['$totalCost', '$messageCount'] }, 6]
      }
    }
  },
  { $sort: { totalCost: -1 } }
])
```

**Output:**
```
{ model: "llama3", totalCost: 7.50, avgCostPerMessage: 0.050 }
{ model: "mistral", totalCost: 4.95, avgCostPerMessage: 0.0285 }
```

### 4.2 MongoDB Query: Expensive Messages

```javascript
db.conversations.find({
  'messages.cost.totalCost': { $gt: 0.01 }
}, {
  'messages.$': 1  // Only return matching message
}).limit(10)
```

### 4.3 MongoDB Query: Messages Missing Cost Data

```javascript
db.conversations.find({
  'messages.stats.usage.totalTokens': { $gt: 0 },
  'messages.cost.totalCost': null
})
```

### 4.4 Update Pricing Configuration

```javascript
db.modelpricingconfigs.updateOne(
  { provider: 'openai', modelName: 'gpt-4' },
  {
    $set: {
      'pricing.promptTokenCost': 5.00,
      'pricing.completionTokenCost': 15.00,
      updatedAt: new Date()
    }
  }
)
```

---

## 5. Data Type Reference

### 5.1 Numeric Precision

| Field | Precision | Example | Storage |
|-------|-----------|---------|---------|
| Cost amount | 6 decimals | 0.000001 | Double (IEEE 754) |
| Token cost | 6 decimals | 0.000001 | Double |
| Per-million rate | 2 decimals | 5.00 | Double |
| Token count | Integer | 1000 | Integer |

**MongoDB Type:** `Double` for all monetary values (IEEE 754 64-bit)

### 5.2 Enum Values

```
Provider: 'ollama', 'openai', 'anthropic', 'google', 'cohere'
Currency: 'USD', 'EUR', 'GBP', 'CAD', 'JPY'
PricingSource: 'environment', 'database', 'default', 'no-token-data'
Status: 'active', 'inactive', 'deprecated', 'proposed'
```

---

## 6. Index Strategy

### 6.1 ModelPricingConfig Indexes

```javascript
// Primary lookup (fastest)
db.modelpricingconfigs.createIndex({
  provider: 1,
  modelName: 1,
  isActive: 1
});

// Time-based queries
db.modelpricingconfigs.createIndex({
  isActive: 1,
  effectiveDate: -1
});

// Cost-based searches (future)
db.modelpricingconfigs.createIndex({
  'pricing.promptTokenCost': 1
});
```

### 6.2 Conversation Indexes

```javascript
// Cost-based sorting
db.conversations.createIndex({
  'totalCost.sum': 1
});

// Message-level cost lookups
db.conversations.createIndex({
  'messages.cost.totalCost': 1
});

// Model + cost combined
db.conversations.createIndex({
  model: 1,
  'totalCost.sum': -1
});
```

---

## 7. Validation Rules

### 7.1 ModelPricingConfig Validation

```
provider:
  - Required
  - Type: String
  - Pattern: ^[a-z0-9_]+$
  - Min: 2 chars, Max: 32 chars

modelName:
  - Required
  - Type: String
  - Pattern: ^[a-zA-Z0-9\-_:\.]+$
  - Min: 1 char, Max: 64 chars

pricing.promptTokenCost:
  - Required if pricingType='token'
  - Type: Number
  - Min: 0, Max: 100
  - Decimal places: max 10

pricing.completionTokenCost:
  - Required if pricingType='token'
  - Type: Number
  - Min: 0, Max: 100
  - Decimal places: max 10

currency:
  - Type: String
  - Pattern: ^[A-Z]{3}$ (ISO 4217)
  - Default: 'USD'

effectiveDate:
  - Type: Date
  - Must be in past or present
  - Must be <= expiryDate (if set)

expiryDate:
  - Type: Date (optional)
  - Must be >= effectiveDate
  - Must be in future
```

### 7.2 Message Cost Validation

```
totalCost:
  - Type: Number
  - Min: 0
  - Decimal places: max 6
  - = promptTokenCost + completionTokenCost (verify)

promptTokenCost:
  - Type: Number
  - Min: 0
  - Decimal places: max 6

completionTokenCost:
  - Type: Number
  - Min: 0
  - Decimal places: max 6

pricingSource.source:
  - Type: String
  - Enum: ['environment', 'database', 'default', 'no-token-data']
```

---

**End of Schema Reference**
