# Chat Onboarding Wizard - Test Plan

**Component:** `ChatOnboardingWizard.js`
**Integration:** `/public/index.html`
**Date:** 2026-01-02
**Status:** Ready for Manual QA

---

## Test Environment Setup

1. **Clear localStorage for clean test:**
   ```javascript
   // Run in browser console
   localStorage.removeItem('agentx_chat_onboarding_seen');
   localStorage.removeItem('agentx_chat_onboarding_completed');
   localStorage.removeItem('agentx_last_conversation_id');
   localStorage.removeItem('agentx_default_prompt');
   localStorage.removeItem('agentx_default_model');
   localStorage.removeItem('agentx_default_use_rag');
   ```

2. **Access:** http://localhost:3080
3. **Browser:** Chrome/Firefox/Safari (test modern browsers)

---

## Test Cases (Detailed)

### TC1: Auto-Trigger on First Visit
**Pre-conditions:** localStorage cleared, no conversation history.
**Steps:**
1. Open http://localhost:3080
2. Wait 1 second
**Expected:**
- ✅ Chat onboarding wizard automatically appears
- ✅ Modal overlay visible with backdrop blur
- ✅ Progress bar shows "Step 1 of 5"
- ✅ localStorage `agentx_chat_onboarding_seen` is set to 'true'

### TC2: Manual Trigger via Button
**Pre-conditions:** Any state.
**Steps:**
1. Click "Tutorial" button in header (graduation cap icon)
**Expected:**
- ✅ Wizard opens regardless of completion status
- ✅ Starts at Step 1 (Welcome)

### TC3: Step Navigation (Forward)
**Steps:** Click "Next" button on each step.
**Expected:**
- **Step 1 → 2:** Transitions to Profile Setup.
- **Step 2 → 3:** Shows loading spinner (if API slow), fetches prompts/models.
- **Step 3 → 4:** RAG Introduction displays.
- **Step 4 → 5:** Completion step, "Next" becomes "Finish".

### TC4: Step Navigation (Backward)
**Steps:** Navigate to Step 3, click "Previous".
**Expected:**
- ✅ Moves back one step
- ✅ Form data preserved across back/forward

### TC5: Profile Save (Step 2)
**Steps:** Enter text in "About" and "Custom Instructions", click "Next".
**Expected:**
- ✅ Button shows "Saving..."
- ✅ POST request to `/api/profile` succeeds
- ✅ Success toast appears
- ✅ Advances to Step 3

### TC6: Prompt/Model Selection (Step 3)
**Steps:** Change prompt and model dropdowns, click "Next".
**Expected:**
- ✅ Selections stored in wizard state
- ✅ Applied to localStorage on completion

### TC7: RAG Toggle (Step 4)
**Steps:** Toggle RAG checkbox ON, complete wizard.
**Expected:**
- ✅ localStorage `agentx_default_use_rag` = 'true'

### TC8: Completion - "Don't Show Again"
**Steps:** Check "Don't show again", click "Finish".
**Expected:**
- ✅ Wizard closes
- ✅ localStorage `agentx_chat_onboarding_completed` = 'true'
- ✅ Does NOT auto-trigger on refresh

### TC9: Completion - Without "Don't Show Again"
**Steps:** Leave checkbox UNCHECKED, click "Finish".
**Expected:**
- ✅ Wizard closes
- ✅ localStorage `agentx_chat_onboarding_completed` NOT set
- ✅ WILL auto-trigger on refresh (if no conversation history)

### TC10: Skip Button
**Steps:** Click X (close) button.
**Expected:**
- ✅ Confirmation dialog appears
- ✅ Closes if confirmed

### TC11: Preferences Application
**Steps:** Complete wizard with custom selections.
**Expected:**
- ✅ Chat interface dropdowns reflect selections immediately
- ✅ Values persist across page refresh

### TC12: No Auto-Trigger After Conversation
**Pre-conditions:** Clear localStorage, create a conversation.
**Steps:** Refresh page.
**Expected:**
- ✅ Wizard does NOT auto-trigger

### TC13: API Error Handling - Profile Save
**Steps:** Block `/api/profile`, try to save Step 2.
**Expected:**
- ✅ Error toast appears
- ✅ Stays on Step 2
- ✅ Button resets from loading state

### TC14: API Error Handling - Prompt Fetch
**Steps:** Block `/api/prompts`, navigate to Step 3.
**Expected:**
- ✅ Fallback to default options
- ✅ No crash

### TC15: Responsive Design
**Steps:** Resize to mobile (375px).
**Expected:**
- ✅ Modal fits viewport, scrollable if needed

### TC16: Accessibility
**Steps:** Navigate using Tab/Enter.
**Expected:**
- ✅ Focus visible, keyboard navigable

---

## Enhanced Manual Test Checklist (Quick Run)

Use this checklist for rapid validation cycles.

### 1. First-Time User Flow (Clean State)
- [ ] **Pre-condition:** Clear Local Storage.
- [ ] **Auto-Trigger:** Verify wizard appears on load.
- [ ] **Step 1:** Verify content.
- [ ] **Step 2 (Profile):** Enter data, click Next. Verify "Saving..." and success toast.
- [ ] **Step 3 (Setup):** Verify dropdowns populate. Select non-defaults.
- [ ] **Step 4 (RAG):** Toggle ON.
- [ ] **Step 5 (Finish):** Check "Don't show again", click Finish.
- [ ] **Post-Condition:** Refresh page. Wizard should **NOT** appear.

### 2. Manual Trigger & Navigation
- [ ] **Trigger:** Click "Tutorial" icon.
- [ ] **Navigation:** Go to Step 3, then Back to Step 2. Verify data preserved.
- [ ] **Skip:** Click "X", confirm dialog.

### 3. Persistence & Integration
- [ ] **Preferences:** Verify Chat UI matches wizard selections (Model, Prompt, RAG).
- [ ] **Profile:** Verify data saved to backend.

### 4. Edge Cases & Resilience
- [ ] **API Failure (Profile):** Block network, verify error toast and non-blocking UI.
- [ ] **API Failure (Models):** Block network, verify graceful fallback.
- [ ] **Mobile:** Verify layout on small screen.

---

## Test Automation Gap Analysis

| Feature Area | Automated Coverage | Manual Only (Gap) | Risk Level |
| :--- | :---: | :---: | :---: |
| **Component Rendering** | ✅ Covered | - | Low |
| **Step Navigation** | ✅ Covered | - | Low |
| **API Integration** | ❌ Partial | **Full E2E:** Verifying real backend saves | Medium |
| **Visual Layout** | ❌ None | **Responsiveness:** Mobile view, overflow | Low |
| **Browser Persistence** | ✅ Covered | - | Low |
| **Error States** | ❌ None | **Network Failures:** Toast appearances, UI recovery | Medium |

---

## Risk Matrix

| Risk Scenario | Likelihood | Impact | Mitigation |
| :--- | :---: | :---: | :--- |
| **API Latency/Timeout** | Medium | Medium | Wizard has loading states; Step 3 pre-fetching recommended. |
| **Profile Save Failure** | Low | Low | User can skip or retry; doesn't block app usage. |
| **LocalStorage Full/Disabled** | Very Low | Low | Wizard might reappear on refresh; annoying but not critical. |
| **Model List Empty** | Low | Medium | Fallback to empty list handled; user can still configure manually. |

---

## Bug Report Template

**Bug ID:** CHAT-OB-XXX
**Severity:** Critical / High / Medium / Low
**Component:** ChatOnboardingWizard.js
**Step:** [Which step?]
**Browser:** [Chrome / Firefox / Safari]

**Steps to Reproduce:**
1.
2.

**Expected:**
**Actual:**
