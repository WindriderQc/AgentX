# Prompt & Config Service

**Agent:** PromptAgent
**Status:** Active

## Responsibility
System prompt management, A/B testing with traffic-weighted selection, prompt templates, configuration variants, data import/export, backup/recovery, cache management, DataAPI proxy.

## File Inventory

### Services (src/services/)
| File | Lines | Purpose |
|------|-------|---------|
| cacheService.js | 407 | Distributed cache management (Redis) |
| dataapiClient.js | - | DataAPI proxy integration |

### Helpers (src/helpers/)
- promptAnalysis.js — Prompt analysis utilities

### Routes (routes/)
| File | Lines | Purpose |
|------|-------|---------|
| prompts.js | 572 | Prompt template versioning and A/B testing |
| prompt-templates.js | - | Template library |
| configVariant.js | - | Configuration variant management |
| dataset.js | - | Dataset management |
| export.js | - | Data export |
| gallery.js | - | Result gallery |
| backup.js | 663 | Backup and recovery operations |
| cache.js | - | Cache management endpoints |

### Models (models/)
| File | Lines | Purpose |
|------|-------|---------|
| PromptConfig.js | 171 | Versioned system prompts with A/B testing |
| PromptTemplate.js | 271 | Prompt template library |
| ConfigVariant.js | 69 | Configuration variants |

### Frontend
- prompts.js (37K), config-optimizer.js (32K), backup.js, storage-tool.js

## APIs Exposed
- `GET/POST/PUT/DELETE /api/prompts/*` — Prompt management
- `GET/POST/PUT/DELETE /api/prompt-templates/*` — Template CRUD
- `GET/POST /api/config-variants/*` — Config variant management
- `GET/POST /api/dataset/*` — Dataset management
- `GET /api/export/*` — Data export
- `GET/POST /api/backup/*` — Backup/restore
- `GET/POST /api/cache/*` — Cache management
- `GET /api/gallery/*` — Gallery

### Internal API
```javascript
// A/B testing prompt selection
const config = await PromptConfig.getActivePrompt('default_chat');
// Returns: { systemPrompt, version, trafficWeight }
```

## Dependencies (Consumed)
| Service | Interface | What |
|---------|-----------|------|
| (leaf) | Conversation model (read-only) | Dataset export, prompt analytics |
| (external) | DataAPI | Proxy client |

## Data Ownership
Exclusive write: PromptConfig, PromptTemplate, ConfigVariant.

## Key Patterns
- A/B testing: random selection proportional to traffic weights
- Snapshot pattern: conversations store prompt version at time of use
- Backup uses filesystem operations (BACKUP_DIR)
- Cache layer wraps Redis with fallback
