# AgentX v1.0.0

**Production-ready local AI assistant with RAG, conversation memory, and continuous improvement capabilities.**

AgentX is a Node.js application that transforms your local Ollama instance into a powerful AI assistant with advanced features including knowledge augmentation (RAG), persistent conversation memory, user profiles, analytics, and automated improvement loops via n8n integration.

---

## 🌟 Key Features

### Core Capabilities
- **�� Advanced Chat Interface**: Rich UI with model selection, parameter tuning, and conversation history
- **🧠 Conversation Memory**: MongoDB-backed persistence with session management and feedback tracking
- **👤 User Profiles**: Personal memory injection into system prompts for context-aware responses
- **📚 RAG (Retrieval-Augmented Generation)**: Semantic search over your documents for knowledge-grounded answers
- **📊 Analytics & Metrics**: Track model performance, feedback rates, and usage patterns
- **🔄 Prompt Versioning**: A/B testing and continuous improvement of system prompts
- **🔌 n8n Integration**: Automated document ingestion and prompt optimization workflows

### Technical Highlights
- Modular Express.js architecture with MongoDB backend
- In-memory vector store with cosine similarity search (Ollama embeddings)
- RESTful APIs with comprehensive contracts for external integrations
- Real-time feedback collection with thumbs up/down
- Dataset export for training and evaluation
- Health monitoring and error recovery

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
   OLLAMA_HOST=http://localhost:11434
   EMBEDDING_MODEL=nomic-embed-text
   PORT=3080
   \`\`\`

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

## 📖 Documentation

### 🚀 Getting Started
- [**Quick Start Guide**](docs/onboarding/quickstart.md) - Installation and first steps
- [**Onboarding Hub**](docs/onboarding/README.md) - Complete onboarding resources
- [**v1.0.0 Release Notes**](docs/reports/REVISED_PLAN_STATUS.md) - What's in this release

### 🏗️ Architecture
- [**Backend Overview**](docs/architecture/backend-overview.md) - System architecture
- [**Database Schema**](docs/architecture/database.md) - MongoDB models
- [**Architecture Diagrams**](docs/architecture/diagrams.md) - Visual documentation

### 🔌 API Documentation
- [**API Reference**](docs/api/reference.md) - Complete endpoint documentation
- [**V3 RAG Contract**](docs/api/contracts/v3-snapshot.md) - RAG ingestion API
- [**V4 Analytics Contract**](docs/api/contracts/v4-contract.md) - Analytics API

### 📋 Specifications
- [**V3 RAG Architecture**](specs/V3_RAG_ARCHITECTURE.md) - RAG system design
- [**V4 Analytics Architecture**](specs/V4_ANALYTICS_ARCHITECTURE.md) - Analytics and improvement loops

### 🔧 Operations
- [**n8n Ingestion Workflows**](docs/reports/n8n-ingestion.md) - Document automation
- [**n8n Prompt Improvement**](docs/reports/n8n-prompt-improvement-v4.md) - Automated optimization
- [**Implementation Reports**](docs/reports/) - Feature summaries

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

## 🔮 Roadmap

### v1.1.0 (Planned)
- Persistent vector database (Qdrant/Chroma migration)
- API authentication and rate limiting
- Structured logging and monitoring
- Docker deployment support

### v1.2.0 (Planned)
- Hybrid search (semantic + keyword)
- Multi-agent conversation support
- Tool use / function calling
- Enhanced prompt evaluation metrics

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

**Version**: 1.0.0 | **Status**: Production Ready ✅
