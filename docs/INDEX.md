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

### Automation
- **[SpecialX — Bounded Automation Agents](architecture/SPECIALX.md)** - Queue-driven task execution, profiles, runner, scheduling, and maintenance mesh integration
- **[SpecialX — Bounded Automation Agents](architecture/SPECIALX.md)** - Queue-driven task profiles, runner lifecycle, scheduling, and maintenance mesh integration

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
- [AgentX API Reference](architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md) - Canonical endpoint reference for the current platform.
- [API README](api/README.md) - Additional API guides and related references.

---

## Directory Indexes

- **[API Documentation](api/README.md)** - API endpoint guides and references
- **[Architecture](architecture/README.md)** - System architecture deep dives
- **[Components](components/README.md)** - Shared UI component documentation
- **[Future](future/README.md)** - Planned features and design proposals
- **[Guides](guides/README.md)** - Troubleshooting, self-healing, and RAG operations guides
- **[Integrations](integrations/README.md)** - External service integration guides
- **[Onboarding](onboarding/README.md)** - Getting started and setup
- **[Operations](operations/README.md)** - Operational procedures and runbooks
- **[Plans](plans/BENCHMARK_QUALITY_PLAN.md)** - Active implementation and quality plans
- **[Services](services/chat/README.md)** - Service-area documentation hubs
- **[Testing](testing/README.md)** - Test strategies, load testing, and E2E references
- **[User Manual](user-manual/README.md)** - End-user documentation

---

## Additional Resources

### File Structure Overview
```
AgentX/
├── src/services/        # Business logic and orchestration
├── routes/              # API endpoints
├── models/              # Mongoose schemas and persistence layer
├── public/              # Frontend UI (HTML, JS, CSS)
├── docs/                # Documentation (you are here)
│   ├── api/             # API endpoint guides
│   ├── architecture/    # Architecture deep dives
│   ├── guides/          # Troubleshooting and operator guides
│   ├── integrations/    # External integration guides
│   ├── operations/      # Operational procedures
│   ├── patterns/        # Development patterns
│   ├── plans/           # Active plans and implementation notes
│   ├── services/        # Service-area documentation hubs
│   ├── testing/         # Test documentation entry points
│   └── user-manual/     # End-user documentation
├── config/              # Configuration files
├── scripts/             # Utility scripts, seeding, backups
├── tests/               # Jest unit tests, E2E tests
├── n8n_workflows/       # Versioned n8n workflow exports in the repo
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
