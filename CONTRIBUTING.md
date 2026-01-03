# Contributing to AgentX

Welcome to AgentX! This guide will help you contribute effectively to the project.

---

## Getting Started

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
    - Copy `.env.example` to `.env` (if available) or create `.env` based on `CLAUDE.md`.
    - Key variables:
        - `MONGODB_URI`: Connection string for MongoDB (e.g., `mongodb://192.168.2.33:27017/agentx`)
        - `OLLAMA_HOST`: URL for the primary Ollama instance (e.g., `http://192.168.2.99:11434`)
        - `PORT`: Server port (default: 3080)
        - `VECTOR_STORE_TYPE`: Use `memory` for dev, `qdrant` for production
        - `AGENTX_API_KEY`: API key for automation/n8n access

4.  **Start the server**:
    ```bash
    npm start
    ```

5.  **Verify setup**:
    ```bash
    # In another terminal
    curl http://localhost:3080/api/health

    # Expected response:
    # {"status":"ok","mongodb":"connected","ollama":"available"}
    ```

---

## Development Tools

### Recommended IDE Setup
- **VS Code Extensions:**
  - ESLint
  - Prettier (if configured)
  - MongoDB for VS Code
  - REST Client (for API testing)

### Debugging
```bash
# Debug mode with inspector
node --inspect src/app.js

# Or use npm script (if configured)
npm run debug
```

### Hot Reload (Development)
```bash
# Install nodemon globally (if not already)
npm install -g nodemon

# Start with auto-reload
nodemon src/app.js
```

### Database Tools
- **MongoDB Compass**: GUI for exploring collections
- **Studio 3T**: Advanced queries and aggregations (optional)
- **Mongoose Schema Inspector**: Built into VS Code MongoDB extension

---

## Development Workflow

### 1. Branching
- Use descriptive branch names following these patterns:
  - `feature/my-feature` - New functionality
  - `fix/issue-description` - Bug fixes
  - `docs/update-api-reference` - Documentation updates
  - `refactor/service-restructure` - Code refactoring
- Branch from `main` and keep branches focused (one feature/fix per branch)

### 2. Progress Tracking & Communication
- **For AI agent collaboration**: Use the `TodoWrite` tool to track task status and handoffs
- **For human collaboration**:
  - Update issue/PR descriptions with progress
  - Use GitHub Projects or Issues for task tracking
  - Comment on PRs for design decisions
- **Documentation**:
  - Document significant decisions in commit messages or `CLAUDE.md` updates
  - Use precise, imperative language for instructions
- **Merge conflicts**:
  - Resolve locally before pushing
  - Run `npm test` after resolution to verify

### 3. Service-Oriented Architecture (SOA)

AgentX uses a **Service-Oriented Architecture** (NOT MVC). Follow this pattern strictly:

- **Routes** (`routes/`): Thin HTTP layer. Validate input, delegate to services, format response. **NO business logic.**
- **Services** (`src/services/`): Business logic, orchestration, and integrations.
- **Models** (`models/`): Mongoose schemas and data persistence.
- **Helpers** (`src/helpers/`): Pure utility functions.

#### Example: Adding a New Feature

**❌ Bad - Logic in Route:**
```javascript
// routes/analytics.js
router.get('/stats', async (req, res) => {
  const conversations = await Conversation.find({});
  const totalTokens = conversations.reduce((sum, c) => sum + c.totalTokens, 0);
  res.json({ totalTokens });
});
```

**✅ Good - Delegate to Service:**
```javascript
// routes/analytics.js
router.get('/stats', async (req, res) => {
  try {
    const stats = await analyticsService.getTokenStats();
    res.json({ status: 'success', data: stats });
  } catch (err) {
    logger.error('Failed to get stats', { error: err.message });
    res.status(500).json({ status: 'error', message: 'Failed to retrieve statistics' });
  }
});

// src/services/analyticsService.js
async function getTokenStats() {
  const conversations = await Conversation.find({});
  return {
    totalTokens: conversations.reduce((sum, c) => sum + c.totalTokens, 0),
    averageTokens: conversations.length > 0
      ? conversations.reduce((sum, c) => sum + c.totalTokens, 0) / conversations.length
      : 0
  };
}
```

### 4. State Management
- Use **Singletons** for stateful services (e.g., `getRagStore()`, `getEmbeddingsService()`)
- Do not store state in routes or controllers
- Use factory pattern for creating service instances (e.g., Vector Store)

### 5. Architectural Patterns
- **Singleton Pattern**: Used for RAG store, embedding cache (shared state across requests)
- **Factory Pattern**: Used for Vector Store creation (in-memory vs Qdrant)
- **Proxy Pattern**: Used for DataAPI integration (server-to-server proxy)

---

## Testing Standards

### Pre-commit Requirements
Before committing, you **must** run the unit and integration tests:
```bash
npm test
```
This runs Jest in silent mode. **Ensure all tests pass.**

### When to Write Tests

#### Unit Tests (Required)
- New service methods (pure logic)
- Helper functions
- Model static methods
- Utility functions

**Example:**
```javascript
// src/services/__tests__/chatService.test.js
describe('chatService', () => {
  it('should format system prompt with user profile', () => {
    const result = chatService.buildSystemPrompt(basePrompt, userProfile);
    expect(result).toContain(userProfile.about);
  });
});
```

#### Integration Tests (Required)
- New API endpoints
- Database schema changes
- Authentication/authorization changes
- RAG ingestion and search flows

**Example:**
```javascript
// tests/integration/chat-endpoints.test.js
describe('POST /api/chat', () => {
  it('should create conversation and return response', async () => {
    const response = await request(app)
      .post('/api/chat')
      .send({ message: 'Hello', model: 'llama3.2' });
    expect(response.status).toBe(200);
    expect(response.body.message).toBeDefined();
  });
});
```

#### E2E Tests (Optional but Recommended)
- Critical user flows (chat, RAG, onboarding)
- Multi-step workflows (wizard completion)
- Payment/billing features (if added)

#### Load Tests (Situational)
- Performance-critical endpoints
- After optimization work
- Before major releases

### Integration & E2E Testing
Run the full test suite before submitting a Pull Request or pushing major changes:
```bash
./test-all.sh
```
This script:
1. Runs Jest tests
2. Starts a temporary test server (`tests/test-server.js`) using `mongodb-memory-server`
3. Executes shell-based E2E tests (`test-backend.sh`, `test-v3-rag.sh`, `test-v4-analytics.sh`)

### Load Testing
For performance-critical changes, run load tests:
```bash
npm run test:load:basic   # Basic load test
npm run test:load:stress  # Stress test
npm run test:load         # All load test scenarios
```

### Coverage
Maintain high test coverage. Jest is configured to collect coverage from `src/`, `routes/`, and `models/`.
```bash
npm run test:coverage
```

**Coverage Expectations:**
- Services: >80%
- Routes: >70%
- Helpers: >90%

---

## Code Review Checklist

Use this checklist when reviewing your own code or others' pull requests:

### Architecture
- [ ] Code follows the **Route → Service → Model** pattern
- [ ] Business logic is in services, NOT routes
- [ ] Stateful services use Singleton pattern

### Error Handling
- [ ] Errors are caught and logged using `winston` (not `console.log`)
- [ ] User-facing error messages are sanitized (no stack traces in production)
- [ ] HTTP status codes are appropriate (200, 400, 401, 403, 404, 500, 503)

### Security
- [ ] Input validation is performed (NoSQL injection prevention with `express-mongo-sanitize`)
- [ ] Rate limiting is verified for new endpoints
- [ ] Authentication/authorization checks are in place
- [ ] Secrets are never hardcoded (use environment variables)
- [ ] API keys are not exposed in logs

### Logging
- [ ] Structured logging with `winston` (info, warn, error, debug)
- [ ] Logs include context (userId, conversationId, etc.)
- [ ] No sensitive data in logs (passwords, API keys, tokens)

**Example:**
```javascript
logger.info('Conversation created', {
  conversationId: conversation._id,
  userId: req.user.userId,
  model: req.body.model
});
```

### Testing
- [ ] Unit tests added for new logic
- [ ] Integration tests added for new endpoints
- [ ] `npm test` passes
- [ ] Edge cases covered (empty input, null values, errors)

### Documentation
- [ ] `CLAUDE.md` metrics updated (if significant changes)
- [ ] `docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md` updated for API changes
- [ ] Code comments added for complex logic (not obvious operations)
- [ ] Changelog entry added to `CHANGELOG.md`

---

## Documentation Requirements

### When to Update Documentation

#### CLAUDE.md
Update `CLAUDE.md` when:
- Adding/removing major components (routes, services, models)
- Changing architecture patterns
- Adding new npm scripts or deployment steps
- Introducing new environment variables

**Required Updates:**

1. **Codebase Metrics** section (in "Current State & Development TODOs"):
   ```bash
   # Count lines for your changes
   wc -l src/services/myNewService.js  # e.g., 234 lines
   ```
   Add to the metrics table:
   ```markdown
   - ✅ **Core Services:** 12 → 13 services (added myNewService.js - 234 lines)
   ```

2. **Commands** section:
   Add new npm scripts or bash commands with descriptions

3. **Architecture Overview**:
   Document new services, patterns, or integrations

**Example Commit:**
```
feat: add user preferences service

- Add src/services/userPreferencesService.js (187 lines)
- Update CLAUDE.md metrics: 12 → 13 services
- Update API reference with 3 new endpoints
- Add environment variable PREFERENCES_CACHE_TTL
```

#### API Reference
Update `docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md` immediately upon changing API contracts:
- New endpoints (method, path, request/response schemas)
- Changed parameters or response formats
- Deprecated endpoints (mark as deprecated, include migration path)

#### Architecture Docs
Update `docs/SBQC-Stack-Final/01-ARCHITECTURE.md` for:
- New architectural patterns
- Service dependencies
- Data flow changes

### Changelog
Record all changes in `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/) format:
- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Security fixes

---

## Architecture Patterns

### Service-Oriented Architecture (NOT MVC)
Routes should **NEVER** contain business logic.

**Flow Pattern:**
```
HTTP Request → Routes (validation) → Services (orchestration) → Models (data) → MongoDB/Ollama
```

**Examples:**
- **Bad**: Calculating token costs in `routes/analytics.js`
- **Good**: Calling `costCalculatorService.calculateCost()` in `routes/analytics.js`

### RAG System Architecture
Three-layer design:

- **Layer 1: Ingestion**
  ```
  Document → Chunks (800 chars, 100 overlap) → Embeddings → Vector Store
  ```

- **Layer 2: Vector Store (Factory Pattern)**
  - In-Memory: `Map<documentId, chunks>` + cosine similarity (dev/testing, **NOT persistent**)
  - Qdrant: REST API client with HNSW indexing (production, persistent)

- **Layer 3: Search & Retrieval**
  ```
  Query → Embedding → Vector Search → Top-K Chunks → Context Injection (into system prompt)
  ```

### Error Handling Pattern
```javascript
try {
  await service.operation();
  res.json({ status: 'success', data: {...} });
} catch (err) {
  logger.error('Operation failed', { error: err.message, context: {...} });
  res.status(500).json({ status: 'error', message: 'User-friendly message' });
}
```

**Rules:**
- ALWAYS log errors with context
- NEVER expose stack traces to client (except in dev mode)
- Use appropriate HTTP status codes
- Provide actionable error messages

---

## Common Pitfalls & How to Avoid Them

### 1. Forgetting to Run Tests Before Pushing
**Problem:** CI/CD fails, blocks deployments.

**Solution:** Set up a git pre-commit hook:
```bash
# Create .git/hooks/pre-commit
#!/bin/sh
echo "Running tests before commit..."
npm test

if [ $? -ne 0 ]; then
  echo "Tests failed. Commit aborted."
  exit 1
fi
```

Make it executable:
```bash
chmod +x .git/hooks/pre-commit
```

### 2. Using In-Memory Vector Store in Production
**Problem:** RAG data lost on server restart.

**Solution:** Always use Qdrant in production:
```bash
# .env
VECTOR_STORE_TYPE=qdrant
QDRANT_URL=http://localhost:6333
```

### 3. Hardcoding URLs/Paths
**Problem:** Breaks in different environments (dev, staging, production).

**Solution:** Use environment variables:
```javascript
// ❌ Bad
const url = 'http://localhost:3080/api/chat';

// ✅ Good
const url = `${process.env.AGENTX_BASE_URL || 'http://localhost:3080'}/api/chat`;
```

### 4. Exposing Secrets in Logs
**Problem:** API keys, passwords, or tokens leaked in error messages or logs.

**Solution:** Sanitize before logging:
```javascript
// ❌ Bad
logger.error('API call failed', {
  url: req.url,
  headers: req.headers  // Contains API keys!
});

// ✅ Good
logger.error('API call failed', {
  url: req.url,
  method: req.method
  // Don't log: apiKey, password, token, authorization header
});
```

### 5. Skipping Documentation Updates
**Problem:** Knowledge gaps, confusion for future developers, outdated API references.

**Solution:** Make docs part of your **Definition of Done**:
- Code written ✓
- Tests passing ✓
- Documentation updated ✓
- **THEN** commit

### 6. Not Using Singletons for Stateful Services
**Problem:** Multiple instances created, state not shared, memory leaks.

**Solution:** Always use getter functions:
```javascript
// ❌ Bad
const ragStore = new VectorStore();

// ✅ Good
const ragStore = getRagStore();  // Returns singleton instance
```

### 7. Ignoring Rate Limiting
**Problem:** New endpoints added without rate limiting, vulnerable to abuse.

**Solution:** Apply appropriate rate limiter:
```javascript
const { apiLimiter, chatLimiter } = require('../middleware/rateLimiter');

router.post('/api/chat', chatLimiter, requireAuth, chatController.sendMessage);
```

---

## Pull Request Process

### Before Submitting

Complete this checklist:
- [ ] `npm test` passes locally
- [ ] Code follows SOA pattern (routes → services → models)
- [ ] Documentation updated (API ref, CLAUDE.md if needed)
- [ ] Changelog entry added
- [ ] No console.log() statements (use logger instead)
- [ ] Environment variables documented (if new ones added)

### PR Template

When creating a PR, use this template (create `.github/PULL_REQUEST_TEMPLATE.md`):

```markdown
## Description
[Brief description of changes - what and why]

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix or feature causing existing functionality to change)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)

## Testing
- [ ] Unit tests pass (`npm test`)
- [ ] Integration tests pass (`./test-all.sh`)
- [ ] Manual testing completed
- [ ] Load testing performed (if performance-critical)

**Test Coverage:**
- Lines covered: XX%
- New tests added: X unit, X integration

## Documentation
- [ ] API reference updated (`docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md`)
- [ ] CLAUDE.md updated (if architectural changes)
- [ ] Changelog entry added (`CHANGELOG.md`)
- [ ] Code comments added for complex logic

## Environment Variables
- [ ] No new environment variables
- [ ] New variables documented in CLAUDE.md and .env.example

**New Variables:**
- `VARIABLE_NAME`: Description of purpose

## Related Issues
Closes #[issue number]
Relates to #[issue number]

## Screenshots (if applicable)
[Add screenshots for UI changes]

## Deployment Notes
[Any special deployment steps or migration requirements]
```

### Review Process

1. **Automated Checks**: GitHub Actions runs tests automatically
2. **Manual Review**: Code review by maintainer/team member
3. **Approval**: At least one approval required
4. **Merge Strategy**: Squash and merge preferred (keeps history clean)

### After Merge

- [ ] Delete feature branch: `git branch -d feature/my-feature`
- [ ] Verify deployment (if auto-deployed via CI/CD)
- [ ] Monitor logs for errors: `pm2 logs agentx`
- [ ] Close related issues

---

## Breaking Changes

### Protocol for Breaking Changes

Breaking changes require extra care and communication.

#### 1. Database Schema Changes
- **Backward Compatible**: Preferred approach
  ```javascript
  // Add new field with default value
  const UserSchema = new Schema({
    // ... existing fields
    newField: { type: String, default: 'default_value' }
  });
  ```

- **Breaking Change**: Requires migration script
  ```javascript
  // Create migration script in /scripts/migrations/
  // scripts/migrations/001-add-user-preferences.js
  async function migrate() {
    await User.updateMany({}, { $set: { preferences: {} } });
  }
  ```

- **Document Migration**: Add to `docs/migrations/`
- **Verify Indexes**: Check performance impact
  ```javascript
  // Add index if needed
  UserSchema.index({ newField: 1 });
  ```

#### 2. API Contract Changes
- **Versioning**: Create new API version (e.g., V3 → V4)
  ```javascript
  // Keep V3 for backward compatibility
  router.post('/api/v3/chat', v3ChatHandler);

  // Add V4 with new contract
  router.post('/api/v4/chat', v4ChatHandler);
  ```

- **Deprecation Notice**: Mark old endpoints
  ```javascript
  // Add deprecation header
  res.set('X-API-Deprecated', 'true');
  res.set('X-API-Sunset', '2026-06-01');
  ```

- **Update Contracts**: Document in `docs/api/contracts/`
- **Communication**: Notify API consumers (if external)

#### 3. Environment Variables
- **New Variables**: Document in CLAUDE.md and `.env.example`
  ```bash
  # .env.example
  NEW_VARIABLE=default_value  # Description of purpose
  ```

- **Changed Variables**: Provide migration guide
  ```markdown
  ## Migration: OLD_VAR → NEW_VAR
  Replace `OLD_VAR` with `NEW_VAR` in your .env file.
  Old format: `OLD_VAR=value`
  New format: `NEW_VAR=value`
  ```

- **Removed Variables**: Add to changelog with removal date

#### 4. Dependency Updates
- **Lock Versions**: Pin major versions in `package.json`
  ```json
  {
    "dependencies": {
      "mongoose": "^8.0.0"  // Won't auto-upgrade to v9
    }
  }
  ```

- **Test Thoroughly**:
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  npm test
  ./test-all.sh
  ```

- **Document Breaking Changes**: In PR and changelog

### Breaking Change Checklist

- [ ] Migration script created (if needed)
- [ ] Backward compatibility considered
- [ ] API versioning applied (if API change)
- [ ] Documentation updated (CLAUDE.md, API ref, migration guide)
- [ ] Changelog entry with **[BREAKING]** prefix
- [ ] Team notified (Slack, email, PR comments)
- [ ] Rollback plan documented

---

## Git Conventions

### Commit Messages
Use clear, imperative mood messages following [Conventional Commits](https://www.conventionalcommits.org/):

**Format:**
```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `refactor`: Code refactoring (no functional changes)
- `test`: Adding or updating tests
- `chore`: Maintenance tasks (dependencies, build config)
- `perf`: Performance improvements
- `style`: Code style changes (formatting, no logic changes)

**Examples:**
```
feat(chat): add streaming response support

Implement SSE-based streaming for chat responses to improve UX.
Includes rate limiting and error handling.

Closes #123

---

fix(rag): resolve vector store memory leak

Fixed singleton pattern in getRagStore() to prevent multiple instances.

---

docs(api): update analytics endpoint reference

Added new query parameters and response schema for /api/analytics/costs.

---

refactor(services): extract cost calculation logic

Moved cost calculation from analyticsService to dedicated costCalculatorService.
No functional changes.
```

### Branch Management
- **Delete After Merge**: `git branch -d feature/my-feature`
- **Keep Main Clean**: All work happens in feature branches
- **Sync Regularly**:
  ```bash
  git checkout main
  git pull origin main
  git checkout feature/my-feature
  git rebase main  # or git merge main
  ```

### Merge Conflicts
1. **Resolve Locally**: Before pushing
   ```bash
   git checkout main
   git pull origin main
   git checkout feature/my-feature
   git rebase main
   # Resolve conflicts
   git add .
   git rebase --continue
   ```

2. **Verify**: Run tests after resolution
   ```bash
   npm test
   ```

3. **Force Push**: Only if you've already pushed the branch
   ```bash
   git push --force-with-lease origin feature/my-feature
   ```

---

## Additional Resources

### Project Documentation
- **[CLAUDE.md](CLAUDE.md)**: Comprehensive project guide (architecture, commands, conventions)
- **[README.md](README.md)**: Quick start and overview
- **[DEPLOYMENT.md](docs/SBQC-Stack-Final/05-DEPLOYMENT.md)**: Deployment guide and environment setup
- **[API Reference](docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md)**: Complete endpoint documentation

### Architecture Deep Dives
- **[V3 RAG Architecture](specs/V3_RAG_ARCHITECTURE.md)**: RAG system design
- **[V4 Analytics Architecture](specs/V4_ANALYTICS_ARCHITECTURE.md)**: Analytics and improvement loops
- **[Qdrant Deployment](docs/QDRANT_DEPLOYMENT.md)**: Vector store setup guide

### Workflow Documentation
- **[n8n Integration](docs/reports/n8n-ingestion.md)**: Document ingestion workflows
- **[Prompt Improvement](docs/reports/n8n-prompt-improvement-v4.md)**: Automated prompt optimization

---

## Getting Help

- **Documentation Issues**: Check CLAUDE.md first, then file an issue
- **Bug Reports**: Include reproduction steps, environment, and logs
- **Feature Requests**: Describe use case and expected behavior
- **Questions**: Use GitHub Discussions or team chat

---

## License

[Include license information]

---

**Thank you for contributing to AgentX!** 🚀
