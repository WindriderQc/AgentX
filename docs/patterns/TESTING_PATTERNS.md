# Testing Patterns

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Testing Patterns

> **Context:** AgentX testing conventions and patterns. For complete testing documentation, see [ROADMAP.md Track 5](../../ROADMAP.md#track-5-testing-infrastructure--ci-cd).

## Jest Configuration

**Config:** `jest.config.js`
- Test environment: Node.js
- Test pattern: `**/tests/**/*.test.js`
- Coverage: `src/`, `routes/`, `models/`
- Timeout: 10 seconds

## Integration Tests

**Location:** `/tests/integration/*.test.js`

**Pattern:** Uses `mongodb-memory-server` for isolated testing
```javascript
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
```

## Load Testing with Artillery

**Configs:**
- `/tests/load/basic-load.yml` - Normal traffic simulation
- `/tests/load/stress-test.yml` - High concurrent load

## Coverage Standards

- **Services:** >80%
- **Routes:** >70%
- **Helpers:** >90%

## Quick Commands

```bash
npm test                    # Run Jest tests (silent mode)
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report
npm run test:e2e            # End-to-end tests
npm run test:load           # Load test with Artillery
```

## Related Documentation

- [Critical Conventions](CRITICAL_CONVENTIONS.md) - Error handling and logging patterns
- [ROADMAP.md Track 5](../../ROADMAP.md#track-5-testing-infrastructure--ci-cd) - Full testing strategy
- [Testing Hub](../testing/README.md) - Complete testing documentation

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
