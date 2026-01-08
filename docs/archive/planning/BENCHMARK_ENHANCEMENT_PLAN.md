# Benchmark System Enhancement Plan
**Date:** January 4, 2026
**Status:** ACTIVE PLAN
**Context:** Post-Peer Review, addressing benchmark feedback + model category tagging system

---

## Executive Summary

Based on comprehensive analysis and peer review feedback, the benchmark system has **excellent backend infrastructure** but **incomplete frontend integration**. This plan addresses:

1. ✅ **Category data collection** (COMPLETE - working perfectly)
2. ❌ **Frontend category filtering** (MISSING - no UI controls)
3. ❌ **Tag-based filtering** (STUB ONLY - TODO placeholder)
4. 🎯 **Model registry with capabilities** (NEW - strategic enhancement)
5. 🚀 **Task-segmented leaderboards** (NEW - per original feedback)

---

## Current State Analysis

### What's Working (Backend ⭐⭐⭐⭐⭐)

**BenchmarkResult Model:**
```javascript
prompt_category: {
  type: String,
  enum: ['coding', 'reasoning', 'factual', 'math', 'creative', 'general'],
  index: true  // ✅ Indexed for performance
}
```

**BenchmarkService Quality Breakdown:**
```javascript
// Line 492-536: Fully implemented, excellent aggregation
getQualityBreakdown(model = null) {
  // Returns: { byCategory, byLevel, byModel }
  // ✅ Sophisticated MongoDB aggregation pipeline
  // ✅ Correctly groups by category and model
}
```

**API Endpoint:**
```javascript
GET /api/benchmark/quality-breakdown?model=<name>
// ✅ Functional
// ❌ Never called from frontend
```

### What's Broken (Frontend ⭐)

**Issue #1: No Category Selector in Leaderboard**
- Leaderboard has sort controls (latency, quality, composite)
- Leaderboard has profile switcher (interactive vs reasoning)
- ❌ NO category filter dropdown
- ❌ NO category parameter passed to API

**Issue #2: Tag Filtering is Dead Code**
```javascript
// public/js/benchmark-analytics.js:463-467
function filterByTag(tag) {
    // TODO: Implement batch filtering by tag
    showToast(`Filtering by tag: ${tag}`, 'info');  // ❌ Just a toast!
}
```

**Issue #3: Quality Breakdown Data Never Used**
- Endpoint exists and works
- Data is collected and aggregated correctly
- Frontend never calls this endpoint
- No UI to display category-specific insights

---

## Strategic Enhancement: Beyond Fixing Gaps

The original feedback identified a deeper issue: **"You're measuring 'best employee' not 'smartest brain'"**

### The Core Problem

The composite score formula:
```javascript
composite_score = (
  normalized_quality * 0.4 +
  normalized_speed * 0.4 +
  normalized_reliability * 0.2
)
```

This optimizes for **operational throughput**, not **capability depth**.

**Symptoms:**
- `smollm2:1.7b` ranking #2 (fast on trivial tasks, fails on complex)
- `deepseek-r1` ranking low (slow but excellent reasoning)
- `nomic-embed-text` in generative leaderboard (wrong benchmark class)

### The Solution: Model Registry + Capability Tagging

Create a **ModelRegistry** that captures:
- What the model is **designed for** (categories)
- What the model is **good at** (capabilities)
- How to **route to it** (selection logic)

Then segment leaderboards by **task fit**, not just raw scores.

---

## Enhancement Tracks

### Track 1: Model Registry & Category System ✨

**Goal:** Single source of truth for model metadata with multi-dimensional tagging.

**Schema:**
```javascript
// models/ModelRegistry.js
const ModelRegistrySchema = new mongoose.Schema({
  // Identity
  modelName: { type: String, required: true, unique: true, index: true },
  displayName: String,
  vendor: String,  // 'meta', 'alibaba', 'deepseek', etc.

  // Categorization (Multi-select)
  categories: [{
    type: String,
    enum: [
      'ops',           // Operations/glue logic
      'coding',        // Code generation
      'reasoning',     // Deep thinking
      'specialist',    // Fine-tuned for specific domain
      'generalist',    // General-purpose
      'embedding',     // Vector embeddings only
      'judge'          // Quality scoring
    ]
  }],

  tags: [String],  // Freeform: ['production', 'experimental', 'fast', 'slow']

  // Capabilities
  capabilities: {
    maxContext: Number,           // 2048, 4096, 128000
    supportsThinking: Boolean,    // Thinking models (qwen, deepseek-r1)
    supportsVision: Boolean,      // Multimodal
    avgLatencyMs: Number,         // Calibrated average
    targetUseCase: String,        // Free text description
    p95LatencyMs: Number,         // From benchmark data
    optimalBatchSize: Number      // For batched inference
  },

  // Deployment
  host: String,                    // Default Ollama host
  isActive: { type: Boolean, default: true, index: true },
  status: {
    type: String,
    enum: ['active', 'deprecated', 'experimental', 'retired'],
    default: 'active'
  },

  // Performance Tracking (Auto-updated from benchmarks)
  benchmarkStats: {
    avgCompositeScore: Number,
    bestCategory: String,         // Category where it excels
    worstCategory: String,        // Category where it struggles
    totalTests: Number,
    lastBenchmarked: Date
  },

  // Routing Hints
  routingRules: {
    preferredFor: [String],       // ['quick_chat', 'code_generation']
    avoidFor: [String],           // ['long_reasoning', 'image_analysis']
    priority: Number              // 1-10 for router selection
  }
}, {
  timestamps: true
});

// Indexes
ModelRegistrySchema.index({ categories: 1 });
ModelRegistrySchema.index({ tags: 1 });
ModelRegistrySchema.index({ status: 1, isActive: 1 });
ModelRegistrySchema.index({ 'capabilities.maxContext': 1 });
```

**Static Methods:**
```javascript
// Query by category
ModelRegistry.findByCategory('coding')

// Query by capability
ModelRegistry.findByMinContext(32000)

// Get best for task type
ModelRegistry.getBestForTask('reasoning', { maxLatency: 5000 })

// Auto-update from benchmark results
ModelRegistry.syncBenchmarkStats(modelName, results)
```

---

### Track 2: Enhanced Benchmark API with Filtering 🔍

**Goal:** Support category and tag-based filtering in dashboard API.

**New/Updated Endpoints:**

```javascript
// Enhanced dashboard endpoint
GET /api/benchmark/dashboard?sort=composite&modelCategory=coding&promptCategory=factual
// Returns: Leaderboard filtered to coding models on factual tasks

// New: Category-specific leaderboard
GET /api/benchmark/leaderboard/category/:category
// Returns: Leaderboard for specific category only

// New: Model capabilities endpoint
GET /api/benchmark/models/capabilities
// Returns: ModelRegistry data for all active models

// Enhanced: Quality breakdown with filters
GET /api/benchmark/quality-breakdown?model=qwen&promptCategory=reasoning
// Returns: Breakdown filtered by prompt category
```

**Implementation:**
```javascript
// In routes/benchmark.js
router.get('/dashboard', async (req, res) => {
  const { sort, modelCategory, promptCategory } = req.query;

  // Filter models by category
  let modelFilter = {};
  if (modelCategory) {
    const modelsInCategory = await ModelRegistry.find({
      categories: modelCategory,
      isActive: true
    }).distinct('modelName');

    modelFilter.model = { $in: modelsInCategory };
  }

  // Filter prompts by category
  let promptFilter = {};
  if (promptCategory) {
    promptFilter.prompt_category = promptCategory;
  }

  const results = await BenchmarkResult.aggregate([
    { $match: { success: true, ...modelFilter, ...promptFilter } },
    // ... rest of aggregation
  ]);

  res.json({ status: 'success', data: results });
});
```

---

### Track 3: Task-Segmented Leaderboards UI 🏆

**Goal:** Multiple specialized leaderboards instead of one universal ranking.

**UI Design:**

```html
<!-- In public/benchmark.html -->
<div class="leaderboard-tabs">
  <button class="tab-btn active" data-view="universal">Universal</button>
  <button class="tab-btn" data-view="ops">Ops/Glue</button>
  <button class="tab-btn" data-view="coding">Coding</button>
  <button class="tab-btn" data-view="reasoning">Reasoning</button>
  <button class="tab-btn" data-view="specialist">Specialists</button>
</div>

<div class="filter-controls">
  <div class="filter-group">
    <label>Model Category:</label>
    <select id="modelCategoryFilter">
      <option value="">All Models</option>
      <option value="ops">Ops/Glue</option>
      <option value="coding">Coding</option>
      <option value="reasoning">Deep Reasoning</option>
      <option value="specialist">Specialists</option>
      <option value="generalist">Generalists</option>
    </select>
  </div>

  <div class="filter-group">
    <label>Task Category:</label>
    <select id="promptCategoryFilter">
      <option value="">All Tasks</option>
      <option value="coding">Coding Tasks</option>
      <option value="reasoning">Reasoning Tasks</option>
      <option value="factual">Factual Recall</option>
      <option value="math">Math Problems</option>
      <option value="creative">Creative Writing</option>
    </select>
  </div>

  <div class="filter-group">
    <label>Tag Filter:</label>
    <select id="tagFilter">
      <option value="">All Tags</option>
      <!-- Populated dynamically from /api/benchmark/stats-by-tag -->
    </select>
  </div>
</div>

<!-- Leaderboard views (switch based on tab selection) -->
<div id="leaderboard-universal" class="leaderboard-view active">
  <!-- Universal leaderboard (current implementation) -->
</div>

<div id="leaderboard-coding" class="leaderboard-view" style="display: none;">
  <!-- Coding-specific leaderboard -->
  <div class="category-header">
    <h3>Coding Specialist Leaderboard</h3>
    <p>Models optimized for code generation, refactoring, and debugging</p>
  </div>
  <table class="leaderboard-table">
    <!-- Filtered to models with 'coding' category -->
    <!-- Weighted toward 'coding' prompt category results -->
  </table>
</div>

<!-- Repeat for other categories -->
```

**JavaScript:**
```javascript
// public/js/benchmark-analytics.js

async function loadCategoryLeaderboard(category) {
  const response = await fetch(`/api/benchmark/leaderboard/category/${category}`);
  const data = await response.json();

  renderLeaderboard(data.leaderboard, category);
}

function renderLeaderboard(models, category) {
  // Render with category-specific insights
  // e.g., for 'coding': show avg quality on coding tasks
  // for 'reasoning': show p95 latency and quality on reasoning tasks
}

// Fix the broken tag filter
function filterByTag(tag) {
  // Remove TODO stub
  const currentFilters = getActiveFilters();
  currentFilters.tag = tag;

  loadDashboard(currentFilters);  // Actually reload with tag filter
}

// New: Combined filter handler
async function loadDashboard(filters = {}) {
  const params = new URLSearchParams();
  if (filters.modelCategory) params.append('modelCategory', filters.modelCategory);
  if (filters.promptCategory) params.append('promptCategory', filters.promptCategory);
  if (filters.tag) params.append('tag', filters.tag);
  if (filters.sort) params.append('sort', filters.sort);

  const response = await fetch(`/api/benchmark/dashboard?${params}`);
  const data = await response.json();

  renderDashboard(data);
}
```

---

### Track 4: Composite Score Refinement 📊

**Goal:** Weight composite scores based on task complexity and model category alignment.

**Problem:** Current formula treats all tasks equally.

**Solution: Context-Aware Weighting**

```javascript
// In benchmarkService.js
function calculateCompositeScore(result, modelRegistry) {
  const baseWeights = { quality: 0.4, speed: 0.4, reliability: 0.2 };

  // Adjust weights based on task category
  let weights = { ...baseWeights };

  if (result.prompt_category === 'reasoning') {
    weights = { quality: 0.7, speed: 0.2, reliability: 0.1 };  // Quality matters most
  } else if (result.prompt_category === 'ops') {
    weights = { quality: 0.2, speed: 0.6, reliability: 0.2 };  // Speed matters most
  }

  // Check model category alignment
  const model = modelRegistry.find(m => m.modelName === result.model);
  const isAligned = model.categories.includes(categoryMapping[result.prompt_category]);

  // Penalty for misaligned usage (e.g., using reasoning model for trivial ops)
  const alignmentBonus = isAligned ? 1.0 : 0.85;

  const composite = (
    (result.normalized_scores.quality * weights.quality) +
    (result.normalized_scores.speed * weights.speed) +
    (result.normalized_scores.reliability * weights.reliability)
  ) * alignmentBonus;

  return Math.round(composite * 100) / 100;
}
```

---

### Track 5: Benchmark Prompt Complexity Tiers 📈

**Goal:** Differentiate trivial vs. complex tasks to prevent small models from gaming scores.

**Enhancement to BenchmarkPrompt:**
```javascript
// Add to existing schema
complexity: {
  type: String,
  enum: ['trivial', 'moderate', 'expert', 'reasoning'],
  required: true,
  index: true
},

minRecommendedContext: Number,  // e.g., 2048, 8192, 32768

expectedLatencyMs: {
  fast: Number,    // < 1s
  medium: Number,  // 1-5s
  slow: Number     // > 5s
}
```

**Filtering Logic:**
```javascript
// Exclude tiny models from expert-tier benchmarks
if (prompt.complexity === 'expert' && model.capabilities.maxContext < 8192) {
  logger.warn(`Skipping ${model.modelName} for expert prompt - insufficient context`);
  continue;
}

// Flag warnings for mismatched complexity
if (prompt.complexity === 'trivial' && model.categories.includes('reasoning')) {
  logger.warn(`Reasoning model on trivial task - results may be misleading`);
}
```

---

## Implementation Plan

### Phase 1: Foundation (Week 1)

**Day 1-2: Model Registry**
- [x] Create `models/ModelRegistry.js`
- [ ] Seed initial data from existing models
- [ ] Create API endpoints: `/api/models/registry`
- [ ] Add sync method to update from benchmark results

**Day 3-4: API Enhancement**
- [ ] Add category parameters to dashboard endpoint
- [ ] Create category-specific leaderboard endpoint
- [ ] Implement tag filtering (fix TODO stub)
- [ ] Add model capability queries

**Day 5: Testing**
- [ ] Integration tests for filtering
- [ ] Verify category aggregations
- [ ] Load test filtered queries

### Phase 2: UI Integration (Week 2)

**Day 1-2: Filter Controls**
- [ ] Build category filter dropdowns
- [ ] Implement filter state management
- [ ] Connect filters to API calls

**Day 3-4: Tabbed Leaderboards**
- [ ] Create tab navigation UI
- [ ] Build category-specific leaderboard views
- [ ] Add category descriptions and guidance

**Day 5: Polish**
- [ ] Add tooltips explaining categories
- [ ] Category-specific insights (e.g., "Best for code")
- [ ] Responsive design testing

### Phase 3: Intelligence (Week 3)

**Day 1-2: Composite Score Refinement**
- [ ] Implement context-aware weighting
- [ ] Add alignment bonus/penalty
- [ ] Recalculate historical scores

**Day 3-4: Complexity Tiers**
- [ ] Add complexity field to prompts
- [ ] Classify existing prompts
- [ ] Implement filtering logic

**Day 5: Validation**
- [ ] Compare old vs. new leaderboards
- [ ] Verify smollm2 no longer ranks artificially high
- [ ] Validate deepseek-r1 ranks higher on reasoning tasks

---

## Success Metrics

### Functional Metrics
- ✅ Category filter reduces leaderboard to relevant models
- ✅ Tag filter works (not just a toast message)
- ✅ Quality breakdown endpoint called and data displayed
- ✅ Tabbed leaderboards show different rankings per category

### Quality Metrics
- ✅ Reasoning models rank higher on reasoning tasks
- ✅ Fast models rank higher on ops/glue tasks
- ✅ Embedding models excluded from generative leaderboards
- ✅ Composite scores reflect task-model alignment

### UX Metrics
- ✅ User can find "best coding model" in < 3 clicks
- ✅ User can compare specialists vs. generalists
- ✅ Tooltips explain what each category means
- ✅ Filter state persists across page refreshes

---

## Beyond: Future Enhancements

### 1. Automatic Model Discovery
- Scan Ollama hosts for available models
- Auto-register new models with basic metadata
- Suggest category tags based on model name patterns

### 2. Performance-Based Auto-Routing
- ModelRouter uses registry + benchmark stats
- Routes coding queries to top coding performers
- Avoids slow models for time-sensitive tasks

### 3. Benchmark Recommendations
- "Your model registry is missing reasoning specialists"
- "Consider benchmarking phi-3 for ops tasks"
- "qwen2.5-coder ranked low on math - re-tune?"

### 4. Cost-Quality Tradeoffs
- Add cost metrics to registry ($/1M tokens)
- Show cost-adjusted leaderboards
- "Best bang for buck" category

### 5. A/B Test Integration
- Automatically create A/B tests between top 2 in category
- Real-world validation of benchmark winners
- Feedback loop: user preference → re-weight composite formula

---

## Migration Plan

### Backward Compatibility
- Existing dashboard API works without filters (default behavior)
- New parameters are optional
- Old leaderboard view remains as "Universal" tab

### Data Migration
```bash
# 1. Create ModelRegistry from existing benchmark results
node scripts/migrate-model-registry.js

# 2. Classify existing prompts by complexity
node scripts/classify-prompt-complexity.js

# 3. Recalculate composite scores with new formula
node scripts/recalculate-composite-scores.js
```

### Rollout Strategy
1. Deploy backend changes (API parameters)
2. Test with curl/Postman
3. Deploy UI changes (filters, tabs)
4. Announce new features
5. Monitor usage and performance

---

## Decision Points

### Required Decisions

1. **Category Taxonomy:** Use proposed 7 categories or different set?
2. **Composite Score Formula:** Adopt context-aware weighting or keep current?
3. **Complexity Tiers:** 4 levels (trivial/moderate/expert/reasoning) or more granular?
4. **Model Registry Source:** Manual curation or auto-discovery?

### Recommended Answers
1. ✅ Use proposed 7 categories (ops, coding, reasoning, specialist, generalist, embedding, judge)
2. ✅ Adopt context-aware weighting (fixes smollm2 gaming issue)
3. ✅ Start with 4 tiers, expand later if needed
4. ✅ Hybrid: auto-discover, manual categorization

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Breaking existing benchmarks** | High | Maintain backward compatibility, add new fields |
| **Performance regression** | Medium | Index all filter fields, cache leaderboard queries |
| **User confusion** | Medium | Clear tooltips, category descriptions, gradual rollout |
| **Data migration failures** | Low | Dry-run scripts, validate before deploy |

---

## Conclusion

This plan transforms the benchmark system from a **single-dimensional leaderboard** into a **multi-dimensional capability matrix**. It addresses:

1. ✅ Missing frontend integration (category filters, tag filtering)
2. ✅ Strategic enhancement (model registry, capability tracking)
3. ✅ Original feedback (task-segmented leaderboards, composite score weighting)
4. ✅ Beyond (automatic routing, cost analysis, A/B test integration)

**Status:** Ready for approval and execution.

**Next Step:** Create ModelRegistry schema and seed initial data.
