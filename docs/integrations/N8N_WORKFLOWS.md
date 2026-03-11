# n8n Integration Workflows

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → n8n Workflows

> **Context:** Automated workflows for document ingestion and prompt optimization. For the canonical workflow specification, see [SBQC Stack n8n Workflows](../architecture/SBQC-Stack-Final/04-N8N-WORKFLOWS.md).

## Overview

AgentX integrates with n8n for automated document ingestion and prompt optimization loops.

## Orchestration Boundary (n8n vs Cron)

Use this rule across the architecture:

- Use **cron + scripts** for single-host, time-based, deterministic jobs.
- Use **n8n** for cross-system orchestration (webhooks, retries, human approvals, multi-step integrations, centralized workflow audit trail).
- Keep **business logic in AgentX scripts/services**. n8n should orchestrate, not reimplement logic.

For N2.4 specifically, the canonical ingestion path is:

```bash
./scripts/archive-and-ingest-all.sh
```

Both cron and n8n should call this same command to avoid drift.

---

## Document Ingestion Workflows

**Documentation:** [SBQC Stack n8n Workflows](../architecture/SBQC-Stack-Final/04-N8N-WORKFLOWS.md)

### Workflow 1: Scheduled Docs Folder → RAG

- **Trigger:** Cron (default: every 60 minutes)
- **Flow:** Filesystem scan → PDF/HTML/Markdown extraction → SHA256 hash → POST `/api/rag/ingest`
- **Idempotency:** Backend deduplicates using hash

**Environment Variables:**
| Variable | Purpose |
|----------|---------|
| `AGENTX_BASE_URL` | e.g., `http://localhost:3080` |
| `AGENTX_API_KEY` | API key for authentication |
| `DOCS_FOLDER_PATH` | Absolute path to docs directory |

### Workflow 2: Manual/Ad-hoc Ingestion

- **Trigger:** HTTP webhook (POST)
- **Accepts:** JSON with `text` or `url` plus optional `title`, `tags`, `path`
- **Flow:** Fetch/extract → Hash → POST `/api/rag/ingest` → Respond to webhook

### N2.3: NAS RAG Document Ingestion

- **Repo status:** The historical N2.3 workflow export is not currently tracked in this repo. Current checked-in workflow exports live under [`n8n_workflows/`](../../n8n_workflows/).
- **Trigger:** Weekly (Sun 3AM) + Manual webhook (`POST /webhook/sbqc-n2-3-rag-ingest`)
- **Scope:** `/mnt/datalake/RAG` only — NAS-hosted documents
- **Limitation:** Only files modified in last 7 days, max 100 per pattern
- **Flow:** Find recent files → Read content (50KB max) → POST `/api/rag/ingest` → Log to DataAPI

### N2.4: Codebase Markdown RAG Update

- **Repo status:** Workflow export is tracked at [`n8n_workflows/N2.4-Codebase-Markdown-RAG-Update.json`](../../n8n_workflows/N2.4-Codebase-Markdown-RAG-Update.json). Import via n8n UI → Workflows → Import from file.
- **Trigger:** Weekly (Mon 2AM) + Manual webhook (`POST /webhook/sbqc-n2-4-codebase-rag`)
- **Scope:** Entire AgentX codebase — all `.md` files (234+ files)
- **No limits:** No date filter, no file count cap
- **Preferred flow:** Execute canonical scripts (no duplicated ingestion logic in workflow)
  - `./scripts/archive-md-files.sh --json`
  - `node scripts/ingest-docs.js --full --json`
  - or single wrapper: `./scripts/archive-and-ingest-all.sh --json`
- **Legacy flow:** Archive all `.md` files → Find all `.md` → Auto-tag by path → POST `/api/rag/ingest` → Log to DataAPI
- **Source tag:** `agentx-complete` (vs N2.3's `nas-docs`)

**N2.3 vs N2.4 coverage:**

| Aspect | N2.3 (NAS) | N2.4 (Codebase) |
|--------|-----------|-----------------|
| Target | `/mnt/datalake/RAG` | `/home/yb/codes/AgentX` |
| File types | `.md`, `.txt`, `.pdf` | `.md` only |
| Date filter | Last 7 days | None |
| File limit | 100 per pattern | None |
| Schedule | Sun 3AM | Mon 2AM |
| Source | `nas-docs` | `agentx-complete` |

### CLI Scripts (Manual/Quick)

For use outside of n8n:

```bash
# Canonical end-to-end command (archive + full ingestion)
./scripts/archive-and-ingest-all.sh               # Human-readable output
./scripts/archive-and-ingest-all.sh --json        # JSON output (automation-friendly)
./scripts/archive-and-ingest-all.sh --dry-run     # Validate pipeline without writing

# Archive all markdown files (preserves folder hierarchy)
./scripts/archive-md-files.sh                     # Human-readable output
./scripts/archive-md-files.sh --json              # JSON output (for automation)

# Ingest docs into RAG
node scripts/ingest-docs.js                       # Default: docs/ folders only
node scripts/ingest-docs.js --full                # Full codebase (all .md files)
node scripts/ingest-docs.js --full --json         # Machine-readable summary
node scripts/ingest-docs.js --full --dry-run      # Preview what would be ingested
node scripts/ingest-docs.js --full --limit=10     # Test with limited files
```

### Cron Alternative (without n8n)

If you only need scheduled local execution, use cron:

```bash
# Weekly Monday 2:00 AM
0 2 * * 1 cd /home/yb/codes/AgentX && ./scripts/archive-and-ingest-all.sh >> /home/yb/codes/AgentX/logs/rag-codebase-sync.log 2>&1
```

UI/monitoring is still possible in AgentX:

- Reuse the operations dashboard pattern (status card + recent runs + manual trigger button).
- Back the card with script output/log status and `GET /api/rag/metrics` for ingestion health context.
- Use dashboard API endpoints:
  - `GET /api/dashboard/rag-sync/status` (cron + last run status)
  - `POST /api/dashboard/rag-sync/run` (manual trigger, optional `{ "dryRun": true }`)
- This gives dashboard visibility without requiring n8n for a simple periodic task.

---

## Prompt Improvement Workflows (V4)

**Documentation:** [SBQC Stack n8n Workflows](../architecture/SBQC-Stack-Final/04-N8N-WORKFLOWS.md)

### Four Automated Workflows

#### 1. Prompt Health Check (Daily Cron)
- Polls `/api/analytics/feedback?sinceDays=7`
- Flags prompts with low positive rates (< 70% threshold)
- Sends alerts to monitoring channel

#### 2. Evaluate Negative Conversations (Manual/Weekly)
- Samples worst conversations via `/api/dataset/conversations?feedback=negative`
- LLM analyzes failures and proposes prompt improvements
- Creates proposal via `POST /api/prompt-configs`

#### 3. Prompt Rollout Controller (Manual Approval)
- Reviews proposed prompts
- Human-in-the-loop approval (Slack/Email buttons)
- Activates via `PATCH /api/prompt-configs/:id/activate`

#### 4. Dataset Export (Weekly)
- Exports conversations for fine-tuning
- Generates JSONL with positive/negative examples
- Stores in `/data/exports/`

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `POSITIVE_RATE_THRESHOLD` | 0.7 (70%) | Minimum acceptable positive rate |
| `MIN_FEEDBACK_COUNT` | 50 | Minimum conversations for analysis |
| `HEALTH_LOOKBACK_DAYS` | 7 | Days to analyze for health check |
| `DATASET_EXPORT_LIMIT` | 500 | Max records per export batch |

---

## Webhook Endpoints for n8n

**API Key Authentication Required:**
```bash
curl -H "x-api-key: ${AGENTX_API_KEY}" http://localhost:3080/api/rag/ingest
```

### Key Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/rag/ingest` | POST | Document ingestion (V3 contract) |
| `/api/rag/search` | POST | RAG search testing |
| `/api/analytics/feedback` | GET | Prompt performance metrics |
| `/api/dataset/conversations` | GET | Conversation export |
| `/api/prompt-configs` | POST | Create new prompt versions |
| `/api/rag/manifests` | POST | Store folder scan manifest |
| `/api/rag/manifests/latest` | GET | Get latest manifest |
| `/api/rag/deletion-preview` | GET | Find orphaned RAG documents |
| `/api/rag/documents` | GET | List all RAG documents |
| `/api/rag/metrics` | GET | RAG system health metrics |

---

## Related Documentation

- [SBQC Stack n8n Workflows](../architecture/SBQC-Stack-Final/04-N8N-WORKFLOWS.md) - Canonical workflow specification
- [ROADMAP.md](../../ROADMAP.md) - Current project status and track summary
- [RAG System](../architecture/RAG_SYSTEM.md) - Document ingestion architecture
- [Authentication](../operations/AUTHENTICATION.md) - API key setup

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
