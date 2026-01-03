# SBQC Stack - Final Architecture Overview

**Created:** December 26, 2025  
**Purpose:** Consolidated architecture and task breakdown for AI coding agents

---

## � How to Use This Documentation

**New to the SBQC Stack? Start here:**
1. **Read this file first** (00-OVERVIEW.md) - Understand the big picture
2. [01-ARCHITECTURE.md](01-ARCHITECTURE.md) - Learn design principles
3. [05-DEPLOYMENT.md](05-DEPLOYMENT.md#environment-variables-reference) - Configure your environment
4. [07-AGENTX-API-REFERENCE.md](07-AGENTX-API-REFERENCE.md) - Explore available endpoints

**Building workflows?**
→ [04-N8N-WORKFLOWS.md](04-N8N-WORKFLOWS.md) - See existing patterns and webhook URLs

**Debugging issues?**
→ [01-ARCHITECTURE.md](01-ARCHITECTURE.md) - System diagram and data flows  
→ [Infrastructure Summary](#infrastructure-summary) - Network topology (this doc)  
→ [MongoDB Structure](#mongodb-structure) - Database schemas (this doc)

**Validating features?**
→ [03-AGENTX-TASKS.md](03-AGENTX-TASKS.md) - AgentX validation tasks  
→ [02-DATAAPI-TASKS.md](02-DATAAPI-TASKS.md) - DataAPI validation tasks

---

## 📋 Document Index

| File | Purpose | When to Read |
|------|---------|--------------|
| [README.md](README.md) | **📖 START HERE** - Navigation hub for all docs | Finding your way |
| [00-AUDIT-SUMMARY.md](00-AUDIT-SUMMARY.md) | Documentation audit summary & fixes | Internal QA |
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | Complete system diagram, components, flows | Understanding "why" |
| [02-DATAAPI-TASKS.md](02-DATAAPI-TASKS.md) | DataAPI validation + feature roadmap | DataAPI development |
| [03-AGENTX-TASKS.md](03-AGENTX-TASKS.md) | AgentX validation + feature roadmap | AgentX development |
| [04-N8N-WORKFLOWS.md](04-N8N-WORKFLOWS.md) | n8n workflow specifications | Building automations |
| [05-DEPLOYMENT.md](05-DEPLOYMENT.md) | Deployment & environment configuration | Setup & deployment |
| [06-AGENT-PROMPTS.md](06-AGENT-PROMPTS.md) | System prompts for AI coding agents | Agent configuration |
| [07-AGENTX-API-REFERENCE.md](07-AGENTX-API-REFERENCE.md) | Complete API documentation (72+ endpoints) v1.1 | API integration |
| [../features/PERFORMANCE_MONITORING.md](../features/PERFORMANCE_MONITORING.md) | Performance dashboard guide (Track 5) | Load testing & monitoring |
| [archive/DISCREPANCY_AUDIT.md](archive/DISCREPANCY_AUDIT.md) | Detailed audit findings (archived) | Historical reference |
| [archive/AGENT_C_PLAN_v2.md](archive/AGENT_C_PLAN_v2.md) | Agent C planning doc (archived) | Historical reference |

---

## 🎯 Priority Order (Confirmed) �📋 Document Index

| File | Purpose |
|------|---------|
| [00-AUDIT-SUMMARY.md](00-AUDIT-SUMMARY.md) | **⚠️ READ FIRST** - Documentation audit summary & remaining fixes |
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | Complete system diagram, components, and data flows |
| [02-DATAAPI-TASKS.md](02-DATAAPI-TASKS.md) | DataAPI repo: validation + new features needed |
| [03-AGENTX-TASKS.md](03-AGENTX-TASKS.md) | AgentX repo: validation + new features needed |
| [04-N8N-WORKFLOWS.md](04-N8N-WORKFLOWS.md) | n8n workflow specifications |
| [05-DEPLOYMENT.md](05-DEPLOYMENT.md) | How to run & configure everything |
| [06-AGENT-PROMPTS.md](06-AGENT-PROMPTS.md) | System prompts for coding agents |
| [07-AGENTX-API-REFERENCE.md](07-AGENTX-API-REFERENCE.md) | **✅ v1.1** Complete API reference with 72+ endpoints (includes Performance) |
| [DISCREPANCY_AUDIT.md](DISCREPANCY_AUDIT.md) | Detailed audit findings with impact analysis |

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
| **Ubundocker** | 192.168.2.199 | Automation | n8n:5678 (Docker container)<br/>Public: https://n8n.specialblend.icu (Cloudflare Tunnel) |

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
- ✅ Chat with conversation logging (`POST /api/chat`)
- ✅ User profiles & memory injection (`GET/POST /api/profile`)
- ✅ Feedback collection (`POST /api/feedback`)
- ✅ Conversation history (`GET /api/history/*`)
- ✅ RAG (V3): ingest, search, integration (`POST /api/rag/*`)
- ✅ Analytics (V4): usage, feedback, stats (`GET /api/analytics/*`)
- ✅ Dataset export (`GET /api/dataset/*`)
- ✅ Prompt management & A/B testing (`GET/POST /api/prompts/*`)
- ✅ Voice I/O services (`POST /api/voice/*`)
- ✅ Model routing (`GET/POST /api/models/*`)
- ✅ **n8n Integration** (`POST /api/n8n/*`) - health checks, webhook triggers
- ✅ Frontend chat UI + n8n-control.html
- ⚠️ Needs validation testing

**Complete AgentX API Endpoints (port 3080):**

```
Chat & Conversations
POST /api/chat                           - Send message with RAG/routing
GET  /api/history/                       - List conversations
GET  /api/history/:id                    - Get conversation + history
PATCH /api/history/conversations/:id     - Update conversation title

User & Feedback
GET  /api/profile                        - Get user preferences
POST /api/profile                        - Create/update profile
POST /api/feedback                       - Submit message ratings

Analytics & Data Export
GET  /api/analytics/usage                - Usage metrics
GET  /api/analytics/feedback             - Feedback metrics
GET  /api/analytics/rag/stats            - RAG performance
GET  /api/dataset/conversations          - Export conversations
GET  /api/dataset/prompts                - List prompts
POST /api/dataset/prompts                - Create prompt version

RAG Integration
POST /api/rag/ingest                     - Ingest documents
POST /api/rag/search                     - Search documents
GET  /api/rag/documents                  - List documents

Model Management
GET  /api/models/routing                 - Routing config
POST /api/models/classify                - Classify query

Prompt Management
GET  /api/prompts/                       - List prompts
GET  /api/prompts/:name                  - Get prompt
POST /api/prompts/                       - Create prompt
POST /api/prompts/:name/ab-test          - Configure A/B test

Voice I/O
GET  /api/voice/health                   - Voice service status
POST /api/voice/transcribe               - Speech to text
POST /api/voice/synthesize               - Text to speech
POST /api/voice/chat                     - Voice chat

n8n Integration
GET  /api/n8n/diagnostic                 - Connection test
GET  /api/n8n/health                     - Health check
POST /api/n8n/rag/ingest                 - Trigger RAG ingest
POST /api/n8n/chat/complete              - Trigger chat webhook
POST /api/n8n/analytics                  - Trigger analytics
POST /api/n8n/trigger/:id                - Generic trigger
POST /api/n8n/event/:type                - Event trigger
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
- [x] n8n workflow N2.3 for RAG document ingestion (**WORKING**)
- [x] RAG embedding for file metadata (endpoint ready)

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

## 📊 n8n Workflow Status

| Workflow | Status | Notes |
|----------|--------|-------|
| **N1.1** System Health Check | ✅ Working | Every 5 min, monitors all services |
| **N1.1b** Duplicate Orchestrator | ❌ Removed | Was duplicate of N2.1 |
| **N1.2** Storage Event Handler | ❌ Removed | DataAPI doesn't push events to n8n |
| **N1.3** Ops AI Diagnostic | 🔄 Pending test | AI-powered system analysis via webhook |
| **N2.1** NAS File Scanner | ✅ Working | Daily 2AM, triggers DataAPI scan |
| **N2.2** NAS Full/Other Scan | 🔄 Pending test | Weekly inverse scan for non-standard files |
| **N2.3** RAG Document Ingestion | ✅ **WORKING** | Ingests docs from /mnt/datalake/RAG to Qdrant |
| **N3.1** Model Health Monitor | 🔄 Pending test | Track Ollama latency every 10 min |
| **N3.2** External AI Gateway | ✅ Built | ⏳ Pending Import & Testing | Webhook to route external queries through AgentX |
| **N5.1** Feedback Analysis | ✅ Built | ⏳ Pending Import & Testing | Weekly prompt optimization analysis |

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
