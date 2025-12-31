# SBQC Stack - Deployment Guide

**Created:** December 26, 2025
**Updated:** December 5, 2025 (Audit/Migration)

---

## 🚀 Prerequisites

*   **Docker & Docker Compose**
*   **Node.js 18+** (for local dev)
*   **MongoDB 6+**
*   **Ollama** (running on reachable hosts)

---

## 📝 Environment Variables Reference

Create a `.env` file in the root of `AgentX` (and `DataAPI` if applicable).

### Core Configuration
```bash
# Server Port
PORT=3080

# Environment (development | production | test)
NODE_ENV=production
```

### Database
```bash
# MongoDB Connection String
MONGODB_URI=mongodb://192.168.2.33:27017/agentx
```

### AI / Inference
```bash
# Primary Ollama Host
OLLAMA_HOST=http://192.168.2.99:11434

# Secondary Ollama Host (Optional, for routing)
OLLAMA_HOST_2=http://192.168.2.12:11434

# Embedding Model (Must be pulled on OLLAMA_HOST)
EMBEDDING_MODEL=nomic-embed-text
```

### Security (CRITICAL)
```bash
# Session Encryption Key (32+ bytes hex)
# Generate with: openssl rand -hex 32
SESSION_SECRET=70dd24b5f523ba3629648e917a43eebbb358a70a289af3bdbe482602e7c31718

# API Key for Automation/n8n (32+ bytes hex)
AGENTX_API_KEY=a2f19379e0c80d7d265cd6a3aa055b7cab334c28ff970e965580bf7f093b6f7a
```

### DataAPI Integration (Optional)
```bash
# URL of the DataAPI service
DATAAPI_BASE_URL=http://localhost:3003

# API Key matching DataAPI's configuration
DATAAPI_API_KEY=change-me-long-random
```

---

## 📦 Deployment Steps (PM2 / Bare Metal)

1.  **Clone Repository:**
    ```bash
    git clone https://github.com/WindriderQc/AgentX.git
    cd AgentX
    ```

2.  **Install Dependencies:**
    ```bash
    npm install --production
    ```

3.  **Configure Environment:**
    Copy `.env.example` to `.env` and update values (see above).

4.  **Database Migration (Indexes):**
    ```bash
    node scripts/create-indexes.js
    ```
    *This creates the necessary 17 MongoDB indexes.*

5.  **Start Application:**
    ```bash
    npm start
    # OR with PM2
    pm2 start ecosystem.config.js
    ```

---

## 🐳 Deployment Steps (Docker)

1.  **Build Image:**
    ```bash
    docker build -t agentx:latest .
    ```

2.  **Run Container:**
    ```bash
    docker run -d \
      --name agentx \
      -p 3080:3080 \
      --env-file .env \
      agentx:latest
    ```

---

## ✅ Production Checklist

1.  **Secrets:** Ensure `SESSION_SECRET` and `AGENTX_API_KEY` are strong and unique.
2.  **Admin User:** Create the first admin user via Mongo shell or API (set `isAdmin: true` in `userprofiles`).
3.  **HTTPS:** Use a reverse proxy (Nginx/Traefik/Cloudflare) for SSL termination.
4.  **Firewall:** Restrict access to port 3080 to trusted IPs / internal network.
5.  **Backups:** Schedule regular MongoDB dumps.
6.  **Monitoring:** Monitor `/api/metrics/system` for health.

---

## 📡 Qdrant Deployment (Vector DB)

For production RAG, use Qdrant instead of in-memory storage.

1.  **Run Qdrant:**
    ```bash
    docker run -d -p 6333:6333 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant
    ```

2.  **Configure AgentX:**
    Set `VECTOR_DB_URL=http://localhost:6333` in `.env` (Future V1.1 feature).

---

## 🔄 Updates & Maintenance

*   **Update Code:** `git pull && npm install`
*   **Refresh Indexes:** `node scripts/create-indexes.js`
*   **Logs:** Check `logs/app.log` and `logs/security.log`.
