# AgentX Action Items
## Detailed Task Breakdown - Updated: 2026-01-01

This document provides actionable tasks for each priority in the global development plan. Each task includes acceptance criteria and technical details.

---

## 🔴 Priority 1: Prompt Management UI

### Phase 1.1: UI Design & Architecture (Days 1-2)

#### Task 1.1.1: Review Existing Frontend Patterns
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 4 hours

**Description:**
Analyze existing frontend code to understand patterns, conventions, and reusable components.

**Action Items:**
- [ ] Read `/public/analytics.html` (18,779 bytes) - Study layout, component structure
- [ ] Read `/public/dashboard.html` (18,464 bytes) - Understand navigation patterns
- [ ] Read `/public/js/utils/apiClient.js` - Review API client implementation
- [ ] Document reusable patterns:
  - API error handling
  - Loading states
  - Modal/dialog implementation
  - Form validation
  - Toast notifications
- [ ] Identify CSS framework (if any) or vanilla CSS approach
- [ ] Check for JavaScript framework usage (React, Vue, or vanilla JS)

**Acceptance Criteria:**
- [ ] Document created: `/docs/frontend-patterns.md` with reusable components
- [ ] Decision made: Use existing patterns or introduce new framework

---

#### Task 1.1.2: Design UI Mockups
**Owner:** Frontend Developer / UX Designer
**Status:** ⚪ Not Started
**Estimated Hours:** 6 hours

**Description:**
Create wireframes and mockups for all prompt management screens.

**Action Items:**
- [ ] Sketch wireframes for 5 main screens:
  1. **Prompt List View** - Gallery of all prompts grouped by name
  2. **Prompt Editor** - Create/edit prompt form
  3. **A/B Test Config** - Traffic weight configuration
  4. **Template Tester** - Variable input and render preview
  5. **Performance Dashboard** - Per-prompt metrics
- [ ] Define user flows:
  - New user onboarding
  - Create new prompt
  - Edit existing prompt
  - Configure A/B test
  - View performance metrics
- [ ] Create mockups (Figma, Sketch, or HTML prototypes)
- [ ] Review mockups with stakeholders

**Acceptance Criteria:**
- [ ] 5 wireframes created and approved
- [ ] User flows documented
- [ ] Visual design guidelines defined (colors, typography, spacing)

---

#### Task 1.1.3: Define Component Architecture
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 4 hours

**Description:**
Plan component structure and state management approach.

**Action Items:**
- [ ] Define component hierarchy:
  ```
  PromptManagementPage
  ├── PromptListView
  │   ├── PromptCard (repeating)
  │   └── CreatePromptButton
  ├── PromptEditorModal
  │   ├── EditorToolbar
  │   ├── CodeEditor (Monaco or CodeMirror)
  │   └── SaveButton
  ├── ABTestConfigPanel
  │   ├── VersionSelector
  │   ├── TrafficWeightSlider (repeating)
  │   └── ValidationMessage
  ├── TemplateTester
  │   ├── VariableInputForm
  │   └── RenderPreview
  └── PerformanceMetrics
      ├── MetricCard (repeating)
      └── TrendChart
  ```
- [ ] Decide state management:
  - Vanilla JS with event emitters
  - OR lightweight library (Zustand, Jotai)
- [ ] Plan data flow (API → State → UI)
- [ ] Document component API (props, events)

**Acceptance Criteria:**
- [ ] Component architecture documented in `/docs/prompt-ui-components.md`
- [ ] State management approach decided and documented
- [ ] Data flow diagram created

---

### Phase 1.2: Core Prompt Management (Days 3-5)

#### Task 1.2.1: Create Prompt Management Page
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 6 hours

**Description:**
Build main HTML page and navigation integration.

**Action Items:**
- [ ] Create `/public/prompts.html`:
  ```html
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Prompt Management - AgentX</title>
    <link rel="stylesheet" href="/css/style.css">
    <link rel="stylesheet" href="/css/prompts.css">
  </head>
  <body>
    <div id="nav-container"></div>
    <main id="prompt-app">
      <header>
        <h1>Prompt Management</h1>
        <button id="create-prompt-btn">Create New Prompt</button>
      </header>
      <div id="prompt-list"></div>
      <div id="modals"></div>
    </main>
    <script src="/js/utils/apiClient.js"></script>
    <script src="/js/prompts.js" type="module"></script>
  </body>
  </html>
  ```
- [ ] Add navigation link in `/public/js/components/nav.js`:
  ```javascript
  { label: 'Prompts', href: '/prompts.html', icon: 'settings' }
  ```
- [ ] Create `/public/css/prompts.css` for styling
- [ ] Test page loads correctly
- [ ] Verify navigation works from dashboard

**Acceptance Criteria:**
- [ ] `/prompts.html` accessible at `http://localhost:3080/prompts.html`
- [ ] Navigation link visible in dashboard
- [ ] Page renders without console errors

---

#### Task 1.2.2: Implement API Client Wrapper
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 4 hours

**Description:**
Create JavaScript module for prompt API interactions.

**Action Items:**
- [ ] Create `/public/js/api/promptsAPI.js`:
  ```javascript
  export class PromptsAPI {
    constructor(baseURL = '/api/prompts') {
      this.baseURL = baseURL;
    }

    async listAll() {
      const response = await fetch(this.baseURL);
      return this.handleResponse(response);
    }

    async getByName(name) {
      const response = await fetch(`${this.baseURL}/${encodeURIComponent(name)}`);
      return this.handleResponse(response);
    }

    async create(promptData) {
      const response = await fetch(this.baseURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(promptData)
      });
      return this.handleResponse(response);
    }

    async update(id, promptData) {
      const response = await fetch(`${this.baseURL}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(promptData)
      });
      return this.handleResponse(response);
    }

    async delete(id) {
      const response = await fetch(`${this.baseURL}/${id}`, { method: 'DELETE' });
      return this.handleResponse(response);
    }

    async configureABTest(name, versions) {
      const response = await fetch(`${this.baseURL}/${encodeURIComponent(name)}/ab-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versions })
      });
      return this.handleResponse(response);
    }

    async renderTemplate(name, variables) {
      const response = await fetch(`${this.baseURL}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptName: name, variables })
      });
      return this.handleResponse(response);
    }

    async handleResponse(response) {
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'API request failed');
      }
      return response.json();
    }
  }
  ```
- [ ] Add error handling for network failures
- [ ] Add retry logic for transient errors (optional)
- [ ] Test all API methods with curl/Postman first

**Acceptance Criteria:**
- [ ] API client module created and tested
- [ ] All 7 prompt endpoints accessible via client
- [ ] Error handling works correctly

---

#### Task 1.2.3: Build Prompt List View
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 8 hours

**Description:**
Display all prompts grouped by name with version management.

**Action Items:**
- [ ] Create `/public/js/components/PromptListView.js`:
  ```javascript
  export class PromptListView {
    constructor(container, api) {
      this.container = container;
      this.api = api;
      this.prompts = [];
    }

    async render() {
      // Fetch all prompts
      const data = await this.api.listAll();
      this.prompts = data.prompts; // Grouped by name

      // Clear container
      this.container.innerHTML = '';

      // Render each prompt group
      this.prompts.forEach(group => {
        const card = this.createPromptCard(group);
        this.container.appendChild(card);
      });
    }

    createPromptCard(group) {
      const card = document.createElement('div');
      card.className = 'prompt-card';
      card.innerHTML = `
        <h3>${group.name}</h3>
        <p class="description">${group.description || 'No description'}</p>
        <div class="versions">
          ${group.versions.map(v => this.renderVersion(v)).join('')}
        </div>
        <div class="actions">
          <button class="edit-btn" data-name="${group.name}">Edit</button>
          <button class="ab-test-btn" data-name="${group.name}">A/B Test</button>
          <button class="metrics-btn" data-name="${group.name}">Metrics</button>
        </div>
      `;
      this.attachEventListeners(card, group);
      return card;
    }

    renderVersion(version) {
      const statusBadge = version.status === 'active'
        ? '<span class="badge active">Active</span>'
        : '<span class="badge inactive">Inactive</span>';
      const traffic = version.trafficWeight || 0;
      return `
        <div class="version">
          <span class="version-number">v${version.version}</span>
          ${statusBadge}
          <span class="traffic">${traffic}% traffic</span>
        </div>
      `;
    }

    attachEventListeners(card, group) {
      // Edit button
      card.querySelector('.edit-btn').addEventListener('click', () => {
        this.emit('edit-prompt', group);
      });
      // A/B test button
      card.querySelector('.ab-test-btn').addEventListener('click', () => {
        this.emit('configure-ab-test', group);
      });
      // Metrics button
      card.querySelector('.metrics-btn').addEventListener('click', () => {
        this.emit('view-metrics', group);
      });
    }

    emit(event, data) {
      const customEvent = new CustomEvent(event, { detail: data });
      this.container.dispatchEvent(customEvent);
    }
  }
  ```
- [ ] Style prompt cards with CSS
- [ ] Add loading spinner during data fetch
- [ ] Add empty state ("No prompts yet")
- [ ] Test with multiple prompt groups

**Acceptance Criteria:**
- [ ] Prompt list displays all prompts grouped by name
- [ ] Each card shows versions with status badges
- [ ] Action buttons trigger correct events
- [ ] Loading and empty states work

---

#### Task 1.2.4: Implement Create Prompt Form
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 8 hours

**Description:**
Build modal form for creating new prompts.

**Action Items:**
- [ ] Create `/public/js/components/PromptEditorModal.js` with CodeMirror or Monaco editor
- [ ] Form fields:
  - Name (text input, required)
  - System Prompt (code editor, required)
  - Description (textarea, optional)
  - Author (text input, default to current user)
  - Tags (comma-separated, optional)
- [ ] Add form validation:
  - Name: 1-50 characters, alphanumeric + underscores
  - System Prompt: 10-5000 characters
- [ ] Implement modal open/close logic
- [ ] Handle form submission:
  ```javascript
  async handleSubmit(formData) {
    try {
      await this.api.create(formData);
      this.showSuccess('Prompt created successfully');
      this.emit('prompt-created');
    } catch (error) {
      this.showError(error.message);
    }
  }
  ```
- [ ] Add "Save" and "Cancel" buttons
- [ ] Test form validation edge cases

**Acceptance Criteria:**
- [ ] Modal opens when "Create New Prompt" clicked
- [ ] Form validation works correctly
- [ ] Successful creation refreshes prompt list
- [ ] Error messages display for validation failures

---

#### Task 1.2.5: Implement Edit Metadata Modal
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 4 hours

**Description:**
Allow editing prompt metadata (description, tags) for inactive prompts.

**Action Items:**
- [ ] Reuse PromptEditorModal component in "edit mode"
- [ ] Disable system prompt editing (per backend constraint)
- [ ] Show warning: "Cannot edit system prompt. Create new version instead."
- [ ] Allow editing:
  - Description
  - Tags
- [ ] Implement `PUT /api/prompts/:id` call
- [ ] Test with inactive vs active prompts (backend should reject active edits)

**Acceptance Criteria:**
- [ ] Edit modal opens with current data
- [ ] System prompt field is disabled
- [ ] Metadata updates successfully
- [ ] Backend rejection of active prompt edits handled gracefully

---

#### Task 1.2.6: Implement Delete Confirmation
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 2 hours

**Description:**
Add delete functionality with confirmation dialog.

**Action Items:**
- [ ] Add "Delete" button to prompt cards (only for inactive prompts)
- [ ] Show confirmation modal:
  ```javascript
  showDeleteConfirmation(prompt) {
    const confirmed = confirm(`Delete prompt "${prompt.name}" v${prompt.version}?\nThis action cannot be undone.`);
    if (confirmed) {
      this.handleDelete(prompt._id);
    }
  }
  ```
- [ ] Implement `DELETE /api/prompts/:id` call
- [ ] Refresh prompt list after successful deletion
- [ ] Handle errors (e.g., trying to delete active prompt)

**Acceptance Criteria:**
- [ ] Delete button only appears for inactive prompts
- [ ] Confirmation modal prevents accidental deletion
- [ ] Deletion removes prompt from list
- [ ] Error handling prevents deleting active prompts

---

### Phase 1.3: A/B Testing Configuration (Days 6-7)

#### Task 1.3.1: Design Traffic Weight UI
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 6 hours

**Description:**
Create interactive UI for configuring A/B test traffic weights.

**Action Items:**
- [ ] Create `/public/js/components/ABTestConfigPanel.js`
- [ ] Design layout:
  - List of active versions for a prompt name
  - Slider for each version (0-100%)
  - Visual bar showing distribution
  - Total weight indicator (must sum to 100)
- [ ] Implement sliders with range inputs:
  ```html
  <div class="version-weight">
    <label>Version ${version} <span class="weight-value">50%</span></label>
    <input type="range" min="0" max="100" value="50" data-version="${version}">
  </div>
  ```
- [ ] Add visual distribution bar:
  ```html
  <div class="distribution-bar">
    <div class="segment" style="width: 50%; background: blue;">v1: 50%</div>
    <div class="segment" style="width: 30%; background: green;">v2: 30%</div>
    <div class="segment" style="width: 20%; background: orange;">v3: 20%</div>
  </div>
  ```
- [ ] Implement real-time validation (weights sum to 100)
- [ ] Add "Auto-balance" button (distributes weights evenly)

**Acceptance Criteria:**
- [ ] Sliders allow setting traffic weights for each version
- [ ] Visual bar updates in real-time
- [ ] Validation prevents saving if total ≠ 100
- [ ] Auto-balance feature works correctly

---

#### Task 1.3.2: Integrate A/B Test API
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 4 hours

**Description:**
Connect A/B test UI to backend API.

**Action Items:**
- [ ] Implement form submission handler:
  ```javascript
  async submitABTest(promptName, versions) {
    // versions = [{ version: 1, trafficWeight: 50 }, ...]
    try {
      await this.api.configureABTest(promptName, versions);
      this.showSuccess('A/B test configured successfully');
      this.emit('ab-test-updated');
    } catch (error) {
      this.showError(error.message);
    }
  }
  ```
- [ ] Add loading state during API call
- [ ] Handle validation errors from backend
- [ ] Refresh prompt list after successful update
- [ ] Test with various weight combinations

**Acceptance Criteria:**
- [ ] A/B test configuration saves successfully
- [ ] Backend validation errors display correctly
- [ ] Prompt list reflects new traffic weights
- [ ] Loading state prevents duplicate submissions

---

#### Task 1.3.3: Add Quick Rollback Feature
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 3 hours

**Description:**
Allow quick rollback to a single version (disable A/B test).

**Action Items:**
- [ ] Add "Rollback to this version" button on each version card
- [ ] Implement rollback logic:
  ```javascript
  async rollbackToVersion(promptName, version) {
    // Set selected version to 100%, others to 0%
    const versions = [{ version: version, trafficWeight: 100 }];
    await this.submitABTest(promptName, versions);
  }
  ```
- [ ] Show confirmation dialog before rollback
- [ ] Test rollback with multiple active versions
- [ ] Verify backend correctly deactivates other versions

**Acceptance Criteria:**
- [ ] Rollback button visible on each version
- [ ] Confirmation prevents accidental rollback
- [ ] Rollback sets single version to 100% traffic
- [ ] Other versions remain inactive but available

---

### Phase 1.4: Template Rendering & Testing (Day 8)

#### Task 1.4.1: Build Template Tester UI
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 6 hours

**Description:**
Create interface for testing prompt templates with variables.

**Action Items:**
- [ ] Create `/public/js/components/TemplateTester.js`
- [ ] Detect template variables in system prompt:
  ```javascript
  extractVariables(systemPrompt) {
    // Match {{variable}} syntax
    const regex = /\{\{(\w+)\}\}/g;
    const variables = new Set();
    let match;
    while ((match = regex.exec(systemPrompt)) !== null) {
      variables.add(match[1]);
    }
    return Array.from(variables);
  }
  ```
- [ ] Generate input form dynamically:
  ```javascript
  renderVariableInputs(variables) {
    return variables.map(varName => `
      <div class="variable-input">
        <label for="${varName}">${varName}</label>
        <input type="text" id="${varName}" name="${varName}" placeholder="Enter ${varName}">
      </div>
    `).join('');
  }
  ```
- [ ] Add "Render Template" button
- [ ] Display rendered output in preview pane
- [ ] Add "Copy to Clipboard" button

**Acceptance Criteria:**
- [ ] Template variables detected automatically
- [ ] Input form generated dynamically
- [ ] Rendered output displays correctly
- [ ] Copy to clipboard works

---

#### Task 1.4.2: Integrate Template Rendering API
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 2 hours

**Description:**
Connect template tester to backend rendering API.

**Action Items:**
- [ ] Implement API call:
  ```javascript
  async renderTemplate(promptName, variables) {
    const response = await this.api.renderTemplate(promptName, variables);
    return response.rendered;
  }
  ```
- [ ] Handle rendering errors (missing variables, syntax errors)
- [ ] Show loading state during rendering
- [ ] Test with complex templates

**Acceptance Criteria:**
- [ ] Template renders successfully with provided variables
- [ ] Error messages display for invalid templates
- [ ] Loading state prevents duplicate renders

---

### Phase 1.5: Performance Dashboard Integration (Days 9-10)

#### Task 1.5.1: Fetch Per-Prompt Metrics
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 4 hours

**Description:**
Retrieve and display performance metrics for each prompt.

**Action Items:**
- [ ] Create API client method:
  ```javascript
  async getPromptMetrics(promptName) {
    const response = await fetch(`/api/analytics/feedback?promptName=${encodeURIComponent(promptName)}`);
    return response.json();
  }
  ```
- [ ] Fetch metrics when user clicks "Metrics" button
- [ ] Parse response:
  ```javascript
  {
    promptName: "default_chat",
    totalConversations: 150,
    positiveCount: 120,
    negativeCount: 30,
    positiveRate: 0.80,
    avgResponseTime: 2500
  }
  ```
- [ ] Cache metrics to avoid redundant API calls

**Acceptance Criteria:**
- [ ] Metrics fetched successfully for each prompt
- [ ] Response parsed correctly
- [ ] Caching reduces redundant requests

---

#### Task 1.5.2: Build Performance Metrics Cards
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 6 hours

**Description:**
Display metrics in visual cards with trends.

**Action Items:**
- [ ] Create `/public/js/components/PerformanceMetrics.js`
- [ ] Design metric cards:
  ```html
  <div class="metric-card">
    <h4>Total Impressions</h4>
    <p class="metric-value">150</p>
    <span class="trend positive">↑ 12% vs last week</span>
  </div>
  ```
- [ ] Implement metrics:
  - Total impressions
  - Positive rate (with visual gauge)
  - Negative rate
  - Average response time
  - Recent trend (7-day comparison)
- [ ] Add visual indicators:
  - Green badge for > 70% positive rate
  - Yellow badge for 50-70%
  - Red badge for < 50%
- [ ] Integrate Chart.js for trend sparklines

**Acceptance Criteria:**
- [ ] Metric cards display all key metrics
- [ ] Visual indicators reflect performance
- [ ] Trend sparklines show 7-day history
- [ ] Low performers highlighted in red

---

#### Task 1.5.3: Link to Full Analytics Page
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 2 hours

**Description:**
Add navigation to detailed analytics dashboard.

**Action Items:**
- [ ] Add "View Detailed Analytics" link in metrics panel
- [ ] Pass prompt name as query parameter:
  ```javascript
  window.location.href = `/analytics.html?promptName=${encodeURIComponent(promptName)}`;
  ```
- [ ] Update `/public/analytics.html` to filter by prompt name if parameter exists
- [ ] Add breadcrumb navigation (Analytics → Prompt Metrics → [Prompt Name])

**Acceptance Criteria:**
- [ ] Link navigates to analytics page
- [ ] Analytics page filters by prompt name
- [ ] Breadcrumb navigation works

---

### Phase 1.6: User Onboarding Flow (Days 11-12)

#### Task 1.6.1: Create Onboarding Wizard Modal
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 8 hours

**Description:**
Build step-by-step onboarding wizard for new users.

**Action Items:**
- [ ] Create `/public/js/components/OnboardingWizard.js`
- [ ] Design 4-step wizard:
  1. **Welcome** - Explain prompt management
  2. **Select or Create Prompt** - Choose default or create custom
  3. **Test Prompt** - Try sample queries
  4. **Configure Profile** - Set user preferences
- [ ] Implement step navigation (Next, Back, Skip)
- [ ] Add progress indicator (Step 1 of 4)
- [ ] Store completion status in localStorage or UserProfile
- [ ] Show wizard on first visit to chat interface

**Acceptance Criteria:**
- [ ] Wizard displays on first visit
- [ ] All 4 steps functional
- [ ] Wizard can be skipped
- [ ] Completion status persisted

---

#### Task 1.6.2: Integrate with User Profile
**Owner:** Frontend Developer + Backend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 4 hours

**Description:**
Store onboarding completion status in UserProfile model.

**Action Items:**
- [ ] **Backend:** Add field to UserProfile schema:
  ```javascript
  onboardingCompleted: { type: Boolean, default: false },
  onboardingCompletedAt: { type: Date }
  ```
- [ ] **Backend:** Create endpoint: `POST /api/user/profile/onboarding-complete`
- [ ] **Frontend:** Call endpoint when wizard completes:
  ```javascript
  async completeOnboarding() {
    await fetch('/api/user/profile/onboarding-complete', { method: 'POST' });
    this.hideWizard();
  }
  ```
- [ ] **Frontend:** Check onboarding status on page load:
  ```javascript
  async checkOnboarding() {
    const profile = await fetch('/api/user/profile').then(r => r.json());
    if (!profile.onboardingCompleted) {
      this.showOnboardingWizard();
    }
  }
  ```

**Acceptance Criteria:**
- [ ] Onboarding status stored in database
- [ ] Wizard only shows for users who haven't completed it
- [ ] Wizard can be manually triggered from settings

---

### Phase 1.7: Integration & Polish (Days 13-14)

#### Task 1.7.1: Add Responsive Design
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 4 hours

**Description:**
Ensure UI works on mobile and tablet devices.

**Action Items:**
- [ ] Add CSS media queries for breakpoints:
  - Mobile: < 768px
  - Tablet: 768px - 1024px
  - Desktop: > 1024px
- [ ] Test all components on mobile (Chrome DevTools)
- [ ] Adjust layouts:
  - Stack cards vertically on mobile
  - Collapse navigation on mobile
  - Adjust font sizes for readability
- [ ] Test touch interactions (sliders, buttons)

**Acceptance Criteria:**
- [ ] UI usable on mobile devices
- [ ] Touch interactions work correctly
- [ ] Text readable without zooming

---

#### Task 1.7.2: Error Handling & Loading States
**Owner:** Frontend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 4 hours

**Description:**
Add comprehensive error handling and loading indicators.

**Action Items:**
- [ ] Add loading spinners for all async operations
- [ ] Implement error toast notifications:
  ```javascript
  showError(message) {
    const toast = document.createElement('div');
    toast.className = 'toast error';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }
  ```
- [ ] Handle common errors:
  - Network failures
  - Backend validation errors
  - Timeout errors
- [ ] Add retry buttons for failed operations
- [ ] Test error scenarios (disconnect network, invalid input)

**Acceptance Criteria:**
- [ ] Loading spinners appear for all async operations
- [ ] Error messages display clearly
- [ ] Retry functionality works

---

#### Task 1.7.3: Write User Documentation
**Owner:** Technical Writer / Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 4 hours

**Description:**
Create user guide for prompt management.

**Action Items:**
- [ ] Create `/docs/guides/prompt-management.md`
- [ ] Document:
  - How to create prompts
  - How to configure A/B tests
  - How to use template variables
  - How to interpret performance metrics
  - Best practices for prompt engineering
- [ ] Add screenshots (use Lightshot or Snagit)
- [ ] Include troubleshooting section
- [ ] Link from in-app help icon

**Acceptance Criteria:**
- [ ] Documentation complete and reviewed
- [ ] Screenshots included
- [ ] Link accessible from UI

---

#### Task 1.7.4: Integration Testing
**Owner:** QA / Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 4 hours

**Description:**
Test complete end-to-end workflows.

**Action Items:**
- [ ] Test workflow 1: Create new prompt → Save → Verify in list
- [ ] Test workflow 2: Configure A/B test → Save → Verify weights
- [ ] Test workflow 3: Test template → Render → Copy output
- [ ] Test workflow 4: View metrics → Navigate to analytics
- [ ] Test workflow 5: Complete onboarding → Verify completion
- [ ] Test error scenarios:
  - Invalid form inputs
  - Network failures
  - Backend errors
- [ ] Cross-browser testing (Chrome, Firefox, Safari)

**Acceptance Criteria:**
- [ ] All workflows complete successfully
- [ ] Error handling works correctly
- [ ] No console errors or warnings

---

## 🔴 Priority 2: Rate Limiting & Security Hardening

### Phase 2.1: Rate Limiting Configuration (Days 1-2)

#### Task 2.1.1: Review Traffic Patterns
**Owner:** Backend Developer / DevOps
**Status:** ⚪ Not Started
**Estimated Hours:** 2 hours

**Description:**
Analyze current traffic to determine appropriate rate limits.

**Action Items:**
- [ ] Query MongoDB for traffic statistics:
  ```javascript
  // Last 30 days conversation counts
  db.conversations.aggregate([
    { $match: { createdAt: { $gte: new Date(Date.now() - 30*24*60*60*1000) } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } }
  ])
  ```
- [ ] Analyze:
  - Peak requests per minute
  - Average requests per user
  - API key usage patterns (n8n workflows)
- [ ] Document findings in `/docs/traffic-analysis.md`
- [ ] Propose rate limit tiers based on data

**Acceptance Criteria:**
- [ ] Traffic patterns documented
- [ ] Rate limit tiers proposed and approved

---

#### Task 2.1.2: Create Rate Limiter Middleware
**Owner:** Backend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 6 hours

**Description:**
Implement rate limiting middleware with multiple tiers.

**Action Items:**
- [ ] Install dependencies:
  ```bash
  npm install express-rate-limit rate-limit-mongo
  ```
- [ ] Create `/src/middleware/rateLimiter.js`:
  ```javascript
  const rateLimit = require('express-rate-limit');
  const MongoStore = require('rate-limit-mongo');

  // Global rate limiter (all requests)
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute
    message: 'Too many requests, please try again later.',
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false,
    skip: (req) => {
      // Skip rate limiting for admin users
      return req.user && req.user.role === 'admin';
    },
    keyGenerator: (req) => {
      // Use user ID if authenticated, otherwise IP
      return req.user ? req.user.userId : req.ip;
    },
    store: new MongoStore({
      uri: process.env.MONGODB_URI,
      expireTimeMs: 60 * 1000,
      collectionName: 'rateLimit'
    })
  });

  // Chat endpoint rate limiter (expensive LLM calls)
  const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20, // 20 requests per minute
    message: 'Chat rate limit exceeded. Please wait before sending more messages.'
  });

  // RAG ingestion rate limiter (expensive embedding operations)
  const ragIngestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10, // 10 ingestions per minute
    message: 'Ingestion rate limit exceeded.'
  });

  module.exports = { globalLimiter, chatLimiter, ragIngestLimiter };
  ```
- [ ] Test with different user tiers

**Acceptance Criteria:**
- [ ] Rate limiters created for global, chat, RAG ingestion
- [ ] MongoDB store configured
- [ ] Skip logic works for admin users

---

#### Task 2.1.3: Apply Rate Limiters to Routes
**Owner:** Backend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 2 hours

**Description:**
Apply rate limiters to appropriate endpoints.

**Action Items:**
- [ ] Update `/src/app.js`:
  ```javascript
  const { globalLimiter } = require('./middleware/rateLimiter');
  app.use(globalLimiter); // Apply to all routes
  ```
- [ ] Update `/routes/api.js`:
  ```javascript
  const { chatLimiter } = require('../middleware/rateLimiter');
  router.post('/chat', chatLimiter, chatController.chat);
  ```
- [ ] Update `/routes/rag.js`:
  ```javascript
  const { ragIngestLimiter } = require('../middleware/rateLimiter');
  router.post('/ingest', ragIngestLimiter, ragController.ingest);
  ```
- [ ] Document rate limits in `/docs/api/reference.md`

**Acceptance Criteria:**
- [ ] Rate limiters applied to all relevant endpoints
- [ ] Documentation updated
- [ ] Tests pass with rate limiting enabled

---

### Phase 2.2: Advanced Rate Limiting (Day 3)

#### Task 2.2.1: Implement Whitelist for Trusted IPs
**Owner:** Backend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 3 hours

**Description:**
Allow bypassing rate limits for trusted IPs (local network, CI/CD).

**Action Items:**
- [ ] Add environment variable:
  ```bash
  RATE_LIMIT_WHITELIST=127.0.0.1,192.168.2.0/24
  ```
- [ ] Parse CIDR ranges:
  ```javascript
  const ipRangeCheck = require('ip-range-check');
  const whitelist = process.env.RATE_LIMIT_WHITELIST.split(',');

  function isWhitelisted(ip) {
    return whitelist.some(range => ipRangeCheck(ip, range));
  }
  ```
- [ ] Update skip function in rate limiters:
  ```javascript
  skip: (req) => {
    return isWhitelisted(req.ip) || (req.user && req.user.role === 'admin');
  }
  ```
- [ ] Test with whitelisted and non-whitelisted IPs

**Acceptance Criteria:**
- [ ] Whitelisted IPs bypass rate limiting
- [ ] Non-whitelisted IPs rate limited correctly
- [ ] Configuration via environment variable

---

#### Task 2.2.2: Add Rate Limit Monitoring
**Owner:** Backend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 3 hours

**Description:**
Log rate limit events for monitoring and abuse detection.

**Action Items:**
- [ ] Add handler to rate limiters:
  ```javascript
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      user: req.user?.userId,
      endpoint: req.path,
      limit: options.max,
      windowMs: options.windowMs
    });
    res.status(options.statusCode).json({
      status: 'error',
      message: options.message,
      retryAfter: req.rateLimit.resetTime
    });
  }
  ```
- [ ] Create `/api/admin/rate-limit-violations` endpoint to view violations
- [ ] Add dashboard widget for rate limit monitoring

**Acceptance Criteria:**
- [ ] Rate limit violations logged
- [ ] Admin endpoint shows recent violations
- [ ] Dashboard displays rate limit metrics

---

### Phase 2.3: Helmet Re-evaluation (Day 4)

#### Task 2.3.1: Configure Helmet for Local Network
**Owner:** Backend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 3 hours

**Description:**
Re-enable Helmet with appropriate configuration.

**Action Items:**
- [ ] Update `/src/app.js`:
  ```javascript
  const helmet = require('helmet');

  if (process.env.NODE_ENV === 'production') {
    app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts (if needed)
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", process.env.OLLAMA_HOST],
          fontSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: []
        }
      },
      crossOriginEmbedderPolicy: false, // For local network compatibility
      crossOriginResourcePolicy: { policy: "cross-origin" }
    }));
  } else {
    // Development: Use minimal helmet
    app.use(helmet({ contentSecurityPolicy: false }));
  }
  ```
- [ ] Test in both development and production modes
- [ ] Verify frontend loads without CSP errors
- [ ] Test with all external resources (CDNs, fonts)

**Acceptance Criteria:**
- [ ] Helmet enabled in production
- [ ] No CSP violations in console
- [ ] Frontend fully functional

---

#### Task 2.3.2: Document Security Headers
**Owner:** Technical Writer / Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 2 hours

**Description:**
Document all security headers and their purpose.

**Action Items:**
- [ ] Update `/docs/SECURITY_HARDENING.md`
- [ ] Document each header:
  - X-Content-Type-Options
  - X-Frame-Options
  - X-XSS-Protection
  - Content-Security-Policy
  - Strict-Transport-Security (HSTS)
- [ ] Explain why each header is important
- [ ] Document how to customize CSP for specific needs

**Acceptance Criteria:**
- [ ] Security headers documented
- [ ] Purpose and configuration explained
- [ ] Examples provided

---

### Phase 2.4: API Key Enhancement (Day 5)

#### Task 2.4.1: Implement API Key Management
**Owner:** Backend Developer
**Status:** ⚪ Not Started
**Estimated Hours:** 6 hours

**Description:**
Create system for managing API keys with scopes and expiration.

**Action Items:**
- [ ] Create `/models/APIKey.js`:
  ```javascript
  const mongoose = require('mongoose');
  const bcrypt = require('bcrypt');

  const APIKeySchema = new mongoose.Schema({
    name: { type: String, required: true }, // e.g., "n8n Production"
    keyHash: { type: String, required: true }, // bcrypt hash
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    scopes: [{ type: String, enum: ['read', 'write', 'admin', 'ingest'] }],
    expiresAt: { type: Date },
    lastUsedAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' }
  });

  APIKeySchema.statics.generate = async function(name, userId, scopes, expiresInDays = 90) {
    const key = `agx_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = await bcrypt.hash(key, 10);
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    await this.create({ name, keyHash, userId, scopes, expiresAt });
    return key; // Return plaintext key (only time it's visible)
  };

  APIKeySchema.statics.verify = async function(key) {
    const keys = await this.find({ status: 'active' });
    for (const apiKey of keys) {
      if (await bcrypt.compare(key, apiKey.keyHash)) {
        if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
          return null; // Expired
        }
        apiKey.lastUsedAt = new Date();
        await apiKey.save();
        return apiKey;
      }
    }
    return null;
  };

  module.exports = mongoose.model('APIKey', APIKeySchema);
  ```
- [ ] Create `/routes/admin/api-keys.js`:
  ```javascript
  router.post('/', requireAdmin, async (req, res) => {
    const { name, scopes, expiresInDays } = req.body;
    const key = await APIKey.generate(name, req.user.userId, scopes, expiresInDays);
    res.json({ key, message: 'Save this key securely. It will not be shown again.' });
  });

  router.get('/', requireAdmin, async (req, res) => {
    const keys = await APIKey.find({ userId: req.user.userId });
    res.json({ keys });
  });

  router.delete('/:id', requireAdmin, async (req, res) => {
    await APIKey.findByIdAndUpdate(req.params.id, { status: 'revoked' });
    res.json({ message: 'API key revoked' });
  });
  ```
- [ ] Update `/src/middleware/auth.js` to use APIKey.verify()

**Acceptance Criteria:**
- [ ] API keys stored securely (hashed)
- [ ] Keys have scopes and expiration
- [ ] Admin endpoints functional
- [ ] Old plaintext API key method removed

---

### Phase 2.5: Testing & Documentation (Days 6-7)

#### Task 2.5.1: Write Security Tests
**Owner:** Backend Developer / QA
**Status:** ⚪ Not Started
**Estimated Hours:** 6 hours

**Description:**
Comprehensive security testing.

**Action Items:**
- [ ] Create `/tests/integration/security.test.js`
- [ ] Test rate limiting:
  ```javascript
  it('should rate limit after exceeding threshold', async () => {
    for (let i = 0; i < 61; i++) {
      const res = await request(app).get('/api/health');
      if (i < 60) {
        expect(res.status).toBe(200);
      } else {
        expect(res.status).toBe(429);
      }
    }
  });
  ```
- [ ] Test NoSQL injection:
  ```javascript
  it('should sanitize NoSQL injection attempts', async () => {
    const res = await request(app).post('/api/chat').send({
      message: { $ne: null }
    });
    expect(res.status).toBe(400); // Bad request
  });
  ```
- [ ] Test XSS attempts
- [ ] Test CSRF token validation
- [ ] Run OWASP ZAP security scan

**Acceptance Criteria:**
- [ ] All security tests pass
- [ ] OWASP ZAP scan shows 0 high-severity issues
- [ ] Security test coverage > 80%

---

#### Task 2.5.2: Load Test with Rate Limiting
**Owner:** DevOps / QA
**Status:** ⚪ Not Started
**Estimated Hours:** 3 hours

**Description:**
Verify rate limiting under load.

**Action Items:**
- [ ] Update `/tests/load/stress-test.yml`:
  ```yaml
  phases:
    - duration: 60
      arrivalRate: 100 # 100 requests/second
  scenarios:
    - name: "Rate limit test"
      flow:
        - get:
            url: "/api/health"
        - think: 1
  ```
- [ ] Run load test: `npm run test:load:stress`
- [ ] Verify:
  - Rate limits enforced correctly
  - 429 responses returned after threshold
  - Server remains stable under load
- [ ] Document results in `/docs/reports/load-test-results.md`

**Acceptance Criteria:**
- [ ] Load test completes without crashes
- [ ] Rate limits enforced under high load
- [ ] Results documented

---

## Summary

This action items document provides 50+ detailed tasks across 4 priorities:

1. **Priority 1 (Prompt Management UI):** 21 tasks, 92 hours, 2 weeks
2. **Priority 2 (Security Hardening):** 14 tasks, 40 hours, 1 week
3. **Priority 3 (Analytics Expansion):** 10 tasks, 33 hours, 1 week
4. **Priority 4 (AgentC Integration):** 11 tasks, 36 hours, 2 weeks

**Total Estimated Effort:** 201 hours (~6 weeks with 1 full-time developer)

---

**Next Steps:**
1. Review and approve action items
2. Assign owners to each task
3. Set up project tracking (GitHub Projects, Jira, etc.)
4. Begin with Priority 1, Task 1.1.1

**Document Version:** 1.0
**Last Updated:** 2026-01-01
