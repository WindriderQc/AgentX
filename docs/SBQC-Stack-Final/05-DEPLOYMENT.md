# 05 - Deployment Guide

**Last Updated:** December 31, 2025

---

## Quick Start

**For new deployments, start here:**
1. [Environment Variables Reference](#environment-variables-reference) - Configure first!
2. [MongoDB Setup](#1-mongodb-setup)
3. [DataAPI Deployment](#2-dataapi-deployment)
4. [AgentX Deployment](#3-agentx-deployment)
5. [n8n Setup](#4-n8n-setup)

---

## Environment Variables Reference

### AgentX (.env)

**Required Variables:**

| Variable | Type | Example | Description |
|----------|------|---------|-------------|
| `MONGODB_URI` | Connection | `mongodb://192.168.2.33:27017/agentx` | MongoDB connection string |
| `PORT` | Number | `3080` | AgentX server port |
| `SESSION_SECRET` | Secret | (32+ chars) | Session encryption key |
| `CSRF_SECRET` | Secret | (32+ chars) | CSRF token secret |
| `AGENTX_API_KEY` | Secret | (32+ chars) | API key for automation access |

**Ollama & RAG:**

| Variable | Type | Example | Description |
|----------|------|---------|-------------|
| `OLLAMA_HOST` | URL | `http://192.168.2.99:11434` | Primary Ollama instance (front-door) |
| `EMBEDDING_MODEL` | String | `nomic-embed-text` | Model for RAG embeddings |
| `VECTOR_STORE_TYPE` | String | `qdrant` or `memory` | Vector store backend |
| `QDRANT_URL` | URL | `http://192.168.2.33:6333` | Qdrant server URL (if using) |
| `QDRANT_COLLECTION` | String | `agentx_embeddings` | Qdrant collection name |

**Integration:**

| Variable | Type | Example | Description |
|----------|------|---------|-------------|
| `DATAAPI_BASE_URL` | URL | `http://192.168.2.33:3003` | DataAPI base URL |
| `DATAAPI_API_KEY` | Secret | (32+ chars) | API key for DataAPI access |
| `N8N_WEBHOOK_BASE_URL` | URL | `https://n8n.specialblend.icu/webhook` | n8n webhook base |
| `N8N_API_KEY` | Secret | (32+ chars) | API key for n8n to call AgentX |

**Optional:**

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `NODE_ENV` | String | `development` | `production` or `development` |
| `CORS_ORIGINS` | String | `*` | Comma-separated allowed origins |
| `HOST` | String | `localhost` | Server bind address |

**Generate Secrets:**
```bash
# Generate all secrets at once
node -e "const c=require('crypto'); console.log('SESSION_SECRET='+c.randomBytes(32).toString('hex')); console.log('CSRF_SECRET='+c.randomBytes(32).toString('hex')); console.log('AGENTX_API_KEY='+c.randomBytes(32).toString('hex')); console.log('DATAAPI_API_KEY='+c.randomBytes(32).toString('hex')); console.log('N8N_API_KEY='+c.randomBytes(32).toString('hex'));"
```

---

### DataAPI (.env)

**Required Variables:**

| Variable | Type | Example | Description |
|----------|------|---------|-------------|
| `MONGODB_URI` | Connection | `mongodb://192.168.2.33:27017/SBQC` | MongoDB connection string |
| `PORT` | Number | `3003` | DataAPI server port |
| `SESSION_SECRET` | Secret | (32+ chars) | Session encryption key |
| `N8N_API_KEY` | Secret | (32+ chars) | API key for n8n access |

**n8n Webhook IDs (Optional):**

| Variable | Type | Description |
|----------|------|-------------|
| `N8N_WEBHOOK_SCAN_COMPLETE` | String | Webhook ID for scan completion events |
| `N8N_WEBHOOK_FILES_EXPORTED` | String | Webhook ID for export events |
| `N8N_WEBHOOK_STORAGE_ALERT` | String | Webhook ID for storage alerts |
| `N8N_WEBHOOK_GENERIC` | String | Generic webhook ID |

> ⚠️ **Note:** These webhook env vars are OPTIONAL. They're for future DataAPI → n8n event pushing. Currently, n8n pulls from DataAPI directly.

**Configuration:**

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `N8N_LAN_ONLY` | Boolean | `true` | Restrict n8n endpoints to LAN |
| `N8N_WEBHOOK_BASE_URL` | URL | - | n8n webhook base URL |

---

### n8n Configuration

**n8n Environment:**

| Variable | Value | Description |
|----------|-------|-------------|
| `N8N_PORT` | `5678` | n8n web UI port |
| `N8N_PROTOCOL` | `https` | Use https (via Cloudflare tunnel) |
| `N8N_HOST` | `n8n.specialblend.icu` | Public domain |
| `WEBHOOK_URL` | `https://n8n.specialblend.icu` | Webhook base URL |

**n8n Infrastructure:**
- **Host:** Ubundocker (192.168.2.199)
- **Deployment:** Docker container
- **Local Access:** http://192.168.2.199:5678
- **Public Access:** https://n8n.specialblend.icu (via Cloudflare Tunnel)
- **Tunnel:** Cloudflare exposes local port 5678 to public domain

**n8n Credentials to Create:**

1. **Header Auth (x-api-key)** - For calling AgentX/DataAPI
   - Name: `AgentX API Key`
   - Header: `x-api-key`
   - Value: Same as `AGENTX_API_KEY` from AgentX .env

2. **Header Auth (x-api-key)** - For calling DataAPI
   - Name: `DataAPI API Key`
   - Header: `x-api-key`
   - Value: Same as `N8N_API_KEY` from DataAPI .env

---

## Infrastructure Overview

| Host | IP | Services | Notes |
|------|-----|----------|-------|
| Docker Host | 192.168.2.33 | DataAPI, AgentX, MongoDB | Main application server |
| Ubundocker | 192.168.2.199 | n8n (Docker) | Automation, https://n8n.specialblend.icu (Cloudflare) |
| UGBrutal | 192.168.2.12 | Ollama (5070 Ti) | Heavy inference |
| UGFrank | 192.168.2.99 | Ollama (3080 Ti) | Fast inference |

---

## 1. MongoDB Setup

### Option A: Docker (Recommended)

```bash
# On 192.168.2.33
docker run -d \
  --name mongodb \
  --restart unless-stopped \
  -p 27017:27017 \
  -v mongodb_data:/data/db \
  mongo:7
```

### Option B: Native Installation

```bash
# Ubuntu/Debian
wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc | sudo apt-key add -
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl start mongod
sudo systemctl enable mongod
```

### Verify

```bash
mongosh --host 192.168.2.33:27017
> show dbs
# Should list: SBQC, agentx, admin, local
```

---

## 2. DataAPI Deployment

### Clone & Configure

```bash
# On 192.168.2.33
cd /opt
git clone https://github.com/WindriderQc/DataAPI.git
cd DataAPI
npm install
```

### Environment File

```bash
# /opt/DataAPI/.env
PORT=3003
NODE_ENV=production

# MongoDB
MONGODB_URI=mongodb://192.168.2.33:27017/SBQC

# n8n Integration
N8N_API_KEY=<generate-with: openssl rand -hex 32>
N8N_LAN_ONLY=true
N8N_WEBHOOK_BASE_URL=https://n8n.specialblend.icu
N8N_WEBHOOK_SCAN_COMPLETE=<your-webhook-id>
N8N_WEBHOOK_FILES_EXPORTED=<your-webhook-id>
N8N_WEBHOOK_STORAGE_ALERT=<your-webhook-id>
N8N_WEBHOOK_GENERIC=<your-webhook-id>

# Session (for web UI)
SESSION_SECRET=<generate-with: openssl rand -hex 32>

# Optional: External APIs
WEATHER_API_KEY=
TIDES_API_KEY=
```

### Run with PM2

```bash
npm install -g pm2

pm2 start data_serv.js --name dataapi
pm2 save
pm2 startup
```

### Verify

```bash
curl http://192.168.2.33:3003/health
# Expected: {"status":"ok"}

# Storage endpoints (require API key):
curl -H "x-api-key: YOUR_KEY" http://192.168.2.33:3003/api/v1/storage/scans
# Expected: {"status":"success","data":[...]}

# Note: n8n trigger endpoints are in AgentX, not DataAPI
```

---

## 3. AgentX Deployment

### Clone & Configure

```bash
# On 192.168.2.33
cd /opt
git clone https://github.com/WindriderQc/AgentX.git
cd AgentX
npm install
```

### Environment File

```bash
# /opt/AgentX/.env
PORT=3080
NODE_ENV=production

# MongoDB
MONGODB_URI=mongodb://192.168.2.33:27017/agentx

# Ollama Hosts
OLLAMA_HOST=192.168.2.99:11434
OLLAMA_HOST_HEAVY=192.168.2.12:11434
EMBEDDING_MODEL=nomic-embed-text

# DataAPI Integration
DATAAPI_BASE_URL=http://192.168.2.33:3003
DATAAPI_API_KEY=<same-key-as-dataapi-n8n-key>

# n8n Integration
N8N_API_KEY=<generate-another-key>
N8N_WEBHOOK_BASE_URL=https://n8n.specialblend.icu

# RAG Configuration
VECTOR_STORE_TYPE=memory
# QDRANT_URL=http://localhost:6333
# QDRANT_COLLECTION=agentx

# Session
SESSION_SECRET=<generate-with: openssl rand -hex 32>
```

### Run with PM2

```bash
pm2 start server.js --name agentx
pm2 save
```

### Verify

```bash
curl http://192.168.2.33:3080/health
# Expected: {"status":"ok","port":3080,"details":{"mongodb":"connected","ollama":"unknown"}}

curl -X POST http://192.168.2.33:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5:7b","message":"Hello","target":"192.168.2.99:11434"}'
# Expected: {"status":"success","data":{...}}
```

---

## 4. Ollama Setup

### On UGFrank (192.168.2.99 - 3080 Ti)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Configure to listen on all interfaces
sudo systemctl edit ollama
# Add:
# [Service]
# Environment="OLLAMA_HOST=0.0.0.0"

sudo systemctl restart ollama

# Pull models
ollama pull qwen2.5:7b
ollama pull whisper  # For future voice
```

### On UGBrutal (192.168.2.12 - 5070 Ti)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Configure to listen on all interfaces
sudo systemctl edit ollama
# Add:
# [Service]
# Environment="OLLAMA_HOST=0.0.0.0"

sudo systemctl restart ollama

# Pull models
ollama pull llama3.3:70b-q4_K_M  # Quantized to fit VRAM
ollama pull deepseek-r1:32b
ollama pull gemma3:12b
ollama pull nomic-embed-text
```

### Verify

```bash
curl http://192.168.2.99:11434/api/tags
curl http://192.168.2.12:11434/api/tags
# Both should return {"models":[...]}
```

---

## 5. n8n Setup

### Docker Compose (Recommended)

```yaml
# /opt/n8n/docker-compose.yml
version: '3.8'
services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "5678:5678"
    environment:
      - N8N_HOST=n8n.specialblend.icu
      - N8N_PORT=5678
      - N8N_PROTOCOL=https
      - WEBHOOK_URL=https://n8n.specialblend.icu/
      - GENERIC_TIMEZONE=America/Toronto
    volumes:
      - n8n_data:/home/node/.n8n
      - /mnt/smb:/mnt/smb:ro  # NAS mounts (read-only)

volumes:
  n8n_data:
```

```bash
cd /opt/n8n
docker compose up -d
```

### Cloudflare Tunnel

The tunnel is already configured to expose `https://n8n.specialblend.icu` → `http://192.168.2.199:5678`

### Verify

```bash
curl https://n8n.specialblend.icu/healthz
# Expected: {"status":"ok"}
```

---

## 6. SMB Mounts for n8n

### On n8n Host (192.168.2.199)

```bash
# Install cifs-utils
sudo apt install cifs-utils

# Create mount points
sudo mkdir -p /mnt/media /mnt/datalake

# Create credentials file
sudo nano /etc/samba/nas-creds
# username=YOUR_NAS_USER
# password=YOUR_NAS_PASSWORD
sudo chmod 600 /etc/samba/nas-creds

# Add to /etc/fstab
//nas.local/Media /mnt/media cifs credentials=/etc/samba/nas-creds,uid=1000,gid=1000,iocharset=utf8 0 0
//nas.local/Datalake /mnt/datalake cifs credentials=/etc/samba/nas-creds,uid=1000,gid=1000,iocharset=utf8 0 0

# Mount
sudo mount -a

# Verify
ls /mnt/media
```

### For Docker n8n

Add the volume mount to docker-compose.yml:
```yaml
volumes:
  - /mnt/smb:/mnt/smb:ro
```

---

## 7. Firewall Rules

Ensure these ports are open between hosts:

| From | To | Port | Service |
|------|-----|------|---------|
| n8n (199) | DataAPI (33) | 3003 | HTTP API |
| n8n (199) | AgentX (33) | 3080 | HTTP API |
| AgentX (33) | DataAPI (33) | 3003 | HTTP API |
| AgentX (33) | Ollama (99) | 11434 | Inference |
| AgentX (33) | Ollama (12) | 11434 | Inference |
| DataAPI (33) | MongoDB (33) | 27017 | Database |
| AgentX (33) | MongoDB (33) | 27017 | Database |
| Browser | AgentX (33) | 3080 | Web UI |
| Browser | DataAPI (33) | 3003 | Web UI (optional) |

---

## 8. Health Check Script

Save as `/opt/scripts/health-check.sh`:

```bash
#!/bin/bash

echo "=== SBQC Stack Health Check ==="
echo "Date: $(date)"
echo

# DataAPI
echo -n "DataAPI: "
if curl -s http://192.168.2.33:3003/health | grep -q "ok"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
fi

# AgentX
echo -n "AgentX: "
if curl -s http://192.168.2.33:3080/health | grep -q "ok"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
fi

# Ollama UGFrank
echo -n "Ollama (UGFrank 99): "
if curl -s http://192.168.2.99:11434/api/tags | grep -q "models"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
fi

# Ollama UGBrutal
echo -n "Ollama (UGBrutal 12): "
if curl -s http://192.168.2.12:11434/api/tags | grep -q "models"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
fi

# MongoDB
echo -n "MongoDB: "
if mongosh --host 192.168.2.33:27017 --eval "db.adminCommand('ping')" 2>/dev/null | grep -q "ok"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
fi

# n8n
echo -n "n8n: "
if curl -s https://n8n.specialblend.icu/healthz | grep -q "ok"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
fi

echo
echo "=== Done ==="
```

```bash
chmod +x /opt/scripts/health-check.sh
```

---

## 9. PM2 Ecosystem File

For managing both apps together:

```javascript
// /opt/ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'dataapi',
      cwd: '/opt/DataAPI',
      script: 'data_serv.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3003
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G'
    },
    {
      name: 'agentx',
      cwd: '/opt/AgentX',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3080
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G'
    }
  ]
};
```

```bash
pm2 start /opt/ecosystem.config.js
pm2 save
```

---

## 10. Quick Start Checklist

1. [ ] MongoDB running on 192.168.2.33:27017
2. [ ] DataAPI running on 192.168.2.33:3003
3. [ ] AgentX running on 192.168.2.33:3080
4. [ ] Ollama running on 192.168.2.99:11434 with Qwen
5. [ ] Ollama running on 192.168.2.12:11434 with Llama, DeepSeek, Gemma, nomic-embed
6. [ ] n8n running on 192.168.2.199:5678
7. [ ] SMB mounts configured on n8n host
8. [ ] API keys generated and configured
9. [ ] n8n credentials created for DataAPI and AgentX
10. [ ] Health check script passes all checks

---

## 11. Logs & Debugging

```bash
# DataAPI logs
pm2 logs dataapi

# AgentX logs
pm2 logs agentx

# Ollama logs
journalctl -u ollama -f

# n8n logs
docker logs -f n8n

# MongoDB logs
sudo tail -f /var/log/mongodb/mongod.log
```

---

## 12. Backup Strategy

### MongoDB

```bash
# Daily backup script
#!/bin/bash
DATE=$(date +%Y%m%d)
mongodump --host 192.168.2.33:27017 --out /backup/mongodb/$DATE
# Keep last 7 days
find /backup/mongodb -mtime +7 -type d -exec rm -rf {} \;
```

### n8n Workflows

Export workflows via n8n UI or API and store in git.

### Configuration

Keep all `.env` files in a secure backup location (encrypted).
