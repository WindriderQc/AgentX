# SBQC Stack - Architecture & Design Principles

**Created:** December 26, 2025
**Updated:** December 5, 2025 (Audit/Migration)

---

## 🏗️ High-Level Architecture

The SBQC Stack is a modular AI system designed for **local-first operations**, **automation**, and **continuous improvement**. It is composed of three primary services running on a Docker host, supported by external GPU inference servers and a NAS.

```mermaid
graph TD
    User[User / Frontend] -->|HTTP| AgentX[AgentX (AI Core)]
    User -->|HTTP| DataAPI[DataAPI (Tools)]

    subgraph "Docker Host (192.168.2.33)"
        AgentX -->|Port 27017| MongoDB[(MongoDB)]
        DataAPI -->|Port 27017| MongoDB
        AgentX -->|Port 3003| DataAPI
    end

    subgraph "Automation (192.168.2.199)"
        n8n[n8n Automation] -->|Webhook| AgentX
        n8n -->|API| DataAPI
        AgentX -->|Webhook| n8n
    end

    subgraph "Inference (GPU Cluster)"
        AgentX -->|Ollama API| UGBrutal[UGBrutal (5070 Ti)]
        AgentX -->|Ollama API| UGFrank[UGFrank (3080 Ti)]
    end

    subgraph "Storage"
        DataAPI -->|SMB/NFS| NAS[TrueNAS Scale]
    end
```

---

## 🧩 Core Components

### 1. AgentX (The Brain)
*   **Role:** Central AI orchestration, chat interface, memory, and decision making.
*   **Tech Stack:** Node.js, Express, MongoDB (Mongoose).
*   **Key Features:**
    *   **RAG Engine (V3):** Semantic search over ingested documents (powered by Ollama embeddings).
    *   **Analytics (V4):** Tracks usage, feedback, and model performance.
    *   **Memory:** Persists user preferences and conversation context.
    *   **Routing:** Dispatches queries to the best-fit model (Code vs Chat).
    *   **Authentication:** Session-based (Users) & API Key (Automation).

### 2. DataAPI (The Hands)
*   **Role:** Headless tool server for file operations and system management.
*   **Tech Stack:** Node.js, Express, MongoDB.
*   **Key Features:**
    *   **File Scanner:** Indexes NAS content with SHA256 hashing for deduplication.
    *   **Storage Access:** Provides read/write access to mounted NAS shares.
    *   **Event Sink:** Receives webhooks from n8n for logging.

### 3. n8n (The Nervous System)
*   **Role:** Workflow automation and glue code.
*   **Tech Stack:** Dockerized n8n.
*   **Key Workflows:**
    *   **Ingestion:** Watch folders -> Text Extraction -> AgentX RAG API.
    *   **Monitoring:** Health checks -> Alerts.
    *   **Optimization:** Analyze feedback -> Propose prompt improvements.

---

## 🔐 Security & Authentication

### Authentication Strategy
*   **Hybrid Model:**
    *   **Browser/User:** Session-based authentication (Cookies) via `express-session` & `connect-mongodb-session`.
    *   **Automation/n8n:** Header-based authentication (`x-api-key` or `Authorization: Bearer`).
*   **Routes:**
    *   `/api/auth/*`: Public (Register/Login).
    *   `/api/analytics/*`, `/api/dataset/*`: Protected (`requireAuth`).
    *   `/api/chat`: Semi-protected (Guest or User).

### Security Measures
*   **Rate Limiting:** `express-rate-limit` on Auth endpoints (5 attempts / 15 min).
*   **Headers:** `helmet` for HSTS, CSP, X-Frame-Options.
*   **CSRF:** `csrf-csrf` (Double Submit Cookie) for state-changing requests.
*   **Sanitization:** `express-mongo-sanitize` prevents NoSQL injection.
*   **Audit Logging:** All security events (login, failed auth, admin actions) are logged to MongoDB.

---

## ⚡ Performance Optimization

### Caching
*   **Embeddings:** LRU Cache with SHA256 deduplication (in-memory) prevents redundant Ollama calls.
*   **Hit Rate:** Typically 50-80% reduction in embedding API load for repetitive tasks.

### Database
*   **Indexing:** 17+ Indexes created on `conversations`, `userprofiles`, and `promptconfigs` for sub-10ms queries.
*   **Connection Pooling:** Optimized Mongoose pool settings (min 10, max 50).

---

## 🔄 Data Flows

### 1. RAG Ingestion (V3)
1.  **n8n** detects a new file on NAS.
2.  **n8n** extracts text and computes SHA256.
3.  **n8n** POSTs to `AgentX /api/rag/ingest`.
4.  **AgentX** checks `RagStore` for existing hash.
5.  **AgentX** (if new) calls **Ollama** for embeddings.
6.  **AgentX** stores chunks in Vector Store (Qdrant/Memory).

### 2. Chat with RAG
1.  **User** sends message to `AgentX`.
2.  **AgentX** embeds query via **Ollama**.
3.  **AgentX** searches Vector Store for top-K chunks.
4.  **AgentX** constructs System Prompt with context.
5.  **AgentX** sends to LLM (Ollama).
6.  **AgentX** streams response and logs usage/sources.

### 3. Prompt Improvement Loop (V4)
1.  **Users** rate messages (Thumbs Up/Down).
2.  **AgentX** stores feedback in `Conversation`.
3.  **n8n** (Weekly) pulls negative feedback via `/api/dataset`.
4.  **n8n** uses LLM to analyze failures and propose Prompt changes.
5.  **n8n** POSTs new `PromptConfig` to `/api/dataset/prompts`.
6.  **Admin** reviews and activates new version via API.

---

## 🛠️ Design Principles

1.  **Local-First:** No dependency on cloud APIs (OpenAI, Anthropic) for core function.
2.  **Modular:** Services are loosely coupled via REST APIs.
3.  **Idempotent:** Automation workflows can run repeatedly without side effects.
4.  **Observable:** Extensive metrics (`/api/metrics`) and logs.
5.  **Secure by Default:** Production-grade security headers and auth.

