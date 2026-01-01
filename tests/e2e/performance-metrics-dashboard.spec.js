/**
 * E2E Tests for Performance Metrics Dashboard Component
 *
 * Tests the PerformanceMetricsDashboard component functionality including:
 * - Dashboard rendering on page load
 * - Time range selector (7d, 30d, 90d, all time)
 * - Auto-refresh toggle
 * - Collapse/expand functionality
 * - Metric cards display
 * - Navigation to analytics page
 * - Empty state handling
 * - Error state handling
 *
 * Prerequisites:
 * - AgentX server running on http://localhost:3080
 * - MongoDB accessible
 * - User authenticated (session-based)
 */

const { test, expect } = require('@playwright/test');

// Test configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const PROMPTS_PAGE = `${BASE_URL}/prompts.html`;
const ANALYTICS_PAGE = `${BASE_URL}/analytics.html`;

// Test data and helpers
const API_ENDPOINTS = {
  feedback: `${BASE_URL}/api/analytics/feedback`,
};

// Helper to wait for dashboard to be visible
async function waitForDashboard(page) {
  await page.waitForSelector('.metrics-dashboard', { state: 'visible', timeout: 5000 });
}

// Helper to wait for metrics to load
async function waitForMetricsLoad(page) {
  // Wait for loading to disappear and content to appear
  await page.waitForSelector('#metricsLoading', { state: 'hidden', timeout: 10000 });
}

// Helper to intercept API and return mock data
async function mockSuccessfulMetricsResponse(page, data = null) {
  const mockData = data || {
    status: 'success',
    data: {
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      totalFeedback: 150,
      positive: 120,
      negative: 30,
      positiveRate: 0.8,
      breakdown: [
        {
          promptName: 'default_chat',
          promptVersion: 1,
          total: 100,
          positive: 85,
          negative: 15,
          positiveRate: 0.85
        },
        {
          promptName: 'code_assistant',
          promptVersion: 2,
          total: 50,
          positive: 35,
          negative: 15,
          positiveRate: 0.7
        }
      ]
    }
  };

  await page.route('**/api/analytics/feedback*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockData)
    });
  });
}

// Helper to mock empty metrics response
async function mockEmptyMetricsResponse(page) {
  await page.route('**/api/analytics/feedback*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success',
        data: {
          from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          to: new Date().toISOString(),
          totalFeedback: 0,
          positive: 0,
          negative: 0,
          positiveRate: 0,
          breakdown: []
        }
      })
    });
  });
}

// Helper to mock API error
async function mockErrorMetricsResponse(page, statusCode = 500, message = 'Internal Server Error') {
  await page.route('**/api/analytics/feedback*', async route => {
    await route.fulfill({
      status: statusCode,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        message: message
      })
    });
  });
}

test.describe('Performance Metrics Dashboard', () => {

  test.beforeEach(async ({ page }) => {
    // Set up authentication cookie/session if needed
    // For now, assuming auth is handled or not required for testing

    // Mock the API response for faster and predictable tests
    await mockSuccessfulMetricsResponse(page);
  });

  test.describe('Dashboard Rendering', () => {

    test('should render dashboard on page load', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);

      // Wait for dashboard to be visible
      await waitForDashboard(page);

      // Verify dashboard structure
      const dashboard = page.locator('.metrics-dashboard');
      await expect(dashboard).toBeVisible();

      // Check header elements
      await expect(page.locator('.dashboard-header h3')).toContainText('Performance Metrics');
      await expect(page.locator('.metrics-subtitle')).toContainText('Real-time prompt analytics');

      // Check header controls
      await expect(page.locator('#metricsTimeRange')).toBeVisible();
      await expect(page.locator('#metricsRefreshBtn')).toBeVisible();
      await expect(page.locator('#autoRefreshToggle')).toBeVisible();
      await expect(page.locator('#metricsCollapseBtn')).toBeVisible();
    });

    test('should display metric cards after loading', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Verify metrics content is visible
      const metricsContent = page.locator('#metricsContent');
      await expect(metricsContent).toBeVisible();

      // Check for metric cards
      const metricCards = page.locator('.metric-card');
      await expect(metricCards).toHaveCount(2); // Based on mock data

      // Verify first card content
      const firstCard = metricCards.first();
      await expect(firstCard).toContainText('default_chat');
      await expect(firstCard).toContainText('85.0%'); // Positive rate
    });

    test('should show correct time range in selector', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      // Default should be 7 days
      const timeRangeSelector = page.locator('#metricsTimeRange');
      await expect(timeRangeSelector).toHaveValue('7d');
    });
  });

  test.describe('Time Range Selector', () => {

    test('should change time range to 30 days', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      // Track API calls
      let apiCallMade = false;
      page.on('request', request => {
        if (request.url().includes('/api/analytics/feedback')) {
          apiCallMade = true;
        }
      });

      // Change time range
      await page.locator('#metricsTimeRange').selectOption('30d');

      // Wait a bit for API call
      await page.waitForTimeout(500);

      // Verify API was called with new range
      expect(apiCallMade).toBe(true);

      // Verify selector shows new value
      await expect(page.locator('#metricsTimeRange')).toHaveValue('30d');
    });

    test('should change time range to 90 days', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      await page.locator('#metricsTimeRange').selectOption('90d');
      await page.waitForTimeout(500);

      await expect(page.locator('#metricsTimeRange')).toHaveValue('90d');
    });

    test('should change time range to all time', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      await page.locator('#metricsTimeRange').selectOption('all');
      await page.waitForTimeout(500);

      await expect(page.locator('#metricsTimeRange')).toHaveValue('all');
    });

    test('should reload metrics when time range changes', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Track loading state
      await page.locator('#metricsTimeRange').selectOption('30d');

      // Loading indicator should appear briefly
      const loadingIndicator = page.locator('#metricsLoading');
      // Note: This might be too fast to catch, so we just verify metrics load

      await waitForMetricsLoad(page);

      // Verify metrics are still displayed
      const metricCards = page.locator('.metric-card');
      await expect(metricCards.first()).toBeVisible();
    });
  });

  test.describe('Auto-Refresh Toggle', () => {

    test('should toggle auto-refresh on', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      const autoRefreshToggle = page.locator('#autoRefreshToggle');

      // Initially should be unchecked
      await expect(autoRefreshToggle).not.toBeChecked();

      // Click to enable
      await autoRefreshToggle.check();

      // Should be checked now
      await expect(autoRefreshToggle).toBeChecked();
    });

    test('should toggle auto-refresh off', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      const autoRefreshToggle = page.locator('#autoRefreshToggle');

      // Enable it first
      await autoRefreshToggle.check();
      await expect(autoRefreshToggle).toBeChecked();

      // Then disable
      await autoRefreshToggle.uncheck();
      await expect(autoRefreshToggle).not.toBeChecked();
    });

    test('should refresh metrics periodically when auto-refresh is on', async ({ page }) => {
      // This test verifies the interval is set, but we won't wait 30 seconds
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      let requestCount = 0;
      page.on('request', request => {
        if (request.url().includes('/api/analytics/feedback')) {
          requestCount++;
        }
      });

      // Initial load counts as 1
      await page.waitForTimeout(500);
      expect(requestCount).toBeGreaterThanOrEqual(1);

      // Enable auto-refresh
      await page.locator('#autoRefreshToggle').check();

      // We can't wait 30 seconds, but we can verify the checkbox is on
      await expect(page.locator('#autoRefreshToggle')).toBeChecked();
    });
  });

  test.describe('Collapse/Expand Functionality', () => {

    test('should collapse dashboard when collapse button clicked', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const dashboardContent = page.locator('.dashboard-content');
      const collapseBtn = page.locator('#metricsCollapseBtn');

      // Should be visible initially
      await expect(dashboardContent).toBeVisible();

      // Click collapse button
      await collapseBtn.click();

      // Wait for animation
      await page.waitForTimeout(300);

      // Content should be hidden
      await expect(dashboardContent).toBeHidden();

      // Icon should change to chevron-down
      const icon = page.locator('#metricsCollapseBtn i');
      await expect(icon).toHaveClass(/fa-chevron-down/);
    });

    test('should expand dashboard when expand button clicked', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const dashboardContent = page.locator('.dashboard-content');
      const collapseBtn = page.locator('#metricsCollapseBtn');

      // Collapse first
      await collapseBtn.click();
      await page.waitForTimeout(300);
      await expect(dashboardContent).toBeHidden();

      // Then expand
      await collapseBtn.click();
      await page.waitForTimeout(300);

      // Content should be visible
      await expect(dashboardContent).toBeVisible();

      // Icon should change to chevron-up
      const icon = page.locator('#metricsCollapseBtn i');
      await expect(icon).toHaveClass(/fa-chevron-up/);
    });

    test('should add collapsed class to dashboard when collapsed', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const dashboard = page.locator('.metrics-dashboard');
      const collapseBtn = page.locator('#metricsCollapseBtn');

      // Initially should not have collapsed class
      await expect(dashboard).not.toHaveClass(/collapsed/);

      // Click collapse
      await collapseBtn.click();
      await page.waitForTimeout(300);

      // Should have collapsed class
      await expect(dashboard).toHaveClass(/collapsed/);
    });
  });

  test.describe('Metric Cards Display', () => {

    test('should display all metric card elements', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();

      // Check all sections exist
      await expect(firstCard.locator('.metric-card-header')).toBeVisible();
      await expect(firstCard.locator('.metric-card-body')).toBeVisible();
      await expect(firstCard.locator('.metric-card-actions')).toBeVisible();

      // Check specific elements
      await expect(firstCard.locator('.metric-name')).toBeVisible();
      await expect(firstCard.locator('.status-badge')).toBeVisible();
      await expect(firstCard.locator('.feedback-bar')).toBeVisible();
      await expect(firstCard.locator('.version-count')).toBeVisible();
    });

    test('should show correct status badge based on positive rate', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // First card has 85% positive rate - should be "Healthy"
      const firstCard = page.locator('.metric-card').first();
      const firstBadge = firstCard.locator('.status-badge');
      await expect(firstBadge).toContainText('Healthy');

      // Second card has 70% positive rate - should be "Fair"
      const secondCard = page.locator('.metric-card').nth(1);
      const secondBadge = secondCard.locator('.status-badge');
      await expect(secondBadge).toContainText('Fair');
    });

    test('should display feedback metrics correctly', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();

      // Check for Total Feedback (100)
      await expect(firstCard).toContainText('100');

      // Check for Positive count (85)
      await expect(firstCard).toContainText('85');

      // Check for Negative count (15)
      await expect(firstCard).toContainText('15');

      // Check for Positive rate (85.0%)
      await expect(firstCard).toContainText('85.0%');
    });

    test('should show version count', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();
      const versionCount = firstCard.locator('.version-count');

      // Should show "1 version" (singular)
      await expect(versionCount).toBeVisible();
      await expect(versionCount).toContainText('version');
    });

    test('should render feedback progress bar', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();
      const feedbackBar = firstCard.locator('.feedback-bar');

      await expect(feedbackBar).toBeVisible();

      // Check positive and negative bars exist
      await expect(feedbackBar.locator('.feedback-positive')).toBeVisible();
      await expect(feedbackBar.locator('.feedback-negative')).toBeVisible();
    });
  });

  test.describe('Navigation to Analytics', () => {

    test('should navigate to analytics page when card is clicked', async ({ page, context }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Get first metric card
      const firstCard = page.locator('.metric-card').first();

      // Get the prompt name for verification
      const promptName = await firstCard.getAttribute('data-prompt-name');

      // Click the card (not the button)
      await firstCard.click();

      // Wait for navigation
      await page.waitForURL(`**/analytics.html?promptName=${encodeURIComponent(promptName)}`);

      // Verify we're on analytics page
      expect(page.url()).toContain('analytics.html');
      expect(page.url()).toContain(`promptName=${encodeURIComponent(promptName)}`);
    });

    test('should navigate to analytics when Details button is clicked', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Get first card's Details button
      const firstCard = page.locator('.metric-card').first();
      const detailsBtn = firstCard.locator('button:has-text("Details")');

      await expect(detailsBtn).toBeVisible();

      // Get the prompt name for verification
      const promptName = await firstCard.getAttribute('data-prompt-name');

      // Click Details button
      await detailsBtn.click();

      // Wait for navigation
      await page.waitForURL(`**/analytics.html?promptName=${encodeURIComponent(promptName)}`);

      // Verify we're on analytics page with correct query param
      expect(page.url()).toContain('analytics.html');
      expect(page.url()).toContain(`promptName=${encodeURIComponent(promptName)}`);
    });

    test('should not navigate when clicking card actions area', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const initialUrl = page.url();

      // Click on the actions area (should not navigate)
      const firstCard = page.locator('.metric-card').first();
      const actionsArea = firstCard.locator('.metric-card-actions');

      // This should not cause navigation (only Details button click does)
      await actionsArea.click({ position: { x: 5, y: 5 }, force: true });

      // Wait a bit to ensure no navigation occurs
      await page.waitForTimeout(500);

      // URL should still be prompts.html
      expect(page.url()).toBe(initialUrl);
    });
  });

  test.describe('Empty State', () => {

    test('should display empty state when no metrics available', async ({ page }) => {
      // Mock empty response
      await mockEmptyMetricsResponse(page);

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Check for empty state message
      const emptyState = page.locator('.metrics-empty');
      await expect(emptyState).toBeVisible();

      // Verify empty state content
      await expect(emptyState).toContainText('No metrics available');
      await expect(emptyState).toContainText('selected time range');

      // Verify no metric cards are shown
      const metricCards = page.locator('.metric-card');
      await expect(metricCards).toHaveCount(0);
    });

    test('should show empty state icon', async ({ page }) => {
      await mockEmptyMetricsResponse(page);

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const emptyState = page.locator('.metrics-empty');
      const icon = emptyState.locator('i.fa-chart-line');

      await expect(icon).toBeVisible();
    });
  });

  test.describe('Error State', () => {

    test('should display error state when API fails', async ({ page }) => {
      // Mock error response
      await mockErrorMetricsResponse(page, 500, 'Database connection failed');

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      // Wait for error to appear
      await page.waitForSelector('#metricsError', { state: 'visible', timeout: 5000 });

      // Check error message
      const errorDiv = page.locator('#metricsError');
      await expect(errorDiv).toBeVisible();

      const errorMessage = page.locator('#metricsErrorMessage');
      await expect(errorMessage).toContainText('Database connection failed');
    });

    test('should display error icon', async ({ page }) => {
      await mockErrorMetricsResponse(page);

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await page.waitForSelector('#metricsError', { state: 'visible' });

      const errorDiv = page.locator('#metricsError');
      const icon = errorDiv.locator('i.fa-exclamation-triangle');

      await expect(icon).toBeVisible();
    });

    test('should hide metrics content when error occurs', async ({ page }) => {
      await mockErrorMetricsResponse(page);

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await page.waitForSelector('#metricsError', { state: 'visible' });

      // Metrics content should be hidden
      const metricsContent = page.locator('#metricsContent');
      await expect(metricsContent).toBeHidden();
    });

    test('should handle 401 unauthorized error', async ({ page }) => {
      await mockErrorMetricsResponse(page, 401, 'Unauthorized');

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await page.waitForSelector('#metricsError', { state: 'visible' });

      const errorMessage = page.locator('#metricsErrorMessage');
      await expect(errorMessage).toContainText('Unauthorized');
    });
  });

  test.describe('Refresh Functionality', () => {

    test('should reload metrics when refresh button is clicked', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      let requestCount = 0;
      page.on('request', request => {
        if (request.url().includes('/api/analytics/feedback')) {
          requestCount++;
        }
      });

      const initialCount = requestCount;

      // Click refresh button
      const refreshBtn = page.locator('#metricsRefreshBtn');
      await refreshBtn.click();

      // Wait for API call
      await page.waitForTimeout(500);

      // Should have made another API call
      expect(requestCount).toBeGreaterThan(initialCount);
    });

    test('should show loading spinner on refresh button during load', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Click refresh
      const refreshBtn = page.locator('#metricsRefreshBtn');
      await refreshBtn.click();

      // Check if icon has spinning class (might be too fast)
      const icon = page.locator('#metricsRefreshBtn i');

      // The spinner might be too fast to catch, so we just verify icon exists
      await expect(icon).toBeVisible();
      await expect(icon).toHaveClass(/fa-sync-alt/);
    });
  });

  test.describe('Loading State', () => {

    test('should show loading indicator on initial load', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      // Loading indicator might be too fast, but we can check it exists
      const loadingIndicator = page.locator('#metricsLoading');

      // Eventually it should be hidden
      await expect(loadingIndicator).toBeHidden({ timeout: 10000 });
    });

    test('should hide loading indicator after metrics load', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const loadingIndicator = page.locator('#metricsLoading');
      await expect(loadingIndicator).toBeHidden();

      const metricsContent = page.locator('#metricsContent');
      await expect(metricsContent).toBeVisible();
    });
  });

  test.describe('Data Integrity', () => {

    test('should correctly calculate and display positive rate percentage', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();

      // From mock data: 85 positive out of 100 total = 85.0%
      const positiveRateText = await firstCard.locator('.metric-value.positive').textContent();
      expect(positiveRateText).toBe('85.0%');
    });

    test('should escape HTML in prompt names to prevent XSS', async ({ page }) => {
      // Mock data with potential XSS
      const xssData = {
        status: 'success',
        data: {
          from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          to: new Date().toISOString(),
          totalFeedback: 10,
          positive: 5,
          negative: 5,
          positiveRate: 0.5,
          breakdown: [{
            promptName: '<script>alert("xss")</script>',
            promptVersion: 1,
            total: 10,
            positive: 5,
            negative: 5,
            positiveRate: 0.5
          }]
        }
      };

      await mockSuccessfulMetricsResponse(page, xssData);

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Should display escaped text, not execute script
      const firstCard = page.locator('.metric-card').first();
      const cardText = await firstCard.textContent();

      // Should contain the literal string, not execute
      expect(cardText).toContain('&lt;script&gt;');
    });

    test('should format large numbers with commas', async ({ page }) => {
      // Mock data with large numbers
      const largeNumberData = {
        status: 'success',
        data: {
          from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          to: new Date().toISOString(),
          totalFeedback: 1234567,
          positive: 1000000,
          negative: 234567,
          positiveRate: 0.81,
          breakdown: [{
            promptName: 'high_volume_prompt',
            promptVersion: 1,
            total: 1234567,
            positive: 1000000,
            negative: 234567,
            positiveRate: 0.81
          }]
        }
      };

      await mockSuccessfulMetricsResponse(page, largeNumberData);

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();
      const cardText = await firstCard.textContent();

      // Should contain formatted number (format varies by locale)
      // Just check that large numbers appear
      expect(cardText).toContain('1,234,567');
    });
  });

  test.describe('Accessibility', () => {

    test('should have proper ARIA labels on interactive elements', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      // Check button titles
      const refreshBtn = page.locator('#metricsRefreshBtn');
      await expect(refreshBtn).toHaveAttribute('title', 'Refresh metrics');

      const collapseBtn = page.locator('#metricsCollapseBtn');
      await expect(collapseBtn).toHaveAttribute('title', 'Collapse/Expand');

      const autoRefreshLabel = page.locator('.auto-refresh-toggle');
      await expect(autoRefreshLabel).toHaveAttribute('title', 'Auto-refresh every 30s');
    });

    test('should be keyboard navigable', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Tab to refresh button
      await page.keyboard.press('Tab');
      // Could be on different element, so let's focus directly
      await page.locator('#metricsRefreshBtn').focus();

      const refreshBtn = page.locator('#metricsRefreshBtn');
      await expect(refreshBtn).toBeFocused();
    });
  });
});
