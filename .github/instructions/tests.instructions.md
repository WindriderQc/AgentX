---
description: "Use when writing, editing, or reviewing Jest tests. Covers mock setup order, auth/workspace stubs, MongoMemoryServer, supertest route tests, coverage targets, and common pitfalls."
applyTo: "tests/**"
---
# Testing Conventions

## Stack
- **Framework**: Jest (`tests/**/*.test.js`, `jest.config.js`)
- **HTTP testing**: `supertest`
- **DB isolation**: `mongodb-memory-server` (integration tests)
- **Timeout**: 60 s default (`JEST_TEST_TIMEOUT` env var)

## Commands
```bash
npm test                     # all tests (silent)
npm run test:unit            # unit tests with coverage
npm run test:integration     # integration tests (--runInBand, required)
npm run test:workflows       # workflow tests
npm run test:ci              # --detectOpenHandles
```

## Coverage Targets
| Layer | Minimum |
|-------|---------|
| `src/services/` | >80% |
| `routes/` | >70% |
| `src/helpers/` | >90% |

## Mock Order Rule
**Mock modules BEFORE requiring the app or routes.** Jest hoists `jest.mock()` but explicit ordering prevents confusion.

```javascript
// 1. Mock auth middleware
jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { _id: 'user-123' }; next(); },
  optionalAuth: (req, res, next) => { res.locals.user = { userId: 'user-123' }; next(); },
  apiKeyAuth:   (req, res, next) => next(),
  requireAdmin: (req, res, next) => next()
}));

// 2. Mock workspace middleware
jest.mock('../../src/middleware/workspace', () => {
  const mongoose = require('mongoose');
  const wsId = new mongoose.Types.ObjectId();
  global.__testWorkspaceId = wsId;
  return {
    attachWorkspace:         (req, res, next) => { req.workspace = { _id: wsId, slug: 'test' }; next(); },
    optionalWorkspaceContext:(req, res, next) => next(),
    requireWorkspaceAccess:  () => (req, res, next) => next(),
    requirePermission:       () => (req, res, next) => next()
  };
});

// 3. Now safe to require the app / routes
const { app } = require('../../src/app');
```

## Route Tests (supertest)
```javascript
const request = require('supertest');
// Mount mocks above, then:
const { app } = require('../../src/app');

describe('POST /api/resource', () => {
  it('returns 201 on success', async () => {
    const res = await request(app)
      .post('/api/resource')
      .send({ name: 'test' })
      .expect(201);
    expect(res.body.status).toBe('success');
  });
});
```

## Integration Tests (MongoMemoryServer)
```javascript
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await MyModel.deleteMany({});
});
```

## Chainable Query Mocks
Services use `.lean()`, `.select()`, `.sort()`, `.limit()` — mock the full chain:
```javascript
const mockQuery = {
  select: jest.fn().mockReturnThis(),
  lean:   jest.fn().mockReturnThis(),
  sort:   jest.fn().mockReturnThis(),
  limit:  jest.fn().mockResolvedValue([])
};
jest.spyOn(MyModel, 'find').mockReturnValue(mockQuery);
```

## Singleton Services
Never instantiate directly; mock the getter:
```javascript
jest.mock('../../src/services/ragStore', () => ({
  getRagStore: jest.fn().mockReturnValue({
    search: jest.fn().mockResolvedValue([]),
    add: jest.fn().mockResolvedValue(true)
  })
}));
```

## Test Structure
```javascript
describe('ServiceOrRoute', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('happy path', () => {
    it('does X when Y', async () => { ... });
  });

  describe('error handling', () => {
    it('returns 500 on DB failure', async () => { ... });
  });
});
```

## Common Pitfalls
- **`--runInBand` required** for integration tests — parallel runs share the in-memory DB and cause flakiness
- **`jest.clearAllMocks()` in `beforeEach`** — prevents state leaking between tests
- **No `new RagStore()`** in tests — always mock `getRagStore()`, `getEmbeddingsService()`
- **Response shape** routes always return `{ status: 'success'|'error', data|message }` — assert both fields
