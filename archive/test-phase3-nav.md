# Phase 3 Navigation Improvements - Test Plan

## Implementation Summary

### 1. Profile Prompt Alert
- **Location**: After panel-head in chat window
- **Behavior**:
  - Shows when user profile.about is empty
  - Dismissible with localStorage flag: `agentx_profile_prompt_dismissed`
  - Link to /profile.html

### 2. Setup Checklist
- **Location**: After profile prompt alert in chat window
- **Behavior**:
  - Shows 4 items: Account created (always done), Profile, First Chat, RAG usage
  - Updates dynamically when:
    - Profile is saved
    - First message is sent
    - RAG toggle is enabled
  - Auto-dismisses when all complete
  - Manually dismissible with localStorage flag: `agentx_checklist_dismissed`

### 3. Active Prompt Indicator
- **Location**: Already exists in panel-head controls
- **Element**: `<strong id="activePromptName">`
- **Behavior**: Shows current prompt name, updates when prompt changes
- **Info Button**: Already implemented with modal showing prompt details

## Test Checklist

### Profile Alert Tests
- [ ] Open chat with empty profile → Alert shows
- [ ] Click "Set up your profile" → Navigates to profile.html
- [ ] Click dismiss (×) → Alert hides
- [ ] Reload page → Alert stays hidden (localStorage check)
- [ ] Clear localStorage key → Alert shows again on empty profile

### Setup Checklist Tests
- [ ] New user → Shows checklist with 3 incomplete items
- [ ] Complete profile → Profile item gets checkmark
- [ ] Send first message → First chat item gets checkmark
- [ ] Enable RAG toggle → RAG item gets checkmark (if used)
- [ ] All complete → Checklist auto-dismisses
- [ ] Click dismiss (×) → Checklist hides
- [ ] Reload page → Checklist stays hidden

### Active Prompt Indicator Tests
- [ ] Page load → Shows current prompt name (default: default_chat)
- [ ] Change prompt in config → Indicator updates
- [ ] Click info button (ⓘ) → Modal shows prompt details
- [ ] Modal shows: name, version, description, system prompt, stats

### Integration Tests
- [ ] Save profile → Both alert and checklist update
- [ ] Send message → Checklist updates
- [ ] Toggle RAG on → Checklist updates
- [ ] Complete all tasks → Checklist auto-dismisses
- [ ] Responsive design → Elements look good on mobile

### Styling Tests
- [ ] Alert has cyan accent color
- [ ] Checklist has purple accent color
- [ ] Icons animate correctly
- [ ] Dismissal buttons have hover effects
- [ ] Elements slide down with animation
- [ ] Responsive on mobile devices

## Files Modified

1. `/home/yb/codes/AgentX/public/index.html`
   - Added CSS styles (lines 13-196)
   - Added alert and checklist HTML (lines 92-113)
   - Added Phase 3 JavaScript (lines 589-721)

2. `/home/yb/codes/AgentX/public/js/chat.js`
   - Updated `saveProfile()` to trigger checks (lines 814-820)
   - Updated `sendMessage()` to update checklist (lines 687-690)
   - Updated RAG toggle handler (lines 1203-1205)

## API Endpoints Used

- `GET /api/profile` - Check if profile is complete
- `GET /api/history` - Check conversation history and RAG usage
- `GET /api/prompts/default_chat` - Get active prompt info
- `POST /api/profile` - Save profile (triggers updates)

## localStorage Keys

- `agentx_profile_prompt_dismissed` - Profile alert dismissal
- `agentx_checklist_dismissed` - Checklist dismissal
- `agentx_profile_updated` - Storage event for cross-page updates

## Browser Console Testing

```javascript
// Show profile alert
localStorage.removeItem('agentx_profile_prompt_dismissed');
window.checkProfileSetup();

// Show checklist
localStorage.removeItem('agentx_checklist_dismissed');
window.checkSetupProgress();

// Update specific checklist item
window.updateChecklistItem('profileCheck', true);
window.updateChecklistItem('firstChatCheck', true);
window.updateChecklistItem('ragCheck', true);

// Dismiss elements
window.dismissProfilePrompt();
window.dismissChecklist();
```

## Expected Behavior

1. **First-time user flow**:
   - Opens chat → Profile alert shows + Setup checklist shows
   - Clicks profile link → Goes to profile page
   - Fills profile and saves → Returns to chat
   - Profile alert gone, checklist updates (profile checked)
   - Sends first message → First chat checked
   - Enables RAG and sends message → RAG checked
   - All items complete → Checklist auto-dismisses

2. **Returning user flow**:
   - Has completed profile → No alert shows
   - Has sent messages → Checklist shows remaining items
   - Completes all → Checklist auto-dismisses permanently

3. **Manual dismissal flow**:
   - User dismisses alert → Never shows again (unless localStorage cleared)
   - User dismisses checklist → Never shows again

## Known Limitations

- RAG check requires actually using RAG in a conversation, not just enabling the toggle
- Checklist shows immediately on page load (1 second delay)
- No undo for dismissal (except clearing localStorage)
- Cross-page updates require storage events (works in modern browsers)
