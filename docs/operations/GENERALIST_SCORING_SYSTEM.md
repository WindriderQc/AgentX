# Generalist Quality Scoring System

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Benchmark System](./BENCHMARK_SYSTEM.md) → Generalist Scoring

> **Source of Truth:** `src/services/benchmark/generalistScore.js`

## Overview

The Generalist Scoring System provides a unified quality metric for comparing LLM models across all benchmark categories. It is the **single source of truth** for quality scoring, used by both:

- **Model Dashboard** - Composite scores blend generalist quality with speed/latency
- **Generalist Leaderboard** - Pure quality ranking with coverage and reliability metrics

## Formula

```
generalistScore = weightedQuality - coveragePenalty + consistencyBonus
```

Where:
- `weightedQuality` = Normalized weighted average of category scores (0-100 scale)
- `coveragePenalty` = Penalty for missing category coverage
- `consistencyBonus` = Bonus for reliable within-category performance

---

## Category Weights

Categories are weighted by importance for general-purpose LLM evaluation:

| Category | Weight | Rationale |
|----------|--------|-----------|
| **Core Capabilities (60%)** | | |
| coding | 15% | Essential for developers |
| reasoning | 15% | Core cognitive ability |
| factual | 10% | Knowledge accuracy |
| creative | 10% | Content generation |
| instruction-following | 10% | User intent adherence |
| **Specialized (30%)** | | |
| math | 8% | Quantitative reasoning |
| summarization | 7% | Information distillation |
| multi-turn-reasoning | 7% | Context retention |
| context-retention | 5% | Long-form understanding |
| translation | 3% | Multilingual capability |
| **Quality Assurance (10%)** | | |
| edge-cases | 5% | Robustness |
| general | 5% | General capability |

**Total: 100%**

---

## Coverage Penalty

Models are penalized for missing category coverage to prevent gaming the leaderboard by only running easy tests.

### How It Works

```javascript
COVERAGE_PENALTY_MAX = 20  // Maximum penalty points per missing category

For each category NOT tested:
    coveragePenalty += categoryWeight × COVERAGE_PENALTY_MAX
```

### Example

If a model skips `coding` (15% weight) and `reasoning` (15% weight):
```
coveragePenalty = (0.15 × 20) + (0.15 × 20) = 6 points
```

### Infrastructure Failures

Categories where tests were **attempted but failed due to infrastructure** (timeouts, connection errors) are **not penalized**. The system detects infra failures via:
- `infra_error: true` flag
- `error_type: 'infra'`
- Error message patterns (ECONNREFUSED, timeout, etc.)

---

## Consistency Bonus (Within-Category Reliability)

Models receive a bonus for **reliable, predictable performance** within each category.

### What It Measures

- **Within-category standard deviation** of quality scores
- Low σ = model produces consistent quality for similar tasks
- High σ = model is unpredictable/unreliable

### Formula

```javascript
CONSISTENCY_STDDEV_THRESHOLD = 15  // On 0-100 scale
CONSISTENCY_BONUS = 5              // Bonus points

// Calculate average stddev across all tested categories
avgWithinCategoryStdDev = average(categoryStdDevs)

if (avgWithinCategoryStdDev < CONSISTENCY_STDDEV_THRESHOLD) {
    consistencyBonus = 5
}
```

### Example

**Reliable Model (gets bonus):**
- Coding tests: 82, 85, 80, 83, 81 → σ = 1.7
- Reasoning tests: 78, 75, 80, 77 → σ = 1.8
- Average σ = 1.75 → **+5 bonus**

**Inconsistent Model (no bonus):**
- Coding tests: 95, 60, 85, 40, 90 → σ = 20.5
- Reasoning tests: 70, 30, 80, 50 → σ = 19.1
- Average σ = 19.8 → **No bonus**

---

## Weighted Quality Normalization

Quality scores are normalized to prevent models with partial coverage from being unfairly compared.

```javascript
// Sum weighted scores only for categories with data
weightedSum = Σ(categoryAverage × categoryWeight)  // Only for tested categories
weightsCovered = Σ(categoryWeight)                  // Sum of weights for tested categories

// Normalize by covered weight
normalizedQuality = weightedSum / weightsCovered
```

### Example

Model tested in `coding` (15%), `reasoning` (15%), `math` (8%):
- Coding avg: 85, Reasoning avg: 80, Math avg: 90
- weightedSum = (85 × 0.15) + (80 × 0.15) + (90 × 0.08) = 31.95
- weightsCovered = 0.15 + 0.15 + 0.08 = 0.38
- normalizedQuality = 31.95 / 0.38 = 84.1

---

## API Reference

### Endpoint

```
GET /api/benchmark/generalist-leaderboard
```

### Response

```json
{
  "status": "success",
  "data": {
    "leaderboard": [
      {
        "model": "gpt-4",
        "host": "api.openai.com",
        "generalistScore": 82.5,
        "weightedSum": 85.0,
        "coveragePenalty": 2.5,
        "consistencyBonus": 5,
        "avgWithinCategoryStdDev": 12.3,
        "coverage": 92,
        "testedCategories": 11,
        "categoryAverages": {
          "coding": 88.5,
          "reasoning": 85.2,
          "factual": 82.0,
          ...
        }
      }
    ],
    "categoryWeights": {
      "coding": 0.15,
      "reasoning": 0.15,
      ...
    }
  }
}
```

### Dashboard Integration

The Model Dashboard uses generalist scores for composite calculation:

```
GET /api/benchmark/dashboard
```

Response includes:
```json
{
  "model_stats": [
    {
      "model": "gpt-4",
      "avg_quality": "8.3",        // Generalist score (0-10 scale)
      "raw_quality": "8.5",        // Raw average (for reference)
      "generalist_breakdown": {
        "coverage": 92,
        "coveragePenalty": 0.8,
        "consistencyBonus": 5,
        "avgWithinCategoryStdDev": 12.3,
        "testedCategories": 11
      },
      "interactive_score": "7.8",  // Composite using generalist quality
      "reasoning_score": "8.1",
      "coding_score": "8.0"
    }
  ]
}
```

---

## Architecture

### File Structure

```
src/services/benchmark/
├── generalistScore.js    # Core calculation (single source of truth)
├── results.js            # Dashboard uses generalistScore
└── index.js              # Exports getGeneralistLeaderboard()

public/js/
└── generalist-leaderboard.js  # Frontend (fetches from API, no calculation)

routes/
└── benchmark.js          # /api/benchmark/generalist-leaderboard endpoint
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    MongoDB (BenchmarkResult)                     │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│              generalistScore.js (Single Source of Truth)         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  calculateAllGeneralistScores()                          │   │
│  │  - Aggregates by model/category                          │   │
│  │  - Calculates $avg and $stdDevPop per category           │   │
│  │  - Applies coverage penalty                               │   │
│  │  - Applies consistency bonus                              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
┌─────────────────────────────┐   ┌─────────────────────────────┐
│      results.js             │   │  /generalist-leaderboard    │
│  getDashboard() uses        │   │  API endpoint               │
│  generalist score for       │   │  Returns leaderboard data   │
│  composite calculation      │   │                             │
└─────────────────────────────┘   └─────────────────────────────┘
              │                                 │
              ▼                                 ▼
┌─────────────────────────────┐   ┌─────────────────────────────┐
│    Model Dashboard UI       │   │  Generalist Leaderboard UI  │
│    /benchmark.html          │   │  /generalist.html           │
└─────────────────────────────┘   └─────────────────────────────┘
```

---

## Configuration

Constants are defined in `src/services/benchmark/generalistScore.js`:

```javascript
// Category weights (must sum to 1.0)
const GENERALIST_CATEGORY_WEIGHTS = {
    'coding': 0.15,
    'reasoning': 0.15,
    // ... see full list above
};

// Coverage penalty
const COVERAGE_PENALTY_MAX = 20;

// Consistency bonus
const CONSISTENCY_STDDEV_THRESHOLD = 15;  // stddev on 0-100 scale
const CONSISTENCY_BONUS = 5;
```

---

## Rationale

### Why Coverage Penalty?

Without it, a model could:
1. Run only easy tests in one category
2. Score 95/100 on those easy tests
3. Rank #1 despite being untested on most capabilities

The penalty ensures models must demonstrate **breadth** of capability.

### Why Within-Category Consistency?

Cross-category consistency (old approach) rewarded "mediocre everywhere" over "excellent but uneven."

Within-category consistency rewards **reliability**:
- A model that scores 8/10 consistently on coding is more useful than one that swings 3-10
- Users can trust reliable models for production use
- Unpredictable models are a deployment risk

### Why Normalize by Covered Weight?

Without normalization:
- Model A tests 12 categories, scores 80 average = weighted sum ~80
- Model B tests 3 categories, scores 80 average = weighted sum ~30

This unfairly punishes Model B. By dividing by covered weight, both would score ~80 before coverage penalty.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-01-27 | Initial implementation with within-category consistency |
| 2026-01-27 | Consolidated frontend/backend to single source of truth |
| 2026-01-27 | Added infrastructure failure exemption for coverage |
