# Dimension Architecture: Judge Scoring System

**Status:** Production
**Last Updated:** 2025-01-26

---

## Overview

The quality scoring system uses an LLM judge (qwen2.5:7b) to evaluate model responses. Each response is scored on **exactly 4 dimensions** specific to its task category.

### Why 4 Dimensions?

**Empirical finding:** The judge model (qwen2.5:7b-instruct-q4_0) fails to produce valid JSON when asked to score 8+ fields. With 4 fields, JSON parse success rate is ~95%+. With 8-10 fields, success rate was 0%.

This is not speculation — it's a constraint of the current judge model.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      BENCHMARK PROMPT                            │
│                  scoring_type: "code"                            │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│           ENHANCED_SCORING_CONFIGS["code"]                       │
│                                                                  │
│  core_dimensions: [                                              │
│    { name: "correctness", weight: 0.35 },                        │
│    { name: "clarity",     weight: 0.25 },                        │
│    { name: "efficiency",  weight: 0.20 },                        │
│    { name: "robustness",  weight: 0.20 }                         │
│  ]                                                               │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                    JUDGE MODEL PROMPT                            │
│                                                                  │
│  "Score this response on 4 criteria:                             │
│   1. correctness (0-10)                                          │
│   2. clarity (0-10)                                              │
│   3. efficiency (0-10)                                           │
│   4. robustness (0-10)                                           │
│                                                                  │
│   Return JSON: {correctness: X, clarity: X, ...}"                │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                    JUDGE RESPONSE                                │
│                                                                  │
│  { "correctness": 8, "clarity": 7, "efficiency": 6,              │
│    "robustness": 9, "overall": 7.5, "explanation": "..." }       │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                 WEIGHTED SCORE CALCULATION                       │
│                                                                  │
│  quality_score = (8 × 0.35) + (7 × 0.25) +                       │
│                  (6 × 0.20) + (9 × 0.20) = 7.55                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## The 16 Categories

Each category has **exactly 4 core dimensions** with weights summing to 1.0.

| Category | Dimension 1 | Dimension 2 | Dimension 3 | Dimension 4 |
|----------|-------------|-------------|-------------|-------------|
| **code** | correctness (0.35) | clarity (0.25) | efficiency (0.20) | robustness (0.20) |
| **reasoning** | accuracy (0.30) | logic_soundness (0.30) | clarity (0.20) | completeness (0.20) |
| **factual** | accuracy (0.40) | completeness (0.30) | clarity (0.20) | objectivity (0.10) |
| **math** | answer_correctness (0.40) | method (0.35) | rigor (0.15) | clarity (0.10) |
| **creative** | originality (0.35) | coherence (0.30) | engagement (0.20) | relevance (0.15) |
| **general** | helpfulness (0.35) | relevance (0.25) | clarity (0.25) | accuracy (0.15) |
| **instruction-following** | instruction_adherence (0.35) | constraint_compliance (0.35) | format_accuracy (0.20) | completeness (0.10) |
| **summarization** | accuracy (0.35) | conciseness (0.30) | completeness (0.20) | coherence (0.15) |
| **translation** | accuracy (0.35) | fluency (0.30) | grammar (0.20) | cultural_fit (0.15) |
| **multi-turn-reasoning** | context_retention (0.35) | logical_progression (0.30) | accuracy (0.25) | coherence (0.10) |
| **context-retention** | recall_accuracy (0.40) | relevance_filtering (0.30) | consistency (0.20) | no_hallucination (0.10) |
| **edge-cases** | error_handling (0.35) | robustness (0.30) | validation (0.20) | recovery (0.15) |
| **refactoring** | readability_improvement (0.35) | logic_preservation (0.35) | simplicity (0.20) | correctness (0.10) |
| **debugging** | root_cause (0.40) | fix_correctness (0.35) | minimal_intervention (0.15) | explanation (0.10) |
| **explanation** | clarity (0.35) | accuracy (0.35) | structure (0.20) | completeness (0.10) |
| **dialogue** | relevance (0.30) | naturalness (0.25) | helpfulness (0.25) | engagement (0.20) |

**Total: 16 categories × 4 dimensions = 64 core dimensions**

---

## Implementation

**Source file:** `src/services/qualityScorer.js`

### Key Functions

1. **`getScoringDimensions(prompt)`** — Looks up dimensions for prompt's `scoring_type`
2. **`buildDynamicJudgePrompt(dimensions, task, expected, response)`** — Builds judge prompt
3. **`callJudge(evalPrompt)`** — Calls judge model, parses JSON response
4. **`scoreResponse({response, prompt})`** — Main entry point for scoring

### Weight Validation

At module load, `validateWeights()` ensures all categories have weights summing to 1.0. The module will throw an error if weights are misconfigured.

---

## Composite Scoring

After quality scoring, results are combined with performance metrics:

```javascript
composite_score = (quality × W_quality) + (latency × W_latency) + (speed × W_speed)
```

Each category has its own composite profile (see `CATEGORY_COMPOSITE_PROFILES` in qualityScorer.js).

---

## FAQ

**Q: Why not more dimensions?**
A: The judge model (qwen2.5:7b) fails to produce valid JSON with 8+ fields. 4 fields = ~95% success rate.

**Q: Can we add a 5th dimension to a category?**
A: Yes, if testing shows the judge handles it reliably. Currently locked at 4 for consistency.

**Q: What if the judge fails?**
A: Score defaults to 0. Failures are logged and counted (`judgeFailureCount`).

**Q: How do I add a new category?**
A: Add entry to `ENHANCED_SCORING_CONFIGS` with exactly 4 `core_dimensions` summing to weight 1.0. Add matching entry to `CATEGORY_COMPOSITE_PROFILES`.

---

## Validation

```bash
# Verify module loads and weights validate
node -e "require('./src/services/qualityScorer.js'); console.log('OK')"

# Run unit tests
npm test -- tests/unit/qualityScorer.test.js
```

---

**This is the authoritative source for dimension architecture. Other docs referencing dimensions should link here.**
