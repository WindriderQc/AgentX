# AgentX Documentation Index

**Complete documentation hub for the AgentX SBQC Stack**

Last Updated: 2026-01-22

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
- **[CONTRIBUTING.md](../CONTRIBUTING.md)** - Contribution guidelines and workflow

---

## API References

### Endpoint Documentation
- Full API reference available at: [API Documentation](../ROADMAP.md#api-endpoints) (40+ endpoints documented inline)

---

## Additional Resources

### File Structure Overview
```
AgentX/
├── src/services/        # 39 services (business logic, orchestration)
├── routes/              # 40 route files (API endpoints)
├── models/              # 38 Mongoose models (data layer)
├── public/              # Frontend UI (HTML/JS/CSS)
├── docs/                # Documentation (you are here)
│   ├── architecture/    # Architecture deep dives
│   ├── patterns/        # Development patterns
│   ├── operations/      # Operational procedures
│   ├── integrations/    # External integration guides
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
