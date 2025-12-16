# Testing Infrastructure

## Overview

AgentX now includes comprehensive test coverage using Jest framework. Tests are organized by service layer and include both unit and integration tests.

## Setup

### Installation

```bash
npm install --save-dev jest @types/jest
```

### Configuration

Jest is configured via `jest.config.js` with:
- Node test environment
- Coverage reporting
- 10-second timeout for async operations
- Test file pattern: `tests/**/*.test.js`

## Running Tests

```bash
# Run all tests
npm test

# Watch mode (re-run on file changes)
npm run test:watch

# Generate coverage report
npm run test:coverage
```

## Test Structure

```
tests/
├── services/
│   ├── vectorStore.test.js    # InMemoryVectorStore unit tests
│   ├── ragStore.test.js        # RAG document management tests
│   └── embeddings.test.js      # (Future) Embeddings service tests
├── routes/
│   └── api.test.js             # (Future) API endpoint integration tests
└── helpers/
    └── testUtils.js            # Shared test utilities and mocks
```

## Test Coverage

### Vector Store Tests (`vectorStore.test.js`)

Tests for `InMemoryVectorStore` adapter:

- ✅ **upsertDocument**: Creating and updating documents with chunks
- ✅ **searchSimilar**: Cosine similarity search with scoring
- ⚠️ **Metadata filtering**: Partially implemented (needs improvement)
- ✅ **deleteDocument**: Removing documents and their vectors
- ✅ **listDocuments**: Listing all stored documents
- ⚠️ **Pagination**: API exists but needs implementation fixes
- ⚠️ **getStats**: Returns stats but vectorDimension calculation needs fix
- ⚠️ **healthCheck**: Basic health check (return format needs alignment)

### RAG Store Tests (`ragStore.test.js`)

Tests for high-level RAG document management:

- ⚠️ **upsertDocumentWithChunks**: Requires full metadata (source, path, title)
- ⚠️ **searchSimilarChunks**: Integration with vector store
- ⚠️ **Document deduplication**: Content hash-based dedup
- ⚠️ **getDocumentById**: Method needs to be added to RagStore
- ⚠️ **deleteDocument**: Full document deletion with all chunks
- ⚠️ **listDocuments**: Document listing with metadata filters

**Status**: ⚠️ Tests written but require proper mocking and API alignment

### Test Utilities (`testUtils.js`)

Shared helpers for creating test data:

- `mockOllamaResponse()`: Mock Ollama chat responses
- `mockOllamaStreamChunk()`: Mock streaming responses
- `mockEmbeddingResponse()`: Generate deterministic embeddings
- `createTestDocument()`: Create test vector documents
- `createMockMongoDocument()`: Mock MongoDB documents

## Known Issues & TODOs

### High Priority

1. **Metadata Filtering**: Vector store metadata filtering doesn't work for arbitrary fields
   - Current: Only filters on `source` and `tags`
   - Needed: Generic metadata filtering
   
2. **RAG Store Validation**: Tests fail because metadata requires `source`, `path`, and `title`
   - Need to update tests with complete metadata
   - Or relax validation for testing

3. **API Method Gaps**: Some methods used in tests don't exist
   - `ragStore.getDocumentById()` - needs implementation
   
### Medium Priority

4. **Search Result Limiting**: `searchSimilar()` returns all results, ignoring `topK` parameter
   - Implementation exists but filtering logic has bugs

5. **Pagination**: `listDocuments()` ignores `limit` and `offset` parameters

6. **Stats Calculation**: `getStats()` doesn't return `vectorDimension`

### Low Priority

7. **Health Check Format**: Inconsistent return format (`healthy` vs `status`)

8. **Integration Tests**: Need API endpoint tests with real HTTP requests

9. **Embeddings Tests**: No tests for embeddings service yet

## Best Practices

### Writing Tests

```javascript
describe('ServiceName', () => {
  let service;

  beforeEach(() => {
    service = new ServiceClass();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('should do something specific', async () => {
    // Arrange
    const input = { ... };

    // Act
    const result = await service.method(input);

    // Assert
    expect(result).toBeDefined();
    expect(result.property).toBe('expected');
  });
});
```

### Mocking External Dependencies

```javascript
jest.mock('../../src/services/embeddings', () => ({
  getEmbeddingsService: jest.fn(() => ({
    generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
  }))
}));
```

### Testing Async Operations

```javascript
test('should handle async operations', async () => {
  const promise = service.asyncMethod();
  await expect(promise).resolves.toBeDefined();
});

test('should handle errors', async () => {
  await expect(service.errorMethod()).rejects.toThrow('Error message');
});
```

## Next Steps

1. Fix vector store metadata filtering implementation
2. Add missing RagStore methods (`getDocumentById`)
3. Update test data to match validation requirements
4. Implement proper `topK` limiting in search
5. Add pagination support to `listDocuments`
6. Create integration tests for API endpoints
7. Add embeddings service tests
8. Set up CI/CD with automated testing

## Coverage Goals

- **Target**: 80% code coverage minimum
- **Current**: ~30% (initial tests, many failures)
- **Priority Areas**:
  - Core services (RAG, vector store, embeddings): 90%+
  - API routes: 80%+
  - Utilities and helpers: 70%+

## Running Specific Tests

```bash
# Run tests for a specific file
npm test vectorStore.test.js

# Run tests matching a pattern
npm test --testNamePattern="should add a new document"

# Run with verbose output
npm test -- --verbose
```

## Debugging Tests

```bash
# Run tests in debug mode
node --inspect-brk node_modules/.bin/jest --runInBand

# Then attach Chrome DevTools to chrome://inspect
```

## Continuous Integration

When setting up CI/CD, add to your pipeline:

```yaml
# .github/workflows/test.yml (example)
- name: Run tests
  run: npm test
  
- name: Check coverage
  run: npm run test:coverage
  
- name: Upload coverage
  uses: codecov/codecov-action@v3
```

---

**Status**: Task 8 (Testing Infrastructure) - IN PROGRESS
**Last Updated**: 2025-12-04
**Maintainer**: GitHub Copilot + User
