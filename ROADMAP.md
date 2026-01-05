# AgentX Project Roadmap

**Last Updated:** 2026-01-04

This roadmap tracks the development status and priorities for the AgentX project - a robust, self-healing, and intelligent monitoring and automation stack built on the SBQC architecture.

---

## Overview

AgentX development is organized across **six parallel development tracks**, each focusing on a specific aspect of the system's capabilities. All six tracks are now **COMPLETE** with production-ready implementations.

### Six Development Tracks

1. **Track 1: Alerts & Notifications** - Real-time proactive monitoring and alerting
2. **Track 2: Historical Metrics & Analytics** - Time-series data collection and insights
3. **Track 3: Custom Model Management** - Fine-tuned LLM lifecycle oversight
4. **Track 4: Self-Healing & Automation** - Automated issue detection and remediation
5. **Track 5: Advanced Testing & CI/CD** - Production-quality assurance and deployment
6. **Track 6: Backup & Disaster Recovery** - Data and workflow safeguarding

---

## Current Status: All Tracks Complete ✅

### Track 1: Alerts & Notifications ✅ COMPLETE

**Purpose:** Real-time monitoring with proactive notifications

**Components:**
- `AlertService` (`/src/services/alertService.js`) - Core alert management and delivery
- `Alert` model (`/models/Alert.js`) - Alert persistence with delivery status tracking
- Alert management API (`/routes/alerts.js`) - CRUD and evaluation endpoints
- N4.1 Alert Dispatcher workflow - Multi-channel notification delivery
- Rule engine for automated event evaluation
- Multi-channel support (email, Slack, webhook, DataAPI)

**Status:** Production-ready with full integration testing

---

### Track 2: Historical Metrics & Analytics ✅ COMPLETE

**Purpose:** Time-series metrics collection and trend analysis

**Components:**
- `MetricsSnapshot` model (`/models/MetricsSnapshot.js`) - Event-based metrics storage
- `MetricsHourly` model (`/models/MetricsHourly.js`) - Time-series aggregation
- N4.2 Metrics Aggregation workflow - Automated hourly rollups
- Analytics dashboards with Chart.js visualizations
- Cost tracking with per-token pricing (V5)
- Performance monitoring with Artillery load test integration

**Features:**
- Real-time request tracking middleware
- Hourly aggregation with percentile calculations (p50, p95, p99)
- Cost efficiency analysis (cost per conversation, cost per 1K tokens)
- Performance regression detection with baseline comparison

**Status:** Production-ready with comprehensive dashboards

---

### Track 3: Custom Model Management ✅ COMPLETE

**Purpose:** Fine-tuned model lifecycle management with A/B testing

**Components:**
- `CustomModel` schema (`/models/CustomModel.js` - 367 lines) - Version tracking and stats
- `customModelService` (`/src/services/customModelService.js` - 482 lines) - Full lifecycle management
- 14 API endpoints (`/routes/custom-models.js` - 455 lines) - CRUD, deployment, stats
- Models Dashboard UI (`/public/models.html`) - Registration, deployment, monitoring
- Ollama deployment integration via API
- Modelfile validation with hash tracking

**Features:**
- A/B testing with traffic-weighted selection
- Version history and rollback functionality
- Performance tracking (inferences, response time, tokens/sec, positive rate)
- Advanced tuning parameters (num_ctx, num_gpu, temperature, etc.)

**Status:** Production-ready with full UI and testing

---

### Track 4: Self-Healing & Automation ✅ COMPLETE

**Purpose:** Automated detection and remediation of operational issues

**Components:**
- Self-healing engine (`/src/services/selfHealingEngine.js` - 883 lines)
- 12 self-healing rules (`/config/self-healing-rules.json` - 363 lines)
- N4.4 Self-Healing Orchestrator workflow
- Persistent failover state tracking in ModelRouter

**Five Remediation Strategies:**
1. **Model Failover** - Switch to backup Ollama host with health verification
2. **Prompt Rollback** - Revert to previous prompt version on quality degradation
3. **Service Restart** - PM2 graceful reload with approval workflow
4. **Request Throttling** - Dynamic rate limit adjustment with auto-restoration
5. **Alert-Only** - Multi-channel notifications without remediation

**Features:**
- Cooldown enforcement to prevent thrashing
- Approval workflow for critical actions
- Execution history tracking
- Integration with ModelRouter for persistent failover state
- Rule enable/disable via API

**Status:** Production-ready with comprehensive integration tests

**Documentation:** `/docs/planning/TRACK_4_COMPLETION_SUMMARY.md` (450 lines)

---

### Track 5: Advanced Testing & CI/CD ✅ COMPLETE

**Purpose:** Production-quality assurance and deployment automation

**Components:**
- CI/CD pipeline (GitHub Actions)
- Jest unit/integration tests (19 test files, ~3,600 lines)
- E2E test suite (`./test-all.sh`)
- Load testing with Artillery integration
- Performance benchmarking dashboard
- Regression detection with baseline comparison

**Performance Monitoring:**
- 3 MongoDB schemas: `PerformanceLoadTest`, `PerformanceBaseline`, `PerformanceSnapshot`
- 8 API endpoints (`/routes/performance.js` - 641 lines)
- Artillery JSON parser service (`/src/services/artilleryParser.js` - 313 lines)
- Full frontend dashboard (`/public/performance.html` - 2,480 lines)
- 5 Chart.js visualizations (latency trends, percentiles, throughput, etc.)
- Request tracking middleware (`/src/middleware/performanceTracker.js` - 297 lines)

**Automation Scripts:**
- `import-artillery-results.sh` - Run load test → auto-import
- `create-performance-baseline.sh` - Capture current metrics as baseline
- `check-performance-regression.sh` - CI/CD regression check (exit codes)

**N8n Workflow:**
- N3.3-Performance-Monitor - Automated 6-hour testing

**Status:** Production-ready with 37 passing Artillery parser tests

**Documentation:** `/docs/features/PERFORMANCE_MONITORING.md` (1,098 lines)

---

### Track 6: Backup & Disaster Recovery ✅ COMPLETE

**Purpose:** Data protection and disaster recovery capabilities

**Components:**
- Backup scripts (`/home/yb/codes/DataAPI/scripts/`)
  - `backup-mongodb.sh` - MongoDB dumps with compression and retention
  - `backup-qdrant.sh` - Vector store snapshots via Qdrant API
  - `restore-mongodb.sh` - MongoDB restoration from archives
  - `restore-qdrant.sh` - Vector store restoration from snapshots
  - `setup-backup-cron.sh` - Automated daily scheduling (2 AM)
- Backup management dashboard (`/public/backup.html`)
- API routes (`/routes/backup.js` - 489 lines) - 15 endpoints
- Workflow version control (Git integration for AgentC)
- Backup directory: `/home/yb/backups/{mongodb,qdrant}/`

**Features:**
- ✅ MongoDB backup/restore interface with API
- ✅ Qdrant snapshot management (23MB snapshots working)
- ✅ Workflow version control with Git history
- ✅ Cron automation setup/removal via UI
- ✅ Backup list/delete functionality
- ✅ Navigation integration in main UI
- ✅ **Fixed:** Backup directory permissions (moved from `/mnt/backups` to `/home/yb/backups`)
- ✅ **Fixed:** Backup routes now pass directory paths to shell scripts

**Verified Backups:**
- MongoDB: `agentx_20260104_231529.tar.gz` (1.2MB) ✓
- Qdrant: `agentx_embeddings_20260104_232946.snapshot` (23MB) ✓

**Status:** Production-ready with verified working backups

---

## Immediate Priorities

### 1. Documentation Normalization ✅ IN PROGRESS

**Goal:** Consolidate scattered documentation into canonical references

**Tasks:**
- [x] Merge CONTRIBUTING.md into CLAUDE.md (unified reference)
- [x] Create new ROADMAP.md (this file) with current status
- [ ] Archive old planning docs to `docs/archive/`
- [ ] Update `docs/INDEX.md` to reflect new structure
- [ ] Verify all cross-references are valid

**Outcome:** Single source of truth for project guidance (CLAUDE.md + ROADMAP.md)

---

### 2. Track 6 Wiring Gaps (Backup & DR) ✅ RESOLVED

**Completed Fixes (2026-01-05):**
- [x] **Qdrant backup listing mismatch** - Updated routes to support both `.snapshot` and `.tar.gz` patterns
- [x] **Backup directory permissions** - Moved from `/mnt/backups` (root-only) to `/home/yb/backups` (user-writable)
- [x] **Backup script integration** - Routes now correctly pass directory paths as arguments
- [x] **Verified working backups** - Both MongoDB and Qdrant backups tested and functional
- [x] **Script ownership** - Keeping in DataAPI `/scripts/` (shared between AgentX and DataAPI)

**Status:** All Track 6 wiring complete and tested ✓

---

### 3. Qdrant Vector Database Integration ✅ COMPLETE

**Completed (2026-01-05):**
- [x] **Started Qdrant service** - Running via PM2 (process ID 5, port 6333)
- [x] **Health monitoring** - Added to system health checks in `server.js` and `src/app.js`
- [x] **Backup integration** - Qdrant snapshots working (23MB verified)
- [x] **UI Integration** - Added Qdrant status to n8n Workflow Monitor dashboard
- [x] **Auto-start configuration** - PM2 saved for reboot persistence
- [x] **Environment configuration** - `.env` updated with `VECTOR_STORE_TYPE=qdrant`

**n8n Monitor Enhancements:**
- Direct Qdrant health check at `http://localhost:6333/healthz`
- Auto-updates health percentage when Qdrant status changes
- Visual indicator: "Qdrant Vector DB" component card
- Degrades overall status to "degraded" if Qdrant fails

**Status:** Qdrant fully operational and monitored ✓

---

### 4. Dashboard JavaScript Error Fixes ✅ COMPLETE

**All Critical Fixes (2026-01-05):**
- [x] **Benchmark Dashboard** - Fixed syntax error (extra closing brace) and `ReferenceError: profileKey`
- [x] **Alert Analytics** - Fixed route ordering (`/statistics` before `/:id`) and removed duplicate route
- [x] **Backup Dashboard** - Fixed directory permissions and API endpoints
- [x] **Benchmark Service** - Fixed nested `$cond` MongoDB aggregation syntax

**Status:** All dashboards load without JavaScript errors ✓

**Impact:** Low (functionality works, but inconsistencies exist)

---

### 3. Alerts End-to-End Connection

**Verification Needed:**
- [ ] Confirm N1.1 (Janitor) and N5.1 (Analyst) workflows actively call `/api/alerts`
- [ ] Add smoke test for workflow → AgentX → UI alert creation path
- [ ] Verify Slack/email notification delivery

**Impact:** Medium (alerts work manually, need automated workflow verification)

---

## Backlog / Future Work

### Security Hardening

**Priority:** High for production deployment

**Tasks:**
- [ ] API key scoping and rotation mechanisms
- [ ] Strict Content Security Policy (CSP) implementation
- [ ] Helmet configuration for production (currently disabled for LAN compatibility)
- [ ] Rate limiting review and optimization
- [ ] Audit log implementation for sensitive operations

**Note:** Basic security is in place (rate limiting, NoSQL injection prevention, API key auth)

---

### Advanced Features

**Lower Priority Enhancements:**
- [ ] Streaming response support (SSE) for chat interface
- [ ] Multi-tenant support with user isolation
- [ ] Advanced RAG features (query expansion, re-ranking, hybrid search)
- [ ] Custom dashboard builder for metrics visualization
- [ ] Webhook retry logic with exponential backoff

---

## Scope Notes

This roadmap covers:
- **AgentX** - UI + orchestration + AI services (this repository)
- **DataAPI** - Tool server + data acquisition (sibling repository)
- **AgentC** - n8n automation workflows (`/AgentC/` directory)

For DataAPI-specific planning, see: `../DataAPI/docs/ROADMAP.md` (if exists)

---

## Canonical References

- **Main Documentation Index:** [docs/INDEX.md](docs/INDEX.md)
- **Agent/Human Guidance:** [CLAUDE.md](CLAUDE.md)
- **Stack Documentation Hub:** [docs/SBQC-Stack-Final/](docs/SBQC-Stack-Final/)
- **Multi-Agent Enhancement Plan:** [docs/planning/MULTI_AGENT_ENHANCEMENT_PLAN.md](docs/planning/MULTI_AGENT_ENHANCEMENT_PLAN.md) *(to be archived)*
- **Progression Log:** [docs/planning/PROGRESSION_LOG.md](docs/planning/PROGRESSION_LOG.md) *(to be archived)*

---

**Note:** This roadmap is the single source of truth for project status. Update this file when track statuses change or new priorities emerge.
