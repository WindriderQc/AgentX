# Benchmark System

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Benchmark System

> **Context:** Service-oriented benchmarking with category filtering and quality scoring.

## Key Documentation

| Document | Purpose |
|----------|---------|
| [GENERALIST_SCORING_SYSTEM.md](./GENERALIST_SCORING_SYSTEM.md) | **Quality scoring formula** - coverage penalty, consistency bonus |
| [BENCHMARK_QUALITY_SCORING.md](../testing/BENCHMARK_QUALITY_SCORING.md) | LLM judge configuration and scoring dimensions |

## Architecture

**Service-Oriented Design:**
- Routes: `/routes/benchmark.js` - Thin HTTP layer
- Service: `/src/services/benchmark/` - Modular business logic
  - `index.js` - Main facade
  - `results.js` - Dashboard and statistics
  - `generalistScore.js` - Quality scoring (single source of truth)
  - `judges.js` - Judge leaderboard
  - `execution.js` - Batch execution (with per-model execution config from registry)
  - `batches.js` - Batch management
  - `config.js` - Default execution settings (fallback when no per-model config)
- Model Sync: `/src/services/modelSync/` - Auto-sync and per-model config detection
  - `syncOrchestrator.js` - Discovers models from Ollama hosts, populates registry
  - `parameterDetection.js` - Auto-detects optimal num_ctx per model

**Per-Model Execution Config:**

During benchmark execution, each model gets its own `num_ctx` resolved via priority chain:
```
User override (executionOverrides.num_ctx)
  → Auto-detected default (executionDefaults.num_ctx)
    → Batch-level config (DEFAULT_EXECUTION_CONFIG.num_ctx = 8192)
```
See [Model Registry](../architecture/MODEL_REGISTRY.md#execution-config-priority) for full details.

**Models:**
- `BenchmarkPrompt` - Test prompts with categories
- `BenchmarkResult` - Individual test results
- `BenchmarkBatch` - Batch execution with state transitions

**Features:**
- 10-level prompt library (1=easy, 10=expert)
- Batch testing with async execution
- Quality scoring with LLM judges
- Generalist scoring with coverage/consistency metrics

---

## Category Filtering (Task-Segmented Leaderboards)

Benchmarks support filtering by model category, prompt category, and tags to enable "apples to apples" comparisons.

### Enhanced Dashboard Endpoint

```bash
GET /api/benchmark/dashboard?modelCategory=<category>&promptCategory=<category>&tag=<tag>&sort=<criteria>
```

### Filter Parameters

| Parameter | Purpose | Values |
|-----------|---------|--------|
| `modelCategory` | Filter to models in category | ops, coding, reasoning, specialist, generalist, embedding, judge |
| `promptCategory` | Filter to prompts in category | coding, reasoning, factual, math, creative, general |
| `tag` | Filter to batches with specific tag | production, experimental, etc. |
| `sort` | Sort criteria | latency, quality, composite |

### Examples

```bash
# Get coding models only
curl "http://localhost:3080/api/benchmark/dashboard?modelCategory=coding"

# Get reasoning tasks only
curl "http://localhost:3080/api/benchmark/dashboard?promptCategory=reasoning"

# Get coding models on coding tasks (find best code generator)
curl "http://localhost:3080/api/benchmark/dashboard?modelCategory=coding&promptCategory=coding"

# Get production-tagged batches sorted by quality
curl "http://localhost:3080/api/benchmark/dashboard?tag=production&sort=quality"

# Combined filters
curl "http://localhost:3080/api/benchmark/dashboard?modelCategory=reasoning&promptCategory=reasoning&tag=production&sort=composite"
```

---

## How Category Filtering Works

1. Frontend passes category/tag filters to dashboard endpoint
2. Backend queries ModelRegistry for models matching `modelCategory`
3. BenchmarkResult aggregation filters to matching models and `promptCategory`
4. Tag filter queries BenchmarkBatch for batches with tag, then filters results
5. Returns task-specific leaderboard (e.g., "Best Coding Models" vs "Best Reasoning Models")

**Critical Pattern:** Category filtering enables finding the right model for specific tasks, preventing fast-but-weak models from ranking artificially high on trivial tasks.

---

## Related Documentation

- [GENERALIST_SCORING_SYSTEM.md](./GENERALIST_SCORING_SYSTEM.md) - Quality scoring formula and API
- [BENCHMARK_QUALITY_SCORING.md](../testing/BENCHMARK_QUALITY_SCORING.md) - LLM judge configuration
- [Model Registry](../architecture/MODEL_REGISTRY.md) - Category filtering integration
- [Model Routing](../architecture/MODEL_ROUTING.md) - Task-based routing

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
