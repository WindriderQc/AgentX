# Model Management Service

**Agent:** ModelAgent
**Status:** Active

## Responsibility
Everything related to LLM model routing, aggregation, registration, custom models, hardware profiling, Ollama host management, VRAM monitoring, and n8n LLM gateway integration.

## File Inventory

### Services (src/services/)
| File | Lines | Purpose |
|------|-------|---------|
| modelRouter.js | 579 | Smart routing between multiple Ollama hosts with failover |
| modelAggregator.js | 448 | Model metadata aggregation across sources |
| customModelService.js | 475 | Custom model registration and deployment |
| hardwareProfileService.js | 341 | Hardware capability detection (GPU, VRAM) |
| n8nLLMProvider.js | - | n8n LLM provider integration |
| ollamaVramService.js | - | VRAM monitoring per Ollama host |

### Routes (routes/)
| File | Lines | Purpose |
|------|-------|---------|
| models-unified.js | 554 | Unified model management interface |
| custom-models.js | - | Custom model CRUD and deployment |
| model-registry.js | - | Model registry management |
| ollama-hosts.js | - | Ollama host management |
| ollama-vram.js | - | VRAM monitoring endpoints |

### Models (models/)
| File | Lines | Purpose |
|------|-------|---------|
| ModelRegistry.js | 572 | Single source of truth for model metadata, capabilities, routing |
| CustomModel.js | 349 | Custom model definitions and version tracking |
| HardwareProfile.js | 247 | Hardware capability profiles |
| N8nLLMSource.js | 286 | n8n LLM provider configurations |
| ModelPricingConfig.js | 165 | Model pricing metadata |

### Config
- config/categories.js — Task category definitions

### Frontend (public/js/)
- models.js, models-unified.js, models-management.js, models-comparison.js
- model-explorer.js, model-categorization.js, hardware-matrix.js

## APIs Exposed
- `GET /api/models` — List all available models
- `GET /api/models/capabilities` — Model capabilities
- `GET /api/models/categories` — Model categories
- `GET/POST/PUT/DELETE /api/custom-models/*` — Custom model lifecycle
- `GET/POST /api/models/registry/*` — Registry management
- `GET/POST /api/ollama-hosts/*` — Host management
- `GET /api/ollama-vram/*` — VRAM status

### Internal API (consumed by other services)
```javascript
const { getModelRouter } = require('./src/services/modelRouter');
const router = getModelRouter();

router.routeRequest(model, messages, options)  // Route inference request
router.getTargetForModel(model)                // Get host for model
router.getRoutingStatus()                      // Health status
router.getFailoverStatus()                     // Failover state
router.HOSTS                                   // Available hosts
```

## Dependencies (Consumed)
| Service | Interface | What |
|---------|-----------|------|
| (none — leaf service) | Ollama HTTP API | Direct model inference |
| (none — leaf service) | n8n API | n8n-proxied model calls |

## Data Ownership
Exclusive write access to: ModelRegistry, CustomModel, HardwareProfile, N8nLLMSource, ModelPricingConfig.

## Key Patterns
- Singleton: `getModelRouter()` — shared routing instance
- Persistent failover state with auto-recovery
- 1s health check cache TTL
- 6s latency slow threshold
