# AgentX

AgentX is a local AI platform for conversation, memory, document search, tools,
tasks and model evaluation. **Nestor** is the personal assistant;
**Household** is the family interface. Both use Core's shared capabilities.

Node.js/Express services run through Docker Compose, with MongoDB for application
data, Qdrant for vector search and Ollama for local models. AgentX runs on your
computer or private network.

## Start locally

Install Git and Docker with Compose v2, then start Docker and clone AgentX:

```bash
git clone https://github.com/WindriderQc/AgentX.git
cd AgentX
```

On Linux:

```bash
./agentx doctor
./agentx ollama-up --build
./agentx ollama-pull llama3.2:1b
./agentx health
```

On Windows, use PowerShell:

```powershell
.\agentx.ps1 doctor
.\agentx.ps1 ollama-up --build
.\agentx.ps1 ollama-pull llama3.2:1b
.\agentx.ps1 health
```

Open http://127.0.0.1:3180/, select the downloaded model in the Playground,
and send a message. Docker Ollama runs on CPU by default; GPU acceleration is
optional. No model is downloaded automatically.

The [installation guide](docs/INSTALLATION.md) covers native Ollama, GPU setup,
document retrieval, Windows and troubleshooting. To use an existing Ollama
server, configure `AGENTX_OLLAMA_HOST` and start with `up --build` instead of
`ollama-up`. You can also use `up --build` to explore before installing a model.

## Choose your capabilities

| Profile | Included capabilities |
| --- | --- |
| `demo` (default) | Chat, Ollama discovery, RAG and Benchmark |
| `full` | Adds Nestor, Household and operational surfaces |

Data is an optional inventory and telemetry service. Profiles enable capabilities
without importing personal data or installing private integrations. The full
profile groups navigation into Personnel, Famille and Atelier, with system tools
under Système. See [available features and acceptance](docs/STATUS.md).

Keep instance settings and personal content outside Git. Configure the
[private LAN HTTPS gateway](docs/PARENTAL_ACCESS.md) before access from other
devices. Human pages and APIs have no account or adult code: anyone reaching an
entry can use its human capabilities. Native integration credentials and family
memory/tool boundaries remain separate. See [personalization, storage and
backups](docs/INSTALLATION.md#personalize-your-instance-and-manage-private-data)
and [security](SECURITY.md).

## Project layout

| Directory | Responsibility |
| --- | --- |
| [`core/`](core/) | Shared APIs, interfaces, conversations, routing, tasks, memory and attachments |
| [`benchmark/`](benchmark/) | Model evaluation, scoring, comparisons and profiling |
| [`rag/`](rag/) | Document ingestion, chunking, embeddings and retrieval |
| [`data/`](data/) | Optional inventory, collectors and telemetry |
| [`shared/`](shared/) | Cross-service contracts, utilities and test infrastructure |
| [`integrations/`](integrations/) | Adapters for external runtimes, voice and operations |
| [`skills/`](skills/) | Portable capabilities and the installable `agentx` skill |

Core owns canonical application data and shared capabilities. Interfaces compose
them; external runtimes call them. Follow **interface → route → service → storage**
when exploring the code. Start at [`core/src/app.js`](core/src/app.js),
[`core/routes/`](core/routes/) and [`core/src/services/`](core/src/services/).

## Develop and verify

Development requires Node.js 24 or newer. From the repository root:

```bash
npm run setup
npm run test:prepare
npm test
npm run test:surfaces --prefix core
npm run test:shared
npm run build
npm run check:compose
```

Tests use disposable local MongoDB; preparation may download its test binary.
`npm run test:nodb` runs a pure subset and does not replace the full suites.
Passing code tests, container checks, deployment and real-device acceptance are
separate results.

Before contributing, read [Contributing](CONTRIBUTING.md), [Status](docs/STATUS.md),
[Architecture](docs/ARCHITECTURE.md), [Operations](docs/OPERATIONS.md) and
[AGENTS.md](AGENTS.md). The [architecture decisions](docs/adr/0001-one-repository.md)
define shared ownership and instance boundaries. Track modernization proposals in
[MODERNIZATION.md](MODERNIZATION.md).

The code is [MIT licensed](LICENSE). Bundled animal sounds retain their
[individual licences](core/surfaces/household/public/sounds/CREDITS.md), and the
Data Toolbox map geometry [its own](core/surfaces/data-toolbox/public/geo/CREDITS.md).
