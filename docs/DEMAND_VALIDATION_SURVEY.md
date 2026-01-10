# Demand Validation Survey: Voice API & Workflow Generator UIs

**Date:** 2026-01-07
**Purpose:** Validate user demand for building UIs for two deferred headless features
**Target Audience:** AgentX users, n8n workflow creators, development team
**Estimated Completion Time:** 5-10 minutes

---

## Survey Context

AgentX currently has **two headless features** (API-only, no UI) that scored medium priority in our feature alignment analysis:

1. **Voice API (70 points)** - Speech-to-text, text-to-speech, voice chat
2. **Workflow Generator (70 points)** - AI-powered n8n workflow creation

We're deciding whether to build user interfaces for these features. Your feedback will directly influence our development roadmap.

---

## Part 1: Respondent Profile

### 1. What is your role?

- ☐ Developer / Engineer
- ☐ Product Manager / Business Analyst
- ☐ Data Scientist / ML Engineer
- ☐ DevOps / SRE
- ☐ Designer
- ☐ Other: __________________

### 2. How often do you use AgentX?

- ☐ Daily
- ☐ Several times per week
- ☐ Weekly
- ☐ Monthly
- ☐ Rarely
- ☐ I'm evaluating AgentX but not a regular user yet

### 3. Which AgentX features do you use most? (Select all that apply)

- ☐ Chat interface
- ☐ Model management
- ☐ Benchmarking
- ☐ RAG (document ingestion)
- ☐ Custom models
- ☐ Analytics dashboards
- ☐ Workspace collaboration
- ☐ n8n workflow integration
- ☐ API access (programmatic)
- ☐ Other: __________________

---

## Part 2: Voice API Demand Assessment

### Current Voice API Capabilities (Headless)

The Voice API provides:
- **Speech-to-Text:** Convert audio files to text (`POST /api/voice/transcribe`)
- **Text-to-Speech:** Convert text to audio files (`POST /api/voice/synthesize`)
- **Voice Chat:** End-to-end voice conversation with LLM (`POST /api/voice/chat`)

**Current Access:** API-only (requires curl, Postman, or custom code)

---

### 4. Have you used the Voice API endpoints? (API-only)

- ☐ Yes, I use them regularly
- ☐ Yes, I've tried them a few times
- ☐ No, but I know they exist
- ☐ No, I didn't know AgentX had voice capabilities

**If No:** Skip to Question 7

---

### 5. How do you currently access the Voice API?

- ☐ Direct API calls (curl, Postman)
- ☐ n8n workflows
- ☐ Custom code/scripts (Python, Node.js, etc.)
- ☐ I haven't used it yet
- ☐ Other: __________________

---

### 6. What challenges have you faced using the Voice API?

- ☐ Setting up authentication
- ☐ Handling audio file formats
- ☐ Understanding API request/response structure
- ☐ No challenges - API works fine
- ☐ Too complex for non-developers to use
- ☐ Hard to test/debug without UI
- ☐ Other: __________________

---

### 7. Would a Voice UI be valuable to you?

**Scale:** 1 = Not at all valuable, 5 = Extremely valuable

**Rating:** ☐ 1  ☐ 2  ☐ 3  ☐ 4  ☐ 5

---

### 8. Which Voice UI features would you use? (Select all that apply)

- ☐ **Microphone recording** - Record audio directly in browser
- ☐ **File upload** - Upload audio files for transcription
- ☐ **Live transcription** - See text appear as you speak
- ☐ **Text-to-speech player** - Type text, hear it spoken
- ☐ **Voice chat** - Push-to-talk conversation with LLM
- ☐ **Conversation history** - Save/replay voice chats
- ☐ **Voice selection** - Choose different voices (if supported)
- ☐ None - I'm fine with API-only access

---

### 9. What would you use a Voice UI for? (Select all that apply)

- ☐ Accessibility (for users with disabilities)
- ☐ Hands-free interaction (driving, cooking, multitasking)
- ☐ Meeting transcription
- ☐ Language learning / pronunciation
- ☐ Voice memo transcription
- ☐ Prototyping voice-enabled applications
- ☐ Demo/presentation purposes
- ☐ Testing voice capabilities before API integration
- ☐ Other: __________________
- ☐ I wouldn't use it

---

### 10. How important is mobile support for Voice UI?

- ☐ Critical - I'd primarily use it on mobile
- ☐ Important - I'd use both mobile and desktop
- ☐ Nice to have - Desktop is sufficient
- ☐ Not important - Desktop only is fine

---

### 11. What's your preference for Voice API access?

- ☐ **Build the UI** - I would use a web interface
- ☐ **Keep API-only** - I prefer programmatic access
- ☐ **Both** - UI for testing, API for production use
- ☐ **No opinion** - I don't use voice features

---

### 12. Additional Voice UI feedback:

**What features are missing? What would make it more useful?**

________________________________________________________
________________________________________________________
________________________________________________________

---

## Part 3: Workflow Generator Demand Assessment

### Current Workflow Generator Capabilities (Headless)

The Workflow Generator provides:
- **Generate Workflow:** Describe workflow in natural language, get n8n JSON (`POST /api/workflow/generate`)
- **Validate Workflow:** Check n8n workflow JSON for errors (`POST /api/workflow/validate`)
- **Deploy Workflow:** Push workflow to n8n instance (`POST /api/workflow/deploy`)
- **Example Library:** Browse pre-built workflow templates (`GET /api/workflow/examples`)

**Current Access:** API-only (requires API client or n8n integration)

---

### 13. Have you used the Workflow Generator API?

- ☐ Yes, I use it regularly
- ☐ Yes, I've tried it a few times
- ☐ No, but I know it exists
- ☐ No, I didn't know AgentX had workflow generation

**If No:** Skip to Question 16

---

### 14. How do you currently access the Workflow Generator API?

- ☐ Direct API calls (curl, Postman)
- ☐ Custom scripts (Python, Node.js)
- ☐ Integrated into my own tools
- ☐ I haven't used it yet
- ☐ Other: __________________

---

### 15. What challenges have you faced with Workflow Generator API?

- ☐ Hard to describe workflows in natural language
- ☐ Generated workflows need significant editing
- ☐ Easier to build workflows directly in n8n UI
- ☐ Validation errors unclear
- ☐ Deployment process complex
- ☐ No challenges - API works fine
- ☐ Other: __________________

---

### 16. Would a Workflow Generator UI be valuable to you?

**Scale:** 1 = Not at all valuable, 5 = Extremely valuable

**Rating:** ☐ 1  ☐ 2  ☐ 3  ☐ 4  ☐ 5

---

### 17. Which Workflow Generator UI features would you use? (Select all that apply)

- ☐ **Natural language prompt** - "Create workflow that sends alerts to Slack"
- ☐ **Visual workflow preview** - See generated workflow before deploying
- ☐ **Template gallery** - Browse/search pre-built workflows
- ☐ **One-click deploy** - Deploy to n8n from UI
- ☐ **Validation feedback** - Visual error messages
- ☐ **Edit in n8n** - Open generated workflow in n8n for refinement
- ☐ **Workflow versioning** - Save/compare different generations
- ☐ None - I'm fine with API-only access

---

### 18. How do you currently create n8n workflows?

- ☐ Manually in n8n UI (drag-and-drop)
- ☐ Write JSON manually
- ☐ Copy/modify existing workflows
- ☐ Use Workflow Generator API
- ☐ I don't create n8n workflows
- ☐ Other: __________________

---

### 19. What would make AI workflow generation more useful?

- ☐ Better prompt understanding (less ambiguity)
- ☐ Support for complex multi-step workflows
- ☐ Integration with n8n node library (use specific nodes)
- ☐ Learning from my existing workflows (personalization)
- ☐ Workflow templates for common use cases
- ☐ Explanation of generated workflow logic
- ☐ Comparison with similar workflows
- ☐ Other: __________________

---

### 20. What's your preference for Workflow Generator access?

- ☐ **Build the UI** - I would use a web interface
- ☐ **Keep API-only** - I prefer programmatic access
- ☐ **Both** - UI for prototyping, API for automation
- ☐ **No opinion** - I don't use workflow generation
- ☐ **Not needed** - n8n UI is sufficient

---

### 21. Additional Workflow Generator feedback:

**What features are missing? What would make it more useful?**

________________________________________________________
________________________________________________________
________________________________________________________

---

## Part 4: Prioritization

### 22. If we can only build ONE of these UIs, which should we prioritize?

- ☐ Voice UI (speech-to-text, text-to-speech, voice chat)
- ☐ Workflow Generator UI (AI-powered n8n workflow creation)
- ☐ Neither - focus on other features instead
- ☐ Both are equally important

**Why?**

________________________________________________________
________________________________________________________

---

### 23. What other headless features (API-only) would you like UIs for?

**List any AgentX APIs that are hard to use without a UI:**

________________________________________________________
________________________________________________________
________________________________________________________

---

### 24. What new features (not currently in AgentX) would you like to see?

**Top 3 feature requests:**

1. ________________________________________________________
2. ________________________________________________________
3. ________________________________________________________

---

## Part 5: Effort vs. Value Assessment

### Context: Development Effort Estimates

- **Voice UI:** 12-16 hours (complex: audio handling, browser permissions, mobile support)
- **Workflow Generator UI:** 10-14 hours (medium: JSON editor, n8n API integration, template gallery)

---

### 25. Given the effort required, which statements do you agree with?

**Voice UI:**
- ☐ Worth building - the value justifies 12-16 hours of development
- ☐ Maybe worth building - depends on quality/features
- ☐ Not worth it - effort too high for expected value
- ☐ No opinion

**Workflow Generator UI:**
- ☐ Worth building - the value justifies 10-14 hours of development
- ☐ Maybe worth building - depends on quality/features
- ☐ Not worth it - effort too high for expected value
- ☐ No opinion

---

### 26. Would you be willing to beta test these UIs if built?

- ☐ Yes - Voice UI
- ☐ Yes - Workflow Generator UI
- ☐ Yes - Both
- ☐ No - I'm not interested
- ☐ Maybe - depends on features

**If Yes, contact email:** __________________

---

## Part 6: Open Feedback

### 27. Any additional comments or suggestions?

**General feedback on AgentX, feature priorities, or anything else:**

________________________________________________________
________________________________________________________
________________________________________________________
________________________________________________________
________________________________________________________

---

## Survey Results Analysis (For Internal Use)

### Scoring Methodology

**Voice UI Priority Score:**
```
Score = (Avg Q7 rating × 20) + (Q8 selections × 2) + (Q9 selections × 3) + (Q11 preference × 15)
Range: 0-150 points
Threshold: ≥75 points = Build UI
```

**Workflow Generator UI Priority Score:**
```
Score = (Avg Q16 rating × 20) + (Q17 selections × 2) + (Q19 selections × 2) + (Q20 preference × 15)
Range: 0-140 points
Threshold: ≥70 points = Build UI
```

### Decision Matrix

| Feature | Priority Score | User Demand | Effort | Decision |
|---------|---------------|-------------|--------|----------|
| Voice UI | __/150 | High/Med/Low | 12-16h | Build/Defer/Cancel |
| Workflow Gen | __/140 | High/Med/Low | 10-14h | Build/Defer/Cancel |

### Key Insights

**Voice UI:**
- **Primary Use Cases:** ____________________
- **Target Users:** ____________________
- **Blockers:** ____________________
- **Recommendation:** ____________________

**Workflow Generator UI:**
- **Primary Use Cases:** ____________________
- **Target Users:** ____________________
- **Blockers:** ____________________
- **Recommendation:** ____________________

---

## Distribution Plan

### Survey Distribution Channels

1. **Email** - Send to AgentX user list
2. **In-App Banner** - Show on dashboard for 1 week
3. **Slack/Discord** - Post in community channels
4. **GitHub Discussions** - Create discussion thread
5. **Team Meeting** - Present during sprint planning

### Target Response Count

- **Minimum:** 10 responses (small user base)
- **Target:** 25 responses (representative sample)
- **Ideal:** 50+ responses (high confidence)

### Timeline

- **Week 1:** Distribute survey, collect responses
- **Week 2:** Analyze results, create summary report
- **Week 3:** Present findings, make build/defer decision
- **Week 4:** Begin development (if approved) or close out

---

## Next Actions

**After Survey Completion:**

1. **Analyze Results**
   - Calculate priority scores
   - Identify patterns in feedback
   - Compare with scanner priority scores (70 points each)

2. **Create Summary Report**
   - Executive summary with recommendation
   - User quotes and key insights
   - Effort vs. value analysis

3. **Make Decision**
   - Build both UIs (if high demand)
   - Build Voice UI only (if higher priority)
   - Build Workflow Generator only (if higher priority)
   - Defer both (if low demand)

4. **Update ROADMAP.md**
   - Document decision rationale
   - Add to backlog or active sprint
   - Communicate to users

---

**Survey Version:** 1.0
**Created:** 2026-01-07
**Owner:** AgentX Product Team
**Status:** Ready for Distribution
