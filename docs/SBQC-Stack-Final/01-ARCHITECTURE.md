# 01 - Complete System Architecture

**Version:** 1.0  
**Date:** December 26, 2025

📖 **See Also:**  
→ [04-N8N-WORKFLOWS.md](04-N8N-WORKFLOWS.md) - Workflow implementations of these design principles  
→ [07-AGENTX-API-REFERENCE.md](07-AGENTX-API-REFERENCE.md) - Complete API documentation

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                 USER INTERFACES                                      │
│                                                                                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────────────┐  │
│  │   AgentX Web UI  │  │   Voice Client   │  │  CLI / API / External Apps       │  │
│  │   (Chat + RAG)   │  │   (Future)       │  │  (curl, Postman, mobile, etc.)   │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────────┬───────────────────┘  │
│           │                     │                            │                       │
└───────────┼─────────────────────┼────────────────────────────┼───────────────────────┘
            │                     │                            │
            ▼                     ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          AgentX (192.168.2.33:3080)                                 │
│                                                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │  Chat Service   │  │  User Memory    │  │  RAG Service    │  │  Model Router │  │
│  │  - Conversations│  │  - Profiles     │  │  - Embeddings   │  │  - Front Door │  │
│  │  - Messages     │  │  - Preferences  │  │  - Vector Store │  │  - Specialist │  │
│  │  - Prompt Mgmt  │  │  - Injection    │  │  - Search       │  │    Dispatch   │  │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  └───────┬───────┘  │
│           │                    │                    │                    │          │
│  ┌────────┴────────────────────┴────────────────────┴────────────────────┴───────┐  │
│  │                             Feedback & Analytics                              │  │
│  │   - Message Ratings (👍/👎)  - Usage Stats  - RAG Performance  - Datasets    │  │
│  └───────────────────────────────────┬───────────────────────────────────────────┘  │
│                                      │                                              │
│                               ┌──────▼──────┐                                       │
│                               │  Benchmark  │                                       │
│                               │  - Service  │                                       │
│                               │  - Quality  │                                       │
│                               └─────────────┘                                       │
│                                                                                      │
│  API Endpoints:                                                                      │
│  POST /api/chat           GET /api/conversations    POST /api/rag/ingest            │
│  POST /api/feedback       GET /api/user/profile     POST /api/rag/search            │
│  GET  /api/analytics/*    GET /api/dataset/*        GET  /api/n8n/health            │
│  POST /api/n8n/trigger/*  POST /api/n8n/event/*     POST /api/n8n/rag/ingest        │
│                                                                                      │
└───────────────────────────────────────────────┬─────────────────────────────────────┘
                                                │
         ┌──────────────────────────────────────┼──────────────────────────────────────┐
         │                                      │                                       │
         ▼                                      ▼                                       ▼
┌─────────────────────────┐  ┌─────────────────────────────────┐  ┌─────────────────────────┐
│  Ollama @ UGFrank       │  │  Ollama @ UGBrutal              │  │  DataAPI (192.168.2.33) │
│  192.168.2.99:11434     │  │  192.168.2.12:11434             │  │  :3003                  │
│                         │  │                                 │  │                         │
│  ┌───────────────────┐  │  │  ┌───────────────────────────┐  │  │  ┌───────────────────┐  │
│  │  Qwen 2.5 7B      │  │  │  │  DeepSeek R1:8B           │  │  │  │  Storage Scans    │  │
│  │  (Front Door)     │  │  │  │  (Deep Reasoning)         │  │  │  │  - NAS indexing   │  │
│  └───────────────────┘  │  │  └───────────────────────────┘  │  │  │  - Directory walk │  │
│  ┌───────────────────┐  │  │  ┌───────────────────────────┐  │  │  └───────────────────┘  │
│  │  Qwen 2.5:3B      │  │  │  │  Qwen 2.5-coder:14B       │  │  │  ┌───────────────────┐  │
│  │  Qwen 3:4B/8B     │  │  │  │  (Code Generation)        │  │  │  │  File Browser     │  │
│  └───────────────────┘  │  │  └───────────────────────────┘  │  │  │  - Query/filter   │  │
│  ┌───────────────────┐  │  │  ┌───────────────────────────┐  │  │  │  - Duplicates     │  │
│  │  nomic-embed-text │  │  │  │  Gemma 3:12B              │  │  │  │  - Exports        │  │
│  │  (RAG Embeddings) │  │  │  │  (Vision, Creative)       │  │  │  └───────────────────┘  │
│  └───────────────────┘  │  │  └───────────────────────────┘  │  │  ┌───────────────────┐  │
│                         │  │  ┌───────────────────────────┐  │  │  │  Integration Sink │  │
│  Role: Low-latency      │  │  │  Qwen 3:14B               │  │  │  │  - n8n events     │  │
│  conversational entry   │  │  │  Llama 3.1:8B             │  │  │  │  - ClickUp        │  │
│  point. Quick queries.  │  │  └───────────────────────────┘  │  │  └───────────────────┘  │
│                         │  │                                 │  │                         │
│  GPU: RTX 3080 Ti 12GB  │  │  GPU: RTX 5070 Ti               │  │  API Endpoints:         │
│                         │  │  Role: Heavy workloads          │  │  /api/v1/storage/*      │
└─────────────────────────┘  └─────────────────────────────────┘  │  /api/v1/files/*        │
                                                                   │  /integrations/*        │
                                                                   │  (n8n routes → AgentX)  │
                                                                   └─────────────────────────┘
                                                                              │
                                                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           n8n (192.168.2.199:5678)                                  │
│                     https://n8n.specialblend.icu (Cloudflare Tunnel)                │
│                                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  SCHEDULED WORKFLOWS                                                         │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │   │
│  │  │  Health Check   │  │  NAS File Scan  │  │  Backup/Cleanup │              │   │
│  │  │  (5 min)        │  │  (Daily 2AM)    │  │  (Weekly)       │              │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘              │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  WEBHOOK WORKFLOWS                                                           │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │   │
│  │  │  Scan Complete  │  │  Files Exported │  │  Storage Alert  │              │   │
│  │  │  (from DataAPI) │  │  (from DataAPI) │  │  (from DataAPI) │              │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘              │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  AI INTEGRATION WORKFLOWS                                                    │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │   │
│  │  │  RAG Ingestion  │  │  Chat Trigger   │  │  Feedback Loop  │              │   │
│  │  │  (to AgentX)    │  │  (AI routing)   │  │  (Optimization) │              │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘              │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  SMB Mounts: /mnt/media, /mnt/datalake                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                                │
                                                ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         MongoDB (192.168.2.33:27017)                                │
│                                                                                      │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────────────────┐ │
│  │  SBQC (Main DB)    │  │  agentx            │  │  datalake_janitor              │ │
│  │                    │  │                    │  │  (merge candidate)             │ │
│  │  - nas_files       │  │  - conversations   │  │                                │ │
│  │  - nas_scans       │  │  - promptconfigs   │  │  - nas_files                   │ │
│  │  - users           │  │  - sessions        │  │  - nas_scans                   │ │
│  │  - profiles        │  │  - userprofiles    │  │  - nas_duplicates              │ │
│  │  - appevents       │  │                    │  │  - nas_findings                │ │
│  │  - integration_evts│  │                    │  │  - nas_chunks                  │ │
│  │  - weatherLocations│  │                    │  │  - nas_settings                │ │
│  │  - (25+ more)      │  │                    │  │                                │ │
│  └────────────────────┘  └────────────────────┘  └────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Diagrams

### Flow 1: Chat Request with RAG

```
User → AgentX UI
         │
         ▼
    POST /api/chat
    {model, message, useRag: true}
         │
         ├─────────────────────────────┐
         │                             │
         ▼                             ▼
    Get User Profile            RAG Search
    (MongoDB: agentx)           (embeddings via Ollama)
         │                             │
         └──────────────┬──────────────┘
                        │
                        ▼
              Build System Prompt
              (memory + RAG context)
                        │
                        ▼
              Call Ollama (model routing)
              - Qwen @ 99 (quick)
              - Llama @ 12 (complex)
                        │
                        ▼
              Store Conversation
              (MongoDB: agentx.conversations)
                        │
                        ▼
              Return Response
              {message, ragUsed, ragSources}
```

### Flow 2: NAS File Scanning (Datalake Janitor)

```
n8n Schedule Trigger (2AM daily)
         │
         ▼
    Create Scan Record
    POST DataAPI /api/v1/storage/scan
         │
         ▼
    Walk SMB Mounts
    (n8n Execute Command / FTP node)
         │
         ▼ (for each batch of files)
    Bulk Insert Files
    POST DataAPI /api/v1/files/bulk
    {files: [...], scanId: "..."}
         │
         ▼
    Check Scan Status
    GET DataAPI /api/v1/storage/status/:id
         │
         ▼
    Enrichment Loop
    - SHA256 hash
    - MIME type detection
    - EXIF extraction
    - Embed metadata (Ollama nomic-embed)
         │
         ▼
    Dedupe Analysis
    - Find files with same hash
    - Mark canonical copies
    - Log to nas_duplicates
         │
         ▼
    Notify AgentX
    POST AgentX /api/n8n/event/scan_complete
         │
         ▼
    Optional: Send Report
    (Email, Slack, Dashboard)
```

### Flow 3: SBQC Ops Agent Health Check

```
n8n Schedule Trigger (every 5 min)
         │
         ▼
    ┌────────────────┬────────────────┐
    │                │                │
    ▼                ▼                ▼
  DataAPI         AgentX           Ollama
  /api/v1/        /health          /api/tags
  n8n/health                       (both hosts)
    │                │                │
    └────────────────┴────────────────┘
                     │
                     ▼
              Aggregate Status
              {dataapi: ok, agentx: ok, ollama_99: ok, ollama_12: ok}
                     │
                     ▼ (if any degraded)
              Trigger Alert
              - Log to MongoDB
              - Send notification
              - Optionally: Call AI to diagnose
```

---

## Authentication Matrix

| Source | Target | Auth Method | Header/Credential |
|--------|--------|-------------|-------------------|
| Browser | AgentX | Session (cookie) | connect.sid |
| n8n | DataAPI | API Key | `x-api-key: $N8N_API_KEY` |
| n8n | AgentX | API Key | `x-api-key: $AGENTX_N8N_KEY` |
| AgentX | DataAPI | API Key | `x-api-key: $DATAAPI_API_KEY` |
| AgentX | Ollama | None | (LAN trusted) |
| DataAPI | Ollama | None | (LAN trusted) |

---

## Environment Variables Reference

### DataAPI (.env)
```bash
PORT=3003
MONGODB_URI=mongodb://192.168.2.33:27017/SBQC
N8N_API_KEY=<generate-with-openssl>
N8N_LAN_ONLY=true
N8N_WEBHOOK_BASE_URL=https://n8n.specialblend.icu
N8N_WEBHOOK_SCAN_COMPLETE=<webhook-id>
N8N_WEBHOOK_FILES_EXPORTED=<webhook-id>
N8N_WEBHOOK_STORAGE_ALERT=<webhook-id>
```

### AgentX (.env)
```bash
PORT=3080
MONGODB_URI=mongodb://192.168.2.33:27017/agentx
OLLAMA_HOST=192.168.2.99:11434
OLLAMA_HOST_HEAVY=192.168.2.12:11434
EMBEDDING_MODEL=nomic-embed-text
DATAAPI_BASE_URL=http://192.168.2.33:3003
DATAAPI_API_KEY=<same-as-above>
N8N_API_KEY=<for-n8n-routes>
```

### n8n (Credentials)
```
DataAPI HTTP Header Auth:
  - Header Name: x-api-key
  - Header Value: <N8N_API_KEY>

AgentX HTTP Header Auth:
  - Header Name: x-api-key  
  - Header Value: <AGENTX_N8N_KEY>
```

---

## Model Allocation Strategy

| Model | Host | Use Case | Context | Notes |
|-------|------|----------|---------|-------|
| Qwen 2.5 7B | UGFrank (99) | Front-door chat | 8K-32K | Fast responses, conversational |
| Llama 3.3 70B | UGBrutal (12) | Planning, coding | 128K | Heavy tasks, Q4 quantization |
| DeepSeek R1 32B | UGBrutal (12) | Deep reasoning | 32K | Chain-of-thought |
| Gemma 3 12B | UGBrutal (12) | Vision, creative | 8K | Image analysis |
| nomic-embed-text | UGBrutal (12) | RAG embeddings | N/A | 768-dim vectors |
| Whisper | UGFrank (99) | Speech-to-text | N/A | Future: voice input |

---

## Port Summary

| Port | Service | Host |
|------|---------|------|
| 3003 | DataAPI | 192.168.2.33 |
| 3080 | AgentX | 192.168.2.33 |
| 5678 | n8n | 192.168.2.199 |
| 11434 | Ollama | 192.168.2.99, 192.168.2.12 |
| 27017 | MongoDB | 192.168.2.33 |
