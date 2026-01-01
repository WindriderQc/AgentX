# AgentX Session Plan - 2026-01-01

**Session Goal:** Rapid feature expansion → Testing → Documentation
**Strategy:** Multi-agent parallel execution (AgentB + AgentC workforce)
**Focus:** Phase 3 implementation + rate limiting + analytics expansion

---

## 🎯 SESSION OBJECTIVES

### Primary Goal: Complete Phase 3 (Feedback-Driven Improvement Loop)

**Why:** Enable users to identify and improve underperforming prompts

**Components:**
1. PromptHealthMonitor.js - Alert banner for low-performing prompts
2. ConversationReviewModal.js - View negative conversations
3. PromptImprovementWizard.js - Guided prompt improvement flow
4. Backend: `/api/prompts/:name/analyze-failures` endpoint

### Secondary Goals

1. **Rate Limiting Implementation** - Protect against abuse
2. **Analytics Dashboard Expansion** - Real-time metrics
3. **Security Hardening** - Helmet configuration review
4. **Documentation Updates** - Keep CLAUDE.md current

---

## 🤖 AGENT WORKFORCE

### AgentB: Feature Implementation

**Role:** Implement Phase 3 components rapidly
**Focus:** Frontend components + backend endpoints
**Constraints:**
- Follow existing patterns (OnboardingWizard.js style)
- Use `optionalAuth` middleware
- Create tests but don't run Playwright during development
- Update docs inline

**Assigned Tasks:**
- [ ] Task B1: PromptHealthMonitor component
- [ ] Task B2: ConversationReviewModal component
- [ ] Task B3: Backend analyze-failures endpoint
- [ ] Task B4: PromptImprovementWizard (multi-step)
- [ ] Task B5: Rate limiting middleware implementation

### AgentC: Testing & Validation

**Role:** Verify implementations, write tests, ensure quality
**Focus:** Integration tests, E2E tests, manual validation
**Constraints:**
- Create E2E specs but don't run until requested
- Manual curl testing for APIs
- Validate against existing test patterns
- Document any issues found

**Assigned Tasks:**
- [ ] Task C1: Test Phase 3 components (after B1-B4)
- [ ] Task C2: Validate rate limiting (after B5)
- [ ] Task C3: Integration testing for new endpoints
- [ ] Task C4: Update test documentation
- [ ] Task C5: Regression testing for existing features

---

## 📋 TASK BREAKDOWN

### Phase 3.1: Low-Performing Prompt Alerts (Task B1)

**Component:** `/public/js/components/PromptHealthMonitor.js`

**Spec:**
```javascript
export class PromptHealthMonitor {
  constructor(toast, api) {
    this.toast = toast;
    this.api = api;
    this.threshold = 0.70; // 70% positive rate
    this.minFeedback = 50;
  }

  async loadHealthAlerts() {
    // GET /api/analytics/feedback/summary?sinceDays=7
    // Filter: positiveRate < threshold && totalFeedback > minFeedback
    // Render alert cards
  }

  renderAlertBanner(lowPerformers) {
    // Banner at top of prompts.html
    // Show count + severity indicator
    // Buttons: "Review Conversations" + "Create Improved Version"
  }
}
```

**Integration:**
- Add to `/public/prompts.html` after navigation
- Auto-load on page load
- Refresh on prompt changes

**Testing (Task C1):**
- Create low-performing test prompt with negative feedback
- Verify alert appears
- Test threshold configuration
- Validate button actions

---

### Phase 3.2: Conversation Review Modal (Task B2)

**Component:** `/public/js/components/ConversationReviewModal.js`

**Spec:**
```javascript
export class ConversationReviewModal {
  async open(promptName, promptVersion) {
    // GET /api/dataset/conversations?promptName=X&promptVersion=Y&feedback=negative&limit=20
    // Show modal with conversation list
  }

  renderConversation(conv) {
    // Message-by-message display
    // Highlight feedback indicators
    // Show metadata (model, RAG used, timestamp)
  }

  exportToJSON(conversations) {
    // Download as {promptName}_v{version}_negative_{timestamp}.json
  }
}
```

**Features:**
- Filter tabs: All / This Week / Last 30 Days
- Sort by: Date / Rating / Message Count
- Export button
- "Analyze with LLM" button (triggers next component)

**Testing (Task C1):**
- Create conversations with negative feedback
- Verify filtering works
- Test export functionality
- Validate modal styling

---

### Phase 3.3: Backend Analyze Endpoint (Task B3)

**Route:** `POST /api/prompts/:name/analyze-failures`

**Implementation:** `/routes/prompts.js`

**Spec:**
```javascript
router.post('/:name/analyze-failures', optionalAuth, async (req, res) => {
  try {
    const { version, limit = 20 } = req.body;

    // 1. Fetch negative conversations
    const conversations = await Conversation.find({
      promptName: req.params.name,
      promptVersion: version,
      'messages.feedback.rating': -1
    }).limit(limit).lean();

    // 2. Extract patterns (common errors, topics, response issues)
    const patterns = analyzeFailurePatterns(conversations);

    // 3. Call Ollama to suggest improvements
    const analysis = await callOllamaForAnalysis(
      currentPrompt.systemPrompt,
      patterns,
      conversations.slice(0, 5) // Sample
    );

    // 4. Return structured response
    res.json({
      status: 'success',
      data: {
        currentPrompt: currentPrompt.systemPrompt,
        failurePatterns: patterns,
        suggestedPrompt: analysis.suggestedPrompt,
        reasoning: analysis.reasoning,
        conversationsAnalyzed: conversations.length
      }
    });
  } catch (error) {
    logger.error('Analyze failures error', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});
```

**Helper Functions:**
```javascript
function analyzeFailurePatterns(conversations) {
  // Extract:
  // - Common user intents that failed
  // - Response characteristics (too short, too long, off-topic)
  // - Model used (any patterns?)
  // - RAG used/not used
  return { patterns: [...], summary: '...' };
}

async function callOllamaForAnalysis(currentPrompt, patterns, samples) {
  // Construct analysis prompt for Ollama
  // Request: Analyze failures + suggest improvements
  // Return structured response
}
```

**Testing (Task C2):**
- Create endpoint test with mock data
- Verify Ollama integration
- Test error handling
- Validate response format

---

### Phase 3.4: Prompt Improvement Wizard (Task B4)

**Component:** `/public/js/components/PromptImprovementWizard.js`

**Multi-Step Flow:**

**Step 1: Analyze Failures**
- Show loading state
- Call `POST /api/prompts/:name/analyze-failures`
- Display failure patterns summary
- Button: "Next: View Suggestions"

**Step 2: Review Suggestions**
- Show current prompt (left)
- Show suggested prompt (right)
- Highlight differences (use PromptVersionCompare diff algorithm)
- Reasoning explanation
- Buttons: "Reject" | "Customize" | "Accept & Create Version"

**Step 3: Customize Prompt (optional)**
- Editable textarea with suggested prompt pre-filled
- Live character count
- Preview button (test with sample query)
- Buttons: "Back" | "Create New Version"

**Step 4: Configure A/B Test (optional)**
- "Run A/B test?" checkbox
- Traffic split slider (20/80 default)
- Duration estimate
- Buttons: "Skip" | "Create with A/B Test"

**Step 5: Confirmation**
- Summary of changes
- New version number
- A/B test config (if enabled)
- Button: "Done" (broadcasts `prompt-version-changed` event)

**Integration:**
- Triggered from PromptHealthMonitor alert button
- Or from "Improve This Prompt" button on prompts.html
- Reuses PromptVersionCompare styles

**Testing (Task C1):**
- Full wizard flow test
- Each step validation
- A/B test configuration
- Event broadcasting

---

### Phase 3.5: Rate Limiting Implementation (Task B5)

**Middleware:** `/src/middleware/rateLimiter.js`

**Spec:**
```javascript
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis'); // Optional: for multi-worker

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: { status: 'error', message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Optional: Use Redis for cluster mode
  // store: new RedisStore({ client: redisClient })
});

// Strict limit for expensive operations
const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: { status: 'error', message: 'Rate limit exceeded. Please wait before retrying.' }
});

// Chat endpoint limit (per user)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 messages per minute
  keyGenerator: (req) => req.session?.userId || req.ip
});

module.exports = { apiLimiter, strictLimiter, chatLimiter };
```

**Integration:** `/src/app.js`
```javascript
const { apiLimiter, strictLimiter, chatLimiter } = require('./middleware/rateLimiter');

// Apply to routes
app.use('/api/', apiLimiter); // General API
app.use('/api/chat', chatLimiter); // Chat specific
app.use('/api/rag/ingest', strictLimiter); // Expensive operations
app.use('/api/prompts/:name/analyze-failures', strictLimiter);
```

**Configuration:** `.env`
```bash
# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_CHAT_MAX=20       # per minute
RATE_LIMIT_STRICT_MAX=10     # per minute
```

**Testing (Task C2):**
- Automated rate limit test script
- Verify headers (RateLimit-*)
- Test per-user vs per-IP
- Multi-worker scenario (if using PM2)

---

## 🔄 WORKFLOW

### Phase 1: Launch Workforce (Parallel)

**Action 1: Start AgentB on Task B1**
```
Prompt: "Implement Phase 3.1 PromptHealthMonitor component following the spec in SESSION_PLAN_2026-01-01.md. Use OnboardingWizard.js as pattern reference. Create component file, integrate into prompts.html, test manually."
```

**Action 2: Start AgentC on Documentation Review**
```
Prompt: "Review CLAUDE.md and SESSION_CHECKPOINT_2026-01-01.md. Identify any outdated information or missing documentation for Phase 2 work. Prepare update suggestions."
```

### Phase 2: Sequential Implementation

**After B1 Complete:**
- AgentC: Test B1 (Task C1)
- AgentB: Start B2 (ConversationReviewModal)

**After B2 Complete:**
- AgentC: Test B2 (Task C1)
- AgentB: Start B3 (Backend endpoint)

**After B3 Complete:**
- AgentC: Test B3 (Task C2)
- AgentB: Start B4 (Improvement Wizard)

**After B4 Complete:**
- AgentC: Full Phase 3 integration test (Task C1)
- AgentB: Start B5 (Rate limiting)

**After B5 Complete:**
- AgentC: Rate limit testing (Task C2)
- AgentC: Full regression test (Task C5)

### Phase 3: Finalization

1. Run full test suite: `npm test`
2. Manual UI walkthrough
3. Update CLAUDE.md with Phase 3 status
4. Create git commit with Phase 3 changes
5. Update session checkpoint document
6. Push to remote

---

## 📊 SUCCESS CRITERIA

### Phase 3 Complete When:

- [ ] PromptHealthMonitor shows alerts for low-performing prompts
- [ ] Clicking "Review Conversations" opens ConversationReviewModal
- [ ] Modal shows negative conversations with filters
- [ ] "Analyze with LLM" button triggers backend analysis
- [ ] Backend endpoint returns structured failure analysis
- [ ] PromptImprovementWizard opens with multi-step flow
- [ ] Users can customize and create new prompt versions
- [ ] Optional A/B test configuration works
- [ ] New prompt version created and activated
- [ ] All components follow established patterns
- [ ] Manual testing confirms functionality
- [ ] E2E test specs created (don't run during dev)

### Rate Limiting Complete When:

- [ ] Middleware created and configured
- [ ] Applied to appropriate routes
- [ ] Environment variables documented
- [ ] Rate limit headers present in responses
- [ ] Exceeding limits returns proper error
- [ ] Per-user and per-IP limiting works
- [ ] Test script validates behavior

### Session Complete When:

- [ ] All Phase 3 tasks implemented
- [ ] Rate limiting active
- [ ] All tests passing (`npm test`)
- [ ] Documentation updated
- [ ] Git committed and pushed
- [ ] Session checkpoint document created

---

## 🔧 DEVELOPMENT COMMANDS

### Start Server
```bash
npm start  # or pm2 reload ecosystem.config.js
```

### Testing
```bash
npm test                 # Unit tests (run before commit)
npm run test:e2e         # E2E tests (create specs, run at end)
npm run test:coverage    # Coverage report
```

### Manual Testing
```bash
# Frontend
http://localhost:3080/prompts.html

# Backend endpoints
curl http://localhost:3080/api/analytics/feedback/summary?sinceDays=7 | jq
curl -X POST http://localhost:3080/api/prompts/default_chat/analyze-failures \
  -H "Content-Type: application/json" \
  -d '{"version":1,"limit":20}' | jq
```

### PM2 Management
```bash
pm2 status
pm2 logs agentx --lines 50
pm2 reload ecosystem.config.js --update-env
pm2 save
```

---

## 📝 GIT WORKFLOW

### Commit Strategy

**After each major component:**
```bash
git add -A
git commit -m "✨ Implement Phase 3.X: [Component Name]"
```

**Example commits for this session:**
- `✨ Implement Phase 3.1: PromptHealthMonitor component`
- `✨ Implement Phase 3.2: ConversationReviewModal`
- `✨ Add analyze-failures endpoint for prompt improvement`
- `✨ Implement Phase 3.4: PromptImprovementWizard`
- `🔒 Add rate limiting middleware to API routes`
- `✅ Add Phase 3 integration tests`
- `📝 Update documentation for Phase 3 completion`

---

## 🚨 KNOWN CONSTRAINTS

### From Previous Session

1. **Playwright Performance**: "stay minimal on this playwright usage as it slow down code progress a lot!!!"
   - **Solution**: Create E2E specs but don't run until end of session

2. **PM2 Cluster Mode**: In-memory state not shared across workers
   - **Solution**: Rate limiting should use Redis store for production (optional for dev)

3. **Authentication**: Using `optionalAuth` for backward compatibility
   - **Reminder**: Don't change to `requireAuth` without user approval

4. **Port 9323 Mystery**: Likely Claude Code internal communication
   - **Action**: No action needed, not interfering

---

## 📊 METRICS TO TRACK

### Development Velocity
- Components implemented per hour
- Test coverage maintained (>80%)
- Documentation updates inline

### Code Quality
- No new linting errors
- All existing tests still passing
- Follows established patterns

### Feature Completeness
- All Phase 3.1-3.4 components functional
- Rate limiting active and tested
- Documentation reflects current state

---

## 🎯 POST-SESSION DELIVERABLES

1. **Working Code**
   - Phase 3 components fully functional
   - Rate limiting middleware active
   - All tests passing

2. **Documentation**
   - CLAUDE.md updated with Phase 3 status
   - Session checkpoint document created
   - API docs updated (if new endpoints)

3. **Tests**
   - Unit tests for new helpers
   - Integration tests for endpoints
   - E2E specs for UI components

4. **Git History**
   - Clean commit messages
   - All work pushed to remote
   - No uncommitted changes

---

## 🔄 NEXT SESSION PREVIEW

### Phase 4 Options (TBD)

1. **n8n Workflow Deployment**
   - Deploy feedback analysis workflows
   - Automated prompt monitoring
   - Alert notifications

2. **Analytics Dashboard Expansion**
   - Real-time metrics
   - Cost tracking
   - Model performance comparison

3. **Security Hardening**
   - Helmet configuration review
   - Input validation audit
   - Security headers optimization

4. **AgentC Integration (MCP + Cloud AI)**
   - Review AgentC directory plan
   - Define MCP tool requirements
   - Cloud AI use case analysis

**Decision Point**: User will choose priority for next session

---

## 📞 QUICK REFERENCE

### Key Files for This Session

**Frontend:**
- `/public/js/components/PromptHealthMonitor.js` (new)
- `/public/js/components/ConversationReviewModal.js` (new)
- `/public/js/components/PromptImprovementWizard.js` (new)
- `/public/prompts.html` (modify)
- `/public/css/prompts.css` (add styles)

**Backend:**
- `/routes/prompts.js` (add analyze-failures endpoint)
- `/src/middleware/rateLimiter.js` (new)
- `/src/app.js` (integrate rate limiting)

**Testing:**
- `/tests/integration/phase3.test.js` (new)
- `/tests/e2e/prompt-improvement.spec.js` (new)

**Documentation:**
- `/CLAUDE.md` (update)
- `/docs/SESSION_CHECKPOINT_2026-01-01.md` (create)
- `/docs/features/Phase-3-Feedback-Loop.md` (new)

### Critical Patterns

**Modal Pattern:** Follow `OnboardingWizard.js`
**API Pattern:** Use `/routes/prompts.js` conventions
**Error Handling:** Use logger + structured responses
**Testing:** Create specs, manual test, unit test helpers

---

**END OF SESSION PLAN** 🏁
