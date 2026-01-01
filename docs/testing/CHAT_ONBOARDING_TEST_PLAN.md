# Chat Onboarding Wizard - Test Plan

**Component:** `ChatOnboardingWizard.js`
**Integration:** `/public/index.html`
**Date:** 2026-01-01

---

## Test Environment Setup

1. **Clear localStorage for clean test:**
   ```javascript
   // Run in browser console
   localStorage.removeItem('agentx_chat_onboarding_seen');
   localStorage.removeItem('agentx_chat_onboarding_completed');
   localStorage.removeItem('agentx_last_conversation_id');
   ```

2. **Access:** http://localhost:3080
3. **Browser:** Chrome/Firefox/Safari (test modern browsers)

---

## Test Cases

### TC1: Auto-Trigger on First Visit

**Pre-conditions:**
- localStorage cleared (no `agentx_chat_onboarding_seen` flag)
- No conversation history (`agentx_last_conversation_id` not set)

**Steps:**
1. Open http://localhost:3080
2. Wait 1 second

**Expected:**
- ✅ Chat onboarding wizard should automatically appear
- ✅ Modal overlay visible with backdrop blur
- ✅ Progress bar shows "Step 1 of 5"
- ✅ Welcome screen content displays correctly
- ✅ localStorage `agentx_chat_onboarding_seen` is set to 'true'

---

### TC2: Manual Trigger via Button

**Pre-conditions:**
- Already completed onboarding (or any state)

**Steps:**
1. Open http://localhost:3080
2. Click "Tutorial" button in header (graduation cap icon)

**Expected:**
- ✅ Wizard opens regardless of completion status
- ✅ Starts at Step 1 (Welcome)
- ✅ All steps render correctly

---

### TC3: Step Navigation (Forward)

**Steps:**
1. Open wizard (auto or manual)
2. Click "Next" button on each step

**Expected for each step:**

**Step 1 → 2:**
- ✅ Transitions to Profile Setup step
- ✅ Progress bar updates to 2/5
- ✅ Textarea fields pre-populated with any existing data
- ✅ "Previous" button now enabled

**Step 2 → 3:**
- ✅ Shows loading spinner briefly
- ✅ Fetches prompts from `/api/prompts`
- ✅ Fetches models from Ollama `/api/tags`
- ✅ Dropdowns populated with data
- ✅ `default_chat` selected by default

**Step 3 → 4:**
- ✅ RAG Introduction step displays
- ✅ Checkbox state preserved

**Step 4 → 5:**
- ✅ Completion step shows
- ✅ "Next" button changes to "Finish"

---

### TC4: Step Navigation (Backward)

**Steps:**
1. Navigate to Step 3
2. Click "Previous" button repeatedly

**Expected:**
- ✅ Each click moves back one step
- ✅ Form data preserved across back/forward
- ✅ Progress bar updates correctly
- ✅ "Previous" disabled on Step 1

---

### TC5: Profile Save (Step 2)

**Steps:**
1. Navigate to Step 2
2. Enter text in both textareas:
   - About You: "I'm a developer"
   - Custom Instructions: "Be concise"
3. Click "Next"

**Expected:**
- ✅ Button shows loading state: "Saving..."
- ✅ POST request to `/api/profile` with correct payload
- ✅ Success toast: "Profile saved successfully!"
- ✅ Advances to Step 3 after successful save
- ✅ If save fails, stays on Step 2 with error toast

**Verify in browser console:**
```javascript
fetch('/api/profile', { credentials: 'include' })
  .then(r => r.json())
  .then(console.log);
// Should show saved profile data
```

---

### TC6: Prompt/Model Selection (Step 3)

**Steps:**
1. Navigate to Step 3
2. Change prompt dropdown value
3. Change model dropdown value
4. Click "Next"

**Expected:**
- ✅ Selections stored in wizard state
- ✅ On completion, preferences applied to localStorage:
   - `agentx_default_prompt`
   - `agentx_default_model`
   - `agentx_default_use_rag`

---

### TC7: RAG Toggle (Step 4)

**Steps:**
1. Navigate to Step 4
2. Toggle RAG checkbox ON
3. Complete wizard

**Expected:**
- ✅ Checkbox state saved
- ✅ localStorage `agentx_default_use_rag` = 'true'

---

### TC8: Completion - "Don't Show Again"

**Steps:**
1. Navigate to Step 5
2. Check "Don't show this tutorial again"
3. Click "Finish"

**Expected:**
- ✅ Wizard closes
- ✅ Success toast: "Welcome to AgentX! Start chatting below."
- ✅ localStorage `agentx_chat_onboarding_completed` = 'true'
- ✅ On page refresh, wizard does NOT auto-trigger

---

### TC9: Completion - Without "Don't Show Again"

**Steps:**
1. Navigate to Step 5
2. Leave checkbox UNCHECKED
3. Click "Finish"

**Expected:**
- ✅ Wizard closes
- ✅ localStorage `agentx_chat_onboarding_completed` NOT set
- ✅ On page refresh with no conversation, wizard WILL auto-trigger again

---

### TC10: Skip Button

**Steps:**
1. Open wizard
2. Click X (close) button in header

**Expected:**
- ✅ Confirmation dialog: "Are you sure you want to skip..."
- ✅ If confirmed, wizard closes
- ✅ If cancelled, wizard remains open

---

### TC11: Preferences Application

**Steps:**
1. Complete wizard with custom selections:
   - Prompt: "custom_prompt"
   - Model: "llama3.2"
   - RAG: enabled
2. Check chat interface

**Expected:**
- ✅ Prompt dropdown reflects selected value
- ✅ Model dropdown reflects selected value
- ✅ RAG toggle enabled
- ✅ Values persist across page refresh

---

### TC12: No Auto-Trigger After Conversation

**Pre-conditions:**
- Clear localStorage
- Create a conversation (send one message)

**Steps:**
1. Refresh page
2. Wait 1 second

**Expected:**
- ✅ Wizard does NOT auto-trigger (user has history)
- ✅ Manual button still works

---

### TC13: API Error Handling - Profile Save

**Steps:**
1. Stop MongoDB or break `/api/profile` endpoint
2. Navigate to Step 2
3. Enter profile data
4. Click "Next"

**Expected:**
- ✅ Error toast appears with message
- ✅ Stays on Step 2 (doesn't advance)
- ✅ Button returns to "Next" state (not loading)
- ✅ Can retry after fixing issue

---

### TC14: API Error Handling - Prompt Fetch

**Steps:**
1. Break `/api/prompts` endpoint
2. Navigate to Step 3

**Expected:**
- ✅ Fallback to default_chat prompt
- ✅ Dropdown shows at least one option
- ✅ No JavaScript errors in console

---

### TC15: Responsive Design

**Steps:**
1. Open wizard
2. Resize browser to mobile (375px width)
3. Navigate through all steps

**Expected:**
- ✅ Modal fits viewport
- ✅ Text is readable
- ✅ Buttons don't overlap
- ✅ Scrollable if content overflows

---

### TC16: Accessibility

**Steps:**
1. Open wizard
2. Use Tab key to navigate
3. Use Enter/Space to activate buttons

**Expected:**
- ✅ Focus visible on interactive elements
- ✅ Can navigate entire wizard via keyboard
- ✅ Modal traps focus (can't tab outside)
- ✅ Esc key closes wizard (optional enhancement)

---

## API Endpoints Verification

Ensure these endpoints work:

1. **GET `/api/prompts`**
   ```bash
   curl http://localhost:3080/api/prompts
   # Should return grouped prompts
   ```

2. **POST `/api/profile`**
   ```bash
   curl -X POST http://localhost:3080/api/profile \
     -H "Content-Type: application/json" \
     -d '{"about":"test","preferences":{"customInstructions":"test"}}'
   # Should save profile
   ```

3. **GET Ollama models**
   ```bash
   curl http://localhost:11434/api/tags
   # Should return list of models
   ```

---

## Browser Console Checks

### No Errors
Run through wizard and check console for:
- ✅ No JavaScript errors
- ✅ No 404s for components
- ✅ No CORS errors

### localStorage State
After completion:
```javascript
console.log({
  seen: localStorage.getItem('agentx_chat_onboarding_seen'),
  completed: localStorage.getItem('agentx_chat_onboarding_completed'),
  prompt: localStorage.getItem('agentx_default_prompt'),
  model: localStorage.getItem('agentx_default_model'),
  rag: localStorage.getItem('agentx_default_use_rag')
});
```

---

## Known Limitations

1. **Toast Dependency:** Wizard assumes `window.toast` exists. Fallback to console if not.
2. **Model Fetch:** Relies on Ollama host from localStorage. Defaults to localhost:11434.
3. **Conversation Detection:** Uses `agentx_last_conversation_id` localStorage key. If chat.js uses different key, update logic.

---

## Test Completion Checklist

- [ ] TC1: Auto-trigger works
- [ ] TC2: Manual trigger works
- [ ] TC3: Forward navigation works
- [ ] TC4: Backward navigation works
- [ ] TC5: Profile save works
- [ ] TC6: Prompt/model selection works
- [ ] TC7: RAG toggle works
- [ ] TC8: "Don't show again" works
- [ ] TC9: Without "don't show" works
- [ ] TC10: Skip works
- [ ] TC11: Preferences applied
- [ ] TC12: No trigger after conversation
- [ ] TC13: Profile error handled
- [ ] TC14: Prompt fetch error handled
- [ ] TC15: Responsive on mobile
- [ ] TC16: Keyboard accessible
- [ ] All API endpoints functional
- [ ] No console errors

---

## Bug Report Template

If issues found:

**Bug ID:** CHAT-OB-XXX
**Severity:** Critical / High / Medium / Low
**Component:** ChatOnboardingWizard.js
**Step:** [Which step?]
**Browser:** [Chrome 120 / Firefox 121 / Safari 17]

**Steps to Reproduce:**
1.
2.
3.

**Expected:**
**Actual:**
**Console Errors:**
**Screenshot:**

---

## Performance Benchmarks

- ✅ Wizard opens in < 100ms
- ✅ Step transition < 50ms
- ✅ API calls complete in < 2s
- ✅ No memory leaks (check DevTools Memory tab)
