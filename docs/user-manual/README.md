# AgentX User Manual (SBQC Stack)

**Last updated:** 2026-02-09

**Audience:** operators and admins using the SBQC stack through AgentX.

**Goal:** help you succeed quickly, then confidently run the system day-to-day.

**System roles (one sentence each):**
- **AgentX**: the primary UI + orchestrator (system-of-record for the SBQC stack).
- **DataAPI**: a headless tool server used by AgentX (your browser typically never calls it directly).

---

## Start Here (If You Read Only One Page)

1. Use AgentX as the “front door”.
2. Verify the stack is healthy before debugging workflows.
3. Iterate in small steps: run → observe → adjust.

Canonical documentation hubs:
- AgentX docs index: [docs/INDEX.md](../INDEX.md)
- Stack overview (architecture + how pieces fit): [SBQC-Stack-Final/00-OVERVIEW.md](../architecture/SBQC-Stack-Final/00-OVERVIEW.md)
- Troubleshooting hub: [TROUBLESHOOTING_README.md](../guides/TROUBLESHOOTING_README.md)

---

## Table of Contents

1. The Stack in Plain English
2. The UI (Pages & Navigation)
3. Quick Start (First Success)
4. Everyday Use (Chat, RAG, Feedback)
5. Knowledge Base (RAG) Workflows
6. Operations Center + Integrations (DataAPI, n8n)
7. Analytics, Reports, and Quality Loops
8. Admin & Operations
9. Troubleshooting
10. FAQ
11. Reference: Commands & Checks

---

## 1) The Stack in Plain English

### What AgentX does
- provides a UI for chat + workflows,
- stores conversations and user profiles,
- can run “knowledge-augmented” answers (RAG),
- can integrate with automation (e.g., n8n),
- provides health endpoints and operational helpers.

### What DataAPI does
- provides backend utility endpoints (file scanning, exports, and tool-like operations),
- can enforce API key / RBAC depending on configuration,
- is designed to be used by AgentX (server-to-server) more than by humans.

---

## 2) The UI (Pages & Navigation)

### 2.1 The main navigation bar
Most pages use the same top navigation (in the UI header). These are the real, current pages:

- **Chat**: `http://localhost:3080/index.html`
	- Main chat UI (title: “AgentX • Ollama Control”). Includes onboarding/tour elements.
- **Operations**: `http://localhost:3080/dashboard.html`
	- “Operations Center” for health, metrics, events, and operational triggers.
- **Alerts**: `http://localhost:3080/alerts.html`
	- Alerts dashboard (list, filters, refresh).
- **n8n Monitor**: `http://localhost:3080/n8n-monitor.html`
	- Workflow monitor + webhook testing + deploy helpers.
- **Backup**: `http://localhost:3080/backup.html`
	- Backup & recovery UI (create/restore/list).
- **Models**: `http://localhost:3080/models.html`
	- Custom models UI.
- **Benchmark**: `http://localhost:3080/benchmark.html`
	- Benchmark runner and charts.
	- Includes exec vs judge progress, Judge Health telemetry, and “details/hyper” drilldowns for debugging.
- **Performance**: `http://localhost:3080/performance.html`
	- Performance dashboard and charts.
- **Analytics**: `http://localhost:3080/analytics.html`
	- Product + usage analytics.
- **RAG**: `http://localhost:3080/rag.html`
	- RAG document upload and management.
- **Prompts**: `http://localhost:3080/prompts.html`
	- Persona management UI (page title uses “Persona Management”).
- **Profile**: `http://localhost:3080/profile.html`
	- User profile and preferences injected into conversations.

### 2.2 Useful “non-nav” pages
These exist in the UI but are not top-nav items:

- **Login**: `http://localhost:3080/login.html`
	- Sign in/sign up screen (if auth is enabled for your deployment).
- **Alert Analytics**: `http://localhost:3080/alert-analytics.html`
	- Linked from the Alerts page (“Analytics” button).
- **Self-Healing**: `http://localhost:3080/self-healing.html`
	- Self-Healing dashboard (rules + history). It uses its own header/nav.

### 2.3 Legacy/compatibility links
- `http://localhost:3080/personas.html` redirects to `http://localhost:3080/prompts.html`.

### 2.4 Test/demo pages (not for normal ops)
AgentX also ships a couple of UI test pages under [public/](../../public/) (e.g., onboarding/template testers). Treat these as dev/test utilities.

### 2.5 Common workflows (page-accurate)

#### Check stack health (fast)
1. Open `http://localhost:3080/dashboard.html` (Operations Center).
2. Look at the “System Health” strip (AgentX / MongoDB / DataAPI / Ollama / n8n).
3. If anything is degraded, jump to [TROUBLESHOOTING.md](../guides/TROUBLESHOOTING.md).

#### Trigger an n8n webhook (from Operations Center)
1. Open `http://localhost:3080/dashboard.html`.
2. In the “n8n Webhook” section, pick a workflow from the “Workflow” dropdown.
3. (Optional) Edit “Payload (JSON)” then click “Trigger Webhook”.
4. Read the “Response” box.

#### Trigger RAG ingestion (from Operations Center)
1. Open `http://localhost:3080/dashboard.html`.
2. In the “RAG Ingestion” section, set “Target Directory” (default `/mnt/datalake/RAG`).
3. Click “Trigger Ingestion” and watch for the result.

#### Manage RAG documents (upload + verify)
1. Open `http://localhost:3080/rag.html`.
2. Drop files into the upload zone (“Upload Documents”).
3. Use the search box to verify your document appears.

#### Work with alerts (list → filter → analytics)
1. Open `http://localhost:3080/alerts.html`.
2. Use “Filters & Actions” to narrow what you’re looking at.
3. Click “Refresh” to pull the latest alerts.
4. Click “Analytics” to open `http://localhost:3080/alert-analytics.html`.

#### Manage personas/prompts
1. Open `http://localhost:3080/prompts.html`.
2. Use “Simple Mode” to hide advanced features when you just need basics.
3. Click “Create Persona” to add a new persona.
4. Use “Export / Import / Compare Versions” for library management (advanced).
5. Click “Show Tutorial” to reopen the onboarding guide.

#### Set your profile (what the AI sees)
1. Open `http://localhost:3080/profile.html`.
2. (Optional) Use “Quick Fill Templates” then click “Apply”.
3. Fill “About You”, “Custom Instructions”, and “Preferences”.
4. Click “Save Profile”, then confirm the “Preview: What the AI Sees”.

#### Read product analytics
1. Open `http://localhost:3080/analytics.html`.
2. Set “Last 7/14/30 days”, then click “Refresh”.
3. Use “Usage Trends” grouping (By Day / By Model / By Prompt).

#### Use the n8n monitor screen
1. Open `http://localhost:3080/n8n-monitor.html`.
2. Click “Refresh” under “System Health”.
3. Select a workflow to view details and test controls.
4. Use “Deploy Selected” / “Deploy All” only if you intend to update n8n.

---

## 3) Quick Start (First Success)

### 3.1 Prerequisites
- Node.js installed (see onboarding quickstart for versions).
- MongoDB reachable.
- Ollama reachable (for chat + embeddings).
- AgentX running.

Optional but common:
- DataAPI running (for “DataAPI Scans” in Operations Center and some workflows).

### 3.2 Confirm the system is alive

Health check:
```bash
curl http://localhost:3080/health
```

If you use PM2:
```bash
pm2 status
pm2 logs --lines 100
```

### 3.3 First success workflow

Pick the simplest possible goal:
- send one chat message,
- confirm a response is generated,
- confirm the conversation appears in history.

UI entrypoint (default):
- `http://localhost:3080/index.html`

If the system can’t complete this minimal flow, skip ahead to Troubleshooting.

### 3.4 Onboarding docs

- Quick start: [onboarding/quickstart.md](../onboarding/quickstart.md)
- Onboarding hub: [onboarding/README.md](../onboarding/README.md)

---

## 4) Everyday Use (Chat, RAG, Feedback)

### 4.1 Chat: how to ask better questions

Use this structure:
- **Goal**: what outcome you want
- **Context**: system names, dates, constraints
- **Input**: the actual question / task
- **Definition of done**: what “good” looks like

Example prompt:
> Goal: Summarize yesterday’s alerts.
> Context: focus on critical + error; include timestamps.
> Input: give me the top 5 recurring causes.
> Done: actionable list + next steps.

### 4.2 Model selection (practical guidance)

In general:
- faster / smaller models for iteration and triage,
- larger models for final writeups or complex synthesis,
- stable temperature for repeatable operations.

### 4.3 Feedback: why it matters

AgentX supports feedback (e.g., thumbs up/down) so you can:
- track what’s working,
- identify regressions,
- feed improvement loops.

When you mark something “bad”, include one sentence: “what was wrong”.

---

## 5) Knowledge Base (RAG) Workflows

RAG = the system answers using your documents (not just the model’s memory).

### 5.1 The mental model
1. Ingest documents (or refresh).
2. Store embeddings / metadata.
3. Retrieve relevant chunks for a query.
4. Generate an answer using that retrieved context.

### 5.2 Best practices for reliable RAG
- Keep documents well titled.
- Prefer smaller, focused docs over giant catch-all docs.
- When debugging, reduce `topK` and tighten your query.

### 5.3 Verification steps (don’t skip)
- confirm ingestion completed,
- confirm your target document is searchable,
- confirm retrieved chunks match your expectation.

For deep technical details, use:
- API reference: [api/reference.md](../api/reference.md)
- Contracts: [api/contracts/](../api/contracts/)

---

## 6) Operations Center + Integrations (DataAPI, n8n)

This is the “ops cockpit” part of AgentX. The primary page is:
- `http://localhost:3080/dashboard.html` (Operations Center)

For step-by-step tasks (health checks, webhook triggers, ingestion, alerts), see “2.5 Common workflows”.

### 6.1 DataAPI: what users should know
- You operate it from AgentX (primarily via the Operations Center).
- AgentX talks to DataAPI server-side (proxy routes), so browsers typically don’t need direct access.

### 6.2 Enabling DataAPI integration (admin)

AgentX expects configuration like:
```bash
DATAAPI_BASE_URL=http://127.0.0.1:3003
DATAAPI_API_KEY=change-me-long-random
```

DataAPI must be configured with a matching API key and may require `x-api-key` on tool endpoints.

DataAPI canonical docs index lives in the sibling DataAPI repo at: [../../../DataAPI/docs/INDEX.md](../../../DataAPI/docs/INDEX.md).

### 6.3 n8n
There are two main UI surfaces:
- `http://localhost:3080/dashboard.html`: quick webhook triggers + RAG ingestion trigger
- `http://localhost:3080/n8n-monitor.html`: workflow monitor/test UI

---

## 7) Analytics, Reports, and Quality Loops

AgentX includes analytics/metrics and can support continuous improvement loops.

### 7.1 What to look at regularly
- response quality (good vs bad feedback),
- recurring failure modes (timeouts, missing context),
- performance (slow responses).

### 7.2 Reports
Use reports for “what happened” and keep them immutable once published.

See:
- Reports folder: [../../reports/](../../reports/)
- Latest validation actions: [../../reports/comprehensive-validation-actions.md](../../reports/comprehensive-validation-actions.md)

---

## 8) Admin & Operations

### 8.1 Start/stop

Local dev:
```bash
npm start
```

Test backend endpoints:
```bash
./test-backend.sh
```

### 8.2 Common services to verify
- AgentX (port 3080 by default)
- MongoDB
- Ollama (default `http://localhost:11434`)
- DataAPI (if enabled)
- Qdrant (if configured)
- Reverse proxy (if deployed behind one)

### 8.3 Where the “real” deployment docs are

- Stack deployment guide: [SBQC-Stack-Final/05-DEPLOYMENT.md](../architecture/SBQC-Stack-Final/05-DEPLOYMENT.md)
- Runner management: [RUNNER_MANAGEMENT.md](../operations/RUNNER_MANAGEMENT.md)
- Security hardening: [SECURITY_HARDENING.md](../architecture/SECURITY_HARDENING.md)

---

## 9) Troubleshooting

Start here:
- [TROUBLESHOOTING.md](../guides/TROUBLESHOOTING.md)

### Fast triage checklist
1. Run health check(s).
2. Confirm dependencies (MongoDB, Ollama).
3. Reproduce with minimal input.
4. Inspect logs.
5. Only then change configuration.

---

## 10) FAQ

### “Do I need to use DataAPI directly?”
Usually no. Use AgentX.

### "Where is the canonical roadmap?"
- [ROADMAP.md](../../ROADMAP.md)

---

## 11) Reference: Commands & Checks

### Health
```bash
curl http://localhost:3080/health
```

Detailed health:
```bash
curl http://localhost:3080/health/detailed
```

Effective runtime config:
```bash
curl http://localhost:3080/api/config
```

### Ollama
```bash
curl http://localhost:11434/api/tags
```

### Tests
```bash
./test-backend.sh
```

### Docs entrypoints
- AgentX docs index: [docs/INDEX.md](../INDEX.md)
- DataAPI docs index: [../../../DataAPI/docs/INDEX.md](../../../DataAPI/docs/INDEX.md)
