# SBQC Stack Documentation

**Complete architecture, API reference, and deployment guide for the SBQC AI Stack**

**Last Updated:** December 31, 2025  
**Status:** ✅ Production Ready  
**Coverage:** 98%

---

## 🎯 Quick Navigation

### New to SBQC Stack?
**Start here in order:**
1. [00-OVERVIEW.md](00-OVERVIEW.md) - System overview & infrastructure
2. [01-ARCHITECTURE.md](01-ARCHITECTURE.md) - Design principles & data flows
3. [05-DEPLOYMENT.md](05-DEPLOYMENT.md#environment-variables-reference) - Configuration guide
4. [07-AGENTX-API-REFERENCE.md](07-AGENTX-API-REFERENCE.md) - API documentation

### Building n8n Workflows?
→ [04-N8N-WORKFLOWS.md](04-N8N-WORKFLOWS.md) - Complete workflow specifications with webhook URLs

### Need to Validate Features?
→ [03-AGENTX-TASKS.md](03-AGENTX-TASKS.md) - AgentX validation tasks  
→ [02-DATAAPI-TASKS.md](02-DATAAPI-TASKS.md) - DataAPI validation tasks

### Debugging Issues?
→ [01-ARCHITECTURE.md](01-ARCHITECTURE.md) - System diagram & component details  
→ [00-OVERVIEW.md](00-OVERVIEW.md#infrastructure-summary) - Infrastructure & MongoDB schemas

---

## 📚 Complete File Index

| File | Purpose | When to Read |
|------|---------|--------------|
| **[README.md](README.md)** | This file - Navigation hub | Finding documentation |
| **[00-OVERVIEW.md](00-OVERVIEW.md)** | System architecture overview | Understanding the stack |
| **[00-AUDIT-SUMMARY.md](00-AUDIT-SUMMARY.md)** | Documentation audit results | QA & recent changes |
| **[01-ARCHITECTURE.md](01-ARCHITECTURE.md)** | Design principles & diagrams | Deep technical understanding |
| **[02-DATAAPI-TASKS.md](02-DATAAPI-TASKS.md)** | DataAPI validation & roadmap | DataAPI development |
| **[03-AGENTX-TASKS.md](03-AGENTX-TASKS.md)** | AgentX validation & roadmap | AgentX development |
| **[04-N8N-WORKFLOWS.md](04-N8N-WORKFLOWS.md)** | Workflow specifications | Building automations |
| **[05-DEPLOYMENT.md](05-DEPLOYMENT.md)** | Deployment & env config | Setup & configuration |
| **[06-AGENT-PROMPTS.md](06-AGENT-PROMPTS.md)** | System prompts for AI agents | Agent configuration |
| **[07-AGENTX-API-REFERENCE.md](07-AGENTX-API-REFERENCE.md)** | Complete API docs (40+ endpoints) | API integration |
| **[archive/](archive/)** | Historical/superseded documents | Reference only |

---

## 🏗️ System Components

### AgentX (192.168.2.33:3080)
AI orchestration layer with chat, RAG, user profiles, analytics, and n8n integration.

**Key Features:**
- Chat with conversation memory
- RAG (Retrieval-Augmented Generation)
- User profiles & memory injection
- Model routing (multi-Ollama support)
- Voice I/O (future)
- Feedback collection & A/B testing

**Documentation:**
- [07-AGENTX-API-REFERENCE.md](07-AGENTX-API-REFERENCE.md) - All endpoints
- [03-AGENTX-TASKS.md](03-AGENTX-TASKS.md) - Validation & roadmap

### DataAPI (192.168.2.33:3003)
File indexing, storage scanning, and data management service.

**Key Features:**
- NAS file scanning with batch processing
- File browser with duplicate detection
- Storage statistics & cleanup recommendations
- Integration event sink for n8n

**Documentation:**
- [02-DATAAPI-TASKS.md](02-DATAAPI-TASKS.md) - Validation & roadmap
- [04-N8N-WORKFLOWS.md](04-N8N-WORKFLOWS.md) - How n8n uses DataAPI

### n8n (192.168.2.199:5678)
Workflow automation and orchestration platform.

**Infrastructure:**
- Host: Ubundocker (192.168.2.199)
- Deployment: Docker container
- Local: http://192.168.2.199:5678
- Public: https://n8n.specialblend.icu (Cloudflare Tunnel)

**Active Workflows:**
- N1.1: System Health Check
- N1.3: Ops AI Diagnostic
- N2.1: NAS File Scanner
- N2.2: Full Scan (Inverse)
- N2.3: RAG Document Ingestion
- N3.1: Model Health Monitor
- N3.2: External AI Gateway
- N5.1: Feedback Analysis

**Documentation:**
- [04-N8N-WORKFLOWS.md](04-N8N-WORKFLOWS.md) - Complete specifications

### Ollama Inference Cluster
Distributed LLM inference across multiple GPU hosts.

**Hosts:**
- UGFrank (192.168.2.99) - Primary front-door, 3080 Ti
- UGBrutal (192.168.2.12) - Specialist models, 5070 Ti

**Documentation:**
- [00-OVERVIEW.md](00-OVERVIEW.md#infrastructure-summary) - Full topology
- [01-ARCHITECTURE.md](01-ARCHITECTURE.md) - System diagram

---

## 📊 Documentation Quality

### Recent Audit Results
- **Critical Issues:** 0 (was 3) ✅
- **Missing Endpoints:** 0 (was 40+) ✅
- **Coverage:** 98% (was 70%) 📈
- **Status:** Production Ready 🚀

See [00-AUDIT-SUMMARY.md](00-AUDIT-SUMMARY.md) for complete audit details.

### What's Documented
- ✅ All 40+ API endpoints with examples
- ✅ All 7 n8n webhook URLs verified
- ✅ 20+ environment variables
- ✅ Complete deployment guide
- ✅ Cross-document navigation
- ✅ Architecture diagrams & data flows

---

## 🚀 Quick Reference

### Common API Endpoints
```bash
# AgentX
POST http://192.168.2.33:3080/api/chat              # Send chat message
GET  http://192.168.2.33:3080/api/history/          # List conversations
POST http://192.168.2.33:3080/api/rag/ingest        # Ingest document
GET  http://192.168.2.33:3080/api/analytics/usage   # Usage stats

# DataAPI
GET  http://192.168.2.33:3003/api/v1/storage/scans  # List scans
POST http://192.168.2.33:3003/api/v1/storage/scan   # Create scan
GET  http://192.168.2.33:3003/api/v1/files/browse   # Browse files
```

### Webhook URLs (n8n)
```
https://n8n.specialblend.icu/webhook/sbqc-n1-1-health-check
https://n8n.specialblend.icu/webhook/sbqc-n2-1-nas-scan
https://n8n.specialblend.icu/webhook/sbqc-ai-query
```

### Environment Variables
```bash
# AgentX
MONGODB_URI=mongodb://192.168.2.33:27017/agentx
OLLAMA_HOST=http://192.168.2.99:11434
AGENTX_API_KEY=<generate with crypto.randomBytes>

# DataAPI
MONGODB_URI=mongodb://192.168.2.33:27017/SBQC
N8N_API_KEY=<same as AGENTX_API_KEY>
```

See [05-DEPLOYMENT.md](05-DEPLOYMENT.md#environment-variables-reference) for complete list.

---

## 🤝 Contributing

When updating documentation:

1. **Verify against code** - Ensure endpoints/features actually exist
2. **Update cross-references** - Check all files that link to what you changed
3. **Follow naming conventions** - Use consistent terminology throughout
4. **Test examples** - Verify curl commands and code snippets work
5. **Update audit summary** - Add entry to [00-AUDIT-SUMMARY.md](00-AUDIT-SUMMARY.md) document history

---

## 📝 License & Support

Part of the SBQC AI Stack project.

**Need help?** Check the documentation files listed above, or review the audit summary for recent changes.

**Found an issue?** Document it in [00-AUDIT-SUMMARY.md](00-AUDIT-SUMMARY.md) following the existing format.
