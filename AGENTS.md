# AgentX Collaboration Guide (AGENTS.md)

This document provides the canonical guidance for any agent—human or AI—contributing to the AgentX repository. It synthesizes and supersedes all previous agent-related documentation, including `CLAUDE.md` and `CONTRIBUTING.md`.

## 1. Getting Started

### 1.1. Initial Setup

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/WindriderQc/AgentX.git
    cd AgentX
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Configure Environment**:
    - Copy `.env.example` to `.env`.
    - Populate the environment variables as specified in **Section 8: Environment Variables**.

4.  **Start the server**:
    ```bash
    npm start
    ```

5.  **Verify setup**:
    ```bash
    curl http://localhost:3080/api/health
    # Expected: {"status":"ok","mongodb":"connected","ollama":"available"}
    ```

### 1.2. Development Commands

```bash
# Start server (default port 3080)
npm start

# Run all tests (Jest, silent mode)
npm test

# Run End-to-End test suite
npm run test:e2e

# Generate code coverage report
npm run test:coverage

# Run load tests with Artillery
npm run test:load

# Seed the database with SBQC operations data
npm run seed:ops
```

## 2. Development Workflow & Git Conventions

### 2.1. Branching Strategy

- Use descriptive branch names from the `main` branch, following these patterns:
  - `feature/my-feature`
  - `fix/issue-description`
  - `docs/update-api-reference`
  - `refactor/service-restructure`

### 2.2. Commit Messages

Use the [Conventional Commits](https://www.conventionalcommits.org/) specification.

**Format:**
```
<type>(<scope>): <subject>

<body>

<footer>
Closes #<issue-number>
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `style`.

### 2.3. Pull Request Process

1.  **Complete Pre-PR Checklist**:
    - [ ] `npm test` passes locally.
    - [ ] Code follows the Service-Oriented Architecture pattern (**Section 3.1**).
    - [ ] All relevant documentation is updated (**Section 7**).
    - [ ] `CHANGELOG.md` has a new entry.
    - [ ] No `console.log()` statements; use the structured logger.

2.  **Submit PR**: Use the template provided in `.github/PULL_REQUEST_TEMPLATE.md`.
3.  **Code Review**: At least one approval is required. Automated checks must pass.
4.  **Merge**: Use "Squash and merge" to maintain a clean history.

### 2.4. Pre-Commit Hook

Before your first commit, install the pre-commit hook to ensure tests pass automatically.
```bash
./scripts/setup-git-hooks.sh
```

## 3. Architecture Principles

### 3.1. Service-Oriented Architecture (SOA)

**This is the most critical architectural principle in the repository.** AgentX is **NOT** an MVC application.

**Flow Pattern:**
```
HTTP Request → Routes (Validation) → Services (Business Logic) → Models (Data Persistence) → DB/Ollama
```

- **Routes (`/routes`)**: The thin HTTP layer. Responsibilities are limited to:
    1.  Validating and sanitizing input.
    2.  Delegating immediately to a service.
    3.  Formatting the final response or error.
    - **A route file should NEVER contain business logic.**

- **Services (`/src/services`)**: The core of the application.
    - Contains all business logic, orchestration, and integrations with external services.
    - Examples: `chatService.js`, `selfHealingEngine.js`, `benchmarkService.js`.

- **Models (`/models`)**: Mongoose schemas that define the data structures.
    - May contain static helper methods for common queries.

- **Helpers (`/src/helpers`)**: Pure, stateless utility functions.

### 3.2. Singleton Pattern for Stateful Services

Services that manage a shared, in-memory state **must** be implemented as singletons to prevent memory leaks and inconsistent state.

- **`getRagStore()`**: Manages the single RAG vector store instance.
- **`getEmbeddingsService()`**: Manages the shared embedding cache.

**❌ Bad:** `const ragStore = new VectorStore();`
**✅ Good:** `const ragStore = getRagStore();`

### 3.3. Factory Pattern for Pluggable Components

The vector store uses a factory pattern to switch between implementations based on the environment.
- **Location**: `/src/services/vectorStore/factory.js`
- **Implementations**: `InMemoryVectorStore` (development) and `QdrantVectorStore` (production).
- **Configuration**: Set via the `VECTOR_STORE_TYPE` environment variable.

### 3.4. API Proxy Pattern

To avoid CORS issues and centralize API key management, frontend requests to external services like DataAPI are proxied through the AgentX backend.
- **Flow**: Frontend → AgentX (`/api/dataapi/*`) → DataAPI (`/api/v1/*`)
- **Implementation**: `/src/services/dataapiClient.js`

## 4. Key System Components

### 4.1. RAG and Vector Store

- **Ingestion**: Documents are chunked (800 chars, 100 overlap), embedded, and stored in a vector store.
- **Retrieval**: User queries are embedded to find the top-K similar chunks via cosine similarity.
- **Context Injection**: Retrieved context is **appended to the system prompt**, not injected as a user message.
- **Critical Gotcha**: The in-memory vector store (`VECTOR_STORE_TYPE=memory`) is **NOT** persistent and is for development only. Production **requires** Qdrant.

### 4.2. Model Routing & Failover

- **Service**: `/src/services/modelRouter.js`
- **Smart Routing**: A small, fast model can classify a user's intent to route the request to the optimal LLM host (e.g., a powerful model for coding, a fast model for chat).
- **Failover**: The router maintains a persistent state of host health and can automatically failover to a secondary Ollama host if the primary is slow or unhealthy. This is a core component of the self-healing system.

### 4.3. Self-Healing Engine

- **Service**: `/src/services/selfHealingEngine.js`
- **Purpose**: To automatically detect and remediate operational issues.
- **Rules Engine**: A declarative JSON configuration (`/config/self-healing-rules.json`) defines the detection logic, remediation strategies, and safety constraints (e.g., cooldowns, manual approval).
- **Strategies**:
    1.  `model_failover`: Switch to a backup Ollama host.
    2.  `prompt_rollback`: Revert to a previous, better-performing prompt version.
    3.  `service_restart`: Gracefully restart a service via PM2.
    4.  `throttle_requests`: Temporarily reduce rate limits to shed load.
    5.  `alert_only`: Send a notification without taking action.

### 4.4. Benchmark System

- **Purpose**: To provide a standardized way of measuring and comparing LLM performance.
- **Architecture**: A perfect example of the project's SOA. The routes (`/routes/benchmark.js`) are extremely thin and delegate all logic to the `benchmarkService.js`.
- **Features**: A five-level prompt library, asynchronous batch testing, LLM-based quality scoring, and detailed analytics.

### 4.5. n8n Agent Workflows

- **Location**: `/AgentC/`
- **Purpose**: Automates recurring tasks using persona-based n8n workflows.
- **Key Pattern**: Workflows use dual triggers (schedule and webhook) to allow for both automated execution and manual runs from a dashboard.
- **Examples**:
    - **N1.1 (Janitor)**: Monitors system health every 5 minutes.
    - **N2.3 (Curator)**: Manages RAG document ingestion.
    - **N4.4 (Guardian)**: Orchestrates self-healing actions.
    - **N5.1 (Analyst)**: Analyzes user feedback to identify underperforming prompts.

## 5. Testing Standards

### 5.1. Test Pyramid

- **Unit Tests (Required)**: For services, helpers, and models. Place in `__tests__` directories or `tests/unit`.
- **Integration Tests (Required)**: For API endpoints, database interactions, and multi-service flows. Place in `tests/integration`. Use `mongodb-memory-server` for isolation.
- **E2E Tests (Recommended)**: For critical user flows. The full suite is run via `./test-all.sh`.

### 5.2. Test Coverage

Run `npm run test:coverage` to generate a report.
- **Services**: Aim for >80%
- **Routes**: Aim for >70%
- **Helpers**: Aim for >90%

## 6. Code Conventions

### 6.1. Error Handling

- **ALWAYS** wrap service calls in `try...catch` blocks within routes.
- **ALWAYS** use the structured logger (`/src/utils/logger.js`) to log errors with context. Never use `console.log`.
- **NEVER** expose raw error messages or stack traces to the client in production. Return a sanitized, user-friendly message.
- Use appropriate HTTP status codes (400 for validation errors, 500 for server errors, etc.).

```javascript
// Good Error Handling in a Route
try {
  const stats = await analyticsService.getTokenStats();
  res.json({ status: 'success', data: stats });
} catch (err) {
  logger.error('Failed to get token stats', { error: err.message, userId: req.user.id });
  res.status(500).json({ status: 'error', message: 'An internal error occurred.' });
}
```

### 6.2. Logging

Use the Winston logger for structured, leveled logging.
- **`error`**: For failures that require immediate attention.
- **`warn`**: For recoverable issues or degraded behavior.
- **`info`**: For significant operational events (e.g., server start, conversation created).
- **`debug`**: For detailed diagnostic information.

```javascript
// Good Logging in a Service
logger.info('Conversation created successfully', {
  conversationId: convo._id,
  userId: user.id,
  model: params.model
});
```

### 6.3. Security

- Input validation and sanitization are handled by middleware (`express-mongo-sanitize`).
- Rate limiting is configured for different tiers of endpoints in `/src/middleware/rateLimiter.js`. Ensure new endpoints are covered.
- Secrets must **never** be hardcoded. Use environment variables.
- Be mindful not to log sensitive data like API keys or user credentials.

## 7. Documentation

Documentation is a core part of the development process.

### 7.1. When to Update

- **API Changes**: Update `docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md`.
- **Architectural Changes**: Update this file (`AGENTS.md`) and, if necessary, `docs/SBQC-Stack-Final/01-ARCHITECTURE.md`.
- **New Features**: Add or update relevant documentation, often in the `docs/features` or `docs/guides` directories.
- **All Changes**: Add an entry to `CHANGELOG.md` following the [Keep a Changelog](https://keepachangelog.com/) format.

## 8. Environment Variables

These are the critical environment variables required to run the application. See `.env.example` for a full list.

- `MONGODB_URI`: The connection string for the MongoDB database.
- `OLLAMA_HOST`: The URL for the primary Ollama LLM host.
- `OLLAMA_HOST_SECONDARY`: (Optional) The URL for a secondary host for specialized or heavy models.
- `PORT`: The port for the AgentX server (defaults to 3080).
- `VECTOR_STORE_TYPE`: The vector store implementation to use. Must be `memory` (dev) or `qdrant` (prod).
- `QDRANT_URL`: The URL for the Qdrant instance if `VECTOR_STORE_TYPE` is `qdrant`.
- `AGENTX_API_KEY`: The API key required for n8n workflows and other automation to access protected endpoints.
- `DATAAPI_BASE_URL`: The base URL for the external DataAPI service.
- `DATAAPI_API_KEY`: The API key for authenticating with the DataAPI service.
