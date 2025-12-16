# Changelog

All notable changes to AgentX will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-12-04

### 🎉 Initial Production Release

AgentX v1.0.0 marks the first production-ready release of this local AI assistant platform. All core features have been implemented, tested, and documented.

### Added

#### Core Chat System
- Advanced chat interface with rich parameter controls
- MongoDB-backed conversation persistence
- Real-time message streaming support
- Conversation history with session management
- Message feedback system (thumbs up/down with comments)
- System prompt customization per conversation

#### User Profile & Memory
- User profile model with persistent memory
- Automatic memory injection into system prompts
- Profile management UI with modal editor
- Custom instructions and preferences storage

#### RAG (Retrieval-Augmented Generation) - V3
- In-memory vector store with cosine similarity search
- Ollama-based embedding generation (`nomic-embed-text`)
- Document ingestion API with automatic chunking
- Semantic search with configurable top-K and filtering
- RAG context injection into chat responses
- Source attribution in responses (`ragUsed`, `ragSources`)
- UI toggle for enabling/disabling RAG per conversation
- n8n-ready ingestion endpoints with contract compliance

#### Analytics & Prompt Versioning - V4
- Prompt versioning model with active/deprecated/proposed states
- Conversation tracking with prompt snapshots
- Usage analytics endpoints (conversations, messages, grouping)
- Feedback metrics endpoints (positive/negative rates)
- Dataset export API for training data
- Prompt creation and activation API
- Comprehensive analytics aggregation pipelines

#### API & Integration
- RESTful API with comprehensive error handling
- Health check endpoint
- Model listing from Ollama instances
- Dynamic Ollama host configuration
- Contract-defined APIs for external integrations
- n8n workflow documentation and templates

#### Documentation
- Complete architecture documentation
- API reference with examples
- Onboarding and quick start guides
- V3 RAG architecture specification
- V4 Analytics architecture specification
- n8n workflow integration guides
- Code review and implementation reports

#### Testing & Validation
- V3 RAG endpoint test script
- V4 Analytics endpoint test script
- Manual testing procedures
- Contract compliance validation

### Technical Highlights

#### Backend Architecture
- Modular Express.js design
- MongoDB integration via Mongoose
- Separation of concerns (routes, models, services)
- Comprehensive error handling with fallbacks
- Timeout protection on Ollama requests
- Database indexes for query optimization

#### Frontend
- Pure JavaScript SPA (no framework dependencies)
- LocalStorage for UI preferences
- Real-time chat updates
- Configuration sidebar with all Ollama parameters
- History sidebar with conversation list
- Profile management modal
- Feedback collection interface

#### Data Models
- `Conversation`: Chat history with messages, feedback, RAG metadata
- `UserProfile`: User memory and preferences
- `PromptConfig`: Versioned system prompts

#### Services
- `ragStore`: Vector store abstraction with full CRUD
- `embeddings`: Ollama embedding service wrapper
- `utils`: Common helper functions

### Infrastructure

- Node.js 18+ support
- MongoDB 4.4+ compatibility
- Ollama integration for LLMs and embeddings
- Environment variable configuration
- Cross-platform support (Linux, macOS, Windows)

### Known Limitations

- Single user mode (hardcoded `userId: 'default'`)
- In-memory vector store (not persistent across restarts)
- No authentication/authorization on endpoints
- No rate limiting
- No structured logging framework

### Migration Notes

This is the initial release. No migration needed.

### Breaking Changes

N/A - Initial release

### Security

- Runs locally by default
- No external API calls except to configured Ollama instances
- MongoDB connection should use authentication in production
- Consider adding API authentication for multi-user deployments

### Performance

- Sub-2s response time for non-RAG queries (depends on model)
- Sub-5s response time for RAG queries (depends on model and corpus size)
- In-memory vector store provides fast semantic search
- MongoDB indexes optimize analytics queries

### Dependencies

```json
{
  "express": "^4.19.2",
  "mongoose": "^9.0.0",
  "cors": "^2.8.5",
  "dotenv": "^17.2.3",
  "node-fetch": "^2.7.0"
}
```

### Contributors

- Agent A: Architecture & Specifications
- Agent B: Backend Implementation
- Agent C: n8n Integration Design
- Human Operator: Requirements & Validation

---

## [Unreleased]

### Planned for v1.1.0
- Persistent vector database (Qdrant/Chroma)
- API authentication middleware
- Rate limiting
- Structured logging (Winston/Pino)
- Docker deployment support
- Health monitoring dashboard

### Planned for v1.2.0
- Hybrid search (semantic + keyword)
- Multi-agent conversations
- Tool use / function calling
- Enhanced prompt evaluation
- Auto-scaling for production

---

## Release Links

- [v1.0.0 Release Notes](docs/reports/REVISED_PLAN_STATUS.md)
- [GitHub Repository](https://github.com/WindriderQc/AgentX)
- [Documentation](docs/)
