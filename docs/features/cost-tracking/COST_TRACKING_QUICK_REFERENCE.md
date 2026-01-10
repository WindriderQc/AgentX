# Cost Tracking: Quick Reference Guide

**For Developers Implementing Cost Tracking**

---

## Quick Answers

### How do I configure pricing?
**Option 1: Environment Variables (Simplest)**
```bash
# For Ollama models (local, free inference)
OLLAMA_LLAMA3_PROMPT_COST_PER_1M=0.00
OLLAMA_LLAMA3_COMPLETION_COST_PER_1M=0.00

# For future OpenAI integration
OPENAI_GPT4_PROMPT_COST_PER_1M=5.00
OPENAI_GPT4_COMPLETION_COST_PER_1M=15.00
```

**Option 2: MongoDB (Dynamic, no redeployment needed)**
```javascript
// In MongoDB, create ModelPricingConfig document
db.modelpricingconfigs.insertOne({
  provider: "ollama",
  modelName: "llama3",
  pricing: {
    promptTokenCost: 0.00,
    completionTokenCost: 0.00
  },
  isActive: true,
  currency: "USD"
})
```

### Pricing lookup resolution order?
1. Check model-specific env var: `OLLAMA_LLAMA3_PROMPT_COST_PER_1M`
2. Check provider default: `OLLAMA_DEFAULT_PROMPT_COST_PER_1M`
3. Check global default: `DEFAULT_FALLBACK_PROMPT_PER_1M`
4. Return 0.00

### What about messages without token data?
- Skip cost calculation, set `cost.totalCost = 0`
- Mark with `pricingSource.source = 'no-token-data'`
- Log a warning but don't fail

### How do I display costs to users?
Add to message object:
```javascript
{
  cost: {
    totalCost: 0.001,
    currency: "USD",
    promptTokenCost: 0.00025,
    completionTokenCost: 0.00075
  }
}
```

Add to conversation summary:
```javascript
{
  totalCost: {
    sum: 0.045,
    currency: "USD",
    breakdown: {
      promptTokens: 0.015,
      completionTokens: 0.030
    }
  }
}
```

### Do I need to track embedding costs?
**Not required for v1**, but the schema supports it:
```javascript
EMBEDDING_COST_PER_1M=0.00  // nomic-embed-text (Ollama is free)
```

If needed, add to RAG query:
```javascript
const embeddingCost = (embeddingTokenCount / 1_000_000)
  * process.env.EMBEDDING_COST_PER_1M;
conversation.ragCost = (conversation.ragCost || 0) + embeddingCost;
```

---

## Implementation Checklist

### Database Changes
- [ ] Add `cost` field to `MessageSchema` in Conversation model
- [ ] Add `totalCost` field to `ConversationSchema`
- [ ] Create `ModelPricingConfig` model
- [ ] Create MongoDB indexes

### Service Development
- [ ] Create `/src/services/costCalculator.js`
- [ ] Implement `getPricingForModel(provider, modelName)`
- [ ] Implement `calculateMessageCost(model, stats)`
- [ ] Implement `calculateConversationCost(conversation)`
- [ ] Add caching with 1-hour TTL

### Chat Integration
- [ ] In `chatService.js`: import costCalculator
- [ ] After Ollama response: calculate and store message cost
- [ ] Update conversation total cost
- [ ] Return cost in API response

### Analytics Integration
- [ ] Update `/api/analytics/stats` aggregation with cost $sum
- [ ] Add cost fields to response
- [ ] Create `/api/analytics/cost` endpoint
- [ ] Update `/api/analytics/feedback/summary` with cost context

### Environment Configuration
- [ ] Add all COST_* variables to `.env.example`
- [ ] Document in `05-DEPLOYMENT.md`
- [ ] Create `.env.production` template with real prices

### Testing
- [ ] Unit tests for cost calculations
- [ ] Integration tests for message cost storage
- [ ] Query performance tests for analytics

### Documentation
- [ ] Update API reference with cost response fields
- [ ] Add cost tracking section to architecture docs
- [ ] Create admin guide for pricing management

---

## Code Snippets

### Load Pricing (costCalculator initialization)
```javascript
// In /src/services/costCalculator.js
const loadPricingConfig = async () => {
  try {
    const configs = await ModelPricingConfig.find({ isActive: true });

    configs.forEach(config => {
      const key = `${config.provider}:${config.modelName}`;
      pricingCache.set(key, config.pricing);
    });

    logger.info('Loaded pricing for', { models: configs.length });
  } catch (err) {
    logger.warn('Failed to load pricing from DB, falling back to env vars', { error: err.message });
  }
};
```

### Get Pricing for Model
```javascript
const getPricingForModel = (provider, modelName) => {
  // Normalize
  const normalized = modelName.toLowerCase().replace(/\s+/g, '_');
  const cacheKey = `${provider.toLowerCase()}:${normalized}`;

  // Check cache
  if (pricingCache.has(cacheKey)) {
    return { ...pricingCache.get(cacheKey), source: 'database' };
  }

  // Check environment variables
  const envKey = `${provider.toUpperCase()}_${normalized.toUpperCase()}`;
  const promptEnv = process.env[`${envKey}_PROMPT_COST_PER_1M`];
  const completionEnv = process.env[`${envKey}_COMPLETION_COST_PER_1M`];

  if (promptEnv !== undefined && completionEnv !== undefined) {
    return {
      promptTokenCost: parseFloat(promptEnv),
      completionTokenCost: parseFloat(completionEnv),
      source: 'environment'
    };
  }

  // Check provider default
  const defaultPrompt = process.env[`${provider.toUpperCase()}_DEFAULT_PROMPT_COST_PER_1M`];
  const defaultCompletion = process.env[`${provider.toUpperCase()}_DEFAULT_COMPLETION_COST_PER_1M`];

  if (defaultPrompt !== undefined && defaultCompletion !== undefined) {
    return {
      promptTokenCost: parseFloat(defaultPrompt),
      completionTokenCost: parseFloat(defaultCompletion),
      source: 'provider-default'
    };
  }

  // Fallback
  return {
    promptTokenCost: parseFloat(process.env.DEFAULT_FALLBACK_PROMPT_COST_PER_1M || 0),
    completionTokenCost: parseFloat(process.env.DEFAULT_FALLBACK_COMPLETION_COST_PER_1M || 0),
    source: 'global-default'
  };
};
```

### Calculate Message Cost
```javascript
const calculateMessageCost = (model, stats) => {
  if (!stats?.usage?.totalTokens) {
    return {
      promptTokenCost: 0,
      completionTokenCost: 0,
      totalCost: 0,
      pricingSource: { source: 'no-token-data' }
    };
  }

  // Extract provider from model name (e.g., "ollama:llama3" → "ollama")
  const [provider, modelName] = model.includes(':')
    ? model.split(':')
    : ['ollama', model];

  const pricing = getPricingForModel(provider, modelName);

  const promptTokenCost = (stats.usage.promptTokens / 1_000_000) * pricing.promptTokenCost;
  const completionTokenCost = (stats.usage.completionTokens / 1_000_000) * pricing.completionTokenCost;
  const totalCost = promptTokenCost + completionTokenCost;

  return {
    promptTokenCost: parseFloat(promptTokenCost.toFixed(6)),
    completionTokenCost: parseFloat(completionTokenCost.toFixed(6)),
    totalCost: parseFloat(totalCost.toFixed(6)),
    currency: process.env.COST_CURRENCY || 'USD',
    pricingSource: {
      provider,
      modelName,
      promptCostPer1M: pricing.promptTokenCost,
      completionCostPer1M: pricing.completionTokenCost,
      source: pricing.source
    },
    calculatedAt: new Date()
  };
};
```

### Integrate in chatService
```javascript
// In handleChatRequest, after getting response from Ollama:

const messageCost = costCalculator.calculateMessageCost(effectiveModel, response.stats);

const messageToSave = {
  role: 'assistant',
  content: response.content,
  stats: response.stats,
  cost: messageCost,
  timestamp: new Date()
};

conversation.messages.push(messageToSave);

// Recalculate conversation total
let conversationTotal = 0;
conversation.messages.forEach(msg => {
  if (msg.cost?.totalCost) {
    conversationTotal += msg.cost.totalCost;
  }
});

conversation.totalCost = {
  sum: parseFloat(conversationTotal.toFixed(6)),
  currency: process.env.COST_CURRENCY || 'USD',
  lastUpdated: new Date()
};

await conversation.save();
```

### Analytics Aggregation
```javascript
// In GET /api/analytics/stats route

const statsAgg = await Conversation.aggregate([
  { $match: dateFilter },
  { $unwind: '$messages' },
  { $match: { 'messages.role': 'assistant', 'messages.stats': { $exists: true } } },
  { $group: {
      _id: groupKey,
      messageCount: { $sum: 1 },
      totalPromptTokens: { $sum: '$messages.stats.usage.promptTokens' },
      totalCompletionTokens: { $sum: '$messages.stats.usage.completionTokens' },
      totalTokens: { $sum: '$messages.stats.usage.totalTokens' },
      totalDuration: { $sum: '$messages.stats.performance.totalDuration' },
      avgTokensPerSecond: { $avg: '$messages.stats.performance.tokensPerSecond' },

      // NEW: Cost aggregation
      totalCost: { $sum: { $ifNull: ['$messages.cost.totalCost', 0] } },
      promptTokenCost: { $sum: { $ifNull: ['$messages.cost.promptTokenCost', 0] } },
      completionTokenCost: { $sum: { $ifNull: ['$messages.cost.completionTokenCost', 0] } }
    }
  },
  { $project: {
      _id: 0,
      key: '$_id',
      messageCount: 1,
      usage: {
        promptTokens: '$totalPromptTokens',
        completionTokens: '$totalCompletionTokens',
        totalTokens: '$totalTokens'
      },
      performance: {
        totalDurationSec: { $divide: ['$totalDuration', 1e9] },
        avgDurationSec: {
          $cond: [{ $gt: ['$messageCount', 0] },
                  { $divide: [{ $divide: ['$totalDuration', 1e9] }, '$messageCount'] },
                  0]
        },
        avgTokensPerSecond: '$avgTokensPerSecond'
      },
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
  },
  { $sort: { 'usage.totalTokens': -1 } }
]);
```

---

## Default Values Reference

| Variable | Default | Use Case |
|----------|---------|----------|
| `COST_TRACKING_ENABLED` | true | Enable/disable feature |
| `COST_CURRENCY` | USD | Display currency |
| `OLLAMA_DEFAULT_PROMPT_COST_PER_1M` | 0.00 | Local models (free) |
| `OLLAMA_DEFAULT_COMPLETION_COST_PER_1M` | 0.00 | Local models (free) |
| `DEFAULT_FALLBACK_PROMPT_COST_PER_1M` | 0.00 | Unknown models |
| `DEFAULT_FALLBACK_COMPLETION_COST_PER_1M` | 0.00 | Unknown models |

---

## Debugging

### Check if pricing loaded correctly
```javascript
const pricing = costCalculator.getPricingForModel('ollama', 'llama3');
console.log(pricing);
// Output: { promptTokenCost: 0, completionTokenCost: 0, source: 'environment' }
```

### Verify message costs are calculated
```javascript
// Query a message with cost
db.conversations.findOne({ "messages.cost": { $exists: true } }).messages[0];
// Should show: { ..., cost: { totalCost: 0.001, ... } }
```

### Check analytics include cost fields
```bash
curl "http://localhost:3080/api/analytics/stats?groupBy=model" | jq '.data.breakdown[0].cost'
# Should show: { totalCost: 0.0, promptTokenCost: 0.0, completionTokenCost: 0.0, ... }
```

### Monitor for pricing mismatches
```javascript
// Query messages with mismatched tokens/costs
db.conversations.aggregate([
  { $unwind: '$messages' },
  { $match: { 'messages.stats.usage.totalTokens': { $gt: 0 }, 'messages.cost.totalCost': 0 } },
  { $limit: 10 }
])
```

---

## Common Mistakes

### Mistake 1: Using wrong env var names
```javascript
// WRONG
process.env.OLLAMA_LLAMA3_COST

// RIGHT
process.env.OLLAMA_LLAMA3_PROMPT_COST_PER_1M
process.env.OLLAMA_LLAMA3_COMPLETION_COST_PER_1M
```

### Mistake 2: Forgetting to normalize model names
```javascript
// WRONG
const key = `ollama:${model}`;  // "ollama:Llama 3" won't match "ollama:llama3"

// RIGHT
const normalized = model.toLowerCase().replace(/\s+/g, '_');
const key = `ollama:${normalized}`;
```

### Mistake 3: Not handling missing stats
```javascript
// WRONG
const cost = (stats.usage.totalTokens / 1M) * rate;  // Crashes if stats undefined

// RIGHT
if (!stats?.usage?.totalTokens) {
  return { totalCost: 0, source: 'no-token-data' };
}
const cost = (stats.usage.totalTokens / 1M) * rate;
```

### Mistake 4: Rounding errors
```javascript
// WRONG
const cost = (100 / 1000000) * 5.00;  // 0.0005000000000000001

// RIGHT
const cost = parseFloat(((100 / 1000000) * 5.00).toFixed(6));  // 0.0005
```

---

## Testing Examples

### Unit Test: Cost Calculation
```javascript
describe('costCalculator', () => {
  it('should calculate correct cost for message', () => {
    const stats = {
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150
      }
    };

    process.env.OLLAMA_LLAMA3_PROMPT_COST_PER_1M = '5.00';
    process.env.OLLAMA_LLAMA3_COMPLETION_COST_PER_1M = '15.00';

    const cost = costCalculator.calculateMessageCost('ollama:llama3', stats);

    expect(cost.promptTokenCost).toBeCloseTo(0.0005, 6);  // (100 / 1M) * 5
    expect(cost.completionTokenCost).toBeCloseTo(0.00075, 6);  // (50 / 1M) * 15
    expect(cost.totalCost).toBeCloseTo(0.00125, 6);
  });
});
```

### Integration Test: Cost Saved with Message
```javascript
it('should save cost with message', async () => {
  const response = await chatService.handleChatRequest({
    model: 'llama3',
    message: 'Hello',
    // ...
  });

  const conversation = await Conversation.findById(response.conversationId);
  const message = conversation.messages[0];

  expect(message.cost).toBeDefined();
  expect(message.cost.totalCost).toBeGreaterThanOrEqual(0);
  expect(message.cost.pricingSource).toBeDefined();
});
```

---

## Related Documentation

- **Full Design:** `docs/COST_TRACKING_DESIGN.md`
- **Analytics API:** `docs/api/reference.md` (section: Cost Endpoints)
- **Deployment:** `docs/05-DEPLOYMENT.md` (section: Environment Variables)
- **Architecture:** `docs/architecture/analytics.md`

---

**Last Updated:** 2026-01-01
**Version:** 1.0
