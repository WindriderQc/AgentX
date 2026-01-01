# E2E Test Suite Summary

## Overview

This document provides a summary of the comprehensive E2E test suite for the AgentX Onboarding Wizard component.

## Test File

**Location**: `/home/yb/codes/AgentX/tests/e2e/onboarding-wizard.spec.js`

**Total Tests**: 10 comprehensive test scenarios

**Test Framework**: Playwright Test

**Target Component**: Onboarding Wizard (`/public/js/components/OnboardingWizard.js`)

**Target Page**: `/prompts.html`

## Test Scenarios

### Test 1: Auto-trigger on First Visit
**Purpose**: Verify the wizard automatically appears for first-time users

**Steps**:
1. Clear localStorage to simulate first-time visit
2. Load prompts page
3. Wait for wizard to auto-appear (500ms delay + buffer)

**Assertions**:
- localStorage flag is cleared
- Wizard modal is visible
- Displays step 1 (Welcome)
- Welcome message and feature list are present

---

### Test 2: Manual Trigger via "Show Tutorial" Button
**Purpose**: Verify users can manually open the wizard after completion

**Steps**:
1. Mark onboarding as completed in localStorage
2. Verify wizard doesn't auto-appear
3. Click "Show Tutorial" button in header

**Assertions**:
- Wizard doesn't auto-trigger when marked complete
- Manual button opens wizard
- Wizard starts at step 1

---

### Test 3: All 5 Steps Navigation (Previous/Next Buttons)
**Purpose**: Test forward and backward navigation through all wizard steps

**Steps**:
1. Navigate forward through all 5 steps
2. Verify each step's content
3. Navigate backward from step 5 to step 1

**Assertions**:
- Step counter updates correctly (1-5)
- Each step displays correct content
- Previous button hidden on step 1
- Forward/backward navigation works correctly
- Form data persists during navigation

**Steps Verified**:
- Step 1: Welcome screen with feature list
- Step 2: Prompt creation form (name, description, systemPrompt)
- Step 3: Template variables explanation
- Step 4: Activation settings (checkbox and traffic weight)
- Step 5: Completion screen with next steps

---

### Test 4: Form Validation on Step 2
**Purpose**: Test all validation rules for the prompt creation form

**Test Cases**:
1. **Empty name** → Error: "name is required"
2. **Invalid name (uppercase)** → Error: "lowercase with underscores"
3. **Invalid name (spaces)** → Error: "lowercase with underscores"
4. **Empty system prompt** → Error: "System prompt is required"
5. **System prompt too short** → Error: "at least 10 characters"
6. **Valid form** → Successfully advances to step 3

**Assertions**:
- Error messages display correctly
- Form submission blocked on validation failure
- User stays on step 2 when validation fails
- Valid data allows progression

---

### Test 5: Skip Button with Confirmation
**Purpose**: Test skip functionality with confirmation dialog

**Test Cases**:
1. **Cancel skip** → Wizard stays open
2. **Confirm skip** → Wizard closes
3. **Skip from header button** → Works same as footer button

**Assertions**:
- Confirmation dialog appears with correct message
- Canceling keeps wizard open
- Confirming closes wizard
- Both skip buttons work identically

---

### Test 6: Successful Prompt Creation
**Purpose**: Test the complete flow including API call

**Steps**:
1. Navigate through wizard filling all required fields
2. Set activation settings (active checkbox, traffic weight)
3. Click Next on step 4 to trigger API call
4. Wait for prompt creation

**Assertions**:
- API receives correct payload (name, description, systemPrompt, isActive, trafficWeight)
- Toast notification shows success message
- Wizard advances to step 5
- Completion message displays prompt name
- "Next steps" section is visible

**API Validation**:
- Prompt name matches input
- Description matches input
- System prompt matches input
- isActive is boolean
- trafficWeight is 1-100

---

### Test 7: localStorage Persistence Check
**Purpose**: Verify completion state persists across page reloads

**Test Cases**:
1. Initial state (not completed)
2. Mark as completed
3. Verify flag set
4. Reload page
5. Verify flag persists
6. Verify wizard doesn't auto-show when completed
7. Reset functionality

**Assertions**:
- localStorage key: `agentx_onboarding_completed`
- Value: `'true'` when completed
- Persists across page reloads
- Auto-trigger respects completion flag
- Reset clears flag correctly

---

### Test 8: "Don't Show Again" Checkbox
**Purpose**: Test the completion preference checkbox on step 5

**Test Cases**:
1. **Unchecked (default)** → Finish without marking complete
2. **Checked** → Finish and mark as completed

**Assertions**:
- Checkbox visible on step 5
- Unchecked by default
- Finishing without checkbox doesn't set localStorage flag
- Checking and finishing sets localStorage flag
- Wizard respects flag on next visit

---

### Test 9: Slider and Number Input Synchronization
**Purpose**: Test UI control synchronization on step 4

**Steps**:
1. Navigate to step 4
2. Change slider value
3. Verify number input updates
4. Change number input value
5. Verify slider updates
6. Test boundary values (1, 100)

**Assertions**:
- Slider → Number input sync works
- Number input → Slider sync works
- Minimum value (1) enforced
- Maximum value (100) enforced
- Values stay synchronized

---

### Test 10: Progress Bar Visual Update
**Purpose**: Test progress indicator through all steps

**Steps**:
1. Navigate through each step
2. Verify progress bar width at each step

**Assertions**:
- Step 1: 20% width
- Step 2: 40% width
- Step 3: 60% width
- Step 4: 80% width
- Step 5: 100% width

---

## Test Architecture

### Mocking Strategy

All tests use Playwright route interception to mock backend APIs:

1. **Authentication API** (`/api/auth/me`)
   - Returns mock user object
   - Bypasses login requirement

2. **Prompts API** (`/api/prompts`)
   - GET: Returns empty prompts (simulates first-time user)
   - POST: Returns success response with created prompt data

### Helper Functions

```javascript
resetOnboarding(page)           // Clear localStorage
isOnboardingCompleted(page)     // Check completion flag
waitForOnboardingModal(page)    // Wait for modal to appear
isOnboardingVisible(page)       // Check if modal is visible
```

### Test Data

```javascript
const TEST_PROMPT = {
  name: 'test_onboarding_prompt',
  description: 'A test prompt created via onboarding wizard',
  systemPrompt: 'You are a helpful AI assistant for testing purposes. Be concise and friendly.'
};
```

## Coverage Analysis

### UI Components Tested
- ✅ Modal overlay and container
- ✅ Header with close button
- ✅ Progress bar
- ✅ Step indicator
- ✅ All 5 step content sections
- ✅ Form inputs (text, textarea, checkbox, range, number)
- ✅ Navigation buttons (Previous, Next, Skip, Finish)
- ✅ Error messages
- ✅ Quick links on completion screen

### User Flows Tested
- ✅ First-time user auto-onboarding
- ✅ Returning user manual access
- ✅ Complete wizard flow (all steps)
- ✅ Skip wizard (with confirmation)
- ✅ Form validation errors
- ✅ Successful prompt creation
- ✅ Preference persistence

### Data Validation Tested
- ✅ Prompt name format (lowercase, underscores only)
- ✅ Prompt name required
- ✅ System prompt required (min 10 chars)
- ✅ Traffic weight range (1-100)
- ✅ Boolean flags (isActive)
- ✅ API payload structure

### Edge Cases Tested
- ✅ Empty form submission
- ✅ Invalid characters in name
- ✅ Short text in required fields
- ✅ Confirmation dialog cancel
- ✅ Confirmation dialog accept
- ✅ Navigation backward from last step
- ✅ Boundary values for numeric inputs
- ✅ localStorage persistence across reloads
- ✅ Checkbox state toggle

## Running the Tests

### Prerequisites
```bash
# Install browsers (first time only)
npx playwright install

# Start AgentX server
npm start
```

### Run Commands
```bash
# All tests
npm run test:e2e:playwright

# Onboarding tests only
npm run test:e2e:onboarding

# Interactive UI mode
npm run test:e2e:playwright:ui

# With visible browser
npm run test:e2e:playwright:headed

# Debug mode
npm run test:e2e:playwright:debug

# View report
npm run test:e2e:playwright:report
```

## Expected Results

### Success Criteria
- All 10 tests pass
- No console errors
- No unhandled promise rejections
- All assertions pass
- API payloads are correct

### Test Duration
- Average: ~2-3 seconds per test
- Total suite: ~20-30 seconds

### Browser Support
Tests run on:
- ✅ Chromium (Desktop)
- ✅ Firefox (Desktop)
- ✅ WebKit (Desktop)
- ✅ Mobile Chrome
- ✅ Mobile Safari

## Maintenance

### When to Update Tests

Update tests when:
1. Onboarding wizard UI changes
2. Step count changes
3. Validation rules change
4. API contract changes
5. localStorage key names change

### Adding New Tests

Follow this pattern:
```javascript
test('Test description', async ({ page }) => {
  // Setup
  await page.goto(`${BASE_URL}/prompts.html`);
  await resetOnboarding(page);

  // Actions
  await page.click('#someButton');

  // Assertions
  await expect(page.locator('#someElement')).toBeVisible();
});
```

## Integration with CI/CD

Tests are configured for CI with:
- Automatic retries on failure (2 retries)
- Single worker (no parallel execution)
- HTML and list reporters
- Screenshot and video capture on failure

Environment variable:
```bash
export CI=true
npm run test:e2e:playwright
```

## Documentation

- **Quick Start**: [QUICKSTART.md](./QUICKSTART.md)
- **Full Guide**: [README.md](./README.md)
- **Playwright Docs**: https://playwright.dev

## Author

Created for AgentX E2E testing suite
Date: 2026-01-01
