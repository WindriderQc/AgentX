# Changelog

All notable changes to AgentX will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.2] - 2026-01-01

### Added

#### Model-Aware Performance Metrics
- **Backend API:** New `/api/analytics/prompt-metrics` endpoint with model breakdown
- **Enhanced Endpoint:** `/api/analytics/feedback?groupBy=promptAndModel` for cross-model analysis
- **Model Filter:** Dropdown selector to filter metrics by specific LLM model
- **Version Badges:** Display prompt version numbers in metric cards
- **Model Breakdown:** Expandable sections showing per-model performance
  - Color-coded status indicators (green/yellow/red)
  - Individual model positive rates and feedback counts
  - Mini progress bars for visual comparison
- **Dashboard Enhancement:** Performance Metrics Dashboard now supports:
  - Filtering by model (e.g., llama3.2, qwen2, deepseek-r1)
  - Aggregate view across all models
  - Dynamic model list population from analytics data
- **CSS Styling:** 220+ lines of responsive styling for model-aware components

#### E2E Test Infrastructure
- **Playwright Configuration:** Chrome-only testing for optimal resource usage
- **Test Suites:**
  - Onboarding Wizard (10 tests) - ✅ All passing
  - Performance Metrics Dashboard (33 tests)
  - Advanced Filtering (15 tests)
  - Export/Import (17 tests)
- **Test Scripts:** Added npm scripts for running tests
  - `npm run test:e2e:playwright` - Run all tests
  - `npm run test:e2e:onboarding` - Onboarding tests
  - `npm run test:e2e:dashboard` - Dashboard tests
  - `npm run test:e2e:filtering` - Filtering tests
  - `npm run test:e2e:export-import` - Import/export tests
- **Documentation:** Complete test guides in `tests/e2e/` directory

### Changed
- Performance Metrics Dashboard now uses new prompt-metrics endpoint
- Playwright configuration optimized for Chrome-only (reduced from 5 browsers)
- Test execution time reduced from 30+ minutes to ~10 minutes

### Technical Details
- **Files Modified:** 3 files, 528 insertions, 35 deletions
- **Backend:** `routes/analytics.js` (+155 lines)
- **Frontend:** `public/js/components/PerformanceMetricsDashboard.js` (+153 lines)
- **Styling:** `public/css/prompts.css` (+220 lines)
- **Tests:** 75 E2E tests across 4 suites

### Benefits
- ✅ Identify which LLM models work best with specific prompts
- ✅ Debug model-specific performance issues quickly
- ✅ Optimize prompt-model pairings based on real feedback data
- ✅ Make data-driven decisions about model deployment
- ✅ Comprehensive test coverage for quality assurance

### Documentation
- Added `PHASE_MODEL_METRICS_COMPLETE.md` - Complete phase documentation
- Updated test documentation in `tests/e2e/` directory
- Added handoff guide for next development phase

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
