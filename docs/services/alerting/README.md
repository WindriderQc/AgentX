# Alerting & Notifications Service

**Agent:** AlertAgent
**Status:** Active

## Responsibility
Alert rule evaluation, alert lifecycle management (create/acknowledge/resolve), notification delivery across multiple channels (email, Slack, webhook), security event logging.

## File Inventory

### Services (src/services/)
| File | Lines | Purpose |
|------|-------|---------|
| alertService.js | 358 | Core alert management and delivery |
| notificationService.js | 678 | Multi-channel notification routing with retry |
| emailService.js | - | Email notification delivery |
| securityLogger.js | - | Security event logging |

### Routes (routes/)
| File | Lines | Purpose |
|------|-------|---------|
| alerts.js | 1,129 | Alert management endpoints |

### Models (models/)
| File | Lines | Purpose |
|------|-------|---------|
| Alert.js | 365 | Alert persistence with delivery status tracking |

### Frontend
- alerts-dashboard.js (42K), alert-analytics.js (32K)

## APIs Exposed
- `GET /api/alerts` — List alerts
- `POST /api/alerts` — Create alert
- `PUT /api/alerts/:id` — Update alert
- `DELETE /api/alerts/:id` — Delete alert
- `POST /api/alerts/evaluate` — Evaluate alert rules
- `POST /api/alerts/test-notification` — Test notification channel

### Internal API
```javascript
const { getAlertService } = require('./src/services/alertService');
const alerts = getAlertService();

alerts.createAlert(data)         // Create and persist alert
alerts.evaluateRules()           // Run rule evaluation

const { getNotificationService } = require('./src/services/notificationService');
const notifier = getNotificationService();

notifier.send(channel, payload)  // Send notification
```

## Dependencies (Consumed)
| Service | Interface | What |
|---------|-----------|------|
| (none — leaf service) | MetricsSnapshot (read-only) | Threshold evaluation |

## Data Ownership
Exclusive write: Alert.

## Key Patterns
- Multi-channel delivery: email, Slack, webhook, DataAPI
- Retry logic with exponential backoff
- Rule engine for automated event evaluation
- Leaf service — no downstream service dependencies
