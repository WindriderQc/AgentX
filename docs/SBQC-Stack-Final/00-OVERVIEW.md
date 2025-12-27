# SBQC Stack - Final Architecture Overview

**Created:** December 26, 2025  
**Purpose:** Consolidated architecture and task breakdown for AI coding agents

---

## 📋 Document Index

| File | Purpose |
|------|---------|
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | Complete system diagram, components, and data flows |
| [02-DATAAPI-TASKS.md](02-DATAAPI-TASKS.md) | DataAPI repo: validation + new features needed |
| [03-AGENTX-TASKS.md](03-AGENTX-TASKS.md) | AgentX repo: validation + new features needed |
| [04-N8N-WORKFLOWS.md](04-N8N-WORKFLOWS.md) | n8n workflow specifications |
| [05-DEPLOYMENT.md](05-DEPLOYMENT.md) | How to run & configure everything |
| [06-AGENT-PROMPTS.md](06-AGENT-PROMPTS.md) | System prompts for coding agents |

---

## 🎯 Priority Order (Confirmed)

1. **SBQC Ops Agent** - Infrastructure monitoring via AI
2. **Datalake Janitor** - File indexing, deduplication, cleanup
3. **Multi-Model Chat Routing** - Distribute tasks across Ollama hosts
4. **Voice I/O** - Speech-to-text and text-to-speech
5. **Self-Improving Feedback Loop** - Prompt optimization from ratings

---

## 🖥️ Infrastructure Summary

| Host | IP | Role | Services |
|------|-----|------|----------|
| **UGBrutal** | 192.168.2.12 | GPU Inference (5070 Ti) | Ollama: deepseek-r1:8b, gemma3:12b-it-qat, qwen2.5-coder:14b, qwen3:14b, llama3.1:8b |
| **UGFrank** | 192.168.2.99 | GPU Inference (3080 Ti) | Ollama: qwen2.5:7b-instruct-q4_0, qwen2.5:3b, qwen3:4b, qwen3:8b, nomic-embed-text:latest |
| **Docker Host** | 192.168.2.33 | App Server | DataAPI:3003, AgentX:3080, MongoDB:27017 |
| **UGStation** | 192.168.2.199 | Automation | n8n:5678 (tunneled to https://n8n.specialblend.icu) |

---

## 📊 MongoDB Structure

**Connection:** `mongodb://192.168.2.33:27017`

| Database | Collections | Purpose |
|----------|-------------|---------|
| **SBQC** | nas_files, nas_scans, appevents, users, profiles, etc. | Main DataAPI data |
| **agentx** | conversations, promptconfigs, sessions, userprofiles | AgentX chat & memory |
| **datalake_janitor** | nas_files, nas_scans, nas_duplicates, nas_findings, nas_chunks, nas_settings | Janitor-specific (can merge with SBQC) |

---

## 🔗 External Integrations

- **n8n → DataAPI:** HTTP requests for file/storage data (`/api/v1/storage/*`, `/api/v1/files/*`)
- **n8n → AgentX:** HTTP requests for AI triggers (`/api/n8n/*`)
- **AgentX → n8n:** Webhook triggers (RAG ingest, chat complete, analytics events)
- **DataAPI → n8n:** Event sink receives n8n POSTs (`/integrations/events/n8n`)
- **AgentX → Ollama:** Inference requests to both hosts
- **SMB Mounts:** n8n host → NAS shares for file scanning

---

## ✅ What's Already Built

### DataAPI (192.168.2.33:3003)
- ✅ Storage scanning (`/api/v1/storage/*`) - API key OR session auth
- ✅ File browser & exports (`/api/v1/files/*`) - API key OR session auth  
- ✅ Integration event sink (`/integrations/events/n8n`) - receives events FROM n8n
- ❌ **n8n trigger routes REMOVED** - migrated to AgentX `/api/n8n/*`
- ⚠️ Stale docs to archive: `N8N_*.md`, `SBQC.json`, `Ollama.14b.Chatbot.json`
- ⚠️ Needs validation testing

### AgentX (192.168.2.33:3080)
- ✅ Chat with conversation logging
- ✅ User profiles & memory injection
- ✅ Feedback collection (thumbs up/down)
- ✅ RAG (V3): ingest, search, chat integration
- ✅ Analytics (V4): usage, feedback, RAG stats
- ✅ Dataset export for training
- ✅ **n8n API routes** (`/api/n8n/*`) - diagnostic, health, rag/ingest, chat/complete, analytics, trigger/:webhookId, event/:eventType
- ✅ Frontend chat UI + n8n-control.html
- ⚠️ Needs validation testing

**Key n8n Endpoints (AgentX port 3080):**
```
GET  /api/n8n/diagnostic     - Connection test
GET  /api/n8n/health         - Health check
POST /api/n8n/rag/ingest     - Trigger RAG webhook
POST /api/n8n/chat/complete  - Trigger chat webhook
POST /api/n8n/analytics      - Trigger analytics webhook
POST /api/n8n/trigger/:id    - Generic webhook trigger
POST /api/n8n/event/:type    - Event trigger
```

### n8n
- ✅ Running at https://n8n.specialblend.icu
- ⚠️ Needs workflows built

---

## 🚧 What Needs to Be Built

### Priority 1: SBQC Ops Agent ✅ COMPLETE
- [x] Validate DataAPI health/storage endpoints
- [x] Create SBQC Ops agent persona in AgentX (`sbqc_ops`)
- [x] Wire agent to DataAPI via tool calls (8 tools available)
- [x] Dashboard health endpoint with dual Ollama monitoring

### Priority 2: Datalake Janitor ✅ COMPLETE
- [x] Implement SHA256 hashing in DataAPI scanner
- [x] Create datalake_janitor persona in AgentX
- [x] Add janitor tools (file_search, janitor_flag, janitor_unflag, rag_file_metadata)
- [x] Duplicate detection working (found 1.6GB wasted space!)
- [ ] n8n workflow for scheduled scanning
- [ ] RAG embedding for file metadata (endpoint ready)

### Priority 3: Multi-Model Routing ✅ COMPLETE
- [x] Model router service in AgentX (`src/services/modelRouter.js`)
- [x] Front-door (Qwen 7B) → specialist routing (DeepSeek, Gemma, Qwen-coder)
- [x] GET /api/models/routing - routing status & available models
- [x] POST /api/models/classify - query classification preview
- [x] autoRoute & taskType params in /api/chat
- [ ] n8n workflow for model health monitoring

### Priority 4: Voice I/O ✅ COMPLETE
- [x] Voice service with local Whisper + OpenAI fallback (`src/services/voiceService.js`)
- [x] Voice routes: /health, /transcribe, /synthesize, /chat (`routes/voice.js`)
- [ ] Deploy faster-whisper-server on 192.168.2.99:8000 (currently uses OpenAI fallback)
- [ ] Frontend voice controls

### Priority 5: Self-Improving Loop ✅ COMPLETE
- [x] Feedback model with aggregation methods (`models/Feedback.js`)
- [x] Feedback summary endpoint with A/B comparison (`routes/analytics.js`)
- [x] Prompt CRUD and A/B test configuration (`routes/prompts.js`)
- [x] Weighted random selection in PromptConfig.getActive()
- [x] Comprehensive test suite (6 new test files)
- [ ] n8n workflow for prompt optimization

---

## 🧹 Cleanup Tasks (Stale Documentation)

### ✅ COMPLETED - DataAPI n8n Docs Archived

The following files have been **archived** to `dataapi/docs/archive/n8n-legacy/`:

| File | Status |
|------|--------|
| `N8N_INTEGRATION.md` | ✅ Archived |
| `N8N_QUICKSTART.md` | ✅ Archived |
| `N8N_WEBHOOK_INTEGRATION.md` | ✅ Archived |
| `N8N_NODE_SETUP.md` | ✅ Archived |
| `N8N_IMPLEMENTATION_SUMMARY.md` | ✅ Archived |
| `SBQC.json` | ✅ Archived |

The `dataapi/DOCS_INDEX.md` has been updated to point to the archived location and clarify that n8n triggers are now in AgentX.

### Remaining Cleanup
| Item | Status | Notes |
|------|--------|-------|
| `dataapi/views/archived/` | ✅ OK | Already in archived folder |
| AgentX docs | ✅ OK | Current and accurate |
