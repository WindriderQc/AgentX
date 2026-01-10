# User Acceptance Testing: Invitation Acceptance UI

**Feature:** Workspace Invitation Acceptance Flow
**Date:** 2026-01-07
**Status:** Ready for Testing
**Tester:** _[Your Name]_
**Environment:** http://localhost:3080

---

## Test Overview

**Purpose:** Validate the invitation acceptance UI works correctly for all user scenarios

**Scope:**
- Token validation
- Happy path acceptance flow
- Error handling (invalid, expired, already member)
- Authentication flow
- Mobile responsiveness
- Browser compatibility

**Prerequisites:**
- AgentX running on localhost:3080
- MongoDB connection active
- At least one workspace created
- Test user accounts available

---

## Test Environment Setup

### Step 1: Create Test Workspace

```bash
# Via UI: http://localhost:3080/workspace-settings.html
# Or via browser console:
```

1. Navigate to Workspace Settings
2. Click "Create Workspace"
3. Fill in details:
   - **Name:** "UAT Test Workspace"
   - **Slug:** "uat-test"
   - **Description:** "Workspace for testing invitation flow"
4. Click "Create"

### Step 2: Create Test User Accounts

**You'll need 3 test users:**
- **User A:** Workspace owner (creates invitations)
- **User B:** New member (accepts invitation)
- **User C:** Existing member (tests "already member" error)

```bash
# Create users via registration page or database insert
# Ensure you have credentials for all 3 users
```

### Step 3: Generate Test Invitation

1. Log in as **User A** (workspace owner)
2. Navigate to Workspace Settings → Members tab
3. Click "Invite Member"
4. Enter **User B's email**
5. Select role: "Member"
6. Click "Send Invitation"
7. **Copy the invitation token from database:**

```bash
# MongoDB query to get token
mongo agentx
db.workspaceinvitations.find().sort({createdAt: -1}).limit(1).pretty()

# Copy the "token" field (e.g., "abc123def456...")
```

### Step 4: Construct Test URL

```
http://localhost:3080/accept-invitation.html?token=[PASTE_TOKEN_HERE]
```

---

## Test Scenarios

### Scenario 1: Valid Invitation - Happy Path ✅

**Objective:** Verify invitation can be accepted successfully

**Steps:**
1. Log in as **User B** (recipient)
2. Open invitation URL in browser: `accept-invitation.html?token=...`
3. Verify page loads without errors

**Expected Results:**
- ✅ Loading spinner appears briefly
- ✅ Invitation details display:
  - Workspace name: "UAT Test Workspace"
  - Workspace description shows
  - "Invited by: [User A's username]"
  - Role badge: "MEMBER" (green)
  - Expiration date formatted nicely (e.g., "Jan 14, 2026, 12:00 PM")
- ✅ Two buttons visible: "Accept Invitation" (blue) and "Decline" (gray)
- ✅ No console errors (F12 → Console tab)

**Action:**
4. Click "Accept Invitation" button

**Expected Results:**
- ✅ Button text changes to "Accepting..." with spinner icon
- ✅ Both buttons disabled during API call
- ✅ Page redirects to `/workspace-settings.html?workspace=uat-test`
- ✅ User B now appears in Members list
- ✅ Role shows "Member"
- ✅ Status shows "Active"

**Pass/Fail:** ______

**Notes:**

---

### Scenario 2: Invalid Token ❌

**Objective:** Verify error handling for invalid token

**Steps:**
1. Open URL with fake token: `accept-invitation.html?token=INVALID123`

**Expected Results:**
- ✅ Loading spinner appears
- ✅ Error state displays:
  - Red border container
  - Warning icon (triangle with exclamation)
  - Error message: "This invitation link is invalid or has expired. Please request a new invitation from your workspace admin."
  - "Go to Dashboard" button visible
- ✅ Accept/Decline buttons NOT visible
- ✅ No console errors

**Action:**
2. Click "Go to Dashboard" button

**Expected Results:**
- ✅ Redirects to `/` (home/dashboard)

**Pass/Fail:** ______

**Notes:**

---

### Scenario 3: Expired Token ⏰

**Objective:** Verify error handling for expired invitation

**Setup:**
```bash
# Manually expire invitation in MongoDB
mongo agentx
db.workspaceinvitations.updateOne(
  { token: "YOUR_TOKEN_HERE" },
  { $set: { expiresAt: new Date("2020-01-01") } }
)
```

**Steps:**
1. Open invitation URL with expired token

**Expected Results:**
- ✅ Error message: "This invitation link is invalid or has expired"
- ✅ Same error state as Scenario 2
- ✅ No ability to accept

**Pass/Fail:** ______

**Notes:**

---

### Scenario 4: Already Member 🔄

**Objective:** Verify error handling when user is already a member

**Setup:**
1. Complete Scenario 1 (User B accepts invitation)
2. Get the same invitation token used in Scenario 1

**Steps:**
1. As **User B** (still logged in), open same invitation URL again
2. Click "Accept Invitation"

**Expected Results:**
- ✅ API returns error: "You are already a member of this workspace"
- ✅ Alert or error message displays
- ✅ Page handles error gracefully (no crash)
- ✅ User can navigate away

**Alternative Expected:**
- API may return 409 Conflict
- Error message: "You're already a member of UAT Test Workspace. No further action needed."

**Pass/Fail:** ______

**Notes:**

---

### Scenario 5: Not Logged In 🔐

**Objective:** Verify authentication flow for logged-out users

**Steps:**
1. Log out completely (clear session cookies)
2. Open valid invitation URL: `accept-invitation.html?token=...`
3. Verify invitation details display (authentication not required for viewing)
4. Click "Accept Invitation" button

**Expected Results:**
- ✅ API returns 401 Unauthorized
- ✅ Page redirects to login page: `/login.html?returnTo=/accept-invitation.html?token=...`
- ✅ Return URL preserves token parameter

**Action:**
5. Log in as **User B** on login page

**Expected Results:**
- ✅ After successful login, automatically redirects back to invitation page
- ✅ Invitation details still visible
- ✅ Can click "Accept Invitation" again
- ✅ Successfully accepts invitation

**Pass/Fail:** ______

**Notes:**

---

### Scenario 6: Decline Invitation ❌

**Objective:** Verify decline flow works correctly

**Setup:**
1. Create a new invitation for a different user (or reset User B's membership)

**Steps:**
1. Open valid invitation URL
2. Click "Decline" button

**Expected Results:**
- ✅ Confirmation dialog appears: "Are you sure you want to decline this invitation?"
- ✅ Dialog has "OK" and "Cancel" buttons

**Action:**
3. Click "Cancel" in confirmation dialog

**Expected Results:**
- ✅ Dialog closes
- ✅ Returns to invitation page (no action taken)

**Action:**
4. Click "Decline" button again
5. Click "OK" in confirmation dialog

**Expected Results:**
- ✅ Redirects to `/` (home/dashboard)
- ✅ No API call made (decline is client-side only)
- ✅ Invitation remains in database (status: "pending")

**Pass/Fail:** ______

**Notes:**

---

### Scenario 7: Mobile Responsiveness 📱

**Objective:** Verify UI works on mobile devices

**Steps:**
1. Open invitation URL in Chrome DevTools mobile emulator:
   - Press F12 → Toggle device toolbar (Ctrl+Shift+M)
   - Select device: iPhone 12 Pro (390x844)
2. Verify page layout

**Expected Results:**
- ✅ Card layout centered on screen
- ✅ Invitation details readable (no text cutoff)
- ✅ Role badge visible and sized correctly
- ✅ Buttons stack vertically (not side-by-side)
- ✅ Buttons are touch-friendly (adequate size/spacing)
- ✅ No horizontal scrolling required
- ✅ Gradient background displays correctly

**Action:**
3. Tap "Accept Invitation" button

**Expected Results:**
- ✅ Button responds to touch
- ✅ Loading state displays
- ✅ Page redirects successfully

**Pass/Fail:** ______

**Notes:**

---

### Scenario 8: Browser Compatibility 🌐

**Objective:** Verify UI works across major browsers

**Browsers to Test:**
- Chrome (latest)
- Firefox (latest)
- Safari (latest, macOS)
- Edge (latest)

**Steps:**
1. Open invitation URL in each browser
2. Verify visual appearance matches design
3. Test accept flow in each browser

**Expected Results:**

| Browser | Visual ✅ | Accept Flow ✅ | Notes |
|---------|----------|---------------|-------|
| Chrome  |          |               |       |
| Firefox |          |               |       |
| Safari  |          |               |       |
| Edge    |          |               |       |

**Pass/Fail:** ______

**Notes:**

---

### Scenario 9: No Token in URL 🚫

**Objective:** Verify error handling when no token provided

**Steps:**
1. Open URL without token: `http://localhost:3080/accept-invitation.html`

**Expected Results:**
- ✅ Error message: "No invitation token provided in URL"
- ✅ Error state displays immediately (no API call)
- ✅ "Go to Dashboard" button visible

**Pass/Fail:** ______

**Notes:**

---

### Scenario 10: Network Error 🌐❌

**Objective:** Verify error handling when API is unavailable

**Setup:**
1. Stop AgentX server (or block network in DevTools)

**Steps:**
1. Open valid invitation URL
2. Wait for API call to fail

**Expected Results:**
- ✅ Loading spinner eventually times out
- ✅ Error message: "Unable to load invitation. Please try again later."
- ✅ "Go to Dashboard" or "Retry" button visible
- ✅ No JavaScript console errors (handled gracefully)

**Pass/Fail:** ______

**Notes:**

---

## Usability Testing

### Visual Design Assessment

**Rate each aspect (1-5, 5=excellent):**

| Aspect | Rating | Notes |
|--------|--------|-------|
| Visual appeal | __/5 | Gradient background, card design |
| Readability | __/5 | Text contrast, font sizes |
| Information hierarchy | __/5 | Workspace name prominent, details clear |
| Button design | __/5 | Colors, hover effects, spacing |
| Error messages | __/5 | Clear, actionable, friendly tone |
| Loading states | __/5 | Spinner, button feedback |

### User Experience Assessment

**Questions:**
1. Is it immediately clear what this page does? **Yes / No**
2. Is the invitation information easy to understand? **Yes / No**
3. Are the next steps obvious (accept vs decline)? **Yes / No**
4. Do error messages help you understand what went wrong? **Yes / No**
5. Does the page feel trustworthy? **Yes / No**

**Overall UX Rating:** __/5

**Improvement Suggestions:**

---

## Performance Testing

### Page Load Time

**Steps:**
1. Open invitation URL in Chrome DevTools Network tab
2. Record page load time (DOMContentLoaded)

**Results:**
- Load time: ______ ms
- API call `/api/invitations/validate/:token`: ______ ms
- Expected: < 2 seconds total

**Pass/Fail:** ______

### API Response Time

**Steps:**
1. Click "Accept Invitation"
2. Measure time from click to redirect

**Results:**
- API call `/api/invitations/accept`: ______ ms
- Total time (click to redirect): ______ ms
- Expected: < 3 seconds total

**Pass/Fail:** ______

---

## Security Testing

### XSS Protection

**Steps:**
1. Create invitation with malicious workspace name:
   ```javascript
   // In database:
   { name: "<script>alert('XSS')</script>" }
   ```
2. Open invitation URL

**Expected Results:**
- ✅ Script tag NOT executed
- ✅ Raw text displayed (HTML escaped)
- ✅ No alert popup

**Pass/Fail:** ______

### CSRF Protection

**Steps:**
1. Verify POST `/api/invitations/accept` requires proper authentication
2. Try calling API from external origin (e.g., Postman without cookies)

**Expected Results:**
- ✅ API returns 401 Unauthorized without valid session
- ✅ CORS policy blocks cross-origin requests

**Pass/Fail:** ______

---

## Accessibility Testing

### Keyboard Navigation

**Steps:**
1. Open invitation URL
2. Tab through all interactive elements

**Expected Results:**
- ✅ Can tab to "Accept Invitation" button
- ✅ Can tab to "Decline" button
- ✅ Focus indicators visible (outline or highlight)
- ✅ Can activate buttons with Enter/Space

**Pass/Fail:** ______

### Screen Reader Compatibility

**Steps:**
1. Enable screen reader (NVDA, JAWS, or macOS VoiceOver)
2. Navigate through page

**Expected Results:**
- ✅ Workspace name announced
- ✅ Invitation details readable
- ✅ Button labels clear ("Accept Invitation", "Decline")
- ✅ Error messages announced

**Pass/Fail:** ______

---

## Integration Testing

### Email Integration (If Configured)

**Steps:**
1. Create invitation via workspace settings
2. Check if email sent to recipient

**Expected Results:**
- ✅ Email received with invitation link
- ✅ Link includes correct token parameter
- ✅ Link works when clicked from email client

**Pass/Fail:** ______ (or N/A if email not configured)

### Workspace Settings Integration

**Steps:**
1. Accept invitation successfully
2. Navigate to Workspace Settings
3. Verify new member appears in list

**Expected Results:**
- ✅ User appears in Members table
- ✅ Role matches invitation (e.g., "Member")
- ✅ Status shows "Active"
- ✅ Can interact with workspace features

**Pass/Fail:** ______

### Audit Log Integration

**Steps:**
1. Accept invitation
2. Navigate to Workspace Audit Logs

**Expected Results:**
- ✅ Audit log entry created: "invitation.accepted"
- ✅ Entry shows: date, user, workspace, action
- ✅ Before/after state captured

**Pass/Fail:** ______

---

## Bug Report Template

**If you find issues, document them here:**

### Bug #1

**Title:** ___________________________

**Severity:** Critical / High / Medium / Low

**Steps to Reproduce:**
1.
2.
3.

**Expected Behavior:**

**Actual Behavior:**

**Screenshots:**

**Browser/Device:**

**Console Errors:**

---

## Test Summary

### Results

| Scenario | Pass/Fail | Notes |
|----------|-----------|-------|
| 1. Valid Invitation - Happy Path | ☐ | |
| 2. Invalid Token | ☐ | |
| 3. Expired Token | ☐ | |
| 4. Already Member | ☐ | |
| 5. Not Logged In | ☐ | |
| 6. Decline Invitation | ☐ | |
| 7. Mobile Responsiveness | ☐ | |
| 8. Browser Compatibility | ☐ | |
| 9. No Token in URL | ☐ | |
| 10. Network Error | ☐ | |

**Total Passed:** __/10
**Total Failed:** __/10

### Critical Issues Found

1.
2.
3.

### Minor Issues Found

1.
2.
3.

### Recommendations

1.
2.
3.

---

## Sign-Off

**Tester Name:** _______________________
**Date Completed:** _______________________
**Overall Status:** ☐ Approved for Production | ☐ Needs Fixes | ☐ Blocked

**Comments:**

---

**Next Steps:**
- [ ] Fix critical bugs (if any)
- [ ] Address usability feedback
- [ ] Re-test failed scenarios
- [ ] Deploy to production

---

**UAT Guide Version:** 1.0
**Last Updated:** 2026-01-07
