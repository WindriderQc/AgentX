# 🚀 Quick Agent Prompt - AgentX Optional Enhancements

**Copy-paste this to your external agent when ready.**

---

## Context

AgentX is **98% complete and production-ready** with 764/770 tests passing (99.2%). All core features implemented. You're working on **optional enhancements** only.

**Previous work you completed:** 81-111 hours across 6 features (workspace integration, RAG citations, RAG compression, scanner fixes).

---

## Project Files Location

```
Repository: /home/yb/codes/AgentX
```

**MUST READ FIRST:**
- `/CLAUDE.md` - Development guide
- `/PROJECT_COMPLETION_2026-01-08.md` - Current status
- `/EXTERNAL_AGENT_PROMPT_FINAL_POLISH.md` - Full specifications

---

## Available Tasks (Choose One)

### Option A: External Notifications (14-20h) ⭐ RECOMMENDED
**Impact:** HIGH - Complete alert delivery infrastructure

**Implement:**
1. Slack webhook delivery with retry logic (4-6h)
2. Email (SMTP) delivery with HTML templates (6-8h)
3. Generic webhook delivery with exponential backoff (4-6h)

**Files:** `/src/services/notificationService.js` (remove placeholders)

**Tests:** Expect 15+ new tests, all must pass

**Deliverables:**
- Real Slack notifications working
- Real email notifications working
- Generic webhooks with retry logic
- Comprehensive test coverage
- Documentation: `/docs/operations/NOTIFICATION_CHANNELS.md`

---

### Option B: Remove CSP 'unsafe-inline' (16-24h)
**Impact:** MEDIUM - Security hardening

**Implement:**
1. Extract all inline styles to CSS files (8-12h)
2. Extract all inline scripts to external JS (8-12h)
3. Update CSP headers in `/src/app.js` (1-2h)

**Success:** No 'unsafe-inline' in CSP, all pages work perfectly

---

### Option C: Streaming Responses (12-16h)
**Impact:** MEDIUM - Better UX for long responses

**Implement:**
1. Server-side SSE streaming (4-6h)
2. Client-side EventSource integration (4-6h)
3. Fix streaming test OOM issues (4-6h)

**Files:**
- `/routes/chat.js` - Add streaming endpoint
- `/public/js/chat.js` - Add EventSource support
- `/tests/routes/chat.stream.*.test.js` - Split and fix

---

### Option D: Custom Dashboard Builder (20-30h)
**Impact:** MEDIUM - Power user feature

**Implement:**
1. Backend: Dashboard model + CRUD APIs (8-10h)
2. Frontend: Drag-and-drop builder (12-20h)

**Deliverables:**
- Users can create custom metric dashboards
- Drag-and-drop widget layout
- Real-time data updates

---

## Quick Start Commands

```bash
# Navigate to project
cd /home/yb/codes/AgentX

# Read core documentation
cat CLAUDE.md
cat PROJECT_COMPLETION_2026-01-08.md

# Run tests to verify environment
npm test

# Run specific test file
npm test -- tests/services/notificationService.test.js

# Start development server
npm start
# Or with PM2:
pm2 restart agentx
```

---

## Code Standards (CRITICAL)

### DO:
- ✅ Follow service-oriented architecture (Routes → Services → Models)
- ✅ Write tests for everything (>80% coverage)
- ✅ Update documentation as you go
- ✅ Use `logger.info/warn/error` (not console.log)
- ✅ Validate all user inputs
- ✅ Handle errors gracefully
- ✅ Update ROADMAP.md when complete

### DON'T:
- ❌ Make breaking changes to existing APIs
- ❌ Skip writing tests (mandatory)
- ❌ Hard-code credentials
- ❌ Modify working features without reason
- ❌ Use console.log
- ❌ Commit .env files

---

## Testing Requirements

**For EVERY task:**
- Unit tests: >80% coverage
- Integration tests: All critical paths
- Manual testing: Happy path + errors
- Browser testing: Chrome, Firefox, Safari (if UI)
- All tests must pass: 100%

**Run tests:**
```bash
npm test                    # All tests
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report
```

---

## Completion Checklist

When done:
- [ ] Feature works as specified
- [ ] All tests passing (100%)
- [ ] Documentation updated
- [ ] ROADMAP.md marked complete
- [ ] No console errors/warnings
- [ ] Security review done
- [ ] Manual testing complete

---

## Report Format

```markdown
## Completion Report: [Task Name]

**Status:** ✅ Complete
**Time:** X hours

### Deliverables:
- [x] Feature implemented
- [x] Tests passing (X/X)
- [x] Documentation updated

### Files Modified:
- /path/to/file.js (description)

### Test Results:
```
Test Suites: X passed
Tests: X passed
```

### Verification:
- All tests pass: ✅
- Manual testing: ✅
- Documentation: ✅
```

---

## Environment Check

Before starting, verify:
```bash
# Node.js 18.x
node --version

# MongoDB connected
mongosh $MONGODB_URI --eval "db.adminCommand({ ping: 1 })"

# Qdrant healthy
curl http://localhost:6333/healthz

# Ollama running
curl http://localhost:11434/api/tags

# Tests passing
npm test
```

---

## Priority Recommendation

**Start with Option A (External Notifications)** - Highest impact, completes core alert infrastructure.

Then do Option B (Remove CSP 'unsafe-inline') - Security hardening.

Options C and D are nice-to-have power features.

---

## Questions?

Read the full spec: `/EXTERNAL_AGENT_PROMPT_FINAL_POLISH.md`

It contains:
- Detailed implementation guides
- Code examples
- Testing requirements
- File structure reference
- Architecture patterns

---

## Remember

- AgentX is **already production-ready** (98% complete)
- All tasks are **optional enhancements**
- **Quality over speed** - tests and docs are mandatory
- **Ask questions** if anything is unclear

---

**Good luck! 🚀**

Repository: `/home/yb/codes/AgentX`
Documentation: Start with `/CLAUDE.md`
