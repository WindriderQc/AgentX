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
- Backend overview: [architecture/backend-overview.md](architecture/backend-overview.md)
- Database: [architecture/database.md](architecture/database.md)
- Diagrams: [architecture/diagrams.md](architecture/diagrams.md)

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
- Security hardening: [SECURITY_HARDENING.md](SECURITY_HARDENING.md)
- Authentication: [AUTHENTICATION.md](AUTHENTICATION.md)

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
- Latest validation report: [VALIDATION_REPORT_2026-01-03.md](VALIDATION_REPORT_2026-01-03.md)

## Feature Alignment & Coverage
- Feature alignment dashboard: `/public/feature-alignment.html` (Track 8, in development)
- Priority algorithm documentation: [FEATURE_ALIGNMENT_PRIORITY_ALGORITHM.md](FEATURE_ALIGNMENT_PRIORITY_ALGORITHM.md)
- Orphan endpoints analysis: [ORPHAN_ENDPOINTS_ANALYSIS.md](../ORPHAN_ENDPOINTS_ANALYSIS.md)
- External agent recommendations: [EXTERNAL_AGENT_RECOMMENDATIONS.md](../EXTERNAL_AGENT_RECOMMENDATIONS.md)
- Feature alignment fix summary: [FEATURE_ALIGNMENT_FIX_SUMMARY.md](../FEATURE_ALIGNMENT_FIX_SUMMARY.md)

## Multi-Tenancy & Workspaces (Track 7)
- Implementation complete - see ROADMAP.md Track 7 section
- Workspace models: `Workspace`, `WorkspaceMember` with RBAC
- Workspace audit logging: `WorkspaceAuditLog` with 15 tracked actions
- Frontend integration: workspace switcher + settings UI
- Historical progress reports: [archive/progress-reports/](archive/progress-reports/) (WEEK4_*.md files)

## Reports & Archive
- Active scanner reports: [../reports/](../reports/)
  - `feature-alignment.json` - Current feature coverage scan
  - `feature-alignment-actions.md` - Actionable recommendations
- Historical documentation: [archive/](archive/)
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
