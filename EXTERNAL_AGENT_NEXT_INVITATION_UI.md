# External Agent Task: Build Invitation Acceptance UI

**Date:** 2026-01-07
**Priority:** HIGH
**Estimated Effort:** 4-6 hours
**Context:** Track 8 Phase 2 - UI Development for Headless Features

---

## Task Overview

Build a user-facing web page for accepting workspace invitations. Currently, users receive email invitations with tokens but have no landing page to view invitation details and accept/decline.

**What Exists:**
- ✅ Backend API routes (`/routes/invitations.js`) - Fully functional
- ✅ Admin UI (`/public/workspace-settings.html`) - Create/send invitations
- ❌ User acceptance UI - **MISSING (your task)**

**What You'll Build:**
- `/public/accept-invitation.html` - Invitation acceptance page
- JavaScript for API integration, validation, error handling
- Mobile-responsive design matching AgentX style

---

## User Flow

### Happy Path

1. **User receives email:** "You've been invited to join [Workspace Name]"
2. **Clicks link:** `http://localhost:3080/accept-invitation.html?token=abc123def456`
3. **Page loads:**
   - Extracts `?token=` from URL query params
   - Calls `GET /api/invitations/validate/:token`
   - Shows invitation details (workspace info, inviter, role, expiration)
4. **User reviews invitation:**
   - Workspace name & description
   - Invited by: [Username]
   - Your role: Member / Admin / Viewer
   - Expires: [Date and time]
5. **User clicks "Accept Invitation":**
   - Checks if user is logged in (if not, redirect to login with return URL)
   - Calls `POST /api/invitations/accept` with token
   - On success: Redirect to `/workspace-settings.html?workspace=[slug]`
6. **User clicks "Decline":**
   - Shows confirmation: "Are you sure you want to decline this invitation?"
   - On confirm: Close page or redirect to home (no API call needed)

### Error Paths

1. **Invalid/Expired Token:**
   - API returns 404 or `valid: false`
   - Show: "This invitation link is invalid or has expired. Please request a new invitation from your workspace admin."
   - Hide Accept/Decline buttons
   - Show "Go to Dashboard" button

2. **Already Accepted:**
   - API returns error: "You are already a member of this workspace"
   - Show: "You're already a member of [Workspace Name]. No further action needed."
   - Show "Go to Workspace Settings" button

3. **Not Logged In:**
   - User clicks Accept but `res.locals.user` is undefined
   - Show: "Please log in to accept this invitation"
   - Redirect to `/login.html?returnTo=/accept-invitation.html?token=[token]`

4. **API Errors:**
   - Network failure, 500 errors, etc.
   - Show: "Unable to load invitation. Please try again later."
   - Show "Retry" button

---

## API Endpoints

### 1. Validate Invitation Token

**Endpoint:** `GET /api/invitations/validate/:token`

**Purpose:** Check if token is valid and get invitation details

**Authentication:** None required (public endpoint)

**Example Request:**
```bash
curl -X GET http://localhost:3080/api/invitations/validate/abc123def456
```

**Success Response (200):**
```json
{
  "status": "success",
  "data": {
    "valid": true,
    "workspace": {
      "name": "Acme Corp Team",
      "description": "Main workspace for Acme Corp projects"
    },
    "role": "member",
    "invitedBy": {
      "username": "john.doe"
    },
    "expiresAt": "2026-01-14T12:00:00.000Z",
    "invitationStatus": "pending"
  }
}
```

**Error Response (404):**
```json
{
  "status": "error",
  "message": "Invalid or expired invitation"
}
```

### 2. Accept Invitation

**Endpoint:** `POST /api/invitations/accept`

**Purpose:** Accept invitation and add user to workspace

**Authentication:** Required (`requireAuth` middleware)

**Example Request:**
```bash
curl -X POST http://localhost:3080/api/invitations/accept \
  -H "Content-Type: application/json" \
  -d '{"token": "abc123def456"}' \
  --cookie "connect.sid=..."
```

**Success Response (200):**
```json
{
  "status": "success",
  "message": "Invitation accepted successfully",
  "data": {
    "workspace": {
      "name": "Acme Corp Team",
      "slug": "acme-corp-team"
    },
    "member": {
      "role": "member",
      "permissions": {
        "chat": true,
        "rag": true,
        "models": false,
        "benchmark": false,
        "alerts": false,
        "settings": false
      }
    }
  }
}
```

**Error Responses:**
- **400:** `{"status": "error", "message": "Invitation token is required"}`
- **404:** `{"status": "error", "message": "Invitation not found or expired"}`
- **409:** `{"status": "error", "message": "You are already a member of this workspace"}`
- **500:** `{"status": "error", "message": "Failed to accept invitation"}`

---

## UI Design Specifications

### Page Structure

**File:** `/public/accept-invitation.html`

**Layout:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Accept Invitation | AgentX</title>
    <link rel="stylesheet" href="styles.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        /* Centered card design for invitation */
        .invitation-container {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 2rem;
        }

        .invitation-card {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            padding: 3rem;
            text-align: center;
        }

        .invitation-icon {
            font-size: 4rem;
            color: #667eea;
            margin-bottom: 1rem;
        }

        .workspace-name {
            font-size: 1.8rem;
            font-weight: 700;
            color: #1a202c;
            margin-bottom: 0.5rem;
        }

        .invitation-details {
            background: #f7fafc;
            border-radius: 8px;
            padding: 1.5rem;
            margin: 1.5rem 0;
            text-align: left;
        }

        .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 1rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid #e2e8f0;
        }

        .detail-row:last-child {
            margin-bottom: 0;
            padding-bottom: 0;
            border-bottom: none;
        }

        .detail-label {
            color: #718096;
            font-weight: 500;
        }

        .detail-value {
            color: #1a202c;
            font-weight: 600;
        }

        .role-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.85rem;
            font-weight: 600;
            text-transform: uppercase;
        }

        .role-owner { background: #ffd700; color: #1a202c; }
        .role-admin { background: #f56565; color: white; }
        .role-member { background: #48bb78; color: white; }
        .role-viewer { background: #cbd5e0; color: #1a202c; }

        .btn-group {
            display: flex;
            gap: 1rem;
            margin-top: 2rem;
        }

        .btn {
            flex: 1;
            padding: 1rem;
            border: none;
            border-radius: 8px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }

        .btn-primary {
            background: #667eea;
            color: white;
        }

        .btn-primary:hover {
            background: #5a67d8;
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .btn-secondary {
            background: #e2e8f0;
            color: #4a5568;
        }

        .btn-secondary:hover {
            background: #cbd5e0;
        }

        .error-container {
            background: #fff5f5;
            border: 2px solid #fc8181;
            border-radius: 8px;
            padding: 1.5rem;
            margin: 1.5rem 0;
        }

        .error-icon {
            color: #f56565;
            font-size: 3rem;
            margin-bottom: 1rem;
        }

        .error-message {
            color: #742a2a;
            font-size: 1rem;
            margin-bottom: 1rem;
        }

        .loading-spinner {
            border: 4px solid #e2e8f0;
            border-top: 4px solid #667eea;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 2rem auto;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        @media (max-width: 600px) {
            .invitation-container {
                padding: 1rem;
            }

            .invitation-card {
                padding: 2rem;
            }

            .btn-group {
                flex-direction: column;
            }
        }
    </style>
</head>
<body>
    <div class="invitation-container">
        <div class="invitation-card">
            <!-- Loading State -->
            <div id="loadingState">
                <div class="loading-spinner"></div>
                <p>Loading invitation...</p>
            </div>

            <!-- Valid Invitation State -->
            <div id="validInvitation" style="display: none;">
                <i class="fas fa-envelope-open-text invitation-icon"></i>
                <h1 class="workspace-name" id="workspaceName">Loading...</h1>
                <p id="workspaceDescription" style="color: #718096; margin-bottom: 1rem;">Loading...</p>

                <div class="invitation-details">
                    <div class="detail-row">
                        <span class="detail-label">Invited by</span>
                        <span class="detail-value" id="invitedBy">-</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Your role</span>
                        <span class="detail-value">
                            <span id="roleBadge" class="role-badge">-</span>
                        </span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Expires</span>
                        <span class="detail-value" id="expiresAt">-</span>
                    </div>
                </div>

                <div class="btn-group">
                    <button class="btn btn-primary" id="acceptBtn" onclick="acceptInvitation()">
                        <i class="fas fa-check"></i> Accept Invitation
                    </button>
                    <button class="btn btn-secondary" id="declineBtn" onclick="declineInvitation()">
                        <i class="fas fa-times"></i> Decline
                    </button>
                </div>
            </div>

            <!-- Error State -->
            <div id="errorState" style="display: none;">
                <div class="error-container">
                    <i class="fas fa-exclamation-triangle error-icon"></i>
                    <p class="error-message" id="errorMessage">An error occurred</p>
                    <button class="btn btn-primary" onclick="window.location.href='/'">
                        Go to Dashboard
                    </button>
                </div>
            </div>
        </div>
    </div>

    <script>
        // State management
        let invitationToken = null;
        let invitationData = null;

        // On page load
        document.addEventListener('DOMContentLoaded', async () => {
            // Extract token from URL
            const params = new URLSearchParams(window.location.search);
            invitationToken = params.get('token');

            if (!invitationToken) {
                showError('No invitation token provided in URL');
                return;
            }

            await loadInvitation();
        });

        // Load and validate invitation
        async function loadInvitation() {
            try {
                const res = await fetch(`/api/invitations/validate/${invitationToken}`);
                const data = await res.json();

                if (!res.ok || data.status === 'error' || !data.data.valid) {
                    showError(data.message || 'This invitation is invalid or has expired');
                    return;
                }

                invitationData = data.data;
                displayInvitation();

            } catch (error) {
                console.error('Error loading invitation:', error);
                showError('Unable to load invitation. Please try again later.');
            }
        }

        // Display invitation details
        function displayInvitation() {
            // Hide loading, show invitation
            document.getElementById('loadingState').style.display = 'none';
            document.getElementById('validInvitation').style.display = 'block';

            // Populate fields
            document.getElementById('workspaceName').textContent = invitationData.workspace.name;
            document.getElementById('workspaceDescription').textContent =
                invitationData.workspace.description || 'Join this workspace to collaborate with your team';
            document.getElementById('invitedBy').textContent = invitationData.invitedBy.username;

            // Role badge
            const roleEl = document.getElementById('roleBadge');
            roleEl.textContent = invitationData.role;
            roleEl.className = `role-badge role-${invitationData.role.toLowerCase()}`;

            // Expiration (format date nicely)
            const expiresDate = new Date(invitationData.expiresAt);
            document.getElementById('expiresAt').textContent = expiresDate.toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        }

        // Accept invitation
        async function acceptInvitation() {
            const acceptBtn = document.getElementById('acceptBtn');
            const declineBtn = document.getElementById('declineBtn');

            // Disable buttons
            acceptBtn.disabled = true;
            declineBtn.disabled = true;
            acceptBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Accepting...';

            try {
                const res = await fetch('/api/invitations/accept', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ token: invitationToken })
                });

                const data = await res.json();

                if (res.status === 401) {
                    // Not logged in - redirect to login with return URL
                    window.location.href = `/login.html?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
                    return;
                }

                if (!res.ok) {
                    throw new Error(data.message || 'Failed to accept invitation');
                }

                // Success! Redirect to workspace settings
                const workspaceSlug = data.data.workspace.slug;
                window.location.href = `/workspace-settings.html?workspace=${workspaceSlug}`;

            } catch (error) {
                console.error('Error accepting invitation:', error);
                alert(`Error: ${error.message}`);

                // Re-enable buttons
                acceptBtn.disabled = false;
                declineBtn.disabled = false;
                acceptBtn.innerHTML = '<i class="fas fa-check"></i> Accept Invitation';
            }
        }

        // Decline invitation
        function declineInvitation() {
            if (confirm('Are you sure you want to decline this invitation?')) {
                // Just close or redirect to home
                window.location.href = '/';
            }
        }

        // Show error state
        function showError(message) {
            document.getElementById('loadingState').style.display = 'none';
            document.getElementById('validInvitation').style.display = 'none';
            document.getElementById('errorState').style.display = 'block';
            document.getElementById('errorMessage').textContent = message;
        }
    </script>
</body>
</html>
```

---

## Acceptance Criteria

### Functional Requirements

1. ✅ **Token Extraction:**
   - Parse `?token=` from URL query parameters
   - Handle missing token gracefully

2. ✅ **Invitation Validation:**
   - Call `GET /api/invitations/validate/:token` on page load
   - Display invitation details if valid
   - Show error message if invalid/expired

3. ✅ **Accept Flow:**
   - Call `POST /api/invitations/accept` with token
   - Check authentication status (redirect to login if needed)
   - Redirect to workspace settings on success
   - Handle errors (already member, expired, network issues)

4. ✅ **Decline Flow:**
   - Show confirmation dialog
   - Redirect to dashboard (no API call)

5. ✅ **Error Handling:**
   - Invalid token → Error message + "Go to Dashboard" button
   - Not logged in → Redirect to login with return URL
   - Already member → Friendly message + "Go to Workspace" button
   - Network errors → Retry button

### UI Requirements

1. ✅ **Visual Design:**
   - Centered card layout with gradient background
   - Mobile-responsive (works on phones)
   - Font Awesome icons for visual appeal
   - Smooth transitions and hover effects

2. ✅ **Information Display:**
   - Workspace name prominently displayed
   - Role badge with color coding (Owner/Admin/Member/Viewer)
   - Invited by username
   - Expiration date formatted nicely

3. ✅ **Loading States:**
   - Spinner while loading invitation
   - "Accepting..." state when submitting
   - Disabled buttons during API calls

4. ✅ **Accessibility:**
   - Semantic HTML
   - Readable text contrast
   - Clear error messages
   - Keyboard navigation support

---

## Testing Checklist

### Before Submission

1. **Test Valid Invitation:**
   - Create invitation via workspace-settings.html
   - Copy token from database or email logs
   - Visit: `http://localhost:3080/accept-invitation.html?token=[token]`
   - Verify invitation details display correctly
   - Click "Accept" → Should redirect to workspace settings

2. **Test Invalid Token:**
   - Visit: `http://localhost:3080/accept-invitation.html?token=INVALID123`
   - Verify error message displays
   - Verify "Go to Dashboard" button works

3. **Test Expired Invitation:**
   - Manually expire invitation in database (set `expiresAt` to past date)
   - Visit with expired token
   - Verify "expired" error message

4. **Test Already Member:**
   - Accept invitation once
   - Try accepting same invitation again
   - Verify "already a member" message

5. **Test Not Logged In:**
   - Log out
   - Visit invitation link
   - Click "Accept"
   - Verify redirect to login page
   - Verify return URL is preserved

6. **Test Mobile Responsive:**
   - Open in Chrome DevTools mobile view
   - Verify card layout adjusts properly
   - Verify buttons stack vertically
   - Verify text is readable

7. **Test Decline:**
   - Click "Decline" button
   - Verify confirmation dialog appears
   - Confirm decline → Should redirect to dashboard

---

## Additional Context

### Existing Invitation System

**Create Invitation (Admin Side):**
- File: `/public/workspace-settings.html`
- Function: `inviteMember(e)` at line ~880
- Calls: `POST /api/workspaces/:slug/members`
- Creates `WorkspaceInvitation` document in database
- Sends email with acceptance link (if email service configured)

**Backend Routes:**
- File: `/routes/invitations.js`
- Dependencies: `WorkspaceInvitation` model, `WorkspaceMember` model
- Audit logging: `logInvitationAction()` middleware

**Database Models:**
- `WorkspaceInvitation` (`/models/WorkspaceInvitation.js`)
  - Fields: `workspaceId`, `email`, `role`, `token`, `expiresAt`, `status`
  - Methods: `findByToken(token)`, `isValid` getter

- `WorkspaceMember` (`/models/WorkspaceMember.js`)
  - Fields: `workspaceId`, `userId`, `role`, `permissions`, `status`
  - Methods: `inviteMember()`, `getMember()`, `isMember()`

### Design System

**AgentX uses:**
- **Colors:** Primary blue (`#667eea`), success green (`#48bb78`), error red (`#f56565`)
- **Typography:** System font stack, 16px base
- **Spacing:** 8px grid (0.5rem, 1rem, 1.5rem, 2rem, 3rem)
- **Borders:** 8px radius for cards, 4px for badges
- **Shadows:** `0 20px 60px rgba(0,0,0,0.3)` for elevated cards

**Similar Pages for Reference:**
- `/public/login.html` - Authentication page (similar card layout)
- `/public/workspace-settings.html` - Workspace management (role badges)

---

## Deliverables

1. ✅ **HTML File:** `/public/accept-invitation.html`
   - Complete page with embedded CSS and JavaScript
   - Mobile-responsive design
   - Error handling for all edge cases

2. ✅ **Testing:** Manually test all scenarios in checklist above

3. ✅ **Documentation:** Add brief comment at top of file explaining purpose

---

## Success Metrics

After implementation:
- ✅ Users can accept invitations via email links
- ✅ Error states are handled gracefully
- ✅ Mobile users have good experience
- ✅ Authentication flow works correctly
- ✅ No JavaScript console errors

---

## Questions?

If you encounter issues:
1. Check `/routes/invitations.js` for exact API response format
2. Reference `/public/workspace-settings.html` for invitation creation flow
3. Check browser console for JavaScript errors
4. Test with actual invitation tokens from database

**Good luck! This is a high-priority feature that completes the workspace collaboration experience.**
