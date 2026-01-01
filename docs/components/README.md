# AgentX Component Documentation

This directory contains detailed documentation for all frontend UI components in the AgentX system.

## Available Components

### Prompt Management Components

#### 1. PromptListView
**Location:** `/public/js/components/PromptListView.js`  
**Purpose:** Displays list of prompts grouped by name with version history  
**Documentation:** Coming soon

#### 2. PromptEditorModal
**Location:** `/public/js/components/PromptEditorModal.js`  
**Purpose:** Modal for creating and editing prompt configurations with Monaco Editor  
**Documentation:** Coming soon

#### 3. ABTestConfigPanel
**Location:** `/public/js/components/ABTestConfigPanel.js`  
**Purpose:** Configure A/B testing with traffic weight sliders and distribution visualization  
**Documentation:** Coming soon

#### 4. TemplateTester ✅
**Location:** `/public/js/components/TemplateTester.js`  
**Purpose:** Test prompt templates with variable substitution and real-time preview  
**Documentation:** [TemplateTester.md](./TemplateTester.md)  
**Status:** Complete (Phase 1.4)

### Shared Components

#### Toast Notifications
**Location:** `/public/js/components/shared/Toast.js`  
**Purpose:** Display success/error/info notifications  
**Documentation:** Coming soon

#### Navigation
**Location:** `/public/js/components/nav.js`  
**Purpose:** Main navigation bar component  
**Documentation:** Coming soon

## Component Architecture

All components follow a consistent architecture pattern:

```javascript
export class ComponentName {
  constructor() {
    this.modal = null;
    // ... initialize state
    this.initModal();
  }

  initModal() {
    // Create DOM structure
  }

  attachEventListeners() {
    // Wire up events
  }

  open(data) {
    // Open/show component
  }

  close() {
    // Close/hide component
  }

  destroy() {
    // Cleanup and remove DOM
  }
}
```

## Development Guidelines

### Creating New Components

1. **File Location:** `/public/js/components/YourComponent.js`
2. **Export as ES6 Module:** `export class YourComponent { ... }`
3. **CSS in:** `/public/css/prompts.css` (or create new file)
4. **Documentation:** `/docs/components/YourComponent.md`
5. **Test Page:** `/public/test-your-component.html` (optional but recommended)

### Component Checklist

- [ ] ES6 class with constructor
- [ ] Modal overlay for popups
- [ ] Event listeners with cleanup
- [ ] Responsive design (mobile-friendly)
- [ ] Keyboard navigation (ESC to close)
- [ ] Click-outside-to-close for modals
- [ ] Loading/error states
- [ ] JSDoc comments
- [ ] Component documentation
- [ ] Test page (if applicable)

### Testing Strategy

1. **Unit Testing:** Manual testing via test pages
2. **Integration Testing:** Test in main app (prompts.html)
3. **Browser Testing:** Chrome, Firefox, Safari, Edge
4. **Responsive Testing:** Desktop, tablet, mobile
5. **Accessibility Testing:** Keyboard nav, screen readers

## Related Documentation

- **Global Plan:** `/GLOBAL_PLAN_REVISED.md`
- **API Documentation:** `/docs/api/reference.md`
- **CLAUDE.md Guidelines:** `/CLAUDE.md`
- **Phase 1 Plan:** `/docs/plans/phase-1-prompt-ui.md`

## Quick Links

- [Template Tester Documentation](./TemplateTester.md)
- [Prompt Management UI Test Page](/test-template-tester.html)
- [Main Prompt Management](/prompts.html)
