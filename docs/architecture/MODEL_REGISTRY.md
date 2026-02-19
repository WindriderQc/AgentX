# Model Registry

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Model Registry

> **Context:** Single source of truth for model metadata, execution config, and categorization. Auto-synced from Ollama hosts on startup.

## Overview

**Model:** `/models/ModelRegistry.js` (~640 lines)
**Routes:** `/routes/model-registry.js` (~630 lines, 16 endpoints)
**Sync Service:** `/src/services/modelSync/syncOrchestrator.js` (~270 lines)
**Parameter Detection:** `/src/services/modelSync/parameterDetection.js` (~190 lines)

### How It Works

1. **Auto-Sync on Startup** — The server queries all configured Ollama hosts (`OLLAMA_HOST`, `OLLAMA_HOST_2`, `OLLAMA_HOST_3`) via `/api/tags` and creates/updates registry entries automatically.
2. **Per-Model Execution Defaults** — For each model, `num_ctx` is auto-detected based on model parameter count, quantization, and host VRAM capacity.
3. **User Overrides** — Users can override auto-detected defaults per model. The UI clearly shows which values are auto-detected vs user-set.
4. **Retirement** — Models no longer found on any Ollama host are automatically marked as `retired`.

### Manual Sync

```bash
# Trigger sync via API
curl -X POST http://localhost:3080/api/models/registry/sync-hosts

# Enrich with curated metadata (categories, tags, descriptions)
node scripts/seed-model-registry.js
```

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

## Schema

```javascript
{
  // Identity
  modelName: String,         // unique, from Ollama model name
  displayName: String,       // human-readable
  vendor: String,            // 'meta', 'alibaba', 'deepseek', 'mistral', 'google', etc.
  description: String,
  userNote: String,          // user-added notes

  // Categorization
  categories: [String],      // multi-select from 7-tier system
  tags: [String],            // freeform

  // Source tracking (populated by auto-sync)
  sourceType: String,        // 'ollama' | 'n8n' | 'manual'
  sourceHost: String,        // Ollama host URL where model lives
  ollamaDigest: String,      // for change detection
  lastSeenAt: Date,          // last discovery timestamp
  modelSizeBytes: Number,    // from Ollama /api/tags
  parameterSize: String,     // e.g. "7B", "32B"
  quantization: String,      // e.g. "Q4_K_M", "Q5_K_M"
  family: String,            // e.g. "qwen2", "llama"

  // Per-model execution config
  executionDefaults: {
    num_ctx: Number,         // auto-detected optimal context window
    temperature: Number,
    _source: String,         // 'auto' | 'user' | 'system'
    _reason: String,         // e.g. "32B Q4_K_M on 24576MiB VRAM → 8192 ctx"
    _detectedAt: Date
  },
  executionOverrides: {      // user overrides (separate from defaults)
    num_ctx: Number,
    temperature: Number,
    _overriddenAt: Date
  },

  // Capabilities & stats
  capabilities: { maxContext, supportsThinking, avgLatencyMs, p95LatencyMs },
  benchmarkStats: { avgCompositeScore, bestCategory, worstCategory, totalTests },
  routingRules: { preferredFor, avoidFor, priority },

  // Status
  status: String,            // 'active' | 'deprecated' | 'experimental' | 'retired'
  isActive: Boolean,
  host: String               // deployment host
}
```

### Execution Config Priority

When running benchmarks or tests, the effective `num_ctx` is resolved as:

```
User override (executionOverrides.num_ctx)
  → Auto-detected default (executionDefaults.num_ctx)
    → Batch-level config (DEFAULT_EXECUTION_CONFIG.num_ctx = 8192)
```

### Auto-Detection Logic

`parameterDetection.js` calculates optimal `num_ctx` using:
- Model parameter count (parsed from name or Ollama details)
- Quantization level (determines bytes per parameter)
- Host VRAM (via SSH nvidia-smi when available)
- Fallback lookup table when VRAM is unknown

| Model Size | VRAM Unknown | With VRAM |
|-----------|-------------|-----------|
| ≤3B | 32768 | Calculated to fill 90% VRAM |
| ≤10B | 16384 | Calculated |
| ≤30B | 8192 | Calculated |
| ≤70B | 4096 | Calculated |
| >70B | 2048 | Calculated |

---

## API Endpoints (`/api/models/registry`)

### Query & List

```bash
GET  /api/models/registry                          # List all active models
GET  /api/models/registry/stats                    # Category statistics
GET  /api/models/registry/grouped                  # Models grouped by category
GET  /api/models/registry/category/:category       # Models in category
GET  /api/models/registry/tag/:tag                 # Models with tag
GET  /api/models/registry/:name                    # Specific model details
```

### Sync & Config

```bash
POST   /api/models/registry/sync-hosts             # Sync from all Ollama hosts
GET    /api/models/registry/:name/execution-config  # Effective config with provenance
POST   /api/models/registry/:name/execution-config  # Set user overrides
DELETE /api/models/registry/:name/execution-config  # Clear overrides → revert to auto
```

### CRUD (require auth)

```bash
POST   /api/models/registry                        # Register new model
PATCH  /api/models/registry/:name                  # Update metadata
DELETE /api/models/registry/:name                  # Retire model
POST   /api/models/registry/:name/sync             # Sync benchmark stats
POST   /api/models/registry/:name/categories       # Add category
DELETE /api/models/registry/:name/categories/:cat  # Remove category
```

---

## Related Documentation

- [Model Routing](MODEL_ROUTING.md) - Category-based routing integration
- [Benchmark System](../operations/BENCHMARK_SYSTEM.md) - Per-model config in benchmarks
- [ROADMAP.md](../../ROADMAP.md) - Registry roadmap (phases 2-4)

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
