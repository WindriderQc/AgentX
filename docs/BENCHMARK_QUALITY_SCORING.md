# LLM Benchmark Quality Scoring System

> **Added:** January 2026  
> **Status:** Production Ready  
> **Purpose:** Evaluate LLM responses for quality, not just speed

## Overview

The benchmark system now supports **multi-dimensional model comparison** by scoring response quality alongside performance metrics. This enables fair comparison between models of different sizes - a slower but more accurate model can now be properly valued against a faster but less capable one.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Benchmark Flow                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────┐    ┌──────────┐ │
│  │  Prompt  │───▶│ Model Under  │───▶│   Response    │───▶│  Store   │ │
│  │  (L1-L5) │    │    Test      │    │   Generated   │    │ Metrics  │ │
│  └──────────┘    └──────────────┘    └───────┬───────┘    └──────────┘ │
│                                              │                          │
│                                              ▼                          │
│                         ┌────────────────────────────────────┐          │
│                         │         Quality Scorer             │          │
│                         ├────────────────────────────────────┤          │
│                         │  1. Quick Score (pattern match)    │          │
│                         │  2. LLM-as-Judge (if needed)       │          │
│                         │  3. Composite Score calculation    │          │
│                         └────────────────────────────────────┘          │
│                                              │                          │
│                                              ▼                          │
│                         ┌────────────────────────────────────┐          │
│                         │      MongoDB Storage               │          │
│                         │  - quality_score (0-10)            │          │
│                         │  - quality_breakdown {}            │          │
│                         │  - composite_score (0-10)          │          │
│                         │  - scoring_method                  │          │
│                         └────────────────────────────────────┘          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Scoring Types

Each prompt is categorized by `scoring_type` which determines how it's evaluated:

| Type | Criteria | Use Case |
|------|----------|----------|
| `code` | Correctness (50%), Clarity (30%), Efficiency (20%) | Programming tasks |
| `reasoning` | Accuracy (40%), Logic (40%), Clarity (20%) | Logic puzzles, analysis |
| `factual` | Accuracy (70%), Completeness (20%), Clarity (10%) | Facts, explanations |
| `math` | Answer (60%), Method (30%), Presentation (10%) | Calculations, proofs |
| `creative` | Creativity (40%), Coherence (30%), Relevance (30%) | Writing, brainstorming |

## Composite Score Formula

The composite score balances speed and quality:

```javascript
composite = (quality × 0.5) + (latency_normalized × 0.3) + (speed_normalized × 0.2)
```

Where:
- **Quality Score**: 0-10 from LLM judge
- **Latency Normalized**: `10 - (latency_ms / 3000)`, capped at 0-10
- **Speed Normalized**: `tokens_per_sec / 10`, capped at 0-10

## Files Modified/Created

### New Files

| File | Purpose |
|------|---------|
| `src/services/qualityScorer.js` | Core scoring logic, LLM-as-judge implementation |

### Modified Files

| File | Changes |
|------|---------|
| `data/benchmark-prompts.json` | Added `expected_answer`, `judge_criteria`, `scoring_type` |
| `routes/benchmark.js` | Integrated quality scoring, new endpoints |
| `public/benchmark.html` | Quality charts, sort controls, scoring toggle |

## API Endpoints

### Enhanced Endpoints

#### `GET /api/benchmark/dashboard`

Now accepts `?sort=` query parameter:

| Sort Value | Description |
|------------|-------------|
| `latency` | Fastest response time (default) |
| `speed` | Highest tokens/second |
| `quality` | Best quality score |
| `composite` | Best balanced score |

**Response includes:**
```json
{
  "model_stats": [{
    "model": "qwen2.5:7b",
    "avg_latency": 1250,
    "avg_tokens_per_sec": "45.23",
    "avg_quality": "7.8",
    "avg_composite": "6.9",
    "quality_tests": 12,
    "tests": 18
  }],
  "sorted_by": "composite"
}
```

#### `POST /api/benchmark/batch`

New optional parameter:

```json
{
  "host": "http://192.168.2.99:11434",
  "models": ["qwen2.5:7b", "llama3.2:1b"],
  "levels": [1, 2, 3],
  "quality_scoring": true  // NEW - default: true
}
```

### New Endpoints

#### `GET /api/benchmark/quality-breakdown`

Get detailed quality analysis by category and level.

**Query Parameters:**
- `model` (optional): Filter to specific model

**Response:**
```json
{
  "overall": [{
    "model": "qwen2.5:7b",
    "avg_quality": "7.8",
    "avg_composite": "6.9",
    "avg_latency": 1250,
    "quality_range": { "best": "9.5", "worst": "5.2" },
    "tests": 20
  }],
  "by_category": {
    "qwen2.5:7b": {
      "coding": { "avg_quality": "8.2", "avg_latency": 1500, "tests": 4 },
      "reasoning": { "avg_quality": "7.5", "avg_latency": 1200, "tests": 4 }
    }
  },
  "by_level": {
    "qwen2.5:7b": {
      "level_1": { "avg_quality": "9.0", "avg_latency": 800, "tests": 4 },
      "level_5": { "avg_quality": "6.5", "avg_latency": 2500, "tests": 4 }
    }
  }
}
```

## Prompt Structure

Prompts in `data/benchmark-prompts.json` now include:

```json
{
  "level": 3,
  "category": "reasoning",
  "name": "Logic Puzzle",
  "prompt": "Three boxes contain apples, oranges, and a mix...",
  "expected_tokens": 200,
  "expected_answer": "Pick from the box labeled 'Mixed'. Since all labels are wrong...",
  "judge_criteria": [
    "Picks from Mixed box",
    "Uses fact that all labels are wrong",
    "Derives all three labels correctly",
    "Logic is sound"
  ],
  "scoring_type": "reasoning"
}
```

## Quality Scorer Service

### Configuration

```javascript
// src/services/qualityScorer.js

const JUDGE_CONFIG = {
    model: 'qwen2.5:7b-instruct-q4_0',  // Fast but capable judge
    fallback_model: 'llama3.2:1b',       // Fallback if primary unavailable
    host: HOSTS.primary,                  // Use primary host for judging
    timeout: 30000,                       // 30s timeout for judge calls
    temperature: 0.1                      // Low temp for consistent scoring
};
```

### Quick Scoring

For simple factual answers, pattern matching is used before calling the LLM judge:

```javascript
// These are scored instantly without LLM call:
"What is the capital of France?" → checks for "paris"
"What is 15 + 27?" → checks for "42"
"2, 4, 8, 16, ?" → checks for "32"
```

### LLM-as-Judge Prompts

Each scoring type has a specialized evaluation prompt:

```javascript
// Example: Reasoning evaluation
`You are a reasoning quality evaluator. Analyze the logical reasoning in this response.

CRITERIA TO EVALUATE:
1. Accuracy (0-10): Is the conclusion/answer correct?
2. Logic (0-10): Is the reasoning process sound and valid?
3. Clarity (0-10): Is the explanation clear and understandable?

TASK: {{task}}
EXPECTED: {{expected}}
RESPONSE TO EVALUATE:
{{response}}

Respond ONLY with JSON in this exact format:
{"accuracy": X, "logic": X, "clarity": X, "overall": X, "explanation": "brief reason"}`
```

### Exported Functions

```javascript
const { 
    scoreResponse,           // Score a single response
    calculateCompositeScore, // Calculate weighted composite
    batchScore,              // Score multiple responses
    quickScore,              // Pattern-match quick scoring
    SCORING_CONFIGS,         // Scoring type configurations
    JUDGE_CONFIG             // Judge model configuration
} = require('./src/services/qualityScorer');
```

## Dashboard UI

### New Charts

The benchmark dashboard now displays 4 charts in a 2x2 grid:

1. **Latency Comparison** (blue) - Average response time per model
2. **Tokens per Second** (purple) - Generation speed per model
3. **Quality Score** (green) - Average quality rating (0-10)
4. **Composite Score** (yellow) - Balanced overall score (0-10)

### Leaderboard Sorting

Use the dropdown to re-rank models by different metrics:

| Sort Option | Best For |
|-------------|----------|
| Latency (fastest) | Real-time applications |
| Tokens/sec (fastest) | Throughput optimization |
| Quality (best) | Accuracy-critical tasks |
| Composite (balanced) | General-purpose comparison |

### Quality Scoring Toggle

When running batch tests, you can enable/disable quality scoring:

- ✅ **Enabled**: Each response is evaluated by the judge model (slower but comprehensive)
- ❌ **Disabled**: Only speed metrics are collected (faster batch runs)

## Database Schema

Results are stored in `benchmark_results` collection:

```javascript
{
  _id: ObjectId,
  model: "qwen2.5:7b",
  host: "http://192.168.2.99:11434",
  prompt: "Write a recursive Fibonacci function",
  prompt_level: 3,
  prompt_category: "coding",
  prompt_name: "Fibonacci",
  expected_answer: "A recursive function with base cases...",
  
  // Performance metrics
  latency: 1523,
  tokens: 45,
  tokens_per_sec: "29.55",
  response: "def fib(n):\n  if n <= 1:\n    return n...",
  
  // Quality metrics (NEW)
  quality_score: 8.5,
  quality_breakdown: {
    correctness: 9,
    clarity: 8,
    efficiency: 7,
    overall: 8.5,
    explanation: "Valid recursive implementation with correct base cases"
  },
  quality_explanation: "Valid recursive implementation...",
  scoring_method: "llm_judge",  // or "quick", "skipped"
  scoring_type: "code",
  composite_score: 7.2,
  normalized_scores: {
    quality: 8.5,
    latency: 4.9,
    speed: 2.9
  },
  
  success: true,
  batch_id: "...",
  timestamp: ISODate
}
```

## Usage Examples

### Run a Quality-Scored Batch Test

```bash
curl -X POST http://localhost:3080/api/benchmark/batch \
  -H "Content-Type: application/json" \
  -d '{
    "host": "http://192.168.2.99:11434",
    "models": ["qwen2.5:7b", "llama3.2:1b", "qwen2.5:3b"],
    "levels": [1, 2, 3],
    "quality_scoring": true
  }'
```

### Get Quality-Sorted Leaderboard

```bash
curl "http://localhost:3080/api/benchmark/dashboard?sort=composite"
```

### Analyze Model Strengths

```bash
curl "http://localhost:3080/api/benchmark/quality-breakdown?model=qwen2.5:7b"
```

## Interpreting Results

### Quality Score Ranges

| Score | Interpretation | Color |
|-------|----------------|-------|
| 7-10 | Excellent | 🟢 Green |
| 4-6.9 | Acceptable | 🟡 Yellow |
| 0-3.9 | Poor | 🔴 Red |

### Common Patterns

- **Small models** (1-3B): Fast but lower quality on complex tasks
- **Medium models** (7-14B): Good balance of speed and quality
- **Large models** (32B+): Best quality but slower, may timeout

### What to Look For

1. **Quality vs Level**: Does quality drop significantly at higher levels?
2. **Category Strengths**: Is the model better at coding vs reasoning?
3. **Composite Ranking**: Which model gives the best overall value?

## Troubleshooting

### Quality scores are all null

- Check that the judge model is available on the primary host
- Verify `HOSTS.primary` is correctly configured in `modelRouter.js`
- Check logs for "Judge call failed" errors

### Scoring is too slow

- Disable quality scoring for speed-only benchmarks
- Use lower prompt levels (L1-L2) for quick tests
- The judge model processes each response, adding ~2-5s per test

### Inconsistent quality scores

- Quality scoring has inherent variance (±1 point is normal)
- Run multiple batches and average results for stable rankings
- Consider using a more capable judge model for critical evaluations

## Future Improvements

- [ ] A/B testing for judge prompts
- [ ] Custom judge model selection per category
- [ ] Historical quality trend analysis
- [ ] Export to CSV/Excel for external analysis
- [ ] Confidence intervals for quality scores
- [ ] Model-specific baseline expectations

---

*Documentation generated: January 2026*
