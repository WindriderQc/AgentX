# AgentX Documentation Index

**Purpose:** This is the canonical “start here” index for permanent AgentX documentation.

## Start Here

**Primary References:**
- **[CLAUDE.md](../CLAUDE.md)** - Architecture reference for agents and humans
  - Commands, architecture patterns, core components, critical conventions
  - Service-oriented architecture, RAG system, model routing, self-healing
- **[CONTRIBUTING.md](../CONTRIBUTING.md)** - Developer workflow and contribution guidelines
  - Git conventions, testing standards, PR process, code review checklist
- **[ROADMAP.md](../ROADMAP.md)** - Project status and priorities
  - Seven development tracks (all complete, including Week 4 multi-tenancy)
  - Immediate priorities and backlog items

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
- Troubleshooting: [TROUBLESHOOTING_README.md](TROUBLESHOOTING_README.md)
- Alerts integration verification: [testing/ALERTS_INTEGRATION_VERIFICATION.md](testing/ALERTS_INTEGRATION_VERIFICATION.md)
- Latest validation report: [VALIDATION_REPORT_2026-01-03.md](VALIDATION_REPORT_2026-01-03.md)

## Week 4 Progress (Multi-Tenancy & Workspaces)
- Week 4 complete summary: [WEEK4_COMPLETE_SUMMARY.md](../WEEK4_COMPLETE_SUMMARY.md)
- Day 1: Data models & architecture: [WEEK4_DAY1_PROGRESS.md](../WEEK4_DAY1_PROGRESS.md)
- Day 2: Backend API & middleware: [WEEK4_DAY2_PROGRESS.md](../WEEK4_DAY2_PROGRESS.md)
- Day 3: UI integration: [WEEK4_DAY3_PROGRESS.md](../WEEK4_DAY3_PROGRESS.md)
- Day 4: Settings UI & testing: [WEEK4_DAY4_PROGRESS.md](../WEEK4_DAY4_PROGRESS.md)
- Post-Week 4 progress: [POST_WEEK4_PROGRESS.md](../POST_WEEK4_PROGRESS.md)

## Reports & Archive
- Reports (historical, but kept for reference): [reports/](reports/)
- Archive (deprecated / superseded docs): [archive/](archive/)

## Repo-Level References (Permanent)
- Changelog (repo root): [CHANGELOG.md](../CHANGELOG.md)
- Performance system implementation notes (repo root): [PERFORMANCE_SYSTEM_IMPLEMENTATION.md](../PERFORMANCE_SYSTEM_IMPLEMENTATION.md)
- Setup snapshot (repo root): [SETUP_COMPLETE.md](../SETUP_COMPLETE.md)

---

### Conventions
- **Permanent docs** live under this folder (this index is the entrypoint).
- **Roadmap/todos** live under [planning/](planning/).
- **Time-stamped status/validation** documents belong under [reports/](reports/) or [archive/](archive/).
