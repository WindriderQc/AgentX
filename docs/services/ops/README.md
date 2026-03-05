# Self-Healing & Repo Ops Service

**Agent:** OpsAgent
**Status:** Active

## Responsibility
Automated remediation (5 strategies: failover, rollback, restart, throttle, alert-only), repository quality scanning, documentation janitor, feature alignment scanning, validation scanning, confidence scoring, feature flags and usage tracking.

## File Inventory

### Services (src/services/)
| File | Lines | Purpose |
|------|-------|---------|
| selfHealingEngine.js | 1,016 | Automated remediation with 5 action strategies |
| repoWatcherService.js | 821 | Repository quality scanning and drift detection |
| docJanitorService.js | 323 | Documentation cleanup and maintenance |
| featureAlignmentScanner.js | 767 | Feature alignment and implementation verification |
| validationScanner.js | 521 | Validation and schema checking |
| scannerConfidence.js | - | Confidence scoring for scanner results |
| featureAlignmentPriority.js | 295 | Feature priority and alignment tracking |

### Routes (routes/)
| File | Lines | Purpose |
|------|-------|---------|
| self-healing.js | - | Self-healing rules and remediation |
| repoWatcher.js | - | Repository quality scanning |
| docJanitor.js | - | Documentation cleanup |
| features.js | 895 | Feature flag management and telemetry |

### Models (models/)
| File | Lines | Purpose |
|------|-------|---------|
| RepoScan.js | 173 | Repository scan results with trend analysis |
| DocJanitorScan.js | 67 | Doc janitor scan results |
| RemediationAction.js | 16 | Self-healing remediation actions |
| FeatureInventory.js | 138 | Feature tracking and inventory |
| FeatureFlag.js | 88 | Feature flags for A/B testing |
| FeatureUsage.js | 86 | Feature usage analytics |

### Config
- config/self-healing-rules.json — Remediation rules with cooldowns

### Frontend
- self-healing-dashboard.js (41K), feature-alignment.js (24K), features-admin.js, features-adoption.js, features-telemetry.js

## APIs Exposed
- `GET/POST /api/self-healing/*` — Rules and remediation
- `GET/POST /api/repowatcher/*` — Repo scanning
- `GET/POST /api/docjanitor/*` — Doc cleanup
- `GET/POST /api/features/*` — Feature flags and telemetry

## Dependencies (Consumed)
| Service | Interface | What |
|---------|-----------|------|
| Alerting | `alertService.createAlert()` | Alert on remediation events |
| Model Management | `modelRouter` | Model failover actions |
| Prompt & Config | `PromptConfig` | Prompt rollback actions |

## Data Ownership
Exclusive write: RepoScan, DocJanitorScan, RemediationAction, FeatureInventory, FeatureFlag, FeatureUsage.

## Key Patterns
- 5 remediation strategies: model failover, prompt rollback, service restart, request throttling, alert-only
- Cooldown enforcement prevents remediation storms
- Approval workflows for critical actions
- docJanitorService imports repoWatcherService (tightly coupled)
- Scanner-pattern services share common detection algorithms
