# Contributing to AgentX

Welcome to AgentX! This guide covers the development workflow and contribution guidelines for the project.

For architectural patterns and system design, see [CLAUDE.md](CLAUDE.md).
For project status and priorities, see [ROADMAP.md](ROADMAP.md).

---

## Branching Strategy

Use descriptive branch names following these patterns:
- `feature/my-feature` - New functionality
- `fix/issue-description` - Bug fixes
- `docs/update-api-reference` - Documentation updates
- `refactor/service-restructure` - Code refactoring

Branch from `main` and keep branches focused (one feature/fix per branch).

**Branch Management:**
```bash
# Delete after merge
git branch -d feature/my-feature

# Sync regularly
git checkout main && git pull origin main
git checkout feature/my-feature && git rebase main
```

---

## Git Conventions

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
```

---

## Testing Standards

**Pre-commit Requirements:**
```bash
npm test  # Must pass before committing
```

**Coverage Expectations:**
- Services: >80%
- Routes: >70%
- Helpers: >90%

**When to Write Tests:**
- **Unit Tests (Required):** New service methods, helper functions, model static methods
- **Integration Tests (Required):** New API endpoints, database schema changes, auth changes
- **E2E Tests (Recommended):** Critical user flows (chat, RAG, onboarding)
- **Load Tests (Situational):** Performance-critical endpoints, after optimization work

**Full Test Suite:**
```bash
./test-all.sh                # E2E tests
npm run test:coverage        # Coverage report
npm run test:load            # Load tests
```

---

## Pull Request Process

**Before Submitting:**
- [ ] `npm test` passes locally
- [ ] Code follows SOA pattern (routes → services → models)
- [ ] Documentation updated (API ref, CLAUDE.md if needed)
- [ ] Changelog entry added
- [ ] No console.log() statements (use logger instead)
- [ ] Environment variables documented (if new ones added)

**Pull Request Template:** Available at `.github/PULL_REQUEST_TEMPLATE.md`

**Review Process:**
1. Automated Checks: GitHub Actions runs tests automatically
2. Manual Review: Code review by maintainer/team member
3. Approval: At least one approval required
4. Merge Strategy: Squash and merge preferred (keeps history clean)

---

## Code Review Checklist

**Architecture:**
- [ ] Code follows Route → Service → Model pattern
- [ ] Business logic is in services, NOT routes
- [ ] Stateful services use Singleton pattern

**Error Handling:**
- [ ] Errors caught and logged using `winston` (not `console.log`)
- [ ] User-facing error messages sanitized (no stack traces in production)
- [ ] HTTP status codes appropriate (200, 400, 401, 403, 404, 500, 503)

**Security:**
- [ ] Input validation performed (NoSQL injection prevention)
- [ ] Rate limiting verified for new endpoints
- [ ] Authentication/authorization checks in place
- [ ] Secrets never hardcoded (use environment variables)
- [ ] API keys not exposed in logs

**Logging:**
- [ ] Structured logging with `winston` (info, warn, error, debug)
- [ ] Logs include context (userId, conversationId, etc.)
- [ ] No sensitive data in logs (passwords, API keys, tokens)

**Documentation:**
- [ ] CLAUDE.md metrics updated (if significant changes)
- [ ] API reference updated for API changes
- [ ] Code comments added for complex logic
- [ ] Changelog entry added

---

## Documentation Update Requirements

**When to Update CLAUDE.md:**
- Adding/removing major components (routes, services, models)
- Changing architecture patterns
- Adding new npm scripts or deployment steps
- Introducing new environment variables

**Update Codebase Metrics:**
```bash
# Count lines for your changes
wc -l src/services/myNewService.js  # e.g., 234 lines
```

Add to the metrics section:
```markdown
- ✅ **Core Services:** 18 → 19 services (added myNewService.js - 234 lines)
```

**API Reference:**
Update `docs/architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md` for:
- New endpoints (method, path, request/response schemas)
- Changed parameters or response formats
- Deprecated endpoints (mark as deprecated, include migration path)

**Changelog:**
Record all changes in `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/) format.

---

## Breaking Changes Protocol

**Database Schema Changes:**
- Prefer backward compatible changes (add fields with defaults)
- Create migration scripts in `/scripts/migrations/` if breaking
- Document migration in `docs/migrations/`
- Verify indexes for performance impact

**API Contract Changes:**
- Version new APIs (e.g., V3 → V4)
- Keep old versions for backward compatibility
- Add deprecation headers (X-API-Deprecated, X-API-Sunset)
- Update contracts in `docs/api/contracts/`

**Environment Variables:**
- Document new variables in CLAUDE.md and `.env.example`
- Provide migration guide for changed variables
- Add to changelog with removal date for deprecated vars

**Breaking Change Checklist:**
- [ ] Migration script created (if needed)
- [ ] Backward compatibility considered
- [ ] API versioning applied (if API change)
- [ ] Documentation updated (CLAUDE.md, API ref, migration guide)
- [ ] Changelog entry with **[BREAKING]** prefix
- [ ] Team notified
- [ ] Rollback plan documented

---

## Established Patterns

**Wizard Consolidation Pattern:**
When multiple components share similar logic:
1. Create base class with shared functionality (step navigation, rendering, styling)
2. Extract common methods to base class (nextStep, prevStep, render, etc.)
3. Keep component-specific logic in subclasses (step definitions, API calls)
4. Benefits: 20-50% code reduction, easier maintenance, consistent UX

**Documentation Updates:**
After major refactoring:
1. Update line counts in CLAUDE.md
2. Document architectural improvements (base classes, patterns)
3. Update codebase metrics in "Current State" section

---

**Thank you for contributing to AgentX!** 🚀
