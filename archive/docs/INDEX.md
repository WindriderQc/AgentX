# AgentX Documentation Index

**Purpose:** This is the canonical “start here” index for permanent AgentX documentation.

## Start Here

**Primary References:**
- **[CLAUDE.md](../CLAUDE.md)** - Architecture reference for agents and humans
  - Commands, architecture patterns, core components, critical conventions
  - Service-oriented architecture, RAG system, model routing, self-healing
- **[ROADMAP.md](../ROADMAP.md)** - Project status and priorities
  - Eight development tracks (7 complete, Track 8 Feature Alignment in progress)
  - Immediate priorities and next steps

**Documentation:**
- User manual (recommended): [user-manual/README.md](user-manual/README.md)
- UI pages map (URLs + what each page does): [user-manual/README.md#2-the-ui-pages--navigation](user-manual/README.md#2-the-ui-pages--navigation)
- SBQC Stack overview (recommended): [SBQC-Stack-Final/00-OVERVIEW.md](SBQC-Stack-Final/00-OVERVIEW.md)
- AgentX architecture (stack doc): [SBQC-Stack-Final/01-ARCHITECTURE.md](SBQC-Stack-Final/01-ARCHITECTURE.md)
- AgentX API reference (stack doc): [SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md](SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md)
- DataAPI tasks (stack doc): [SBQC-Stack-Final/02-DATAAPI-TASKS.md](SBQC-Stack-Final/02-DATAAPI-TASKS.md)

## Onboarding
- Onboarding hub: [onboarding/README.md](onboarding/README.md)
- Quick start: [onboarding/quickstart.md](onboarding/quickstart.md)
- n8n deployment: [onboarding/n8n-deployment.md](onboarding/n8n-deployment.md)

## Architecture

**Core Architecture Documentation:**
- **[Multi-Tenancy & Workspaces](architecture/MULTI_TENANCY.md)** - Team collaboration, RBAC, data isolation
- **[Model Registry](architecture/MODEL_REGISTRY.md)** - Model categorization, 7-tier category system
- **[RAG System](architecture/RAG_SYSTEM.md)** - Vector store, retrieval, Qdrant integration
- **[Model Routing](architecture/MODEL_ROUTING.md)** - Smart routing, failover, persistent state
- **[Startup Sequence](architecture/STARTUP_SEQUENCE.md)** - Bootstrap order, graceful degradation

**Foundation:**
- Backend overview: [architecture/backend-overview.md](architecture/backend-overview.md)
- Database: [architecture/database.md](architecture/database.md)
- Diagrams: [architecture/diagrams.md](architecture/diagrams.md)

## Integrations

External system integrations and automation workflows:

- **[N8N Workflows](integrations/N8N_WORKFLOWS.md)** - Document ingestion, prompt optimization

## Patterns & Conventions

Mandatory coding patterns and testing standards:

- **[Critical Conventions](patterns/CRITICAL_CONVENTIONS.md)** - Error handling, logging, environment variables
- **[Testing Patterns](patterns/TESTING_PATTERNS.md)** - Jest config, integration tests, coverage standards

## Operations (Procedures & Systems)

Operational guides and troubleshooting:

- **[Authentication](operations/AUTHENTICATION.md)** - Dual auth system, API keys
- **[Response Handling](operations/RESPONSE_HANDLING.md)** - LLM response processing
- **[Benchmark System](operations/BENCHMARK_SYSTEM.md)** - Quality scoring, category filtering
- **[Critical Gotchas](operations/CRITICAL_GOTCHAS.md)** - Known issues, pitfalls

## API
- API reference: [api/reference.md](api/reference.md)
- Contracts: [api/contracts/](api/contracts/)
- Integration examples: [INTEGRATION_EXAMPLES.md](INTEGRATION_EXAMPLES.md)

## Operations (Deployment, Runtimes, RAG storage)
- Deployment (stack doc): [SBQC-Stack-Final/05-DEPLOYMENT.md](SBQC-Stack-Final/05-DEPLOYMENT.md)
- Qdrant deployment: [QDRANT_DEPLOYMENT.md](QDRANT_DEPLOYMENT.md)
- Runner management: [RUNNER_MANAGEMENT.md](RUNNER_MANAGEMENT.md)
- CI/CD setup (repo root): [CI_CD_SETUP.md](../CI_CD_SETUP.md)
- Deployment notes (repo root): [DEPLOYMENT.md](../DEPLOYMENT.md)

## Security
- **Security status report** ✅ NEW: [SECURITY_STATUS_REPORT.md](../SECURITY_STATUS_REPORT.md) (400+ lines, comprehensive audit, production-ready)
- Security hardening: [SECURITY_HARDENING.md](SECURITY_HARDENING.md)
- Authentication (implementation details): [AUTHENTICATION_IMPLEMENTATION_DETAILS.md](AUTHENTICATION_IMPLEMENTATION_DETAILS.md)
- Authentication (quick reference): [operations/AUTHENTICATION.md](operations/AUTHENTICATION.md)

## Feature Deep Dives
- Cost tracking start: [COST_TRACKING_START_HERE.md](COST_TRACKING_START_HERE.md)
- Cost tracking index: [COST_TRACKING_INDEX.md](COST_TRACKING_INDEX.md)
- Self-healing quick start: [SELF_HEALING_QUICK_START.md](SELF_HEALING_QUICK_START.md)
- Alerts dashboard: [ALERTS_DASHBOARD_IMPLEMENTATION.md](ALERTS_DASHBOARD_IMPLEMENTATION.md)
- Benchmark quality scoring + dashboard: [BENCHMARK_QUALITY_SCORING.md](BENCHMARK_QUALITY_SCORING.md)
- RAG search features: [features/RAG_SEARCH_FEATURES.md](features/RAG_SEARCH_FEATURES.md)
- RAG metrics guide (ingestion monitoring): [RAG_METRICS_GUIDE.md](RAG_METRICS_GUIDE.md)

## Testing & Validation
- Testing hub: [testing/README.md](testing/README.md)
- Bugs (intake + prevention rules): [bugs/INDEX.md](bugs/INDEX.md)
- Troubleshooting: [TROUBLESHOOTING_README.md](TROUBLESHOOTING_README.md)
- Alerts integration verification: [testing/ALERTS_INTEGRATION_VERIFICATION.md](testing/ALERTS_INTEGRATION_VERIFICATION.md)
- Historical validation reports: [archive/validation-reports/](archive/validation-reports/)

## Feature Alignment & Coverage (Track 8)

**Phase 1: Dashboard** ✅ COMPLETE
- Feature alignment dashboard: http://localhost:3080/feature-alignment.html (Production-ready)
- Dashboard user guide: [FEATURE_ALIGNMENT_DASHBOARD_GUIDE.md](FEATURE_ALIGNMENT_DASHBOARD_GUIDE.md) (320+ lines)
- Phase 1 completion report: [FEATURE_ALIGNMENT_DASHBOARD_COMPLETE.md](../FEATURE_ALIGNMENT_DASHBOARD_COMPLETE.md)
- Priority algorithm documentation: [FEATURE_ALIGNMENT_PRIORITY_ALGORITHM.md](FEATURE_ALIGNMENT_PRIORITY_ALGORITHM.md)

**Phase 2: UI Development** 🔄 IN PROGRESS (99% Complete)
- Feature prioritization analysis: [FEATURE_PRIORITIZATION_ANALYSIS.md](../FEATURE_PRIORITIZATION_ANALYSIS.md) (350+ lines)
- Phase 2 progress tracking: [TRACK_8_PHASE_2_PROGRESS.md](../TRACK_8_PHASE_2_PROGRESS.md)
- Invitation acceptance UI: `/public/accept-invitation.html` (Completed 2026-01-07) ✅
- UAT guide (invitations): [UAT_INVITATION_ACCEPTANCE.md](../UAT_INVITATION_ACCEPTANCE.md)
- Demand validation survey: [DEMAND_VALIDATION_SURVEY.md](../DEMAND_VALIDATION_SURVEY.md)

**External Agent Task Specifications:**
- API workspace integration: [EXTERNAL_AGENT_NEXT_API_WORKSPACE_INTEGRATION.md](../EXTERNAL_AGENT_NEXT_API_WORKSPACE_INTEGRATION.md) (Completed) ✅
- Invitation UI task: [EXTERNAL_AGENT_NEXT_INVITATION_UI.md](../EXTERNAL_AGENT_NEXT_INVITATION_UI.md) (Completed) ✅
- Scanner confidence scoring: [EXTERNAL_AGENT_NEXT_SCANNER_CONFIDENCE.md](../EXTERNAL_AGENT_NEXT_SCANNER_CONFIDENCE.md) (Completed) ✅
- Scanner improvements: [EXTERNAL_AGENT_NEXT_SCANNER_IMPROVEMENTS.md](../EXTERNAL_AGENT_NEXT_SCANNER_IMPROVEMENTS.md) (Completed) ✅

**Historical (Phase 0-1):**
- Orphan endpoints analysis: [ORPHAN_ENDPOINTS_ANALYSIS.md](../ORPHAN_ENDPOINTS_ANALYSIS.md)
- External agent recommendations: [EXTERNAL_AGENT_RECOMMENDATIONS.md](../EXTERNAL_AGENT_RECOMMENDATIONS.md)
- Data mapping fix summary: [FEATURE_ALIGNMENT_FIX_SUMMARY.md](../FEATURE_ALIGNMENT_FIX_SUMMARY.md)

## Multi-Tenancy & Workspaces (Track 7)
- Implementation complete - see ROADMAP.md Track 7 section
- Workspace models: `Workspace`, `WorkspaceMember` with RBAC
- Workspace audit logging: `WorkspaceAuditLog` with 15 tracked actions
- Frontend integration: workspace switcher + settings UI
- Workspace API integration: [WORKSPACE_API_GUIDE.md](WORKSPACE_API_GUIDE.md) - 60+ endpoints workspace-aware ✅
- Workspace API completion report: [WORKSPACE_API_INTEGRATION_COMPLETE.md](../WORKSPACE_API_INTEGRATION_COMPLETE.md)
- Workspace API testing checklist: [WORKSPACE_API_TESTING_CHECKLIST.md](../WORKSPACE_API_TESTING_CHECKLIST.md)
- Historical progress reports: [archive/progress-reports/](archive/progress-reports/) (WEEK4_*.md files)

## RAG Advanced Options (Track 8 Phase 2)

**Completed RAG Enhancements:**
- RAG advanced options implementation: [RAG_ADVANCED_OPTIONS_IMPLEMENTATION.md](../RAG_ADVANCED_OPTIONS_IMPLEMENTATION.md) - Completed 2026-01-08 ✅
  - Query expansion, hybrid search, re-ranking, top-K controls
  - localStorage persistence for user preferences
- RAG citation tracking: [RAG_CITATIONS_IMPLEMENTATION.md](../RAG_CITATIONS_IMPLEMENTATION.md) - Completed 2026-01-08 ✅
  - Citation markers ([1], [2]) in responses
  - Interactive source highlighting
  - Database persistence (ragSources field)
- RAG testing guide: [RAG_TESTING_GUIDE.md](../RAG_TESTING_GUIDE.md)
- RAG UX enhancement report: [RAG_UX_ENHANCEMENT_REPORT.md](../RAG_UX_ENHANCEMENT_REPORT.md) - Completed 2026-01-08 ✅

**Next RAG Enhancement (Spec Ready):**
- RAG contextual compression: [EXTERNAL_AGENT_NEXT_RAG_CONTEXTUAL_COMPRESSION.md](../EXTERNAL_AGENT_NEXT_RAG_CONTEXTUAL_COMPRESSION.md) (900+ lines)
  - 40-60% token savings via LLM sentence extraction
  - Cost reduction and quality improvement
  - Ready for external agent implementation

**External Agent Task Specifications:**
- RAG UI controls task: [EXTERNAL_AGENT_NEXT_RAG_UI_CONTROLS.md](../EXTERNAL_AGENT_NEXT_RAG_UI_CONTROLS.md) (Completed) ✅
- RAG citations task: [EXTERNAL_AGENT_NEXT_RAG_CITATIONS.md](../EXTERNAL_AGENT_NEXT_RAG_CITATIONS.md) (Completed) ✅
- RAG contextual compression task: [EXTERNAL_AGENT_NEXT_RAG_CONTEXTUAL_COMPRESSION.md](../EXTERNAL_AGENT_NEXT_RAG_CONTEXTUAL_COMPRESSION.md) (Ready) ⚡

## Reports & Archive

**Session Summaries:**
- [SESSION_SUMMARY_2026-01-08.md](../SESSION_SUMMARY_2026-01-08.md) - Extended session summary (630+ lines)
  - 3 external agent completions (Workspace API, RAG UI Controls, RAG Citations)
  - Navigation improvements (100% coverage achieved)
  - RAG feature pipeline progress (Phases 1-3 complete)
  - Security status documentation
  - Total: 36-52 hours of external agent work, 38+ files modified

**Active Scanner Reports:**
- [../reports/](../reports/)
  - `feature-alignment.json` - Current feature coverage scan
  - `feature-alignment-actions.md` - Actionable recommendations
  - `low-confidence-review-2026-01.md` - Low-confidence feature analysis
  - `frontend-signal-investigation-2026-01.md` - Scanner detection improvements

**Historical Documentation:**
- [archive/](archive/)
  - [archive/progress-reports/](archive/progress-reports/) - Weekly progress (WEEK1-4)
  - [archive/validation-reports/](archive/validation-reports/) - Phase validations
  - [archive/planning/](archive/planning/) - Historical plans and completion reports
  - [archive/README.md](archive/README.md) - Archive guide

## Repo-Level References (Permanent)
- Changelog (repo root): [CHANGELOG.md](../CHANGELOG.md)
- CI/CD setup (repo root): [CI_CD_SETUP.md](../CI_CD_SETUP.md)
- Deployment notes (repo root): [DEPLOYMENT.md](../DEPLOYMENT.md)
- Implementation plan (repo root): [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)

---

### Conventions
- **Permanent docs** live under this folder (this index is the entrypoint).
- **Roadmap/todos** live under [planning/](planning/).
- **Time-stamped status/validation** documents belong under [reports/](reports/) or [archive/](archive/).
