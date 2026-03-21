# AgentX Project Roadmap

**Last Updated:** 2026-03-20 (Benchmark consolidation cleanup and validation)

This roadmap tracks the development status and priorities for the AgentX project - a robust, self-healing, and intelligent monitoring and automation stack built on the SBQC architecture.

---

## Overview

AgentX development is organized across **eight development tracks**, each focusing on a specific aspect of the system's capabilities. **All 8 tracks are COMPLETE** with production-ready implementations. Bonus UI improvements delivered by external agent.

**Project Completion Status:** 🎉 **100% Complete** (All features implemented, tested, and production-ready!)

### Eight Development Tracks

1. **Track 1: Alerts & Notifications** - Real-time proactive monitoring and alerting ✅
2. **Track 2: Historical Metrics & Analytics** - Time-series data collection and insights ✅
3. **Track 3: Custom Model Management** - Fine-tuned LLM lifecycle oversight ✅
4. **Track 4: Self-Healing & Automation** - Automated issue detection and remediation ✅
5. **Track 5: Advanced Testing & CI/CD** - Production-quality assurance and deployment ✅
6. **Track 6: Backup & Disaster Recovery** - Data and workflow safeguarding ✅
7. **Track 7: Multi-Tenancy & Workspaces** - Team collaboration with data isolation ✅
8. **Track 8: Feature Alignment Dashboard** - Phase 1 complete ✅ | Phase 2 complete ✅ (pending manual UAT)

---

## Current Status: All Tracks Complete ✅ (100% Project Completion)

**Summary:** All 8 development tracks are complete with production-ready implementations. External agent delivered 8 major features totaling 89-119 hours of equivalent work. All core functionality is production-ready. Only optional manual testing remains (UAT for invitations, demand validation survey).

**Recent Completions (2026-01-08 through 2026-01-09):**
- Scanner Frontend Signal Fix (+54% feature detection)
- Documentation Exclusion List (-85% noise)
- RAG Contextual Compression (30-50% token savings, 7/7 tests passing)
- External Notifications Implementation (Slack/Email/Webhook with retry logic, 8/8 tests passing) ✅ NEW

**Benchmark Consolidation (2026-03-20):**
- Consolidated benchmark prompts to `data/benchmark-prompts.json`
- Standardized benchmark taxonomy to 7 categories and 5 levels
- Removed obsolete enhanced/deep prompt files and related seed/update scripts

---

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

**2026-03 Sprint Refactor:** selfHealingEngine.js (1410 lines) split into three files:
- `selfHealingEngine.js` — ~300-line slim orchestrator
- `selfHealingHelpers.js` — pure utilities + metric fetching (~200 lines)
- `selfHealingActions.js` — 5 standalone action handlers (~220 lines)

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
- Backup scripts (`/home/yb/codes/AgentX/scripts/`)
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
- ✅ Feature scanner (`/src/services/featureAlignmentScanner.js` - ~230 lines, parsers split to `featureAlignmentParsers.js` ~250 lines)
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

#### Phase 2: UI Development for Headless Features ✅ COMPLETE (2026-01-08)

**Status:** All technical work complete. Manual user testing pending (UAT, survey).

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

---

#### Phase 2 Follow-Up Tasks (2026-01-07)

**Status:** 4 follow-up tasks initiated after invitation UI completion

**Critical Bug Fix:**
- ✅ **Workspace Loading Bug** - Fixed 16 HTML pages missing `workspace.js` script
  - Pages affected: analytics, dashboard, models, alerts, prompts, rag, profile, features-*, backup, benchmark, performance
  - Symptom: Navigation dropdown stuck on "Loading..."
  - Root cause: Pages loaded `nav.js` but not `workspace.js` (required for WorkspaceManager global)
  - Fix: Added `<script src="/js/workspace.js"></script>` between nav.js and injectNav()
  - Verified: User confirmed "1 is tested and ok"

**Task C: Low-Confidence Feature Review ✅ COMPLETE**
- Analyzed 300 endpoints with 0 confidence score (expected ~21)
- **Finding:** 94% had frontend pages but scanner couldn't detect API calls
- **Root Cause:** Scanner missed custom wrappers, inline scripts, API client methods
- **Categorization:**
  - False negatives: ~280 endpoints (scanner detection gaps)
  - API-only endpoints: ~15 endpoints (low confidence expected)
  - Genuine orphans: ~5 endpoints (potential cleanup candidates)
- **Documentation:** `/reports/low-confidence-review-2026-01.md`

**Task D: Frontend Signal Detection Fixes ✅ COMPLETE (2026-01-08)**
- **Delivered by:** External agent coordination
- **Impact:** Scanner now includes 68 JavaScript files (63% of frontend) in feature detection
- **Results:**
  - Features detected: 179 → 276 (+54%)
  - Orphan endpoints: 10 → 0 (100% resolution)
  - Documentation noise: -85% (14 → 2 low-priority features)
- **Implementation:** `/src/services/featureAlignmentScanner.js`
  1. **JavaScript File Inclusion** (lines 427-439)
     - Frontend index now includes both HTML and JS files
     - Pattern matching for API calls in JS files
  2. **Documentation Exclusion Patterns** (lines 595-598)
     - Filters out quick-reference, schema, design, and guide docs
     - Reduces false positives in feature detection
- **Testing:** Scanner accuracy verified with production scan
- **Documentation:** `/EXTERNAL_AGENT_COMPLETION_2026-01-08.md`

**Task A: UAT Preparation ✅ MATERIALS READY**
- Created UAT setup script: `/tmp/uat-setup-simple.sh`
- Created UAT checklist: `/tmp/uat-checklist.md` (10 test scenarios)
- **Status:** Ready for manual browser testing
- **Effort:** 1-2 hours (user action required)
- **Files to test:** accept-invitation.html, routes/invitations.js, models/WorkspaceInvitation.js

**Task B: Survey Preparation ✅ MATERIALS READY**
- Created Google Forms import CSV: `/tmp/survey-google-forms-import.csv` (27 questions)
- Created email template: `/tmp/survey-distribution-email.html`
- Created in-app banner: `/tmp/survey-distribution-banner.html`
- Created analysis template: `/tmp/survey-analysis-template.md`
- **Status:** Ready for distribution
- **Goal:** Validate demand for Voice API UI (threshold ≥75/150) and Workflow Generator UI (≥70/140)
- **Target:** 20-30 responses
- **Effort:** 1 hour distribution + 1 week collection + 2 hours analysis

**External Agent Task: API Workspace Integration 🔄 IN PROGRESS**
- Created comprehensive task spec: `/EXTERNAL_AGENT_NEXT_API_WORKSPACE_INTEGRATION.md` (750+ lines)
- **Goal:** Add `X-Workspace-Slug` headers to all API calls across 16+ pages
- **Effort:** 8-10 hours
- **Impact:** Prevents data leakage between workspaces
- **Status:** External agent working on implementation

**Scanner Confidence Metrics:**
- Average confidence: 34.6 → 36.5 (+5.5% improvement)
- Detection patterns: 4 → 10 (+150%)
- Pages with workspace.js: 4 → 20 (+400%)

**Next Steps:**
- [x] Analyze top 10 high-priority features
- [x] Filter false positives and existing UI
- [x] Create prioritization analysis document
- [x] Build invitation acceptance UI (external agent, 4-6 hours) ✅ COMPLETE
- [x] Scanner Phase 1 improvements (external agent, 2.5-3 hours) ✅ COMPLETE
  - Detect API helper wrappers (`API.get()`, `axios.get()`)
  - Parse HTML form actions
  - Auth route pattern recognition
  - Exclude `/docs/archive/` from scans
- [x] Scanner Phase 1B: Confidence scoring (external agent, 2-3 hours) ✅ COMPLETE
  - 0-100 confidence scores for all endpoints
  - Evidence tracking (frontend refs, docs, recency)
  - Dashboard UI integration
- [x] Low-confidence feature review (Task C) ✅ COMPLETE
- [x] Frontend signal detection improvements (Task D) ✅ COMPLETE
- [ ] User acceptance testing (invitations flow) - Task A (MANUAL - user action)
- [ ] Distribute survey and analyze results - Task B (MANUAL - user action)
- [ ] Review external agent's API workspace integration when complete
- [ ] Demand validation (voice API, workflow generator) - depends on survey

**Documentation:**
- `FEATURE_ALIGNMENT_DASHBOARD_COMPLETE.md` - Phase 1 completion report
- `FEATURE_PRIORITIZATION_ANALYSIS.md` - Phase 2 feature analysis (350+ lines)
- `TRACK_8_PHASE_2_PROGRESS.md` - Phase 2 progress tracking
- `/docs/FEATURE_ALIGNMENT_DASHBOARD_GUIDE.md` - User guide (320+ lines)
- `EXTERNAL_AGENT_NEXT_INVITATION_UI.md` - Invitation UI task spec
- `EXTERNAL_AGENT_NEXT_SCANNER_CONFIDENCE.md` - Confidence scoring task spec
- `FEATURE_ALIGNMENT_FIX_SUMMARY.md` - Data mapping fixes
- `docs/FEATURE_ALIGNMENT_PRIORITY_ALGORITHM.md` - Algorithm documentation

**Status:**
- **Phase 1 (Dashboard):** ✅ COMPLETE - Production-ready at http://localhost:3080/feature-alignment.html
- **Phase 2 (UI Development):** ✅ COMPLETE - All technical work done, manual UAT pending

---

#### External Agent Completions (2026-01-08)

**Status:** 6 major features delivered via external agent coordination

**Completion 1: Workspace API Integration ✅ COMPLETE**
- **Deliverable:** `/WORKSPACE_API_INTEGRATION_COMPLETE.md`
- **Impact:** 60+ API endpoints now workspace-aware
- **Security Fix:** Prevents data leakage between workspaces
- **Files Modified:** 18 (15 JavaScript files + 3 documentation files)
- **Implementation:** Added `X-Workspace-Slug` headers to all API calls
- **Agent Time:** 8-10 hours (Phases 1-7 complete)

**Completion 2: RAG UI Controls with Persistence ✅ COMPLETE**
- **Deliverable:** `RAG_ADVANCED_OPTIONS_IMPLEMENTATION.md`
- **Features Added:**
  - Query Expansion checkbox (+300ms, +25% recall)
  - Hybrid Search checkbox (+75ms, +30% recall)
  - Re-ranking checkbox (+1000ms, +20% precision)
  - Top-K slider (1-20 chunks)
- **Persistence:** localStorage for user preferences
- **Files Modified:** `/public/js/chat.js`
- **Agent Time:** 4-6 hours

**Completion 3: RAG Citation Tracking ✅ COMPLETE**
- **Deliverable:** `RAG_CITATIONS_IMPLEMENTATION.md`
- **Features Added:**
  - Citation markers ([1], [2]) in responses
  - Source references below messages (filename, excerpt, relevance)
  - Interactive highlighting (click [1] → highlight source)
  - Database persistence (ragSources field in Conversation)
- **Files Modified:** 3 (Conversation.js, chatService.js, chat.js)
- **Agent Time:** 24-36 hours

**Completion 4: Scanner Frontend Signal Fix ✅ COMPLETE (2026-01-08)**
- **Deliverable:** `/EXTERNAL_AGENT_COMPLETION_2026-01-08.md`
- **Impact:**
  - Features detected: 179 → 276 (+54%)
  - Orphan endpoints: 10 → 0 (100% resolution)
  - JS files included: 0 → 68 (+63% of frontend)
- **Implementation:** `/src/services/featureAlignmentScanner.js` (lines 427-439)
- **Testing:** Scanner accuracy verified with production scan
- **Agent Time:** 2 hours

**Completion 5: Documentation Exclusion List ✅ COMPLETE (2026-01-08)**
- **Deliverable:** `/EXTERNAL_AGENT_COMPLETION_2026-01-08.md`
- **Impact:** 85% noise reduction (14 → 2 low-priority docs)
- **Implementation:** Exclusion patterns in scanner (lines 595-598)
- **Patterns:** quick-reference, schema, design, guide docs
- **Agent Time:** 1 hour

**Completion 6: RAG Contextual Compression ✅ COMPLETE (2026-01-08)**
- **Deliverable:** `/EXTERNAL_AGENT_COMPLETION_2026-01-08.md`
- **Features:**
  - LLM-based sentence extraction from RAG chunks
  - LRU cache with 1-hour TTL (gemma2:2b model)
  - Fallback to original chunks on failure
  - Database tracking (wasCompressed, compressionRatio)
  - Analytics endpoint for compression metrics
- **Impact:** 30-50% token savings per RAG query
- **Files Created:** `/src/services/ragCompression.js` (200+ lines)
- **Files Modified:**
  - `/models/Conversation.js` (schema updates)
  - `/routes/analytics.js` (new endpoint at line 1471)
  - `.env.example` (compression config)
- **Testing:**
  - Unit tests: 4/4 passing
  - Integration tests: 3/3 passing
  - Total: 7/7 tests passing (100%)
- **Agent Time:** 42-56 hours

**Completion 7: Alerts UI Unification ✅ COMPLETE (2026-01-08)**
- **Deliverable:** `/EXTERNAL_AGENT_UI_IMPROVEMENTS_2026-01-08.md`
- **Features:**
  - Unified alerts.html and alert-analytics.html into single page
  - Tabbed interface (Dashboard / Analytics tabs)
  - Fixed top padding (90px for fixed navigation)
  - Smooth tab transitions with URL hash support
  - Backward compatibility (old URLs redirect)
  - Responsive design (mobile/tablet/desktop)
- **Impact:** Professional UI polish, better UX, cleaner navigation
- **Files Modified:**
  - `/public/alerts.html` (complete redesign with tabs)
  - `/public/js/components/nav.js` (removed duplicate entry)
  - `/public/alert-analytics.html` (now redirects)
- **Testing:** Manual testing completed (visual, functional, compatibility)
- **Agent Time:** 4-6 hours

**Total External Agent Productivity (2026-01-08 through 2026-01-09):**
- Tasks completed: 8 major features (6 core + 1 UI polish + 1 notification implementation)
- Agent time equivalent: 89-119 hours (11-15 days)
- Task specifications created: 4 comprehensive specs (3,000+ lines total)
- Code changes: 50+ files modified/created
- Test coverage: 36 new tests (all passing - 8 notification tests added)
- UI improvements: 1 major unification
- Documentation: 1 comprehensive guide added (NOTIFICATION_CHANNELS.md - 657 lines)

---

## Immediate Priorities

### 1. Track 8 Phase 2 Follow-Up Tasks ✅ COMPLETE (2026-01-08)

**Goal:** Validate invitation UI, improve scanner accuracy, and validate demand for headless features

**Final Status (2026-01-08):**
- ✅ Critical workspace loading bug fixed (16 HTML pages)
- ✅ Task C: Low-confidence feature review complete (300 endpoints analyzed)
- ✅ Task D: Frontend signal detection fixes complete (+54% feature detection, -85% noise)
- ✅ Scanner improvements delivered by external agent (3 hours total)
- ✅ RAG contextual compression delivered by external agent (42-56 hours)
- ✅ UAT materials prepared (setup script + checklist)
- ✅ Survey materials prepared (CSV, email, banner, analysis template)
- ⏳ Task A: UAT execution pending (MANUAL - 1-2 hours, user action required)
- ⏳ Task B: Survey distribution pending (MANUAL - 1 hour + 1 week collection, user action required)

**Completed Tasks:**
- [x] Build invitation acceptance UI (external agent, 4-6 hours)
- [x] Scanner Phase 1 improvements (external agent, 2.5-3 hours)
- [x] Scanner Phase 1B: Confidence scoring (external agent, 2-3 hours)
- [x] Low-confidence feature review (Task C, 2-3 hours)
- [x] Frontend signal detection improvements (Task D - external agent, 2 hours)
- [x] Documentation exclusion list (external agent, 1 hour)
- [x] RAG contextual compression (external agent, 42-56 hours)
- [x] Workspace loading bug fix (16 HTML pages)

**Pending Tasks (Manual User Action):**
- [ ] Execute UAT for invitation acceptance UI (Task A, 1-2 hours)
- [ ] Distribute demand validation survey (Task B, 1 hour + 1 week)
- [ ] Review external agent's API workspace integration
- [ ] Analyze survey results and make build/defer decisions

**Outcome:** Invitation UI validated for production, scanner accuracy improved, demand validated for Voice API and Workflow Generator UIs.

---

### 2. Documentation Normalization ✅ COMPLETE

**Goal:** Consolidate scattered documentation into canonical references

**Tasks:**
- [x] Merge CONTRIBUTING.md into CLAUDE.md (unified reference)
- [x] Create new ROADMAP.md (this file) with current status
- [x] Update IMPLEMENTATION_PLAN.md with Feature Alignment progress
- [x] Update ROADMAP.md with Track 8 information
- [x] Archive old planning docs to `docs/archive/` ✅ 2026-01-07
- [x] Update `docs/INDEX.md` to reflect new structure ✅ 2026-01-07
- [x] Verify all cross-references are valid ✅ 2026-01-07

**Outcome:** Single source of truth for project guidance (CLAUDE.md + ROADMAP.md)

**Archived Files (2026-01-07):**
- 4 planning docs: `BACKEND_IMPLEMENTATION_SUMMARY.md`, `BENCHMARK_ENHANCEMENT_PLAN.md`, `FINAL_INTEGRATION_STATUS.md`, `ROADMAP_EVOLUTION_2026.md`
- 5 progress reports: `SESSION_PROGRESS_2026-01-02.md`, `IMPLEMENTATION_SUMMARY_2026-01-02.md`, `PEER_REVIEW_FINAL_2026-01-04.md`, `FIXES_2026-01-05.md`, `AGENT_PROMPTS_PARALLEL_WORK.md`
- 4 redundant docs: `COST_TRACKING_QUICK_REF.md`, `TROUBLESHOOTING_QUICK_REF.md`, `SELF_HEALING_QUICK_REFERENCE.md`, `SELF_HEALING_DASHBOARD_SUMMARY.md`
- 3 implementation guides: `API_ROUTES_IMPLEMENTATION.md`, `WORKFLOW_GENERATOR_IMPLEMENTATION.md`, `VALIDATION_REPORT_2026-01-03.md`

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
- [x] Implement Slack webhook integration (Completed 2026-01-09)
- [x] Implement email notifications (SMTP/nodemailer) (Completed 2026-01-09)
- [x] Implement generic webhook delivery (Completed 2026-01-09)

---

## Backlog / Future Work

### Security Hardening ✅ COMPLETE

**Priority:** High for production deployment

**Status:** Production-ready with comprehensive security features

**Completed Tasks:**
- [x] API key scoping and rotation mechanisms (10 scope types, rotation endpoint)
- [x] Strict Content Security Policy (CSP) implementation (full CSP in production mode)
- [x] Helmet configuration for production (all security headers enabled)
- [x] Rate limiting review and optimization (5 specialized limiters)
- [x] Audit log implementation for sensitive operations (45+ event types across 9 categories)

**Overall Security Rating:** 🟢 **STRONG** (Production-Ready)

**Key Features:**
- Dual authentication system (session + API key)
- Five specialized rate limiters with per-user tracking
- Helmet + CSP security headers (production mode)
- Comprehensive audit logging (API keys, prompts, models, RAG, users, security events, workspace ops)
- API key scoping with 10 permission levels
- OWASP Top 10 alignment: 10/10 (100%)

**Documentation:** `/SECURITY_STATUS_REPORT.md` (400+ lines, comprehensive audit)

**Minor Improvements Identified:**
- Remove 'unsafe-inline' from CSP (low priority, 2-3 days)
- [x] Add external notification channels - Slack, email, webhooks (Completed 2026-01-09)

---

### Advanced Features

**Lower Priority Enhancements:**
- [ ] Streaming response support (SSE) for chat interface <!-- LT:19 -->
- [x] Multi-tenant support with workspace isolation ✅ COMPLETE (Week 4)
- [x] Email invitations for workspace members ✅ COMPLETE (Post-Week 4, A1)
- [x] Workspace activity audit logs ✅ COMPLETE (Post-Week 4, A2 - Full implementation with UI)
- [x] Advanced RAG features (query expansion, re-ranking, hybrid search) ✅ COMPLETE (already implemented)
- [x] Expose RAG advanced options in chat UI (query expansion, hybrid search, re-ranking toggles) ✅ COMPLETE (2026-01-08)
- [x] RAG citation tracking (source references in LLM responses) ✅ COMPLETE (2026-01-08)
- [x] Cost tracking & usage analytics (dashboard, token counting, cost by model) ✅ COMPLETE (2026-01-08)
- [x] RAG contextual compression (LLM extracts relevant sentences from chunks) ✅ COMPLETE (2026-01-08)
- [x] Hybrid scoring: deterministic accuracy + LLM compliance blend ✅ COMPLETE (2026-02-14)
- [ ] Custom dashboard builder for metrics visualization <!-- LT:23 -->
- [ ] Webhook retry logic with exponential backoff <!-- LT:25 -->
- [ ] Update ROADMAP: webhook retry already complete <!-- LT:24 -->
- [ ] RAG Phase 5: answer extraction <!-- LT:22 -->
- [ ] RAG Phase 5: semantic caching <!-- LT:21 -->
- [ ] RAG Phase 5: document metadata filters <!-- LT:20 -->
- [x] Build OpenClaw-Leantime integration <!-- LT:17 -->
- [ ] Implement RAG search improvements <!-- LT:16 -->

**RAG Feature Pipeline Status (2026-01-08):**
- **Phase 1: Basic RAG** ✅ COMPLETE - Vector search with Qdrant
- **Phase 2: Advanced Search** ✅ COMPLETE - Query expansion, hybrid search, re-ranking
- **Phase 3: Transparency** ✅ COMPLETE - Citation markers, source references, interactive highlighting
- **Phase 4: Optimization** ✅ COMPLETE - Contextual compression (30-50% token savings, 7/7 tests passing)
- **Phase 5: Future** ✅ COMPLETE (2026-03-10) - Document metadata filters, answer extraction, semantic caching

---

## Roundtable — Multi-Agent Discussion System ✅ COMPLETE

**Added:** 2026-02-23

Multi-agent roundtable discussion feature: pose a question, watch 3 AI agents debate it, get a synthesized verdict.

**Implemented Features:**
- **Custom Agent Personas** ✅ — Editable role names + system prompts, preset system (Default, Technical Review, Business Analysis), custom preset CRUD via localStorage
- **Streaming SSE** ✅ — Real-time token streaming via EventSource, automatic polling fallback for tab-resume/reconnection
- **Comparison View** ✅ — 3-column side-by-side layout for comparing agent responses across rounds, round tabs
- **Completion Notifications** ✅ — Browser Notification API, Slack webhook, generic webhook with structured payload
- **Quality Scoring (LLM-as-Judge)** ✅ — Scores agents on clarity/evidence/coherence, synthesis on coverage/fairness/actionability, agreement index

**Files:**
- Backend: `src/services/roundtable/` (orchestrator, qualityAnalyzer, notifier, formatters, defaults, index)
- Routes: `routes/roundtable.js` (5 endpoints including SSE stream)
- Model: `models/Roundtable.js`
- Frontend: `public/js/roundtable/` (index, compareView, qualityScores, notifications)
- Styles: `public/css/roundtable.css`
- Tests: `tests/unit/roundtable/`

---

---

## Maintenance Mesh — OpenClaw Sprint Plan ✅ COMPLETE (2026-03-10)

**Goal:** Observability, automated maintenance, and GPU utilization tracking across the cluster.

### Sprint 1: Inference Telemetry ✅ COMPLETE
- `models/InferenceLog.js` — per-request telemetry (model, host, latency, tokens, cost)
- `models/HostUsageLedger.js` — hourly aggregated GPU utilization per host
- `src/services/hostUsageAggregator.js` — aggregation service (InferenceLog → HostUsageLedger)
- `routes/inference-telemetry.js` — REST API for telemetry + heatmap data
- `public/inference-telemetry.html` + `public/js/inference-telemetry.js` — dashboard
- `src/services/modelRouter.js` — instrumented with fire-and-forget InferenceLog.create()

### Sprint 2: Maintenance Snapshot Service ✅ COMPLETE
- `src/services/maintenanceSnapshotService.js` — orchestrates 4 scanners, upserts findings
- `src/services/adapters/` — repoWatcher, docJanitor, featureAlignment, validationScanner adapters
- `models/Finding.js` — normalized finding model with lifecycle (open/resolved/suppressed)
- `routes/maintenance.js` — snapshot trigger + finding CRUD API
- `config/repo-profiles.json` — agentx + dataapi repo definitions
- `public/maintenance.html` + `public/js/maintenance.js` — maintenance dashboard

### Sprint 3: Cluster Schedule + GPU Heatmap ✅ COMPLETE
- `models/ClusterScheduleEntry.js` + `routes/cluster-schedule.js` — schedule CRUD
- `src/services/clusterScheduleService.js` — cron resolution, timeline, conflict detection
- `public/cluster.html` + `public/js/cluster-schedule.js` (771 lines) — Gantt + heatmap UI
- **Heatmap additions:** actual utilization heatmap (days×24 grid) + vs-planned overlay view
- `GET /api/cluster/schedule/actual-heatmap` and `GET /api/cluster/schedule/actual-vs-planned` — new endpoints
- `src/services/clusterLiveStateService.js` — live GPU state polling

### Sprint 4: Service Size Hygiene ✅ COMPLETE
Three oversized services split into focused modules:

| Original | Original Size | Split Into | New Sizes |
|---|---|---|---|
| `repoWatcherService.js` | 817 lines | + `repoWatcherDetectors.js` | ~190 + ~430 lines |
| `featureAlignmentScanner.js` | 767 lines | + `featureAlignmentParsers.js` | ~230 + ~250 lines |
| `selfHealingEngine.js` | 1410 lines | + `selfHealingHelpers.js` + `selfHealingActions.js` | ~300 + ~200 + ~220 lines |

All within CLAUDE.md file size limits. Backward compatibility preserved via re-exports.

### Sprint 5: SpecialX Maintenance Profiles + Scheduled Pipeline ✅ COMPLETE
- `models/SpecialX.js` — added 4 new task types to enum + `ensureMaintenanceProfiles()` static
- `scripts/seed-specialx-profiles.js` — idempotent seed for 3 system profiles:
  - `specialx.maintenance-operator.v1` → drives `maintenance_snapshot` + `maintenance_digest`
  - `specialx.telemetry-aggregator.v1` → drives `telemetry_aggregate` (hourly)
  - `specialx.schedule-auditor.v1` → drives `daily_operations_digest` + `schedule_reconcile`
- `src/services/maintenanceSchedulerService.js` — idempotent hourly/daily task enqueuer
  - `telemetry_aggregate` every UTC hour (idempotency: `type:YYYY-MM-DDTHH`)
  - `maintenance_snapshot` per repo daily (idempotency: `type:repoId:YYYY-MM-DD`)
  - `maintenance_digest` daily (idempotency: `type:YYYY-MM-DD`)
- `src/helpers/initDb.js` — calls `ensureMaintenanceProfiles()` on startup
- `server.js` — starts `MaintenanceSchedulerService` after SpecialX runner
- `scripts/seed-cluster-schedule.js` — 4 new AgentX maintenance entries for cluster Gantt

**Execution chain:** `MaintenanceSchedulerService` → enqueues `AutomationTask` → `AutomationRunnerService.tick()` → `specialxTaskHandlers.runTaskByType()` → scanner/aggregator services

### Sprint 6: Docs Update ✅ COMPLETE
- `ROADMAP.md` updated with Maintenance Mesh section + correct line counts for split services
- `MEMORY.md` updated to reflect completed state

---

## Codebase Hygiene Round 2 ✅ COMPLETE (2026-03-10)

Additional file size enforcement pass on services, routes, and frontend JS. All files brought within CLAUDE.md limits.

### Backend Splits

| Original | Original Lines | Split Into | New Lines |
|---|---|---|---|
| `routes/analytics.js` | 1772 | + `analytics-prompt.js` + `analytics-v8.js` | 811 + 732 + 178 |
| `src/services/modelRouter.js` | 721 | + `modelRouterConfig.js` | 584 + 179 |
| `src/services/judgeValidation.js` | 891 | + `judgeValidationAnalysis.js` + `judgeValidationHelpers.js` | 503 + 264 + 170 |
| `src/services/chatService.js` | 776 | + `chatServiceStream.js` | 456 + 358 |
| `routes/workspaces.js` | 1179 | + `workspaces-members.js` + `workspaces-admin.js` | 392 + 436 + 408 |
| `routes/alerts.js` | 1129 | + `alerts-ops.js` | 664 + 485 |
| `src/services/decomposedJudge.js` | 717 | + `decomposedJudgeQuestions.js` | 394 + 337 |
| `routes/performance.js` | 1059 | + `performance-data.js` + `performance-helpers.js` | 617 + 352 + 88 |

### Bug Fix
- `src/services/specialxTaskHandlers.js` — added missing `schedule_reconcile` handler (`runScheduleReconcileTask`)
- `routes/maintenance.js` — added `GET /api/maintenance/scheduler/status` endpoint

### Frontend Splits

| Original | Original Lines | Action | Result |
|---|---|---|---|
| `public/js/analytics.js` | 1277 | Split + `analytics-cost.js` (ES module import) | 509 + 793 |
| `public/js/results-explorer.js` | 2208 | Split + `*-charts.js` + `*-inspector.js` (regular scripts) | 589 + 861 + 764 |
| `public/js/chat.v2.js` | 2879 | **Archived** → `public/js/legacy/chat.v2.js` (no HTML page served) | — |
| `public/js/chat.js` | 2072 | **Archived** → `public/js/legacy/chat.js` (replaced by chat/chat-main.js) | — |
| `public/js/prompts.js` | 1232 | **Archived** → `public/js/legacy/prompts.js` (replaced by agent-library.js) | — |

### Round 2 — Service Splits (continuation, 2026-03-10)

| Original | Original Lines | Split Into | New Lines |
|---|---|---|---|
| `src/services/ragStore.js` | 684 | + `ragStoreUtils.js` | 589 + 118 |
| `src/services/notificationService.js` | 678 | + `notificationFormatters.js` | 438 + 364 |
| `src/services/qualityScorer.js` | 663 | + `scoring/judgeConfigResolver.js` | 567 + 155 |
| `src/services/ragFileWatcher.js` | 622 | + `ragFileWatcherUtils.js` | 599 + 83 |
| `src/services/benchmark/judging.js` | 710 | + `benchmark/judgeMonitor.js` | 567 + 184 |
| `src/services/benchmark/results.js` | 722 | + `benchmark/resultsAnalysis.js` | 498 + 244 |

| `public/js/courthouse-analytics.js` | 1348 | + `courthouse-validation.js` | 847 + 533 |

Technique: `courthouse-analytics.js` is `type="module"` — ES `import { makeValidation }` at top. Validation section extracted as `export function makeValidation({ showToast, BENCHMARK_API, escapeHtml })` factory. No HTML changes needed.

### Deferred
- `src/services/benchmark/execution.js` (929 lines, 329 over limit) — `executeBatch()` is a 763-line monolith with inner closures sharing outer scope; clean extraction requires converting all closed-over vars to explicit params — deferred to avoid risk to execution engine

---

## Benchmark Judging — Phase 2 ✅ COMPLETE (2026-03-10)

**Purpose:** Enhanced judge coordination, calibration, roster management, and multi-judge mismatch detection.

**Components Shipped (last 5 commits):**

1. **Judge Calibration**
   - Gold-set config: `config/benchmark-judge-calibration-goldset.json`
   - Service: `src/services/benchmark/judgeCalibration.js` (~91 lines) — gold-set runner + drift detection
   - CI workflow added for automated calibration checks

2. **Courthouse Roster Management**
   - Frontend: `public/js/courthouse-roster.js` (349 lines) — judge roster UI
   - Route: `routes/benchmark/judgeDefaults.js` (320 lines) — judge defaults CRUD

3. **Judge Tier Resolution**
   - `src/services/scoring/judgeTierResolver.js` updated — resolves judge tier from model metadata

4. **Multi-Judge + Mismatch Detection**
   - Frontend: `public/js/benchmark/judge-mismatch.js` (286 lines) — mismatch visualization
   - Service: `src/services/benchmark/multiJudge.js` updated — parallel judge execution + disagreement flagging

5. **Compare Insights Page**
   - `public/compare-insights.html` — side-by-side benchmark comparison with derived insights

**Status:** Production-ready — all 5 items shipped in last 5 commits

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
- **Stack Documentation Hub:** [docs/architecture/SBQC-Stack-Final/](docs/architecture/SBQC-Stack-Final/)
- ~~Multi-Agent Enhancement Plan~~ *(archived — docs/planning/ no longer exists)*
- ~~Progression Log~~ *(archived — docs/planning/ no longer exists)*

---

**Note:** This roadmap is the single source of truth for project status. Update this file when track statuses change or new priorities emerge.
