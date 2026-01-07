# n8n Integration Workflows

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → n8n Workflows

> **Context:** Automated workflows for document ingestion and prompt optimization. For detailed n8n documentation, see reports in `/docs/reports/`.

## Overview

AgentX integrates with n8n for automated document ingestion and prompt optimization loops.

---

## Document Ingestion Workflows

**Documentation:** `/docs/reports/n8n-ingestion.md`

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

---

## Prompt Improvement Workflows (V4)

**Documentation:** `/docs/reports/n8n-prompt-improvement-v4.md`

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

---

## Related Documentation

- [n8n Ingestion Report](../reports/n8n-ingestion.md) - Detailed workflow documentation
- [n8n Prompt Improvement](../reports/n8n-prompt-improvement-v4.md) - V4 optimization loops
- [RAG System](../architecture/RAG_SYSTEM.md) - Document ingestion architecture
- [Authentication](../operations/AUTHENTICATION.md) - API key setup

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
