# AgentX Global Development Plan
## Updated: 2026-01-01

This document provides a comprehensive roadmap for AgentX development, based on codebase analysis and architecture review.

---

## Executive Summary

**Current State:** AgentX is a **production-ready, well-architected local AI assistant** with:
- ✅ Complete RAG system (V3) with dual vector store backends
- ✅ Service-oriented architecture with 11 core services
- ✅ 40+ API endpoints across 14 route files
- ✅ Comprehensive testing (13 test files, 2,235 lines)
- ✅ 17,393 lines of documentation across 60+ files
- ✅ PM2 cluster mode deployment with CI/CD

**Critical Gaps:**
1. 🔴 **Priority 1:** Prompt Management UI (backend complete, frontend missing)
2. 🔴 **Priority 2:** Rate Limiting & Security (dependencies installed, not configured)
3. 🟡 **Priority 3:** Analytics Dashboard Expansion (5 endpoints exist, need enhancement)
4. 🟢 **Priority 4:** AgentC Integration Strategy (workflows ready, MCP tools integration needed)

**Overall Assessment:** System is 85% complete for production use. Remaining 15% focuses on user experience (prompt management UI) and security hardening (rate limiting).

---

## Development Priorities

### 🔴 Priority 1: Prompt Management UI (WEEKS 1-2)
**Status:** Backend complete, frontend missing
**Impact:** HIGH - Users cannot customize prompts through interface
**Effort:** 2 weeks (40-50 hours)

#### Current State
✅ **Backend (Complete):**
- `/routes/prompts.js` (328 lines) - 7 CRUD endpoints
- `/models/PromptConfig.js` (103 lines) - Versioning, A/B testing, traffic weights
- `getActive()` static method with weighted random selection
- Template rendering with Handlebars-like syntax

❌ **Frontend (Missing):**
- No HTML/JS files for prompt management
- No visual A/B test configuration
- No user onboarding flow
- No prompt performance dashboard

#### Implementation Plan

**Phase 1.1: UI Design & Architecture (Days 1-2)**
- [ ] Review existing frontend patterns in `/public/analytics.html` and `/public/dashboard.html`
- [ ] Design mockups for prompt management interface (wireframes)
- [ ] Define UI components:
  - Prompt list/gallery view (all versions grouped by name)
  - Prompt editor (Monaco or CodeMirror for systemPrompt editing)
  - A/B test configuration panel (traffic weight sliders)
  - Performance metrics cards (impressions, positive rate, feedback)
  - Template variable tester (render preview)
- [ ] Plan state management (vanilla JS vs lightweight framework)

**Phase 1.2: Core Prompt Management (Days 3-5)**
- [ ] Create `/public/prompts.html` - Main prompt management page
- [ ] Create `/public/js/prompts.js` - Core logic
- [ ] Implement API client wrapper for prompt endpoints
- [ ] Build prompt list view with grouping by `name`
- [ ] Implement version history display
- [ ] Add create prompt form (name, systemPrompt, description, author)
- [ ] Add edit metadata modal (description, tags, only for inactive prompts)
- [ ] Implement delete confirmation (only for inactive prompts)

**Phase 1.3: A/B Testing Configuration (Days 6-7)**
- [ ] Design traffic weight distribution UI (sliders with visual bar)
- [ ] Implement `POST /api/prompts/:name/ab-test` integration
- [ ] Add real-time validation (weights must sum to 100)
- [ ] Show current active versions and their weights
- [ ] Add "quick rollback" feature (deactivate all except one version)

**Phase 1.4: Template Rendering & Testing (Day 8)**
- [ ] Build template variable tester UI
- [ ] Implement `POST /api/prompts/render` integration
- [ ] Add variable input form (dynamic based on detected placeholders)
- [ ] Show rendered output preview
- [ ] Add copy-to-clipboard functionality

**Phase 1.5: Performance Dashboard Integration (Days 9-10)**
- [ ] Connect to existing `/api/analytics/feedback/summary` endpoint
- [ ] Display per-prompt metrics:
  - Total impressions
  - Positive rate (positiveCount / (positiveCount + negativeCount))
  - Recent trend (last 7 days vs previous 7 days)
- [ ] Add visual indicators for low performers (< 70% positive rate)
- [ ] Link to analytics page for detailed breakdown

**Phase 1.6: User Onboarding Flow (Days 11-12)**
- [ ] Create first-time user wizard (modal on chat interface load)
- [ ] Guide user through:
  1. Select or create initial prompt
  2. Test prompt with sample queries
  3. Set user profile preferences
- [ ] Add "skip for now" option with reminder banner
- [ ] Store onboarding completion flag in UserProfile

**Phase 1.7: Integration & Polish (Days 13-14)**
- [ ] Add navigation link to prompts page from dashboard
- [ ] Implement responsive design (mobile-friendly)
- [ ] Add loading states and error handling
- [ ] Write user documentation (`/docs/guides/prompt-management.md`)
- [ ] Add help tooltips and inline guidance
- [ ] Test with real users, gather feedback

#### Acceptance Criteria
- [ ] Users can view all prompt versions grouped by name
- [ ] Users can create new prompt versions
- [ ] Users can configure A/B tests with traffic weights
- [ ] Users can preview template rendering
- [ ] Users can see per-prompt performance metrics
- [ ] New users receive onboarding guidance
- [ ] UI is responsive and works on mobile devices
- [ ] All frontend code has error handling and loading states

#### Testing Strategy
- [ ] Manual testing of all CRUD operations
- [ ] A/B test weight validation edge cases (sum to 100)
- [ ] Template rendering with various variable types
- [ ] Cross-browser testing (Chrome, Firefox, Safari)
- [ ] Mobile responsiveness testing
- [ ] Integration test: Create → Edit → A/B Test → Delete workflow

---

### 🔴 Priority 2: Rate Limiting & Security Hardening (WEEK 3)
**Status:** Dependencies installed, not configured
**Impact:** HIGH - Production deployment vulnerability
**Effort:** 1 week (20-25 hours)

#### Current State
✅ **Implemented:**
- `express-mongo-sanitize`: ACTIVE at `/src/app.js:48-57`
- Custom security headers (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection)
- API key authentication (`/src/middleware/auth.js`)

⚠️ **Partially Implemented:**
- `helmet`: INSTALLED but DISABLED (line 26: "removed for local network compatibility")

❌ **Not Implemented:**
- `express-rate-limit`: NOT CONFIGURED
- Per-user rate limiting
- Per-IP rate limiting
- API endpoint-specific limits

#### Implementation Plan

**Phase 2.1: Rate Limiting Configuration (Days 1-2)**
- [ ] Review production traffic patterns (if available)
- [ ] Define rate limit tiers:
  - **Anonymous/IP-based:** 10 requests/minute per IP
  - **Authenticated users:** 60 requests/minute per user
  - **API key clients (n8n):** 300 requests/minute
  - **Admin users:** 1000 requests/minute
- [ ] Create `/src/middleware/rateLimiter.js`
- [ ] Implement rate limit store selection:
  - Development: MemoryStore
  - Production: MongoDB store (connect-mongo-rate-limit)
- [ ] Configure global rate limiter
- [ ] Configure endpoint-specific rate limiters:
  - `/api/chat/*` - 20 req/min (expensive LLM calls)
  - `/api/rag/ingest` - 10 req/min (expensive embedding operations)
  - `/api/analytics/*` - 60 req/min (read-heavy, less expensive)

**Phase 2.2: Advanced Rate Limiting (Day 3)**
- [ ] Implement skip functions for whitelisted IPs
- [ ] Add custom key generators (user ID vs IP vs API key)
- [ ] Implement rate limit response headers (X-RateLimit-*)
- [ ] Add rate limit exceeded logging
- [ ] Create rate limit metrics for monitoring

**Phase 2.3: Helmet Re-evaluation (Day 4)**
- [ ] Test helmet with current frontend (check for CSP issues)
- [ ] Configure helmet for local network compatibility:
  ```javascript
  helmet({
    contentSecurityPolicy: false, // Or custom CSP if needed
    crossOriginEmbedderPolicy: false // For local network
  })
  ```
- [ ] Test in both development and production modes
- [ ] Document helmet configuration in SECURITY_HARDENING.md

**Phase 2.4: API Key Enhancement (Day 5)**
- [ ] Implement API key rotation strategy
- [ ] Create `/api/admin/api-keys` management endpoint
- [ ] Add API key scopes/permissions (e.g., read-only, ingest-only, full-access)
- [ ] Store API keys securely (hashed with bcrypt)
- [ ] Add API key expiration dates
- [ ] Implement API key usage tracking

**Phase 2.5: Testing & Documentation (Days 6-7)**
- [ ] Write integration tests for rate limiting:
  - Test limit enforcement (exceed limits, verify 429 responses)
  - Test different user tiers
  - Test skip functions
  - Test rate limit headers
- [ ] Write security tests:
  - NoSQL injection attempts (verify sanitization)
  - XSS attempts (verify header protection)
  - CSRF attempts (verify token validation)
- [ ] Update `/docs/SECURITY_HARDENING.md` with new configurations
- [ ] Document rate limit tiers and configuration
- [ ] Create security incident response playbook

#### Acceptance Criteria
- [ ] Rate limiting active for all API endpoints
- [ ] Different rate limits enforced per user tier
- [ ] Rate limit headers included in responses
- [ ] Helmet re-enabled with appropriate configuration
- [ ] API key rotation strategy documented and implemented
- [ ] Security tests pass with 100% coverage of attack vectors
- [ ] Documentation updated with security best practices

#### Testing Strategy
- [ ] Integration tests for rate limiting (all tiers)
- [ ] Load testing with Artillery to verify limits
- [ ] Security audit using tools like OWASP ZAP
- [ ] Penetration testing (manual or automated)
- [ ] Test rate limit bypass attempts

---

### 🟡 Priority 3: Analytics Dashboard Expansion (WEEK 4)
**Status:** 5 endpoints exist, dashboard needs enhancement
**Impact:** MEDIUM - Improves observability and decision-making
**Effort:** 1 week (20-25 hours)

#### Current State
✅ **Implemented:**
- `/routes/analytics.js` (563 lines) - 5 functional endpoints
- `/public/analytics.html` (18,779 bytes) - Basic visualization
- MongoDB aggregation pipelines for metrics

#### Implementation Plan

**Phase 3.1: Real-Time Metrics (Days 1-2)**
- [ ] Implement Server-Sent Events (SSE) for live metrics
- [ ] Create `/api/analytics/live` endpoint
- [ ] Stream metrics every 5 seconds:
  - Active conversations count
  - Requests per minute (RPM)
  - Average response time (last 5 min)
  - Current model distribution
- [ ] Update frontend to display live metrics cards
- [ ] Add sparkline charts for trends

**Phase 3.2: Cost Tracking (Day 3)**
- [ ] Define token pricing per model (configurable via env vars)
- [ ] Calculate costs in analytics queries:
  - Total tokens × price per 1M tokens
  - Breakdown by model
  - Breakdown by user (optional)
- [ ] Add cost projections (current month, next month)
- [ ] Create budget alerts (when exceeding threshold)

**Phase 3.3: Advanced Visualizations (Days 4-5)**
- [ ] Integrate lightweight charting library (Chart.js or ApexCharts)
- [ ] Add charts:
  - **Time series:** Requests over time (hourly, daily, weekly)
  - **Model comparison:** Performance metrics by model
  - **A/B test results:** Prompt version comparison
  - **RAG impact:** With RAG vs without RAG metrics
  - **User engagement:** Active users over time
- [ ] Add interactive filters (date range, model, prompt version)
- [ ] Implement CSV export for all charts

**Phase 3.4: Model Performance Comparison (Day 6)**
- [ ] Create `/api/analytics/model-comparison` endpoint
- [ ] Aggregate metrics per model:
  - Average response time
  - Average tokens per response
  - Positive feedback rate
  - Error rate
- [ ] Build comparison table UI
- [ ] Add sorting and filtering

**Phase 3.5: Testing & Documentation (Day 7)**
- [ ] Write integration tests for new endpoints
- [ ] Test SSE connection stability (reconnection logic)
- [ ] Document analytics API in `/docs/api/reference.md`
- [ ] Create analytics user guide (`/docs/guides/analytics.md`)
- [ ] Add dashboard tour for first-time users

#### Acceptance Criteria
- [ ] Real-time metrics stream via SSE
- [ ] Cost tracking with projections and alerts
- [ ] Interactive charts with filtering and export
- [ ] Model performance comparison table
- [ ] All new endpoints tested and documented

---

### 🟢 Priority 4: AgentC Integration Strategy (WEEKS 5-6)
**Status:** Workflows ready, MCP tools integration needed
**Impact:** MEDIUM - Enables advanced automation and agent capabilities
**Effort:** 2 weeks (30-40 hours)

#### Current State
✅ **Implemented:**
- 9 n8n workflow JSONs version-controlled in `/AgentC/`
- Deployment script: `/scripts/deploy-n8n-workflows.sh`
- n8n instance: http://192.168.2.199:5678

#### Implementation Plan

**Phase 4.1: MCP Tools Architecture (Days 1-3)**
- [ ] Research Model Context Protocol (MCP) specification
- [ ] Design MCP tool integration architecture:
  - Tool registry pattern
  - Tool discovery mechanism
  - Tool execution sandboxing
  - Tool result formatting
- [ ] Define standard tool interface:
  ```javascript
  interface MCPTool {
    name: string;
    description: string;
    parameters: ToolParameters;
    execute(params: any): Promise<ToolResult>;
  }
  ```
- [ ] Create `/src/services/mcpToolRegistry.js`
- [ ] Document MCP tool development guide

**Phase 4.2: Core MCP Tools Implementation (Days 4-6)**
- [ ] Implement foundational tools:
  - **FileSystemTool:** Read/write files with permission checks
  - **SearchTool:** Web search integration (DuckDuckGo API)
  - **CalculatorTool:** Math evaluation with safe-eval
  - **DateTimeTool:** Date/time operations and formatting
  - **WeatherTool:** Weather API integration (if needed)
- [ ] Create `/src/tools/` directory with tool implementations
- [ ] Add tool execution to chatService.js (tool calling flow)
- [ ] Implement tool result injection into conversation

**Phase 4.3: n8n Workflow Integration (Days 7-9)**
- [ ] Create n8n webhook endpoints for each workflow:
  - `/api/n8n/health-check` (N1.1)
  - `/api/n8n/ops-diagnostic` (N1.3)
  - `/api/n8n/nas-scan` (N2.1, N2.2)
  - `/api/n8n/rag-ingest` (N2.3)
  - `/api/n8n/model-monitor` (N3.1)
  - `/api/n8n/ai-query` (N3.2)
  - `/api/n8n/feedback-analysis` (N5.1)
- [ ] Implement bidirectional communication (AgentX ↔ n8n)
- [ ] Add workflow status tracking (queued, running, completed, failed)
- [ ] Create workflow execution logs

**Phase 4.4: Cloud AI LLM Integration (Days 10-12)**
- [ ] Design cloud LLM routing strategy:
  - When to use cloud vs local (task complexity, latency requirements)
  - Fallback mechanisms (cloud → local or vice versa)
- [ ] Implement cloud LLM clients:
  - **OpenAI:** GPT-4, GPT-4 Turbo
  - **Anthropic:** Claude 3 Opus, Claude 3.5 Sonnet
  - **Google:** Gemini Pro
- [ ] Add cloud LLM routing to modelRouter.js
- [ ] Implement cost tracking for cloud API calls
- [ ] Add cloud usage quotas and alerts

**Phase 4.5: Testing & Documentation (Days 13-14)**
- [ ] Write integration tests for MCP tools
- [ ] Write integration tests for n8n workflows
- [ ] Test cloud LLM routing and fallback
- [ ] Document MCP tool development guide
- [ ] Document n8n integration patterns
- [ ] Create cloud LLM configuration guide
- [ ] Update AgentC README with integration details

#### Acceptance Criteria
- [ ] MCP tool registry implemented with 5+ core tools
- [ ] n8n workflows callable via API endpoints
- [ ] Cloud LLM routing functional with fallback
- [ ] All integrations tested and documented
- [ ] Cost tracking includes cloud API usage

---

## Implementation Timeline

### Week 1-2: Prompt Management UI (Priority 1)
**Focus:** User experience and prompt customization

| Day | Tasks | Owner | Status |
|-----|-------|-------|--------|
| 1-2 | UI design, architecture, mockups | TBD | ⚪ Not Started |
| 3-5 | Core CRUD functionality | TBD | ⚪ Not Started |
| 6-7 | A/B testing configuration | TBD | ⚪ Not Started |
| 8 | Template rendering & testing | TBD | ⚪ Not Started |
| 9-10 | Performance dashboard integration | TBD | ⚪ Not Started |
| 11-12 | User onboarding flow | TBD | ⚪ Not Started |
| 13-14 | Integration, polish, documentation | TBD | ⚪ Not Started |

### Week 3: Rate Limiting & Security (Priority 2)
**Focus:** Production readiness and security hardening

| Day | Tasks | Owner | Status |
|-----|-------|-------|--------|
| 1-2 | Rate limiting configuration | TBD | ⚪ Not Started |
| 3 | Advanced rate limiting features | TBD | ⚪ Not Started |
| 4 | Helmet re-evaluation | TBD | ⚪ Not Started |
| 5 | API key enhancement | TBD | ⚪ Not Started |
| 6-7 | Testing & documentation | TBD | ⚪ Not Started |

### Week 4: Analytics Dashboard Expansion (Priority 3)
**Focus:** Observability and insights

| Day | Tasks | Owner | Status |
|-----|-------|-------|--------|
| 1-2 | Real-time metrics with SSE | TBD | ⚪ Not Started |
| 3 | Cost tracking implementation | TBD | ⚪ Not Started |
| 4-5 | Advanced visualizations | TBD | ⚪ Not Started |
| 6 | Model performance comparison | TBD | ⚪ Not Started |
| 7 | Testing & documentation | TBD | ⚪ Not Started |

### Week 5-6: AgentC Integration (Priority 4)
**Focus:** Advanced automation and agent capabilities

| Day | Tasks | Owner | Status |
|-----|-------|-------|--------|
| 1-3 | MCP tools architecture | TBD | ⚪ Not Started |
| 4-6 | Core MCP tools implementation | TBD | ⚪ Not Started |
| 7-9 | n8n workflow integration | TBD | ⚪ Not Started |
| 10-12 | Cloud AI LLM integration | TBD | ⚪ Not Started |
| 13-14 | Testing & documentation | TBD | ⚪ Not Started |

---

## Resource Requirements

### Development Team
- **Full-stack Developer** (Primary): 6 weeks full-time
- **Frontend Specialist** (Weeks 1-2): 2 weeks full-time for prompt UI
- **Security Engineer** (Week 3): 1 week part-time for security review
- **DevOps Engineer** (Week 6): 3 days for deployment and monitoring setup

### Infrastructure
- **Development:**
  - Local development environment (existing)
  - MongoDB instance (existing)
  - Ollama instances (existing)
  - Qdrant instance (existing)

- **Testing:**
  - Staging environment (if not exists, need to provision)
  - Load testing infrastructure (Artillery on separate machine)

- **Production:**
  - PM2 cluster (existing)
  - Monitoring tools (need to add: Prometheus + Grafana OR simple Node.js monitoring)
  - Backup strategy for MongoDB + Qdrant (need to implement)

### Third-Party Services
- **Optional Cloud LLM APIs:**
  - OpenAI API account (if implementing cloud routing)
  - Anthropic API account (if implementing cloud routing)
  - Budget: $200-500/month for initial testing

- **Monitoring (Optional):**
  - Sentry for error tracking (free tier available)
  - Uptime monitoring service (UptimeRobot free tier)

---

## Risk Assessment

### High-Risk Items
1. **Prompt UI Complexity** (Priority 1)
   - Risk: UI/UX design may require iterations based on user feedback
   - Mitigation: Start with MVP, gather feedback early, iterate in sprints
   - Contingency: +3 days for redesign if needed

2. **Rate Limiting Performance** (Priority 2)
   - Risk: MongoDB-based rate limit store may introduce latency
   - Mitigation: Benchmark with load tests, consider Redis if needed
   - Contingency: Budget for Redis instance ($20-30/month)

3. **MCP Tools Security** (Priority 4)
   - Risk: Tool execution may introduce security vulnerabilities
   - Mitigation: Sandboxed execution, strict input validation, permission checks
   - Contingency: Security audit by external expert ($500-1000)

### Medium-Risk Items
1. **SSE Connection Stability** (Priority 3)
   - Risk: Server-Sent Events may disconnect frequently
   - Mitigation: Implement reconnection logic with exponential backoff
   - Contingency: +1 day for robust reconnection implementation

2. **Cloud LLM API Costs** (Priority 4)
   - Risk: Unexpected costs from cloud LLM usage
   - Mitigation: Hard quotas, usage alerts, cost tracking dashboard
   - Contingency: Budget buffer of $200/month for overage

---

## Success Metrics

### Priority 1: Prompt Management UI
- [ ] 90%+ users can successfully create and configure prompts (user testing)
- [ ] A/B test adoption rate: 30%+ of prompts use multiple versions
- [ ] Onboarding completion rate: 70%+ of new users complete wizard
- [ ] User satisfaction: 4+ out of 5 stars (feedback survey)

### Priority 2: Rate Limiting & Security
- [ ] 0 rate limit bypass incidents in production
- [ ] Rate limit overhead: <50ms additional latency
- [ ] Security scan (OWASP ZAP): 0 high-severity vulnerabilities
- [ ] API key rotation compliance: 100% of keys rotated within 90 days

### Priority 3: Analytics Dashboard
- [ ] Real-time metrics latency: <1 second from event to display
- [ ] Dashboard load time: <2 seconds
- [ ] Analytics API response time: <500ms (p95)
- [ ] CSV export adoption: 20%+ of users export data monthly

### Priority 4: AgentC Integration
- [ ] MCP tool success rate: >95% (successful executions / total attempts)
- [ ] n8n workflow uptime: >99%
- [ ] Cloud LLM routing accuracy: >90% (correct model selected)
- [ ] Cloud LLM cost efficiency: <30% premium vs local execution

---

## Post-Implementation Plan

### Week 7: Production Deployment
- [ ] Deploy to staging environment
- [ ] Run full test suite (integration + load + security)
- [ ] Conduct user acceptance testing (UAT)
- [ ] Deploy to production with blue-green strategy
- [ ] Monitor for 48 hours post-deployment
- [ ] Document deployment procedure

### Week 8: Monitoring & Optimization
- [ ] Set up monitoring dashboards (Grafana or custom)
- [ ] Configure alerts (error rates, latency, rate limits)
- [ ] Analyze production metrics
- [ ] Identify optimization opportunities
- [ ] Create performance tuning backlog

### Week 9+: Maintenance & Enhancement
- [ ] Bug fixes from production feedback
- [ ] User-requested features backlog
- [ ] Regular security updates (monthly)
- [ ] Performance optimization (quarterly)
- [ ] Documentation updates (ongoing)

---

## Appendix A: File Structure Reference

### New Files to Create

**Priority 1: Prompt Management UI**
```
/public/prompts.html                          # Main prompt management page
/public/js/prompts.js                         # Core prompt UI logic
/public/js/components/promptEditor.js         # Prompt editor component
/public/js/components/abTestConfig.js         # A/B test configuration
/public/js/components/templateTester.js       # Template rendering tester
/docs/guides/prompt-management.md             # User guide
```

**Priority 2: Rate Limiting & Security**
```
/src/middleware/rateLimiter.js                # Rate limiting middleware
/routes/admin/api-keys.js                     # API key management endpoints
/tests/integration/security.test.js           # Security tests
/docs/SECURITY_HARDENING.md (update)          # Updated security guide
/docs/guides/rate-limiting.md                 # Rate limiting configuration guide
```

**Priority 3: Analytics Dashboard**
```
/routes/analytics-live.js                     # SSE endpoint for real-time metrics
/public/js/analytics/liveMetrics.js           # Live metrics UI component
/public/js/analytics/charts.js                # Chart rendering logic
/public/js/analytics/costTracking.js          # Cost tracking UI
/docs/guides/analytics.md                     # Analytics user guide
```

**Priority 4: AgentC Integration**
```
/src/services/mcpToolRegistry.js              # MCP tool registry
/src/tools/FileSystemTool.js                  # File system MCP tool
/src/tools/SearchTool.js                      # Web search MCP tool
/src/tools/CalculatorTool.js                  # Calculator MCP tool
/routes/n8n/webhooks.js                       # n8n webhook endpoints
/src/services/cloudLLMRouter.js               # Cloud LLM routing service
/docs/guides/mcp-tool-development.md          # MCP tool development guide
/docs/guides/cloud-llm-configuration.md       # Cloud LLM setup guide
```

---

## Appendix B: Decision Log

### 2026-01-01: Initial Plan Creation
- **Decision:** Prioritize prompt management UI over analytics expansion
- **Rationale:** User experience and customization is critical for adoption. Backend is complete, frontend is blocking users.
- **Trade-off:** Delays analytics enhancements but unblocks 100% of users for prompt customization

### 2026-01-01: Rate Limiting Strategy
- **Decision:** Use MongoDB for rate limit store in production
- **Rationale:** Consistency with existing architecture, no new dependencies
- **Trade-off:** Potential latency vs Redis, but simpler deployment

### 2026-01-01: MCP Tools Scope
- **Decision:** Start with 5 core tools, expand based on usage
- **Rationale:** Validate integration architecture before scaling
- **Trade-off:** Limited tool set initially, but lower risk

---

## Appendix C: Contact & Escalation

### Project Stakeholders
- **Product Owner:** TBD
- **Technical Lead:** TBD
- **DevOps Lead:** TBD

### Escalation Path
1. **Technical Issues:** Technical Lead → Architecture Review
2. **Resource Constraints:** Product Owner → Reprioritization
3. **Security Concerns:** Security Engineer → Immediate review + hold deployment

### Communication Channels
- **Daily Standups:** TBD
- **Weekly Status Updates:** TBD
- **Project Tracking:** GitHub Issues/Projects (or alternative)

---

**Document Version:** 1.0
**Last Updated:** 2026-01-01
**Next Review:** After Week 2 (Priority 1 completion)
