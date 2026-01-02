# Contributing to AgentX

## Getting Started

1.  **Clone the repository**:
    ```bash
    git clone <repository-url>
    cd agentx
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Configure Environment**:
    - Copy `.env.example` to `.env` (if available) or create `.env` based on `CLAUDE.md`.
    - Key variables:
        - `MONGODB_URI`: Connection string for MongoDB.
        - `OLLAMA_HOST`: URL for the primary Ollama instance.
        - `PORT`: Server port (default: 3080).

4.  **Start the server**:
    ```bash
    npm start
    ```

## Development Workflow

1.  **Branching**:
    - Use descriptive branch names: `feature/my-feature`, `fix/issue-description`.
    - For multi-agent collaboration, include agent identifier if applicable.

2.  **Multi-Agent Workflow & Communication**:
    - **Progress Tracking**: Agents must use the `TodoWrite` tool (if available) or update `ACTION_ITEMS.md` to track task status and handoffs.
    - **Communication**:
        - Document decisions and plan changes in `CLAUDE.md` or session logs.
        - Use precise, imperative language for instructions between agents.
        - Resolve merge conflicts locally before pushing.

3.  **Service-Oriented Architecture (SOA)**:
    - **Routes** (`routes/`): Thin HTTP layer. Validate input, delegate to services, format response. No business logic.
    - **Services** (`src/services/`): Business logic, orchestration, and integrations.
    - **Models** (`models/`): Mongoose schemas and data persistence.
    - **Helpers** (`src/helpers/`): Pure utility functions.

3.  **State Management**:
    - Use **Singletons** for stateful services (e.g., `ragStore`, `embeddings`).
    - Do not store state in routes or controllers.

4.  **Patterns**:
    - **Factory Pattern**: Used for Vector Store creation.
    - **Proxy Pattern**: Used for DataAPI integration.

## Testing Standards

### Pre-commit Requirements
Before committing, you **must** run the unit and integration tests:
```bash
npm test
```
This runs Jest in silent mode. Ensure all tests pass.

### Integration & E2E Testing
Run the full test suite before submitting a Pull Request or pushing major changes:
```bash
./test-all.sh
```
This script:
1.  Runs Jest tests.
2.  Starts a temporary test server (`tests/test-server.js`) using `mongodb-memory-server`.
3.  Executes shell-based E2E tests (`test-backend.sh`, `test-v3-rag.sh`, `test-v4-analytics.sh`).

### Load Testing
For performance-critical changes, run load tests:
```bash
npm run test:load:basic   # Basic load test
npm run test:load:stress  # Stress test
```

### Coverage
Maintain high test coverage. Jest is configured to collect coverage from `src/`, `routes/`, and `models/`.
```bash
npm run test:coverage
```

## Code Review Checklist

- [ ] **Architecture**: Does the code follow the Route -> Service -> Model pattern?
- [ ] **State**: Are stateful services implemented as Singletons?
- [ ] **Error Handling**:
    - [ ] Errors are caught and logged using `winston` (not `console.log`).
    - [ ] User-facing error messages are sanitized (no stack traces).
- [ ] **Security**:
    - [ ] Input validation is performed (NoSQL injection prevention).
    - [ ] Rate limiting is verified for new endpoints.
- [ ] **Logging**: Structured logging with `winston` (info, warn, error).
- [ ] **Tests**:
    - [ ] Unit tests added for new logic.
    - [ ] Integration tests added for new endpoints.
    - [ ] `npm test` passes.
- [ ] **Documentation**:
    - [ ] `CLAUDE.md` metrics updated (if significant changes).
    - [ ] `docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md` updated for API changes.

## Documentation Requirements

### When to Update
- **CLAUDE.md**: Update "Current State", "Codebase Metrics", and "Commands" when adding features or changing workflow.
- **API Reference**: Update `docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md` immediately upon changing API contracts.
- **Architecture**: Update `docs/SBQC-Stack-Final/01-ARCHITECTURE.md` for structural changes.

### Changelog
- Record significant changes in `CHANGELOG.md`.

## Architecture Patterns

### Service-Oriented Architecture (NOT MVC)
Routes should **NEVER** contain business logic.
- **Bad**: calculating stats in `routes/analytics.js`.
- **Good**: calling `analyticsService.getStats()` in `routes/analytics.js`.

### RAG System
- **Layer 1**: Ingestion (Document -> Chunks -> Embeddings).
- **Layer 2**: Vector Store (Factory: Memory or Qdrant).
- **Layer 3**: Search (Query -> Embedding -> Search -> Context).

### Error Handling
```javascript
try {
  await service.operation();
  res.json({ status: 'success', data: ... });
} catch (err) {
  logger.error('Context', { error: err.message });
  res.status(500).json({ status: 'error', message: 'Sanitized message' });
}
```

## Breaking Changes

### Protocol
1.  **Database**:
    - Mongoose schema changes must be backward compatible or include a migration script.
    - Verify indexes for performance.
2.  **API**:
    - Version your API (e.g., V3, V4) if breaking contracts.
    - Update `docs/api/contracts/`.
3.  **Environment**:
    - Document new variables in `CLAUDE.md` and `docs/SBQC-Stack-Final/05-DEPLOYMENT.md`.
4.  **Dependencies**:
    - Lock versions in `package.json`.
    - Test `npm install` from scratch to verify compatibility.

## Git Conventions

- **Commit Messages**: Use clear, imperative mood messages.
    - `feat: add new analytics endpoint`
    - `fix: resolve rate limiting issue`
    - `docs: update API reference`
    - `refactor: move logic to chatService`
- **Merge Conflicts**:
    - Resolve locally before pushing.
    - Verify with `npm test` after resolution.
