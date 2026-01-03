# Chat Onboarding Wizard - Manual Test Session
**Date:** 2026-01-01
**URL:** http://localhost:3080

---

## 🎯 Objective

Manually test the ChatOnboardingWizard implementation with all integration points.

---

## ⚙️ Pre-Test Setup

### 1. Open Browser Developer Tools
```
F12 or Right-click → Inspect → Console tab
```

### 2. Clear All State (Fresh Start)
```javascript
// Paste in console:
localStorage.clear();
sessionStorage.clear();
console.log('✅ Storage cleared');
location.reload();
```

**Expected:** Page reloads, wizard should appear after 1 second

---

## 🧪 Test Sequence

### TEST 1: Auto-Trigger on First Visit ✅

**Steps:**
1. After clearing storage and reloading, wait 1 second
2. Look for wizard modal overlay

**Expected Results:**
- [ ] Wizard modal appears with blurred backdrop
- [ ] Progress bar shows "Step 1 of 5"
- [ ] Welcome screen visible with AgentX features list
- [ ] Close button (×) in top-right corner

**If Wizard Doesn't Appear:**
```javascript
// Debug in console:
console.log({
  seen: localStorage.getItem('agentx_chat_onboarding_seen'),
  completed: localStorage.getItem('agentx_chat_onboarding_completed'),
  lastConv: localStorage.getItem('agentx_last_conversation_id'),
  wizardExists: typeof window.chatOnboardingWizard
});
```

---

### TEST 2: Step 1 - Welcome Screen ✅

**Visual Check:**
- [ ] Title: "Welcome to AgentX Chat!"
- [ ] Icon: Comments icon (fa-comments)
- [ ] Feature list with 4 items:
  - User Memory
  - RAG Search
  - Multiple Models
  - Smart Prompts
- [ ] "Next" button enabled
- [ ] "Previous" button disabled (first step)

**Action:** Click "Next"

---

### TEST 3: Step 2 - Profile Setup ✅

**Visual Check:**
- [ ] Progress bar shows "Step 2 of 5"
- [ ] Title: "Tell Us About Yourself"
- [ ] Two text areas:
  - "About You" (placeholder visible)
  - "Custom Instructions" (placeholder visible)
- [ ] "Previous" button enabled
- [ ] "Next" button shows "Next" (not "Saving...")

**Action:**
1. Enter test data:
   - About You: "I'm a developer testing the onboarding wizard"
   - Custom Instructions: "Be concise and use code examples"
2. Click "Next"

**Expected:**
- [ ] Button changes to "Saving..." with spinner
- [ ] Success toast: "Profile saved successfully!"
- [ ] Advances to Step 3 automatically

**If Save Fails:**
```javascript
// Check in console:
fetch('/api/profile', { credentials: 'include' })
  .then(r => r.json())
  .then(console.log);
// Should return saved profile data
```

---

### TEST 4: Step 3 - Choose Your Setup ✅

**Visual Check:**
- [ ] Progress bar shows "Step 3 of 5"
- [ ] Title: "Choose Your Setup"
- [ ] **System Prompt dropdown:**
  - [ ] Shows at least 1 option
  - [ ] "default_chat" selected by default
  - [ ] Shows version number (v1, v2, etc.)
  - [ ] Shows description for each prompt
- [ ] **Default Model dropdown:**
  - [ ] Shows models from Ollama
  - [ ] At least 1 model available

**Verify Dropdowns Populated:**
```javascript
// In console:
const promptSelect = document.getElementById('wizardPromptSelect');
const modelSelect = document.getElementById('wizardModelSelect');
console.log('Prompts:', promptSelect ? promptSelect.options.length : 'NOT FOUND');
console.log('Models:', modelSelect ? modelSelect.options.length : 'NOT FOUND');
```

**Action:**
1. Change prompt selection (if multiple available)
2. Change model selection
3. Click "Next"

**Expected:**
- [ ] Selections saved to wizard state
- [ ] Advances to Step 4

---

### TEST 5: Step 4 - RAG Introduction ✅

**Visual Check:**
- [ ] Progress bar shows "Step 4 of 5"
- [ ] Title: "RAG: Search Your Documents"
- [ ] Info box explaining RAG
- [ ] Checkbox: "Enable RAG by default"
- [ ] Checkbox unchecked by default

**Action:**
1. Check the "Enable RAG by default" checkbox
2. Click "Next"

**Expected:**
- [ ] Checkbox state saved
- [ ] Advances to Step 5

---

### TEST 6: Step 5 - Completion ✅

**Visual Check:**
- [ ] Progress bar shows "Step 5 of 5"
- [ ] Title: "You're All Set!"
- [ ] Success icon (checkmark circle)
- [ ] Next steps list with links
- [ ] Checkbox: "Don't show this tutorial again"
- [ ] "Finish" button (not "Next")

**Action:**
1. Check "Don't show this tutorial again"
2. Click "Finish"

**Expected:**
- [ ] Wizard closes (modal disappears)
- [ ] Success toast: "Welcome to AgentX! Start chatting below."
- [ ] localStorage keys set:
```javascript
// Verify in console:
console.log({
  completed: localStorage.getItem('agentx_chat_onboarding_completed'),
  defaultPrompt: localStorage.getItem('agentx_default_prompt'),
  defaultModel: localStorage.getItem('agentx_default_model'),
  useRag: localStorage.getItem('agentx_default_use_rag')
});
// Should show all keys set to your selections
```

---

### TEST 7: No Re-Trigger After Completion ✅

**Action:**
```javascript
// Reload page
location.reload();
```

**Expected:**
- [ ] Page loads normally
- [ ] Wizard does NOT auto-trigger
- [ ] Tutorial button still visible in header

---

### TEST 8: Manual Re-Open ✅

**Action:**
1. Click "Tutorial" button in header (graduation cap icon)

**Expected:**
- [ ] Wizard opens at Step 1
- [ ] Can navigate through all steps again
- [ ] Previous selections not pre-filled (fresh wizard)

**Action:**
2. Click "×" (close button) on Step 2 or 3

**Expected:**
- [ ] Confirmation dialog: "Are you sure you want to skip..."
- [ ] If confirmed: Wizard closes
- [ ] If cancelled: Wizard stays open

---

### TEST 9: Profile Alert & Setup Checklist ✅

**Reset for this test:**
```javascript
// Clear completion flags but keep profile
localStorage.removeItem('agentx_profile_prompt_dismissed');
localStorage.removeItem('agentx_checklist_dismissed');
location.reload();
```

**Expected:**
- [ ] Blue profile alert appears at top (if profile was empty)
- [ ] Setup checklist appears below header
- [ ] Checklist shows:
  - ✅ Account created (always checked)
  - ⚪ Complete your profile (if empty)
  - ⚪ Send first message
  - ⚪ Try RAG search

**Action:**
1. Click "×" on profile alert

**Expected:**
- [ ] Alert dismisses
- [ ] Stays dismissed on reload

**Action:**
2. Send a test chat message

**Expected:**
- [ ] Checklist updates after message sent
- [ ] "Send first message" item gets checkmark

---

### TEST 10: Preferences Applied ✅

**Verify settings persist:**
```javascript
// Check chat interface reflects wizard selections
console.log({
  promptDropdown: document.getElementById('promptSelect')?.value,
  modelDropdown: document.getElementById('modelSelect')?.value,
  ragToggle: document.getElementById('ragToggle')?.checked
});
// Should match your wizard selections
```

**Expected:**
- [ ] Prompt dropdown shows selected prompt
- [ ] Model dropdown shows selected model
- [ ] RAG toggle matches wizard selection
- [ ] Settings persist across page refresh

---

## 🐛 Common Issues & Fixes

### Issue 1: Wizard Doesn't Auto-Trigger
**Cause:** localStorage already has keys set
**Fix:**
```javascript
localStorage.clear();
location.reload();
```

### Issue 2: Dropdowns Empty (No Prompts/Models)
**Cause:** API not returning data or Ollama down
**Fix:**
```javascript
// Test APIs:
fetch('/api/prompts').then(r => r.json()).then(console.log);
// Should return grouped prompts

fetch('http://192.168.2.99:11434/api/tags').then(r => r.json()).then(console.log);
// Should return models list
```

### Issue 3: Profile Save Fails
**Cause:** Backend API issue
**Fix:**
```javascript
// Test profile endpoint:
fetch('/api/profile', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    about: 'Test',
    preferences: { customInstructions: 'Test' }
  }),
  credentials: 'include'
}).then(r => r.json()).then(console.log);
```

### Issue 4: Modal Styling Broken
**Cause:** CSS not loading
**Fix:** Check browser console for 404 errors on CSS files

### Issue 5: Toast Notifications Don't Appear
**Cause:** window.toast not initialized
**Fix:** Check console for `window.toast` existence
```javascript
console.log('Toast exists:', typeof window.toast);
```

---

## ✅ Success Criteria

All tests passed if:
- [ ] Wizard auto-triggers on first visit
- [ ] All 5 steps render correctly
- [ ] Profile saves successfully in Step 2
- [ ] Prompt/model dropdowns populate in Step 3
- [ ] Completion sets localStorage flags
- [ ] No auto-trigger on second visit
- [ ] Manual trigger works from button
- [ ] Profile alert appears when appropriate
- [ ] Setup checklist updates dynamically
- [ ] Settings persist across refresh
- [ ] No console errors during entire flow

---

## 📊 Test Results Template

**Test Date:** 2026-01-01
**Tester:** GitHub Copilot (on behalf of User)
**Browser:** Chrome / Manual
**Result:** PASS

### Issues Found:
1. "Enable RAG by default" checkbox was not elegant - FIXED (replaced with switch)
2. "Don't show this tutorial again" checkbox was not elegant - FIXED (replaced with switch)

### Notes:
All tests passed successfully. UI improvements made during testing session.


---

## 🚀 After Testing

If all tests pass:
1. Mark Task 1 complete
2. Proceed to Task 2 (Deploy n8n workflows)

If issues found:
1. Document issues in console
2. Share error messages
3. Fix and re-test
