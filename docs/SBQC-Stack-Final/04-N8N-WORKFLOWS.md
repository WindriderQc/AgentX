# n8n Workflow Specifications

**Created:** December 26, 2025
**Updated:** December 5, 2025 (Audit/Migration)

---

## 🔄 Workflow Overview

These workflows run on the `n8n` instance (192.168.2.199) and orchestrate data flow between the NAS, AgentX, and DataAPI.

### Global Credentials
*   `AGENTX_API_KEY`: The 32-byte hex key from AgentX `.env`.
*   `DATAAPI_API_KEY`: The key for DataAPI access.
*   `NAS_MOUNT_PATH`: Path to mounted NAS shares (e.g., `/mnt/datalake`).

---

## 📂 Ingestion Workflows

### N2.1: NAS File Scanner
*   **Trigger:** Cron (Daily @ 02:00)
*   **Action:**
    1.  Recursively list files in `${NAS_MOUNT_PATH}`.
    2.  Calculate SHA256 of files.
    3.  Call **DataAPI** `POST /api/v1/files/scan` to update index.
    4.  Log results to AgentX via `/api/n8n/event/scan_complete`.

### N2.3: RAG Document Ingestion
*   **Trigger:** Cron (Hourly) OR File Watcher.
*   **Action:**
    1.  Find modified Markdown/Text files in `${NAS_MOUNT_PATH}/RAG`.
    2.  Extract text content.
    3.  Compute SHA256 hash.
    4.  Call **AgentX** `POST /api/rag/ingest`.
        *   Body: `{ source: "nas", path: "...", text: "...", hash: "..." }`
    5.  AgentX handles deduplication (skips if hash exists).

---

## 🛡️ Monitoring Workflows

### N1.1: System Health Check
*   **Trigger:** Cron (Every 5 min).
*   **Action:**
    1.  HTTP GET `AgentX /health`.
    2.  HTTP GET `DataAPI /health`.
    3.  HTTP GET `Ollama /api/tags`.
    4.  **If any fail:** Send Alert (Email/Telegram).

### N5.1: Feedback Analysis (Prompt Loop)
*   **Trigger:** Weekly Schedule.
*   **Action:**
    1.  Call **AgentX** `GET /api/dataset/conversations?minFeedback=-1`.
    2.  Loop through negative conversations.
    3.  Ask **LLM (via AgentX)** to analyze root cause.
    4.  Aggregate suggestions.
    5.  If pattern found, propose new prompt via `POST /api/dataset/prompts`.

---

## 🤖 AI Trigger Workflows

### N3.2: External AI Gateway
*   **Trigger:** Webhook `POST /webhook/ask-agentx`.
*   **Action:**
    1.  Receive payload `{ "question": "..." }`.
    2.  Call **AgentX** `POST /api/chat`.
    3.  Return response to webhook caller.
*   **Use Case:** Allow external scripts/tools to query the AI.

---

## 🔗 Integration Points

### AgentX -> n8n (Webhooks)
AgentX can trigger n8n workflows for specific events. Configure webhook URLs in AgentX if needed (future feature). Currently, n8n mostly polls or pushes to AgentX.

### n8n -> AgentX (API)
*   **Base URL:** `http://192.168.2.33:3080`
*   **Headers:**
    *   `Content-Type: application/json`
    *   `x-api-key: {{ $env.AGENTX_API_KEY }}`
