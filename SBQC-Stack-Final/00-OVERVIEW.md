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
| **UGBrutal** | 192.168.2.12 | GPU Inference (5070 Ti) | Ollama: Llama 3.3 70B, DeepSeek R1 32B, Gemma 3, nomic-embed-text |
| **UGFrank** | 192.168.2.99 | GPU Inference (3080 Ti) | Ollama: Qwen 2.5 7B (front-door), Whisper (STT) |
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

### Priority 1: SBQC Ops Agent
- [ ] Validate DataAPI health/storage endpoints
- [ ] Create n8n health check workflow
- [ ] Create SBQC Ops agent persona in AgentX
- [ ] Wire agent to DataAPI via MCP-style HTTP tool calls

### Priority 2: Datalake Janitor
- [ ] Validate/extend n8n file scanning capabilities
- [ ] Implement SHA256 hashing in DataAPI
- [ ] Build deduplication logic
- [ ] RAG embedding for file metadata
- [ ] Chat tools for file.search, dedupe.suggestDeletes

### Priority 3: Multi-Model Routing
- [ ] Model router service in AgentX
- [ ] Front-door (Qwen) → specialist routing
- [ ] n8n workflow for model health monitoring

### Priority 4: Voice I/O
- [ ] Whisper integration (STT)
- [ ] TTS service selection
- [ ] Frontend voice controls

### Priority 5: Self-Improving Loop
- [ ] Aggregate feedback analytics
- [ ] Prompt version A/B testing
- [ ] n8n workflow for prompt optimization

---

## 🧹 Cleanup Tasks (Stale Documentation)

The following files in **DataAPI repo** reference `/api/v1/n8n/*` endpoints that were **removed/migrated to AgentX**. They should be archived or deleted:

| File | Status | Action |
|------|--------|--------|
| `dataapi/N8N_INTEGRATION.md` | ❌ Stale | Archive to `docs/archive/` |
| `dataapi/N8N_QUICKSTART.md` | ❌ Stale | Archive to `docs/archive/` |
| `dataapi/N8N_WEBHOOK_INTEGRATION.md` | ❌ Stale | Archive to `docs/archive/` |
| `dataapi/N8N_NODE_SETUP.md` | ❌ Stale | Archive to `docs/archive/` |
| `dataapi/N8N_IMPLEMENTATION_SUMMARY.md` | ❌ Stale | Archive to `docs/archive/` |
| `dataapi/SBQC.json` | ⚠️ Outdated | Update URLs to use AgentX endpoints |
| `dataapi/Ollama.14b.Chatbot.json` | ⚠️ Outdated | Update URLs to use AgentX endpoints |
| `dataapi/views/archived/n8n-test.ejs` | ⚠️ References old endpoints | Already in archived folder |
| `dataapi/views/archived/ai-control.ejs` | ⚠️ References old endpoints | Already in archived folder |

**Recommended cleanup command:**
```bash
cd dataapi
mkdir -p docs/archive/n8n-legacy
mv N8N_*.md docs/archive/n8n-legacy/
```
- [ ] n8n workflow for prompt optimization
