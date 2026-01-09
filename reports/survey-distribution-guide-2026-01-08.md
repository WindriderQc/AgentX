# Survey Distribution Guide: Voice API & Workflow Generator UIs

**Date:** 2026-01-08
**Survey:** Demand Validation for UI Development
**Target Responses:** 20-30 minimum
**Timeline:** 1 week collection + 2 hours analysis
**Status:** ✅ READY TO LAUNCH

---

## Executive Summary

This guide provides everything needed to distribute the **Voice API & Workflow Generator Demand Validation Survey** and collect responses for build/defer decisions.

**Survey Purpose:** Determine if we should invest 22-30 hours building UIs for two currently headless features
**Decision Thresholds:**
- Voice API: ≥75/150 points → BUILD UI
- Workflow Generator: ≥70/140 points → BUILD UI

**Distribution Channels:** 4 primary (Email, In-App, Slack, GitHub)
**Estimated Setup Time:** 1 hour
**Response Collection:** 1 week (passive)
**Analysis Time:** 2 hours

---

## Quick Start (5-Minute Setup)

### Step 1: Create Google Form (15 min)
1. Go to [forms.google.com](https://forms.google.com)
2. Click "Blank Form"
3. Copy questions from `/DEMAND_VALIDATION_SURVEY.md`
4. Configure settings (see "Google Form Setup" section below)
5. Get shareable link

### Step 2: Distribute Survey (5 min)
1. Send email to user list (template below)
2. Add in-app banner (optional, requires code deployment)
3. Post to Slack/Discord (template below)
4. Create GitHub Discussion (template below)

### Step 3: Set Reminders (2 min)
- Day 3: Send reminder email
- Day 5: Share interim results
- Day 7: Final reminder and close survey

### Step 4: Analyze Results (2 hours)
- Calculate priority scores using formulas
- Create summary report
- Make build/defer recommendation

---

## Survey Overview

### Questions Breakdown
**Total Questions:** 27
**Sections:** 6

1. **Respondent Profile** (3 questions)
   - Role, usage frequency, features used

2. **Voice API Demand** (11 questions)
   - Current usage, challenges, importance, preferred method, willingness to pay

3. **Voice API UI Features** (1 question)
   - Desired UI features (multi-select)

4. **Workflow Generator Demand** (10 questions)
   - Current usage, challenges, importance, automation confidence, willingness to pay

5. **Workflow Generator UI Features** (1 question)
   - Desired UI features (multi-select)

6. **Overall Feedback** (1 question)
   - Additional comments

### Scoring Methodology

#### Voice API Priority Score (0-150 points)
```
Score = (Avg Q7 rating × 20) + (Q8 frequency × 2) + (Q9 method preference × 3) + (Q11 willingness to pay × 15)

Components:
- Q7: Importance (1-5 scale) × 20 = 0-100 points
- Q8: Frequency (multi-select) × 2 = 0-10 points
- Q9: Method preference (multi-select) × 3 = 0-15 points
- Q11: Willingness to pay (0-100%) × 15 = 0-15 points

Threshold: ≥75 points = BUILD UI
```

#### Workflow Generator Priority Score (0-140 points)
```
Score = (Avg Q16 rating × 20) + (Q17 frequency × 2) + (Q19 confidence × 2) + (Q20 willingness to pay × 15)

Components:
- Q16: Importance (1-5 scale) × 20 = 0-100 points
- Q17: Frequency (multi-select) × 2 = 0-10 points
- Q19: Automation confidence (multi-select) × 2 = 0-10 points
- Q20: Willingness to pay (0-100%) × 15 = 0-15 points

Threshold: ≥70 points = BUILD UI
```

---

## Distribution Templates

### Email Template (Primary Channel)

**Subject:** Help shape AgentX development - 5 minute survey

**Body:**
```
Hi [Name],

We need your input on AgentX's development priorities.

AgentX currently has two powerful features that are API-only (no UI):
1. Voice API - Speech-to-text, text-to-speech, voice chat
2. Workflow Generator - AI-powered n8n workflow creation

We're deciding whether to build user interfaces for these features. Your feedback will directly influence our roadmap.

📝 Survey: [INSERT GOOGLE FORM LINK]
⏱️ Time: 5-10 minutes
🎯 Your response will help us prioritize the right features

Survey closes: [DATE - 7 days from now]

Thank you for helping us build what you need!

Best,
[Your Name]
AgentX Team

P.S. If you're not a regular AgentX user, you can still provide feedback as an evaluator. All perspectives are valuable!
```

### In-App Banner (Optional)

**File to Modify:** `/public/index.html` (or dashboard page)

**Banner HTML:**
```html
<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 16px;
            text-align: center;
            border-radius: 8px;
            margin-bottom: 20px;">
  <h3 style="margin: 0 0 8px 0;">
    🗳️ Help Shape AgentX Development
  </h3>
  <p style="margin: 0 0 12px 0;">
    Should we build UIs for Voice API and Workflow Generator?
    Take our 5-minute survey and influence the roadmap.
  </p>
  <a href="[GOOGLE FORM LINK]"
     target="_blank"
     style="background: white;
            color: #667eea;
            padding: 10px 24px;
            border-radius: 6px;
            text-decoration: none;
            font-weight: 600;">
    Take Survey →
  </a>
  <button onclick="this.parentElement.style.display='none'"
          style="position: absolute;
                 top: 8px;
                 right: 12px;
                 background: none;
                 border: none;
                 color: white;
                 font-size: 20px;
                 cursor: pointer;">
    ×
  </button>
</div>
```

### Slack/Discord Template

**Message:**
```
📊 **AgentX Development Survey**

We need your input! Should we build UIs for these API-only features?

🎤 **Voice API** - Speech-to-text, text-to-speech, voice chat
🤖 **Workflow Generator** - AI-powered n8n workflow creation

Your feedback will directly shape our roadmap.

📝 **Survey:** [GOOGLE FORM LINK]
⏱️ **Time:** 5-10 minutes
🗓️ **Closes:** [DATE]

All users welcome - even if you haven't used these features yet! 🙌

Reply with 👍 when you've completed it!
```

### GitHub Discussion Template

**Title:** [Survey] Voice API & Workflow Generator UI Demand Validation

**Body:**
```markdown
## 🗳️ Community Input Needed: UI Development Priorities

Hi AgentX community!

We're seeking your feedback on two features that are currently API-only:

### 1. Voice API
- Speech-to-text transcription
- Text-to-speech synthesis
- End-to-end voice chat with LLMs

### 2. Workflow Generator
- AI-powered n8n workflow creation
- Template suggestions
- Visual workflow builder

Both are fully functional via API but require curl/Postman/code to use. We're deciding whether to build user-friendly UIs.

### 📝 Take the Survey
**Link:** [GOOGLE FORM LINK]
**Time:** 5-10 minutes
**Closes:** [DATE]

### Why Your Input Matters
- Your response directly influences our development roadmap
- We'll publish results and rationale for our decision
- All perspectives welcome (regular users, evaluators, API users, non-technical users)

### Decision Thresholds
- **Voice API:** ≥75/150 points → Build UI
- **Workflow Generator:** ≥70/140 points → Build UI
- Scores below threshold → Keep as API-only

We'll share results in 2 weeks. Thank you for helping us prioritize! 🚀

---

**Questions?** Reply to this thread or email [contact@agentx.dev]
```

---

## Google Form Setup Guide

### Form Configuration

**Step 1: General Settings**
- ✅ Limit to 1 response per person (requires sign-in)
- ✅ Collect email addresses
- ✅ Send response copy to respondent
- ✅ Show progress bar

**Step 2: Response Validation**
- Q7, Q16: Required (1-5 scale)
- Q8, Q9, Q17, Q19: Required (multi-select)
- Q11, Q20: Required (percentage input, 0-100)

**Step 3: Question Types**
- Profile questions: Multiple choice
- Importance ratings (Q7, Q16): Linear scale (1-5)
- Frequency questions: Checkboxes (multi-select)
- Willingness to pay: Short answer (number validation, 0-100)
- Open-ended: Paragraph text

**Step 4: Response Collection**
- View responses in Google Sheets
- Auto-export to `/responses/survey-results-[DATE].csv`

### Question Mapping for Google Forms

**Section 1: Respondent Profile**
- Q1: Multiple choice (single select)
- Q2: Multiple choice (single select)
- Q3: Checkboxes (allow "Other")

**Section 2: Voice API Demand**
- Q4-Q6: Multiple choice (skip logic)
- Q7: Linear scale (1-5) - **REQUIRED**
- Q8: Checkboxes - **REQUIRED**
- Q9: Checkboxes - **REQUIRED**
- Q10: Paragraph text
- Q11: Short answer (number, 0-100) - **REQUIRED**

**Section 3: Voice API UI Features**
- Q12: Checkboxes (allow "Other")

**Section 4: Workflow Generator Demand**
- Q13-Q15: Multiple choice (skip logic)
- Q16: Linear scale (1-5) - **REQUIRED**
- Q17: Checkboxes - **REQUIRED**
- Q18: Paragraph text
- Q19: Checkboxes - **REQUIRED**
- Q20: Short answer (number, 0-100) - **REQUIRED**

**Section 5: Workflow Generator UI Features**
- Q21: Checkboxes (allow "Other")

**Section 6: Overall Feedback**
- Q22: Paragraph text

---

## Response Tracking

### Target Metrics
| Metric | Minimum | Target | Ideal |
|--------|---------|--------|-------|
| Total Responses | 10 | 25 | 50+ |
| Daily Users | 3 | 8 | 15+ |
| Weekly Users | 2 | 5 | 10+ |
| API Users | 2 | 5 | 8+ |
| Evaluators | 1 | 3 | 5+ |

### Daily Check-In (5 min)
**Days 1-7:** Check response count
```
# Response Count Target
Day 1: 3-5 responses
Day 3: 8-12 responses (send reminder)
Day 5: 15-20 responses (share interim results)
Day 7: 20-30+ responses (final reminder & close)
```

### Reminder Schedule

**Day 3 Reminder Email:**
```
Subject: Reminder: AgentX survey closes in 4 days

Hi [Name],

Quick reminder - we'd love your input on AgentX UI priorities.

We've received [X] responses so far, but we need at least 20 for a confident decision.

📝 Survey: [LINK]
⏱️ 5 minutes
🗓️ Closes: [DATE]

Your feedback directly shapes our roadmap. Thank you!

[Your Name]
```

**Day 5 Interim Results Share:**
```
Subject: [Interim Results] AgentX survey responses

Hi all,

Thank you to the [X] users who've responded so far! Here's what we're seeing:

📊 Current Response Count: [X]/20 minimum
🎤 Voice API Interest: [High/Med/Low] (preliminary)
🤖 Workflow Generator Interest: [High/Med/Low] (preliminary)

Still need your input! Survey closes in 2 days.

📝 Survey: [LINK]

We'll share final results next week.

[Your Name]
```

**Day 7 Final Reminder:**
```
Subject: Last chance: AgentX survey closes today

Hi [Name],

**Final reminder** - survey closes tonight at midnight!

We're at [X]/20 responses. Your input will help us make the right decision.

📝 Survey: [LINK]
⏱️ 5 minutes
⏰ Closes: Tonight at 11:59 PM

Thank you to everyone who's responded!

[Your Name]
```

---

## Analysis Guide (Post-Collection)

### Step 1: Export Data (5 min)
1. Open Google Form responses
2. Click "Responses" → "..." → "Download responses (.csv)"
3. Save as `/reports/survey-results-[DATE].csv`

### Step 2: Calculate Scores (30 min)

**Voice API Score:**
```python
# Pseudo-code for score calculation
voice_score = 0

# Q7: Importance (1-5 scale)
avg_q7 = sum(responses['q7']) / len(responses)
voice_score += avg_q7 * 20  # 0-100 points

# Q8: Frequency (count selections)
q8_selections = count_multi_select(responses['q8'])
voice_score += q8_selections * 2  # 0-10 points

# Q9: Method preference (count selections)
q9_selections = count_multi_select(responses['q9'])
voice_score += q9_selections * 3  # 0-15 points

# Q11: Willingness to pay (0-100%)
avg_q11 = sum(responses['q11']) / len(responses)
voice_score += (avg_q11 / 100) * 15  # 0-15 points

print(f"Voice API Score: {voice_score}/150")
if voice_score >= 75:
    print("Decision: BUILD UI")
else:
    print("Decision: DEFER (remain API-only)")
```

**Workflow Generator Score:**
```python
workflow_score = 0

# Q16: Importance (1-5 scale)
avg_q16 = sum(responses['q16']) / len(responses)
workflow_score += avg_q16 * 20  # 0-100 points

# Q17: Frequency (count selections)
q17_selections = count_multi_select(responses['q17'])
workflow_score += q17_selections * 2  # 0-10 points

# Q19: Confidence (count selections)
q19_selections = count_multi_select(responses['q19'])
workflow_score += q19_selections * 2  # 0-10 points

# Q20: Willingness to pay (0-100%)
avg_q20 = sum(responses['q20']) / len(responses)
workflow_score += (avg_q20 / 100) * 15  # 0-15 points

print(f"Workflow Generator Score: {workflow_score}/140")
if workflow_score >= 70:
    print("Decision: BUILD UI")
else:
    print("Decision: DEFER (remain API-only)")
```

### Step 3: Qualitative Analysis (1 hour)

**Extract Key Insights:**
1. Read all open-ended responses (Q10, Q18, Q22)
2. Identify common themes/patterns
3. Extract representative quotes
4. Categorize feedback:
   - Pain points (current API usage)
   - Desired features
   - Use cases
   - Blockers

**Example Analysis Template:**
```
Voice API Insights:
- Primary use case: [e.g., "Accessibility features"]
- Target users: [e.g., "Non-technical users, mobile users"]
- Blockers: [e.g., "No way to test without writing code"]
- Representative quote: "[Quote from Q10]"

Workflow Generator Insights:
- Primary use case: [e.g., "Rapid prototyping"]
- Target users: [e.g., "Citizen developers, product managers"]
- Blockers: [e.g., "n8n editor too complex"]
- Representative quote: "[Quote from Q18]"
```

### Step 4: Create Summary Report (30 min)

**Report Template:** `/reports/survey-analysis-[DATE].md`

**Sections:**
1. Executive Summary (decision + rationale)
2. Response Demographics (role, usage frequency)
3. Voice API Results (score, breakdown, insights)
4. Workflow Generator Results (score, breakdown, insights)
5. Recommendations (build, defer, alternative approaches)
6. Next Steps (if building, create external agent task spec)

---

## Decision Matrix

### Scenarios

| Voice Score | Workflow Score | Decision |
|-------------|---------------|----------|
| ≥75 | ≥70 | **Build both UIs** (22-30 hours total) |
| ≥75 | <70 | **Build Voice UI only** (12-16 hours) |
| <75 | ≥70 | **Build Workflow Generator UI only** (10-14 hours) |
| <75 | <70 | **Defer both** (remain API-only) |

### Edge Cases

**Scores Near Threshold (±5 points):**
- Review qualitative feedback
- Consider effort vs. value
- Pilot with 10-hour MVP if uncertain

**Example:** Voice API scores 72/150 (3 points below threshold)
- **Option A:** Defer (follow threshold rule)
- **Option B:** Build minimal MVP (6-8 hours) based on strong qualitative feedback

**Low Response Rate (<10 responses):**
- Extend survey collection by 1 week
- Direct outreach to power users
- Consider alternative signals (support requests, feature requests, API usage metrics)

---

## Communication Plan

### During Collection (Week 1)
- **Day 1:** Initial distribution
- **Day 3:** Reminder email + progress update
- **Day 5:** Interim results share (builds momentum)
- **Day 7:** Final reminder + close survey

### Analysis Phase (Week 2)
- **Day 8-9:** Calculate scores, analyze feedback
- **Day 10:** Create summary report
- **Day 11:** Review with team, make decision
- **Day 12:** Communicate decision to users

### Post-Decision (Week 3)
**If Building:**
- Update ROADMAP.md with new features
- Create external agent task specs
- Announce timeline to users

**If Deferring:**
- Document rationale in ROADMAP.md
- Provide guidance on API usage
- Commit to revisit in 6 months or when demand increases

---

## Success Criteria

### Response Collection
- ✅ ≥20 responses collected
- ✅ Representative mix of roles (developers, PMs, data scientists)
- ✅ At least 5 responses from API users
- ✅ At least 3 responses from daily/weekly users

### Data Quality
- ✅ <10% incomplete responses
- ✅ Scores show clear trend (not 50/50 split)
- ✅ Qualitative feedback provides actionable insights
- ✅ No survey fatigue indicators (all questions answered)

### Decision Confidence
- ✅ Score is >10 points away from threshold (clear signal)
- ✅ Qualitative feedback aligns with quantitative score
- ✅ Team consensus on build/defer decision
- ✅ User communication plan prepared

---

## Troubleshooting

### Low Response Rate
**Problem:** <10 responses after 5 days

**Solutions:**
1. Extend deadline by 3-5 days
2. Offer incentive (early access, feature credit)
3. Direct outreach to power users via Slack DM
4. Post in additional channels (LinkedIn, Twitter)

### Conflicting Signals
**Problem:** High quantitative score but negative qualitative feedback

**Solutions:**
1. Weight qualitative feedback heavily (user pain points matter)
2. Review if questions are misleading (rating scale ambiguity)
3. Conduct follow-up interviews with 3-5 respondents
4. Build minimal MVP and iterate based on feedback

### Score Near Threshold
**Problem:** Voice API scores 73/150 (2 points below 75)

**Solutions:**
1. Review margin of error (±3 points with small sample size)
2. Check qualitative feedback for strong demand signals
3. Consider pilot/MVP approach (6-8 hours vs. 12-16 hours)
4. Defer and collect more data (revisit in 3 months)

---

## Checklist

### Pre-Launch
- [ ] Google Form created and tested
- [ ] Email list prepared (user contacts)
- [ ] Email templates customized
- [ ] Slack/Discord channels identified
- [ ] GitHub Discussion ready to post
- [ ] Reminder emails scheduled (Day 3, 5, 7)
- [ ] Response tracking spreadsheet set up

### Launch Day
- [ ] Send initial email to user list
- [ ] Post to Slack/Discord
- [ ] Create GitHub Discussion
- [ ] Add in-app banner (if using)
- [ ] Set calendar reminders for check-ins

### Week 1 (Collection)
- [ ] Day 1: Monitor initial responses (target: 3-5)
- [ ] Day 3: Send reminder email
- [ ] Day 5: Share interim results, send reminder
- [ ] Day 7: Final reminder, close survey

### Week 2 (Analysis)
- [ ] Export response data to CSV
- [ ] Calculate Voice API priority score
- [ ] Calculate Workflow Generator priority score
- [ ] Analyze qualitative feedback
- [ ] Create summary report
- [ ] Review with team, make decision
- [ ] Communicate decision to users

### Post-Survey
- [ ] Update ROADMAP.md with decision
- [ ] Create external agent task specs (if building)
- [ ] Archive survey data for future reference
- [ ] Thank respondents via email/Slack

---

## Appendix A: Quick Reference

### Key Dates
- **Day 0:** Launch survey
- **Day 3:** First reminder
- **Day 5:** Interim results
- **Day 7:** Close survey
- **Day 10:** Complete analysis
- **Day 12:** Communicate decision

### Contact Targets
- **Email:** All AgentX users with email addresses
- **Slack:** #general, #feedback channels
- **GitHub:** Create Discussion in main repo
- **Team:** Present during sprint planning

### Response Targets
- **Minimum:** 10 responses (small user base)
- **Target:** 25 responses (representative sample)
- **Ideal:** 50+ responses (high confidence)

### Decision Thresholds
- **Voice API:** ≥75/150 points = BUILD
- **Workflow Generator:** ≥70/140 points = BUILD

---

## Appendix B: External Agent Task Specs (If Building)

### Voice API UI Task Spec (If Score ≥75)
**Title:** Build Voice API User Interface
**Effort:** 12-16 hours
**Priority:** HIGH

**Requirements:**
- Microphone input with waveform visualization
- Audio file upload (drag-and-drop)
- Real-time transcription display
- Text-to-speech playback controls
- Voice chat interface (end-to-end)
- Error handling and loading states
- Mobile-responsive design
- Accessibility (keyboard shortcuts, screen reader)

**Deliverables:**
- `/public/voice.html` (UI page)
- `/public/js/voice.js` (frontend logic)
- Integration with existing `/api/voice/*` endpoints
- User documentation

### Workflow Generator UI Task Spec (If Score ≥70)
**Title:** Build Workflow Generator User Interface
**Effort:** 10-14 hours
**Priority:** HIGH

**Requirements:**
- Prompt input for workflow description
- Generated JSON preview (syntax highlighting)
- Visual workflow preview (node graph)
- One-click deploy to n8n
- Template library (common workflows)
- Validation and error display
- Mobile-responsive design
- Integration with n8n API

**Deliverables:**
- `/public/workflow-generator.html` (UI page)
- `/public/js/workflow-generator.js` (frontend logic)
- n8n API integration
- Workflow templates library
- User documentation

---

**Guide Version:** 1.0
**Created:** 2026-01-08
**Status:** ✅ READY TO USE

---

**Next Steps:**
1. Create Google Form (15 minutes)
2. Customize and send email template
3. Post to Slack/Discord and GitHub
4. Set reminders for Day 3, 5, 7
5. Wait 1 week, then analyze results

**Questions?** Refer to troubleshooting section or contact [team lead]
