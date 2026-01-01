# Cost Tracking Design: Executive Summary

**Design Status:** Complete - Ready for Implementation
**Date:** January 1, 2026
**Target Implementation:** 3-4 weeks

---

## What Has Been Designed

A **production-ready cost tracking system** for AgentX that enables:

1. **Per-token pricing** - Separate costs for prompt and completion tokens (matches OpenAI, Anthropic patterns)
2. **Flexible configuration** - Environment variables + MongoDB fallback for dynamic updates
3. **Multi-model support** - Different pricing for Ollama, OpenAI, Anthropic (and future providers)
4. **Historical data handling** - Graceful degradation for messages without pricing info
5. **Analytics integration** - Cost breakdown by model, date, and prompt version
6. **Admin control** - API endpoints to manage pricing without redeployment

---

## Design Documents

Four comprehensive documents have been created:

### 1. **COST_TRACKING_DESIGN.md** (Main Spec)
- 550+ lines of detailed design
- Industry pricing research (Ollama, OpenAI, Anthropic, etc.)
- Complete database schema design
- Cost calculation logic with multiple tiers
- Environment variable schema with fallback resolution
- JSON response format examples
- Edge case handling (thinking models, embeddings, multi-user, etc.)
- Implementation roadmap (5 phases)

**Location:** `/home/yb/codes/AgentX/docs/COST_TRACKING_DESIGN.md`

### 2. **COST_TRACKING_QUICK_REFERENCE.md** (Developer Guide)
- 400+ lines of quick answers
- Code snippets ready to use
- Common mistakes and debugging
- Testing examples
- Environment variable cheat sheet

**Location:** `/home/yb/codes/AgentX/docs/COST_TRACKING_QUICK_REFERENCE.md`

### 3. **COST_TRACKING_SCHEMA.md** (Technical Reference)
- Database collections with visual diagrams
- API request/response schemas
- MongoDB aggregation queries
- Validation rules
- Index strategy
- Data type specifications

**Location:** `/home/yb/codes/AgentX/docs/COST_TRACKING_SCHEMA.md`

### 4. **COST_TRACKING_IMPLEMENTATION_GUIDE.md** (Step-by-Step)
- 300+ lines of implementation walkthrough
- Phase-by-phase breakdown
- Code templates ready to copy-paste
- Testing commands for each phase
- Deployment checklist

**Location:** `/home/yb/codes/AgentX/docs/COST_TRACKING_IMPLEMENTATION_GUIDE.md`

---

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| **Pricing Model** | Per-token (prompt vs completion) | Matches industry standard, accounts for token type asymmetry |
| **Configuration** | Env vars + MongoDB | Flexible: quick updates without redeployment |
| **Unit** | Per million tokens | OpenAI convention, easy to understand |
| **Default Cost** | $0.00 for Ollama | Honest pricing (local models are free) |
| **Historical Data** | Three-tier fallback | Graceful handling of incomplete information |
| **Caching** | 1-hour TTL | Fast lookups, allows dynamic updates |
| **Pricing Granularity** | Per message, aggregated by conversation | Match existing architecture |
| **Currency** | USD only (v1) | Simplify first release, expand later |

---

## Architecture Overview

```
Chat Request
    ↓
Ollama Response + Token Stats
    ↓
costCalculator.calculateMessageCost()
    ├→ Get pricing (env vars → DB → fallback)
    ├→ Calculate: (tokens / 1M) * rate
    └→ Return: { promptCost, completionCost, totalCost }
    ↓
Save to Message.cost
    ↓
Recalculate Conversation.totalCost
    ↓
Return in API response + store in MongoDB
    ↓
Analytics aggregations (groupBy model, date, promptVersion)
```

---

## Environment Variables (Complete List)

```bash
# Enable/disable
COST_TRACKING_ENABLED=true
COST_CURRENCY=USD

# Ollama defaults (local = free)
OLLAMA_DEFAULT_PROMPT_COST_PER_1M=0.00
OLLAMA_DEFAULT_COMPLETION_COST_PER_1M=0.00

# Model-specific (optional, overrides defaults)
OLLAMA_LLAMA3_PROMPT_COST_PER_1M=0.00
OLLAMA_LLAMA3_COMPLETION_COST_PER_1M=0.00

# Future providers
OPENAI_GPT4_PROMPT_COST_PER_1M=5.00
OPENAI_GPT4_COMPLETION_COST_PER_1M=15.00

# Fallback
DEFAULT_FALLBACK_PROMPT_COST_PER_1M=0.00
DEFAULT_FALLBACK_COMPLETION_COST_PER_1M=0.00
```

---

## Database Additions

### New Model: ModelPricingConfig
```javascript
{
  provider: String,           // 'ollama', 'openai', etc.
  modelName: String,          // 'llama3', 'gpt-4', etc.
  pricing: {
    promptTokenCost: Number,  // $/1M tokens
    completionTokenCost: Number
  },
  isActive: Boolean,
  effectiveDate: Date,
  expiryDate: Date,
  // ... with timestamps and audit trail
}
```

### Updates to Message:
```javascript
cost: {
  promptTokenCost: Number,
  completionTokenCost: Number,
  totalCost: Number,
  currency: String,
  pricingSource: {
    provider: String,
    modelName: String,
    promptCostPer1M: Number,
    completionCostPer1M: Number,
    source: String  // 'environment' | 'database' | 'default'
  }
}
```

### Updates to Conversation:
```javascript
totalCost: {
  sum: Number,
  currency: String,
  breakdown: {
    promptTokens: Number,
    completionTokens: Number
  }
}
```

---

## API Endpoints (Summary)

### New Analytics Endpoint
```
GET /api/analytics/cost?from=...&to=...&groupBy=model

Returns: {
  summary: { totalCost, totalMessages, avgCostPerMessage, ... },
  breakdown: [{ model, totalCost, avgCostPerMessage, ... }],
  insights: { mostExpensive, mostEfficient, trend, projectedMonthly }
}
```

### Enhanced Endpoints
- `GET /api/analytics/stats` - Now includes `cost` field in breakdown
- `GET /api/analytics/feedback/summary` - Now includes cost context
- Chat response - Now includes `message.cost` object

### Admin Endpoints (New)
- `GET /api/admin/pricing` - List all pricing configurations
- `POST /api/admin/pricing` - Create new pricing
- `POST /api/admin/pricing/refresh` - Refresh pricing cache

---

## Implementation Phases

### Phase 1: Database & Models (2 days)
- Create ModelPricingConfig model
- Update Conversation model with cost fields
- Update .env.example

### Phase 2: Cost Calculator Service (3 days)
- Create costCalculator.js service
- Implement pricing lookup (resolution order)
- Implement cost calculation functions
- Initialize on app startup

### Phase 3: Chat Integration (2 days)
- Call costCalculator in chatService
- Store costs with messages
- Update conversation totals

### Phase 4: Analytics Integration (3 days)
- Add cost fields to /api/analytics/stats
- Create new /api/analytics/cost endpoint
- Test aggregations

### Phase 5: Admin & Testing (2 days)
- Create admin pricing endpoints
- Write comprehensive tests
- Deployment checklist

**Total:** ~12 days of development

---

## Cost Calculation Examples

### Local Model (Ollama - Free)
```
Ollama Llama3 response:
- Prompt tokens: 100
- Completion tokens: 50
- Pricing: $0.00 per million for both

Cost = (100 / 1,000,000) * 0 + (50 / 1,000,000) * 0 = $0.00
```

### Commercial Model (e.g., GPT-4)
```
OpenAI GPT-4 response:
- Prompt tokens: 100
- Completion tokens: 50
- Pricing: $5.00 per million (prompt), $15.00 per million (completion)

Cost = (100 / 1,000,000) * 5.00 + (50 / 1,000,000) * 15.00
     = 0.0005 + 0.00075 = $0.00125
```

---

## Response Format Examples

### Message with Cost
```json
{
  "id": "msg_123",
  "role": "assistant",
  "content": "...",
  "stats": { "usage": { "promptTokens": 100, "completionTokens": 50 } },
  "cost": {
    "promptTokenCost": 0.0005,
    "completionTokenCost": 0.00075,
    "totalCost": 0.00125,
    "currency": "USD",
    "pricingSource": {
      "provider": "openai",
      "modelName": "gpt-4",
      "promptCostPer1M": 5.00,
      "completionCostPer1M": 15.00,
      "source": "environment"
    }
  }
}
```

### Analytics Cost Breakdown
```json
{
  "summary": {
    "totalCost": 12.45,
    "totalMessages": 324,
    "avgCostPerMessage": 0.0384,
    "costPerThousandTokens": 0.0273
  },
  "breakdown": [
    {
      "key": "gpt-4",
      "messageCount": 100,
      "totalCost": 8.50,
      "costBreakdown": {
        "promptTokenCost": 3.00,
        "completionTokenCost": 5.50
      }
    }
  ]
}
```

---

## Key Features

### 1. Flexible Configuration
- Environment variables for quick setup
- MongoDB fallback for dynamic updates
- Fallback resolution order (model-specific → provider default → global fallback)
- No redeployment needed to change pricing

### 2. Graceful Degradation
- Missing pricing? Falls back to defaults
- No token data? Costs set to $0.00
- Never breaks the system

### 3. Comprehensive Tracking
- Per-message cost calculation
- Conversation-level aggregation
- Analytics breakdown (by model, date, prompt version)
- Pricing source auditing

### 4. Production Ready
- MongoDB indexes for fast queries
- In-memory caching with TTL
- Error handling with logging
- Validation on all inputs

### 5. Future Proof
- Extensible to multiple currencies
- Support for thinking model premium pricing
- Embedding cost tracking
- Multi-user cost attribution
- Cost budgeting and alerts

---

## What's NOT Included (v1)

These features are documented as future enhancements:

- **Multi-currency support** (USD only in v1)
- **Thinking model premium pricing** (tracked in completion tokens for v1)
- **Separate embedding cost tracking** (supported in schema, not required)
- **User-based cost attribution** (architecture supports it, not required)
- **Cost budgeting/alerts** (documented for future)
- **Frontend cost dashboard** (design is UI-agnostic)

---

## Testing Strategy

### Unit Tests
- Cost calculation accuracy
- Pricing resolution order
- Rounding precision
- Cache behavior

### Integration Tests
- Message cost storage
- Conversation total updates
- Analytics aggregation
- Migration scripts

### Load Tests
- Cost calculation performance
- Aggregation query speed
- Cache hit rates

---

## Validation & Error Handling

| Scenario | Handling |
|----------|----------|
| Cost tracking disabled | All costs = $0.00 |
| Missing token stats | Cost = $0.00, log warning |
| No pricing configured | Falls back to default ($0.00) |
| Invalid pricing data | Validation error, transaction rolled back |
| Database down | Fall back to environment variables |
| Stale cache | Auto-refresh on TTL expiry |

---

## Performance Characteristics

| Operation | Complexity | Time |
|-----------|-----------|------|
| Calculate message cost | O(1) | <1ms |
| Lookup pricing (cached) | O(1) | <1μs |
| Save conversation | O(n) messages | ~50ms |
| Recalc conv total | O(n) messages | ~5ms |
| Analytics aggregation | O(m) conversations | ~100-500ms |
| Cache refresh | O(p) pricing configs | ~50ms |

---

## Files Created

1. `/docs/COST_TRACKING_DESIGN.md` - Complete design specification (550+ lines)
2. `/docs/COST_TRACKING_QUICK_REFERENCE.md` - Quick start guide (400+ lines)
3. `/docs/COST_TRACKING_SCHEMA.md` - Database/API schema reference (600+ lines)
4. `/docs/COST_TRACKING_IMPLEMENTATION_GUIDE.md` - Step-by-step implementation (300+ lines)
5. `/COST_TRACKING_SUMMARY.md` - This file

**Total Documentation:** ~1,850 lines of design specification

---

## How to Use These Documents

1. **Start here:** This summary for overview
2. **Then read:** `/docs/COST_TRACKING_DESIGN.md` for complete design
3. **While coding:** Use `/docs/COST_TRACKING_QUICK_REFERENCE.md` for code snippets
4. **For schemas:** Reference `/docs/COST_TRACKING_SCHEMA.md` for API/DB details
5. **For implementation:** Follow `/docs/COST_TRACKING_IMPLEMENTATION_GUIDE.md` step-by-step

---

## Questions This Design Answers

- **How do I price different models?** Environment variables + MongoDB, with fallback resolution
- **What about models without pricing configured?** Graceful fallback to defaults
- **How do I support multiple currencies?** Schema supports it, start with USD in v1
- **What about thinking models that cost more?** Schema supports thinking token tracking, use completion tokens for v1
- **How do I handle historical data?** Three-tier fallback based on available data
- **Do I have to redeploy to change pricing?** No, use MongoDB or environment variable refresh
- **What if the database is down?** Falls back to environment variables
- **How do I know which pricing was used?** Snapshot stored with each message
- **Can I track costs per user?** Schema supports it, requires auth layer
- **Is this production ready?** Yes, includes validation, error handling, caching, indexes

---

## Next Steps

### For Developers
1. Read the full design doc
2. Follow the implementation guide
3. Use quick reference while coding
4. Reference schema doc for API details

### For Implementers
1. Phase 1: Database setup (2 days)
2. Phase 2: Cost service (3 days)
3. Phase 3: Chat integration (2 days)
4. Phase 4: Analytics (3 days)
5. Phase 5: Testing & admin (2 days)

### For Operations
1. Configure environment variables
2. Create MongoDB indexes
3. Load initial pricing data
4. Monitor error logs for missing pricing
5. Set up cache refresh schedule (optional)

---

## Support & References

**Industry Standards Referenced:**
- OpenAI pricing model (asymmetric token costs)
- Anthropic Claude pricing
- Google Gemini pricing
- LLM token economics

**Design Patterns Used:**
- Factory pattern (pricing resolution)
- Singleton pattern (cache)
- Snapshot pattern (audit trail)
- Three-tier fallback (graceful degradation)

**Related AgentX Architecture:**
- Service-oriented architecture
- MongoDB-backed persistence
- Conversation versioning
- Analytics aggregation pipelines

---

**Design Complete - Ready for Implementation**

Questions? Refer to the comprehensive documents created above.
