# AgentX Documentation Index

**Primary documentation hub for the AgentX codebase**

Last Updated: 2026-03-21

---

## Quick Start

- **[Quick Start Guide](onboarding/quickstart.md)** - Installation, setup, and first steps
- **[CLAUDE.md](../CLAUDE.md)** - Primary reference for Claude Code (start here for development)
- **[ROADMAP.md](../ROADMAP.md)** - Project status, completion tracking, and priorities
- **[CONTRIBUTING.md](../CONTRIBUTING.md)** - Development workflow, git conventions, and PR process

---

## Architecture Documentation

### Core Architecture
- **[Backend Overview](architecture/backend-overview.md)** - Current runtime architecture, route families, and platform boundaries
- **[Startup Sequence](architecture/STARTUP_SEQUENCE.md)** - Bootstrap order and initialization
- **[Model Registry](architecture/MODEL_REGISTRY.md)** - Model categorization and metadata system
- **[Model Routing](architecture/MODEL_ROUTING.md)** - Smart routing, failover, and host management

### Data & Multi-Tenancy
- **[Multi-Tenancy & Workspaces](architecture/MULTI_TENANCY.md)** - Team collaboration, RBAC, and data isolation
- **[RAG System](architecture/RAG_SYSTEM.md)** - Vector store, retrieval, and contextual compression

### Multi-Agent Systems
- **Roundtable Discussion System** — 3-agent debate with synthesis, SSE streaming, custom personas, quality scoring. See [AGENTS.md Roundtable section](../AGENTS.md#roundtable--multi-agent-discussion-system)

### Automation
- **[SpecialX](architecture/SPECIALX.md)** - Queue-driven specialist task profiles, runner lifecycle, API surface, and operator UI

---

## Development Patterns

### Critical Conventions
- **[Critical Conventions](patterns/CRITICAL_CONVENTIONS.md)** - Mandatory coding patterns and environment rules
- **[Testing Patterns](patterns/TESTING_PATTERNS.md)** - Jest, integration tests, and coverage standards
- **[Critical Gotchas](operations/CRITICAL_GOTCHAS.md)** - Known issues, pitfalls, and workarounds

---

## Operations Documentation

### System Operations
- **[Operations Hub](operations/README.md)** - Main runbook entry point
- **[Authentication](operations/AUTHENTICATION.md)** - Dual auth system (session + API keys)
- **[Deployment](operations/DEPLOYMENT.md)** - Runtime and deployment guidance
- **[Response Handling](operations/RESPONSE_HANDLING.md)** - LLM response processing and streaming
- **[Benchmark System](operations/BENCHMARK_SYSTEM.md)** - Quality scoring and model evaluation
- **[Categorization Tests](operations/CATEGORIZATION_TESTS.md)** - Model category assignment and validation

---

## Integration Documentation

### External Integrations
- **[N8N Workflows](integrations/N8N_WORKFLOWS.md)** - Automated ingestion, optimization, and orchestration

---

## User Documentation

### End-User Guides
- **[User Manual](user-manual/README.md)** - Complete user guide with UI navigation
- **[Frontend UI Inventory](consolidation/04-FRONTEND-UI.md)** - Current page inventory verified from `public/` and `nav.js`

---

## Project Documentation

### Planning & Status
- **[ROADMAP.md](../ROADMAP.md)** - Project status and current roadmap narrative
- **[Documentation Consolidation](consolidation/00-OVERVIEW.md)** - Inventory, mapping, permanent-doc set, and cleanup record

---

## API References

### Endpoint Documentation
- **[API README](api/README.md)** - API documentation hub
- **[API Reference](api/reference.md)** - Reference-style API documentation
- **[SBQC AgentX API Reference](architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md)** - Stack-oriented API reference

---

## Directory Indexes

- **[API Documentation](api/README.md)** - API endpoint guides and references
- **[Architecture](architecture/README.md)** - System architecture deep dives
- **[Archive](archive/README.md)** - Historical and superseded docs
- **[Components](components/README.md)** - Shared UI component documentation
- **[Consolidation](consolidation/00-OVERVIEW.md)** - Documentation inventory, mapping, and cleanup
- **[Future](future/README.md)** - Planned features and design proposals
- **[Guides](guides/README.md)** - How-to guides and tutorials
- **[Integrations](integrations/README.md)** - External service integration guides
- **[Onboarding](onboarding/README.md)** - Getting started and setup
- **[Operations](operations/README.md)** - Operational procedures and runbooks
- **[Services](services/chat/README.md)** - Domain service documentation set
- **[Testing](testing/README.md)** - Test strategies, load testing, E2E
- **[User Manual](user-manual/README.md)** - End-user documentation

---

## Additional Resources

### File Structure Overview
```
AgentX/
├── src/services/        # 60+ services (business logic, orchestration)
├── routes/              # 55 route files (API endpoints)
├── models/              # 52 Mongoose models (data layer)
├── public/              # Frontend UI (42 HTML pages, JS/CSS)
├── docs/                # Documentation (you are here)
│   ├── api/             # API endpoint guides
│   ├── archive/         # Historical/completed work
│   ├── architecture/    # Architecture deep dives
│   ├── consolidation/   # Documentation audit and cleanup records
│   ├── guides/          # How-to guides
│   ├── integrations/    # External integration guides
│   ├── operations/      # Operational procedures
│   ├── patterns/        # Development patterns
│   ├── services/        # Service/domain docs
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

## Maintenance Notes

- The permanent docs set is described in [consolidation/03-PERMANENT-DOCS.md](consolidation/03-PERMANENT-DOCS.md).
- Historical one-off docs are moved to [archive/README.md](archive/README.md).

---

**Navigation:** [Back to Root](../README.md) | [Quick Start](onboarding/quickstart.md) | [Architecture](architecture/README.md) | [Operations](operations/README.md)
