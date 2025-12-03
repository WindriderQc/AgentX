# AgentX

Into GraphysX world, AgentX is a node.js application intended to run locally, exploiting various local instance of ollama in order to create an ecosystem of AI agents as a personal local assistant.

## Documentation Map

We have organized the documentation to help you get started quickly and then dive deep into the technical details.

### 🚀 Getting Started (Onboarding)
*   [**Quick Start Guide**](docs/onboarding/quickstart.md): Installation, setup, and your first test. Start here!
*   [**V4 Quick Reference**](docs/onboarding/v4-quick-reference.md): Specifics for V4 features.

### 🏗️ Architecture & Technical Details
*   [**Backend Overview**](docs/architecture/backend-overview.md): High-level architecture and design decisions.
*   [**Architecture Diagrams**](docs/architecture/diagrams.md): Visual representation of the system and data flows.
*   [**Database Architecture**](docs/architecture/database.md): Schema and data model details.
*   [**Specs**](specs/): Detailed architectural specifications (V3 RAG, V4 Analytics).

### 🔌 API Reference
*   [**API Reference**](docs/api/reference.md): Complete API documentation with examples.
*   [**Contracts**](docs/api/contracts/): Snapshots of API contracts for specific versions.

### 📜 History & Reports
*   [**Implementation Reports**](docs/reports/): Summaries of what was implemented in each version.
*   [**Archive**](docs/archive/): Old plans, reports, and deprecated documentation.

## What’s here

- Local Node.js server on port `3080` that proxies requests to your Ollama instance(s).
- Rich chat interface inspired by the DataAPI AI control view: model picker, system prompt, sliders for temperature/top‑p/top‑k, context length, stop sequences, keep-alive, streaming toggle, and more.
- Quick actions, message counters, session log viewer, feedback controls, and saved defaults in `localStorage`.
- Profile (memory) editor wired to `/api/profile` plus feedback posting through `/api/feedback` for each assistant reply.

## Quick Install

1. Install dependencies (Node.js 18+ recommended):
   ```bash
   npm install
   ```
2. Start the UI on port 3080:
   ```bash
   npm start
   ```
3. Open `http://localhost:3080`.

See [Quick Start Guide](docs/onboarding/quickstart.md) for more details.
