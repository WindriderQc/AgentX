# Feature Alignment Action Report

## 1. Executive Summary

- **Total Features:** 298
- **Complete Features:** 297
- **Truly Headless Features:** 32
- **API-Only Features:** 1
- **Orphan Endpoints:** 1

## 2. High-Priority Headless Features (Top 10)

_Features that need UI development, excluding API-only endpoints_

### dashboards (Score: 80/100)

**Status:** headless-documented
**Priority:** CRITICAL (critical)

**Endpoints (9):**
- GET /api/dashboards/ (`dashboards.js`) [Conf: 50%]
- POST /api/dashboards/ (`dashboards.js`) [Conf: 50%]
- GET /api/dashboards/:id (`dashboards.js`) [Conf: 50%]
- PATCH /api/dashboards/:id (`dashboards.js`) [Conf: 50%]
- POST /api/dashboards/:id/panels (`dashboards.js`) [Conf: 45%]
- PATCH /api/dashboards/:id/panels/:panelId (`dashboards.js`) [Conf: 45%]
- DELETE /api/dashboards/:id/panels/:panelId (`dashboards.js`) [Conf: 45%]
- DELETE /api/dashboards/:id (`dashboards.js`) [Conf: 50%]
- POST /api/dashboards/:id/refresh (`dashboards.js`) [Conf: 45%]

**Score Breakdown:**
- n8n Workflow Usage: ➖ (0)
- Endpoint Count: 40 pts
- Documentation: 15 pts
- Security/Admin: 15 pts
- Recent Activity: 10 pts

**Why Build UI:** Critical feature with 9 endpoints and strong documentation. High priority for user accessibility.

**Suggested UI location:** /public/dashboards.html

---

### dataset (Score: 80/100)

**Status:** headless-documented
**Priority:** CRITICAL (critical)

**Endpoints (4):**
- GET /api/dataset/conversations (`dataset.js`) [Conf: 80%]
<<<<<<< ours
- POST /api/dataset/prompts (`dataset.js`) [Conf: 55%]
- GET /api/dataset/prompts (`dataset.js`) [Conf: 55%]
- PATCH /api/dataset/prompts/:id/activate (`dataset.js`) [Conf: 55%]
=======
- POST /api/dataset/prompts (`dataset.js`) [Conf: 60%]
- GET /api/dataset/prompts (`dataset.js`) [Conf: 60%]
- PATCH /api/dataset/prompts/:id/activate (`dataset.js`) [Conf: 60%]
>>>>>>> theirs

**Score Breakdown:**
- n8n Workflow Usage: ➖ (0)
- Endpoint Count: 40 pts
- Documentation: 15 pts
- Security/Admin: 10 pts
- Recent Activity: 15 pts

**Why Build UI:** Critical feature with 4 endpoints and strong documentation. High priority for user accessibility.

**Suggested UI location:** /public/dataset.html

---

### invitations (Score: 80/100)

**Status:** headless-documented
**Priority:** CRITICAL (critical)

**Endpoints (6):**
- GET /api/invitations/validate/:token (`invitations.js`) [Conf: 55%]
- POST /api/invitations/accept (`invitations.js`) [Conf: 80%]
<<<<<<< ours
- GET /api/invitations/my-invitations (`invitations.js`) [Conf: 40%]
- POST /api/workspaces/:slug/invitations (`workspaces.js`) [Conf: 42%]
- GET /api/workspaces/:slug/invitations (`workspaces.js`) [Conf: 42%]
- DELETE /api/workspaces/:slug/invitations/:invitationId (`workspaces.js`) [Conf: 42%]
=======
- GET /api/invitations/my-invitations (`invitations.js`) [Conf: 45%]
- POST /api/workspaces/:slug/invitations (`workspaces.js`) [Conf: 45%]
- GET /api/workspaces/:slug/invitations (`workspaces.js`) [Conf: 45%]
- DELETE /api/workspaces/:slug/invitations/:invitationId (`workspaces.js`) [Conf: 45%]
>>>>>>> theirs

**Score Breakdown:**
- n8n Workflow Usage: ➖ (0)
- Endpoint Count: 40 pts
- Documentation: 15 pts
- Security/Admin: 15 pts
- Recent Activity: 10 pts

**Why Build UI:** Critical feature with 6 endpoints and strong documentation. High priority for user accessibility.

**Suggested UI location:** /public/invitations.html

---

### model-registry (Score: 80/100)

**Status:** headless-documented
**Priority:** CRITICAL (critical)

**Endpoints (12):**
- GET /api/models/registry/ (`model-registry.js`) [Conf: 70%]
- GET /api/models/registry/stats (`model-registry.js`) [Conf: 70%]
<<<<<<< ours
- GET /api/models/registry/grouped (`model-registry.js`) [Conf: 37%]
- GET /api/models/registry/category/:category (`model-registry.js`) [Conf: 32%]
- GET /api/models/registry/tag/:tag (`model-registry.js`) [Conf: 32%]
- GET /api/models/registry/:name (`model-registry.js`) [Conf: 47%]
- POST /api/models/registry/ (`model-registry.js`) [Conf: 70%]
- PATCH /api/models/registry/:name (`model-registry.js`) [Conf: 47%]
- DELETE /api/models/registry/:name (`model-registry.js`) [Conf: 47%]
- POST /api/models/registry/:name/sync (`model-registry.js`) [Conf: 47%]
- POST /api/models/registry/:name/categories (`model-registry.js`) [Conf: 37%]
- DELETE /api/models/registry/:name/categories/:category (`model-registry.js`) [Conf: 37%]
=======
- GET /api/models/registry/grouped (`model-registry.js`) [Conf: 40%]
- GET /api/models/registry/category/:category (`model-registry.js`) [Conf: 35%]
- GET /api/models/registry/tag/:tag (`model-registry.js`) [Conf: 35%]
- GET /api/models/registry/:name (`model-registry.js`) [Conf: 50%]
- POST /api/models/registry/ (`model-registry.js`) [Conf: 70%]
- PATCH /api/models/registry/:name (`model-registry.js`) [Conf: 50%]
- DELETE /api/models/registry/:name (`model-registry.js`) [Conf: 50%]
- POST /api/models/registry/:name/sync (`model-registry.js`) [Conf: 50%]
- POST /api/models/registry/:name/categories (`model-registry.js`) [Conf: 40%]
- DELETE /api/models/registry/:name/categories/:category (`model-registry.js`) [Conf: 40%]
>>>>>>> theirs

**Score Breakdown:**
- n8n Workflow Usage: ➖ (0)
- Endpoint Count: 40 pts
- Documentation: 15 pts
- Security/Admin: 10 pts
- Recent Activity: 15 pts

**Why Build UI:** Critical feature with 12 endpoints and strong documentation. High priority for user accessibility.

**Suggested UI location:** /public/model-registry.html

---

### diagnostics (Score: 70/100)

**Status:** headless-documented
**Priority:** CRITICAL (critical)

**Endpoints (12):**
- GET /judge/health (`diagnostics.js`) [Conf: 0%]
- POST /judge/validate/consistency (`diagnostics.js`) [Conf: 0%]
- POST /judge/validate/ground-truth (`diagnostics.js`) [Conf: 0%]
- GET /judge/validate/bias (`diagnostics.js`) [Conf: 0%]
- GET /judge/validate/calibration (`diagnostics.js`) [Conf: 0%]
- GET /judge/validate/failures (`diagnostics.js`) [Conf: 0%]
- GET /judge/ground-truth (`diagnostics.js`) [Conf: 0%]
- POST /judge/ground-truth (`diagnostics.js`) [Conf: 0%]
- GET /judge/ground-truth/summary (`diagnostics.js`) [Conf: 0%]
- GET /judge/ground-truth/problematic (`diagnostics.js`) [Conf: 0%]
- PATCH /judge/ground-truth/:id (`diagnostics.js`) [Conf: 0%]
- DELETE /judge/ground-truth/:id (`diagnostics.js`) [Conf: 0%]

**Score Breakdown:**
- n8n Workflow Usage: ➖ (0)
- Endpoint Count: 40 pts
- Documentation: 15 pts
- Security/Admin: 0 pts
- Recent Activity: 15 pts

**Why Build UI:** Critical feature with 12 endpoints and strong documentation. High priority for user accessibility.

**Suggested UI location:** /public/diagnostics.html

---

### notification-channels (Score: 60/100)

**Status:** headless-documented
**Priority:** HIGH (high)

**Endpoints (3):**
- GET /api/alerts/notifications/status (`alerts.js`) [Conf: 25%]
- POST /api/alerts/notifications/test (`alerts.js`) [Conf: 25%]
- POST /api/alerts/notifications/verify (`alerts.js`) [Conf: 25%]

**Score Breakdown:**
- n8n Workflow Usage: ➖ (0)
- Endpoint Count: 30 pts
- Documentation: 15 pts
- Security/Admin: 0 pts
- Recent Activity: 15 pts

**Why Build UI:** High-value feature that would benefit from user-friendly interface for non-technical users.

**Suggested UI location:** /public/notification-channels.html

---

### voice (Score: 60/100)

**Status:** headless-documented
**Priority:** HIGH (high)

**Endpoints (4):**
- GET /api/voice/health (`voice.js`) [Conf: 60%]
- POST /api/voice/transcribe (`voice.js`) [Conf: 60%]
- POST /api/voice/synthesize (`voice.js`) [Conf: 60%]
- POST /api/voice/chat (`voice.js`) [Conf: 60%]

**Score Breakdown:**
- n8n Workflow Usage: ➖ (0)
- Endpoint Count: 40 pts
- Documentation: 15 pts
- Security/Admin: 0 pts
- Recent Activity: 5 pts

**Why Build UI:** High-value feature that would benefit from user-friendly interface for non-technical users.

**Suggested UI location:** /public/voice.html

---

### workflowgenerator (Score: 60/100)

**Status:** headless-documented
**Priority:** HIGH (high)

**Endpoints (4):**
- POST /api/workflow/generate (`workflowGenerator.js`) [Conf: 35%]
- POST /api/workflow/validate (`workflowGenerator.js`) [Conf: 35%]
- POST /api/workflow/deploy (`workflowGenerator.js`) [Conf: 35%]
- GET /api/workflow/examples (`workflowGenerator.js`) [Conf: 35%]

**Score Breakdown:**
- n8n Workflow Usage: ➖ (0)
- Endpoint Count: 40 pts
- Documentation: 15 pts
- Security/Admin: 0 pts
- Recent Activity: 5 pts

**Why Build UI:** High-value feature that would benefit from user-friendly interface for non-technical users.

**Suggested UI location:** /public/workflowgenerator.html

---

### deployment (Score: 55/100)

**Status:** headless-documented
**Priority:** HIGH (high)

**Endpoints (0):**
- (No exact endpoint hits, matched via service/model files)

**Score Breakdown:**
- n8n Workflow Usage: ✅ (+30)
- Endpoint Count: 0 pts
- Documentation: 15 pts
- Security/Admin: 0 pts
- Recent Activity: 10 pts

**Why Build UI:** High-value feature that would benefit from user-friendly interface for non-technical users.

**Suggested UI location:** /public/deployment.html

---

### 01-architecture (Score: 45/100)

**Status:** headless-documented
**Priority:** MEDIUM (medium)

**Endpoints (0):**
- (No exact endpoint hits, matched via service/model files)

**Score Breakdown:**
- n8n Workflow Usage: ➖ (0)
- Endpoint Count: 0 pts
- Documentation: 15 pts
- Security/Admin: 15 pts
- Recent Activity: 15 pts

**Why Build UI:** Moderate priority. Consider if users frequently request this functionality.

**Suggested UI location:** /public/01-architecture.html

---

## 3. API-Only Features

_Features designed for programmatic access only (n8n workflows, backend integrations)_

### model-routing

**Endpoints (3):**
- GET /api/models/routing
- GET /routing
- POST /routing/active-host

**Why API-Only:** Programmatic integration endpoint

## 4. Orphan Endpoints Analysis

### False Positives (Scanner Missed Usage)

_None_

### API-Only Endpoints

_None_

### Needs Review

| Status | Method | Path | Source File | Confidence | Action |
|--------|--------|------|-------------|------------|--------|
| ⚠️ Verify | POST | /api/dashboard/scans/:id/stop | `dashboard.js` | 0% | Review code for actual usage |

