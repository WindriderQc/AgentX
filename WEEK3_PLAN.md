# Week 3 Plan - Advanced Features & Production Hardening

**Date:** 2026-01-06
**Status:** 🚀 **INITIATED**
**Duration:** Days 1-14 (accelerated execution expected)

---

## 🎯 Mission

Week 3 focuses on **production-grade enhancements** and **advanced user-facing features** that elevate AgentX from functional to exceptional:

1. **Real-Time Features** - Streaming responses, live dashboard updates
2. **Advanced RAG** - Query expansion, re-ranking, hybrid search
3. **Security Hardening** - API key management, audit logging, production CSP
4. **Performance Optimization** - Redis caching, database tuning, compression
5. **Documentation** - Complete user guides, API references, deployment docs

---

## Week 3 Structure

### Days 1-3: Real-Time Features
- **Day 1-2:** Streaming Response Support (SSE)
- **Day 3:** Real-Time Dashboard Updates (WebSocket/SSE)

### Days 4-6: Advanced RAG Features
- **Day 4:** Query Expansion
- **Day 5:** Result Re-Ranking
- **Day 6:** Hybrid Search (Vector + Keyword)

### Days 7-9: Security Hardening
- **Day 7:** API Key Scoping & Rotation
- **Day 8:** Audit Logging UI
- **Day 9:** Production CSP & Security Headers

### Days 10-12: Performance Optimization
- **Day 10:** Redis Caching Layer
- **Day 11:** Database Query Optimization
- **Day 12:** Frontend Asset Optimization

### Days 13-14: Documentation & Deployment
- **Day 13:** User Manual Updates, API Documentation
- **Day 14:** Docker Containerization, Final Testing

---

## Days 1-2: Streaming Response Support ✨ HIGH VALUE

### Goal
Enable real-time token streaming in chat interface for better UX and support for thinking models.

### Deliverables

**1. Backend SSE Implementation** (`/routes/chat.js`)
```javascript
// New endpoint: POST /api/chat/stream
router.post('/stream', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Stream tokens as they arrive from Ollama/n8n
  // Handle thinking vs content tokens
  // Support client-side cancellation
});
```

**2. chatService Streaming Support** (`/src/services/chatService.js`)
- Add `streamEnabled` parameter support
- Handle Ollama streaming API (`stream: true` in payload)
- Parse NDJSON stream from Ollama
- Emit SSE events: `data`, `thinking`, `done`, `error`

**3. Frontend Streaming UI** (`/public/index.html`)
- EventSource API for SSE consumption
- Progressive token rendering (word-by-word)
- Thinking section reveal (for thinking models)
- Stop/cancel button during generation
- Graceful fallback to non-streaming

**4. n8n LLM Streaming** (`/src/services/n8nLLMProvider.js`)
- Check if n8n webhook supports streaming
- Stream proxy if supported, buffer if not
- Unified SSE format for both Ollama and n8n

### Testing
- Manual test with qwen2.5-coder (fast tokens)
- Manual test with deepseek-r1 (thinking model)
- Test cancellation mid-stream
- Verify conversation history still saves correctly

### Success Criteria
- ✅ Tokens appear progressively in chat UI
- ✅ Thinking models show separate thinking section
- ✅ Stop button cancels generation
- ✅ Non-streaming mode still works

---

## Day 3: Real-Time Dashboard Updates 📊

### Goal
Replace 30-second polling with instant updates for operations dashboard.

### Approach Decision
**Option A:** WebSocket (bidirectional, persistent connection)
**Option B:** SSE (server-to-client, simpler, better for monitoring)

**Choice:** SSE (simpler, fits monitoring use case)

### Deliverables

**1. SSE Endpoint** (`/routes/operations.js`)
```javascript
// GET /api/operations/events
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  // Emit events on:
  // - Health status change
  // - New activity log
  // - Alert triggered
  // - Workflow test result
});
```

**2. Event Emitter Integration** (`/src/app.js`)
- Global EventEmitter for system events
- Emit on health check changes
- Emit on new ActivityLog entries
- Emit on alert creation

**3. Frontend SSE Consumer** (`/public/dashboard.html`)
- Replace `setInterval` with EventSource
- Update UI instantly on events
- Maintain fallback polling (every 60s for heartbeat)
- Reconnection logic with exponential backoff

### Testing
- Trigger alert → Dashboard updates instantly
- Stop Ollama → Health card turns red instantly
- Test with multiple browser tabs open
- Verify memory doesn't leak over 1 hour

### Success Criteria
- ✅ Dashboard updates instantly (< 1s latency)
- ✅ No polling visible in network tab
- ✅ Reconnects automatically on connection drop
- ✅ Supports multiple concurrent clients

---

## Days 4-6: Advanced RAG Features 🔍

### Day 4: Query Expansion

**Goal:** Generate related queries to improve retrieval coverage

**Implementation:**
```javascript
// /src/services/ragStore.js - enhanceQuery()
async enhanceQuery(userQuery) {
  // 1. Use small LLM to generate 2-3 related queries
  const expandedQueries = await this._generateRelatedQueries(userQuery);

  // 2. Search with each query
  const results = await Promise.all(
    [userQuery, ...expandedQueries].map(q => this.searchSimilarChunks(q))
  );

  // 3. Deduplicate and merge results
  return this._deduplicateResults(results.flat());
}
```

**Testing:**
- Query: "how to deploy" → Expands to "deployment steps", "production setup"
- Verify coverage improvement (more relevant results)

---

### Day 5: Result Re-Ranking

**Goal:** Improve relevance by re-ranking semantic results with LLM judge

**Implementation:**
```javascript
// /src/services/ragStore.js - rerankResults()
async rerankResults(query, results, topK = 5) {
  // 1. Use LLM judge to score each result for relevance
  const scoredResults = await Promise.all(
    results.map(r => this._scoreRelevance(query, r))
  );

  // 2. Sort by LLM score (not just vector similarity)
  scoredResults.sort((a, b) => b.llmScore - a.llmScore);

  // 3. Return top K
  return scoredResults.slice(0, topK);
}

async _scoreRelevance(query, result) {
  // Prompt: "Rate relevance 0-10 for query: {query}, context: {result.text}"
  // Return: { ...result, llmScore: 8.5 }
}
```

**Testing:**
- Compare with/without re-ranking on ambiguous queries
- Measure latency impact (acceptable: < 2s)

---

### Day 6: Hybrid Search (Vector + Keyword)

**Goal:** Combine semantic search with keyword matching for better precision

**Implementation:**
```javascript
// /src/services/ragStore.js - hybridSearch()
async hybridSearch(query, options = {}) {
  // 1. Semantic search (existing)
  const vectorResults = await this.searchSimilarChunks(query, options);

  // 2. Keyword search (new - full-text search in MongoDB)
  const keywordResults = await this._keywordSearch(query, options);

  // 3. Reciprocal Rank Fusion (RRF) to merge
  const fusedResults = this._reciprocalRankFusion(vectorResults, keywordResults);

  return fusedResults;
}

_reciprocalRankFusion(listA, listB, k = 60) {
  // RRF formula: score = sum(1 / (k + rank_in_list))
  // Combine scores for docs in both lists
}
```

**Schema Update:**
```javascript
// /models/RAGDocument.js - Add text index
schema.index({ 'chunks.text': 'text', title: 'text' });
```

**Testing:**
- Query: "API endpoint" → Should match both semantic similarity AND exact keyword
- Verify hybrid outperforms pure semantic on exact term queries

---

## Days 7-9: Security Hardening 🔒

### Day 7: API Key Scoping & Rotation

**Goal:** Fine-grained API key permissions and rotation workflow

**Schema Update** (`/models/APIKey.js` - new model)
```javascript
{
  key: String (hashed, indexed),
  keyPrefix: String (last 8 chars, for display),
  userId: ObjectId,
  name: String,
  scopes: [String], // ['chat:read', 'chat:write', 'admin:*', 'rag:write']
  revokedAt: Date,
  expiresAt: Date,
  lastUsedAt: Date,
  usageCount: Number,
  createdAt: Date
}
```

**Middleware Update** (`/src/middleware/auth.js`)
```javascript
const checkScope = (requiredScope) => {
  return (req, res, next) => {
    const apiKey = req.apiKey; // Set by apiKeyAuth middleware
    if (!apiKey.scopes.includes(requiredScope) && !apiKey.scopes.includes('admin:*')) {
      return res.status(403).json({ error: 'Insufficient scope' });
    }
    next();
  };
};
```

**API Endpoints** (`/routes/api-keys.js` - new)
```javascript
POST /api/keys - Create new key with scopes
GET /api/keys - List user's keys (show prefix only)
DELETE /api/keys/:id - Revoke key
POST /api/keys/:id/rotate - Generate new key, revoke old
```

**UI** (`/public/settings.html` - new section)
- List active API keys (prefix only)
- Create new key modal (select scopes)
- Revoke/rotate buttons
- Copy key to clipboard (shown once on creation)

---

### Day 8: Audit Logging UI

**Goal:** Admin dashboard for reviewing sensitive operations

**Schema** (`/models/AuditLog.js` - new)
```javascript
{
  timestamp: Date (indexed),
  userId: ObjectId,
  action: String (enum: api_key_created, prompt_activated, model_deployed, ...),
  resource: String,
  resourceId: ObjectId,
  ipAddress: String,
  userAgent: String,
  details: Mixed,
  severity: String (enum: info, warning, critical)
}
```

**Logging Middleware** (`/src/middleware/auditLogger.js`)
```javascript
const auditLog = (action, severity = 'info') => {
  return async (req, res, next) => {
    // Log after response completes
    res.on('finish', async () => {
      if (res.statusCode < 400) {
        await AuditLog.create({
          timestamp: new Date(),
          userId: res.locals.user?.userId,
          action,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          severity
        });
      }
    });
    next();
  };
};
```

**Apply to Routes:**
```javascript
router.post('/api/keys', requireAuth, auditLog('api_key_created', 'warning'), handler);
router.patch('/api/prompt-configs/:id/activate', requireAuth, auditLog('prompt_activated', 'info'), handler);
router.post('/api/custom-models/:id/deploy', requireAuth, auditLog('model_deployed', 'critical'), handler);
```

**UI** (`/public/dashboard.html` - new Tab 4: Audit Log)
- Filterable table (user, action, date range)
- Severity indicators (color-coded)
- Export to CSV
- Real-time updates via SSE

---

### Day 9: Production CSP & Security Headers

**Goal:** Strict Content Security Policy for production deployment

**Helmet Configuration** (`/src/app.js`)
```javascript
if (process.env.NODE_ENV === 'production') {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"], // Chart.js
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
      }
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  }));
}
```

**Additional Headers:**
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`

**Testing:**
- Run security scan (e.g., OWASP ZAP)
- Verify CSP doesn't break dashboards
- Test with Firefox devtools (CSP warnings)

---

## Days 10-12: Performance Optimization ⚡

### Day 10: Redis Caching Layer

**Goal:** External cache for distributed caching across PM2 workers

**Installation:**
```bash
npm install redis ioredis
```

**Service** (`/src/services/cacheService.js` - new, ~200 lines)
```javascript
class CacheService {
  constructor() {
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.enabled = process.env.REDIS_ENABLED === 'true';
  }

  async get(key) {
    if (!this.enabled) return null;
    const value = await this.redis.get(key);
    return value ? JSON.parse(value) : null;
  }

  async set(key, value, ttlSeconds = 300) {
    if (!this.enabled) return;
    await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
  }

  async invalidate(pattern) {
    if (!this.enabled) return;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) await this.redis.del(...keys);
  }
}

module.exports = new CacheService();
```

**Integration Points:**
1. **Health Checks** (`/routes/operations.js`)
   - Cache key: `health:status`
   - TTL: 30 seconds
   - Invalidate on: Service status change

2. **Model Listings** (`/routes/models-unified.js`)
   - Cache key: `models:list:${target}`
   - TTL: 5 minutes
   - Invalidate on: Model registration/deletion

3. **Embeddings** (`/src/services/embeddings.js`)
   - Cache key: `embedding:${hash(text)}`
   - TTL: 24 hours
   - Shared across workers (no more per-worker LRU)

**Testing:**
- Verify cache hits (log hit rate)
- Test invalidation triggers
- Benchmark latency improvement (expect 50-80% reduction)

---

### Day 11: Database Query Optimization

**Goal:** Review and optimize MongoDB queries with indexes

**Tasks:**

1. **Analyze Slow Queries**
```javascript
// Enable MongoDB profiling
db.setProfilingLevel(1, { slowms: 100 });

// Review slow queries
db.system.profile.find({ millis: { $gt: 100 } }).sort({ ts: -1 }).limit(10);
```

2. **Add Missing Indexes**
```javascript
// Conversation queries
Conversation.schema.index({ userId: 1, createdAt: -1 });
Conversation.schema.index({ 'messages.feedback.rating': 1 });

// BenchmarkResult queries
BenchmarkResult.schema.index({ batchId: 1, createdAt: 1 });
BenchmarkResult.schema.index({ model: 1, 'stats.latency': 1 });

// MetricsSnapshot queries
MetricsSnapshot.schema.index({ timestamp: -1 });
MetricsSnapshot.schema.index({ model: 1, timestamp: -1 });
```

3. **Optimize Aggregation Pipelines**
- Use `$match` early to filter before `$group`
- Add `allowDiskUse: true` for large aggregations
- Consider materialized views for dashboard queries

4. **Connection Pool Tuning**
```javascript
// /config/db-mongodb.js
mongoose.connect(MONGODB_URI, {
  maxPoolSize: 20,
  minPoolSize: 5,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000
});
```

**Testing:**
- Run analytics dashboard queries before/after
- Measure latency improvement (target: 30% reduction)

---

### Day 12: Frontend Asset Optimization

**Goal:** Reduce page load times and bandwidth

**Tasks:**

1. **Add Compression Middleware**
```javascript
// /src/app.js
const compression = require('compression');
app.use(compression());
```

2. **Minify Static Assets**
```bash
npm install terser cssnano --save-dev
```

```javascript
// Build script: /scripts/build-assets.js
const terser = require('terser');
const cssnano = require('cssnano');

// Minify all JS/CSS in /public
```

3. **Add Cache Headers**
```javascript
// /src/app.js
app.use(express.static('public', {
  maxAge: '1d',
  etag: true
}));
```

4. **Lazy Load Chart.js**
```html
<!-- Only load Chart.js on pages that need it -->
<script>
if (document.getElementById('performance-chart')) {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
  document.head.appendChild(script);
}
</script>
```

**Testing:**
- Lighthouse audit (target: 90+ performance score)
- Network tab analysis (compare before/after sizes)

---

## Days 13-14: Documentation & Deployment 📚

### Day 13: Documentation Updates

**Tasks:**

1. **User Manual Updates** (`/docs/user-manual/README.md`)
   - Add streaming response guide
   - Document real-time dashboard features
   - Add advanced RAG section
   - Update API key management guide

2. **API Documentation** (`/docs/api/reference.md`)
   - Document SSE endpoints
   - Add API key management endpoints
   - Update RAG endpoints (hybrid search)
   - Add audit log endpoints

3. **Deployment Guide** (`/docs/deployment/PRODUCTION.md` - new)
   - Environment variables reference
   - Redis setup instructions
   - PM2 cluster configuration
   - Nginx reverse proxy config
   - SSL/TLS setup with Let's Encrypt
   - Security checklist

4. **CHANGELOG Update**
   - Document Week 3 features
   - List breaking changes (if any)
   - Migration guide for Week 2 → Week 3

---

### Day 14: Docker Containerization

**Goal:** Containerize AgentX for easy deployment

**Deliverables:**

1. **Dockerfile**
```dockerfile
FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application
COPY . .

# Expose port
EXPOSE 3080

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "require('http').get('http://localhost:3080/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Start application
CMD ["node", "server.js"]
```

2. **docker-compose.yml**
```yaml
version: '3.8'

services:
  agentx:
    build: .
    ports:
      - "3080:3080"
    environment:
      - NODE_ENV=production
      - MONGODB_URI=mongodb://mongo:27017/agentx
      - REDIS_URL=redis://redis:6379
      - OLLAMA_HOST=http://ollama:11434
    depends_on:
      - mongo
      - redis
    restart: unless-stopped

  mongo:
    image: mongo:7
    volumes:
      - mongo-data:/data/db
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama-data:/root/.ollama
    restart: unless-stopped

volumes:
  mongo-data:
  ollama-data:
```

3. **Docker Deployment Guide** (`/docs/deployment/DOCKER.md`)
   - Build and run instructions
   - Volume management
   - Environment configuration
   - Backup/restore procedures

**Testing:**
- Build Docker image
- Run docker-compose up
- Verify all services start correctly
- Test health endpoints
- Run integration test suite

---

## Success Criteria

### Week 3 Complete When:

1. **Real-Time Features** ✅
   - [ ] Streaming chat works with Ollama and n8n
   - [ ] Dashboard updates instantly via SSE
   - [ ] Stop button cancels generation

2. **Advanced RAG** ✅
   - [ ] Query expansion improves retrieval coverage
   - [ ] Re-ranking improves relevance scores
   - [ ] Hybrid search outperforms pure semantic

3. **Security** ✅
   - [ ] API keys have scoped permissions
   - [ ] Audit log tracks sensitive operations
   - [ ] CSP headers protect production deployment

4. **Performance** ✅
   - [ ] Redis caching reduces latency by 50%+
   - [ ] Database queries optimized with indexes
   - [ ] Frontend assets compressed and cached

5. **Documentation** ✅
   - [ ] User manual covers all Week 3 features
   - [ ] API documentation is complete
   - [ ] Docker deployment works end-to-end

---

## Code Metrics Target

- **New Files:** ~12 files (SSE endpoints, caching, audit log, Docker configs)
- **New Code:** ~3,000 lines
- **Modified Files:** ~10 files (chatService, operations routes, dashboards)
- **API Endpoints:** ~8 new endpoints
- **Tests:** Integration tests for streaming, caching, security

---

## External Agent Parallel Work

While I work on Week 3 features, external agent continues with:

**Test Suite Completion:**
- `modelRouter.test.js` - Routing logic, host failover
- `costCalculator.test.js` - Cost calculations, price lookup
- `embeddings.test.js` - Embedding generation, cache (IN PROGRESS)
- `ragStore.test.js` - Vector store operations

**Target Coverage:** >80% services, >70% routes

---

## Week 3 vs Week 2 Comparison

| Metric | Week 2 | Week 3 (Target) |
|--------|--------|-----------------|
| **Scope** | Operations + n8n LLMs | Real-time + Advanced RAG + Security |
| **New Files** | 4 | ~12 |
| **Lines of Code** | ~1,750 | ~3,000 |
| **API Endpoints** | 4 | ~8 |
| **Features** | Operations, Workflows, n8n LLMs | Streaming, SSE, Hybrid RAG, API Keys, Caching |
| **Focus** | Consolidation | Enhancement |

---

## Risks & Mitigation

### Risk 1: Redis Dependency
**Risk:** Redis becomes single point of failure
**Mitigation:** Graceful degradation (cache disabled = slower but functional)

### Risk 2: SSE Browser Compatibility
**Risk:** Older browsers don't support EventSource
**Mitigation:** Fallback to polling for unsupported browsers

### Risk 3: Docker Complexity
**Risk:** Docker adds deployment complexity
**Mitigation:** Keep PM2 deployment as primary, Docker as optional alternative

---

## Next Steps: Week 4 Preview

With Week 3 complete, Week 4 could focus on:

1. **Multi-Tenant Support** - Workspace isolation, user permissions
2. **Advanced Analytics** - Custom dashboards, query builder
3. **Workflow Builder** - UI for creating n8n workflows
4. **Mobile App** - React Native chat interface
5. **Plugin System** - Extensibility framework

---

**Status:** 🚀 **READY TO BEGIN**
**Start Date:** 2026-01-06
**Target Completion:** 2026-01-20 (accelerated execution expected)
