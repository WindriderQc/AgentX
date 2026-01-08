# External Agent Task: Cost Tracking & Usage Analytics

**Your Mission:** Build comprehensive cost tracking and usage analytics to give users visibility into token usage, costs, and usage patterns.

**Estimated Effort:** 32-40 hours (4-5 days)
**Priority:** HIGH - Visibility into LLM costs and usage patterns
**Source Specification:** `/EXTERNAL_AGENT_NEXT_COST_TRACKING.md`

---

## 🎯 Objective

Implement a full-stack cost tracking system that provides:
- Token usage per conversation, model, and time period
- Estimated costs (even for local Ollama - track compute usage)
- Usage trends and patterns
- Model comparison (speed, cost, quality)
- Daily/weekly/monthly summaries
- Beautiful dashboard with charts

---

## 📊 Current State Analysis

**What Exists:**
- ✅ Conversations store `model` field
- ✅ Messages have `content` (can estimate tokens)
- ❌ No cost tracking whatsoever
- ❌ No usage analytics dashboard
- ❌ No token counting
- ❌ No cost calculation per model

**Critical Context:**
- Conversation model: `/models/Conversation.js` (130 lines)
- Chat service: `/src/services/chatService.js` (orchestrates chat flow)
- Existing analytics routes: `/routes/analytics.js` (may need extension)
- Frontend styles: `/public/styles.css` (dark theme, cyberpunk aesthetic)

---

## 📂 Implementation Phases

### **Phase 1: Token Tracking Service (8-10 hours)**

#### 1.1 Create Token Counter Service (4-5 hours)

**File:** `/src/services/tokenCounter.js` (NEW - ~150 lines)

**Requirements:**
- Singleton service using `getTokenCounter()` pattern (follow existing patterns in codebase)
- Character-to-token estimation: ~4 chars per token
- Model cost rates per 1M tokens (configurable)
- Methods:
  - `countTokens(text)` - Estimate token count from text
  - `calculateCost(model, promptTokens, completionTokens)` - Calculate USD cost
  - `getModelPricing(model)` - Get pricing info for a model
  - `analyzeConversation(conversation)` - Full conversation analysis

**Model Pricing (Default Rates):**
```javascript
MODEL_COSTS = {
  // OpenAI (reference)
  'gpt-4': { prompt: 30.00, completion: 60.00 },
  'gpt-3.5-turbo': { prompt: 0.50, completion: 1.50 },

  // Ollama models (compute cost estimates)
  'llama3.1:8b': { prompt: 0.10, completion: 0.20 },
  'llama3.1:70b': { prompt: 0.50, completion: 1.00 },
  'deepseek-r1:70b': { prompt: 0.50, completion: 1.00 },
  'gemma2:2b': { prompt: 0.05, completion: 0.10 },
  'mistral:7b': { prompt: 0.10, completion: 0.20 },
  'qwen2.5:72b': { prompt: 0.50, completion: 1.00 },

  // Default for unknown models
  'default': { prompt: 0.10, completion: 0.20 }
}
```

**Token Counting Logic:**
```javascript
countTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / this.CHARS_PER_TOKEN);
}
```

**Conversation Analysis:**
```javascript
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
```

**Testing:** Create `/tests/unit/tokenCounter.test.js` with:
- Token counting accuracy tests
- Cost calculation tests (different models)
- Edge cases (empty text, null values)
- Conversation analysis tests

#### 1.2 Add Usage Fields to Conversation Model (2-3 hours)

**File:** `/models/Conversation.js` (MODIFY)

**Add to ConversationSchema:**
```javascript
// NEW: Token usage tracking
usage: {
  promptTokens: { type: Number, default: 0 },
  completionTokens: { type: Number, default: 0 },
  totalTokens: { type: Number, default: 0 },
  estimatedCost: { type: Number, default: 0 }  // USD
},

// NEW: Track last usage update
lastUsageUpdate: { type: Date, default: Date.now }
```

**Add Helper Method:**
```javascript
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

**Add Indexes:**
```javascript
ConversationSchema.index({ 'usage.estimatedCost': -1 }); // For top conversations query
ConversationSchema.index({ 'usage.totalTokens': -1 });
```

#### 1.3 Integrate Usage Tracking into Chat Service (2 hours)

**File:** `/src/services/chatService.js` (MODIFY)

**In `sendMessage()` function (after saving conversation):**
```javascript
// Update token usage stats
conversation.updateUsage();
await conversation.save();

logger.info('Token usage updated', {
  conversationId: conversation._id,
  totalTokens: conversation.usage.totalTokens,
  estimatedCost: conversation.usage.estimatedCost
});
```

**IMPORTANT:** Follow existing chatService patterns:
- Use proper error handling
- Add logger statements
- Update both streaming and non-streaming paths
- Test with RAG enabled/disabled

---

### **Phase 2: Usage Analytics Service (10-12 hours)**

#### 2.1 Create Analytics Service (6-8 hours)

**File:** `/src/services/usageAnalyticsService.js` (NEW - ~200 lines)

**Requirements:**
- Singleton pattern: `getUsageAnalytics()`
- MongoDB aggregation pipelines for fast queries
- Workspace-aware (filter by workspaceId if provided)
- Methods:
  - `getUsageSummary(userId, workspaceId, startDate, endDate)` - Overall stats
  - `getUsageByModel(userId, workspaceId, startDate, endDate)` - Per-model breakdown
  - `getDailyUsage(userId, workspaceId, days)` - Daily trend data
  - `getTopConversations(userId, workspaceId, limit)` - Most expensive conversations

**Example Aggregation (Usage Summary):**
```javascript
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
```

**Daily Usage Pipeline:**
```javascript
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
}
```

**Testing:** Create `/tests/integration/usage-analytics.test.js` with:
- Summary calculations (multiple conversations)
- Model breakdown (different models)
- Daily trends (date range queries)
- Top conversations (sorting)
- Workspace isolation (workspace filtering)

#### 2.2 Create/Extend Analytics Routes (4 hours)

**File:** `/routes/analytics.js` (MODIFY or CREATE)

**Add 4 New Endpoints:**

1. **`GET /api/analytics/usage/summary`**
   - Query param: `period` (7d, 30d, 90d, all)
   - Returns: Total conversations, messages, tokens, cost

2. **`GET /api/analytics/usage/by-model`**
   - Query param: `period` (7d, 30d, 90d, all)
   - Returns: Array of { model, conversations, tokens, cost, avgTokensPerConv }

3. **`GET /api/analytics/usage/daily`**
   - Query param: `days` (default: 30, max: 365)
   - Returns: Array of { date, conversations, messages, tokens, cost }

4. **`GET /api/analytics/usage/top-conversations`**
   - Query param: `limit` (default: 10, max: 50)
   - Returns: Array of conversations sorted by cost (desc)

**Middleware:**
- Use `optionalAuth` (supports both auth and non-auth users)
- Use `attachWorkspace` (workspace context)
- Use `getUserId(res)` helper

**Period Parsing Helper:**
```javascript
function parsePeriod(period) {
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

  return { startDate, endDate };
}
```

**Mount Routes in app.js:**
```javascript
// Ensure analytics routes are mounted (may already exist)
app.use('/api/analytics', require('./routes/analytics'));
```

---

### **Phase 3: Frontend Dashboard (12-16 hours)**

#### 3.1 Create Cost Tracking Dashboard Page (6-8 hours)

**File:** `/public/cost-tracking.html` (NEW - ~200 lines)

**Requirements:**
- Use existing AgentX dark theme and styles
- Cyberpunk aesthetic (match existing UI)
- Responsive design (mobile-friendly)
- Navigation bar (link back to chat)

**Layout Sections:**

1. **Period Selector**
   - Buttons: Last 7 Days, Last 30 Days, Last 90 Days, All Time
   - Active state styling

2. **Summary Cards (4 cards in grid)**
   - 💬 Total Conversations
   - 📊 Total Tokens
   - 💰 Estimated Cost
   - 📈 Avg Cost/Conversation

3. **Charts Row 1**
   - Daily Usage Trend (line chart) - tokens + cost on dual Y-axes
   - Usage by Model (doughnut chart) - cost breakdown

4. **Top Conversations Table**
   - Columns: Title, Model, Tokens, Cost, Date
   - Clickable titles (link to conversation)
   - Limit to 10 rows

**Use Chart.js for visualizations:**
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
```

**CSS Styling:**
- Match existing `/public/styles.css` patterns
- Use existing color variables (--accent, --accent-2, --bg, --card-bg, etc.)
- Card shadows and hover effects
- Responsive grid layouts

#### 3.2 Cost Tracking JavaScript (4-5 hours)

**File:** `/public/js/cost-tracking.js` (NEW - ~250 lines)

**Requirements:**
- Workspace-aware API calls (use `window.WorkspaceManager` if available)
- Chart.js initialization and updates
- Period selector event handling
- Loading states and error handling

**Key Functions:**

1. **`loadDashboardData()`** - Load all data in parallel
2. **`loadSummary()`** - Fetch and update summary cards
3. **`loadDailyUsage()`** - Create/update daily trend chart
4. **`loadModelUsage()`** - Create/update model breakdown chart
5. **`loadTopConversations()`** - Populate table

**Chart Configuration Examples:**

**Daily Usage (Line Chart):**
```javascript
new Chart(ctx, {
  type: 'line',
  data: {
    labels: dates,
    datasets: [
      {
        label: 'Tokens',
        data: tokenData,
        borderColor: 'rgba(124, 240, 255, 1)', // --accent
        yAxisID: 'y'
      },
      {
        label: 'Cost ($)',
        data: costData,
        borderColor: 'rgba(238, 176, 255, 1)', // --accent-2
        yAxisID: 'y1'
      }
    ]
  },
  options: {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    scales: {
      y: { position: 'left', title: { text: 'Tokens' } },
      y1: { position: 'right', title: { text: 'Cost ($)' }, grid: { drawOnChartArea: false } }
    }
  }
});
```

**Model Usage (Doughnut Chart):**
```javascript
new Chart(ctx, {
  type: 'doughnut',
  data: {
    labels: modelNames,
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
          label: (context) => `${context.label}: $${context.parsed.toFixed(4)}`
        }
      }
    }
  }
});
```

**Error Handling:**
```javascript
try {
  await loadDashboardData();
} catch (err) {
  console.error('Failed to load dashboard:', err);
  showError('Failed to load cost tracking data. Please try again.');
}
```

#### 3.3 Add Cost Display to Chat UI (2-3 hours)

**File:** `/public/index.html` (MODIFY)

**Add to conversation header area:**
```html
<!-- Conversation stats badges -->
<div class="conversation-stats" style="display: flex; gap: 8px; margin-top: 8px;">
  <span id="conversationTokens" class="stat-badge" style="display: none;">
    <i class="fas fa-chart-bar"></i>
    <span id="tokenCount">0</span> tokens
  </span>
  <span id="conversationCost" class="stat-badge" style="display: none;">
    <i class="fas fa-dollar-sign"></i>
    $<span id="costAmount">0.00</span>
  </span>
</div>
```

**CSS for stat badges:**
```css
.stat-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(124, 240, 255, 0.1);
  border: 1px solid rgba(124, 240, 255, 0.3);
  border-radius: 4px;
  font-size: 12px;
  color: var(--accent);
}

.stat-badge i {
  font-size: 10px;
}
```

**File:** `/public/js/chat.js` (MODIFY)

**Add function to update cost display:**
```javascript
function updateConversationStats(conversation) {
  if (conversation && conversation.usage) {
    document.getElementById('conversationTokens').style.display = 'inline-flex';
    document.getElementById('conversationCost').style.display = 'inline-flex';

    document.getElementById('tokenCount').textContent =
      conversation.usage.totalTokens.toLocaleString();
    document.getElementById('costAmount').textContent =
      conversation.usage.estimatedCost.toFixed(4);
  } else {
    document.getElementById('conversationTokens').style.display = 'none';
    document.getElementById('conversationCost').style.display = 'none';
  }
}
```

**Call after loading conversation:**
```javascript
// In loadConversation() or equivalent function
if (currentConversation) {
  updateConversationStats(currentConversation);
}

// Update after each message
async function sendMessage() {
  // ... existing code ...

  // Refresh conversation to get updated usage stats
  const response = await fetch(`/api/history/${conversationId}`);
  const { data } = await response.json();
  updateConversationStats(data);
}
```

**Add link to cost tracking dashboard in navigation:**
```html
<!-- In nav menu -->
<a href="/cost-tracking.html" class="nav-link">
  <i class="fas fa-dollar-sign"></i> Cost Tracking
</a>
```

---

### **Phase 4: Migration & Testing (6-8 hours)**

#### 4.1 Create Migration Script (3-4 hours)

**File:** `/scripts/backfill-usage-stats.js` (NEW - ~80 lines)

**Requirements:**
- Backfill usage stats for all existing conversations
- Process in batches (100 conversations at a time)
- Progress logging every 10 conversations
- Error handling (log errors, continue processing)
- Graceful MongoDB connection handling

**Implementation:**
```javascript
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const { getTokenCounter } = require('../src/services/tokenCounter');
require('dotenv').config();

async function backfillUsageStats() {
  console.log('Starting usage stats backfill...');

  await mongoose.connect(process.env.MONGODB_URI);

  const tokenCounter = getTokenCounter();

  const batchSize = 100;
  let processed = 0;
  let errors = 0;

  while (true) {
    const conversations = await Conversation.find({
      'usage.totalTokens': { $exists: false }
    }).limit(batchSize);

    if (conversations.length === 0) break;

    for (const conv of conversations) {
      try {
        conv.updateUsage();
        await conv.save();
        processed++;

        if (processed % 10 === 0) {
          console.log(`Processed ${processed} conversations...`);
        }
      } catch (err) {
        console.error(`Error processing conversation ${conv._id}:`, err.message);
        errors++;
      }
    }
  }

  console.log(`\nBackfill complete!`);
  console.log(`✅ Processed: ${processed} conversations`);
  console.log(`❌ Errors: ${errors} conversations`);

  await mongoose.disconnect();
}

backfillUsageStats().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
```

**Usage:**
```bash
node scripts/backfill-usage-stats.js
```

#### 4.2 Unit Tests (2-3 hours)

**File:** `/tests/unit/tokenCounter.test.js` (NEW)

**Test Cases:**
- Token counting (various text lengths)
- Cost calculation (different models)
- Model pricing lookup (known + unknown models)
- Conversation analysis (mixed role messages)
- Edge cases (null, empty, undefined)

**File:** `/tests/unit/usageAnalyticsService.test.js` (NEW)

**Test Cases:**
- Service initialization (singleton pattern)
- Method signatures (all expected methods exist)

#### 4.3 Integration Tests (1-2 hours)

**File:** `/tests/integration/usage-analytics.test.js` (NEW)

**Test Cases:**
- `GET /api/analytics/usage/summary` (various periods)
- `GET /api/analytics/usage/by-model` (multiple models)
- `GET /api/analytics/usage/daily` (different day ranges)
- `GET /api/analytics/usage/top-conversations` (sorting)
- Workspace isolation (workspace-aware queries)
- Authentication (optionalAuth behavior)

**Example Test:**
```javascript
describe('GET /api/analytics/usage/summary', () => {
  it('should return usage summary for 30d period', async () => {
    const res = await request(app)
      .get('/api/analytics/usage/summary?period=30d')
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('totalConversations');
    expect(res.body.data).toHaveProperty('totalTokens');
    expect(res.body.data).toHaveProperty('totalCost');
  });
});
```

---

## ✅ Success Criteria

**Backend Completion:**
- ✅ Token counter service with accurate estimates (±10%)
- ✅ Usage stats automatically tracked per conversation
- ✅ Analytics aggregations (summary, by model, daily, top conversations)
- ✅ Cost calculation for all major models
- ✅ All API endpoints respond <100ms
- ✅ Unit + integration tests passing

**Frontend Completion:**
- ✅ Cost tracking dashboard (`/cost-tracking.html`)
- ✅ Real-time cost display in chat UI
- ✅ Period selector (7d, 30d, 90d, all)
- ✅ Charts render correctly (Chart.js)
- ✅ Top conversations table with sorting
- ✅ Responsive design (mobile + desktop)
- ✅ Dark theme + cyberpunk aesthetic

**Data Quality:**
- ✅ Existing conversations backfilled with usage stats
- ✅ Token counts accurate (±10% of actual)
- ✅ Cost calculations correct (verified against model pricing)
- ✅ Analytics queries performant (<100ms)

**Documentation:**
- ✅ Inline code comments (JSDoc style)
- ✅ README section for cost tracking feature
- ✅ Migration script usage instructions

---

## 🚧 Critical Implementation Notes

### 1. Follow Existing Patterns

**Singleton Services:**
```javascript
// ✅ CORRECT (match existing patterns)
let instance = null;
function getTokenCounter() {
  if (!instance) {
    instance = new TokenCounterService();
  }
  return instance;
}

// ❌ WRONG (don't do this)
module.exports = new TokenCounterService();
```

**Route Handlers:**
```javascript
// ✅ CORRECT (match existing patterns)
router.get('/usage/summary', optionalAuth, attachWorkspace, async (req, res) => {
  try {
    const userId = getUserId(res);
    // ... logic ...
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('Failed to get summary', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});
```

**Logging:**
```javascript
// ✅ CORRECT (use existing logger)
const logger = require('../config/logger');
logger.info('Token usage updated', { conversationId, totalTokens, estimatedCost });

// ❌ WRONG (don't use console.log in services)
console.log('Token usage updated');
```

### 2. Workspace Awareness

**Always check for workspace context:**
```javascript
const query = { userId };

if (workspaceId) {
  query.workspaceId = workspaceId;
}
```

### 3. Performance Considerations

- Use MongoDB aggregation pipelines (not in-memory processing)
- Add indexes on `usage.estimatedCost` and `usage.totalTokens`
- Batch migration script (100 conversations at a time)
- Chart.js lazy loading (initialize on page load, not module load)

### 4. Error Handling

- Always wrap async code in try-catch
- Log errors with context (userId, conversationId, etc.)
- Graceful degradation (if cost tracking fails, don't block chat)
- Return empty results on error (don't return 500 for missing data)

### 5. Testing Strategy

- Unit tests: Pure functions (token counting, cost calculation)
- Integration tests: API endpoints (mock database)
- Manual testing: Dashboard UI (all periods, different models)
- Migration testing: Run on copy of production data

---

## 📦 Deliverables Checklist

**Backend Files:**
- [ ] `/src/services/tokenCounter.js` (~150 lines)
- [ ] `/src/services/usageAnalyticsService.js` (~200 lines)
- [ ] `/routes/analytics.js` (4 new endpoints)
- [ ] `/models/Conversation.js` (usage fields + updateUsage method)
- [ ] `/src/services/chatService.js` (integrate usage tracking)
- [ ] `/scripts/backfill-usage-stats.js` (~80 lines)

**Frontend Files:**
- [ ] `/public/cost-tracking.html` (~200 lines)
- [ ] `/public/js/cost-tracking.js` (~250 lines)
- [ ] `/public/index.html` (conversation stats display)
- [ ] `/public/js/chat.js` (updateConversationStats function)
- [ ] `/public/styles.css` (stat badges, dashboard styles)

**Test Files:**
- [ ] `/tests/unit/tokenCounter.test.js`
- [ ] `/tests/unit/usageAnalyticsService.test.js`
- [ ] `/tests/integration/usage-analytics.test.js`

**Documentation:**
- [ ] Completion report: `/COST_TRACKING_COMPLETION_2026-01-08.md`
- [ ] Update `/ROADMAP.md` (mark cost tracking as complete)

---

## 🎯 Expected Impact

**User Value:**
- 💰 Full visibility into LLM costs (even for free local models)
- 📈 Usage patterns and trends over time
- 🎯 Identify expensive conversations for optimization
- 📊 Model comparison (which models are most cost-effective)
- 💡 Informed decision-making on model selection

**Technical Value:**
- Token tracking enables future optimizations
- Usage data informs capacity planning
- Cost baseline for evaluating RAG compression savings
- Analytics foundation for future features

**Business Value:**
- Cost awareness drives optimization behavior
- Data-driven model selection
- ROI measurement for AgentX features

---

## 🚀 Implementation Timeline

**Day 1 (8 hours):**
- Token counter service (4h)
- Conversation model updates (2h)
- Chat service integration (2h)

**Day 2 (10 hours):**
- Analytics service (6h)
- Analytics routes (4h)

**Day 3 (8 hours):**
- Cost tracking dashboard HTML/CSS (6h)
- Dashboard JavaScript (2h)

**Day 4 (8 hours):**
- Dashboard JavaScript completion (4h)
- Chat UI integration (2h)
- Testing (2h)

**Day 5 (6 hours):**
- Migration script (3h)
- Full testing (3h)

**Total: 40 hours**

---

## 🎁 Bonus Enhancements (If Time Permits)

**Low Effort, High Value:**
- Export usage data to CSV (2h)
- Email cost summary (weekly digest) (3h)

**Medium Effort:**
- Cost alerts (email when exceeding threshold) (4h)
- Budget tracking (set monthly budget) (5h)

**High Effort:**
- Model recommendation (suggest cheaper alternatives) (8h)
- A/B testing (compare model costs across same prompts) (10h)

---

## 🔗 Related Files to Review

**Before Starting:**
- `/models/Conversation.js` - Understand schema structure
- `/src/services/chatService.js` - Understand chat flow
- `/routes/analytics.js` - Check if file exists
- `/public/styles.css` - Learn color variables and styling patterns
- `/src/services/ragStore.js` - Example singleton service

**For Reference:**
- `/src/services/embeddings.js` - Singleton pattern example
- `/routes/history.js` - Route handler patterns
- `/public/js/chat.js` - Frontend API call patterns

---

## 💪 Final Instructions

**You are implementing a complete cost tracking system from scratch.**

**Your mission:**
1. Create token counter service (accurate estimates)
2. Integrate usage tracking into chat flow (automatic)
3. Build analytics service (fast aggregations)
4. Create beautiful dashboard (Chart.js visualizations)
5. Add cost display to chat UI (real-time updates)
6. Write migration script (backfill existing data)
7. Test everything (unit + integration tests)

**Work Order:**
1. Backend first (Phases 1-2)
2. Frontend next (Phase 3)
3. Migration & testing last (Phase 4)

**Code Quality:**
- Follow existing patterns religiously
- Use singleton services
- Add proper error handling
- Write comprehensive tests
- Document complex logic

**When Complete:**
- Run migration script
- Verify dashboard loads
- Check chat UI cost display
- Test all time periods
- Validate calculations

---

**READY TO BUILD! 🚀**

This is your chance to give AgentX users complete visibility into their LLM usage and costs. Make it beautiful, make it fast, make it accurate.

**GO TIME! 💪**
