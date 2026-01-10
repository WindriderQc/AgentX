# Architecture Reality Check (2026-01-04)

**Status:** Production / Stable
**Version:** 1.4.1

This document reflects the *actual* implemented architecture of the SBQC Stack (AgentX + DataAPI) as of January 2026, diverging from initial theoretical designs.

---

## 1. High-Level Topology (Service-Oriented Architecture)

The system operates as a **Service-Oriented Architecture (SOA)** managed by PM2. It is NOT a monolithic application.

```mermaid
graph TD
    User[User Browser] -->|HTTP/3080| AgentX[AgentX Service]
    User -->|HTTP/3003| DataAPI[DataAPI Service]
    
    subgraph "SBQC Stack (PM2 Managed)"
        AgentX -->|Proxy /api/dataapi/*| DataAPI
        AgentX -->|Vector Search| Qdrant[Qdrant Vector DB]
        AgentX -->|Chat/Embeddings| Ollama[Ollama (External)]
        
        DataAPI -->|Ingest| External[External APIs]
        DataAPI -->|Events| AgentX
    end
    
    AgentX -->|Read/Write| Mongo[MongoDB (Shared)]
    DataAPI -->|Read/Write| Mongo
```

### Services

| Service | Port | Role | Tech Stack |
| :--- | :--- | :--- | :--- |
| **AgentX** | `3080` | **Core Logic & UI.** Handles chat, RAG, user profiles, and orchestration. | Node.js, Express, EJS |
| **DataAPI** | `3003` | **Data Utility.** Handles background ingestion (ISS, Quakes), file scanning, and raw data access. | Node.js, Express, EJS |
| **Qdrant** | `6333` | **Vector Memory.** Stores embeddings for RAG. Managed via AgentX scripts. | Rust (Binary) |
| **MongoDB** | `27017` | **Persistence.** Shared database for both services. | MongoDB Community |

---

## 2. Data Flow & Integration

### A. The "Headless" Misconception
*   **Theory:** DataAPI was intended to be purely headless.
*   **Reality:** DataAPI has its own UI (`/`) for monitoring ingestion status, but AgentX users primarily interact with it via **Proxy Routes**.

### B. Proxy Architecture
AgentX does not reimplement DataAPI logic. It proxies requests:
1.  **Client** requests `AgentX:3080/api/dataapi/weather`.
2.  **AgentX** validates session/auth.
3.  **AgentX** signs request with `DATAAPI_API_KEY`.
4.  **AgentX** forwards to `DataAPI:3003/api/v1/weather`.
5.  **Response** flows back to Client.

**Why?**
*   **Security:** Browser never needs `DATAAPI_API_KEY`.
*   **CORS:** No cross-origin issues for the frontend.
*   **Unified Auth:** AgentX session protects DataAPI endpoints.

### C. Shared Database Model
Both services connect to the **same MongoDB instance** but typically operate on different collections/databases.
*   **AgentX DB:** `agentx` (Users, Sessions, Prompts, Feedback)
*   **DataAPI DB:** `data` (Weather, Quakes, TLEs)

*Note: While they can technically access each other's data, they are designed to interact via APIs to maintain decoupling.*

---

## 3. Deployment Reality (PM2)

The `ecosystem.config.js` in the root of `AgentX` is the **Master Controller**.

*   **It starts AgentX:** `./server.js`
*   **It starts DataAPI:** `../DataAPI/data_serv.js` (Assumes sibling directory structure)
*   **It starts Qdrant:** `./qdrant` (Binary in AgentX root)

**Critical Dependency:**
The deployment assumes a specific folder structure:
```text
/home/user/codes/
├── AgentX/       (Contains ecosystem.config.js)
└── DataAPI/      (Sibling directory)
```

---

## 4. Security Boundary

*   **Public Face:** AgentX (`3080`) is the intended public entry point.
*   **Private Utility:** DataAPI (`3003`) and Qdrant (`6333`) should generally be firewalled or restricted to `localhost` access, except for specific n8n webhooks.
*   **Authentication:**
    *   **User:** Session-based (Passport.js) on AgentX.
    *   **Service-to-Service:** API Key (`x-api-key`) for AgentX -> DataAPI.
    *   **Automation:** API Key (`x-api-key`) for n8n -> AgentX.

---

## 5. Known Technical Debt

1.  **Sibling Dependency:** `ecosystem.config.js` hardcodes the path to DataAPI. Moving folders breaks the stack.
2.  **Shared Mongo Connection:** No strict isolation between services at the DB user level (usually root/admin used for both).
3.  **Duplicate Utils:** Some utility functions (logger, formatting) are duplicated across repos.
