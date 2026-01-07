# Week 2 Implementation Plan

**Date:** 2026-01-06
**Status:** Ready to Start
**Previous:** Week 1 Complete (100% objectives achieved)

---

## Week 1 Recap ✅

### Completed Objectives (Exceeded Scope)

1. ✅ **Unified Model Catalog** (Initiative 1)
   - Backend: Unified API aggregating Ollama + n8n + Custom + Registry
   - Frontend: Complete models.html redesign with 4 data sources
   - Testing: All endpoints verified

2. ✅ **Feature Alignment Dashboard** (Initiative 3)
   - Tab 1: Feature Inventory (frontend/backend/docs alignment matrix)
   - Tab 2: API Telemetry (endpoint performance tracking)
   - Tab 3: Feature Adoption (user engagement metrics)
   - Tab 4: Admin Controls (feature flags + system actions)
   - Backend: 18 API endpoints, 5 database models
   - Frontend: 4 complete pages with AgentX theme

3. ✅ **chatService Tests**
   - 13/13 tests passing
   - Fixed Mongoose mocking issues
   - Fixed cost calculation test cases

**Week 1 Outcome:** 100% complete + exceeded scope (planned 2 tabs, delivered 4)

---

## Week 2 Objectives

### Primary Goals

**Focus Areas:**
1. **Operations Center Consolidation** (Initiative 2)
2. **n8n LLM Integration** (Initiative 4)
3. **Documentation & Testing Improvements**
4. **Security & Performance Enhancements**

**Success Criteria:**
- Single unified operations dashboard
- n8n webhook LLMs integrated into model catalog
- Comprehensive test coverage (>80% services, >70% routes)
- Security hardening complete

---

## Initiative 2: Operations Center Consolidation

### Problem Statement

**Current State:**
- `dashboard.html` - System health (AgentX, MongoDB, Ollama, DataAPI, n8n, Qdrant)
- `n8n-monitor.html` - n8n-specific monitoring and workflow management

**Issues:**
- **Duplication:** Both pages show n8n health status
- **Fragmentation:** Users must navigate between pages for operations view
- **Inconsistency:** Different health check implementations

### Solution: Unified Operations Dashboard

**Approach:** Merge both dashboards into single `dashboard.html` with tabbed interface

**Tab Structure:**
1. **System Health** (current dashboard.html core)
   - All service health checks (AgentX, MongoDB, Ollama, DataAPI, n8n, Qdrant)
   - System metrics (CPU, memory, disk)
   - Recent activity timeline

2. **n8n Workflows** (current n8n-monitor.html features)
   - Workflow list with status
   - Webhook testing interface
   - Deployment controls
   - Execution history

3. **Metrics Overview** (new)
   - Quick stats from analytics.html
   - Recent alerts
   - Performance summary

### Implementation Tasks

**Day 1-2: Backend API Consolidation**

1. **Health Check Unification**
   - [ ] Review existing health endpoints:
     - `GET /health` (basic)
     - `GET /health/detailed` (comprehensive)
     - n8n-specific health checks
   - [ ] Create unified endpoint: `GET /api/operations/health`
   - [ ] Return structure:
     ```json
     {
       "status": "healthy" | "degraded" | "down",
       "timestamp": "...",
       "services": {
         "agentx": { "status": "up", "uptime": 123456, "version": "1.4.1" },
         "mongodb": { "status": "up", "latency": 5 },
         "ollama": { "status": "up", "models": 7 },
         "dataapi": { "status": "up", "version": "1.2.0" },
         "n8n": { "status": "up", "workflows": 12, "activeExecutions": 3 },
         "qdrant": { "status": "up", "collections": 1, "vectors": 1234 }
       },
       "metrics": {
         "requests24h": 1500,
         "avgLatency": 250,
         "errorRate": 0.5,
         "activeUsers": 25
       }
     }
     ```

2. **n8n Workflow Management API**
   - [ ] Review existing n8n routes
   - [ ] Create: `GET /api/operations/workflows`
   - [ ] Create: `POST /api/operations/workflows/:id/test`
   - [ ] Create: `GET /api/operations/workflows/:id/executions`

3. **Activity Timeline API**
   - [ ] Create: `GET /api/operations/activity`
   - [ ] Aggregate from:
     - ActivityLog (admin actions)
     - Recent API calls (MetricsSnapshot)
     - Recent alerts (Alert)
     - Recent self-healing actions

**Day 3-4: Frontend Consolidation**

4. **Dashboard.html Redesign**
   - [ ] Read current dashboard.html
   - [ ] Read current n8n-monitor.html
   - [ ] Design 3-tab layout:
     - Tab 1: System Health (cards + charts)
     - Tab 2: n8n Workflows (table + controls)
     - Tab 3: Metrics Overview (summary cards)
   - [ ] Implement tab switching
   - [ ] Integrate Chart.js for visualizations
   - [ ] Add auto-refresh (30s interval)

5. **Navigation Update**
   - [ ] Update nav.js to point "Dashboard" to consolidated page
   - [ ] Remove "n8n Monitor" link (functionality merged)
   - [ ] Add breadcrumb navigation within dashboard tabs

6. **Testing & Validation**
   - [ ] Test all health checks
   - [ ] Test workflow management
   - [ ] Test auto-refresh
   - [ ] Test tab switching
   - [ ] Verify no regressions in functionality

**Deliverables:**
- ✅ Unified `dashboard.html` (replacing 2 separate pages)
- ✅ 4 new API endpoints for operations data
- ✅ Archived old n8n-monitor.html (for reference)
- ✅ Updated navigation

---

## Initiative 4: n8n LLM Integration

### Problem Statement

**Current State:**
- Model catalog shows: Ollama models, custom models, registry entries
- Missing: n8n webhook-based LLM sources (OpenAI, Anthropic, Google via n8n)

**Use Case:**
- User has n8n workflows that proxy to cloud LLM APIs
- Want to use these as models in AgentX chat
- Need unified interface to discover and select n8n-provided LLMs

### Solution: Webhook LLM Provider

**Architecture:**
```
User → AgentX Chat → chatService → n8n webhook → Cloud API (OpenAI/Anthropic/Google)
                        ↓
                   Model Selection
                   (Ollama | n8n webhook | Custom)
```

### Implementation Tasks

**Day 5-6: Backend Integration**

1. **n8nLLMProvider Service**
   - [ ] Create: `/src/services/n8nLLMProvider.js`
   - [ ] Features:
     - List available n8n LLM webhooks
     - Proxy chat requests to n8n
     - Handle response parsing (streaming optional)
     - Error handling and retries
   - [ ] Methods:
     ```javascript
     async listModels() // Returns n8n-provided LLMs
     async chat(webhookUrl, messages, options) // Proxy to n8n
     async health(webhookUrl) // Test webhook availability
     ```

2. **n8nLLM Model Registration**
   - [ ] Create: `/models/N8nLLM.js`
   - [ ] Schema:
     ```javascript
     {
       name: String (e.g., "openai-gpt-4o"),
       displayName: String,
       webhookUrl: String (n8n webhook URL),
       provider: String (openai, anthropic, google),
       enabled: Boolean,
       metadata: {
         maxTokens: Number,
         supportsStreaming: Boolean,
         costPer1kTokens: { input: Number, output: Number }
       },
       stats: {
         totalRequests: Number,
         avgLatency: Number,
         lastUsed: Date
       }
     }
     ```

3. **Unified Model Catalog API Enhancement**
   - [ ] Update: `GET /api/models/unified`
   - [ ] Add n8n section to response:
     ```json
     {
       "ollama": [...],
       "custom": [...],
       "registry": [...],
       "n8n": [
         {
           "name": "openai-gpt-4o",
           "displayName": "OpenAI GPT-4o (n8n)",
           "provider": "openai",
           "source": "n8n",
           "webhookUrl": "http://localhost:5678/webhook/...",
           "enabled": true
         }
       ]
     }
     ```

4. **chatService Integration**
   - [ ] Update: `/src/services/chatService.js`
   - [ ] Add n8n routing logic:
     ```javascript
     if (model.source === 'n8n') {
       const n8nProvider = require('./n8nLLMProvider');
       response = await n8nProvider.chat(model.webhookUrl, messages, options);
     }
     ```
   - [ ] Handle n8n-specific response format
   - [ ] Track usage stats for n8n models

**Day 7: Frontend Integration**

5. **Models.html Enhancement**
   - [ ] Add "n8n LLMs" section to unified catalog
   - [ ] Show provider badge (OpenAI, Anthropic, Google)
   - [ ] Add enable/disable toggle
   - [ ] Add "Test Connection" button
   - [ ] Show latency and cost info

6. **Chat Interface Integration**
   - [ ] Update model selector dropdown to include n8n models
   - [ ] Add badge to distinguish n8n models from Ollama
   - [ ] Test chat flow with n8n model selected

**Deliverables:**
- ✅ n8n LLM models integrated into unified catalog
- ✅ Chat interface supports n8n model selection
- ✅ Usage tracking for n8n models
- ✅ Admin UI for managing n8n LLM webhooks

---

## Testing & Quality Improvements

### Test Coverage Goals

**Current Coverage:**
- chatService: 13/13 tests passing ✅
- Other services: Minimal coverage ⚠️

**Target Coverage:**
- Services: >80%
- Routes: >70%
- Helpers: >90%

### Implementation Tasks

**Day 8-9: Test Suite Expansion**

1. **Core Service Tests**
   - [ ] `modelRouter.test.js` - Model routing logic
   - [ ] `ragStore.test.js` - Vector store operations
   - [ ] `embeddings.test.js` - Embedding generation
   - [ ] `costCalculator.test.js` - Cost calculation accuracy
   - [ ] `selfHealingEngine.test.js` - Remediation strategies

2. **Route Tests**
   - [ ] `features.test.js` - Feature Dashboard API
   - [ ] `models.test.js` - Unified model catalog API
   - [ ] `alerts.test.js` - Alert management API

3. **Integration Tests**
   - [ ] End-to-end chat flow (user → model → response)
   - [ ] RAG search → context injection → chat
   - [ ] Model failover scenario
   - [ ] Alert creation → notification delivery

4. **Load Testing**
   - [ ] Update Artillery configs for new endpoints
   - [ ] Run baseline load tests
   - [ ] Document performance thresholds

**Deliverables:**
- ✅ 20+ new test files
- ✅ >80% service coverage
- ✅ >70% route coverage
- ✅ Load test baselines documented

---

## Documentation Improvements

### Tasks

**Day 10: Documentation Cleanup**

1. **User Manual Updates**
   - [ ] Document Feature Dashboard (all 4 tabs)
   - [ ] Document Unified Model Catalog
   - [ ] Document Operations Dashboard (consolidated)
   - [ ] Document n8n LLM Integration

2. **API Documentation**
   - [ ] Update `/api/operations/*` endpoints
   - [ ] Update `/api/models/unified` with n8n section
   - [ ] Update `/api/features/*` endpoints (already have 18)

3. **Architecture Documentation**
   - [ ] Update architecture diagrams
   - [ ] Document n8n integration flow
   - [ ] Document operations consolidation

4. **Archive Old Planning Docs**
   - [ ] Move old planning docs to `docs/archive/`
   - [ ] Update `docs/INDEX.md` to reflect new structure
   - [ ] Verify all cross-references

**Deliverables:**
- ✅ User manual updated (4 new sections)
- ✅ API docs current
- ✅ Architecture docs updated
- ✅ Planning docs archived

---

## Security Hardening

### Priority Tasks (from ROADMAP.md Backlog)

**Day 11-12: Security Improvements**

1. **API Key Scoping**
   - [ ] Review current API key implementation
   - [ ] Add scope/permissions system (read, write, admin)
   - [ ] Implement key rotation mechanism
   - [ ] Add expiration dates for keys

2. **Rate Limiting Review**
   - [ ] Audit current rate limits
   - [ ] Add per-endpoint limits (different limits for read vs write)
   - [ ] Add user-based limits (not just IP-based)
   - [ ] Add Redis-backed rate limiter (optional, for cluster mode)

3. **Audit Logging**
   - [ ] Review ActivityLog usage
   - [ ] Add audit logs for all sensitive operations:
     - Feature flag changes
     - Model deployments
     - System actions (clear telemetry, etc.)
     - Alert rule modifications
   - [ ] Add audit log UI (read-only view)

4. **CSP & Headers**
   - [ ] Review current security headers
   - [ ] Implement strict Content Security Policy
   - [ ] Consider re-enabling Helmet (with LAN-compatible config)
   - [ ] Add HSTS headers (HTTPS only)

5. **Input Validation**
   - [ ] Review all API endpoints for input validation
   - [ ] Add Joi/Zod schemas for request validation
   - [ ] Ensure NoSQL injection prevention is comprehensive
   - [ ] Add file upload validation (if applicable)

**Deliverables:**
- ✅ API key scoping and rotation
- ✅ Enhanced rate limiting
- ✅ Comprehensive audit logging
- ✅ Strict CSP and security headers
- ✅ Input validation for all endpoints

---

## Performance Optimization

### Tasks

**Day 13: Performance Improvements**

1. **Database Optimization**
   - [ ] Review all MongoDB queries
   - [ ] Add missing indexes
   - [ ] Optimize aggregation pipelines
   - [ ] Add query performance monitoring

2. **Caching Strategy**
   - [ ] Review current LRU cache usage (embeddings)
   - [ ] Add Redis cache layer (optional)
   - [ ] Cache health check results (30s TTL)
   - [ ] Cache model listings (5min TTL)

3. **API Response Optimization**
   - [ ] Add compression middleware (gzip/brotli)
   - [ ] Review response payload sizes
   - [ ] Add pagination where missing
   - [ ] Add field selection (sparse fieldsets)

4. **Frontend Optimization**
   - [ ] Minify JS/CSS in production
   - [ ] Add asset versioning for cache busting
   - [ ] Lazy load Chart.js only when needed
   - [ ] Review bundle sizes

**Deliverables:**
- ✅ Database queries optimized
- ✅ Caching strategy implemented
- ✅ API responses compressed
- ✅ Frontend assets optimized

---

## Week 2 Schedule

### Day-by-Day Breakdown

**Days 1-2: Operations Center (Backend)**
- Health check unification
- n8n workflow management API
- Activity timeline API

**Days 3-4: Operations Center (Frontend)**
- Dashboard.html redesign (3 tabs)
- Navigation updates
- Testing & validation

**Days 5-6: n8n LLM Integration (Backend)**
- n8nLLMProvider service
- n8nLLM model registration
- Unified catalog API update
- chatService integration

**Day 7: n8n LLM Integration (Frontend)**
- Models.html enhancement
- Chat interface integration

**Days 8-9: Testing & Quality**
- Core service tests (5+ new test files)
- Route tests (3+ new test files)
- Integration tests
- Load testing

**Day 10: Documentation**
- User manual updates
- API documentation
- Architecture docs
- Archive old planning docs

**Days 11-12: Security Hardening**
- API key scoping
- Rate limiting review
- Audit logging
- CSP & headers
- Input validation

**Day 13: Performance Optimization**
- Database optimization
- Caching strategy
- API response optimization
- Frontend optimization

**Day 14: Week 2 Wrap-up & Testing**
- Full regression testing
- Documentation review
- Deployment preparation
- Week 3 planning

---

## Success Criteria

### Week 2 Complete When:

- [ ] Single unified operations dashboard (dashboard.html)
- [ ] n8n monitor functionality fully merged
- [ ] n8n LLM webhooks integrated into model catalog
- [ ] Chat interface supports n8n model selection
- [ ] Test coverage: >80% services, >70% routes
- [ ] Security hardening complete (API keys, rate limits, audit logs)
- [ ] Performance optimizations applied
- [ ] Documentation fully updated
- [ ] All tests passing
- [ ] PM2 production deployment successful

---

## Risk Assessment

### Potential Blockers

1. **n8n Webhook Complexity**
   - Risk: n8n webhook response formats vary by provider
   - Mitigation: Standardize response format in n8n workflows
   - Fallback: Support multiple response formats with adapters

2. **Operations Dashboard Complexity**
   - Risk: Merging two complex pages may introduce bugs
   - Mitigation: Incremental approach, keep old pages as backup
   - Fallback: Keep n8n-monitor as separate page if merge too complex

3. **Test Coverage Time**
   - Risk: Writing comprehensive tests takes longer than expected
   - Mitigation: Focus on critical paths first
   - Fallback: Continue testing in Week 3

4. **Security Hardening Scope**
   - Risk: Security improvements reveal additional issues
   - Mitigation: Time-box security work to 2 days
   - Fallback: Create security backlog for Week 3

---

## External Agent Participation

### Potential Tasks for External Agent

If external agent wants to continue in Week 2:

**Option 1: Testing Focus**
- Write test suites for core services
- Write integration tests
- Help with load testing

**Option 2: Frontend Enhancement**
- Operations dashboard UI design
- n8n LLM integration frontend
- Chart.js visualizations

**Option 3: Documentation**
- User manual updates
- API documentation
- Tutorial/guide creation

**Option 4: New Feature**
- Advanced analytics features
- Export capabilities
- Real-time updates (WebSocket/SSE)

**Decision Point:** Ask external agent about availability and interest

---

## Carry-Over from Week 1

### Deferred Items

- **Adoption Trend Calculation:** Tab 3 uses simplified mock trends
  - Week 2 Task: Implement real trend calculation based on time-series data

- **System Actions:** Tab 4 has placeholder implementations
  - Week 2 Task: Implement actual scan, export, sync logic

- **Real-Time Updates:** Dashboards require manual refresh
  - Week 3 Task: Add WebSocket/SSE for real-time updates

---

## Week 3 Preview

### Likely Focus Areas

1. **Advanced Features** (from ROADMAP.md backlog)
   - Streaming response support (SSE) for chat
   - Advanced RAG features (query expansion, re-ranking)
   - Custom dashboard builder

2. **Multi-Tenant Support** (if needed)
   - User isolation
   - Workspace concepts
   - Permission system

3. **Deployment & DevOps**
   - Docker containerization
   - CI/CD pipeline
   - Monitoring & observability

---

## References

- **Week 1 Completion:** `/FEATURE_DASHBOARD_INTEGRATION.md`, `/TABS_3_4_INTEGRATION.md`
- **Project Roadmap:** `/ROADMAP.md`
- **Implementation Plan:** `/IMPLEMENTATION_PLAN.md`
- **Test Results:** `/CHATSERVICE_TEST_RESULTS.md`

---

**Status:** Ready to begin Week 2
**Next Step:** Start Day 1 tasks (Operations Center Backend)
