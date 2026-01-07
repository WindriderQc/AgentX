# AgentX Project Roadmap

**Last Updated:** 2026-01-06

This roadmap tracks the development status and priorities for the AgentX project - a robust, self-healing, and intelligent monitoring and automation stack built on the SBQC architecture.

---

## Overview

AgentX development is organized across **eight development tracks**, each focusing on a specific aspect of the system's capabilities. Seven tracks are **COMPLETE** with production-ready implementations. Track 8 has completed Phase 1 (Feature Alignment Dashboard) and is now in Phase 2 (UI Development for Headless Features).

### Eight Development Tracks

1. **Track 1: Alerts & Notifications** - Real-time proactive monitoring and alerting ✅
2. **Track 2: Historical Metrics & Analytics** - Time-series data collection and insights ✅
3. **Track 3: Custom Model Management** - Fine-tuned LLM lifecycle oversight ✅
4. **Track 4: Self-Healing & Automation** - Automated issue detection and remediation ✅
5. **Track 5: Advanced Testing & CI/CD** - Production-quality assurance and deployment ✅
6. **Track 6: Backup & Disaster Recovery** - Data and workflow safeguarding ✅
7. **Track 7: Multi-Tenancy & Workspaces** - Team collaboration with data isolation ✅
8. **Track 8: Feature Alignment Dashboard** - Phase 1 complete ✅ | Phase 2 in progress 🔄

---

## Current Status: Track 8 Phase 2 (UI Development) 🔄

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

### Track 7: Multi-Tenancy & Workspaces ✅ COMPLETE

**Purpose:** Team collaboration with complete data isolation and role-based access control

**Week 4 Implementation (2026-01-02 to 2026-01-06):**

**Day 1: Data Models & Architecture**
- `Workspace` model (`/models/Workspace.js`) - Team workspace with settings and features
- `WorkspaceMember` model (`/models/WorkspaceMember.js`) - RBAC with 4 tiers (Owner/Admin/Member/Viewer)
- Schema design with compound indexes for performance
- Virtual fields for member counts and role names

**Day 2: Backend API & Middleware**
- Workspace API routes (`/routes/workspaces.js` - 11 endpoints, 786 lines)
  - CRUD operations for workspaces
  - Member management (invite, role changes, removal)
  - Transfer ownership (owner only)
  - Statistics dashboard endpoint
- Workspace middleware (`/src/middleware/workspace.js` - 4 functions)
  - `attachWorkspace` - Extract workspace context from URL/headers
  - `requireWorkspaceAccess` - Verify membership
  - `requireAdmin` - Admin-only routes
  - `requireOwner` - Owner-only routes

**Day 3: UI Integration**
- Workspace switcher component (`/public/js/workspace.js` - 233 lines)
  - localStorage persistence
  - Auto-initialization
  - Helper methods for adding workspace context to API calls
  - Custom event broadcasting
- Navigation integration (`/public/js/components/nav.js`)
  - Workspace dropdown in navigation bar
  - Visual role badges
- Frontend API integration (`/public/js/chat.js`)
  - All chat API calls include workspace context
  - Dual pattern: query params (GET) vs headers (POST)
- Route updates (4 files, 19 routes):
  - `/routes/history.js` - Conversation filtering
  - `/routes/prompts.js` - Workspace-scoped versioning
  - `/routes/benchmark.js` - Benchmark tagging
  - `/routes/custom-models.js` - Model isolation

**Day 4: Settings UI & Testing**
- Workspace settings page (`/public/workspace-settings.html` - 1,119 lines)
  - Workspace list sidebar with role badges
  - Details view/edit (admin only)
  - Feature toggles (RAG, custom models, benchmarking, alerts)
  - Members table with invite/role management
  - Statistics dashboard (5 metrics)
  - Danger Zone (delete workspace - owner only)
  - 3 modals: create workspace, invite member, delete confirmation
- Integration testing (`/tests/integration/workspace-isolation.test.js` - 386 lines, 21 tests)
  - Conversation isolation (4 tests)
  - Prompt isolation with independent versioning (4 tests)
  - Custom model isolation (3 tests)
  - Cross-workspace access prevention (3 tests)
  - Member permissions (3 tests)
  - Statistics isolation (2 tests)
  - Settings isolation (2 tests)
  - **Result:** 21/21 passing (100%)

**Key Features:**
- **Complete Data Isolation** - Conversations, prompts, custom models, settings scoped to workspaces
- **Role-Based Access Control** - 4 tiers with granular permissions
- **Workspace-Scoped Prompt Versioning** - Independent version numbers per workspace
- **Member Management** - Invite, role changes, removal, ownership transfer
- **Feature Toggles** - Enable/disable features per workspace
- **Statistics Dashboard** - Real-time workspace usage metrics
- **Settings Management** - Model restrictions, usage limits, plan types

**Code Metrics:**
- **Total Files Modified/Created:** 28
- **Total Lines Added:** 4,260+
- **Models:** 2 (Workspace, WorkspaceMember)
- **API Endpoints:** 11
- **Middleware Functions:** 4
- **UI Pages:** 2 (switcher + settings)
- **Integration Tests:** 21 (all passing)
- **Development Time:** 4 days

**Status:** Production-ready with comprehensive testing and full UI integration

**Documentation:**
- `WEEK4_DAY1_PROGRESS.md` - Models and architecture
- `WEEK4_DAY2_PROGRESS.md` - API routes and middleware
- `WEEK4_DAY3_PROGRESS.md` - UI integration
- `WEEK4_DAY4_PROGRESS.md` - Settings UI and testing (630 lines)

---

### Track 8: Feature Alignment Dashboard ✅ PHASE 1 COMPLETE | 🔄 PHASE 2 IN PROGRESS

**Purpose:** Comprehensive feature coverage visibility and UI development prioritization

---

#### Phase 1: Feature Alignment Dashboard ✅ COMPLETE (2026-01-07)

**Status:** Production-ready, accessible at http://localhost:3080/feature-alignment.html

**Components:**
- ✅ Feature scanner (`/src/services/featureAlignmentScanner.js` - 470 lines)
  - Scans 179 features across frontend, backend, and documentation
  - Maps 254 backend endpoints
  - Identifies orphan endpoints and headless features
- ✅ Priority algorithm (`/src/services/featureAlignmentPriority.js` - 350+ lines)
  - 7-criteria scoring system (0-100 points)
  - n8n workflow detection (±30 points)
  - False positive handling (-15 points)
  - UI implementation detection (-20 points)
- ✅ Actionable reports (`/reports/feature-alignment-actions.md`)
  - Top 10 high-priority features analyzed
  - Orphan endpoint categorization (0 genuine orphans found)
  - Recommendations for UI development
- ✅ Interactive dashboard (`/public/feature-alignment.html` - 15.5 KB)
  - Overview stats panel with 4 key metrics
  - Status distribution pie chart (Chart.js)
  - Orphan endpoints table with false positive detection
  - Features priority table with filters and sorting
  - Feature details modal with score breakdown
  - Actionable recommendations panel
- ✅ Dashboard JavaScript (`/public/js/feature-alignment.js` - 22.1 KB)
  - Real-time priority score calculation
  - Orphan endpoint classification
  - Interactive filtering and sorting
  - CSV export functionality
- ✅ Navigation integration (`/public/js/components/nav.js`)
  - "Alignment" link between Admin and Workspaces
- ✅ User documentation (`/docs/FEATURE_ALIGNMENT_DASHBOARD_GUIDE.md` - 320+ lines)
  - Quick start guide
  - Dashboard sections explained
  - Common workflows (4 examples)
  - Troubleshooting and FAQs

**Scanner Results (2026-01-07):**
- 179 features detected (down from 227 after filtering report artifacts)
- 127 complete features (already have UIs - 71%)
- 42 headless-documented features
- 10 partial features
- 0 orphan endpoints (all 10 initially detected were false positives)

**Priority Algorithm (7 Criteria):**
1. **n8n Workflow Usage (±30pts):** Negative for n8n endpoints (API-only), positive for monitoring needs
2. **Endpoint Count (0-40pts):** More endpoints = more complex = higher priority
3. **Documentation (0-15pts):** Well-documented features get higher scores
4. **Security (0-15pts):** Auth-required features need admin UI
5. **Recent Activity (0-15pts):** Active development = current priority
6. **False Positive Penalty (-15pts):** Already has UI but marked as orphan
7. **UI Detection (-20pts):** Has frontend files (not truly headless)

**Validation Results:**
- ✅ All dashboard components functional
- ✅ Priority scoring algorithm accurate
- ✅ False positive detection working (7/10 orphans correctly categorized)
- ✅ Navigation integrated across all pages
- ✅ Responsive design for mobile/desktop

---

#### Phase 2: UI Development for Headless Features 🔄 IN PROGRESS

**Status:** Feature prioritization analysis complete, implementation in progress

**High-Priority Features (Score 70+):**

1. **Invitations (85 points)** - ⚡ NEXT UP
   - **Status:** Partial UI - Admin side complete, user acceptance MISSING
   - **Gap:** No UI for users receiving email invitations to accept/decline
   - **Endpoints:** `/api/invitations/validate/:token`, `/api/invitations/accept`
   - **Implementation:** `/public/accept-invitation.html`
   - **Effort:** 4-6 hours
   - **Priority:** ✅ **HIGH** - Completes workspace collaboration feature

2. **Voice API (70 points)** - ⚠️ DEFER
   - **Status:** Fully headless - No UI
   - **Endpoints:** transcribe, synthesize, chat (4 endpoints)
   - **Gap:** Voice interfaces require complex audio handling
   - **Priority:** ⚠️ **MEDIUM** - Defer until user demand confirmed
   - **Effort:** 12-16 hours

3. **Workflow Generator (70 points)** - ⚠️ DEFER
   - **Status:** Fully headless - No UI
   - **Endpoints:** generate, validate, deploy, examples (4 endpoints)
   - **Gap:** AI-powered n8n workflow creation
   - **Priority:** ⚠️ **MEDIUM** - Validate demand with power users first
   - **Effort:** 10-14 hours

**Filtered Out (Not Requiring UI):**
- ✅ **Models Unified (85):** Already has UI via models.html (scanner missed JS → API chain)
- ✅ **Model Registry (80):** Used by benchmark.html, API-only by design
- ✅ **Dataset (80):** Designed for n8n/API access, not user-facing
- ❌ **4 Report Artifacts (65 each):** Scanner incorrectly flagged docs as features

**Scanner Accuracy:**
- **True Positives:** 3/10 (30%) - Invitations, Voice, Workflow Generator
- **False Positives:** 7/10 (70%) - Existing UI, API-only, documentation artifacts
- **Improvement Needed:** Detect HTML → JS → API chains, exclude archived docs

**Next Steps:**
- [x] Analyze top 10 high-priority features
- [x] Filter false positives and existing UI
- [x] Create prioritization analysis document
- [ ] Build invitation acceptance UI (external agent, 4-6 hours)
- [ ] Scanner Phase 1 improvements (external agent, 2.5-3 hours)
  - Detect API helper wrappers (`API.get()`, `axios.get()`)
  - Parse HTML form actions
  - Auth route pattern recognition
  - Exclude `/docs/archive/` from scans

**Documentation:**
- `ORPHAN_ENDPOINTS_ANALYSIS.md` - False positives analysis
- `EXTERNAL_AGENT_RECOMMENDATIONS.md` - Dashboard specifications
- `FEATURE_ALIGNMENT_FIX_SUMMARY.md` - Data mapping fixes
- `docs/FEATURE_ALIGNMENT_PRIORITY_ALGORITHM.md` - Algorithm documentation

**Status:** Backend complete, UI in active development. Dashboard will provide visibility into feature coverage and prioritize future UI development work.

---

## Immediate Priorities

### 1. Complete Feature Alignment Dashboard (Track 8) 🔄 IN PROGRESS

**Goal:** Finish interactive dashboard UI for feature coverage visibility

**Current Status:**
- ✅ Backend complete (scanner + priority algorithm)
- 🔄 UI in development (external agent building HTML/JS)
- ⏳ Navigation integration pending

**Tasks:**
- [x] Implement feature scanner (225 features detected)
- [x] Build priority algorithm (7-criteria scoring)
- [x] Generate actionable reports
- [ ] Complete dashboard HTML/JS (external agent, 5-6 hours)
- [ ] Add to navigation (30 minutes)
- [ ] Update documentation (1 hour)
- [ ] Review 5 medium-priority features for UI development

**Outcome:** Comprehensive dashboard showing which features are complete, which need UI development, and orphan endpoint resolution.

---

### 2. Documentation Normalization ✅ IN PROGRESS

**Goal:** Consolidate scattered documentation into canonical references

**Tasks:**
- [x] Merge CONTRIBUTING.md into CLAUDE.md (unified reference)
- [x] Create new ROADMAP.md (this file) with current status
- [x] Update IMPLEMENTATION_PLAN.md with Feature Alignment progress
- [x] Update ROADMAP.md with Track 8 information
- [ ] Archive old planning docs to `docs/archive/`
- [ ] Update `docs/INDEX.md` to reflect new structure
- [ ] Verify all cross-references are valid

**Outcome:** Single source of truth for project guidance (CLAUDE.md + ROADMAP.md)

---

### 3. Track 6 Wiring Gaps (Backup & DR) ✅ RESOLVED

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

### 3. Alerts End-to-End Connection ✅ VERIFIED (2026-01-06)

**Completed Verification:**
- [x] Confirmed N1.1 (Janitor) and N5.1 (Analyst) workflows call `/api/alerts` ✓
- [x] Added smoke test suite: 17/17 tests passing (100%) ✓
- [x] Verified API → Database → UI path working ✓
- [x] Added graceful channel validation with fallback ✓

**Known Limitations:**
- ⚠️ n8n workflows not currently active (require manual activation in n8n UI)
- ⚠️ Slack/email/webhook channels not implemented (log warnings, default to dataapi_log)
- ✅ Alert creation, persistence, and retrieval fully functional

**Documentation:** `/docs/testing/ALERTS_INTEGRATION_VERIFICATION.md` (180 lines)

**Next Steps:**
- [ ] Activate N1.1/N5.1 workflows in n8n UI (operational task)
- [ ] Implement Slack webhook integration
- [ ] Implement email notifications (SMTP/nodemailer)
- [ ] Implement generic webhook delivery

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
- [x] Multi-tenant support with workspace isolation ✅ COMPLETE (Week 4)
- [x] Email invitations for workspace members ✅ COMPLETE (Post-Week 4, A1)
- [x] Workspace activity audit logs ✅ COMPLETE (Post-Week 4, A2 - Full implementation with UI)
- [x] Advanced RAG features (query expansion, re-ranking, hybrid search) ✅ COMPLETE (already implemented)
- [ ] Expose RAG advanced options in chat UI (query expansion, hybrid search, re-ranking toggles)
- [ ] RAG contextual compression (LLM extracts relevant sentences from chunks)
- [ ] RAG citation tracking (source references in LLM responses)
- [ ] Custom dashboard builder for metrics visualization
- [ ] Webhook retry logic with exponential backoff

**RAG Features Note:** Advanced RAG features (query expansion, hybrid search, re-ranking) are fully implemented in `/src/services/ragStore.js` (647 lines) but not yet exposed in the UI. See `/docs/features/RAG_ENHANCEMENT_STATUS.md` for details.

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
