# AgentX Documentation Index

**Complete documentation hub for the AgentX SBQC Stack**

Last Updated: 2026-02-09

---

## Quick Start

- **[Quick Start Guide](onboarding/quickstart.md)** - Installation, setup, and first steps
- **[CLAUDE.md](../CLAUDE.md)** - Primary reference for Claude Code (start here for development)
- **[ROADMAP.md](../ROADMAP.md)** - Project status, completion tracking, and priorities
- **[CONTRIBUTING.md](../CONTRIBUTING.md)** - Development workflow, git conventions, and PR process

---

## Architecture Documentation

### Core Architecture
- **[Backend Overview](architecture/backend-overview.md)** - Service-oriented architecture overview
- **[Startup Sequence](architecture/STARTUP_SEQUENCE.md)** - Bootstrap order and initialization
- **[Model Registry](architecture/MODEL_REGISTRY.md)** - Model categorization and metadata system
- **[Model Routing](architecture/MODEL_ROUTING.md)** - Smart routing, failover, and host management

### Data & Multi-Tenancy
- **[Multi-Tenancy & Workspaces](architecture/MULTI_TENANCY.md)** - Team collaboration, RBAC, and data isolation
- **[RAG System](architecture/RAG_SYSTEM.md)** - Vector store, retrieval, and contextual compression

### Multi-Agent Systems
- **Roundtable Discussion System** — 3-agent debate with synthesis, SSE streaming, custom personas, quality scoring. See [AGENTS.md Roundtable section](../AGENTS.md#roundtable--multi-agent-discussion-system)

---

## Development Patterns

### Critical Conventions
- **[Critical Conventions](patterns/CRITICAL_CONVENTIONS.md)** - Mandatory coding patterns (Service-Oriented, Singletons, etc.)
- **[Testing Patterns](patterns/TESTING_PATTERNS.md)** - Jest, integration tests, and coverage standards
- **[Critical Gotchas](operations/CRITICAL_GOTCHAS.md)** - Known issues, pitfalls, and workarounds

---

## Operations Documentation

### System Operations
- **[Authentication](operations/AUTHENTICATION.md)** - Dual auth system (session + API keys)
- **[Response Handling](operations/RESPONSE_HANDLING.md)** - LLM response processing and streaming
- **[Benchmark System](operations/BENCHMARK_SYSTEM.md)** - Quality scoring and model evaluation
- **[Benchmark Color Theme](operations/BENCHMARK_COLOR_THEME.md)** - Level-based color system for UI
- **[Categorization Tests](operations/CATEGORIZATION_TESTS.md)** - Model category assignment and validation
- **[Enhanced Judging System Plan](operations/ENHANCED_JUDGING_SYSTEM_PLAN.md)** - Future benchmark enhancements (planning doc)

---

## Integration Documentation

### External Integrations
- **[N8N Workflows](integrations/N8N_WORKFLOWS.md)** - Automated ingestion, optimization, and orchestration

---

## User Documentation

### End-User Guides
- **[User Manual](user-manual/README.md)** - Complete user guide with UI navigation
- **[UI Pages & Navigation](user-manual/README.md#2-the-ui-pages--navigation)** - Detailed page-by-page reference

---

## Project Documentation

### Planning & Status
- **[ROADMAP.md](../ROADMAP.md)** - All 8 tracks complete, production-ready status
- **[AGENTS.md](../AGENTS.md)** - Contribution guidelines and workflow

---

## API References

### Endpoint Documentation
- Full API reference available at: [API Documentation](../ROADMAP.md#api-endpoints) (40+ endpoints documented inline)

---

## Directory Indexes

- **[API Documentation](api/README.md)** - API endpoint guides and references
- **[Architecture](architecture/README.md)** - System architecture deep dives
- **[Archives](Archives/README.md)** - Historical completed work (preserved for reference)
- **[Components](components/README.md)** - Shared UI component documentation
- **[Features](features/README.md)** - Feature-specific documentation
- **[Future](future/README.md)** - Planned features and design proposals
- **[Guides](guides/README.md)** - How-to guides and tutorials
- **[Integrations](integrations/README.md)** - External service integration guides
- **[Onboarding](onboarding/README.md)** - Getting started and setup
- **[Operations](operations/README.md)** - Operational procedures and runbooks
- **[Reports](reports/README.md)** - Generated reports and audits
- **[Reviews](reviews/README.md)** - Code and architecture reviews
- **[Testing](testing/README.md)** - Test strategies, load testing, E2E
- **[User Manual](user-manual/README.md)** - End-user documentation

---

## Additional Resources

### File Structure Overview
```
AgentX/
├── src/services/        # 60+ services (business logic, orchestration)
├── routes/              # 49 route files (API endpoints)
├── models/              # 41 Mongoose models (data layer)
├── public/              # Frontend UI (38 HTML pages, JS/CSS)
├── docs/                # Documentation (you are here)
│   ├── api/             # API endpoint guides
│   ├── architecture/    # Architecture deep dives
│   ├── Archives/        # Historical/completed work
│   ├── features/        # Feature documentation
│   ├── guides/          # How-to guides
│   ├── integrations/    # External integration guides
│   ├── operations/      # Operational procedures
│   ├── patterns/        # Development patterns
│   ├── testing/         # Test strategies
│   └── user-manual/     # End-user documentation
├── config/              # Configuration files
├── scripts/             # Utility scripts, seeding, backups
├── tests/               # Jest unit tests, E2E tests
└── personas/            # Chat persona configurations
```

### Key Technologies
- **Backend:** Node.js, Express.js, MongoDB, Mongoose
- **Frontend:** Vanilla JS, Bootstrap, Chart.js
- **LLM Integration:** Ollama (local), n8n workflows
- **Testing:** Jest, Playwright (E2E)
- **Deployment:** PM2, Docker (optional)
- **Monitoring:** Custom metrics, alerting, self-healing

---

## Getting Help

- **Issues:** Report at [GitHub Issues](https://github.com/WindriderQc/AgentX/issues)
- **Discussions:** Coming soon
- **Documentation Gaps:** File an issue with label `documentation`

---

**Navigation:** [Back to Root](../README.md) | [Quick Start](onboarding/quickstart.md) | [CLAUDE.md](../CLAUDE.md) | [ROADMAP.md](../ROADMAP.md)
