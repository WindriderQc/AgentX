# Model Registry

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Model Registry

> **Context:** Single source of truth for model metadata with multi-dimensional categorization. Enables task-specific benchmarking and intelligent routing.

## Overview

**Model:** `/models/ModelRegistry.js` (590 lines)
**Routes:** `/routes/model-registry.js` (489 lines, 13 endpoints)
**Seeded Data:** 11 pre-configured models

---

## 7-Tier Category System

Models can have **multiple categories** (e.g., qwen2.5-coder is both `coding` and `specialist`):

| Category | Purpose |
|----------|---------|
| `ops` | Operations/glue logic (routing, classification, simple tasks) |
| `coding` | Code generation, refactoring, debugging specialists |
| `reasoning` | Deep thinking, problem-solving, complex analysis |
| `specialist` | Fine-tuned for specific domain (code, embeddings, legal) |
| `generalist` | General-purpose chat and broad task coverage |
| `embedding` | Vector embeddings for RAG ingestion only |
| `judge` | LLM-as-judge quality scoring |

---

## Schema & Capabilities

```javascript
{
  modelName: String (unique, indexed),
  displayName: String,
  vendor: String,  // 'meta', 'alibaba', 'deepseek'
  categories: [String],  // Multi-select: ['coding', 'specialist']
  tags: [String],        // Freeform: ['production', 'fast', 'thinking-model']

  capabilities: {
    maxContext: Number,           // 2048, 8192, 128000
    supportsThinking: Boolean,    // Thinking models
    avgLatencyMs: Number,         // Calibrated average
    p95LatencyMs: Number,         // 95th percentile
    targetUseCase: String         // Description
  },

  benchmarkStats: {
    avgCompositeScore: Number,
    bestCategory: String,         // Where it excels
    worstCategory: String,        // Where it struggles
    totalTests: Number
  }
}
```

---

## Seeded Models (11)

```bash
node scripts/seed-model-registry.js  # Populate registry
```

| Model | Categories | Tags | Use Case |
|-------|-----------|------|----------|
| qwen2.5-coder:7b | coding, specialist | production, fast, code-generation | Code generation, refactoring |
| qwen2.5-coder:14b | coding, specialist, reasoning | production, high-quality | Complex code, architecture |
| deepseek-r1:7b | reasoning, specialist | experimental, thinking-model | Deep reasoning, problem-solving |
| qwen2.5:7b | reasoning, generalist | production, thinking-model | General reasoning |
| qwen2.5-7b-instruct-q4_0 | generalist, ops | production, fast, recommended | Front-door model, routing |
| llama3.3:70b | generalist, reasoning | production, high-quality, slow | High-quality responses |
| smollm2:1.7b | ops, specialist | experimental, ultra-fast | Query classification |
| gemma2:2b | ops, generalist | production, fast | Quick responses |
| nomic-embed-text | embedding | production, rag, embeddings | RAG embeddings |
| mxbai-embed-large | embedding | production, rag, high-quality | High-quality RAG |
| llama3.1:8b | judge, generalist | production, judge, balanced | LLM-as-judge scoring |

---

## API Endpoints (`/api/models/registry`)

### Query & List (13 endpoints total)

```bash
# List all models with filtering
GET /api/models/registry?category=coding&tag=production&vendor=alibaba

# Get category statistics
GET /api/models/registry/stats

# Get models grouped by category
GET /api/models/registry/grouped

# Get models in specific category
GET /api/models/registry/category/coding

# Get models with specific tag
GET /api/models/registry/tag/production

# Get specific model
GET /api/models/registry/:name
```

### CRUD Operations (require auth)

```bash
# Register new model
POST /api/models/registry
{
  "modelName": "new-model:7b",
  "categories": ["generalist"],
  "tags": ["experimental"],
  "capabilities": { "maxContext": 4096 }
}

# Update model
PATCH /api/models/registry/:name

# Retire model (soft delete)
DELETE /api/models/registry/:name?reason=deprecated

# Sync benchmark stats (auto-updates avgCompositeScore, bestCategory)
POST /api/models/registry/:name/sync

# Add/remove categories
POST /api/models/registry/:name/categories
DELETE /api/models/registry/:name/categories/:category
```

---

## Related Documentation

- [Model Routing](MODEL_ROUTING.md) - Category-based routing integration
- [Benchmark System](../operations/BENCHMARK_SYSTEM.md) - Category filtering
- [ROADMAP.md](../../ROADMAP.md) - Model registry roadmap

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
