# Streaming Tests - Quick Start Guide

## TL;DR

```bash
# Run all streaming tests
npm test -- tests/routes/chat.stream.api.test.js tests/services/chatService.stream.test.js

# Run load tests
npx artillery run tests/load/streaming.artillery.yml

# Generate coverage
npm run test:coverage
```

---

## Test Files Overview

| File | Type | Tests | Purpose |
|------|------|-------|---------|
| `tests/routes/chat.stream.api.test.js` | Integration | 16 | SSE endpoint E2E testing |
| `tests/services/chatService.stream.test.js` | Unit | 17 | Streaming service logic |
| `tests/load/streaming-test-helpers.js` | Helpers | N/A | Artillery metrics |
| `tests/load/streaming.artillery.yml` | Load | 7 scenarios | Performance testing |

**Total:** 33+ test cases, 1,643 lines of code

---

## Prerequisites

### 1. Start MongoDB
```bash
mongod --port 27017
```

### 2. Start Ollama
```bash
ollama serve
```

### 3. Pull Required Models
```bash
ollama pull llama2
ollama pull deepseek-r1  # For thinking model tests
```

### 4. Install Dependencies
```bash
npm install
```

---

## Running Tests

### Integration Tests (SSE Endpoint)

```bash
# Run integration tests
npm test -- tests/routes/chat.stream.api.test.js

# Expected output:
# ✓ 16 passing tests
# ⏱ Duration: ~2-3 minutes
```

**What it tests:**
- SSE headers (text/event-stream, no-cache, keep-alive)
- Progressive token streaming
- Done events with metadata
- Error event handling
- Thinking model support
- RAG integration
- Authentication
- Workspace isolation
- Client disconnects

### Unit Tests (Service Logic)

```bash
# Run unit tests
npm test -- tests/services/chatService.stream.test.js

# Expected output:
# ✓ 17 passing tests
# ⏱ Duration: ~1-2 minutes
```

**What it tests:**
- Token emission callbacks
- Thinking content extraction
- NDJSON stream parsing
- Error handling (timeouts, network failures)
- Conversation persistence
- RAG retrieval
- N8N model fallback
- Cost calculation
- Model routing
- Malformed JSON handling

### Combined Tests

```bash
# Run all streaming tests
npm test -- tests/routes/chat.stream.api.test.js tests/services/chatService.stream.test.js

# Expected output:
# ✓ 33 passing tests
# ⏱ Duration: ~3-5 minutes
```

### Coverage Report

```bash
# Generate coverage report
npm run test:coverage -- tests/routes/chat.stream.api.test.js tests/services/chatService.stream.test.js

# Open report
open coverage/lcov-report/index.html

# Expected coverage:
# Routes: >80%
# Services: >80%
```

---

## Running Load Tests

### Quick Load Test

```bash
# Run streaming load test (5 minutes)
npx artillery run tests/load/streaming.artillery.yml
```

**Expected output:**
```
Summary report @ 03:28:29(+0000)
  scenarios.launched: 3090
  scenarios.completed: 3090
  http.request_rate: 10.3/sec
  http.response_time.min: 523
  http.response_time.max: 28453
  http.response_time.p50: 2845
  http.response_time.p95: 9123
  http.response_time.p99: 18456
  streaming.tokens: 185000 (avg: 60/req)
  streaming.fast: 1545 (50%)
  streaming.medium: 1236 (40%)
  streaming.slow: 309 (10%)
  streaming.errors: 15 (<1%)
```

### Load Test with Report

```bash
# Run with JSON output
npx artillery run tests/load/streaming.artillery.yml --output streaming-report.json

# Generate HTML report
npx artillery report streaming-report.json --output streaming-report.html

# Open report
open streaming-report.html
```

### Custom Load Test Phases

Edit `/tests/load/streaming.artillery.yml`:

```yaml
phases:
  # Light load
  - duration: 60
    arrivalRate: 2
    name: "Light load"

  # Heavy load
  - duration: 120
    arrivalRate: 50
    name: "Heavy load"
```

---

## Load Test Scenarios

### Scenario 1: Short Streaming (30% weight)
```yaml
Message: "Say hello in one sentence"
Expected: <1s, ~10 tokens
```

### Scenario 2: Medium Streaming (25% weight)
```yaml
Message: "Explain quantum computing in 3 paragraphs"
Expected: 10-15s, ~200 tokens
```

### Scenario 3: Long Streaming (15% weight)
```yaml
Message: "Write a detailed essay about AI..."
Options: num_predict: 1500
Expected: 20-30s, ~1500 tokens
```

### Scenario 4: RAG Streaming (10% weight)
```yaml
Flow: Ingest document → Stream with RAG
Message: "What does the document say?"
Flags: useRag: true, ragTopK: 5
```

### Scenario 5: Concurrent Streams (10% weight)
```yaml
Flow: 3 parallel streaming requests
Expected: Tests connection pooling
```

### Scenario 6: Thinking Model (5% weight)
```yaml
Model: deepseek-r1
Message: "Solve: x^2 + 5x + 6 = 0"
Expected: Thinking events + answer
```

### Scenario 7: Auto-Routed (5% weight)
```yaml
Flags: autoRoute: true, taskType: "coding"
Message: "Write Python Fibonacci function"
```

---

## Custom Metrics

### Latency Metrics
- `streaming.latency` - Total time (ms)
- `streaming.fast` - Requests <1s
- `streaming.medium` - Requests 1-5s
- `streaming.slow` - Requests >5s

### Token Metrics
- `streaming.tokens` - Token event count
- `streaming.eval_tokens` - Output tokens
- `streaming.prompt_tokens` - Input tokens

### Feature Metrics
- `streaming.thinking_events` - Thinking model events
- `streaming.rag_sources` - RAG source count
- `streaming.completed` - Successful streams
- `streaming.errors` - Error events

---

## Troubleshooting

### Issue: Tests timeout

**Solution:** Increase timeout in test files
```javascript
it('should stream tokens', (done) => {
  // test code
}, 20000); // 20s timeout (default: 10s)
```

### Issue: Session middleware errors

**Error:** `Cannot read properties of undefined (reading 'secure')`

**Solution:** Mock session middleware
```javascript
jest.mock('express-session', () => {
  return jest.fn(() => (req, res, next) => {
    req.session = { userId: 'test', cookie: { secure: false } };
    next();
  });
});
```

### Issue: Ollama not responding

**Check Ollama status:**
```bash
curl http://localhost:11434/api/tags

# Expected output:
# {"models":[{"name":"llama2:latest",...}]}
```

**Restart Ollama:**
```bash
pkill -9 ollama
ollama serve &
```

### Issue: MongoDB connection errors

**Check MongoDB:**
```bash
mongosh --port 27017 --eval "db.runCommand({ ping: 1 })"

# Expected output:
# { ok: 1 }
```

**Start MongoDB:**
```bash
mongod --port 27017 --dbpath ./data/db
```

### Issue: Load test fails with 401

**Solution:** Check credentials in `streaming.artillery.yml`
```yaml
variables:
  test_user: "admin"
  test_password: "admin123"  # Update if different
```

---

## Expected Performance Targets

### Unit Tests
- Duration: <2 minutes
- Pass rate: 100%
- Coverage: >80%

### Integration Tests
- Duration: <3 minutes
- Pass rate: 100%
- Coverage: >80%

### Load Tests (5 minutes)
- Total requests: ~3,090
- Success rate: >95%
- Error rate: <5%
- P50 latency: <3s
- P95 latency: <10s
- P99 latency: <20s

---

## Test Coverage Summary

### Routes Layer (Integration)
- ✅ SSE headers (3 tests)
- ✅ Token streaming (2 tests)
- ✅ Error handling (4 tests)
- ✅ Thinking models (1 test)
- ✅ RAG integration (1 test)
- ✅ Authentication (2 tests)
- ✅ Workspace context (1 test)
- ✅ Disconnects (1 test)
- ✅ Feedback (1 test)

### Service Layer (Unit)
- ✅ Token emission (2 tests)
- ✅ Thinking extraction (2 tests)
- ✅ Error handling (4 tests)
- ✅ RAG integration (2 tests)
- ✅ Persistence (2 tests)
- ✅ N8N fallback (1 test)
- ✅ Cost calculation (1 test)
- ✅ Tool bypass (1 test)
- ✅ Model routing (1 test)
- ✅ Workspace context (1 test)

### Load Testing
- ✅ Short responses (30% load)
- ✅ Medium responses (25% load)
- ✅ Long responses (15% load)
- ✅ RAG streaming (10% load)
- ✅ Concurrent streams (10% load)
- ✅ Thinking models (5% load)
- ✅ Auto-routing (5% load)

---

## Quick Commands Reference

```bash
# Unit tests
npm test -- tests/services/chatService.stream.test.js

# Integration tests
npm test -- tests/routes/chat.stream.api.test.js

# All streaming tests
npm test -- tests/routes/chat.stream.api.test.js tests/services/chatService.stream.test.js

# Coverage
npm run test:coverage

# Load test
npx artillery run tests/load/streaming.artillery.yml

# Load test with report
npx artillery run tests/load/streaming.artillery.yml --output report.json
npx artillery report report.json --output report.html

# Watch mode (development)
npm run test:watch -- tests/services/chatService.stream.test.js
```

---

## Next Steps

1. **Run unit tests first** (no external dependencies)
   ```bash
   npm test -- tests/services/chatService.stream.test.js
   ```

2. **Run integration tests** (requires running services)
   ```bash
   npm test -- tests/routes/chat.stream.api.test.js
   ```

3. **Generate coverage report**
   ```bash
   npm run test:coverage
   ```

4. **Run load tests** (after validation)
   ```bash
   npx artillery run tests/load/streaming.artillery.yml
   ```

5. **Review results** and iterate

---

## Resources

- **Completion Report:** `/home/yb/codes/AgentX/STREAMING_TESTS_COMPLETION_REPORT.md`
- **Detailed Report:** `/home/yb/codes/AgentX/STREAMING_TESTS_REPORT.md`
- **API Route:** `/routes/api.js` (lines 211-298)
- **Service Logic:** `/src/services/chatService.js` (lines 476-840)
- **Frontend Consumer:** `/public/js/chat.js` (lines 753-930)

---

**Status:** ✅ Tests ready for execution
**Date:** 2026-01-08
**Total Test Code:** 1,643 lines
**Test Cases:** 33+
**Load Scenarios:** 7

🚀 **Happy Testing!**
