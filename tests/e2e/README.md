# E2E Tests for AgentX

This directory contains end-to-end (E2E) tests for the AgentX application using Playwright.

## Test Files

### advanced-filtering.spec.js

Comprehensive E2E tests for the Advanced Filtering functionality on Prompts Management page, covering:

1. **Enhanced Search** - Search prompts by name, description, and author
2. **Toggle Advanced Filters Panel** - Show/hide panel with visual feedback
3. **Tag Multi-Select Filtering** - Filter by single or multiple tags
4. **Date Range Filtering** - Filter prompts by creation date range
5. **Author Filtering** - Filter by author name (case-insensitive)
6. **Combined Filters** - All filters working together simultaneously
7. **Clear All Filters** - Reset all advanced filters at once
8. **Filter Persistence** - State management across navigation (documentation)
9. **Status Filter Integration** - Active/Inactive status filtering
10. **Sort Integration** - Sorting while maintaining active filters
11. **Empty State Handling** - UI feedback when no results match filters
12. **Filter Count Badge** - Visual indicators for active filter count
13. **Keyboard Navigation** - Keyboard shortcuts support (/ for search)
14. **Responsive Design** - Mobile viewport testing
15. **Performance** - Filter response time validation (< 2 seconds)

**Test Data**: Creates 5 test prompts with various tags, authors, and statuses for comprehensive testing.

### onboarding-wizard.spec.js

Comprehensive E2E tests for the Onboarding Wizard component, covering:

1. **Auto-trigger on first visit** - Verifies wizard appears automatically for new users
2. **Manual trigger** - Tests "Show Tutorial" button functionality
3. **All 5 steps navigation** - Validates forward/backward navigation through all wizard steps
4. **Form validation** - Tests all validation rules on Step 2 (prompt creation form)
5. **Skip functionality** - Verifies skip button with confirmation dialog
6. **Successful prompt creation** - Tests the complete flow including API calls
7. **localStorage persistence** - Validates state persistence across page reloads
8. **"Don't show again" checkbox** - Tests the completion preference setting
9. **Slider/number input sync** - Validates UI control synchronization on Step 4
10. **Progress bar updates** - Tests visual progress indicator through all steps

### performance-metrics-dashboard.spec.js

Comprehensive E2E tests for the Performance Metrics Dashboard component, covering:

1. **Dashboard Rendering** - Verifies dashboard loads and displays correctly on page load
2. **Time Range Selector** - Tests all time range options (7d, 30d, 90d, all time)
3. **Auto-Refresh Toggle** - Tests enabling/disabling auto-refresh functionality
4. **Collapse/Expand Functionality** - Verifies dashboard can be collapsed and expanded
5. **Metric Cards Display** - Tests metric cards show correct data and formatting
6. **Navigation to Analytics** - Tests clicking cards and buttons navigates to analytics page
7. **Empty State** - Validates empty state display when no metrics are available
8. **Error State** - Tests error handling and display for API failures
9. **Refresh Functionality** - Tests manual refresh button behavior
10. **Loading State** - Verifies loading indicators during data fetch
11. **Data Integrity** - Tests data formatting, XSS prevention, large number formatting
12. **Accessibility** - Tests ARIA labels and keyboard navigation

## Prerequisites

Before running the tests, ensure:

1. **AgentX server is running** on `http://localhost:3080` (or set `BASE_URL` environment variable)
2. **Playwright browsers are installed**:
   ```bash
   npx playwright install
   ```

## Running the Tests

### Run all E2E tests
```bash
npm run test:e2e:playwright
```

### Run only onboarding wizard tests
```bash
npm run test:e2e:onboarding
```

### Run tests in UI mode (interactive)
```bash
npm run test:e2e:playwright:ui
```

### Run tests in headed mode (see browser)
```bash
npm run test:e2e:playwright:headed
```

### Run tests for specific browser
```bash
npx playwright test --project=chromium
npx playwright test --project=firefox
npx playwright test --project=webkit
```

### Run single test
```bash
npx playwright test onboarding-wizard.spec.js -g "Test 1"
```

### Debug mode
```bash
npx playwright test --debug
```

## Configuration

The Playwright configuration is defined in `/home/yb/codes/AgentX/playwright.config.js`.

Key settings:
- **Test directory**: `./tests/e2e`
- **Timeout**: 30 seconds per test
- **Base URL**: `http://localhost:3080` (configurable via `BASE_URL` env var)
- **Browsers**: Chromium, Firefox, WebKit, Mobile Chrome, Mobile Safari
- **Reports**: HTML report in `playwright-report/` directory
- **Screenshots**: Captured on test failure
- **Videos**: Recorded on test failure

## Test Architecture

### Mocking Strategy

The tests use Playwright's route interception to mock backend APIs:

```javascript
// Mock authentication
await page.route('**/api/auth/me', (route) => {
  route.fulfill({
    status: 200,
    body: JSON.stringify({ userId: 'test-user-123' })
  });
});

// Mock prompts API
await page.route('**/api/prompts', (route) => {
  if (route.request().method() === 'POST') {
    // Handle prompt creation
  }
});
```

### Helper Functions

- `resetOnboarding(page)` - Clears localStorage to simulate first-time user
- `isOnboardingCompleted(page)` - Checks localStorage completion flag
- `waitForOnboardingModal(page, timeout)` - Waits for modal to appear
- `isOnboardingVisible(page)` - Checks if modal is currently visible

### Test Data

```javascript
const TEST_PROMPT = {
  name: 'test_onboarding_prompt',
  description: 'A test prompt created via onboarding wizard',
  systemPrompt: 'You are a helpful AI assistant for testing purposes.'
};
```

## Writing New Tests

### Basic test structure:

```javascript
test('Test description', async ({ page }) => {
  // Navigate to page
  await page.goto(`${BASE_URL}/prompts.html`);

  // Setup (mock APIs, reset state)
  await resetOnboarding(page);

  // Perform actions
  await page.click('#someButton');

  // Assertions
  await expect(page.locator('#someElement')).toBeVisible();
});
```

### Best Practices

1. **Use data-testid attributes** for stable selectors:
   ```html
   <button data-testid="create-prompt">Create</button>
   ```
   ```javascript
   await page.getByTestId('create-prompt').click();
   ```

2. **Wait for network idle** after navigation:
   ```javascript
   await page.waitForLoadState('networkidle');
   ```

3. **Mock external APIs** to ensure test reliability:
   ```javascript
   await page.route('**/api/**', (route) => route.fulfill({ ... }));
   ```

4. **Use descriptive test names** that explain what is being tested

5. **Clean up state** in `beforeEach` hooks:
   ```javascript
   test.beforeEach(async ({ page }) => {
     await resetOnboarding(page);
   });
   ```

## Viewing Test Reports

After running tests, view the HTML report:

```bash
npx playwright show-report
```

This opens an interactive report in your browser showing:
- Test results (pass/fail)
- Screenshots on failure
- Videos of failed tests
- Detailed error messages
- Test duration statistics

## CI/CD Integration

The tests are configured to run in CI environments with:
- Retry on failure (2 retries)
- Single worker (no parallel execution)
- Fail build on `test.only` found

Environment variable for CI:
```bash
export CI=true
npm run test:e2e:playwright
```

## Debugging Failed Tests

### 1. Run in headed mode to see browser
```bash
npm run test:e2e:playwright:headed
```

### 2. Use debug mode with Playwright Inspector
```bash
npx playwright test --debug
```

### 3. Check screenshots and videos
Failed tests automatically capture:
- Screenshots: `test-results/` directory
- Videos: `test-results/` directory

### 4. Add console logging
```javascript
test('Debug test', async ({ page }) => {
  page.on('console', msg => console.log('Browser console:', msg.text()));
  // ... test code
});
```

### 5. Use step-by-step execution
```javascript
await page.pause(); // Pauses execution and opens inspector
```

## Troubleshooting

### Server not running
```
Error: page.goto: net::ERR_CONNECTION_REFUSED
```
**Solution**: Start the AgentX server: `npm start`

### Browsers not installed
```
Error: Executable doesn't exist at ...
```
**Solution**: Install browsers: `npx playwright install`

### Timeout errors
```
Error: Test timeout of 30000ms exceeded
```
**Solution**: Increase timeout in config or for specific test:
```javascript
test('Slow test', async ({ page }) => {
  test.setTimeout(60000); // 60 seconds
  // ... test code
});
```

### localStorage issues
```
Error: localStorage is not defined
```
**Solution**: Ensure you're accessing localStorage within `page.evaluate()`:
```javascript
await page.evaluate(() => localStorage.getItem('key'));
```

## Resources

- [Playwright Documentation](https://playwright.dev)
- [Playwright Test API](https://playwright.dev/docs/api/class-test)
- [Best Practices](https://playwright.dev/docs/best-practices)
- [Debugging Guide](https://playwright.dev/docs/debug)

## Contributing

When adding new E2E tests:

1. Follow the existing test structure and naming conventions
2. Add helper functions to reduce code duplication
3. Mock external APIs to ensure test reliability
4. Document test coverage in this README
5. Ensure tests pass in all configured browsers
6. Add appropriate assertions and error messages

## Test Coverage

### Onboarding Wizard
- ✅ Auto-trigger logic
- ✅ Manual trigger
- ✅ All step navigation
- ✅ Form validation (all rules)
- ✅ Skip functionality
- ✅ Prompt creation API
- ✅ localStorage persistence
- ✅ User preferences
- ✅ UI control synchronization
- ✅ Progress indicators

Total: **10 comprehensive test scenarios** covering all major user flows.

### Performance Metrics Dashboard
- ✅ Dashboard rendering on page load
- ✅ Time range selector (7d, 30d, 90d, all time)
- ✅ Auto-refresh toggle (on/off)
- ✅ Collapse/expand functionality
- ✅ Metric cards display and formatting
- ✅ Navigation to analytics page
- ✅ Empty state handling
- ✅ Error state handling (500, 401, etc.)
- ✅ Refresh button functionality
- ✅ Loading state indicators
- ✅ Data integrity (XSS prevention, number formatting)
- ✅ Accessibility (ARIA labels, keyboard navigation)

Total: **50+ test cases** covering all dashboard functionality and edge cases.
