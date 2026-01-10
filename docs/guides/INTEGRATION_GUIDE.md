# Integration Guide: AgentX ↔ DataAPI ↔ n8n

**Version:** 1.0
**Status:** Active

This guide serves as the **Single Source of Truth** for how the three pillars of the SBQC Stack interact.

---

## 1. The Triad

1.  **AgentX (The Brain):** Handles user interaction, decision making, and orchestration.
2.  **DataAPI (The Senses):** Gathers raw data (Weather, Quakes, Files) and provides it on demand.
3.  **n8n (The Automation):** Executes complex workflows triggered by AgentX or external schedules.

---

## 2. AgentX ↔ DataAPI (The Proxy Pattern)

AgentX consumes DataAPI services to enhance user experience.

### Flow
1.  **User** asks: "What's the weather?"
2.  **AgentX** determines it needs weather data.
3.  **AgentX** calls `GET http://localhost:3003/api/v1/weather/current`.
    *   Header: `x-api-key: <DATAAPI_API_KEY>`
4.  **DataAPI** returns JSON.
5.  **AgentX** formats the response into the chat context.

### Configuration
*   **AgentX `.env`**:
    ```bash
    DATAAPI_BASE_URL=http://localhost:3003
    DATAAPI_API_KEY=secret_key_123
    ```
*   **DataAPI `.env`**:
    ```bash
    DATAAPI_API_KEY=secret_key_123
    ```

---

## 3. AgentX ↔ n8n (The Automation Loop)

n8n is used for tasks that are too complex or long-running for a simple API call (e.g., "Ingest this PDF and summarize it").

### A. AgentX Triggering n8n
*   **Mechanism:** Webhooks.
*   **Flow:**
    1.  User uploads a file in AgentX.
    2.  AgentX saves file to disk.
    3.  AgentX calls `POST <N8N_WEBHOOK_URL>`.
        *   Payload: `{ "filepath": "/path/to/file", "action": "ingest" }`
        *   Header: `x-api-key: <N8N_API_KEY>`

### B. n8n Calling AgentX
*   **Mechanism:** REST API.
*   **Flow:**
    1.  n8n finishes processing.
    2.  n8n calls `POST http://agentx:3080/api/v1/rag/ingest`.
        *   Header: `x-api-key: <AGENTX_API_KEY>`
    3.  AgentX updates its vector database.

### Configuration
*   **AgentX `.env`**:
    ```bash
    N8N_WEBHOOK_BASE_URL=https://n8n.example.com/webhook
    N8N_API_KEY=n8n_secret_key
    AGENTX_API_KEY=agentx_secret_key
    ```
*   **n8n Credentials**:
    *   Header Auth: `x-api-key` = `agentx_secret_key`

---

## 4. DataAPI ↔ n8n (The Data Sink)

n8n can use DataAPI as a logging or raw data storage service.

### Flow
1.  n8n detects a new RSS feed item.
2.  n8n calls `POST http://dataapi:3003/integrations/events/n8n`.
3.  DataAPI logs the event to MongoDB `data.events` collection.

---

## 5. Troubleshooting

### Common Issues

**1. 401 Unauthorized**
*   **Cause:** API Key mismatch.
*   **Fix:** Ensure `DATAAPI_API_KEY` in AgentX matches `DATAAPI_API_KEY` in DataAPI.

**2. Connection Refused**
*   **Cause:** Service not running or wrong port.
*   **Fix:** Check `pm2 status`. Ensure ports `3080` and `3003` are active.

**3. CORS Error (Frontend)**
*   **Cause:** Browser trying to hit DataAPI directly.
*   **Fix:** Always use the AgentX proxy route (`/api/dataapi/...`), never the direct DataAPI URL (`:3003`) from client-side JS.
