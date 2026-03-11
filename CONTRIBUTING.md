# Contributing to AgentX

Welcome to AgentX! This guide covers the development workflow and contribution guidelines.

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

```bash
# Delete after merge
git branch -d feature/my-feature

# Sync regularly
git checkout main && git pull origin main
git checkout feature/my-feature && git rebase main
```

---

## Git Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `style`

**Examples:**
```
feat(chat): add streaming response support
fix(rag): resolve vector store memory leak
docs(api): update analytics endpoint reference
```

---

## Testing Standards

```bash
npm test                     # Must pass before committing
npm run test:coverage        # Coverage report
./test-all.sh                # E2E tests
npm run test:load            # Load tests
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

---

## Pull Request Process

**Before Submitting:**
- [ ] `npm test` passes locally
- [ ] Code follows SOA pattern (routes → services → models)
- [ ] Documentation updated (API ref, CLAUDE.md if needed)
- [ ] No console.log() statements (use logger instead)
- [ ] Environment variables documented (if new ones added)

**PR Template:** `.github/PULL_REQUEST_TEMPLATE.md`

**Review:** Automated CI checks → Manual review → Approval → Squash and merge

---

## Code Review Checklist

**Architecture:**
- [ ] Route → Service → Model pattern followed
- [ ] Business logic in services, NOT routes
- [ ] Stateful services use Singleton pattern

**Error Handling:**
- [ ] Errors logged with `winston` (not `console.log`)
- [ ] HTTP status codes appropriate
- [ ] No stack traces in production responses

**Security:**
- [ ] Input validation (NoSQL injection prevention)
- [ ] Rate limiting on new endpoints
- [ ] Secrets not hardcoded or in logs

---

## Documentation Updates

**When to update docs:**
- Adding/removing major components (routes, services, models)
- Changing architecture patterns
- New npm scripts or environment variables

**Documentation maintenance checks:**
- Update [docs/INDEX.md](docs/INDEX.md) when you add or remove canonical entry-point docs.
- Keep [docs/guides/README.md](docs/guides/README.md) and [docs/testing/README.md](docs/testing/README.md) in sync with new troubleshooting or testing docs.
- Verify relative markdown links in any documentation files you touch.

**API Reference:** Update `docs/architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md` for new/changed endpoints.

**Changelog:** Use conventional commit messages — git history serves as the changelog.

---

## Breaking Changes Protocol

- Prefer backward compatible changes (add fields with defaults)
- Create migration scripts in `/scripts/migrations/` if breaking
- Version new APIs (e.g., V3 → V4)
- Add deprecation headers (X-API-Deprecated, X-API-Sunset)

**Checklist:**
- [ ] Migration script created (if needed)
- [ ] API versioning applied (if API change)
- [ ] Documentation updated
- [ ] Changelog entry with **[BREAKING]** prefix
- [ ] Rollback plan documented
