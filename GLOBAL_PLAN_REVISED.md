# AgentX Global Development Plan (REVISED)
## Updated: 2026-01-01 | **FULL OPEN FIRST APPROACH** ✅ APPROVED

---

## 🎯 Development Philosophy

### Full Open First - Approved Strategy

**Approach:** Build all features in an open, accessible system FIRST, then layer security controls once features are stable and validated.

**Rationale:**
- ✅ Faster time to full functionality
- ✅ Earlier user feedback on features
- ✅ Avoid premature optimization for trusted network deployment
- ✅ Security can be added incrementally without blocking features

---

## 📅 Development Phases

### **Phase 1: Full Feature Implementation (Weeks 1-5)**
*Build complete, open system with all user-facing features*

### **Phase 2: Security Hardening (Week 6+)**
*Layer security controls once system is stable*

---

## 🔴 Priority 1: Prompt Management UI (Weeks 1-2)

### Overview
- **Status:** Backend complete, frontend missing
- **Impact:** HIGH - Users need UI to customize prompts
- **Effort:** 2 weeks (40-50 hours)
- **Phase:** 1 (Full Feature Implementation)

### What's Complete ✅
- `/routes/prompts.js` (328 lines) - 7 CRUD endpoints
- `/models/PromptConfig.js` (103 lines) - Versioning, A/B testing
- Template rendering API
- Performance metrics integration

### What's Missing ❌
- Prompt management HTML page
- Prompt editor component (Monaco/CodeMirror)
- A/B test configuration UI (traffic weight sliders)
- Template variable tester
- Performance metrics dashboard
- User onboarding wizard

### Implementation Timeline

**Week 1 (Days 1-5):**
- Days 1-2: UI design, mockups, component architecture
- Days 3-5: Core CRUD functionality (list, create, edit, delete)

**Week 2 (Days 6-10):**
- Days 6-7: A/B testing configuration UI
- Day 8: Template rendering & testing UI
- Days 9-10: Performance dashboard, onboarding wizard

### Key Deliverables
- [ ] `/public/prompts.html` - Main prompt management page
- [ ] `/public/js/prompts.js` - Core UI logic
- [ ] Prompt list with version history
- [ ] Visual A/B test configuration (sliders, validation)
- [ ] Template variable tester with preview
- [ ] Per-prompt performance metrics
- [ ] First-time user onboarding wizard

### Success Metrics
- 90%+ users can create prompts successfully
- 30%+ of prompts use A/B testing
- 70%+ new users complete onboarding
- User satisfaction: 4+ out of 5 stars

---

## 🟡 Priority 2: Analytics Dashboard Expansion (Week 3)

### Overview
- **Status:** 5 endpoints functional, need enhancement
- **Impact:** MEDIUM-HIGH - Better observability
- **Effort:** 1 week (20-25 hours)
- **Phase:** 1 (Full Feature Implementation)

### What's Complete ✅
- `/routes/analytics.js` (563 lines) - 5 endpoints:
  - `GET /api/analytics/usage` - Conversation counts
  - `GET /api/analytics/feedback` - Positive/negative rates
  - `GET /api/analytics/rag-stats` - RAG metrics
  - `GET /api/analytics/stats` - Token usage
  - `GET /api/analytics/feedback/summary` - A/B comparison
- `/public/analytics.html` (18,779 bytes) - Basic visualization
- MongoDB aggregation pipelines

### What's Missing ❌
- Real-time metrics streaming (Server-Sent Events)
- Cost tracking with token pricing
- Advanced visualizations (Chart.js/ApexCharts)
- Model performance comparison table
- CSV export functionality
- Interactive filtering (date ranges)

### Implementation Timeline

**Week 3 (Days 11-15):**
- Days 11-12: Real-time metrics with SSE
- Day 13: Cost tracking implementation
- Days 14-15: Advanced charts, CSV export, model comparison

### Key Deliverables
- [ ] `/routes/analytics-live.js` - SSE endpoint for real-time metrics
- [ ] Real-time dashboard cards (active conversations, RPM, response time)
- [ ] Cost tracking dashboard with projections
- [ ] Interactive charts (time series, model comparison, A/B results)
- [ ] CSV export for all analytics data
- [ ] Model performance comparison table

### Success Metrics
- Real-time metrics latency <1 second
- Dashboard load time <2 seconds
- Analytics API response time <500ms (p95)
- CSV export adoption 20%+ monthly

---

## 🟢 Priority 3: AgentC Integration & MCP Tools (Weeks 4-5)

### Overview
- **Status:** n8n workflows ready, need MCP tools
- **Impact:** MEDIUM - Advanced automation capabilities
- **Effort:** 2 weeks (30-40 hours)
- **Phase:** 1 (Full Feature Implementation)

### What's Complete ✅
- 9 n8n workflow JSONs in `/AgentC/`
- Deployment script: `/scripts/deploy-n8n-workflows.sh`
- n8n instance operational (http://192.168.2.199:5678)
- Webhook endpoints for n8n communication

### What's Missing ❌
- MCP (Model Context Protocol) tool registry
- Core MCP tools (FileSystem, Search, Calculator, DateTime)
- Tool execution sandboxing
- Cloud LLM routing (OpenAI, Anthropic, Google) - OPTIONAL
- Workflow status tracking
- Tool usage logging

### Implementation Timeline

**Week 4 (Days 16-20):**
- Days 16-17: MCP tool registry architecture
- Days 18-20: Core MCP tools (FileSystem, Search, Calculator, DateTime, Weather)

**Week 5 (Days 21-25):**
- Days 21-23: n8n workflow enhancements (status tracking, logging)
- Days 24-25: Cloud LLM routing (OPTIONAL), testing, documentation

### Key Deliverables
- [ ] `/src/services/mcpToolRegistry.js` - Tool registry
- [ ] `/src/tools/FileSystemTool.js` - File operations with permissions
- [ ] `/src/tools/SearchTool.js` - Web search (DuckDuckGo API)
- [ ] `/src/tools/CalculatorTool.js` - Math evaluation
- [ ] `/src/tools/DateTimeTool.js` - Date/time operations
- [ ] `/routes/n8n/webhooks.js` - Enhanced n8n endpoints
- [ ] `/src/services/cloudLLMRouter.js` - Cloud routing (OPTIONAL)
- [ ] Tool execution logs and metrics

### Success Metrics
- MCP tool success rate >95%
- n8n workflow uptime >99%
- Cloud LLM routing accuracy >90% (if implemented)
- Tool response time <2 seconds (p95)

---

## 🔵 Priority 4: Rate Limiting & Security (Week 6+)

### Overview
- **Status:** Dependencies installed, not configured
- **Impact:** MEDIUM - Production hardening for public deployment
- **Effort:** 1 week (20-25 hours)
- **Phase:** 2 (Security Hardening - DEFERRED)

### Rationale for Deferral
This priority is moved to **Phase 2** because:
- System is for trusted network / internal use initially
- Features need validation before restricting access
- Security can be layered on top without refactoring
- express-mongo-sanitize already active (NoSQL injection protection)

### What's Already Protected ✅
- NoSQL injection: `express-mongo-sanitize` ACTIVE
- Custom security headers (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection)
- API key authentication functional
- Session-based auth with MongoDB store

### What's Deferred to Phase 2 ⏸️
- Rate limiting per user/IP
- API endpoint-specific limits
- Helmet configuration (CSP, HSTS)
- API key scopes/permissions
- API key rotation strategy
- Security testing (OWASP ZAP, penetration tests)

### Implementation Timeline (Phase 2)

**Week 6+ (When ready for public deployment):**
- Days 1-2: Rate limiting configuration
- Day 3: Whitelist, monitoring, rate limit headers
- Day 4: Helmet configuration for production
- Day 5: API key enhancement (scopes, rotation)
- Days 6-7: Security testing, documentation

### Key Deliverables (Phase 2)
- [ ] `/src/middleware/rateLimiter.js` - Rate limiting middleware
- [ ] MongoDB-backed rate limit store
- [ ] Per-endpoint rate limits (chat: 20/min, ingest: 10/min)
- [ ] Helmet configuration for production
- [ ] API key management endpoints
- [ ] Security test suite
- [ ] Updated security documentation

---

## 📊 Implementation Timeline Summary

### Phase 1: Full Feature Implementation (Weeks 1-5)

| Week | Priority | Focus | Deliverables |
|------|----------|-------|--------------|
| 1-2 | Priority 1 | Prompt Management UI | Prompt editor, A/B test config, metrics, onboarding |
| 3 | Priority 2 | Analytics Expansion | Real-time metrics, cost tracking, charts, CSV export |
| 4-5 | Priority 3 | AgentC Integration | MCP tools, n8n enhancements, cloud routing (optional) |

**End of Phase 1:** Fully functional system with all user-facing features

### Phase 2: Security Hardening (Week 6+)

| Week | Priority | Focus | Deliverables |
|------|----------|-------|--------------|
| 6+ | Priority 4 | Rate Limiting & Security | Rate limiters, Helmet, API key management, security tests |

**End of Phase 2:** Production-hardened system ready for public deployment

---

## 🎯 Success Criteria

### Phase 1 Completion (Week 5):
- [ ] Users can manage prompts through UI
- [ ] A/B testing adopted by 30%+ of prompts
- [ ] Real-time analytics dashboard functional
- [ ] Cost tracking showing projections
- [ ] 5+ MCP tools operational
- [ ] n8n workflows enhanced with status tracking
- [ ] All features tested and documented
- [ ] User satisfaction >4/5 stars

### Phase 2 Completion (Week 6+):
- [ ] Rate limiting active on all endpoints
- [ ] 0 rate limit bypass incidents
- [ ] Helmet configured and tested
- [ ] API key rotation strategy documented
- [ ] Security scan: 0 high-severity vulnerabilities
- [ ] Load tests pass with rate limiting

---

## 🛠️ Resource Requirements

### Phase 1 (Weeks 1-5)
**Team:**
- Full-stack Developer: 5 weeks full-time (200 hours)
- Frontend Specialist (optional): Weeks 1-2 (80 hours)

**Infrastructure:**
- Existing (no additional cost)

**Total Effort:** 200-280 hours

### Phase 2 (Week 6+)
**Team:**
- Backend Developer: 1 week full-time (40 hours)
- Security Engineer (optional): 2 days review (16 hours)

**Infrastructure:**
- Redis for rate limiting (optional): $20-30/month
- Monitoring tools (optional): Free tier

**Total Effort:** 40-56 hours

---

## ⚠️ Risk Assessment

### Phase 1 Risks

**Low Risk:**
- Prompt UI complexity → Mitigation: Start with MVP, iterate
- SSE connection stability → Mitigation: Reconnection logic
- MCP tools complexity → Mitigation: Start with 5 core tools, expand later

**Very Low Risk:**
- No security hardening during Phase 1 → Acceptable for trusted network deployment

### Phase 2 Risks

**Medium Risk:**
- Rate limiting performance → Mitigation: MongoDB store, consider Redis if needed
- Helmet CSP conflicts → Mitigation: Test thoroughly, adjust CSP directives

---

## 📦 Key Deliverables

### Phase 1 (Weeks 1-5)

**Frontend:**
```
/public/prompts.html
/public/js/prompts.js
/public/js/components/PromptListView.js
/public/js/components/PromptEditorModal.js
/public/js/components/ABTestConfigPanel.js
/public/js/components/TemplateTester.js
/public/js/components/PerformanceMetrics.js
/public/js/components/OnboardingWizard.js
/public/js/analytics/liveMetrics.js
/public/js/analytics/charts.js
/public/js/analytics/costTracking.js
```

**Backend:**
```
/routes/analytics-live.js (SSE endpoint)
/src/services/mcpToolRegistry.js
/src/tools/FileSystemTool.js
/src/tools/SearchTool.js
/src/tools/CalculatorTool.js
/src/tools/DateTimeTool.js
/routes/n8n/webhooks.js (enhanced)
/src/services/cloudLLMRouter.js (optional)
```

**Documentation:**
```
/docs/guides/prompt-management.md
/docs/guides/analytics.md
/docs/guides/mcp-tool-development.md
```

### Phase 2 (Week 6+)

**Backend:**
```
/src/middleware/rateLimiter.js
/routes/admin/api-keys.js
/tests/integration/security.test.js
```

**Documentation:**
```
/docs/guides/rate-limiting.md
/docs/SECURITY_HARDENING.md (updated)
```

---

## 📋 Next Steps

### Immediate (Today):
1. ✅ Review and approve revised plan
2. ✅ Confirm "full open first" approach
3. [ ] Assign developer to Priority 1
4. [ ] Set up project tracking

### Week 1 (Days 1-5):
1. [ ] Begin Priority 1, Phase 1.1: UI Design
2. [ ] Review existing frontend patterns
3. [ ] Create mockups for prompt management
4. [ ] Start implementing core CRUD UI
5. [ ] Daily standups to track progress

### Week 3 (Day 11):
1. [ ] Complete Priority 1 (Prompt UI)
2. [ ] Begin Priority 2 (Analytics Expansion)
3. [ ] Sprint retrospective

### Week 5 (Day 25):
1. [ ] Complete Priority 3 (AgentC Integration)
2. [ ] Phase 1 completion review
3. [ ] User acceptance testing
4. [ ] Decide: Proceed to Phase 2 or iterate on features

### Phase 2 (Week 6+):
1. [ ] Evaluate: Is public deployment needed?
2. [ ] If yes: Begin Priority 4 (Security Hardening)
3. [ ] If no: Defer Phase 2, focus on feature enhancements

---

## 📞 Questions & Support

For clarification on any aspect of this plan:

**Architecture:** How do components fit together?
**Implementation:** How should I build feature X?
**Prioritization:** Should we adjust priorities based on feedback?
**Resources:** Do we need additional team members?
**Timeline:** Are estimates realistic for our team?

I'm available to provide detailed guidance on any area!

---

**Document Version:** 2.0 (Revised for "Full Open First" approach)
**Last Updated:** 2026-01-01
**Approval Status:** ✅ APPROVED
**Next Review:** After Week 2 (Priority 1 completion)
