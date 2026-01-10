# Primary Agent Coordination Plan

**Role:** Coordination and Validation Lead
**Purpose:** Orchestrate CLAUDE.md refactoring, validate results, execute Phase 2 follow-up
**Agent:** Primary Claude instance (you)

---

## Mission Overview

Coordinate multi-agent execution of:
1. CLAUDE.md refactoring (External Agent)
2. Validation and integration (You)
3. Phase 2 follow-up tasks (You + Sub-agents)

**Timeline:** 3-4 hours total

---

## Phase 1: Launch External Agent for Refactoring

### 1.1 Provide External Agent with Complete Spec

**Task Prompt:** `/EXTERNAL_AGENT_CLAUDE_MD_REFACTORING.md`

**Key Context to Include:**
- Task: Refactor CLAUDE.md from 1,263 → 358 lines
- Spec: 6 phases (pre-refactoring → finalization)
- Validation: Line ranges are accurate, conflicts identified
- Deliverables: 12 new files, updated CLAUDE.md, updated INDEX.md, commit ready

**Launch Command:**
```
External Agent: Execute CLAUDE.md refactoring following EXTERNAL_AGENT_CLAUDE_MD_REFACTORING.md

Success criteria:
- CLAUDE.md is 300-400 lines
- All 12 files created with proper headers
- 0 broken links
- Zero information loss
- Single atomic commit ready
```

**Expected Duration:** 2 hours

### 1.2 Monitor Progress (Optional)

If external agent provides progress updates:
- Validate each phase checkpoint
- Verify file creation after Phase 2
- Check line counts after Phase 3
- Confirm validation results after Phase 5

---

## Phase 2: Validate External Agent Work

### 2.1 Read Deliverables

**Critical Files to Check:**

1. **New CLAUDE.md** (`/home/yb/codes/AgentX/CLAUDE.md`)
   - Line count: 300-400 range?
   - Documentation hub present?
   - Links formatted correctly?

2. **Extracted Files (12 total):**
   - `/docs/architecture/MULTI_TENANCY.md`
   - `/docs/architecture/MODEL_REGISTRY.md`
   - `/docs/architecture/RAG_SYSTEM.md`
   - `/docs/architecture/MODEL_ROUTING.md`
   - `/docs/architecture/STARTUP_SEQUENCE.md`
   - `/docs/integrations/N8N_WORKFLOWS.md`
   - `/docs/patterns/CRITICAL_CONVENTIONS.md`
   - `/docs/patterns/TESTING_PATTERNS.md`
   - `/docs/operations/AUTHENTICATION.md`
   - `/docs/operations/RESPONSE_HANDLING.md`
   - `/docs/operations/BENCHMARK_SYSTEM.md`
   - `/docs/operations/CRITICAL_GOTCHAS.md`

3. **Updated INDEX.md** (`/docs/INDEX.md`)
   - New sections added?
   - Links correct?

4. **Refactoring Report** (`/REFACTORING_REPORT.md`)
   - Metrics documented?
   - Validation results present?

### 2.2 Run Validation Checks

**Execute validation script:**
```bash
# Check if script exists
ls -la /home/yb/codes/AgentX/scripts/validate-docs-links.sh

# Run validation
/home/yb/codes/AgentX/scripts/validate-docs-links.sh

# Expected output: "✓ All links valid"
```

**Manual validation:**
```bash
# Line count verification
wc -l /home/yb/codes/AgentX/CLAUDE.md
# Expected: 300-400 lines

# Check all files created
ls -1 /home/yb/codes/AgentX/docs/architecture/*.md
ls -1 /home/yb/codes/AgentX/docs/integrations/*.md
ls -1 /home/yb/codes/AgentX/docs/patterns/*.md
ls -1 /home/yb/codes/AgentX/docs/operations/*.md
# Expected: 12 files total

# Verify backup exists
ls -la /tmp/CLAUDE_BACKUP.md
```

### 2.3 Test Agent Navigation

**Manual navigation test:**

1. **Start from CLAUDE.md:**
   - Read first 50 lines
   - Verify documentation hub links present
   - Click through to 2-3 extracted docs (Read tool)
   - Confirm content makes sense

2. **Start from docs/INDEX.md:**
   - Read new sections (Architecture, Integrations, Patterns, Operations)
   - Verify all 12 files linked
   - Test 1-2 links (Read tool)

3. **Test cross-references:**
   - Read MULTI_TENANCY.md
   - Find "Related Documentation" section
   - Verify links to Backend Overview, API Reference, etc. exist

**Acceptance Criteria:**
- [ ] Can navigate from CLAUDE.md → any extracted doc
- [ ] Can navigate from docs/INDEX.md → any extracted doc
- [ ] Related documentation links work
- [ ] No 404s or missing files

### 2.4 Approve or Request Fixes

**If all validations pass:**
```
✅ Refactoring approved!

Results:
- CLAUDE.md: [X] lines (within 300-400)
- Files created: 12/12
- Broken links: 0
- Navigation: Functional
- Commit: Ready for merge

Proceed to Phase 3.
```

**If issues found:**
```
⚠️ Issues detected:

1. [Issue description]
   - Expected: [X]
   - Actual: [Y]
   - Fix required: [Z]

2. [Issue description]
   ...

Request external agent to address issues before proceeding.
```

---

## Phase 3: Execute Phase 2 Follow-Up Tasks

### 3.1 Get User Priority

**Ask user:**
```
CLAUDE.md refactoring complete! ✅

Phase 2 follow-up tasks available:

A. User Acceptance Testing (UAT)
   - Test invitation acceptance UI (10 scenarios)
   - Deliverable: Bug report or sign-off
   - Time: 1-2 hours

B. Demand Validation Survey
   - Distribute survey for voice/workflow UIs
   - Collect 20-30 responses (1 week)
   - Time: 1 hour distribution + 1 hour analysis

C. Low-Confidence Feature Review
   - Review 21 "very low" confidence features
   - Determine scanner gaps vs unused
   - Time: 2-3 hours

D. Frontend Signal Investigation
   - Analyze why avg confidence only 34.6/100
   - Identify detection patterns scanner misses
   - Time: 2-3 hours

Which task should I execute first? (A/B/C/D)
```

**User response determines next action.**

### 3.2 Task A: User Acceptance Testing

**If user chooses Task A:**

**Your Actions:**

1. **Read UAT guide:**
   - `/UAT_INVITATION_ACCEPTANCE.md`
   - Understand 10 test scenarios

2. **Execute tests manually or coordinate with user:**
   - Scenario 1: Valid token → Accept
   - Scenario 2: Valid token → Decline
   - Scenario 3: Invalid token → Error
   - Scenario 4: Expired token → Error
   - Scenario 5: Already member → Error
   - Scenario 6: Not logged in → Auth flow
   - Scenario 7: Mobile responsive
   - Scenario 8: Accessibility
   - Scenario 9: Performance
   - Scenario 10: Security

3. **Document results:**
   - If bugs found: Create bug report in `/docs/bugs/agentx/`
   - If no bugs: Create sign-off document

4. **Deliverable:**
   ```markdown
   # UAT Results: Invitation Acceptance UI

   **Date:** [Date]
   **Tester:** [Your agent ID]
   **Status:** [PASS / ISSUES FOUND]

   ## Test Results

   | Scenario | Status | Notes |
   |----------|--------|-------|
   | 1. Valid Accept | ✅ | [Details] |
   | 2. Valid Decline | ✅ | [Details] |
   | ... | ... | ... |

   ## Bugs Found

   [List bugs or "None"]

   ## Sign-off

   [✅ Approved for production] or [⚠️ Bugs must be fixed first]
   ```

### 3.3 Task B: Demand Validation Survey

**If user chooses Task B:**

**Your Actions:**

1. **Read survey:**
   - `/DEMAND_VALIDATION_SURVEY.md`
   - 27 questions, 6 sections

2. **Prepare distribution strategy:**
   ```markdown
   # Survey Distribution Plan

   **Survey:** Voice API & Workflow Generator Demand Validation

   **Target Audience:**
   - n8n power users (existing integration users)
   - Voice API prospects (users who mentioned voice in feedback)
   - Workflow automation users

   **Distribution Channels:**
   - Email to active users (if user list available)
   - In-app notification (banner on dashboard)
   - Community forum post
   - Slack/Discord announcement

   **Timeline:**
   - Distribute: [Date]
   - Close: [Date + 1 week]
   - Analyze: [Date + 1 week + 1 day]

   **Target Responses:** 20-30

   **Decision Thresholds:**
   - Voice API: ≥75/150 = build
   - Workflow Generator: ≥70/140 = build
   ```

3. **Coordinate with user:**
   - Ask: "Do you have user email list for survey distribution?"
   - Ask: "Preferred distribution method? (Email / In-app / Forum)"

4. **After responses collected (1 week later):**
   - Calculate scores
   - Analyze responses
   - Make build/defer recommendations

### 3.4 Task C: Low-Confidence Feature Review

**If user chooses Task C:**

**Your Actions:**

1. **Launch sub-agent for investigation:**
   - Provide: `/SUBAGENT_PROMPT_PHASE2_INVESTIGATION.md`
   - Task: Option A (review 21 features)
   - Expected deliverable: Analysis report with categorization

2. **Review sub-agent findings:**
   - Scanner gaps: How many?
   - Genuinely unused: How many?
   - Documented headless: How many?

3. **Create action plan based on findings:**
   ```markdown
   # Low-Confidence Feature Review: Action Plan

   **Findings Summary:**
   - Scanner Gaps: X features (need detection improvements)
   - Genuinely Unused: X features (deprecation candidates)
   - Documented Headless: X features (update confidence criteria)
   - False Negatives: X features (re-assign)

   **Actions Required:**

   1. **Scanner Improvements (Priority: HIGH)**
      - Implement: [Detection methods identified]
      - Expected impact: +X confidence points
      - Effort: X hours

   2. **Deprecation Candidates (Priority: MEDIUM)**
      - Review: [List endpoints]
      - Verify: No usage in last 3 months
      - Deprecate: Create deprecation plan

   3. **Re-assignments (Priority: LOW)**
      - Fix: [List mis-assigned features]
      - Update: Feature mapping in scanner
      - Re-scan: Verify improved assignment
   ```

4. **Deliverable:** Action plan + sub-agent report

### 3.5 Task D: Frontend Signal Investigation

**If user chooses Task D:**

**Your Actions:**

1. **Launch sub-agent for investigation:**
   - Provide: `/SUBAGENT_PROMPT_PHASE2_INVESTIGATION.md`
   - Task: Option B (investigate frontend signals)
   - Expected deliverable: Investigation report with patterns

2. **Review sub-agent findings:**
   - Root causes: Dynamic construction? Helper abstraction?
   - Pattern analysis: What % each cause?
   - Recommendations: Detection strategies?

3. **Prioritize recommendations:**
   ```markdown
   # Frontend Signal Investigation: Implementation Plan

   **Root Cause Analysis:**
   - Dynamic path construction: X% of cases
   - Helper abstraction: X% of cases
   - Config indirection: X% of cases

   **Implementation Priority:**

   **Phase 1 (High Priority):**
   1. Template Literal Detection
      - Tool: Babel AST parser
      - Pattern: Match /api/${var}
      - Effort: 2-3 hours
      - Impact: +15-20 confidence points

   2. API Helper Mapping
      - Create: /scripts/api-helper-map.json
      - Document: API.method() → endpoint
      - Effort: 1-2 hours
      - Impact: +10-15 confidence points

   **Phase 2 (Medium Priority):**
   3. Config Constant Extraction
      - Parse: /public/js/config.js
      - Build: constant → endpoint map
      - Effort: 2-3 hours
      - Impact: +5-10 confidence points

   **Expected Outcome:**
   - Average confidence: 34.6 → 55-65
   - Detection coverage: ~35% → ~60%
   ```

4. **Deliverable:** Implementation plan + sub-agent report

---

## Phase 4: Documentation and Handoff

### 4.1 Update Progress Tracking

**Files to update:**

1. **ROADMAP.md:**
   - Mark CLAUDE.md refactoring complete
   - Add Phase 2 task completion status
   - Update "Current State" section

2. **docs/INDEX.md:**
   - Verify all new sections present
   - Add any new documentation from Phase 2

3. **TRACK_8_PHASE_2_PROGRESS.md:**
   - Add refactoring completion
   - Add Phase 2 task results

### 4.2 Create Session Summary

```markdown
# Session Summary: CLAUDE.md Refactoring + Phase 2

**Date:** [Date]
**Duration:** [X hours]

## Accomplishments

### Part 1: CLAUDE.md Refactoring ✅

- Reduced CLAUDE.md from 1,263 → 358 lines (72% reduction)
- Created 12 new documentation files
- Updated docs/INDEX.md with 4 new sections
- Zero information loss, zero broken links
- Commit ready for merge

**Metrics:**
- Files created: 12
- Directories added: 3
- Line count: 1,263 → 358 (-905 lines)
- Broken links: 0
- Validation: PASS

### Part 2: Phase 2 Follow-Up

**Task Executed:** [A/B/C/D]

**Results:**
- [Summary of task results]
- [Deliverables created]
- [Next steps identified]

## Agent Coordination

- **External Agent:** CLAUDE.md refactoring (2 hours)
  - Success rate: 100%
  - Issues: [None / List]

- **Sub-Agent:** [Task C or D if executed]
  - Analysis: [Summary]
  - Recommendations: [Count]

- **Primary Agent:** Coordination, validation, execution
  - Validations: PASS
  - Documentation: Updated

## Next Steps

1. **Merge refactoring:** Branch `refactor/claude-md-modular` ready
2. **Execute remaining Phase 2 tasks:** [List unexecuted tasks]
3. **Implement recommendations:** [From sub-agent reports]
4. **Phase 3 decision:** [If applicable]

---

**Session Status:** ✅ Complete
**Quality:** [Excellent / Good / Issues]
**User Satisfaction:** [Pending feedback]
```

### 4.3 Prepare for User Review

**Create summary for user:**

```
📋 Session Complete!

✅ **CLAUDE.md Refactoring:**
- Reduced from 1,263 → 358 lines (72% reduction)
- 12 new documentation files created
- Zero information loss, zero broken links
- Commit ready: branch `refactor/claude-md-modular`

✅ **Phase 2 Task [A/B/C/D]:**
- [Summary of results]
- [Deliverables: List]

📊 **Metrics:**
- Total files: 12 created, 2 updated
- Documentation quality: [Score]
- Agent coordination: 100% success

🎯 **Next Steps:**
1. Review refactoring commit (ready to merge)
2. [Task-specific next steps]

**Questions?**
- Merge refactoring now or review first?
- Execute additional Phase 2 tasks?
- Any concerns or feedback?
```

---

## Coordination Principles

### 1. Trust but Verify

- Trust external agent to execute per spec
- Verify all deliverables with validation checks
- Don't micromanage, but validate checkpoints

### 2. Clear Communication

- Provide comprehensive task prompts
- State success criteria explicitly
- Document all findings for user

### 3. Proactive Problem Solving

- If validation fails, diagnose and fix
- Don't wait for user to discover issues
- Provide rollback plan if critical errors

### 4. Documentation First

- Update progress tracking continuously
- Create summary after each major phase
- Preserve findings for future reference

---

## Rollback Procedures

### If Refactoring Issues Found

```bash
# Option 1: Minor fixes (fix in place)
# - Edit broken links
# - Adjust file headers
# - Re-run validation

# Option 2: Major issues (rollback)
cp /tmp/CLAUDE_BACKUP.md /home/yb/codes/AgentX/CLAUDE.md
git checkout main
git branch -D refactor/claude-md-modular
# Diagnose issues, re-plan, re-execute
```

### If Phase 2 Task Issues

- Document issues in session summary
- Create bug reports if needed
- Propose fixes or alternative approaches
- Get user approval before re-execution

---

## Success Criteria

**Refactoring Success:**
- [ ] CLAUDE.md is 300-400 lines
- [ ] All 12 files created
- [ ] 0 broken links
- [ ] 0 information loss
- [ ] Agent navigation functional
- [ ] Commit ready for merge

**Phase 2 Success:**
- [ ] Task deliverable matches spec
- [ ] Findings documented
- [ ] Recommendations actionable
- [ ] Next steps clear

**Overall Success:**
- [ ] User satisfied with results
- [ ] Documentation updated
- [ ] No blockers for next phase
- [ ] Team velocity maintained

---

**Coordination Plan Status:** ✅ Ready
**Agent:** Primary Claude (Coordinator)
**Estimated Total Time:** 3-4 hours
**Success Probability:** HIGH
