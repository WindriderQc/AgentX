# External Agent Task: Cost Tracking & Usage Analytics

**Date:** 2026-01-08
**Estimated Effort:** 32-40 hours (4-5 days)
**Priority:** HIGH - Visibility into LLM costs and usage patterns
**Agent Type:** Full-Stack (Backend + Frontend)

---

## 🎯 Objective

Build comprehensive cost tracking and usage analytics to give users visibility into:
- Token usage per conversation, model, and time period
- Estimated costs (even for local Ollama - track compute usage)
- Usage trends and patterns
- Model comparison (speed, cost, quality)
- Daily/weekly/monthly summaries

---

## 📊 Current State

**What Exists:**
- Conversations store `model` field
- Messages have `content` (can estimate tokens)
- No cost tracking whatsoever
- No usage analytics dashboard

**What's Missing:**
- Token counting (prompt + completion)
- Cost calculation per model
- Usage aggregation/analytics
- Cost tracking UI/dashboard
- Historical trends

---

## 🏗️ Architecture Design

### Phase 1: Token Tracking Service (8-10 hours)

#### 1.1 Create Token Counter Service

**File:** `/src/services/tokenCounter.js` (NEW)

```javascript
/**
 * Token Counter Service
 * Estimates token usage for cost tracking
 */

class TokenCounterService {
  constructor() {
    // Token estimation: ~4 chars per token (rough average)
    this.CHARS_PER_TOKEN = 4;

    // Model cost rates (per 1M tokens)
    this.MODEL_COSTS = {
      // OpenAI-style pricing (for reference, even if using Ollama)
      'gpt-4': { prompt: 30.00, completion: 60.00 },
      'gpt-3.5-turbo': { prompt: 0.50, completion: 1.50 },

      // Ollama models (estimate compute cost)
      'llama3.1:8b': { prompt: 0.10, completion: 0.20 },
      'llama3.1:70b': { prompt: 0.50, completion: 1.00 },
      'gemma2:2b': { prompt: 0.05, completion: 0.10 },
      'mistral:7b': { prompt: 0.10, completion: 0.20 },

      // Default for unknown models
      'default': { prompt: 0.10, completion: 0.20 }
    };
  }

  /**
   * Estimate token count from text
   * @param {string} text - Text to count tokens for
   * @returns {number} Estimated token count
   */
  countTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / this.CHARS_PER_TOKEN);
  }

  /**
   * Calculate cost for token usage
   * @param {string} model - Model name
   * @param {number} promptTokens - Prompt token count
   * @param {number} completionTokens - Completion token count
   * @returns {number} Cost in USD
   */
  calculateCost(model, promptTokens, completionTokens) {
    const rates = this.MODEL_COSTS[model] || this.MODEL_COSTS['default'];

    const promptCost = (promptTokens / 1000000) * rates.prompt;
    const completionCost = (completionTokens / 1000000) * rates.completion;

    return promptCost + completionCost;
  }

  /**
   * Get model pricing info
   * @param {string} model - Model name
   * @returns {object} Pricing info
   */
  getModelPricing(model) {
    return this.MODEL_COSTS[model] || this.MODEL_COSTS['default'];
  }

  /**
   * Analyze conversation token usage
   * @param {object} conversation - Conversation document
   * @returns {object} Token usage breakdown
   */
  analyzeConversation(conversation) {
    let promptTokens = 0;
    let completionTokens = 0;

    conversation.messages.forEach(msg => {
      const tokens = this.countTokens(msg.content);

      if (msg.role === 'user' || msg.role === 'system') {
        promptTokens += tokens;
      } else if (msg.role === 'assistant') {
        completionTokens += tokens;
      }
    });

    const totalTokens = promptTokens + completionTokens;
    const cost = this.calculateCost(conversation.model, promptTokens, completionTokens);

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      cost,
      model: conversation.model
    };
  }
}

// Export singleton
let instance = null;
function getTokenCounter() {
  if (!instance) {
    instance = new TokenCounterService();
  }
  return instance;
}

module.exports = { getTokenCounter, TokenCounterService };
```

#### 1.2 Add Usage Tracking to Conversation Model

**File:** `/models/Conversation.js` (MODIFY)

Add new fields to track token usage:

```javascript
const ConversationSchema = new mongoose.Schema({
  // ... existing fields ...

  // NEW: Token usage tracking
  usage: {
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    estimatedCost: { type: Number, default: 0 }  // USD
  },

  // NEW: Track last usage update
  lastUsageUpdate: { type: Date, default: Date.now }
});

// Helper method to update usage stats
ConversationSchema.methods.updateUsage = function() {
  const { getTokenCounter } = require('../src/services/tokenCounter');
  const tokenCounter = getTokenCounter();

  const analysis = tokenCounter.analyzeConversation(this);

  this.usage = {
    promptTokens: analysis.promptTokens,
    completionTokens: analysis.completionTokens,
    totalTokens: analysis.totalTokens,
    estimatedCost: analysis.cost
  };
  this.lastUsageUpdate = new Date();

  return this.usage;
};
```

#### 1.3 Integrate Usage Tracking into Chat Service

**File:** `/src/services/chatService.js` (MODIFY)

Update usage stats after each message:

```javascript
// In sendMessage() function, after saving conversation:

// Update token usage stats
conversation.updateUsage();
await conversation.save();

logger.info('Token usage updated', {
  conversationId: conversation._id,
  totalTokens: conversation.usage.totalTokens,
  estimatedCost: conversation.usage.estimatedCost
});
```

---

### Phase 2: Usage Analytics Service (10-12 hours)

#### 2.1 Create Analytics Service

**File:** `/src/services/usageAnalyticsService.js` (NEW)

```javascript
/**
 * Usage Analytics Service
 * Aggregates usage data for reporting
 */

const Conversation = require('../models/Conversation');
const { getTokenCounter } = require('./tokenCounter');

class UsageAnalyticsService {
  /**
   * Get usage summary for a time period
   * @param {string} userId - User ID
   * @param {string} workspaceId - Workspace ID (optional)
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Promise<object>} Usage summary
   */
  async getUsageSummary(userId, workspaceId, startDate, endDate) {
    const query = {
      userId,
      createdAt: { $gte: startDate, $lte: endDate }
    };

    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    const pipeline = [
      { $match: query },
      {
        $group: {
          _id: null,
          totalConversations: { $sum: 1 },
          totalMessages: { $sum: { $size: '$messages' } },
          totalPromptTokens: { $sum: '$usage.promptTokens' },
          totalCompletionTokens: { $sum: '$usage.completionTokens' },
          totalTokens: { $sum: '$usage.totalTokens' },
          totalCost: { $sum: '$usage.estimatedCost' }
        }
      }
    ];

    const [result] = await Conversation.aggregate(pipeline);

    return result || {
      totalConversations: 0,
      totalMessages: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCost: 0
    };
  }

  /**
   * Get usage by model
   * @param {string} userId - User ID
   * @param {string} workspaceId - Workspace ID (optional)
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Promise<Array>} Usage by model
   */
  async getUsageByModel(userId, workspaceId, startDate, endDate) {
    const query = {
      userId,
      createdAt: { $gte: startDate, $lte: endDate }
    };

    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    const pipeline = [
      { $match: query },
      {
        $group: {
          _id: '$model',
          conversations: { $sum: 1 },
          messages: { $sum: { $size: '$messages' } },
          promptTokens: { $sum: '$usage.promptTokens' },
          completionTokens: { $sum: '$usage.completionTokens' },
          totalTokens: { $sum: '$usage.totalTokens' },
          cost: { $sum: '$usage.estimatedCost' },
          avgTokensPerConversation: { $avg: '$usage.totalTokens' }
        }
      },
      { $sort: { cost: -1 } }
    ];

    return await Conversation.aggregate(pipeline);
  }

  /**
   * Get daily usage trend
   * @param {string} userId - User ID
   * @param {string} workspaceId - Workspace ID (optional)
   * @param {number} days - Number of days to look back
   * @returns {Promise<Array>} Daily usage data
   */
  async getDailyUsage(userId, workspaceId, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const query = {
      userId,
      createdAt: { $gte: startDate }
    };

    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    const pipeline = [
      { $match: query },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          conversations: { $sum: 1 },
          messages: { $sum: { $size: '$messages' } },
          tokens: { $sum: '$usage.totalTokens' },
          cost: { $sum: '$usage.estimatedCost' }
        }
      },
      { $sort: { _id: 1 } }
    ];

    return await Conversation.aggregate(pipeline);
  }

  /**
   * Get top conversations by cost
   * @param {string} userId - User ID
   * @param {string} workspaceId - Workspace ID (optional)
   * @param {number} limit - Number of results
   * @returns {Promise<Array>} Top conversations
   */
  async getTopConversations(userId, workspaceId, limit = 10) {
    const query = { userId };
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    return await Conversation
      .find(query)
      .select('title model usage createdAt updatedAt')
      .sort({ 'usage.estimatedCost': -1 })
      .limit(limit);
  }
}

// Export singleton
let instance = null;
function getUsageAnalytics() {
  if (!instance) {
    instance = new UsageAnalyticsService();
  }
  return instance;
}

module.exports = { getUsageAnalytics, UsageAnalyticsService };
```

#### 2.2 Create Analytics Routes

**File:** `/routes/analytics.js` (MODIFY or CREATE)

```javascript
const express = require('express');
const router = express.Router();
const { optionalAuth, requireAuth } = require('../src/middleware/auth');
const { attachWorkspace } = require('../src/middleware/workspace');
const { getUsageAnalytics } = require('../src/services/usageAnalyticsService');
const logger = require('../config/logger');

// Helper to get userId
function getUserId(res) {
  return res.locals.user?.userId || res.locals.defaultUserId || 'default';
}

// GET /api/analytics/usage/summary
router.get('/usage/summary', optionalAuth, attachWorkspace, async (req, res) => {
  try {
    const userId = getUserId(res);
    const workspaceId = req.workspace?._id || null;

    const { period = '30d' } = req.query;

    // Parse period (7d, 30d, 90d, all)
    const endDate = new Date();
    let startDate;

    if (period === '7d') {
      startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === '30d') {
      startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else if (period === '90d') {
      startDate = new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);
    } else {
      startDate = new Date(0); // All time
    }

    const analytics = getUsageAnalytics();
    const summary = await analytics.getUsageSummary(userId, workspaceId, startDate, endDate);

    res.json({ status: 'success', data: summary });
  } catch (err) {
    logger.error('Failed to get usage summary', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/analytics/usage/by-model
router.get('/usage/by-model', optionalAuth, attachWorkspace, async (req, res) => {
  try {
    const userId = getUserId(res);
    const workspaceId = req.workspace?._id || null;

    const { period = '30d' } = req.query;

    const endDate = new Date();
    let startDate;

    if (period === '7d') {
      startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === '30d') {
      startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else if (period === '90d') {
      startDate = new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);
    } else {
      startDate = new Date(0);
    }

    const analytics = getUsageAnalytics();
    const byModel = await analytics.getUsageByModel(userId, workspaceId, startDate, endDate);

    res.json({ status: 'success', data: byModel });
  } catch (err) {
    logger.error('Failed to get usage by model', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/analytics/usage/daily
router.get('/usage/daily', optionalAuth, attachWorkspace, async (req, res) => {
  try {
    const userId = getUserId(res);
    const workspaceId = req.workspace?._id || null;

    const { days = 30 } = req.query;
    const validDays = Math.min(parseInt(days) || 30, 365);

    const analytics = getUsageAnalytics();
    const daily = await analytics.getDailyUsage(userId, workspaceId, validDays);

    res.json({ status: 'success', data: daily });
  } catch (err) {
    logger.error('Failed to get daily usage', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/analytics/usage/top-conversations
router.get('/usage/top-conversations', optionalAuth, attachWorkspace, async (req, res) => {
  try {
    const userId = getUserId(res);
    const workspaceId = req.workspace?._id || null;

    const { limit = 10 } = req.query;
    const validLimit = Math.min(parseInt(limit) || 10, 50);

    const analytics = getUsageAnalytics();
    const top = await analytics.getTopConversations(userId, workspaceId, validLimit);

    res.json({ status: 'success', data: top });
  } catch (err) {
    logger.error('Failed to get top conversations', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
```

---

### Phase 3: Frontend Dashboard (12-16 hours)

#### 3.1 Create Cost Tracking Dashboard Page

**File:** `/public/cost-tracking.html` (NEW)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cost Tracking - AgentX</title>
  <link rel="stylesheet" href="/styles.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</head>
<body>
  <div class="app-layout">
    <!-- Navigation -->
    <nav class="top-nav">
      <div class="nav-left">
        <h1>💰 Cost Tracking</h1>
      </div>
      <div class="nav-right">
        <a href="/" class="nav-link">← Back to Chat</a>
      </div>
    </nav>

    <!-- Main Content -->
    <main class="main-content">
      <!-- Period Selector -->
      <div class="period-selector">
        <button class="period-btn active" data-period="7d">Last 7 Days</button>
        <button class="period-btn" data-period="30d">Last 30 Days</button>
        <button class="period-btn" data-period="90d">Last 90 Days</button>
        <button class="period-btn" data-period="all">All Time</button>
      </div>

      <!-- Summary Cards -->
      <div class="summary-grid">
        <div class="summary-card">
          <div class="card-icon">💬</div>
          <div class="card-content">
            <div class="card-label">Total Conversations</div>
            <div class="card-value" id="totalConversations">-</div>
          </div>
        </div>

        <div class="summary-card">
          <div class="card-icon">📊</div>
          <div class="card-content">
            <div class="card-label">Total Tokens</div>
            <div class="card-value" id="totalTokens">-</div>
          </div>
        </div>

        <div class="summary-card">
          <div class="card-icon">💰</div>
          <div class="card-content">
            <div class="card-label">Estimated Cost</div>
            <div class="card-value" id="totalCost">-</div>
          </div>
        </div>

        <div class="summary-card">
          <div class="card-icon">📈</div>
          <div class="card-content">
            <div class="card-label">Avg Cost/Conversation</div>
            <div class="card-value" id="avgCost">-</div>
          </div>
        </div>
      </div>

      <!-- Charts Row 1 -->
      <div class="charts-grid">
        <div class="chart-card">
          <h3>Daily Usage Trend</h3>
          <canvas id="dailyUsageChart"></canvas>
        </div>

        <div class="chart-card">
          <h3>Usage by Model</h3>
          <canvas id="modelUsageChart"></canvas>
        </div>
      </div>

      <!-- Top Conversations Table -->
      <div class="table-card">
        <h3>Top 10 Most Expensive Conversations</h3>
        <table id="topConversationsTable">
          <thead>
            <tr>
              <th>Title</th>
              <th>Model</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            <!-- Populated by JS -->
          </tbody>
        </table>
      </div>
    </main>
  </div>

  <script src="/js/workspace.js"></script>
  <script src="/js/cost-tracking.js"></script>
</body>
</html>
```

#### 3.2 Cost Tracking JavaScript

**File:** `/public/js/cost-tracking.js` (NEW)

```javascript
/**
 * Cost Tracking Dashboard
 */

let currentPeriod = '30d';
let dailyChart = null;
let modelChart = null;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
  initPeriodSelector();
  loadDashboardData();
});

function initPeriodSelector() {
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      loadDashboardData();
    });
  });
}

async function loadDashboardData() {
  try {
    await Promise.all([
      loadSummary(),
      loadDailyUsage(),
      loadModelUsage(),
      loadTopConversations()
    ]);
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
    showError('Failed to load cost tracking data');
  }
}

async function loadSummary() {
  const url = window.WorkspaceManager
    ? WorkspaceManager.addWorkspaceParam(`/api/analytics/usage/summary?period=${currentPeriod}`)
    : `/api/analytics/usage/summary?period=${currentPeriod}`;

  const res = await fetch(url);
  const { data } = await res.json();

  document.getElementById('totalConversations').textContent =
    data.totalConversations.toLocaleString();
  document.getElementById('totalTokens').textContent =
    data.totalTokens.toLocaleString();
  document.getElementById('totalCost').textContent =
    `$${data.totalCost.toFixed(4)}`;
  document.getElementById('avgCost').textContent =
    data.totalConversations > 0
      ? `$${(data.totalCost / data.totalConversations).toFixed(4)}`
      : '$0.00';
}

async function loadDailyUsage() {
  const days = currentPeriod === '7d' ? 7 : currentPeriod === '30d' ? 30 : 90;

  const url = window.WorkspaceManager
    ? WorkspaceManager.addWorkspaceParam(`/api/analytics/usage/daily?days=${days}`)
    : `/api/analytics/usage/daily?days=${days}`;

  const res = await fetch(url);
  const { data } = await res.json();

  const labels = data.map(d => d._id);
  const tokens = data.map(d => d.tokens);
  const costs = data.map(d => d.cost);

  if (dailyChart) {
    dailyChart.destroy();
  }

  const ctx = document.getElementById('dailyUsageChart').getContext('2d');
  dailyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Tokens',
          data: tokens,
          borderColor: 'rgba(124, 240, 255, 1)',
          backgroundColor: 'rgba(124, 240, 255, 0.1)',
          yAxisID: 'y'
        },
        {
          label: 'Cost ($)',
          data: costs,
          borderColor: 'rgba(238, 176, 255, 1)',
          backgroundColor: 'rgba(238, 176, 255, 0.1)',
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { type: 'linear', position: 'left', title: { display: true, text: 'Tokens' } },
        y1: { type: 'linear', position: 'right', title: { display: true, text: 'Cost ($)' }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

async function loadModelUsage() {
  const url = window.WorkspaceManager
    ? WorkspaceManager.addWorkspaceParam(`/api/analytics/usage/by-model?period=${currentPeriod}`)
    : `/api/analytics/usage/by-model?period=${currentPeriod}`;

  const res = await fetch(url);
  const { data } = await res.json();

  const labels = data.map(d => d._id || 'Unknown');
  const costs = data.map(d => d.cost);

  if (modelChart) {
    modelChart.destroy();
  }

  const ctx = document.getElementById('modelUsageChart').getContext('2d');
  modelChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: costs,
        backgroundColor: [
          'rgba(124, 240, 255, 0.8)',
          'rgba(238, 176, 255, 0.8)',
          'rgba(255, 176, 124, 0.8)',
          'rgba(176, 255, 124, 0.8)',
          'rgba(255, 124, 176, 0.8)'
        ]
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right' },
        tooltip: {
          callbacks: {
            label: (context) => {
              const label = context.label || '';
              const value = context.parsed || 0;
              return `${label}: $${value.toFixed(4)}`;
            }
          }
        }
      }
    }
  });
}

async function loadTopConversations() {
  const url = window.WorkspaceManager
    ? WorkspaceManager.addWorkspaceParam('/api/analytics/usage/top-conversations')
    : '/api/analytics/usage/top-conversations';

  const res = await fetch(url);
  const { data } = await res.json();

  const tbody = document.querySelector('#topConversationsTable tbody');
  tbody.innerHTML = '';

  data.forEach(conv => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><a href="/?conversation=${conv._id}">${conv.title || 'Untitled'}</a></td>
      <td><span class="model-badge">${conv.model}</span></td>
      <td>${conv.usage?.totalTokens.toLocaleString() || 0}</td>
      <td>$${(conv.usage?.estimatedCost || 0).toFixed(4)}</td>
      <td>${new Date(conv.updatedAt).toLocaleDateString()}</td>
    `;
    tbody.appendChild(row);
  });
}

function showError(message) {
  // Implement toast notification
  console.error(message);
}
```

#### 3.3 Add Cost Display to Chat UI

**File:** `/public/index.html` (MODIFY)

Add cost display to conversation header:

```html
<!-- In conversation header area -->
<div class="conversation-stats">
  <span id="conversationTokens" class="stat-badge">
    <i class="fas fa-chart-bar"></i>
    <span id="tokenCount">0</span> tokens
  </span>
  <span id="conversationCost" class="stat-badge">
    <i class="fas fa-dollar-sign"></i>
    $<span id="costAmount">0.00</span>
  </span>
</div>
```

**File:** `/public/js/chat.js` (MODIFY)

Update cost display when conversation loads:

```javascript
function updateConversationStats(conversation) {
  if (conversation.usage) {
    document.getElementById('tokenCount').textContent =
      conversation.usage.totalTokens.toLocaleString();
    document.getElementById('costAmount').textContent =
      conversation.usage.estimatedCost.toFixed(4);
  }
}

// Call after loading conversation
updateConversationStats(currentConversation);
```

---

### Phase 4: Migration & Testing (6-8 hours)

#### 4.1 Migration Script

**File:** `/scripts/backfill-usage-stats.js` (NEW)

```javascript
/**
 * Backfill usage stats for existing conversations
 */

const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const { getTokenCounter } = require('../src/services/tokenCounter');

async function backfillUsageStats() {
  await mongoose.connect(process.env.MONGODB_URI);

  const tokenCounter = getTokenCounter();

  // Process in batches
  const batchSize = 100;
  let processed = 0;

  while (true) {
    const conversations = await Conversation.find({
      'usage.totalTokens': { $exists: false }
    }).limit(batchSize);

    if (conversations.length === 0) break;

    for (const conv of conversations) {
      conv.updateUsage();
      await conv.save();
      processed++;

      if (processed % 10 === 0) {
        console.log(`Processed ${processed} conversations...`);
      }
    }
  }

  console.log(`Backfill complete! Processed ${processed} conversations.`);
  await mongoose.disconnect();
}

backfillUsageStats().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
```

#### 4.2 Unit Tests

**File:** `/tests/unit/tokenCounter.test.js` (NEW)

Test token counting and cost calculation.

#### 4.3 Integration Tests

**File:** `/tests/integration/usage-analytics.test.js` (NEW)

Test analytics endpoints and aggregations.

---

## ✅ Success Criteria

**Backend:**
- ✅ Token counting service with accurate estimates
- ✅ Usage stats tracked per conversation
- ✅ Analytics aggregations (summary, by model, daily trend)
- ✅ Cost calculation for all models

**Frontend:**
- ✅ Cost tracking dashboard with charts
- ✅ Real-time cost display in chat UI
- ✅ Period selector (7d, 30d, 90d, all)
- ✅ Top conversations by cost

**Quality:**
- ✅ Accurate token estimation (±10%)
- ✅ Fast analytics queries (<100ms)
- ✅ Beautiful visualizations (Chart.js)

---

## 📊 Expected Impact

**User Value:**
- 💰 Visibility into LLM costs (even for free local models)
- 📈 Usage patterns and trends
- 🎯 Identify expensive conversations
- 📊 Model comparison (which models are most cost-effective)

**Technical Value:**
- Token tracking for future optimizations
- Usage data for capacity planning
- Cost baseline for evaluating RAG compression savings

---

## 🚀 Implementation Order

1. **Day 1-2:** Token counter service + model integration (8-10h)
2. **Day 3:** Analytics service + routes (10-12h)
3. **Day 4-5:** Frontend dashboard + UI integration (12-16h)
4. **Day 5:** Migration + testing (6-8h)

**Total: 32-40 hours**

---

## 🎁 Bonus Enhancements (If Time Permits)

- Export usage data to CSV
- Cost alerts (email when exceeding threshold)
- Budget tracking (set monthly budget)
- Model recommendation (suggest cheaper alternatives)

---

**READY TO ROCK! 🎸**

This feature gives you complete visibility into your LLM usage and costs. Even for local Ollama, it helps track compute usage and optimize model selection.

Go build it! 💪
