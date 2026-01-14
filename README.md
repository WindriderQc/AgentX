# AgentX v1.4.1

[![AgentX CI Pipeline](https://github.com/WindriderQc/AgentX/actions/workflows/ci.yml/badge.svg)](https://github.com/WindriderQc/AgentX/actions/workflows/ci.yml)
[![AgentX CD Pipeline](https://github.com/WindriderQc/AgentX/actions/workflows/cd.yml/badge.svg)](https://github.com/WindriderQc/AgentX/actions/workflows/cd.yml)

**Production-ready AI assistant platform with RAG, conversation memory, multi-tenancy, and automated improvement capabilities.**

AgentX transforms your local Ollama instance into a powerful AI platform with advanced features including knowledge augmentation (RAG), persistent conversation memory, team collaboration, analytics, and automated improvement loops via n8n integration.

---

## 🎯 Project Status

✅ **All 8 development tracks complete** - Production ready with comprehensive testing and CI/CD

See **[ROADMAP.md](ROADMAP.md)** for detailed status, **[CHANGELOG.md](CHANGELOG.md)** for version history.

---

## 📖 Documentation

**→ Complete documentation index:** **[docs/INDEX.md](docs/INDEX.md)** ← Start here!

### Quick Links

**👤 For Users:**
- [Getting Started](docs/onboarding/quickstart.md) - Installation & first steps
- [User Manual](docs/user-manual/README.md) - Complete UI guide
- [Troubleshooting](docs/guides/TROUBLESHOOTING.md) - Common issues & solutions

**👨‍💻 For Developers:**
- [Contributing Guide](CONTRIBUTING.md) - Development workflow
- [Architecture Overview](docs/architecture/backend-overview.md) - System design
- [API Reference](docs/architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md) - All endpoints

**🤖 For AI Agents (Claude Code):**
- [CLAUDE.md](CLAUDE.md) - Complete agent guidance

**📚 All Documentation:**
- [Complete Documentation Index](docs/INDEX.md) - Navigate all 226 docs

---

## 🌟 Key Features

### Core Capabilities
- **�� Advanced Chat Interface**: Rich UI with model selection, parameter tuning, and conversation history
- **🧠 Conversation Memory**: MongoDB-backed persistence with session management and feedback tracking
- **👤 User Profiles**: Personal memory injection into system prompts for context-aware responses
- **📚 RAG (Retrieval-Augmented Generation)**: Semantic search over your documents for knowledge-grounded answers
- **📊 Analytics & Metrics**: Track model performance, feedback rates, usage patterns, and cost estimation
- **🔄 Prompt Versioning**: A/B testing and continuous improvement of system prompts
- **🔌 n8n Integration**: Automated document ingestion and prompt optimization workflows
- **🛠️ Custom Models**: Register and tune models with advanced parameters (context size, GPU layers, threads) directly from the UI

### Technical Highlights
- **Service-Oriented Architecture (SOA):** Decoupled architecture with AgentX (Logic) and DataAPI (Data Services).
- **Vector Database:** Qdrant for high-performance, persistent vector storage.
- **Database:** MongoDB for conversation history, user profiles, and analytics.
- **Integration:** RESTful APIs with comprehensive contracts for n8n and external tools.
- **Resilience:** Self-healing capabilities and automated health monitoring.

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** 18+ 
- **MongoDB** (local or remote instance)
- **Ollama** with at least one chat model and `nomic-embed-text` for embeddings

### Installation

1. **Clone and install dependencies:**
   \`\`\`bash
   git clone https://github.com/WindriderQc/AgentX.git
   cd AgentX
   npm install
   \`\`\`

2. **Configure environment** (create \`.env\` file):
   \`\`\`bash
   MONGODB_URI=mongodb://localhost:27017/agentx
  # Single Ollama host
  OLLAMA_HOST=http://localhost:11434

  # Optional: multi-host Ollama discovery for the UI (Benchmark page host picker)
  # OLLAMA_HOST_PRIMARY=http://192.168.2.99:11434
  # OLLAMA_HOST_2=http://192.168.2.12:11434
   EMBEDDING_MODEL=nomic-embed-text
   PORT=3080
   \`\`\`

Notes:
- The Benchmark page populates its host dropdown via `GET /api/ollama-hosts`.
- The UI only falls back to `http://localhost:11434` if no hosts are configured on the server.

### DataAPI tool server (optional, recommended)

AgentX can use a companion headless tool server (DataAPI) for file scanning/search/exports. AgentX remains the only UI; browsers never talk to DataAPI directly.

AgentX integrates with DataAPI via server-side proxy routes under `/api/dataapi/*`.

Add to AgentX `.env`:

```bash
DATAAPI_BASE_URL=http://127.0.0.1:3003
DATAAPI_API_KEY=change-me-long-random
```

DataAPI must be configured with the matching `DATAAPI_API_KEY` and will require an `x-api-key` header on all tool endpoints under `/api/v1/*`.

3. **Start the server:**
   \`\`\`bash
   npm start
   \`\`\`

4. **Open your browser:**
   \`\`\`
   http://localhost:3080
   \`\`\`

See [Quick Start Guide](docs/onboarding/quickstart.md) for detailed setup instructions.

---

## 🎯 Usage Examples

### Basic Chat
\`\`\`bash
curl -X POST http://localhost:3080/api/chat \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "llama3",
    "message": "Explain quantum computing",
    "options": {"temperature": 0.7}
  }'
\`\`\`

### RAG-Enhanced Chat
\`\`\`bash
curl -X POST http://localhost:3080/api/chat \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "llama3",
    "message": "What does our documentation say about RAG?",
    "useRag": true,
    "ragTopK": 5
  }'
\`\`\`

### Document Ingestion
\`\`\`bash
curl -X POST http://localhost:3080/api/rag/ingest \\
  -H "Content-Type: application/json" \\
  -d '{
    "source": "docs",
    "path": "/guides/getting-started.md",
    "title": "Getting Started Guide",
    "text": "Your document content here...",
    "tags": ["guide", "documentation"]
  }'
\`\`\`

---

## 🗂️ Project Structure

\`\`\`
AgentX/
├── server.js              # Express app entry point
├── package.json           # Dependencies and scripts
├── config/
│   └── db.js             # MongoDB connection
├── models/               # Mongoose schemas
│   ├── Conversation.js   # Chat history with feedback
│   ├── UserProfile.js    # User memory and preferences
│   └── PromptConfig.js   # Versioned system prompts
├── routes/               # API endpoints
│   ├── api.js           # Core chat and profile endpoints
│   ├── rag.js           # RAG ingestion and search
│   ├── analytics.js     # Usage and feedback metrics
│   └── dataset.js       # Conversation export
├── src/
│   ├── services/
│   │   ├── ragStore.js  # Vector store implementation
│   │   └── embeddings.js # Ollama embedding service
│   └── utils.js         # Helper functions
├── public/              # Frontend (HTML/JS/CSS)
├── docs/                # Documentation
└── specs/               # Architecture specifications
\`\`\`

---

## 🧪 Testing

Run endpoint validation tests:

\`\`\`bash
# Test V3 RAG endpoints
./test-v3-rag.sh

# Test V4 Analytics endpoints
./test-v4-analytics.sh http://localhost:3080
\`\`\`

---

## 🚀 Deployment Checklist

- [ ] MongoDB instance configured and accessible
- [ ] Ollama running with required models installed
- [ ] Environment variables set correctly
- [ ] Port 3080 accessible (or configured alternative)
- [ ] Health check passes: \`curl http://localhost:3080/health\`
- [ ] Models load successfully: \`curl http://localhost:3080/api/ollama/models\`

---

## �� License

MIT License - See LICENSE file for details

---

## 🤝 Contributing

AgentX is part of the GraphysX ecosystem. Contributions are welcome! Please read our contribution guidelines and submit pull requests to the main branch.

---

## 📞 Support

- **Documentation**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/WindriderQc/AgentX/issues)
- **Architecture**: See [docs/architecture/](docs/architecture/)

---

**Version**: 1.4.1 | **Status**: Production Ready ✅
