# Benchmark System

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Benchmark System

> **Context:** Current benchmark architecture after consolidation to a single prompt catalog, 7 benchmark categories, and 5 difficulty levels.

## Overview

AgentX benchmark execution follows the standard service-oriented flow:

`routes/benchmark.js` → `src/services/benchmark/*` → `models/Benchmark*`

The benchmark prompt library now lives in a single source of truth:

- `data/benchmark-prompts.json`
- 84 prompts total
- 7 categories
- 5 levels
- `scoring_type === category` for seeded prompts

## Categories

| Key | Label | Notes |
|-----|-------|-------|
| `coding` | Coding | Code generation, bug fixing, refactors |
| `reasoning` | Reasoning | Multi-step logic and edge-case handling |
| `math` | Math | Numeric correctness and method validity |
| `knowledge` | Knowledge | Factual recall, explanation, grounded answers |
| `instruction` | Instruction | Constraint following, format compliance, summarization-style tasks |
| `creative` | Creative | Writing quality, originality, dialogue-style generation |
| `translation` | Translation | Cross-language fidelity and fluency |

## Levels

| Level | Label | Judge Tier | Prompts per category |
|-------|-------|------------|----------------------|
| 1 | Basic | `basic` | 2 |
| 2 | Intermediate | `standard` | 3 |
| 3 | Advanced | `standard` | 3 |
| 4 | Expert | `advanced` | 3 |
| 5 | Master | `advanced` | 1 |

Distribution: `2 + 3 + 3 + 3 + 1 = 12` prompts per category, `12 × 7 = 84` prompts total.

## Runtime Notes

- Prompt seeding: `src/services/benchmark/init.js`
- Category metadata and leaderboard tabs: `config/categories.js`
- Scoring configs and strategies: `src/services/scoring/scoringConfigs.js`
- Decomposed judging questions: `src/services/decomposedJudgeQuestions.js`
- Prompt coverage audit: `scripts/audit-prompt-coverage.js`

## Filter Values

`GET /api/benchmark/dashboard`

| Parameter | Values |
|-----------|--------|
| `modelCategory` | `ops`, `coding`, `reasoning`, `specialist`, `generalist`, `embedding`, `judge` |
| `promptCategory` | `coding`, `reasoning`, `math`, `knowledge`, `instruction`, `creative`, `translation` |
| `sort` | `latency`, `quality`, `composite` |

## Validation Checklist

- Prompt file contains 84 prompts
- Active prompt categories exactly match the 7 benchmark categories
- Active levels are within `1..5`
- Judge tier policy matches `1=basic`, `2-3=standard`, `4-5=advanced`

## Related Documentation

- [GENERALIST_SCORING_SYSTEM.md](./GENERALIST_SCORING_SYSTEM.md)
- [BENCHMARK_QUALITY_SCORING.md](../testing/BENCHMARK_QUALITY_SCORING.md)
- [Model Registry](../architecture/MODEL_REGISTRY.md)

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
