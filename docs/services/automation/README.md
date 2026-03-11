# Automation & SpecialX Service

**Full Documentation:** [docs/architecture/SPECIALX.md](../../architecture/SPECIALX.md)

**Agent:** SpecialXAgent
**Status:** Active

## Responsibility
SpecialX task queue management, automation runner with heartbeat/timeout, task type handlers, n8n workflow generation, validation, and deployment.

## File Inventory

### Services (src/services/)
| File | Lines | Purpose |
|------|-------|---------|
| automationRunnerService.js | 466 | Queue-driven automation runner with lease/heartbeat |
| specialxTaskHandlers.js | - | Task type dispatch and execution |

### Utils (src/utils/)
| File | Lines | Purpose |
|------|-------|---------|
| workflowValidator.js | 591 | n8n workflow validation and testing |
| workflowDeployer.js | 471 | n8n workflow deployment |
| n8nWebhook.js | 167 | n8n webhook handling |

### Routes (routes/)
| File | Lines | Purpose |
|------|-------|---------|
| specialx.js | 616 | Automation task execution endpoints |
| workflowGenerator.js | 526 | n8n workflow generation and deployment |
| n8n.js | - | n8n integration endpoints |

### Models (models/)
| File | Lines | Purpose |
|------|-------|---------|
| AutomationTask.js | 164 | SpecialX task queue entries |
| AutomationRun.js | 92 | Run records with metrics |
| SpecialX.js | 156 | SpecialX automation definitions |

### Config
- n8n_workflows/* — n8n workflow JSON definitions

### Frontend
- specialx.js

## APIs Exposed
- `GET/POST /api/specialx/*` — Task queue management
- `POST /api/workflow/generate` — Generate n8n workflow
- `POST /api/workflow/validate` — Validate workflow
- `POST /api/workflow/deploy` — Deploy to n8n
- `POST /api/n8n/webhook` — Receive n8n webhooks

## Dependencies (Consumed)
| Service | Interface | What |
|---------|-----------|------|
| Chat Service | `chatService.handleChatRequest()` | Chat-type automation tasks |
| Model Management | `modelRouter.routeRequest()` | Inference-type tasks |
| Ops Service | `repoWatcherService` | Scan-type tasks |
| (external) | n8n HTTP API | Workflow deployment |

## Data Ownership
Exclusive write: AutomationTask, AutomationRun, SpecialX.

## Key Patterns
- Queue-driven execution: trigger -> lease -> execute -> persist -> mark complete/failed
- Heartbeat refresh with timeout-based dead-letter
- Bounded retries with backoff
- Idempotency support
- Task handlers delegate to other services (Chat, Model, Ops) -- never duplicate their logic
