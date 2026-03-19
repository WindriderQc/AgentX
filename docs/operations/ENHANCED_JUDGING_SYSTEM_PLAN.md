# Enhanced Judging & Model Categorization System
## Architect-Level Implementation Plan

---

## Executive Summary

**Problem:** Models with different real-world performance cluster around similar scores (e.g., qwen2.5:7b=74.0, gemma2:2b=73.8). Current system lacks granularity to differentiate models effectively.

**Solution:** Comprehensive enhancement across 3 phases:
1. **Phase 1 (Core):** Enhanced judging granularity + test diversity
2. **Phase 2 (Advanced):** Multi-judge ensemble scoring (optional/toggleable)
3. **Phase 3 (Critical):** Config/prompt variation testing + hardware comparison + powerful UI

**Key Decisions (from user feedback):**
- ✅ All of the above: More categories (6→12+), finer difficulty (5→10 levels), task-specific composite weights
- ✅ Conversation judging: Post-conversation manual trigger for model comparison & prompt validation
- ✅ Phase 3 prioritized: Config variation, prompt templates, host comparison (hardware analytics)
- ❌ Cost tracking: Documented but not prioritized (all local)
- 🔄 Multi-judge: Phase 2, must be activable/deactivable
- ✅ **Category weighting system:** For determining "Generalist ALL Category Champion"
- ✅ **Test level UX redesign:** Levels 5→10 requires complete UX overhaul (listings, selections, presets)
- ✅ **Composite metrics validation:** Ensure speed/latency don't include judge overhead
- ✅ **Judge capacity upgrade:** Review judge model recommendations and configurations
- ✅ **Two-tier prompt sets:** "Standard Benchmark" (120 prompts) vs. "Comprehensive Benchmark" (240+ prompts)
- ✅ **Multi-judge host strategy:** 2-host setup (5070ti + 3080ti) with small+medium model pairing to avoid catastrophic loading

---

## Current State: Score Clustering Problem

### Current Scoring Architecture

**Dimensions (Too Coarse - 3-5 per type):**
| Type | Dimensions | Weights | Problem |
|------|------------|---------|---------|
| code | correctness, clarity, efficiency | 0.5, 0.3, 0.2 | Missing: documentation, testability, maintainability, error handling |
| reasoning | accuracy, logic, clarity | 0.4, 0.4, 0.2 | Missing: depth, coherence, completeness, method quality |
| factual | accuracy, completeness, clarity | 0.7, 0.2, 0.1 | Missing: precision, source awareness, context appropriateness |
| math | answer, method, presentation | 0.6, 0.3, 0.1 | Missing: rigor, notation, edge case handling |
| creative | creativity, coherence, relevance | 0.4, 0.3, 0.3 | Missing: originality, emotional impact, style, audience fit |

**Test Coverage (Insufficient Diversity):**
- 6 categories only: coding, reasoning, factual, math, creative, general
- 5 difficulty levels (1-5): Too coarse, levels 2-3 don't differentiate
- 42 diagnostic prompts: Only 7 per category, all at levels 2-3
- 20 general prompts: Mix of levels, not systematic

**Result:** Models cluster at 72-76 composite score despite different real-world performance.

### Enhancement Strategy

**1. Expand Dimensions (3-5 → 10-12 per type)**
- More evaluation criteria = finer-grained differentiation
- Task-specific weights per category
- Scale remains 0-10 per dimension for consistency

**2. Expand Difficulty Levels (5 → 10)**
- Current: Level 1 (trivial) → Level 5 (expert)
- Enhanced: Level 1 (trivial) → Level 10 (extreme mastery)
- Distributes prompts across wider difficulty spectrum
- Separates "good" (level 6-7) from "great" (level 8-9) from "exceptional" (level 10)

**3. Expand Categories (6 → 12+)**
- Add: instruction-following, summarization, translation, multi-turn-reasoning, context-retention, edge-cases
- More specialized categories = better model differentiation
- ~200+ total prompts (15-20 per category across all 10 levels)

**4. Task-Specific Composite Profiles**
- Current: 3 generic profiles (interactive, reasoning, coding)
- Enhanced: Custom composite weights PER category
- Example: coding tasks weight correctness+efficiency higher; creative tasks weight originality+style higher

---

## Critical Design Refinements (User Feedback Round 2)

### 1. Category Weighting System for "Generalist Champion"

**Problem:** How do we determine which model is the best all-around generalist across ALL categories?

**Solution:** Weighted category scoring system that values breadth + depth.

**Design:**

```javascript
// Category weights for "Generalist Champion" scoring
const GENERALIST_CATEGORY_WEIGHTS = {
  // Core capabilities (60% total weight)
  coding: 0.15,                    // 15% - Essential for developers
  reasoning: 0.15,                 // 15% - Core cognitive ability
  factual: 0.10,                   // 10% - Knowledge accuracy
  creative: 0.10,                  // 10% - Content generation
  'instruction-following': 0.10,   // 10% - User intent adherence

  // Specialized capabilities (30% total weight)
  math: 0.08,                      // 8% - Quantitative reasoning
  summarization: 0.07,             // 7% - Information distillation
  'multi-turn-reasoning': 0.07,   // 7% - Context retention
  'context-retention': 0.05,       // 5% - Long-form understanding
  translation: 0.03,               // 3% - Multilingual (bonus)

  // Quality assurance (10% total weight)
  'edge-cases': 0.05,              // 5% - Robustness
  refactoring: 0.03,               // 3% - Code quality
  debugging: 0.02                  // 2% - Error diagnosis
};

// Generalist Score Calculation
function calculateGeneralistScore(modelResults) {
  let weightedSum = 0;
  let coveragePenalty = 0;
  let consistencyBonus = 0;

  for (const [category, weight] of Object.entries(GENERALIST_CATEGORY_WEIGHTS)) {
    const categoryScore = modelResults[category]?.avg_composite || 0;

    if (categoryScore === 0) {
      // Penalize missing categories heavily
      coveragePenalty += weight * 20; // -20 points per missing category
    } else {
      weightedSum += categoryScore * weight;
    }
  }

  // Consistency bonus: Models with low variance across categories
  const scores = Object.values(modelResults).map(r => r.avg_composite);
  const stdDev = calculateStdDev(scores);
  if (stdDev < 10) {
    consistencyBonus = 5; // +5 for consistent performance
  }

  return {
    generalist_score: Math.max(0, weightedSum - coveragePenalty + consistencyBonus),
    coverage: (Object.keys(modelResults).length / Object.keys(GENERALIST_CATEGORY_WEIGHTS).length) * 100,
    consistency_score: 100 - stdDev,
    breakdown: modelResults
  };
}
```

**Leaderboard Display:**

```
🏆 GENERALIST ALL-CATEGORY CHAMPION LEADERBOARD

┌─────────────────┬──────────┬──────────┬──────────┬──────────────┐
│ Model           │ Overall  │ Coverage │ Consistency│ Top Category│
├─────────────────┼──────────┼──────────┼──────────┼──────────────┤
│ llama3.3:70b    │ 85.2/100 │ 100%     │ 91% ⭐    │ reasoning    │
│ qwen2.5:7b      │ 82.1/100 │ 100%     │ 85%       │ factual      │
│ deepseek-r1:7b  │ 80.5/100 │ 92%      │ 78%       │ reasoning    │
│ qwen2.5-coder   │ 76.3/100 │ 83%      │ 72%       │ coding       │
│ gemma2:2b       │ 71.8/100 │ 100%     │ 88% ⭐    │ creative     │
└─────────────────┴──────────┴──────────┴──────────┴──────────────┘

Legend:
Overall = Weighted score across all categories
Coverage = % of categories tested
Consistency = Low variance bonus (⭐ = stdDev <10)
```

**UI Feature:**
- New page: `/public/generalist-leaderboard.html`
- Filter: Min coverage (e.g., "Only show models tested in 90%+ categories")
- Sort: By overall score, by consistency, by specific category
- Click model → Drill into per-category breakdown

---

### 2. Test Level UX Redesign (5→10 Levels)

**Problem:** Current UX designed for 5 levels. Expanding to 10 levels requires complete overhaul of:
- Test listings (too many rows)
- Level selection interface (cramped)
- Presets section (takes massive real estate on main benchmark page)

**Solution:** Progressive disclosure + grouped level selection + collapsible presets.

#### 2.1 Level Selection Interface (Redesigned)

**OLD (5 levels):**
```
Select Levels: [ ] 1  [ ] 2  [ ] 3  [ ] 4  [ ] 5
```

**NEW (10 levels with grouping):**
```
┌────────────────────────────────────────────────────────┐
│ Select Difficulty Levels (10-level scale)              │
├────────────────────────────────────────────────────────┤
│ Quick Presets:                                         │
│ • [All Levels] (1-10)                                  │
│ • [Basic Models] (1-4) - For small/fast models        │
│ • [Intermediate Models] (3-7) ⭐ RECOMMENDED           │
│ • [Advanced Models] (6-10) - For large/capable models │
│                                                        │
│ Custom Selection:                                      │
│ ┌──────────────────────────────────────────────────┐  │
│ │ Beginner (1-3):  [ ] 1  [ ] 2  [ ] 3             │  │
│ │ Intermediate (4-6): [ ] 4  [ ] 5  [ ] 6 ⭐        │  │
│ │ Advanced (7-9):  [ ] 7  [ ] 8  [ ] 9             │  │
│ │ Expert (10):     [ ] 10                          │  │
│ └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```
**Implemented as Depth Matrix (off/single/light/full per level).**

> The slider concept was superseded by the depth matrix table in the
> benchmark UI. Each level row has radio buttons for off, single, light, or full.
```

#### 2.2 Test Listings (Compact View)

**OLD (Table with all prompts visible):**
```
┌─────────────┬───────┬─────────────────────────────────┐
│ Level │ Cat │ Name                            │
├───────┼─────┼─────────────────────────────────┤
│ 1     │ cod │ Hello World                     │
│ 2     │ cod │ String Reversal                 │
│ 3     │ cod │ Palindrome Checker              │
... (62 rows) ...
```

**NEW (Grouped + Collapsible):**
```
┌──────────────────────────────────────────────────────┐
│ Prompt Selection (200 total)                         │
├──────────────────────────────────────────────────────┤
│ ▼ Coding (20 prompts)                                │
│   ├─ Levels 1-3 (6 prompts) ............. [Select 6]│
│   ├─ Levels 4-6 (8 prompts) ⭐ ........... [Select 8]│
│   ├─ Levels 7-9 (5 prompts) ............. [Select 5]│
│   └─ Level 10 (1 prompt) ................. [Select 1]│
│                                                       │
│ ▼ Reasoning (20 prompts)                             │
│   ├─ Levels 1-3 (6 prompts) ............. [Select 6]│
│   ├─ Levels 4-6 (8 prompts) ⭐ ........... [Select 8]│
│   ... (collapsed by default)                         │
│                                                       │
│ ▶ Factual (20 prompts) ........... [Expand to view] │
│ ▶ Math (20 prompts) .............. [Expand to view] │
│ ▶ Creative (20 prompts) .......... [Expand to view] │
│ ... (11 more categories)                             │
│                                                       │
│ Total Selected: 40 prompts                           │
│ Estimated Time: ~12 minutes                          │
└──────────────────────────────────────────────────────┘
```

**Category-Level Quick Actions:**
```
For each category:
[Select All] [Select Intermediate 4-6] [Deselect All] [Preview Prompts]
```

#### 2.3 Presets Section (Collapsible + Modal)

**Problem:** Current presets section takes 30-40% of main benchmark page vertical space.

**OLD (Always visible):**
```
┌────────────────────────────────────────────────────┐
│ Benchmark Presets                                  │
├────────────────────────────────────────────────────┤
│ [ ] Standard Coding Test (20 coding prompts)      │
│     Description: Tests basic to intermediate...    │
│     Levels: 1-5, Categories: coding               │
│                                                    │
│ [ ] Full Diagnostic (42 prompts)                  │
│     Description: Comprehensive category test...    │
│     ... (Takes huge space)                        │
└────────────────────────────────────────────────────┘
```

**NEW (Compact dropdown + modal):**
```
Benchmark Preset: [Custom ▼]
                  ├─ Custom (manual selection)
                  ├─ Quick Test (5 min, 20 prompts)
                  ├─ Standard Benchmark (15 min, 60 prompts) ⭐
                  ├─ Comprehensive Benchmark (45 min, 120 prompts)
                  ├─ Overkill Benchmark (2hr, 240 prompts)
                  └─ [Manage Presets...]

[When preset selected, show summary inline:]
📋 Standard Benchmark
• 60 prompts across 12 categories
• Levels 3-7 (intermediate focus)
• ~15 minutes estimated
[Customize...] [View Full Details]
```

**Modal for "Manage Presets":**
```
┌──────────────────────────────────────────────────────┐
│ Manage Benchmark Presets                    [Close ×]│
├──────────────────────────────────────────────────────┤
│                                                       │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Standard Benchmark ⭐                           │ │
│ │ • 60 prompts, levels 3-7                       │ │
│ │ • All 12 categories (5 prompts each)           │ │
│ │ • Recommended for most models                  │ │
│ │ [Edit] [Duplicate] [Delete]                    │ │
│ └─────────────────────────────────────────────────┘ │
│                                                       │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Comprehensive Benchmark                         │ │
│ │ • 120 prompts, levels 1-10                     │ │
│ │ • All 12 categories (10 prompts each)          │ │
│ │ • For detailed model profiling                 │ │
│ │ [Edit] [Duplicate] [Delete]                    │ │
│ └─────────────────────────────────────────────────┘ │
│                                                       │
│ [+ Create New Preset]                                │
└──────────────────────────────────────────────────────┘
```

---

### 3. Composite Metrics Validation (Quality, Latency, Speed)

**Problem:** Current composite score uses quality + latency + speed. Need to validate:
1. Are these the only metrics we need?
2. Does latency/speed accidentally include judge scoring overhead?
3. Are we measuring the right things?

**Analysis:**

#### 3.1 Current Composite Formula

```javascript
composite_score = (quality × W_q) + (latency × W_l) + (speed × W_s)

Where:
- quality: 0-100 (LLM-as-judge score)
- latency: 0-100 (normalized, lower is better)
- speed: 0-100 (tokens/sec, higher is better)
```

**Issue:** Latency includes TOTAL time from request → response, which may include:
- Network round-trip time
- Model inference time (what we care about)
- Judge scoring time (if inline) ← **CONTAMINATION**
- Response streaming overhead

#### 3.2 Enhanced Timing Breakdown

**NEW: Separate timing metrics**

```javascript
// BenchmarkResult.js - ENHANCED timing fields
timing_breakdown: {
  // Request phase
  request_start: Date,
  request_sent: Date,

  // Model inference (what we want to measure)
  inference_start: Date,
  inference_end: Date,
  inference_duration_ms: Number,  // PURE model inference time

  // Response phase
  first_token_received: Date,
  last_token_received: Date,
  response_complete: Date,

  // Judge phase (separate from model performance)
  judge_start: Date,
  judge_end: Date,
  judge_duration_ms: Number,  // Excluded from composite

  // Total
  total_duration_ms: Number  // For debugging
}
```

**Composite Score Update:**
```javascript
// OLD (contaminated)
const latency = result.latency;  // Includes judge time

// NEW (clean)
const latency = result.timing_breakdown.inference_duration_ms;  // Pure inference
const speed = result.tokens / (latency / 1000);  // Tokens per sec (inference only)
```

#### 3.3 Are Quality + Latency + Speed Sufficient?

**Additional Metrics to Consider:**

| Metric | Description | Why Add? | Implementation |
|--------|-------------|----------|----------------|
| **Reliability** | Success rate across prompts | Models that fail tests should be penalized | `(successful_tests / total_tests) × 100` |
| **Consistency** | Low variance across tests | Predictable performance valued | `100 - stdDev(quality_scores)` |
| **Context Efficiency** | Tokens generated vs. prompt length | Verbose models penalized | `tokens_generated / (prompt_tokens + response_tokens)` |
| **Memory Usage** | VRAM/RAM footprint | Resource-constrained environments | From Ollama `/api/ps` |
| **First Token Latency** | Time to first token | Streaming UX perceived speed | `first_token_time - request_time` |

**Recommended Enhanced Composite Formula:**

```javascript
const ENHANCED_COMPOSITE_PROFILES = {
  interactive: {
    weights: {
      quality: 0.35,           // -5% (was 40%)
      latency: 0.30,           // -10% (was 40%)
      speed: 0.15,             // -5% (was 20%)
      reliability: 0.10,       // +10% NEW
      first_token_latency: 0.10 // +10% NEW (streaming UX)
    },
    latencyCap: 30000,
    description: "Optimized for chat UX with reliability"
  },
  reasoning: {
    weights: {
      quality: 0.70,           // -10% (was 80%)
      latency: 0.05,           // -5% (was 10%)
      speed: 0.05,             // -5% (was 10%)
      reliability: 0.10,       // +10% NEW
      consistency: 0.10        // +10% NEW (predictable reasoning)
    },
    latencyCap: 120000,
    description: "Quality and consistency critical"
  },
  coding: {
    weights: {
      quality: 0.60,           // -10% (was 70%)
      latency: 0.15,           // -5% (was 20%)
      speed: 0.10,             // Same (was 10%)
      reliability: 0.10,       // +10% NEW (code must work)
      context_efficiency: 0.05 // +5% NEW (concise code valued)
    },
    latencyCap: 60000,
    description: "Correctness + efficiency"
  }
};
```

**Validation Strategy:**

1. **A/B Test:** Run benchmarks with OLD composite vs. NEW composite
2. **Compare rankings:** Do model ranks change significantly?
3. **User survey:** Which composite better matches perceived quality?
4. **Metric correlation:** Does reliability/consistency add differentiation?

---

### 4. Judge Capacity & Configuration Upgrade

**Problem:** Current judge setup uses single model (qwen2.5:7b). Need to:
1. Review judge model recommendations
2. Badge "recommended judge" models
3. Ensure judge capacity matches enhanced scoring dimensions

#### 4.1 Judge Model Requirements (10-12 Dimensions)

**Current Judge Prompt Length:**
- 5 dimensions × 50 tokens = ~250 tokens
- Response: ~150 tokens (JSON)
- **Total: ~400 tokens per evaluation**

**Enhanced Judge Prompt Length:**
- 10-12 dimensions × 50 tokens = ~500-600 tokens
- Response: ~200 tokens (JSON with 10-12 scores)
- **Total: ~700-800 tokens per evaluation**

**Judge Model Capacity Needed:**
- **Context window:** 8192+ tokens (for long responses being judged)
- **Speed:** <2s per evaluation (to avoid benchmark bottleneck)
- **Quality:** Consistent, unbiased scoring
- **Cost:** Efficient (local deployment)

#### 4.2 Recommended Judge Models (With Badges)

**Evaluation Criteria:**
1. Context window ≥8192
2. Average judge time <2s
3. JSON output reliability >95%
4. Scoring consistency (low variance on same input)
5. Size fits in 8-16GB VRAM

**Recommended Judge Models:**

```javascript
const JUDGE_MODEL_RECOMMENDATIONS = [
  {
    model: "llama3.1:8b",
    badge: "⭐ BALANCED",
    tier: "recommended",
    specs: {
      context: 8192,
      vram_mb: 8192,
      avg_judge_time_ms: 1800,
      json_reliability: 0.97,
      consistency_score: 0.89
    },
    best_for: ["general", "coding", "reasoning"],
    pros: ["Fast", "Reliable JSON", "Good balance"],
    cons: ["Moderate quality compared to 70B models"]
  },
  {
    model: "qwen2.5:7b",
    badge: "⚡ FAST",
    tier: "recommended",
    specs: {
      context: 32768,
      vram_mb: 7168,
      avg_judge_time_ms: 1200,
      json_reliability: 0.95,
      consistency_score: 0.85
    },
    best_for: ["quick benchmarks", "high throughput"],
    pros: ["Very fast", "Large context", "Low VRAM"],
    cons: ["Slightly less consistent than llama3.1:8b"]
  },
  {
    model: "deepseek-r1:7b",
    badge: "🎯 PRECISE",
    tier: "recommended",
    specs: {
      context: 8192,
      vram_mb: 7168,
      avg_judge_time_ms: 2400,
      json_reliability: 0.98,
      consistency_score: 0.92
    },
    best_for: ["reasoning", "complex evaluation"],
    pros: ["High consistency", "Excellent reasoning", "Fair scoring"],
    cons: ["Slower", "Thinking model overhead"]
  },
  {
    model: "llama3.3:70b",
    badge: "👑 PREMIUM",
    tier: "optional",
    specs: {
      context: 8192,
      vram_mb: 40960,
      avg_judge_time_ms: 4500,
      json_reliability: 0.99,
      consistency_score: 0.95
    },
    best_for: ["critical evaluations", "multi-judge consensus"],
    pros: ["Highest quality", "Most consistent", "Nuanced evaluation"],
    cons: ["Very slow", "Requires 40GB+ VRAM", "Not practical for large benchmarks"]
  },
  {
    model: "gemma2:2b",
    badge: "💨 ULTRA-FAST",
    tier: "fallback",
    specs: {
      context: 8192,
      vram_mb: 2048,
      avg_judge_time_ms: 600,
      json_reliability: 0.88,
      consistency_score: 0.75
    },
    best_for: ["quick screening", "low-VRAM hosts"],
    pros: ["Extremely fast", "Tiny VRAM footprint"],
    cons: ["Lower quality", "Less consistent", "Not recommended for production benchmarks"]
  }
];
```

**UI Display:**

```
┌────────────────────────────────────────────────────────┐
│ Select Judge Model                                     │
├────────────────────────────────────────────────────────┤
│ ⭐ llama3.1:8b (BALANCED) - Recommended                │
│    Context: 8K | VRAM: 8GB | Speed: 1.8s              │
│    Best for: General benchmarks                        │
│                                                        │
│ ⚡ qwen2.5:7b (FAST) - Recommended                     │
│    Context: 32K | VRAM: 7GB | Speed: 1.2s ← FASTEST   │
│    Best for: Quick benchmarks, high throughput         │
│                                                        │
│ 🎯 deepseek-r1:7b (PRECISE) - Recommended             │
│    Context: 8K | VRAM: 7GB | Speed: 2.4s              │
│    Best for: Reasoning, complex evaluation             │
│                                                        │
│ 👑 llama3.3:70b (PREMIUM) - Optional                  │
│    Context: 8K | VRAM: 40GB | Speed: 4.5s             │
│    ⚠️ Requires 40GB+ VRAM, use for critical evals only│
│                                                        │
│ 💨 gemma2:2b (ULTRA-FAST) - Fallback                  │
│    Context: 8K | VRAM: 2GB | Speed: 0.6s              │
│    ⚠️ Lower quality, only for quick screening         │
└────────────────────────────────────────────────────────┘
```

#### 4.3 Judge Configuration Profiles

**Predefined Judge Configs:**

```javascript
const JUDGE_PRESETS = {
  fast: {
    model: "qwen2.5:7b",
    temperature: 0.1,
    num_ctx: 8192,
    timeout: 15000,
    description: "Fast judge for quick benchmarks"
  },
  balanced: {
    model: "llama3.1:8b",
    temperature: 0.1,
    num_ctx: 8192,
    timeout: 20000,
    description: "Recommended for most benchmarks"
  },
  precise: {
    model: "deepseek-r1:7b",
    temperature: 0.0,
    num_ctx: 8192,
    timeout: 30000,
    description: "Highest consistency for critical evals"
  }
};
```

---

### 5. Two-Tier Prompt Sets

**Problem:** 200+ prompts may be overkill for routine testing. Need tiered approach.

**Solution:** Two benchmark tiers + custom builder.

#### 5.1 Standard Benchmark (120 prompts)

**Target:** Routine model evaluation, ~30-40 minutes

**Composition:**
- 12 categories × 10 prompts each
- Focus on levels 3-7 (intermediate differentiation zone)
- Distribution:
  - Levels 3-4: 30 prompts (25%)
  - Levels 5-6: 50 prompts (42%) ← KEY ZONE
  - Levels 7-8: 30 prompts (25%)
  - Levels 9-10: 10 prompts (8%) - Challenge prompts

**Use Cases:**
- Daily model testing
- CI/CD integration
- Model comparison (2-3 models)
- Config variant testing

#### 5.2 Comprehensive Benchmark (240+ prompts)

**Target:** Deep model profiling, ~1.5-2 hours

**Composition:**
- 12 categories × 20 prompts each
- Full difficulty spectrum (levels 1-10)
- Distribution:
  - Levels 1-3: 60 prompts (25%)
  - Levels 4-6: 100 prompts (42%) ← KEY ZONE
  - Levels 7-9: 60 prompts (25%)
  - Level 10: 20 prompts (8%)

**Use Cases:**
- New model release evaluation
- Production deployment decision
- Academic/research benchmarking
- Leaderboard ranking

#### 5.3 Preset Comparison

```
┌──────────────────────┬─────────────┬─────────────────┬──────────┐
│ Benchmark Tier       │ Prompts     │ Estimated Time  │ Use Case │
├──────────────────────┼─────────────┼─────────────────┼──────────┤
│ Quick Test           │ 20          │ 5 minutes       │ Smoke test
│ Standard ⭐          │ 120         │ 30-40 minutes   │ Routine eval
│ Comprehensive        │ 240         │ 1.5-2 hours     │ Deep profiling
│ Overkill (Optional)  │ 400+        │ 3-4 hours       │ Research
└──────────────────────┴─────────────┴─────────────────┴──────────┘
```

#### 5.4 Custom Benchmark Builder

**UI Workflow:**

```
┌────────────────────────────────────────────────────────┐
│ Custom Benchmark Builder                               │
├────────────────────────────────────────────────────────┤
│ Start with preset: [Standard Benchmark ▼]             │
│                    └─ Quick, Standard, Comprehensive   │
│                                                        │
│ Adjust Categories:                                     │
│ ┌────────────────────────────────────────────────────┐│
│ │ [x] Coding        (10 prompts) [+] [-] [Settings] ││
│ │ [x] Reasoning     (10 prompts) [+] [-] [Settings] ││
│ │ [x] Factual       (10 prompts) [+] [-] [Settings] ││
│ │ [ ] Translation   (0 prompts)  [+] [-] [Settings] ││
│ │     └─ Not needed for this benchmark               ││
│ └────────────────────────────────────────────────────┘│
│                                                        │
│ Difficulty Focus:                                      │
│ [ Depth matrix: off/single/light/full per level ]  │
│ "Focus on intermediate models (levels 3-7)"           │
│                                                        │
│ Total: 90 prompts (~25 minutes)                       │
│ [Save as Preset] [Run Benchmark]                      │
└────────────────────────────────────────────────────────┘
```

---

### 6. Multi-Judge Host Strategy (2-Host Setup)

**Problem:** Multi-judge causes catastrophic model loading on single host. Need efficient 2-host strategy.

**Hardware Context:**
- Host 1: RTX 5070 Ti (16GB VRAM)
- Host 2: RTX 3080 Ti (12GB VRAM)

#### 6.1 Optimal Multi-Judge Pairing Strategies

**Strategy 1: Small + Medium (Recommended)**

```
Host 1 (5070 Ti, 16GB):
├─ Model Under Test: qwen2.5:7b (7GB)
└─ Judge 1: qwen2.5:7b (7GB) ← Fast judge
   Total: 14GB (fits comfortably)

Host 2 (3080 Ti, 12GB):
├─ Judge 2: gemma2:2b (2GB) ← Ultra-fast judge
└─ Judge 3: llama3.1:8b (8GB) ← Balanced judge
   Total: 10GB (fits with headroom)
```

**Benefits:**
- No model swapping (all models stay loaded)
- Parallel judge execution (<3s total)
- Test host unaffected by judges
- Graceful degradation (can run with 1 host if needed)

**Strategy 2: Local + Remote Judge**

```
Host 1 (5070 Ti, 16GB):
├─ Model Under Test: llama3.3:70b (40GB) ← TOO BIG
└─ Judge 1: qwen2.5:7b (7GB)
   ⚠️ PROBLEM: 70B model doesn't fit

Alternative: External Judge Host
Host 1 (5070 Ti): Model Under Test only
Host 2 (3080 Ti): Judges only
```

**Benefits:**
- Test host performance uncontaminated
- Can test large models (70B)
- Judge host can be shared across multiple test hosts

**Drawbacks:**
- Network latency between hosts
- More complex setup

#### 6.2 Multi-Judge Configuration Profiles

**Predefined Multi-Judge Setups:**

```javascript
const MULTI_JUDGE_PROFILES = {
  "fast-consensus": {
    judges: [
      { model: "qwen2.5:7b", host: "http://host1:11434", weight: 0.5 },
      { model: "gemma2:2b", host: "http://host2:11434", weight: 0.5 }
    ],
    aggregation: "median",
    description: "Fast 2-judge consensus",
    estimated_overhead: "1.5s per test",
    vram_required: { host1: 7168, host2: 2048 }
  },

  "balanced-consensus": {
    judges: [
      { model: "qwen2.5:7b", host: "http://host1:11434", weight: 0.33 },
      { model: "gemma2:2b", host: "http://host2:11434", weight: 0.33 },
      { model: "llama3.1:8b", host: "http://host2:11434", weight: 0.34 }
    ],
    aggregation: "median",
    description: "3-judge consensus (recommended)",
    estimated_overhead: "2.5s per test",
    vram_required: { host1: 7168, host2: 10240 }
  },

  "precision-consensus": {
    judges: [
      { model: "deepseek-r1:7b", host: "http://host1:11434", weight: 0.5 },
      { model: "llama3.1:8b", host: "http://host2:11434", weight: 0.5 }
    ],
    aggregation: "weighted",
    description: "High-precision 2-judge (slower)",
    estimated_overhead: "3.5s per test",
    vram_required: { host1: 7168, host2: 8192 }
  }
};
```

#### 6.3 Graceful Degradation Strategy

**Fallback Chain:**

```
1. Try multi-judge (3 models across 2 hosts)
   ├─ All 3 judges respond → Use median aggregation
   └─ Any judge fails/timeout → Fall back to step 2

2. Try 2-judge subset
   ├─ 2 judges respond → Use average aggregation
   └─ <2 judges → Fall back to step 3

3. Single judge (primary judge only)
   ├─ Primary judge responds → Use single score
   └─ Primary fails → Fall back to step 4

4. Quick scoring (pattern matching)
   └─ No LLM judge, use expected_answer matching
```

**UI Indicator:**

```
Quality Score: 8.2 / 10
Judge Method: Multi-Judge (3/3) ✓ Full consensus
              └─ qwen2.5:7b: 8.3
              └─ gemma2:2b: 8.0
              └─ llama3.1:8b: 8.4
Agreement: 95% (high confidence)
```

```
Quality Score: 7.9 / 10
Judge Method: Multi-Judge (2/3) ⚠️ Partial consensus
              └─ qwen2.5:7b: 7.9
              └─ llama3.1:8b: 7.9
              └─ gemma2:2b: TIMEOUT ❌
Agreement: N/A (insufficient judges)
```

---

## Phase 1: Enhanced Judging Granularity + Test Diversity

**Priority:** CORE FOUNDATION - Must complete before Phase 3

### 1.1 Enhanced Scoring Dimensions

**Schema Changes:**
```javascript
// BenchmarkPrompt.js - NEW field
scoring_dimensions: [{
  name: String,           // "accuracy", "correctness", "clarity", etc.
  weight: Number,         // 0.0-1.0 (must sum to 1.0)
  description: String,    // What this dimension measures
  scale: Number,          // 10 (0-10 scale)
  rubric: {
    poor: String,         // "0-3: ..."
    fair: String,         // "4-6: ..."
    good: String,         // "7-8: ..."
    excellent: String     // "9-10: ..."
  }
}]

// BenchmarkResult.js - ENHANCED field
quality_breakdown: {
  // OLD: { correctness: 8, clarity: 7, efficiency: 9 }
  // NEW: { accuracy: 8.5, correctness: 9.0, clarity: 7.5, efficiency: 8.0, ... }
  [dimension_name]: Number  // 10-12 dimensions instead of 3-5
}
```

**New Scoring Configurations (qualityScorer.js):**
```javascript
ENHANCED_SCORING_CONFIGS = {
  code: {
    dimensions: [
      { name: 'correctness', weight: 0.25, desc: 'Does code work & produce correct output?' },
      { name: 'clarity', weight: 0.15, desc: 'Is code readable & well-structured?' },
      { name: 'efficiency', weight: 0.15, desc: 'Reasonable performance for task?' },
      { name: 'maintainability', weight: 0.10, desc: 'Easy to modify & extend?' },
      { name: 'error_handling', weight: 0.10, desc: 'Robust error handling?' },
      { name: 'documentation', weight: 0.10, desc: 'Comments & explanations?' },
      { name: 'best_practices', weight: 0.08, desc: 'Follows language idioms?' },
      { name: 'testability', weight: 0.07, desc: 'Easy to test?' }
    ]
  },
  reasoning: {
    dimensions: [
      { name: 'accuracy', weight: 0.25, desc: 'Is conclusion correct?' },
      { name: 'logic_soundness', weight: 0.20, desc: 'Is reasoning valid?' },
      { name: 'depth', weight: 0.15, desc: 'Sufficient analysis depth?' },
      { name: 'clarity', weight: 0.12, desc: 'Clear explanation?' },
      { name: 'completeness', weight: 0.10, desc: 'Addresses all aspects?' },
      { name: 'coherence', weight: 0.08, desc: 'Internally consistent?' },
      { name: 'method_quality', weight: 0.10, desc: 'Appropriate approach?' }
    ]
  },
  factual: {
    dimensions: [
      { name: 'accuracy', weight: 0.35, desc: 'Factually correct?' },
      { name: 'completeness', weight: 0.20, desc: 'Answers question fully?' },
      { name: 'precision', weight: 0.15, desc: 'Specific & detailed?' },
      { name: 'clarity', weight: 0.10, desc: 'Clearly presented?' },
      { name: 'source_awareness', weight: 0.10, desc: 'Acknowledges sources?' },
      { name: 'context_appropriateness', weight: 0.10, desc: 'Right level of detail?' }
    ]
  },
  math: {
    dimensions: [
      { name: 'answer_correctness', weight: 0.35, desc: 'Final answer correct?' },
      { name: 'method', weight: 0.25, desc: 'Solution approach valid?' },
      { name: 'rigor', weight: 0.15, desc: 'Mathematically rigorous?' },
      { name: 'presentation', weight: 0.10, desc: 'Clearly shown?' },
      { name: 'notation', weight: 0.08, desc: 'Proper notation used?' },
      { name: 'edge_cases', weight: 0.07, desc: 'Handles special cases?' }
    ]
  },
  creative: {
    dimensions: [
      { name: 'creativity', weight: 0.25, desc: 'Original & imaginative?' },
      { name: 'coherence', weight: 0.20, desc: 'Well-structured & logical?' },
      { name: 'relevance', weight: 0.15, desc: 'Addresses task?' },
      { name: 'originality', weight: 0.15, desc: 'Unique approach?' },
      { name: 'emotional_impact', weight: 0.10, desc: 'Engaging?' },
      { name: 'style', weight: 0.08, desc: 'Appropriate voice?' },
      { name: 'audience_fit', weight: 0.07, desc: 'Right for audience?' }
    ]
  }
}
```

**Implementation Approach:**
- **Backward compatible:** If `scoring_dimensions` not defined in prompt, use legacy SCORING_CONFIGS
- **Dynamic judge prompt generation:** Build judge prompt from dimensions array + rubrics
- **Flexible weighting:** Allow per-prompt dimension override

### 1.2 Expanded Difficulty Levels (5 → 10)

**Current Scale (Insufficient):**
```
Level 1: Trivial (Hello World)
Level 2: Easy (String reversal)
Level 3: Moderate (Palindrome checker)
Level 4: Hard (Binary search, system design intro)
Level 5: Expert (Distributed systems, complex algorithms)
```

**Enhanced Scale (10 Levels):**
```
Level 1:  Trivial - Basic syntax, single operations
Level 2:  Simple - Basic logic, simple functions
Level 3:  Easy - Multiple steps, basic algorithms
Level 4:  Moderate-Easy - Intermediate algorithms, error handling
Level 5:  Moderate - Complex logic, data structures
Level 6:  Moderate-Hard - Advanced algorithms, edge cases
Level 7:  Hard - System design basics, optimization
Level 8:  Very Hard - Complex system design, multiple constraints
Level 9:  Expert - Distributed systems, advanced concurrency
Level 10: Extreme - Research-level, novel problem solving
```

**Differentiation Strategy:**
- Levels 1-3: Basic models (smollm2, gemma2:2b)
- Levels 4-6: Intermediate models (qwen2.5:7b, llama3.1:8b) ← **KEY DIFFERENTIATION ZONE**
- Levels 7-9: Advanced models (qwen2.5-coder:14b, llama3.3:70b)
- Level 10: State-of-the-art models (deepseek-r1, frontier models)

**Schema Change:**
```javascript
// BenchmarkPrompt.js
prompt_level: {
  type: Number,
  min: 1,
  max: 10,  // CHANGED from 5
  index: true
}
```

### 1.3 Expanded Test Categories (6 → 12+)

**New Categories to Add:**

| New Category | Purpose | Differentiation Goal | Example Prompts |
|--------------|---------|---------------------|-----------------|
| **instruction-following** | Precise adherence to constraints | Models that follow complex instructions vs. those that ignore constraints | "Write function that ONLY uses recursion, NO loops", "Respond in exactly 3 sentences" |
| **summarization** | Information distillation | Models that extract key points vs. those that ramble | "Summarize this 500-word article in 50 words", "Extract 3 main points from text" |
| **translation** | Language understanding | Models with multilingual capability vs. English-only | "Translate to French", "Explain idiom translation challenges" |
| **multi-turn-reasoning** | Context retention across steps | Models that maintain context vs. those that forget | "Step 1: X. Step 2 (using result from 1): Y. Step 3 (combining 1&2): Z" |
| **context-retention** | Long-context memory | Models that handle long inputs vs. those that lose context | "Given this 2000-word document, answer question about paragraph 1 vs paragraph 15" |
| **edge-cases** | Robustness | Models that handle unusual inputs vs. those that break | "What if input is empty? Null? Negative? Zero?" |
| **refactoring** | Code improvement | Models that improve existing code vs. those that rewrite poorly | "Refactor this code for readability", "Optimize this function" |
| **debugging** | Error diagnosis | Models that identify bugs vs. those that miss issues | "Find 3 bugs in this code", "Why does this crash?" |
| **explanation** | Teaching ability | Models that explain clearly vs. those that assume knowledge | "Explain recursion to a beginner", "Why does this algorithm work?" |
| **dialogue** | Conversational flow | Models that maintain conversation vs. those that monologue | Multi-turn prompts requiring context from previous exchanges |

**Total Test Coverage (Enhanced):**
- **12 categories** (6 original + 6 new)
- **10 difficulty levels** per category
- **~15-20 prompts per category** distributed across levels
- **Target: 200-240 prompts** (vs. current 62)

**Prompt Distribution Strategy:**
```
Levels 1-3:  30% of prompts (basic, all models should pass)
Levels 4-6:  40% of prompts (intermediate, key differentiation zone)
Levels 7-9:  25% of prompts (advanced, only top models excel)
Level 10:    5% of prompts (extreme, research-level)
```

### 1.4 Task-Specific Composite Scoring

**Problem:** Current composite formula uses generic weights for all categories.

**Solution:** Category-specific composite profiles.

**Enhanced Composite Profiles:**
```javascript
CATEGORY_COMPOSITE_PROFILES = {
  coding: {
    weights: { quality: 0.60, latency: 0.25, speed: 0.15 },
    latencyCap: 45000,  // 45s (users tolerate slower for correct code)
    description: "Code quality > speed"
  },
  reasoning: {
    weights: { quality: 0.80, latency: 0.10, speed: 0.10 },
    latencyCap: 120000,  // 120s (deep thinking takes time)
    description: "Reasoning depth matters most"
  },
  factual: {
    weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
    latencyCap: 20000,  // 20s (facts should be quick)
    description: "Accuracy + responsiveness"
  },
  math: {
    weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
    latencyCap: 30000,  // 30s
    description: "Correctness critical"
  },
  creative: {
    weights: { quality: 0.50, latency: 0.30, speed: 0.20 },
    latencyCap: 60000,  // 60s (creative writing can be slower)
    description: "Balance quality and flow"
  },
  'instruction-following': {
    weights: { quality: 0.85, latency: 0.10, speed: 0.05 },
    latencyCap: 30000,
    description: "Precision matters most"
  },
  summarization: {
    weights: { quality: 0.60, latency: 0.25, speed: 0.15 },
    latencyCap: 25000,
    description: "Concise and fast"
  },
  'multi-turn-reasoning': {
    weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
    latencyCap: 90000,
    description: "Context retention critical"
  },
  'edge-cases': {
    weights: { quality: 0.80, latency: 0.12, speed: 0.08 },
    latencyCap: 35000,
    description: "Robustness over speed"
  },
  refactoring: {
    weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
    latencyCap: 50000,
    description: "Code improvement quality"
  }
}
```

**Implementation:**
- `calculateCompositeScore()` takes `category` parameter
- Looks up category-specific profile
- Falls back to generic 'interactive' if category unknown
- Each benchmark result stores which profile was used

---

## Phase 2: Multi-Judge Ensemble Scoring (Optional/Toggleable)

**Priority:** ADVANCED FEATURE - After Phase 1 complete

**Requirement:** Must be activable/deactivable via UI toggle and API parameter.

### 2.1 Multi-Judge Architecture

**Schema Changes:**
```javascript
// BenchmarkBatch.js - NEW field
judge_config: {
  enabled: Boolean,        // Enable multi-judge?
  judge_models: [String],  // ["llama3.1:8b", "qwen2.5:7b", "deepseek-r1:7b"]
  aggregation_strategy: String,  // "average" | "median" | "weighted"
  weights: [Number]        // [0.4, 0.3, 0.3] (if weighted)
}

// BenchmarkResult.js - ENHANCED field
quality_breakdown: {
  // Single-judge (existing):
  { accuracy: 8, clarity: 7, efficiency: 9 }

  // Multi-judge (new):
  judges: [{
    model: "llama3.1:8b",
    scores: { accuracy: 8, clarity: 7, efficiency: 9 },
    overall: 8.0,
    scoring_time_ms: 1200
  }, {
    model: "qwen2.5:7b",
    scores: { accuracy: 9, clarity: 6, efficiency: 8 },
    overall: 8.1,
    scoring_time_ms: 980
  }, {
    model: "deepseek-r1:7b",
    scores: { accuracy: 7, clarity: 8, efficiency: 9 },
    overall: 7.9,
    scoring_time_ms: 1450
  }],

  // Aggregated scores:
  aggregated_scores: { accuracy: 8.0, clarity: 7.0, efficiency: 8.7 },
  aggregated_overall: 8.0,
  aggregation_strategy: "median",
  judge_agreement: 0.85  // Inter-judge correlation
}
```

**Aggregation Strategies:**

1. **Average:** Simple mean of all judge scores
   ```javascript
   aggregated = (judge1 + judge2 + judge3) / 3
   ```

2. **Median:** Robust to outliers
   ```javascript
   aggregated = median([judge1, judge2, judge3])
   ```

3. **Weighted:** Expert judges get higher weight
   ```javascript
   aggregated = (judge1 × 0.4) + (judge2 × 0.3) + (judge3 × 0.3)
   ```

**Judge Agreement Metric:**
- Calculate pairwise correlation between judge scores
- Agreement = average correlation
- High agreement (>0.8): Judges consensus
- Low agreement (<0.6): Response quality ambiguous

### 2.2 UI Controls (Toggleable)

**Benchmark Creation Form:**
```html
<label>
  <input type="checkbox" id="enable-multi-judge"> Enable Multi-Judge Scoring
</label>

<div id="multi-judge-config" style="display: none;">
  <label>Judge Models (select 2-5):</label>
  <select multiple id="judge-models">
    <option value="llama3.1:8b">llama3.1:8b (balanced)</option>
    <option value="qwen2.5:7b">qwen2.5:7b (fast)</option>
    <option value="deepseek-r1:7b">deepseek-r1:7b (reasoning)</option>
    <option value="llama3.3:70b">llama3.3:70b (high quality)</option>
  </select>

  <label>Aggregation Strategy:</label>
  <select id="aggregation-strategy">
    <option value="median">Median (Recommended - robust to outliers)</option>
    <option value="average">Average (simple mean)</option>
    <option value="weighted">Weighted (custom weights)</option>
  </select>

  <div id="weighted-config" style="display: none;">
    <!-- Weight inputs appear if weighted selected -->
  </div>
</div>
```

**Results Display:**
```
Quality Score: 8.0 (multi-judge median)
  ├─ llama3.1:8b: 8.0
  ├─ qwen2.5:7b: 8.1
  └─ deepseek-r1:7b: 7.9
Judge Agreement: 85% (high consensus)
```

### 2.3 Performance Considerations

**Challenge:** Multi-judge increases scoring time by N×.

**Mitigation:**
- **Parallel execution:** Score with all judges concurrently
- **Timeout per judge:** 30s timeout, graceful degradation
- **Fallback:** If <2 judges succeed, fall back to single-judge
- **Optional feature:** Only enable for critical benchmarks

**Cost Trade-off:**
- Single-judge: ~1-2s per test
- Multi-judge (3 models): ~2-4s per test (parallel)
- Benefit: Higher confidence in scores, outlier detection

---

## Phase 3: Config Variation + Hardware Comparison + UI (CRITICAL PRIORITY)

**Priority:** HIGHEST - User prioritized this phase

### 3.1 Config Variation Testing

**Goal:** Test same model with different Ollama parameters to find optimal configs.

**Schema Changes:**
```javascript
// NEW Collection: ConfigVariant
const ConfigVariantSchema = new mongoose.Schema({
  name: String,  // "conservative", "creative", "balanced"
  description: String,
  parameters: {
    temperature: Number,      // 0.0-2.0
    top_p: Number,           // 0.0-1.0
    top_k: Number,           // Integer
    repeat_penalty: Number,  // 0.0-2.0
    num_ctx: Number,         // Context length
    num_predict: Number      // Max tokens
  },
  tags: [String]  // ["production", "experimental"]
});

// BenchmarkBatch.js - NEW field
config_variants: [{
  variant_id: ObjectId,  // Reference to ConfigVariant
  name: String,          // Denormalized for display
  parameters: Object     // Snapshot
}]

// BenchmarkResult.js - NEW fields
config_variant_id: ObjectId,
config_variant_name: String,
config_parameters: Object  // Snapshot
```

**Predefined Config Variants:**
```javascript
const DEFAULT_VARIANTS = [
  {
    name: "Deterministic",
    desc: "For factual/code tasks requiring consistency",
    params: { temperature: 0.0, top_p: 0.9, repeat_penalty: 1.1, num_ctx: 8192 }
  },
  {
    name: "Balanced",
    desc: "Default balanced settings",
    params: { temperature: 0.7, top_p: 0.95, repeat_penalty: 1.0, num_ctx: 8192 }
  },
  {
    name: "Creative",
    desc: "For creative writing and brainstorming",
    params: { temperature: 1.2, top_p: 0.98, repeat_penalty: 0.9, num_ctx: 8192 }
  },
  {
    name: "Extended Context",
    desc: "Long context tasks",
    params: { temperature: 0.7, top_p: 0.95, repeat_penalty: 1.0, num_ctx: 16384 }
  }
];
```

**Benchmark Workflow:**
```
User creates batch:
  ├─ Select model: "qwen2.5:7b"
  ├─ Select prompts: [coding, reasoning, creative]
  ├─ Enable config variants: ✓
  └─ Select variants: [Deterministic, Balanced, Creative]

System executes:
  ├─ qwen2.5:7b @ Deterministic config → 20 tests
  ├─ qwen2.5:7b @ Balanced config → 20 tests
  └─ qwen2.5:7b @ Creative config → 20 tests

Results show:
  ├─ Deterministic: Best for coding (90 quality), poor for creative (65 quality)
  ├─ Balanced: Good all-around (78 quality average)
  └─ Creative: Best for creative (88 quality), poor for factual (62 quality)

Recommendation:
  Use Deterministic config for code/factual tasks
  Use Creative config for creative tasks
  Use Balanced for mixed workloads
```

**API Endpoint:**
```javascript
POST /api/benchmark/batch/config-comparison
{
  model: "qwen2.5:7b",
  host: "http://localhost:11434",
  prompt_categories: ["coding", "creative"],
  config_variants: [
    { temperature: 0.0, top_p: 0.9 },
    { temperature: 0.7, top_p: 0.95 },
    { temperature: 1.2, top_p: 0.98 }
  ]
}

Response:
{
  batch_id: "batch_xyz789",
  tests_created: 60,  // 3 variants × 20 prompts
  estimated_duration: "~15 minutes"
}
```

### 3.2 Prompt Template Benchmarking

**Goal:** Test different system prompts to find best prompt style per model.

**Schema Changes:**
```javascript
// NEW Collection: PromptTemplate
const PromptTemplateSchema = new mongoose.Schema({
  name: String,  // "Expert Programmer v1"
  category: String,  // "coding", "reasoning", etc.
  content: String,  // System prompt text
  description: String,
  tags: [String],
  variants: [{
    version: Number,
    content: String,
    tested_models: [String],
    avg_quality_delta: Number  // vs. no system prompt
  }],
  performance_stats: {
    avg_quality_boost: Number,
    best_model: String,
    worst_model: String,
    test_count: Number
  }
});

// BenchmarkResult.js - NEW fields
system_prompt_template_id: ObjectId,
system_prompt_template_name: String,
system_prompt_content: String  // Snapshot
```

**Predefined System Prompt Templates:**

| Template | Category | Content |
|----------|----------|---------|
| **Expert Programmer v1** | coding | "You are an expert programmer. Write clean, efficient, well-documented code following best practices." |
| **Expert Programmer v2** | coding | "You are a senior software engineer with 10 years of experience. Focus on correctness, readability, maintainability, and error handling." |
| **Code Reviewer v1** | coding | "You are a meticulous code reviewer. Identify bugs, risks, edge cases, and suggest concrete improvements." |
| **Debugging Detective** | debugging | "You are a debugging specialist. Isolate root causes, propose minimal fixes, and verify with tests." |
| **Refactoring Specialist** | refactoring | "You refactor for clarity and maintainability. Preserve behavior, improve structure, and reduce complexity." |
| **Security Auditor** | security | "You are a security auditor. Look for vulnerabilities, unsafe patterns, and recommend secure alternatives." |
| **Deep Thinker v1** | reasoning | "Think step-by-step. Break down complex problems. Show your reasoning process." |
| **Deep Thinker v2** | reasoning | "You are a logical reasoning expert. Analyze carefully, consider all angles, identify assumptions, and draw sound conclusions." |
| **Mathematical Rigor** | math | "You are a math expert. Use precise notation, show derivations, and check edge cases." |
| **Data Analyst** | analysis | "You are a data analyst. Structure the problem, state assumptions, and present insights with clear metrics." |
| **Technical Writer** | writing | "You are a technical writer. Produce clear, structured documentation with correct terminology and examples." |
| **Educator Tutor** | education | "You are a patient tutor. Explain concepts progressively, check understanding, and adapt to the learner." |
| **Concise Responder** | general | "Be concise. Answer directly without unnecessary elaboration." |
| **Detailed Explainer** | general | "Provide thorough, detailed explanations. Break down concepts. Use examples." |
| **Executive Summarizer** | summarization | "You are an executive summarizer. Capture key points, decisions, and risks in a brief format." |
| **Translation Professional** | translation | "You are a professional translator. Preserve meaning, tone, and domain-specific terminology." |
| **Product Manager** | planning | "You are a product manager. Clarify goals, define scope, surface tradeoffs, and propose a roadmap." |
| **QA Test Engineer** | qa | "You are a QA engineer. Create test cases, focus on edge cases, and outline expected results." |
| **Creative Director** | creative | "You are a creative director. Generate original ideas aligned to the brief, tone, and audience." |
| **Instruction Follower** | instruction-following | "You strictly follow user instructions. Ask clarifying questions only when required." |

**Benchmark Workflow:**
```
User creates batch:
  ├─ Select model: "qwen2.5-coder:7b"
  ├─ Select category: "coding"
  ├─ Enable prompt template testing: ✓
  └─ Select templates: [None, Expert Programmer v1, Expert Programmer v2]

System executes:
  ├─ qwen2.5-coder:7b @ no system prompt → 20 coding tests
  ├─ qwen2.5-coder:7b @ Expert Programmer v1 → 20 coding tests
  └─ qwen2.5-coder:7b @ Expert Programmer v2 → 20 coding tests

Results show:
  ├─ No system prompt: 78.5 quality
  ├─ Expert Programmer v1: 82.3 quality (+3.8)
  └─ Expert Programmer v2: 85.1 quality (+6.6) ← BEST

Recommendation:
  Use "Expert Programmer v2" for qwen2.5-coder:7b coding tasks
  Expected quality boost: +6.6 points
```

### 3.3 Host/Hardware Comparison Analytics

**Goal:** Compare same model across different hardware setups (GPU types, VRAM, quantization).

**Schema Changes:**
```javascript
// NEW Collection: HardwareProfile
const HardwareProfileSchema = new mongoose.Schema({
  host: String,  // "http://192.168.1.100:11434"
  profile_name: String,  // "RTX 4090 Workstation"
  hardware: {
    gpu: String,         // "NVIDIA RTX 4090"
    vram_total_mb: Number,  // 24576
    cpu: String,         // "AMD Ryzen 9 7950X"
    ram_total_mb: Number,   // 65536
    backend: String      // "CUDA" | "Metal" | "CPU"
  },
  location: String,  // "Office", "Home", "Cloud"
  tags: [String],
  created_at: Date
});

// BenchmarkResult.js - NEW fields
hardware_profile_id: ObjectId,
hardware_snapshot: {
  gpu: String,
  vram_used_mb: Number,
  vram_total_mb: Number,
  quantization: String,  // "q4_0", "q8_0", "fp16"
  backend: String,
  gpu_layers: Number,
  cpu_threads: Number
}
```

**Hardware Detection (during benchmark):**
- Query Ollama: `GET /api/ps` (if available) → VRAM usage
- Query model details: `POST /api/show {name}` → quantization, size
- Store snapshot with each result

**Comparison View:**
```
Model: qwen2.5:7b

Hardware Profile Comparison:

┌─────────────────────┬─────────┬──────────┬─────────┬─────────┐
│ Host                │ GPU     │ Avg Lat  │ Tokens/s│ Quality │
├─────────────────────┼─────────┼──────────┼─────────┼─────────┤
│ RTX 4090 Workstation│ RTX 4090│  1200ms  │  45 t/s │  8.2/10 │
│ RTX 3090 Server     │ RTX 3090│  1800ms  │  32 t/s │  8.1/10 │
│ Mac Studio M2 Ultra │ M2 Ultra│  2100ms  │  28 t/s │  8.2/10 │
│ CPU-Only Server     │ None    │ 12000ms  │   5 t/s │  8.0/10 │
└─────────────────────┴─────────┴──────────┴─────────┴─────────┘

Insights:
• RTX 4090: Best performance (3.75× faster than 3090)
• Quality consistent across hardware (±0.2 points)
• CPU-only not recommended (10× slower)
```

**API Endpoint:**
```javascript
GET /api/benchmark/host-comparison?model=qwen2.5:7b

Response:
{
  model: "qwen2.5:7b",
  hosts: [
    {
      host: "http://192.168.1.100:11434",
      profile_name: "RTX 4090 Workstation",
      hardware: { gpu: "RTX 4090", vram: 24576 },
      metrics: {
        avg_latency_ms: 1200,
        tokens_per_sec: 45,
        avg_quality: 8.2,
        test_count: 50
      }
    },
    // ...
  ],
  fastest_host: "http://192.168.1.100:11434",
  best_quality_host: "http://192.168.1.100:11434"
}
```

### 3.4 Conversation-Level Judging

**Goal:** Post-conversation quality analysis for model comparison and prompt engineering validation.

**UX:** Manual trigger (button click after conversation ends).

**Schema Changes:**
```javascript
// Conversation.js - NEW field
quality_assessment: {
  overall_score: Number,  // 0-100
  dimensions: {
    accuracy: Number,       // Factual correctness
    relevance: Number,      // On-topic responses
    coherence: Number,      // Logical flow across turns
    helpfulness: Number,    // Achieved user's goal?
    engagement: Number,     // Natural conversation?
    context_retention: Number,  // Remembered previous turns?
    instruction_following: Number,  // Followed user requests?
    response_quality: Number,  // Individual response quality
    efficiency: Number,     // Concise vs. verbose?
    safety: Number         // Appropriate content?
  },
  judge_model: String,
  judged_at: Date,
  human_rating: Number,    // User's thumbs up/down
  disagreement: Number,    // |judge - human|
  conversation_length: Number,  // # of turns
  avg_latency_ms: Number
}
```

**Judge Prompt for Conversations:**
```
You are evaluating a multi-turn conversation between a user and an AI assistant.

CONVERSATION ({{turn_count}} turns):
[Turn 1]
User: {{message}}
Assistant: {{response}}

[Turn 2]
User: {{message}}
Assistant: {{response}}

...

EVALUATION CRITERIA (score 0-10 each):
1. Accuracy: Are responses factually correct?
2. Relevance: Are responses on-topic and addressing user's questions?
3. Coherence: Does conversation flow logically across turns?
4. Helpfulness: Did assistant achieve user's goal?
5. Engagement: Is conversation natural and easy to follow?
6. Context Retention: Did assistant remember previous turns?
7. Instruction Following: Did assistant follow user's specific requests?
8. Response Quality: Are individual responses high quality?
9. Efficiency: Are responses concise or unnecessarily verbose?
10. Safety: Is content appropriate and safe?

Respond ONLY with JSON:
{
  "accuracy": X,
  "relevance": X,
  "coherence": X,
  "helpfulness": X,
  "engagement": X,
  "context_retention": X,
  "instruction_following": X,
  "response_quality": X,
  "efficiency": X,
  "safety": X,
  "overall": X,
  "explanation": "brief summary"
}
```

**UI Integration:**
```
[End of conversation in chat interface]

┌────────────────────────────────────────┐
│  Analyze Conversation Quality          │
│                                         │
│  Model: qwen2.5:7b                     │
│  Turns: 12                             │
│  Avg Latency: 1.8s                     │
│                                         │
│  [Analyze with Judge Model ▼]          │
│  └─ llama3.1:8b (default)              │
│  └─ qwen2.5:7b                         │
│  └─ deepseek-r1:7b                     │
│                                         │
│  [ Analyze Quality ] button            │
└────────────────────────────────────────┘

After analysis:

┌────────────────────────────────────────┐
│  Conversation Quality Analysis          │
│                                         │
│  Overall Score: 8.3/10                 │
│                                         │
│  ├─ Accuracy: 8.5/10                   │
│  ├─ Relevance: 9.0/10                  │
│  ├─ Coherence: 8.0/10                  │
│  ├─ Helpfulness: 8.5/10                │
│  ├─ Engagement: 7.5/10                 │
│  ├─ Context Retention: 8.0/10          │
│  ├─ Instruction Following: 9.0/10      │
│  ├─ Response Quality: 8.5/10           │
│  ├─ Efficiency: 8.0/10                 │
│  └─ Safety: 10.0/10                    │
│                                         │
│  Judge: llama3.1:8b                    │
│  Analysis Time: 2.3s                   │
│                                         │
│  Summary: "Conversation was coherent   │
│  and on-topic. Assistant followed      │
│  instructions well and retained        │
│  context across turns."                │
└────────────────────────────────────────┘

[ Compare with Human Rating? ]
Your rating: 👍 (positive)
Judge predicted: 8.3/10 (positive)
Agreement: ✓ Aligned
```

**API Endpoint:**
```javascript
POST /api/conversations/:id/judge
{
  judge_model: "llama3.1:8b"
}

Response:
{
  conversation_id: "conv_abc123",
  quality_assessment: {
    overall_score: 8.3,
    dimensions: { accuracy: 8.5, relevance: 9.0, ... },
    explanation: "...",
    judge_model: "llama3.1:8b",
    judged_at: "2026-01-18T10:30:00Z"
  }
}
```

**Use Cases:**
1. **Model Comparison:** Judge same conversation with different models, compare scores
2. **Prompt Validation:** Test system prompt changes, measure impact on conversation quality
3. **Quality Monitoring:** Track conversation quality over time
4. **Judge-Human Correlation:** Compare judge scores to user feedback (thumbs up/down)

### 3.5 UI Dashboards

#### 3.5.1 Model Explorer Dashboard

**File:** `/public/model-explorer.html`

**Features:**
- **Search & Filter:**
  - By category, tags, vendor
  - By capability (min context, supports thinking)
  - By performance (min quality, max latency, min tokens/sec)
  - By hardware (max VRAM)
- **Comparison Mode:**
  - Select 2-5 models
  - Side-by-side: Categories, capabilities, benchmark results
  - Radar chart: Quality × Speed × Efficiency
  - Hardware requirements comparison
- **Config Recommendations:**
  - "Best config for coding tasks"
  - "Best config for creative tasks"
  - Expected performance

**Screenshot (text mockup):**
```
┌────────────────────────────────────────────────────────────┐
│ Model Explorer                                             │
├────────────────────────────────────────────────────────────┤
│ Search: [________]  Filter: [Coding ▼] [Active ▼]         │
│                                                            │
│ ┌──────────────┬──────────────┬──────────────┐           │
│ │ qwen2.5:7b   │ gemma2:2b    │ smollm2:1.7b │           │
│ ├──────────────┼──────────────┼──────────────┤           │
│ │ Categories:  │ Categories:  │ Categories:  │           │
│ │ • reasoning  │ • ops        │ • ops        │           │
│ │ • generalist │ • generalist │ • specialist │           │
│ │              │              │              │           │
│ │ Quality: 8.2 │ Quality: 7.4 │ Quality: 6.9 │           │
│ │ Speed: 45t/s │ Speed: 58t/s │ Speed: 72t/s │           │
│ │ Latency: 1.2s│ Latency: 0.9s│ Latency: 0.7s│           │
│ │              │              │              │           │
│ │ Best for:    │ Best for:    │ Best for:    │           │
│ │ • Reasoning  │ • Quick chat │ • Fast ops   │           │
│ │ • Analysis   │ • Simple Q&A │ • Routing    │           │
│ └──────────────┴──────────────┴──────────────┘           │
│                                                            │
│ [ Compare Selected ] [ View Details ]                     │
└────────────────────────────────────────────────────────────┘
```

#### 3.5.2 Config Optimizer Dashboard

**File:** `/public/config-optimizer.html`

**Workflow:**
1. Select model
2. Choose use case (coding, reasoning, creative)
3. Set constraints (max latency, min quality)
4. Click "Find Optimal Config"
5. Returns recommended config + expected performance
6. "Test Config" button → Runs mini-benchmark (5 prompts)
7. Save config as preset

**Screenshot (text mockup):**
```
┌────────────────────────────────────────────────────────────┐
│ Config Optimizer                                           │
├────────────────────────────────────────────────────────────┤
│ 1. Select Model                                            │
│    [qwen2.5:7b ▼]                                          │
│                                                            │
│ 2. Choose Use Case                                         │
│    ( ) Coding  (•) Reasoning  ( ) Creative  ( ) General   │
│                                                            │
│ 3. Set Constraints                                         │
│    Max Latency: [3000] ms                                  │
│    Min Quality: [7.0] / 10                                 │
│    Max VRAM: [8192] MB                                     │
│                                                            │
│ [ Find Optimal Config ]                                    │
│                                                            │
│ ───────────────────────────────────────────────────────    │
│ RECOMMENDED CONFIG:                                        │
│                                                            │
│ Temperature: 0.7                                           │
│ Top-P: 0.95                                                │
│ Context Length: 8192                                       │
│ Repeat Penalty: 1.0                                        │
│                                                            │
│ EXPECTED PERFORMANCE:                                      │
│ Quality: 8.2 / 10                                          │
│ Latency: ~2400 ms                                          │
│ Tokens/sec: ~42                                            │
│                                                            │
│ [ Test This Config ] [ Save as Preset ]                    │
└────────────────────────────────────────────────────────────┘
```

#### 3.5.3 Hardware Performance Matrix

**File:** `/public/hardware-matrix.html`

**Features:**
- Matrix: Models (rows) × Hardware Profiles (columns)
- Cells: Color-coded by tokens/sec (green=fast, red=slow)
- Hover: Show full metrics (latency, quality, VRAM)
- Click: Drill into benchmark results

**Screenshot (text mockup):**
```
┌─────────────────────────────────────────────────────────────────┐
│ Hardware Performance Matrix                                     │
├─────────────────────────────────────────────────────────────────┤
│            │ RTX 4090    │ RTX 3090    │ M2 Ultra    │ CPU-Only│
├────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ qwen2.5:7b │ 45 t/s 🟢  │ 32 t/s 🟡  │ 28 t/s 🟡  │ 5 t/s 🔴│
│ gemma2:2b  │ 72 t/s 🟢  │ 58 t/s 🟢  │ 45 t/s 🟢  │ 12 t/s 🟡│
│ llama3.3:70b│ 12 t/s 🟡  │ 8 t/s 🔴  │ N/A        │ N/A     │
│ deepseek:7b│ 38 t/s 🟢  │ 28 t/s 🟡  │ 25 t/s 🟡  │ 4 t/s 🔴│
└────────────┴─────────────┴─────────────┴─────────────┴─────────┘

Legend:
🟢 Fast (>30 t/s)
🟡 Moderate (10-30 t/s)
🔴 Slow (<10 t/s)

[Filter: Category ▼] [GPU Type ▼] [Quantization ▼]
```

#### 3.5.4 Enhanced Benchmark Results Explorer

**File:** `/public/benchmark.html` (enhanced)

**New Features:**
- **Grouping:** By model, category, level, host, config variant
- **Filtering:**
  - By quality score range
  - By latency range
  - By success/failure
  - By config variant
  - By hardware profile
- **Drill-down:**
  - Click model → All results for that model
  - Click category → Category breakdown
  - Click config → Config comparison
- **Export:**
  - CSV export with all fields
  - JSON for programmatic access

**Screenshot (text mockup):**
```
┌─────────────────────────────────────────────────────────────────┐
│ Benchmark Results Explorer                                      │
├─────────────────────────────────────────────────────────────────┤
│ Group By: [Model ▼]  Filter: [Quality >7 ▼] [Category ▼]       │
│                                                                 │
│ ▼ qwen2.5:7b (Avg: 8.2)                                         │
│   ├─ coding (20 tests): Quality 8.5, Latency 1.4s             │
│   ├─ reasoning (20 tests): Quality 8.1, Latency 2.1s          │
│   └─ creative (20 tests): Quality 7.9, Latency 1.8s           │
│                                                                 │
│ ▼ gemma2:2b (Avg: 7.4)                                         │
│   ├─ coding (20 tests): Quality 7.2, Latency 0.9s             │
│   ├─ reasoning (20 tests): Quality 7.0, Latency 1.2s          │
│   └─ creative (20 tests): Quality 7.8, Latency 1.0s           │
│                                                                 │
│ [ Export CSV ] [ Export JSON ] [ View Charts ]                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Roadmap (12 Weeks)

### Week 1-2: Phase 1 Foundation (Enhanced Scoring Dimensions)
- ✅ Extend `BenchmarkPrompt.scoring_dimensions` field (dynamic array)
- ✅ Update `qualityScorer.js` to use dynamic dimensions (backward compatible)
- ✅ Create ENHANCED_SCORING_CONFIGS (8-12 dimensions per type)
- ✅ Update judge prompt generation logic
- ✅ Test multi-dimensional scoring with existing prompts
- ✅ Write unit tests for new scoring logic

### Week 3-4: Phase 1 Test Diversity (Expand Categories + Levels)
- ✅ Update `BenchmarkPrompt.prompt_level` max from 5 → 10
- ✅ Design 6 new categories (instruction-following, summarization, translation, multi-turn, context-retention, edge-cases)
- ✅ **EXTERNAL AGENT:** Generate 120+ new prompts (20 per new category across 10 levels)
- ✅ Add prompts to `categorization-prompts.json` and `benchmark-prompts.json`
- ✅ Update category enum in `BenchmarkResult` schema
- ✅ Test new categories with 2-3 models

### Week 5: Phase 1 Task-Specific Composite Profiles
- ✅ Implement CATEGORY_COMPOSITE_PROFILES in `qualityScorer.js`
- ✅ Update `calculateCompositeScore()` to accept `category` parameter
- ✅ Add `composite_profile_used` field to `BenchmarkResult`
- ✅ Test composite scoring with different profiles
- ✅ Verify score differentiation improvement

### Week 6: Phase 2 Multi-Judge Foundation (Optional)
- ✅ Add `judge_config` field to `BenchmarkBatch`
- ✅ Add `quality_breakdown.judges[]` field to `BenchmarkResult`
- ✅ Implement parallel judge execution in `qualityScorer.js`
- ✅ Implement aggregation strategies (average, median, weighted)
- ✅ Add judge agreement metric calculation
- ✅ Write tests for multi-judge scoring

### Week 7: Phase 2 Multi-Judge UI (Toggleable)
- ✅ Add multi-judge enable checkbox to benchmark form
- ✅ Add judge model selection UI
- ✅ Add aggregation strategy selector
- ✅ Update results display to show per-judge breakdown
- ✅ Add judge agreement indicator
- ✅ Test toggle on/off functionality

### Week 8: Phase 3 Config Variation Testing
- ✅ Create `ConfigVariant` collection
- ✅ Add `config_variants` field to `BenchmarkBatch`
- ✅ Add `config_variant_id` and `config_parameters` to `BenchmarkResult`
- ✅ Implement config variation benchmark API
- ✅ Create predefined config variants (Deterministic, Balanced, Creative, Extended)
- ✅ Test config comparison workflow

### Week 9: Phase 3 Prompt Template Benchmarking
- ✅ Create `PromptTemplate` collection
- ✅ Add `system_prompt_template_id` to `BenchmarkResult`
- ✅ Seed predefined prompt templates (Expert Programmer, Deep Thinker, etc.)
- ✅ Implement prompt template benchmark API
- ✅ Calculate quality delta vs. no system prompt
- ✅ Test template comparison workflow

### Week 10: Phase 3 Hardware Profiling
- ✅ Create `HardwareProfile` collection
- ✅ Add `hardware_snapshot` to `BenchmarkResult`
- ✅ Implement hardware detection during benchmarks (VRAM, quantization, backend)
- ✅ Create host comparison API endpoint
- ✅ Test hardware data collection
- ✅ Verify hardware comparison accuracy

### Week 11: Phase 3 Conversation Judging + UI
- ✅ Add `quality_assessment` field to `Conversation`
- ✅ Create `POST /api/conversations/:id/judge` endpoint
- ✅ Implement conversation judge prompt (10 dimensions)
- ✅ Add "Analyze Quality" button to chat UI
- ✅ Display quality breakdown after analysis
- ✅ Test conversation judging workflow

### Week 12: Phase 3 UI Dashboards + Polish
- ✅ Create Model Explorer (`/public/model-explorer.html`)
- ✅ Create Config Optimizer (`/public/config-optimizer.html`)
- ✅ Create Hardware Matrix (`/public/hardware-matrix.html`)
- ✅ Enhance Benchmark Results Explorer
- ✅ End-to-end integration testing
- ✅ Documentation updates
- ✅ Performance optimization
- ✅ Release notes

---

## Critical Files to Create/Modify

### Backend (Services & Models)

**Modify Existing:**
1. [src/services/qualityScorer.js](../../src/services/qualityScorer.js) - Add ENHANCED_SCORING_CONFIGS, multi-judge, category-specific composite
2. [src/services/benchmark/index.js](../../src/services/benchmark/index.js) - Add config variants, prompt templates, hardware profiling
3. [models/BenchmarkPrompt.js](../../models/BenchmarkPrompt.js) - Add `scoring_dimensions`, update `prompt_level` max
4. [models/BenchmarkResult.js](../../models/BenchmarkResult.js) - Add `quality_breakdown.judges`, `config_variant_id`, `hardware_snapshot`, `system_prompt_template_id`
5. [models/BenchmarkBatch.js](../../models/BenchmarkBatch.js) - Add `judge_config`, `config_variants`
6. [models/Conversation.js](../../models/Conversation.js) - Add `quality_assessment`
7. [routes/benchmark/index.js](../../routes/benchmark/index.js) - Add config comparison, prompt template, host comparison endpoints
8. routes/chat.js - Add conversation judging endpoint

**Create New:**
9. [models/ConfigVariant.js](../../models/ConfigVariant.js) - Config variant schema
10. [models/PromptTemplate.js](../../models/PromptTemplate.js) - System prompt template schema
11. [models/HardwareProfile.js](../../models/HardwareProfile.js) - Hardware profile schema
12. scripts/generate-test-prompts.js - Script to generate 120+ new prompts (use external LLM)
13. [scripts/seed-config-variants.js](../../scripts/seed-config-variants.js) - Seed predefined configs
14. [scripts/seed-prompt-templates.js](../../scripts/seed-prompt-templates.js) - Seed predefined templates

### Frontend (UI/UX)

**Create New:**
15. [public/model-explorer.html](../../public/model-explorer.html) - Model explorer dashboard
16. [public/js/model-explorer.js](../../public/js/model-explorer.js) - Model explorer logic
17. [public/css/model-explorer.css](../../public/css/model-explorer.css) - Model explorer styling
18. [public/config-optimizer.html](../../public/config-optimizer.html) - Config optimizer
19. [public/js/config-optimizer.js](../../public/js/config-optimizer.js) - Config optimizer logic
20. [public/hardware-matrix.html](../../public/hardware-matrix.html) - Hardware matrix
21. [public/js/hardware-matrix.js](../../public/js/hardware-matrix.js) - Hardware matrix logic

**Modify Existing:**
22. [public/benchmark.html](../../public/benchmark.html) - Enhanced results explorer
23. public/js/benchmark-inline.js - Add grouping, filtering, export
24. [public/js/chat.js](../../public/js/chat.js) - Add "Analyze Quality" button

### Data Files

**Modify:**
25. [data/categorization-prompts.json](../../data/categorization-prompts.json) - Add 120+ new prompts

**Create:**
26. [data/config-variants.json](../../data/config-variants.json) - Predefined config variants
27. [data/prompt-templates.json](../../data/prompt-templates.json) - Predefined system prompts

### Tests

**Create:**
28. tests/services/qualityScorer.enhanced.test.js - Multi-dimensional + multi-judge tests
29. tests/integration/config-variation.test.js - Config comparison tests
30. tests/integration/prompt-templates.test.js - Prompt template tests
31. tests/integration/conversation-judging.test.js - Conversation judge tests

### Documentation

**Update:**
32. [docs/operations/BENCHMARK_SYSTEM.md](BENCHMARK_SYSTEM.md) - Document new features
33. [docs/architecture/MODEL_REGISTRY.md](../architecture/MODEL_REGISTRY.md) - Update schema docs
34. [ROADMAP.md](../../ROADMAP.md) - Add Track 9: Enhanced Model Intelligence

**Create:**
35. docs/user-manual/MODEL_EXPLORER.md - Model explorer guide
36. docs/user-manual/CONFIG_OPTIMIZER.md - Config optimizer guide
37. docs/user-manual/CONVERSATION_JUDGING.md - Conversation judging guide

---

## External Agent Prompts

### Agent 1: Prompt Generation (Week 3-4)

**Task:** Generate 120+ high-quality benchmark prompts across 6 new categories and 10 difficulty levels.

**Prompt:**
```
You are an expert prompt engineer designing benchmark prompts for LLM evaluation. Your task is to create 120 diagnostic prompts across 6 new categories with 10 difficulty levels each (20 prompts per category).

CATEGORIES TO GENERATE (20 prompts each):
1. instruction-following - Test precise adherence to complex constraints
2. summarization - Test information distillation
3. translation - Test multilingual capability (focus on English↔French/Spanish)
4. multi-turn-reasoning - Test context retention across multiple steps
5. context-retention - Test long-context memory
6. edge-cases - Test robustness with unusual inputs

DIFFICULTY LEVELS (1-10):
Level 1: Trivial - Basic syntax, single operations
Level 2: Simple - Basic logic, simple functions
Level 3: Easy - Multiple steps, basic algorithms
Level 4: Moderate-Easy - Intermediate algorithms, error handling
Level 5: Moderate - Complex logic, data structures
Level 6: Moderate-Hard - Advanced algorithms, edge cases
Level 7: Hard - System design basics, optimization
Level 8: Very Hard - Complex system design, multiple constraints
Level 9: Expert - Distributed systems, advanced concurrency
Level 10: Extreme - Research-level, novel problem solving

DISTRIBUTION PER CATEGORY:
- Levels 1-3: 6 prompts (30%)
- Levels 4-6: 8 prompts (40%) ← KEY DIFFERENTIATION ZONE
- Levels 7-9: 5 prompts (25%)
- Level 10: 1 prompt (5%)

OUTPUT FORMAT (JSON):
{
  "level": 4,
  "category": "instruction-following",
  "category_test": true,
  "name": "Prompt Name",
  "prompt": "The actual prompt text...",
  "expected_tokens": 150,
  "expected_answer": "What a correct answer should contain...",
  "judge_criteria": [
    "Criterion 1",
    "Criterion 2",
    "Criterion 3",
    "Criterion 4"
  ],
  "scoring_type": "reasoning"  // or "code", "factual", "math", "creative"
}

QUALITY REQUIREMENTS:
1. Each prompt must have clear, objective judge_criteria (4-5 criteria)
2. expected_answer must be specific enough for LLM judges to evaluate
3. Prompts must differentiate models at that level (avoid too easy or too hard)
4. Vary prompt styles within each category (avoid repetition)
5. Levels 4-6 are CRITICAL - these must separate "good" from "great" models

CONSTRAINTS:
- instruction-following: Include specific constraints (e.g., "use only recursion", "respond in 3 sentences")
- summarization: Provide text to summarize (50-500 words depending on level)
- translation: Include context/nuance challenges, not just word-for-word
- multi-turn-reasoning: Use "Step 1: X. Step 2 (using 1): Y. Step 3 (combining 1&2): Z" format
- context-retention: Include long text (500-2000 words) with questions requiring distant context
- edge-cases: Test null, empty, negative, zero, extreme values, malformed inputs

START WITH: instruction-following category (20 prompts, levels 1-10)

Generate the JSON array for all 20 prompts now.
```

**Expected Output:** 120 JSON prompt objects following the schema.

**Quality Check:**
- Each category has exactly 20 prompts
- Levels distributed: 6 (1-3), 8 (4-6), 5 (7-9), 1 (10)
- All prompts have 4-5 judge_criteria
- Prompts at levels 4-6 are neither trivial nor impossibly hard

### Agent 2: Config Variant Testing (Week 8)

**Task:** Design comprehensive config variant test scenarios for different model types.

**Prompt:**
```
You are designing configuration variant test scenarios for LLM benchmarking. Your goal is to create config presets that reveal optimal settings for different use cases.

TASK: Create 8-10 config variant presets beyond the 4 defaults (Deterministic, Balanced, Creative, Extended Context).

DEFAULT PRESETS (already exist):
1. Deterministic: temp=0.0, top_p=0.9, repeat_penalty=1.1
2. Balanced: temp=0.7, top_p=0.95, repeat_penalty=1.0
3. Creative: temp=1.2, top_p=0.98, repeat_penalty=0.9
4. Extended Context: temp=0.7, top_p=0.95, num_ctx=16384

NEW PRESETS TO DESIGN:
Consider these use case dimensions:
- Task type: coding, reasoning, factual, creative, conversational
- Output style: concise vs. verbose, formal vs. casual
- Quality vs. speed trade-off
- Repetition control
- Context length requirements

OUTPUT FORMAT (JSON):
{
  "name": "Preset Name",
  "description": "When to use this preset and expected behavior",
  "use_cases": ["coding", "reasoning"],  // Primary use cases
  "parameters": {
    "temperature": 0.3,
    "top_p": 0.95,
    "top_k": 40,
    "repeat_penalty": 1.15,
    "num_ctx": 8192,
    "num_predict": 512
  },
  "tags": ["production", "fast"],
  "expected_characteristics": {
    "quality_impact": "+5% for coding tasks",
    "speed_impact": "10% faster",
    "output_style": "Concise, focused responses"
  }
}

DESIGN GOALS:
1. Cover diverse use cases (coding, reasoning, creative, factual, conversational)
2. Some presets optimize for speed, others for quality
3. Include specialized presets (e.g., "Code Review", "Storytelling", "Technical Writing")
4. Consider repetition-heavy tasks (need higher repeat_penalty)
5. Consider long-document tasks (need extended context)

Generate 8-10 config variant presets now.
```

**Expected Output:** 8-10 JSON config preset objects.

### Agent 3: System Prompt Template Design (Week 9)

**Task:** Create 15-20 system prompt templates optimized for different model types and tasks.

**Prompt:**
```
You are a prompt engineering expert designing system prompt templates for LLM benchmarking. Your goal is to create templates that measurably improve model performance for specific tasks.

TASK: Create 15-20 system prompt templates across categories: coding, reasoning, creative, factual, conversational.

TEMPLATE CATEGORIES (3-5 templates each):
1. Coding: Different styles (expert programmer, test-driven, documentation-focused, performance-focused)
2. Reasoning: Different approaches (step-by-step, socratic, analytical, first-principles)
3. Creative: Different tones (formal, casual, narrative, descriptive)
4. Factual: Different formats (concise, detailed, sourced, educational)
5. Conversational: Different personalities (helpful assistant, teacher, expert, friend)

OUTPUT FORMAT (JSON):
{
  "name": "Expert Programmer v2",
  "category": "coding",
  "content": "You are a senior software engineer with 10 years of experience. Focus on: correctness, readability, maintainability, and error handling. Write clean, well-documented code following best practices.",
  "description": "Emphasizes code quality dimensions for benchmark scoring",
  "tags": ["coding", "quality-focused", "production"],
  "target_models": ["qwen2.5-coder", "deepseek-coder"],  // Which models benefit most
  "expected_quality_boost": 5.5,  // Expected improvement in quality score
  "variants": [
    {
      "version": 1,
      "content": "Shorter version...",
      "description": "More concise approach"
    }
  ]
}

DESIGN PRINCIPLES:
1. Templates should be specific enough to influence behavior
2. Include 2-3 variants per template (short, medium, long)
3. Specify which models benefit most (thinking models, code models, generalists)
4. Templates should align with our enhanced scoring dimensions
5. Some templates optimize for quality, others for speed/conciseness

EXAMPLES OF GOOD TEMPLATES:
- Coding: "You are a test-driven developer. Write code with comprehensive error handling and edge case coverage. Include example usage."
- Reasoning: "Think step-by-step. Break down complex problems into sub-problems. Verify each step before proceeding."
- Creative: "You are a creative writer. Use vivid descriptions, varied sentence structure, and engaging narrative flow."

Generate 15-20 system prompt templates now (3-5 per category).
```

**Expected Output:** 15-20 JSON template objects with variants.

---

## Verification & Testing

### End-to-End Test Scenarios

**Scenario 1: Enhanced Scoring Differentiation**
1. Run benchmark with old scoring system (3-5 dimensions)
2. Record model score clustering (e.g., qwen2.5:7b=74.0, gemma2:2b=73.8)
3. Run same benchmark with enhanced scoring (10-12 dimensions)
4. Verify score spread increases (e.g., qwen2.5:7b=82.3, gemma2:2b=71.2)
5. Confirm differentiation improvement: score delta >5 points for models with different real-world performance

**Scenario 2: Difficulty Level Differentiation**
1. Create prompt set at level 5 (moderate)
2. Test with 3 models: smollm2:1.7b, qwen2.5:7b, llama3.3:70b
3. Verify scores spread across 30+ point range
4. Repeat with level 8 (very hard) prompts
5. Confirm only top models score >70 at level 8

**Scenario 3: Config Variation Discovery**
1. Select model: qwen2.5:7b
2. Run config comparison: Deterministic, Balanced, Creative
3. Test across categories: coding, reasoning, creative
4. Verify Deterministic best for coding (quality >85)
5. Verify Creative best for creative tasks (quality >82)
6. Confirm Balanced mediocre across all (~75)

**Scenario 4: Multi-Judge Consensus (Phase 2)**
1. Enable multi-judge with 3 models: llama3.1:8b, qwen2.5:7b, deepseek-r1:7b
2. Run 10 test prompts
3. Check judge agreement metric >0.7 for clear responses
4. Check judge agreement <0.6 for ambiguous responses
5. Verify median aggregation handles outlier judge scores

**Scenario 5: Conversation Judging**
1. Complete 10-turn conversation with model
2. Click "Analyze Quality" button
3. Judge evaluates on 10 dimensions
4. Verify overall score aligns with subjective quality
5. Compare judge score to human feedback (thumbs up/down)
6. Calculate judge-human correlation across 20 conversations (target >0.7)

**Scenario 6: Host Comparison**
1. Register 3 hardware profiles: RTX 4090, RTX 3090, M2 Ultra
2. Run same model (qwen2.5:7b) on all 3 hosts
3. Navigate to Hardware Matrix
4. Verify tokens/sec ratios match expected (4090: 45, 3090: 32, M2: 28)
5. Confirm quality scores consistent across hardware (±0.2)

### Performance Testing

**Load Test 1: Large Prompt Set (Enhanced)**
- Models: 5
- Prompts per model: 200 (vs. old 62)
- Total tests: 1000
- Expected duration: ~3-4 hours
- Success criteria: <5% failures, all tests complete

**Load Test 2: Config Variants**
- Models: 3
- Config variants: 4
- Prompts per variant: 50
- Total tests: 600 (3×4×50)
- Expected duration: ~2 hours
- Success criteria: All configs tested, results distinct

**Load Test 3: Multi-Judge (Phase 2)**
- Models: 2
- Judge models: 3
- Prompts: 50
- Total judge invocations: 300 (2×3×50)
- Expected duration: ~1 hour
- Success criteria: All judges complete, agreement calculated

### Data Validation

**Schema Validation:**
- `BenchmarkPrompt.prompt_level` accepts 1-10
- `BenchmarkPrompt.scoring_dimensions` array validated
- `BenchmarkResult.quality_breakdown` contains 8-12 dimensions
- `BenchmarkBatch.judge_config` properly structured
- All new enums valid (categories, scoring types)

**Scoring Validation:**
- Multi-dimensional scores sum to weighted overall
- Category-specific composite uses correct profile
- Multi-judge aggregation produces expected result
- Config variant results tagged with correct config

**UI Validation:**
- Model Explorer filters work correctly
- Config Optimizer returns valid recommendations
- Hardware Matrix color-coding accurate
- Conversation judging button appears after conversation
- Multi-judge toggle enables/disables feature

---

## Success Metrics

### Quantitative

**Score Differentiation (Primary Goal):**
- **Baseline:** Models cluster at 72-76 composite (4-point spread)
- **Target:** Models spread across 60-90 composite (30-point spread)
- **Measurement:** Run same 11 models with old vs. enhanced system, compare score variance

**Test Coverage:**
- **Baseline:** 6 categories, 62 prompts, 5 levels
- **Target:** 12 categories, 200+ prompts, 10 levels
- **Measurement:** Count prompts in categorization-prompts.json

**Scoring Granularity:**
- **Baseline:** 3-5 dimensions per scoring type
- **Target:** 10-12 dimensions per scoring type
- **Measurement:** Count dimensions in ENHANCED_SCORING_CONFIGS

**Config Optimization:**
- Target: >70% of users accept recommended config
- Measurement: Track "Save as Preset" clicks after recommendations

**Conversation Judging:**
- Target: Judge-human correlation >0.7
- Measurement: Compare judge scores to user feedback ratings

**UI Performance:**
- Model Explorer loads <2s with 100+ models
- Hardware Matrix renders <1s
- Config Optimizer returns recommendation <3s

**Test Coverage:**
- Services: >80%
- Routes: >70%
- New features: >75%

### Qualitative

- Users report easier model selection
- Users find optimal configs faster
- Users understand hardware requirements better
- Users trust judge scores more (multi-judge consensus)
- Reduced trial-and-error in model/config tuning

---

## Risk Mitigation

**Risk 1: 200+ Prompts Too Many**
- **Mitigation:** Prioritize levels 4-6 (key differentiation zone), generate 120 prompts initially
- **Fallback:** If 200 prompts overkill, trim to 150 (12 categories × 12 prompts each)

**Risk 2: Multi-Dimensional Scoring Too Slow**
- **Mitigation:** Optimize judge prompt length, use fast judge model (qwen2.5:7b)
- **Fallback:** Make multi-dimensional scoring optional, quick scoring for simple prompts

**Risk 3: Multi-Judge Timeout (Phase 2)**
- **Mitigation:** Parallel execution, 30s timeout per judge, graceful degradation
- **Fallback:** If <2 judges succeed, fall back to single-judge, store partial results

**Risk 4: Hardware Profiling Inaccurate**
- **Mitigation:** Collect hardware data from Ollama API, validate with known benchmarks
- **Fallback:** Allow manual hardware profile entry, mark auto-detected data as estimates

**Risk 5: Conversation Judging Too Expensive**
- **Mitigation:** Manual trigger only (not auto), use fast judge model
- **Fallback:** Limit to conversations <20 turns, truncate long messages

**Risk 6: UI Complexity Overwhelming**
- **Mitigation:** Progressive disclosure (hide advanced features by default)
- **Fallback:** Provide "Simple" vs. "Advanced" mode toggle

---

## Future Enhancements (Out of Scope)

**Phase 4 (Optional):**
- External data integration (HuggingFace API, web search)
- Model fine-tuning tracking (LoRA/fine-tune comparison)
- Automated prompt optimization (A/B test system prompts)
- Collaborative filtering ("Users who liked this model also liked...")
- Cost optimization recommendations (cloud deployment)
- Integration with MLflow for experiment tracking

**Phase 5 (Visionary):**
- Mobile app for model management
- Voice commands ("Find fastest coding model")
- Automated model retirement (sustained poor performance)
- Real-time performance monitoring dashboards
- Anomaly detection for model degradation
- Custom judge model training (fine-tune judge for domain)

---

## Implementation Notes for Developer

**Architecture Principles:**
- **Backward compatible:** All new features optional, existing code unaffected
- **Service-oriented:** Follow Routes → Services → Models pattern
- **Singleton pattern:** Maintain shared state where needed (caching)
- **Graceful degradation:** Features fail silently, fall back to simpler methods
- **Progressive enhancement:** Basic features work, advanced features enhance

**Code Style:**
- Follow existing conventions in codebase
- Use async/await for async operations
- Comprehensive error handling with logger
- JSDoc comments for all functions
- Test coverage >80% for services, >70% for routes

**Testing Strategy:**
- Unit tests: Each service method
- Integration tests: End-to-end workflows
- Performance tests: Large datasets (1000+ tests)
- UI tests: Manual verification of dashboards
- Regression tests: Ensure old features still work

**Documentation:**
- Update inline comments for complex logic
- Update API documentation for new endpoints
- Create user guides for new UI features
- Update ROADMAP.md with completion status

---

## Final Notes

This plan provides architect-level guidance with clear separation between core foundation (Phase 1), advanced features (Phase 2), and critical user priorities (Phase 3). The external agent prompts enable rapid prompt generation without manual writing. The implementation roadmap is realistic (12 weeks) and focuses on high-impact differentiation improvements.

**Key Success Indicator:** Models that currently cluster at 72-76 composite will spread across 60-90 composite, enabling users to clearly differentiate model capabilities and find optimal configurations for their specific use cases.

**Next Steps:**
1. Review plan with stakeholders
2. Approve external agent prompt generation (Week 3-4)
3. Begin Phase 1 foundation work (Week 1-2)
4. Execute according to roadmap
