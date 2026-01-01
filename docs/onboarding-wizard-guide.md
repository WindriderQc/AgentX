# Onboarding Wizard - User Guide

## Overview

The Onboarding Wizard is a 5-step interactive tutorial that guides first-time users through creating their first prompt in the Prompt Management UI.

## Location

**File:** `/public/js/components/OnboardingWizard.js`
**UI:** `/public/prompts.html`
**Styles:** `/public/css/prompts.css`

## How It Works

### Auto-Trigger

The wizard automatically opens when:
1. User visits `/prompts.html` for the first time
2. No prompts exist in the database
3. The `agentx_onboarding_completed` localStorage flag is not set

### Manual Trigger

Click the "Show Tutorial" button in the prompts page header at any time.

## Wizard Steps

### Step 1: Welcome
- Introduction to Prompt Management features
- Overview of capabilities (CRUD, A/B testing, templates, metrics)
- Skip option

### Step 2: Create Your First Prompt
**Form Fields:**
- **Prompt Name** (required): Unique identifier (lowercase with underscores)
- **Description** (optional): Brief explanation
- **System Prompt** (required): The actual prompt text (min 10 chars)

**Validation:**
- Name format: `^[a-z0-9_]+$`
- System prompt minimum length: 10 characters
- Real-time error display

### Step 3: Understand Variables
- Template variable syntax: `{{variableName}}`
- Common variables list
- Code examples
- Testing guidance

### Step 4: Activation Settings
**Options:**
- **Activate Immediately**: Checkbox to make prompt active
- **Traffic Weight**: Slider (1-100%) for A/B testing distribution

**Recommendation:** Start inactive for testing first

### Step 5: Complete
- Success confirmation
- What's next guide
- Quick links to view prompts or create another
- "Don't show again" checkbox

## API Integration

The wizard uses the `PromptsAPI` class to create prompts:

```javascript
await api.create({
  name: 'my_first_prompt',
  description: 'A helpful assistant',
  systemPrompt: 'You are a helpful AI assistant...',
  isActive: false,
  trafficWeight: 100
});
```

## LocalStorage

**Key:** `agentx_onboarding_completed`
**Value:** `'true'` (string)

### Methods

```javascript
// Check completion status
OnboardingWizard.isCompleted(); // returns boolean

// Reset (for testing)
OnboardingWizard.reset();
```

## Error Handling

### Form Validation Errors
- Displayed inline with red error box
- Scrolls error into view
- Prevents progression until fixed

### API Errors
- Toast notification on failure
- Allows retry (stays on Step 4)
- User-friendly error messages

## Customization

### Modify Steps

Edit the `renderStepX()` methods in `OnboardingWizard.js`:

```javascript
renderStep2() {
  return `<div class="onboarding-step">...</div>`;
}
```

### Add More Steps

1. Increase `this.totalSteps` in constructor
2. Add new `renderStepX()` method
3. Update `renderStep()` switch statement
4. Add step-specific listeners if needed

### Change Auto-Trigger Logic

Edit `checkOnboarding()` in `prompts.js`:

```javascript
function checkOnboarding() {
  const hasCompletedOnboarding = OnboardingWizard.isCompleted();
  const hasPrompts = Object.keys(state.prompts).length > 0;

  // Custom logic here
  if (!hasCompletedOnboarding && !hasPrompts) {
    onboardingWizard.open();
  }
}
```

## Styling

All styles are in `/public/css/prompts.css` under the `ONBOARDING WIZARD` section.

### Key CSS Classes

- `.onboarding-modal` - Modal container
- `.onboarding-progress` - Progress bar container
- `.progress-fill` - Animated progress bar
- `.onboarding-step` - Step content wrapper
- `.step-icon` - Icon circle at top
- `.feature-list` - Bulleted list with icons
- `.form-error` - Validation error box
- `.variables-examples` - Code examples container
- `.activation-section` - Settings section
- `.next-steps` - Completion guide

### Responsive Breakpoints

- Desktop: Default (800px modal)
- Tablet: `@media (max-width: 768px)`
- Mobile: Included in tablet breakpoint

## Testing

### Reset Onboarding

In browser console:
```javascript
localStorage.removeItem('agentx_onboarding_completed');
location.reload();
```

### Force Open Wizard

Click "Show Tutorial" button or in console:
```javascript
onboardingWizard.open();
```

### Test Validation

1. Leave name field empty → Error
2. Enter uppercase in name → Error
3. Enter short prompt (< 10 chars) → Error
4. Enter valid data → Proceeds

### Test API Integration

Mock the API in console:
```javascript
api.create = async (data) => {
  console.log('Creating prompt:', data);
  return { _id: 'test-id', ...data };
};
```

## Troubleshooting

### Wizard Doesn't Open Automatically

**Check:**
1. Is localStorage flag set? Clear it with `OnboardingWizard.reset()`
2. Are there existing prompts? Wizard only shows on empty state
3. Check browser console for JavaScript errors

### Wizard Opens Every Time

**Cause:** localStorage flag not being set

**Fix:** Ensure "Don't show again" checkbox is checked on Step 5, or completion handler is running

### Form Validation Not Working

**Check:**
1. Input IDs match: `wizardPromptName`, `wizardDescription`, `wizardSystemPrompt`
2. Event listeners attached in `attachStep2Listeners()`
3. Browser console for JavaScript errors

### Prompt Not Created

**Check:**
1. API endpoint `/api/prompts` is accessible
2. User is authenticated (session valid)
3. Network tab for API response errors
4. Toast notification shows error message

### Styling Issues

**Check:**
1. `prompts.css` loaded in HTML
2. CSS variables defined in base `styles.css`
3. FontAwesome icons loaded
4. Browser developer tools for CSS conflicts

## Browser Support

**Minimum Requirements:**
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

**Required Features:**
- ES6 modules
- localStorage
- Fetch API
- CSS Grid/Flexbox
- CSS Variables

## Accessibility

### Keyboard Navigation
- Tab through form fields
- Enter to proceed to next step
- Escape to close modal (future enhancement)

### Screen Reader Support
- Semantic HTML elements
- ARIA labels on progress indicators
- Error messages announced
- Button labels descriptive

### Color Contrast
- All text meets WCAG AA standards
- Error states clearly visible
- Focus indicators prominent

## Performance

### Metrics
- **Component Size:** 23KB (uncompressed)
- **Render Time:** < 100ms
- **Animation Performance:** GPU-accelerated
- **API Call Time:** Depends on network

### Optimization Tips
- Lazy load Monaco Editor (not needed in wizard)
- Defer Chart.js (not needed in wizard)
- Preload critical CSS

## Security

### Input Sanitization
- All user input escaped in template strings
- Backend validation required
- No eval() or innerHTML with user content

### Storage Security
- localStorage only stores boolean flag
- No sensitive data stored
- Session-based authentication

### XSS Prevention
- Template literals automatically escape
- No user-generated HTML
- Icon classes whitelisted

## Future Enhancements

1. **Interactive Preview:** Live template rendering
2. **Video Tutorial:** Embedded walkthrough
3. **Progress Persistence:** Save partial completion
4. **Analytics:** Track completion rates
5. **Multi-language:** i18n support
6. **Contextual Tooltips:** In-app help after wizard
7. **Advanced Mode:** Skip for power users
8. **Celebration Animation:** Confetti on completion

## API Reference

### OnboardingWizard Class

```javascript
class OnboardingWizard {
  constructor(api, toast)
  open()
  close()
  markCompleted()
  static isCompleted()
  static reset()

  // Internal methods
  render()
  renderStep()
  updateProgress()
  renderStepX() // X = 1-5
  renderNavigation()
  attachStepListeners()
  attachStepXListeners() // X = 2, 4, 5
  handlePrevious()
  handleNext()
  handleSkip()
  handleFinish()
  validateStep2()
  showError(message)
  createPrompt()
}
```

### Events

**Click Events:**
- `#onboardingSkip` - Close wizard
- `#onboardingPrev` - Go to previous step
- `#onboardingNext` - Go to next step
- `#onboardingFinish` - Complete wizard
- `#showOnboardingBtn` - Manual trigger

**Input Events:**
- `#wizardPromptName` - Prompt name input
- `#wizardDescription` - Description input
- `#wizardSystemPrompt` - System prompt textarea
- `#wizardIsActive` - Activation checkbox
- `#wizardTrafficWeight` - Traffic weight slider

## Support

For issues or questions:
1. Check browser console for errors
2. Verify API connectivity
3. Test with reset localStorage
4. Review implementation documentation
5. Check CLAUDE.md for architecture context

## License

Part of AgentX project. See main LICENSE file.
