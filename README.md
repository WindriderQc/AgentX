# AgentX

AgentX is a local AI platform that brings conversation, memory, documents,
tools, tasks and model evaluation together. Chat with Ollama models, search
your documents and compare model quality in one place.

**Nestor is the personal assistant; Household is the family interface.** Both
use Core's shared capabilities. Other deployments use the same repository with
the capabilities they enable.

The common home at `/` offers Personnel, Famille and Atelier in the full profile.
The same navigation connects surfaces and services, with system tools behind
Système. The demo profile shows only its enabled capabilities.

One repository contains several Node.js/Express services, each with its own
dependencies and tests. Docker Compose runs them together through one launcher.

| Directory | Role | When to work here |
| --- | --- | --- |
| [`core/`](core/) | APIs, interfaces, conversations, model routing, tasks, memory and attachments | Shared capabilities and user-facing behavior |
| [`benchmark/`](benchmark/) | Evaluation, scoring, leaderboards and model profiling | Measuring model quality and performance |
| [`rag/`](rag/) | Document ingestion, chunking, embeddings and retrieval | Finding knowledge useful to an answer |
| [`data/`](data/) | Optional inventory and telemetry service | Collectors and system observations |
| [`shared/`](shared/) | Contracts, utilities and shared test infrastructure | Code used by multiple services |
| [`integrations/`](integrations/) | Adapters for OpenClaw, voice, operations and external tools | Connecting an external system |
| [`skills/`](skills/) | Portable content authoring and validation capabilities, and the operator skill Core serves at `/api/operator-skill/download` | Capabilities consumers invoke explicitly |

**Core owns the canonical application data and shared capabilities.** Interfaces
compose them; external integrations call them. A new interface uses Core's
conversation and task storage rather than creating its own.

MongoDB stores application data, Qdrant provides vector search, and Ollama serves
the configured models. AgentX runs locally or on a private network. See
[status](docs/STATUS.md) for available features and outstanding acceptance.
The [agents, personalities and voice reference](docs/AGENTS_AND_VOICE.md)
explains selection, execution attribution, speech fallback and qualification.

## Start locally

You need Git and Docker with Compose v2. Start Docker, then clone the repository:

```bash
git clone https://github.com/WindriderQc/AgentX.git
cd AgentX
```

On Linux, start AgentX and its isolated Docker Ollama, then download one small
chat model explicitly:

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
and send your first message. This Docker Ollama setup runs on CPU by default;
GPU acceleration is optional. Node.js 24 or newer is needed for development,
not for this Docker installation.

**[Installation guide](docs/INSTALLATION.md)** covers native Ollama, GPU setup,
document retrieval, Windows and troubleshooting. Already have an Ollama server?
Configure `AGENTX_OLLAMA_HOST` and use `up --build` instead of `ollama-up`.
You can also start with `up --build` to explore the interface before installing
any model. No model is downloaded automatically.

The default `demo` profile includes chat, Ollama discovery, RAG and Benchmark.
The `full` profile adds Nestor, Household and operational surfaces; Data is
optional. Neither profile imports personal data or installs a private integration.
See the guide before enabling family access or private content.
[Personalization and private data](docs/INSTALLATION.md#personalize-your-instance-and-manage-private-data)
explains instance settings, storage, backups and cleanup.

## Explore the code

Start with these entry points:

- [`core/server.js`](core/server.js): startup, MongoDB connection, initialization and shutdown.
- [`core/src/app.js`](core/src/app.js): Express application and middleware assembly.
- [`core/routes/chat.js`](core/routes/chat.js) and [`chatService.js`](core/src/services/chatService.js): chat API and orchestration.
- [`core/models/`](core/models/) and [`core/src/services/`](core/src/services/): persisted models and application logic.
- [`core/surfaces/`](core/surfaces/): specialized interfaces, including Household and PsyX.
- [`core/public/`](core/public/) and each surface's `public/` directory: browser JavaScript and styles.

Follow **interface → HTTP route → service → storage or external service**, then
read the corresponding tests. For surface conversations, see
[`surfaceConversationService.js`](core/src/services/surfaceConversationService.js);
for attachments, see
[`conversationAttachmentService.js`](core/src/services/conversationAttachmentService.js).

## Develop and verify

```bash
npm run setup
npm run test:prepare
npm test
npm run test:surfaces --prefix core
npm run test:shared
npm run build
npm run check:compose
```

Tests use disposable local MongoDB, never a production database. Mongo preparation
may download its test binary. `npm run test:nodb` is a useful pure subset, not a
replacement for the full suites. Passing tests validate code; they do not prove
a successful deployment or real-phone behavior. Details:
[operations](docs/OPERATIONS.md).

Before contributing, read this README, [Status](docs/STATUS.md),
[Architecture](docs/ARCHITECTURE.md) and [Operations](docs/OPERATIONS.md), in that
order. Preserve personal, family and child access boundaries and the existing
stack. Record modernization proposals in [MODERNIZATION.md](MODERNIZATION.md).

Human pages and APIs use [private LAN HTTPS](docs/PARENTAL_ACCESS.md) without
an account or adult code; anyone reaching an entry can use human capabilities.
Native integration tokens and family memory/tool boundaries remain separate.
[Local voice identification](docs/VOICE_ID.md) is a proposed next step, not delivered.

See [execution sources](docs/EXECUTION_SOURCES.md) for local direct and OpenClaw model/agent execution.

AgentX runs locally or on your LAN. Keep runtime secrets, instance configuration
and personal content outside Git. The code is [MIT licensed](LICENSE); bundled
animal sounds retain their [individual licences](core/surfaces/household/public/sounds/CREDITS.md),
and the Data Toolbox world map geometry [its own](core/surfaces/data-toolbox/public/geo/CREDITS.md).

[Status](docs/STATUS.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Operations](docs/OPERATIONS.md) · [Decisions](docs/adr/0001-one-repository.md) ·
[Modernization candidates](MODERNIZATION.md)

[Operational screens](docs/OPERATOR_UI.md) explains Pipeline admission conditions,
Nerve Center GPU residency and Profiler runtime continuity, with links to their
operator procedures.

The existing information levels are reused across Core and RAG. Personal Nestor
is intended to consult the owner's full information; family/child surfaces keep
their existing restrictions. [Decision and implementation limits](docs/adr/0002-memory-access.md).
