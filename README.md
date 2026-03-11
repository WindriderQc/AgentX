# AgentX v1.4.1

[![AgentX CI Pipeline](https://github.com/WindriderQc/AgentX/actions/workflows/ci.yml/badge.svg)](https://github.com/WindriderQc/AgentX/actions/workflows/ci.yml)
[![AgentX CD Pipeline](https://github.com/WindriderQc/AgentX/actions/workflows/cd.yml/badge.svg)](https://github.com/WindriderQc/AgentX/actions/workflows/cd.yml)

**Local-first AI platform with RAG, conversation memory, multi-model benchmarking, and continuous improvement — powered by Ollama.**

AgentX turns your local Ollama instance into a full AI operations platform: chat with knowledge augmentation (RAG), benchmark models head-to-head, manage custom models, monitor performance, and automate workflows via n8n.

---

## Key Features

- **Chat Interface** — Model selection, parameter tuning, conversation history, user profiles
- **RAG (Retrieval-Augmented Generation)** — Semantic search over your documents with citation tracking, contextual compression, and hybrid search
- **Multi-Model Benchmarking** — Run batches, judge responses, compare models with quality scoring
- **Custom Model Management** — Register, deploy, and A/B test fine-tuned models via Ollama
- **Analytics & Cost Tracking** — Usage patterns, token costs, performance metrics, trend analysis
- **Self-Healing** — Automated failover, prompt rollback, throttling, and health monitoring
- **Multi-Tenancy** — Workspace isolation with RBAC (Owner/Admin/Member/Viewer)
- **n8n Integration** — Automated document ingestion, prompt optimization, and orchestration workflows
- **Backup & Recovery** — MongoDB dumps and Qdrant snapshots with cron scheduling

---

## Quick Start

### Prerequisites

- **Node.js** 18+
- **MongoDB** (local or remote)
- **Ollama** with at least one chat model and `nomic-embed-text` for embeddings

### Install

```bash
git clone https://github.com/WindriderQc/AgentX.git
cd AgentX
npm install
```

### Configure

Create a `.env` file:

```bash
MONGODB_URI=mongodb://localhost:27017/agentx
OLLAMA_HOST=http://localhost:11434

# Optional: multi-host Ollama (for benchmark host picker)
# OLLAMA_HOST_PRIMARY=http://192.168.2.99:11434
# OLLAMA_HOST_2=http://192.168.2.12:11434

EMBEDDING_MODEL=nomic-embed-text
PORT=3080
```

### Run

```bash
npm start
# Open http://localhost:3080
```

### DataAPI (optional)

AgentX can use a companion headless tool server (DataAPI) for file scanning/search/exports. Add to `.env`:

```bash
DATAAPI_BASE_URL=http://127.0.0.1:3003
DATAAPI_API_KEY=change-me-long-random
```

See [Quick Start Guide](docs/onboarding/quickstart.md) for detailed setup.

---

## Documentation

**Start here:** [`docs/INDEX.md`](docs/INDEX.md) — complete documentation hub.

| Audience | Start With |
|----------|-----------|
| New Users | [Quick Start](docs/onboarding/quickstart.md), [User Manual](docs/user-manual/README.md) |
| Developers | [AGENTS.md](AGENTS.md), [Architecture](docs/architecture/backend-overview.md), [Testing Patterns](docs/patterns/TESTING_PATTERNS.md) |
| Operators | [Deployment](docs/operations/DEPLOYMENT.md), [SBQC Stack](docs/architecture/SBQC-Stack-Final/00-OVERVIEW.md) |
| AI Agents | [CLAUDE.md](CLAUDE.md), [Critical Conventions](docs/patterns/CRITICAL_CONVENTIONS.md) |

Key references:
- **[ROADMAP.md](ROADMAP.md)** — Project status (all 8 tracks complete)
- **[API Reference](docs/architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md)** — 40+ endpoints
- **[Critical Gotchas](docs/operations/CRITICAL_GOTCHAS.md)** — Common pitfalls

---

## Architecture

Service-Oriented Architecture: Routes (validation) → Services (orchestration) → Models (data) → MongoDB/Ollama.

```
AgentX/
├── server.js                # Express entry point
├── src/
│   ├── app.js              # Express app setup
│   ├── services/           # Business logic (chatService, ragStore, modelRouter, benchmark, ...)
│   ├── helpers/            # Pure utilities (response parsing, template cleaning)
│   └── middleware/         # Auth, workspace, performance tracking
├── routes/                 # API endpoints (thin HTTP layer)
├── models/                 # Mongoose schemas
├── config/                 # DB connection, categories, self-healing rules
├── public/                 # Frontend (HTML/JS/CSS, Bootstrap, Chart.js)
├── scripts/                # Seeding, backups, migrations
├── tests/                  # Jest unit/integration, Playwright E2E, Artillery load
├── n8n_workflows/          # Versioned n8n workflow exports
├── personas/               # Chat persona configurations
├── docs/                   # Documentation
└── reports/                # Generated validation and analysis artifacts
```

---

## Testing

```bash
npm test                     # Jest tests (unit + integration)
npm run test:unit            # Unit tests with coverage
npm run test:integration     # Integration tests
npm run test:e2e             # E2E via test-all.sh
npm run test:e2e:playwright  # Playwright browser tests
npm run test:load            # Artillery load tests
npm run test:coverage        # Full coverage report
```

---

## Deployment

Health check: `curl http://localhost:3080/health`

For PM2 production deployment, see [Deployment Guide](docs/operations/DEPLOYMENT.md).

---

## Contributing

Development workflow, git conventions, testing standards, and PR process are documented in [AGENTS.md](AGENTS.md#contributing-to-agentx).

---

## License

MIT License — See LICENSE file for details.

---

## Support

- **Documentation**: [docs/INDEX.md](docs/INDEX.md)
- **Issues**: [GitHub Issues](https://github.com/WindriderQc/AgentX/issues)
- **Architecture**: [docs/architecture/](docs/architecture/)

---

**Version**: 1.4.1 | **Status**: Production Ready | All 8 development tracks complete
