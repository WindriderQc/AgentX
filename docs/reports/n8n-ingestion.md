# AgentX V3 n8n Ingestion Workflows

This guide defines two n8n workflows that push external content into the AgentX RAG ingestion endpoint using the V3 contract snapshot. All HTTP calls target the AgentX backend without modifying backend code.

## Environment variables
Set these in n8n (global credentials or per-workflow):

- `AGENTX_BASE_URL` – e.g., `http://localhost:3080` or the deployed AgentX host.
- `AGENTX_API_KEY` – if the backend requires authentication (leave empty otherwise).
- `DOCS_FOLDER_PATH` – absolute path to the docs directory mounted in the n8n host (e.g., `/data/docs`).

## Contract snapshot (Agent A)
- **Endpoint:** `POST /api/rag/ingest`
- **Request body:**
  ```json
  {
    "source": "docs-folder",
    "path": "guides/agentx-v3.md",
    "title": "AgentX V3 Design",
    "text": "plain text here...",
    "tags": ["agentx", "docs"],
    "hash": "sha256-of-plain-text"
  }
  ```
- **Response fields used:** `status`, `documentId`, `chunkCount` (ignore extra fields). Backend deduplicates using the `hash`.

## Workflow 1: Scheduled docs folder ➜ AgentX RAG
**Name:** `Docs Folder ➜ AgentX RAG`

**Trigger:** Cron (every 60 minutes by default; adjust in node settings).

**Nodes (in order):**
1. **Cron** – schedule the sync.
2. **List Files** (Filesystem) – root `${DOCS_FOLDER_PATH}`; include subfolders.
3. **IF** – continue only when the item is a file (skip directories).
4. **Read Binary File** – load the file contents.
5. **Convert** –
   - If PDF: `PDF Extract` → text.
   - If HTML/Markdown: `HTML Extract` or `Markdown to Text`.
   - If plain text: `Binary to Text` with UTF-8.
6. **Function** – compute deterministic SHA256 of the plain text and build request payload:
   ```js
   const crypto = require('crypto');
   const text = $json["text"];
   const hash = crypto.createHash('sha256').update(text).digest('hex');
   const relativePath = $json["path"].replace(process.env.DOCS_FOLDER_PATH + '/', '');
   return [{
     source: 'docs-folder',
     path: relativePath,
     title: relativePath.split('/').pop(),
     text,
     tags: ['agentx', 'docs'],
     hash,
   }];
   ```
7. **HTTP Request** – POST to `${AGENTX_BASE_URL}/api/rag/ingest` with JSON body from previous node; add `Authorization: Bearer {{ $env.AGENTX_API_KEY }}` if required.
8. **IF** – check response status for success; route errors to logging.
9. **Set** / **Webhook** / **Email** (optional) – log `path`, `status`, `documentId`, `chunkCount`, and errors.

**Idempotency:** The backend uses `hash` to skip unchanged documents; the workflow always sends current content so repeated runs are safe.

**Scheduling tweaks:** Change the Cron expression in the trigger to increase/decrease frequency (e.g., every 30 minutes for faster updates).

## Workflow 2: Manual/ad-hoc ingestion (HTTP trigger)
**Name:** `Ad-hoc ➜ AgentX RAG`

**Trigger:** HTTP Trigger (`POST`). Accepts JSON with either `text` or `url` plus optional `title`, `tags`, and `path`.

**Nodes (in order):**
1. **HTTP Trigger** – fields: `text`, `url`, `title`, `tags`, `path` (optional).
2. **IF** – if `url` present, fetch via **HTTP Request** and extract body text (use `HTML Extract` if needed); else use provided `text`.
3. **Function** – compute SHA256 and assemble payload:
   ```js
   const crypto = require('crypto');
   const text = $json["text"];
   const hash = crypto.createHash('sha256').update(text).digest('hex');
   return [{
     source: 'manual',
     path: $json.path || 'adhoc/' + Date.now() + '.txt',
     title: $json.title || $json.path || 'Ad-hoc Submission',
     text,
     tags: $json.tags || ['adhoc'],
     hash,
   }];
   ```
4. **HTTP Request** – POST to `${AGENTX_BASE_URL}/api/rag/ingest` with JSON payload; include API key header if required.
5. **Respond to Webhook** – return backend `status`, `documentId`, `chunkCount`, or error details.

## Error handling
- Configure the HTTP Request nodes with retry on 5xx/timeouts.
- Route failed items to a notification node (Email/Slack) or write to a log file for later replay.
- Keep `source` and `path` consistent so reruns overwrite or deduplicate correctly.

## Debugging search (optional)
Add an auxiliary workflow that calls `POST /api/rag/search` with `{ "query": "..." }` to verify ingested chunks. This workflow should be manual-only to avoid load on the backend.

## Enabling/disabling
- Disable a workflow in n8n to stop its schedule without deleting it.
- To pause ingestion for maintenance, turn off the Cron node or change the schedule to a long interval.

