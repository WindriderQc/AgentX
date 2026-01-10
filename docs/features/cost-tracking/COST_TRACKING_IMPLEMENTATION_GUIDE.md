# Cost Tracking Implementation Guide

**Complete step-by-step guide for implementing cost tracking in AgentX**

---

## Overview

This guide walks through implementing the cost tracking system designed in `/docs/COST_TRACKING_DESIGN.md`. Start here before reading the full design document.

**Estimated Implementation Time:** 3-4 weeks (Phase 1-5)

---

## Phase 1: Database & Models (Week 1, ~2 days)

### Step 1.1: Create ModelPricingConfig Model

**File:** `/models/ModelPricingConfig.js`

```javascript
const mongoose = require('mongoose');

const ModelPricingConfigSchema = new mongoose.Schema({
  // Identification
  provider: {
    type: String,
    required: true,
    enum: ['ollama', 'openai', 'anthropic', 'google', 'cohere'],
    lowercase: true
  },
  modelName: {
    type: String,
    required: true,
    lowercase: true,
    match: /^[a-z0-9\-_:.]+$/
  },
  displayName: String,

  // Pricing per million tokens
  pricing: {
    promptTokenCost: {
      type: Number,
      required: true,
      min: 0,
      max: 100
    },
    completionTokenCost: {
      type: Number,
      required: true,
      min: 0,
      max: 100
    },
    embeddingCost: {
      type: Number,
      min: 0,
      max: 100
    }
  },

  // Metadata
  isActive: { type: Boolean, default: true },
  currency: { type: String, default: 'USD', match: /^[A-Z]{3}$/ },
  source: {
    type: String,
    enum: ['environment', 'manual', 'provider-api'],
    default: 'manual'
  },
  notes: String,

  // Effective dates
  effectiveDate: { type: Date, default: Date.now },
  expiryDate: Date,

  // Audit trail
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  createdBy: { type: String, default: 'system' }
});

// Indexes
ModelPricingConfigSchema.index({ provider: 1, modelName: 1, isActive: 1 });
ModelPricingConfigSchema.index({ isActive: 1, effectiveDate: -1 });

// Pre-save hook to update updatedAt
ModelPricingConfigSchema.pre('save', function() {
  this.updatedAt = Date.now();
});

module.exports = mongoose.model('ModelPricingConfig', ModelPricingConfigSchema);
```

**Testing:**
```bash
# After creating the model, test in mongosh:
use agentx
db.modelpricingconfigs.insertOne({
  provider: "ollama",
  modelName: "llama3",
  pricing: { promptTokenCost: 0, completionTokenCost: 0 },
  isActive: true
})
```

### Step 1.2: Update Conversation Model

**File:** `/models/Conversation.js`

**In MessageSchema, add cost tracking:**
```javascript
const MessageSchema = new mongoose.Schema({
  role: { type: String, required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  feedback: { /* existing */ },
  stats: { /* existing */ },

  // NEW: Cost tracking
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
      source: {
        type: String,
        enum: ['environment', 'database', 'default', 'no-token-data']
      }
    },
    calculatedAt: Date
  }
});
```

**In ConversationSchema, add conversation-level cost:**
```javascript
const ConversationSchema = new mongoose.Schema({
  userId: { /* existing */ },
  model: String,
  systemPrompt: String,
  messages: [MessageSchema],
  title: { type: String, default: 'New Conversation' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },

  // ... existing fields (ragUsed, promptConfigId, etc.) ...

  // NEW: Total cost for conversation
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
});
```

**Add indexes:**
```javascript
ConversationSchema.index({ 'totalCost.sum': 1 });
ConversationSchema.index({ 'messages.cost.totalCost': 1 });
```

**Verify:**
```bash
npm test  # Run tests to ensure no breaks
```

### Step 1.3: Update .env.example

**File:** `/.env.example`

Add section (around line 60, after authentication):
```bash
# =====================================================
# COST TRACKING CONFIGURATION
# =====================================================

# Enable cost tracking (true/false, default: true)
COST_TRACKING_ENABLED=true

# Currency (USD/EUR/GBP, default: USD)
COST_CURRENCY=USD

# Default pricing for local models (per million tokens)
OLLAMA_DEFAULT_PROMPT_COST_PER_1M=0.00
OLLAMA_DEFAULT_COMPLETION_COST_PER_1M=0.00

# Model-specific pricing (optional, overrides defaults)
OLLAMA_LLAMA3_PROMPT_COST_PER_1M=0.00
OLLAMA_LLAMA3_COMPLETION_COST_PER_1M=0.00

OLLAMA_MISTRAL_PROMPT_COST_PER_1M=0.00
OLLAMA_MISTRAL_COMPLETION_COST_PER_1M=0.00

OLLAMA_QWEN_PROMPT_COST_PER_1M=0.00
OLLAMA_QWEN_COMPLETION_COST_PER_1M=0.00

OLLAMA_DEEPSEEK_R1_PROMPT_COST_PER_1M=0.00
OLLAMA_DEEPSEEK_R1_COMPLETION_COST_PER_1M=0.00

# Future: OpenAI integration
OPENAI_GPT4_PROMPT_COST_PER_1M=5.00
OPENAI_GPT4_COMPLETION_COST_PER_1M=15.00

# Embedding costs (nomic-embed-text is free, OpenAI embedding costs money)
EMBEDDING_COST_PER_1M=0.00

# Fallback for unknown models
DEFAULT_FALLBACK_PROMPT_COST_PER_1M=0.00
DEFAULT_FALLBACK_COMPLETION_COST_PER_1M=0.00
```

---

## Phase 2: Cost Calculator Service (Week 1, ~3 days)

### Step 2.1: Create costCalculator Service

**File:** `/src/services/costCalculator.js`

```javascript
const ModelPricingConfig = require('../../models/ModelPricingConfig');
const logger = require('../../config/logger');

// In-memory cache for pricing
let pricingCache = new Map();
let cacheLoadedAt = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Initialize cost calculator: load pricing from DB
 */
const initialize = async () => {
  try {
    if (!process.env.COST_TRACKING_ENABLED || process.env.COST_TRACKING_ENABLED === 'false') {
      logger.info('Cost tracking disabled');
      return;
    }

    pricingCache.clear();
    const configs = await ModelPricingConfig.find({ isActive: true });

    configs.forEach(config => {
      const key = `${config.provider.toLowerCase()}:${config.modelName.toLowerCase()}`;
      pricingCache.set(key, config.pricing);
    });

    cacheLoadedAt = Date.now();
    logger.info('Cost calculator initialized', { modelsLoaded: configs.length });
  } catch (err) {
    logger.warn('Failed to initialize cost calculator from DB', { error: err.message });
    cacheLoadedAt = Date.now();
  }
};

/**
 * Refresh pricing cache (manual or periodic)
 */
const refreshCache = async () => {
  try {
    await initialize();
    return { success: true, modelsLoaded: pricingCache.size };
  } catch (err) {
    logger.error('Cache refresh failed', { error: err.message });
    return { success: false, error: err.message };
  }
};

/**
 * Check if cache is stale (older than TTL)
 */
const isCacheStale = () => {
  if (!cacheLoadedAt) return true;
  return (Date.now() - cacheLoadedAt) > CACHE_TTL_MS;
};

/**
 * Get pricing for a model (with fallback resolution)
 * @param {string} provider - 'ollama', 'openai', etc.
 * @param {string} modelName - Model name
 * @returns {Object} { promptTokenCost, completionTokenCost, source }
 */
const getPricingForModel = (provider, modelName) => {
  if (!process.env.COST_TRACKING_ENABLED || process.env.COST_TRACKING_ENABLED === 'false') {
    return { promptTokenCost: 0, completionTokenCost: 0, source: 'disabled' };
  }

  // Normalize
  const normalizedProvider = (provider || 'ollama').toLowerCase();
  const normalizedModel = (modelName || '').toLowerCase().replace(/\s+/g, '_');

  // 1. Check cache (from database)
  const cacheKey = `${normalizedProvider}:${normalizedModel}`;
  if (pricingCache.has(cacheKey)) {
    const cached = pricingCache.get(cacheKey);
    return {
      promptTokenCost: cached.promptTokenCost,
      completionTokenCost: cached.completionTokenCost,
      source: 'database'
    };
  }

  // 2. Check environment variables (model-specific)
  const envKey = `${normalizedProvider.toUpperCase()}_${normalizedModel.toUpperCase()}`;
  const promptEnv = parseFloat(process.env[`${envKey}_PROMPT_COST_PER_1M`] || 'NaN');
  const completionEnv = parseFloat(process.env[`${envKey}_COMPLETION_COST_PER_1M`] || 'NaN');

  if (!isNaN(promptEnv) && !isNaN(completionEnv)) {
    return {
      promptTokenCost: promptEnv,
      completionTokenCost: completionEnv,
      source: 'environment-model'
    };
  }

  // 3. Check provider default
  const providerKey = `${normalizedProvider.toUpperCase()}_DEFAULT`;
  const defaultPrompt = parseFloat(process.env[`${providerKey}_PROMPT_COST_PER_1M`] || 'NaN');
  const defaultCompletion = parseFloat(process.env[`${providerKey}_COMPLETION_COST_PER_1M`] || 'NaN');

  if (!isNaN(defaultPrompt) && !isNaN(defaultCompletion)) {
    return {
      promptTokenCost: defaultPrompt,
      completionTokenCost: defaultCompletion,
      source: 'environment-provider-default'
    };
  }

  // 4. Global fallback
  const fallbackPrompt = parseFloat(process.env.DEFAULT_FALLBACK_PROMPT_COST_PER_1M || '0');
  const fallbackCompletion = parseFloat(process.env.DEFAULT_FALLBACK_COMPLETION_COST_PER_1M || '0');

  return {
    promptTokenCost: fallbackPrompt,
    completionTokenCost: fallbackCompletion,
    source: 'global-fallback'
  };
};

/**
 * Calculate cost for a single message
 * @param {string} model - Model name (e.g., "llama3" or "ollama:llama3")
 * @param {Object} stats - Token statistics { usage: { promptTokens, completionTokens } }
 * @returns {Object} Cost breakdown with metadata
 */
const calculateMessageCost = (model, stats) => {
  // Handle disabled tracking
  if (!process.env.COST_TRACKING_ENABLED || process.env.COST_TRACKING_ENABLED === 'false') {
    return {
      promptTokenCost: 0,
      completionTokenCost: 0,
      totalCost: 0,
      currency: 'USD',
      pricingSource: { source: 'disabled' },
      calculatedAt: new Date()
    };
  }

  // Handle missing stats
  if (!stats?.usage || typeof stats.usage.promptTokens !== 'number') {
    return {
      promptTokenCost: 0,
      completionTokenCost: 0,
      totalCost: 0,
      currency: process.env.COST_CURRENCY || 'USD',
      pricingSource: { source: 'no-token-data' },
      calculatedAt: new Date()
    };
  }

  // Parse model and provider
  let provider = 'ollama';
  let modelName = model;

  if (model && model.includes(':')) {
    [provider, modelName] = model.split(':');
  }

  // Get pricing
  const pricing = getPricingForModel(provider, modelName);

  // Calculate costs
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

/**
 * Calculate total cost for a conversation
 * @param {Object} conversation - Mongoose conversation document
 * @returns {Object} { sum, currency, breakdown, lastUpdated }
 */
const calculateConversationCost = (conversation) => {
  if (!process.env.COST_TRACKING_ENABLED || process.env.COST_TRACKING_ENABLED === 'false') {
    return { sum: 0, currency: 'USD', lastUpdated: new Date() };
  }

  let totalCost = 0;
  let promptTokenCost = 0;
  let completionTokenCost = 0;

  if (conversation.messages && Array.isArray(conversation.messages)) {
    conversation.messages.forEach(msg => {
      if (msg.cost?.totalCost) {
        totalCost += msg.cost.totalCost;
        promptTokenCost += msg.cost.promptTokenCost || 0;
        completionTokenCost += msg.cost.completionTokenCost || 0;
      }
    });
  }

  return {
    sum: parseFloat(totalCost.toFixed(6)),
    currency: process.env.COST_CURRENCY || 'USD',
    breakdown: {
      promptTokens: parseFloat(promptTokenCost.toFixed(6)),
      completionTokens: parseFloat(completionTokenCost.toFixed(6))
    },
    lastUpdated: new Date()
  };
};

/**
 * Calculate aggregated cost statistics
 * @param {Array} conversations - Array of conversation documents
 * @returns {Object} Aggregated cost stats
 */
const calculateAggregatedStats = (conversations) => {
  let totalCost = 0;
  let messageCount = 0;

  const costByModel = {};

  conversations.forEach(conv => {
    if (conv.totalCost?.sum) {
      totalCost += conv.totalCost.sum;
    }

    if (conv.messages) {
      conv.messages.forEach(msg => {
        if (msg.cost?.totalCost) {
          messageCount += 1;
          const model = conv.model || 'unknown';
          if (!costByModel[model]) {
            costByModel[model] = 0;
          }
          costByModel[model] += msg.cost.totalCost;
        }
      });
    }
  });

  return {
    totalCost: parseFloat(totalCost.toFixed(6)),
    messageCount,
    avgCostPerMessage: messageCount > 0
      ? parseFloat((totalCost / messageCount).toFixed(6))
      : 0,
    costByModel: Object.entries(costByModel).map(([model, cost]) => ({
      model,
      cost: parseFloat(cost.toFixed(6))
    }))
  };
};

module.exports = {
  initialize,
  refreshCache,
  isCacheStale,
  getPricingForModel,
  calculateMessageCost,
  calculateConversationCost,
  calculateAggregatedStats
};
```

### Step 2.2: Integrate costCalculator in app.js

**File:** `/src/app.js`

In the startup sequence (in `startServer()` function):

```javascript
// At the beginning of startServer:
const costCalculator = require('./src/services/costCalculator');

// After MongoDB connection check, before routes:
try {
  await costCalculator.initialize();
  logger.info('Cost tracking initialized');
} catch (err) {
  logger.warn('Cost tracking initialization failed', { error: err.message });
  // Continue anyway - graceful degradation
}
```

---

## Phase 3: Chat Integration (Week 1-2, ~2 days)

### Step 3.1: Update chatService

**File:** `/src/services/chatService.js`

After Ollama response (around line 200 in existing code), before saving:

```javascript
// Import at the top
const costCalculator = require('./costCalculator');

// In handleChatRequest, after receiving response from Ollama:
// (Add this around where message is being prepared for save)

// Calculate cost for this message
const messageCost = costCalculator.calculateMessageCost(
  effectiveModel,
  response.stats
);

// Add cost to message object
const assistantMessage = {
  role: 'assistant',
  content: response.content,
  timestamp: new Date(),
  stats: response.stats,
  cost: messageCost
  // ... other fields ...
};

conversation.messages.push(assistantMessage);

// Recalculate conversation total cost
conversation.totalCost = costCalculator.calculateConversationCost(conversation);

// Save conversation
await conversation.save();

// Return in response
return {
  conversationId: conversation._id,
  message: assistantMessage,
  // ... other response fields ...
};
```

**Testing:**
```bash
# Start server and test chat endpoint
npm start

# In another terminal:
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "message": "Hello",
    "messages": []
  }' | jq '.message.cost'

# Should output cost fields
```

---

## Phase 4: Analytics Integration (Week 2, ~3 days)

### Step 4.1: Update /api/analytics/stats

**File:** `/routes/analytics.js`

In the aggregation pipeline for the `/stats` endpoint (around line 385):

```javascript
// In $group stage, add:
totalCost: { $sum: { $ifNull: ['$messages.cost.totalCost', 0] } },
promptTokenCost: { $sum: { $ifNull: ['$messages.cost.promptTokenCost', 0] } },
completionTokenCost: { $sum: { $ifNull: ['$messages.cost.completionTokenCost', 0] } }

// In $project stage, add (before final response):
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
```

**Testing:**
```bash
curl "http://localhost:3080/api/analytics/stats" | jq '.data.breakdown[0].cost'
```

### Step 4.2: Create /api/analytics/cost endpoint

**In `/routes/analytics.js`, add new endpoint:**

```javascript
/**
 * GET /api/analytics/cost
 * Dedicated cost analytics endpoint
 */
router.get('/cost', optionalAuth, async (req, res) => {
  try {
    const { from, to, groupBy = 'model', minCost = 0 } = req.query;

    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateFilter = { createdAt: { $gte: fromDate, $lte: toDate } };

    let groupKey = '$model';
    if (groupBy === 'day') {
      groupKey = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
    } else if (groupBy === 'promptVersion') {
      groupKey = { name: '$promptName', version: '$promptVersion' };
    }

    const costAgg = await Conversation.aggregate([
      { $match: dateFilter },
      { $unwind: '$messages' },
      { $match: { 'messages.cost.totalCost': { $gt: 0 } } },
      { $group: {
          _id: groupKey,
          messageCount: { $sum: 1 },
          totalPromptTokens: { $sum: '$messages.stats.usage.promptTokens' },
          totalCompletionTokens: { $sum: '$messages.stats.usage.completionTokens' },
          totalTokens: { $sum: '$messages.stats.usage.totalTokens' },
          totalCost: { $sum: '$messages.cost.totalCost' },
          promptTokenCost: { $sum: '$messages.cost.promptTokenCost' },
          completionTokenCost: { $sum: '$messages.cost.completionTokenCost' }
        }
      },
      { $project: {
          _id: 0,
          key: '$_id',
          messageCount: 1,
          promptTokens: '$totalPromptTokens',
          completionTokens: '$totalCompletionTokens',
          totalTokens: 1,
          totalCost: 1,
          promptTokenCost: 1,
          completionTokenCost: 1,
          avgCostPerMessage: {
            $cond: [{ $gt: ['$messageCount', 0] },
                    { $divide: ['$totalCost', '$messageCount'] },
                    0]
          },
          costPerThousandTokens: {
            $cond: [{ $gt: ['$totalTokens', 0] },
                    { $divide: ['$totalCost', { $divide: ['$totalTokens', 1000] }] },
                    0]
          }
        }
      },
      { $match: { totalCost: { $gte: parseFloat(minCost) } } },
      { $sort: { totalCost: -1 } }
    ]);

    // Calculate totals
    const summary = costAgg.reduce((acc, curr) => {
      acc.totalCost += curr.totalCost;
      acc.totalMessages += curr.messageCount;
      acc.totalTokens += curr.totalTokens;
      return acc;
    }, { totalCost: 0, totalMessages: 0, totalTokens: 0 });

    const avgCostPerMessage = summary.totalMessages > 0
      ? summary.totalCost / summary.totalMessages
      : 0;
    const costPerThousandTokens = summary.totalTokens > 0
      ? summary.totalCost / (summary.totalTokens / 1000)
      : 0;

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        currency: process.env.COST_CURRENCY || 'USD',
        summary: {
          totalCost: parseFloat(summary.totalCost.toFixed(6)),
          totalMessages: summary.totalMessages,
          totalTokens: summary.totalTokens,
          avgCostPerMessage: parseFloat(avgCostPerMessage.toFixed(6)),
          costPerThousandTokens: parseFloat(costPerThousandTokens.toFixed(6))
        },
        breakdown: costAgg.map(item => ({
          ...item,
          totalCost: parseFloat(item.totalCost.toFixed(6)),
          avgCostPerMessage: parseFloat(item.avgCostPerMessage.toFixed(6)),
          costPerThousandTokens: parseFloat(item.costPerThousandTokens.toFixed(6))
        }))
      }
    });
  } catch (err) {
    logger.error('Analytics cost error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});
```

**Testing:**
```bash
curl "http://localhost:3080/api/analytics/cost?groupBy=model" | jq '.data'
```

---

## Phase 5: Admin & Testing (Week 2-3, ~2 days)

### Step 5.1: Create Admin Pricing Endpoints

**New File:** `/routes/admin-pricing.js`

```javascript
const express = require('express');
const router = express.Router();
const ModelPricingConfig = require('../models/ModelPricingConfig');
const costCalculator = require('../src/services/costCalculator');
const logger = require('../config/logger');

// Middleware: admin auth (placeholder, implement per your auth system)
const requireAdmin = (req, res, next) => {
  // TODO: Implement admin check
  // For now, allow all (remove in production)
  next();
};

/**
 * GET /api/admin/pricing
 * List all model pricing configurations
 */
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { isActive, provider, modelName } = req.query;
    const filter = {};
    if (isActive) filter.isActive = isActive === 'true';
    if (provider) filter.provider = provider.toLowerCase();
    if (modelName) filter.modelName = modelName.toLowerCase();

    const configs = await ModelPricingConfig.find(filter).sort({ provider: 1, modelName: 1 });

    res.json({
      status: 'success',
      data: configs,
      count: configs.length
    });
  } catch (err) {
    logger.error('Failed to list pricing', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/admin/pricing
 * Create new pricing configuration
 */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { provider, modelName, displayName, pricing, currency, notes, effectiveDate } = req.body;

    if (!provider || !modelName || !pricing) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: provider, modelName, pricing'
      });
    }

    const config = new ModelPricingConfig({
      provider: provider.toLowerCase(),
      modelName: modelName.toLowerCase(),
      displayName,
      pricing: {
        promptTokenCost: pricing.promptTokenCost || 0,
        completionTokenCost: pricing.completionTokenCost || 0,
        embeddingCost: pricing.embeddingCost
      },
      currency: currency || 'USD',
      notes,
      effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
      createdBy: req.user?.id || 'api'
    });

    await config.save();

    // Refresh cache
    await costCalculator.refreshCache();

    res.status(201).json({
      status: 'success',
      data: config
    });
  } catch (err) {
    logger.error('Failed to create pricing', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/admin/pricing/refresh
 * Refresh pricing cache
 */
router.post('/refresh', requireAdmin, async (req, res) => {
  try {
    const result = await costCalculator.refreshCache();

    res.json({
      status: result.success ? 'success' : 'error',
      message: result.success ? 'Pricing cache refreshed' : result.error,
      modelsLoaded: result.modelsLoaded,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('Cache refresh failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
```

**Mount in app.js:**
```javascript
const adminPricingRouter = require('./routes/admin-pricing');
app.use('/api/admin/pricing', adminPricingRouter);
```

### Step 5.2: Create Unit Tests

**File:** `/tests/unit/costCalculator.test.js`

```javascript
const costCalculator = require('../../src/services/costCalculator');

describe('costCalculator', () => {
  beforeEach(() => {
    process.env.COST_TRACKING_ENABLED = 'true';
    process.env.COST_CURRENCY = 'USD';
  });

  describe('calculateMessageCost', () => {
    it('should calculate cost correctly', () => {
      process.env.OLLAMA_LLAMA3_PROMPT_COST_PER_1M = '5.00';
      process.env.OLLAMA_LLAMA3_COMPLETION_COST_PER_1M = '15.00';

      const stats = {
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150
        }
      };

      const cost = costCalculator.calculateMessageCost('llama3', stats);

      expect(cost.promptTokenCost).toBeCloseTo(0.0005, 6);
      expect(cost.completionTokenCost).toBeCloseTo(0.00075, 6);
      expect(cost.totalCost).toBeCloseTo(0.00125, 6);
    });

    it('should handle missing stats', () => {
      const cost = costCalculator.calculateMessageCost('llama3', null);

      expect(cost.totalCost).toBe(0);
      expect(cost.pricingSource.source).toBe('no-token-data');
    });

    it('should return zero when tracking disabled', () => {
      process.env.COST_TRACKING_ENABLED = 'false';

      const cost = costCalculator.calculateMessageCost('llama3', { usage: { promptTokens: 100, completionTokens: 50 } });

      expect(cost.totalCost).toBe(0);
    });
  });

  describe('getPricingForModel', () => {
    it('should resolve pricing in correct order', () => {
      process.env.OLLAMA_DEFAULT_PROMPT_COST_PER_1M = '2.00';
      process.env.OLLAMA_DEFAULT_COMPLETION_COST_PER_1M = '6.00';
      process.env.DEFAULT_FALLBACK_PROMPT_COST_PER_1M = '1.00';

      const pricing = costCalculator.getPricingForModel('ollama', 'unknown_model');

      expect(pricing.promptTokenCost).toBe(2.00); // Uses provider default
      expect(pricing.source).toBe('environment-provider-default');
    });
  });
});
```

**Run tests:**
```bash
npm test -- tests/unit/costCalculator.test.js
```

---

## Checklist

### Phase 1 Completion
- [ ] ModelPricingConfig model created
- [ ] Conversation model updated with cost fields
- [ ] .env.example updated
- [ ] npm test passes

### Phase 2 Completion
- [ ] costCalculator.js created and exports all functions
- [ ] costCalculator initialized in app.js startup
- [ ] Unit tests created and passing

### Phase 3 Completion
- [ ] chatService updated to calculate and store costs
- [ ] Manual chat test shows cost in response
- [ ] Conversation documents have cost fields

### Phase 4 Completion
- [ ] /api/analytics/stats includes cost fields
- [ ] /api/analytics/cost endpoint working
- [ ] Analytics test script passes

### Phase 5 Completion
- [ ] Admin pricing endpoints created
- [ ] Pricing can be created/updated via API
- [ ] Cache refresh working
- [ ] All integration tests passing

---

## Deployment Checklist

Before deploying to production:

- [ ] All environment variables set in `.env`
- [ ] Initial pricing data loaded (either via env vars or API)
- [ ] Database indexes created for cost fields
- [ ] Admin endpoints protected with authentication
- [ ] Load tests show acceptable performance
- [ ] Analytics queries optimized (use indexes)
- [ ] Error handling tested for missing pricing
- [ ] Monitoring alerts set for cost anomalies

---

## Next Steps

After Phase 5:

1. **Frontend Integration** - Display costs in UI
2. **Historical Data Migration** - Backfill costs for old messages (optional)
3. **Advanced Analytics** - Cost trends, projections, budgeting
4. **Multi-User Cost Attribution** - Track costs per user
5. **Cost Budgets** - Set limits and alerts

---

**For full design details, see:** `/docs/COST_TRACKING_DESIGN.md`

**For quick reference, see:** `/docs/COST_TRACKING_QUICK_REFERENCE.md`

**For schema reference, see:** `/docs/COST_TRACKING_SCHEMA.md`
