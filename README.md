# AgentX

Into GraphysX world, AgentX is a node.js application intended to run locally, exploiting various local instance of ollama in order to create an ecosystem of AI agents as a personal local assistant.

## What’s here

- Local Node.js server on port `3080` that proxies requests to your Ollama instance(s).
- Rich chat interface inspired by the DataAPI AI control view: model picker, system prompt, sliders for temperature/top‑p/top‑k, context length, stop sequences, keep-alive, streaming toggle, and more.
- Quick actions, message counters, session log viewer, feedback controls, and saved defaults in `localStorage`.
- Profile (memory) editor wired to `/api/profile` plus feedback posting through `/api/feedback` for each assistant reply.

## Getting started

1. Install dependencies (Node.js 18+ recommended):
   ```bash
   npm install
   ```
2. Start the UI on port 3080:
   ```bash
   npm start
   ```
3. Open `http://localhost:3080` in your browser. Point the host/port fields at a reachable Ollama service (defaults to `localhost:11434`) and select a model.

## Notes

- The server forwards `/api/ollama/models` and `/api/ollama/chat` to the target Ollama host; no data leaves your network.
- Options are sanitized before calling Ollama, but invalid hosts or ports will surface as connection errors in the UI.
- For RAG ingestion via n8n, see `docs/n8n-ingestion.md` for scheduled and ad-hoc workflows that call the V3 `/api/rag/ingest` contract.
