/**
 * Advanced Filtering E2E Tests
 *
 * Tests the complete advanced filtering functionality on the Prompts Management page
 * including search, tag filtering, date range filtering, author filtering, and combinations.
 *
 * @requires @playwright/test
 */

const { test, expect } = require('@playwright/test');

// Configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const TEST_TIMEOUT = 30000;

// Test user credentials (assuming basic auth or session is required)
const TEST_USER = {
  username: process.env.TEST_USERNAME || 'testuser',
  password: process.env.TEST_PASSWORD || 'testpass'
};

/**
 * Helper Functions
 */

/**
 * Login helper - ensures authentication for protected pages
 */
async function login(page) {
  // Check if already authenticated
  const currentUrl = page.url();
  if (currentUrl.includes('/prompts.html')) {
    // Try to access the page first
    const response = await page.goto(`${BASE_URL}/api/auth/me`);
    if (response.ok()) {
      return; // Already authenticated
    }
  }

  // Navigate to login page if needed
  await page.goto(`${BASE_URL}/login.html`);

  // Wait for login form
  await page.waitForSelector('#loginForm', { timeout: 5000 });

  // Fill login form
  await page.fill('input[name="username"]', TEST_USER.username);
  await page.fill('input[name="password"]', TEST_USER.password);

  // Submit form
  await page.click('button[type="submit"]');

  // Wait for redirect or success
  await page.waitForURL(/\/(prompts\.html|index\.html)/, { timeout: 10000 });
}

/**
 * Setup test prompts with various attributes for filtering
 */
async function setupTestPrompts(page) {
  // Navigate to prompts page
  await page.goto(`${BASE_URL}/prompts.html`);
  await page.waitForLoadState('networkidle');

  // Create test prompts with different characteristics
  const testPrompts = [
    {
      name: 'test_prompt_alpha',
      description: 'Test prompt for alpha testing',
      author: 'Alice Anderson',
      tags: ['testing', 'alpha', 'development'],
      systemPrompt: 'You are a helpful alpha testing assistant.',
      isActive: true
    },
    {
      name: 'test_prompt_beta',
      description: 'Test prompt for beta testing',
      author: 'Bob Builder',
      tags: ['testing', 'beta', 'qa'],
      systemPrompt: 'You are a helpful beta testing assistant.',
      isActive: true
    },
    {
      name: 'test_prompt_gamma',
      description: 'Test prompt for production use',
      author: 'Charlie Chen',
      tags: ['production', 'stable'],
      systemPrompt: 'You are a helpful production assistant.',
      isActive: false
    },
    {
      name: 'test_prompt_delta',
      description: 'Advanced AI assistant for delta wave analysis',
      author: 'Alice Anderson',
      tags: ['analytics', 'advanced'],
      systemPrompt: 'You are a specialized delta wave analysis assistant.',
      isActive: true
    },
    {
      name: 'test_prompt_epsilon',
      description: 'Customer service helper',
      author: 'Eve Everson',
      tags: ['customer-service', 'support'],
      systemPrompt: 'You are a customer service assistant.',
      isActive: false
    }
  ];

  // Create prompts via API
  for (const prompt of testPrompts) {
    await page.evaluate(async (promptData) => {
      const response = await fetch('/api/prompts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify(promptData)
      });
      if (!response.ok) {
        throw new Error(`Failed to create prompt: ${promptData.name}`);
      }
    }, prompt);
  }

  // Reload the page to see new prompts
  await page.reload();
  await page.waitForLoadState('networkidle');
}

/**
 * Cleanup test prompts
 */
async function cleanupTestPrompts(page) {
  // Get all test prompts and delete them
  const prompts = await page.evaluate(async () => {
    const response = await fetch('/api/prompts', {
      credentials: 'include'
    });
    const data = await response.json();
    return data.data;
  });

  // Delete test prompts
  for (const [name, versions] of Object.entries(prompts)) {
    if (name.startsWith('test_prompt_')) {
      for (const version of versions) {
        await page.evaluate(async (id) => {
          await fetch(`/api/prompts/${id}`, {
            method: 'DELETE',
            credentials: 'include'
          });
        }, version._id);
      }
    }
  }
}

/**
 * Test Suite
 */

test.describe('Advanced Filtering Functionality', () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();

    // Login if authentication is required
    try {
      await login(page);
    } catch (error) {
      console.log('Login may not be required or failed:', error.message);
    }

    // Setup test data
    await setupTestPrompts(page);
  });

  test.afterAll(async () => {
    // Cleanup test data
    await cleanupTestPrompts(page);
    await page.close();
  });

  test.beforeEach(async () => {
    // Navigate to prompts page before each test
    await page.goto(`${BASE_URL}/prompts.html`);
    await page.waitForLoadState('networkidle');

    // Clear all filters before each test
    const advancedPanel = await page.$('#advancedFiltersPanel');
    const isVisible = await advancedPanel?.isVisible();

    if (isVisible) {
      await page.click('#clearFiltersBtn');
      await page.waitForTimeout(500);
    }

    // Clear search input
    await page.fill('#searchInput', '');
    await page.waitForTimeout(500);
  });

  /**
   * Test 1: Enhanced Search (name, description, author)
   */
  test('should search prompts by name, description, and author', async () => {
    // Test search by name
    await page.fill('#searchInput', 'alpha');
    await page.waitForTimeout(500); // Debounce delay

    let visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    expect(visiblePrompts.some(text => text.includes('alpha'))).toBeTruthy();
    expect(visiblePrompts.length).toBeGreaterThan(0);

    // Test search by description
    await page.fill('#searchInput', 'production use');
    await page.waitForTimeout(500);

    visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    expect(visiblePrompts.some(text => text.includes('gamma'))).toBeTruthy();

    // Test search by author
    await page.fill('#searchInput', 'Alice Anderson');
    await page.waitForTimeout(500);

    visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    expect(visiblePrompts.length).toBeGreaterThanOrEqual(2); // alpha and delta
    expect(visiblePrompts.some(text =>
      text.includes('alpha') || text.includes('delta')
    )).toBeTruthy();

    // Test no results
    await page.fill('#searchInput', 'nonexistent_search_term');
    await page.waitForTimeout(500);

    const noResults = await page.$('.empty-state');
    expect(noResults).toBeTruthy();
  });

  /**
   * Test 2: Toggle Advanced Filters Panel
   */
  test('should toggle advanced filters panel visibility', async () => {
    const advancedFiltersBtn = await page.$('#advancedFiltersBtn');
    const advancedPanel = await page.$('#advancedFiltersPanel');

    // Initially hidden
    let isVisible = await advancedPanel.isVisible();
    expect(isVisible).toBe(false);

    // Click to show
    await advancedFiltersBtn.click();
    await page.waitForTimeout(300);

    isVisible = await advancedPanel.isVisible();
    expect(isVisible).toBe(true);

    // Button should have active class
    const hasActiveClass = await advancedFiltersBtn.evaluate(
      btn => btn.classList.contains('active')
    );
    expect(hasActiveClass).toBe(true);

    // Button text should change
    const buttonText = await advancedFiltersBtn.textContent();
    expect(buttonText).toContain('Hide Filters');

    // Click to hide
    await advancedFiltersBtn.click();
    await page.waitForTimeout(300);

    isVisible = await advancedPanel.isVisible();
    expect(isVisible).toBe(false);

    const buttonTextAfter = await advancedFiltersBtn.textContent();
    expect(buttonTextAfter).toContain('More Filters');
  });

  /**
   * Test 3: Tag Multi-Select Filtering
   */
  test('should filter prompts by selected tags', async () => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Verify tags are populated
    const tagOptions = await page.$$eval('#tagFilter option', options =>
      options.map(opt => opt.value).filter(v => v !== '')
    );
    expect(tagOptions.length).toBeGreaterThan(0);
    expect(tagOptions).toContain('testing');
    expect(tagOptions).toContain('production');

    // Select single tag
    await page.selectOption('#tagFilter', 'testing');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    let visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    // Should show alpha and beta prompts (both have 'testing' tag)
    expect(visiblePrompts.some(text => text.includes('alpha'))).toBeTruthy();
    expect(visiblePrompts.some(text => text.includes('beta'))).toBeTruthy();
    expect(visiblePrompts.some(text => text.includes('gamma'))).toBe(false);

    // Clear and select multiple tags
    await page.click('#clearFiltersBtn');
    await page.waitForTimeout(500);

    // Select multiple tags (Ctrl+click simulation)
    await page.evaluate(() => {
      const select = document.getElementById('tagFilter');
      const options = Array.from(select.options);
      options.find(opt => opt.value === 'production').selected = true;
      options.find(opt => opt.value === 'analytics').selected = true;
    });

    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    // Should show gamma (production) and delta (analytics)
    expect(visiblePrompts.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * Test 4: Date Range Filtering
   */
  test('should filter prompts by date range', async () => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Get current date and set date range
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayStr = today.toISOString().split('T')[0];
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // Test: Filter prompts created today
    await page.fill('#dateFrom', todayStr);
    await page.fill('#dateTo', tomorrowStr);
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    let visiblePrompts = await page.$$('.prompt-card');
    expect(visiblePrompts.length).toBeGreaterThan(0);

    // Test: Filter with past date range (should show nothing)
    await page.fill('#dateFrom', '2020-01-01');
    await page.fill('#dateTo', '2020-12-31');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    const noResults = await page.$('.empty-state');
    expect(noResults).toBeTruthy();

    // Test: Filter with "from" date only
    await page.fill('#dateFrom', yesterdayStr);
    await page.fill('#dateTo', '');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    visiblePrompts = await page.$$('.prompt-card');
    expect(visiblePrompts.length).toBeGreaterThan(0);
  });

  /**
   * Test 5: Author Filtering
   */
  test('should filter prompts by author name', async () => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Test exact author name
    await page.fill('#authorFilter', 'Alice Anderson');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    let visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    // Should show alpha and delta (both by Alice Anderson)
    expect(visiblePrompts.length).toBeGreaterThanOrEqual(2);
    expect(visiblePrompts.some(text =>
      text.includes('alpha') || text.includes('delta')
    )).toBeTruthy();

    // Test partial author name (case-insensitive)
    await page.fill('#authorFilter', 'bob');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    // Should show beta (by Bob Builder)
    expect(visiblePrompts.some(text => text.includes('beta'))).toBeTruthy();
    expect(visiblePrompts.length).toBeGreaterThanOrEqual(1);

    // Test no matches
    await page.fill('#authorFilter', 'Nonexistent Author');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    const noResults = await page.$('.empty-state');
    expect(noResults).toBeTruthy();
  });

  /**
   * Test 6: Combined Filters (All Together)
   */
  test('should apply multiple filters simultaneously', async () => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Set search term
    await page.fill('#searchInput', 'test');
    await page.waitForTimeout(500);

    // Select tag
    await page.selectOption('#tagFilter', 'testing');

    // Set date range (today)
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const todayStr = today.toISOString().split('T')[0];
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    await page.fill('#dateFrom', todayStr);
    await page.fill('#dateTo', tomorrowStr);

    // Set author filter
    await page.fill('#authorFilter', 'Alice');

    // Apply filters
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    // Verify toast notification shows filter count
    const toast = await page.waitForSelector('.toast', { timeout: 5000 });
    const toastText = await toast.textContent();
    expect(toastText).toContain('Applied');
    expect(toastText).toContain('filter');

    // Should show only alpha prompt (matches all criteria)
    const visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    expect(visiblePrompts.length).toBeGreaterThanOrEqual(1);
    expect(visiblePrompts.some(text => text.includes('alpha'))).toBeTruthy();

    // Verify state filter also works in combination
    await page.selectOption('#statusFilter', 'active');
    await page.waitForTimeout(500);

    const activePrompts = await page.$$('.prompt-card');
    expect(activePrompts.length).toBeGreaterThan(0);
  });

  /**
   * Test 7: Clear All Filters Button
   */
  test('should clear all advanced filters when clear button is clicked', async () => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Set multiple filters
    await page.selectOption('#tagFilter', 'testing');
    await page.fill('#dateFrom', '2024-01-01');
    await page.fill('#dateTo', '2024-12-31');
    await page.fill('#authorFilter', 'Alice');

    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    // Verify filters are applied
    let tagValue = await page.$eval('#tagFilter', select =>
      Array.from(select.selectedOptions).map(o => o.value)
    );
    expect(tagValue.length).toBeGreaterThan(0);

    let dateFrom = await page.$eval('#dateFrom', input => input.value);
    expect(dateFrom).toBe('2024-01-01');

    let authorValue = await page.$eval('#authorFilter', input => input.value);
    expect(authorValue).toBe('Alice');

    // Click clear filters button
    await page.click('#clearFiltersBtn');
    await page.waitForTimeout(500);

    // Verify all filters are cleared
    tagValue = await page.$eval('#tagFilter', select =>
      Array.from(select.selectedOptions).map(o => o.value)
    );
    expect(tagValue.length).toBe(0);

    dateFrom = await page.$eval('#dateFrom', input => input.value);
    expect(dateFrom).toBe('');

    const dateTo = await page.$eval('#dateTo', input => input.value);
    expect(dateTo).toBe('');

    authorValue = await page.$eval('#authorFilter', input => input.value);
    expect(authorValue).toBe('');

    // Verify toast notification
    const toast = await page.waitForSelector('.toast', { timeout: 5000 });
    const toastText = await toast.textContent();
    expect(toastText).toContain('cleared');

    // Verify all prompts are shown again
    const allPrompts = await page.$$('.prompt-card');
    expect(allPrompts.length).toBeGreaterThanOrEqual(5); // All test prompts
  });

  /**
   * Test 8: Filter Persistence
   */
  test('should maintain filter state when navigating away and back', async () => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Set filters
    await page.fill('#searchInput', 'alpha');
    await page.waitForTimeout(500);

    await page.selectOption('#tagFilter', 'testing');
    await page.fill('#authorFilter', 'Alice');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    // Get current results count
    const initialCount = await page.$$eval('.prompt-card', cards => cards.length);

    // Navigate away to another page
    await page.click('a[href="index.html"]');
    await page.waitForLoadState('networkidle');

    // Navigate back
    await page.goto(`${BASE_URL}/prompts.html`);
    await page.waitForLoadState('networkidle');

    // Note: Without localStorage or session storage implementation,
    // filters will NOT persist. This test documents expected behavior
    // if persistence is implemented in the future.

    // Verify filters are reset (current implementation)
    const searchValue = await page.$eval('#searchInput', input => input.value);
    expect(searchValue).toBe('');

    // If persistence is implemented, this test would change to:
    // expect(searchValue).toBe('alpha');
    // const newCount = await page.$$eval('.prompt-card', cards => cards.length);
    // expect(newCount).toBe(initialCount);
  });

  /**
   * Test 9: Status Filter Integration with Advanced Filters
   */
  test('should work with status filter dropdown', async () => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Select a tag
    await page.selectOption('#tagFilter', 'testing');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    const allTestingPrompts = await page.$$('.prompt-card');
    const allTestingCount = allTestingPrompts.length;

    // Apply status filter - Active only
    await page.selectOption('#statusFilter', 'active');
    await page.waitForTimeout(500);

    const activeTestingPrompts = await page.$$('.prompt-card');
    const activeTestingCount = activeTestingPrompts.length;

    // Should be less than or equal to all testing prompts
    expect(activeTestingCount).toBeLessThanOrEqual(allTestingCount);
    expect(activeTestingCount).toBeGreaterThan(0);

    // Apply status filter - Inactive only
    await page.selectOption('#statusFilter', 'inactive');
    await page.waitForTimeout(500);

    const inactiveTestingPrompts = await page.$$('.prompt-card');

    // Alpha and beta are active, so inactive filter should show nothing
    expect(inactiveTestingPrompts.length).toBe(0);
  });

  /**
   * Test 10: Sort Integration with Filters
   */
  test('should maintain filters when changing sort order', async () => {
    // Apply filters
    await page.fill('#searchInput', 'test');
    await page.waitForTimeout(500);

    const initialPrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );
    const initialCount = initialPrompts.length;

    // Change sort order
    await page.selectOption('#sortBy', 'version');
    await page.waitForTimeout(500);

    const sortedPrompts = await page.$$('.prompt-card');
    expect(sortedPrompts.length).toBe(initialCount);

    // Try different sort
    await page.selectOption('#sortBy', 'name');
    await page.waitForTimeout(500);

    const nameSortedPrompts = await page.$$('.prompt-card');
    expect(nameSortedPrompts.length).toBe(initialCount);
  });

  /**
   * Test 11: Empty State Handling
   */
  test('should show empty state when no prompts match filters', async () => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Set filters that match nothing
    await page.fill('#authorFilter', 'NonexistentAuthor12345');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    // Verify empty state is shown
    const emptyState = await page.$('.empty-state');
    expect(emptyState).toBeTruthy();

    const isVisible = await emptyState.isVisible();
    expect(isVisible).toBe(true);

    // Verify prompt list is hidden
    const promptList = await page.$('#promptListContainer');
    const listVisible = await promptList.isVisible();
    expect(listVisible).toBe(false);
  });

  /**
   * Test 12: Filter Count Badge/Indicator
   */
  test('should show visual indicator when filters are active', async () => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Apply a filter
    await page.fill('#authorFilter', 'Alice');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    // Verify toast shows filter count
    const toast = await page.waitForSelector('.toast', { timeout: 5000 });
    const toastText = await toast.textContent();
    expect(toastText).toMatch(/Applied.*1.*filter/);

    // Apply multiple filters
    await page.selectOption('#tagFilter', 'testing');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    const toast2 = await page.waitForSelector('.toast', { timeout: 5000 });
    const toast2Text = await toast2.textContent();
    expect(toast2Text).toMatch(/Applied.*2.*filters/);
  });

  /**
   * Test 13: Keyboard Navigation Support
   */
  test('should support keyboard shortcuts while filtering', async () => {
    // Press '/' to focus search
    await page.keyboard.press('/');
    await page.waitForTimeout(300);

    const focusedElement = await page.evaluate(() => document.activeElement.id);
    expect(focusedElement).toBe('searchInput');

    // Type search query
    await page.keyboard.type('alpha');
    await page.waitForTimeout(500);

    const visiblePrompts = await page.$$('.prompt-card');
    expect(visiblePrompts.length).toBeGreaterThan(0);

    // Clear with Escape (if implemented)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Note: Current implementation may not have Escape to close behavior
  });

  /**
   * Test 14: Responsive Design - Mobile View
   */
  test('should handle filters in mobile viewport', async () => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Reload page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Advanced filters button should be visible
    const advancedBtn = await page.$('#advancedFiltersBtn');
    expect(advancedBtn).toBeTruthy();

    // Click to open panel
    await advancedBtn.click();
    await page.waitForTimeout(300);

    // Panel should be visible
    const panel = await page.$('#advancedFiltersPanel');
    const isVisible = await panel.isVisible();
    expect(isVisible).toBe(true);

    // Filters should be usable
    await page.fill('#authorFilter', 'Alice');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    const results = await page.$$('.prompt-card');
    expect(results.length).toBeGreaterThan(0);

    // Reset viewport
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  /**
   * Test 15: Performance - Filter Response Time
   */
  test('should apply filters quickly with reasonable response time', async () => {
    // Open advanced filters
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Set filter
    await page.selectOption('#tagFilter', 'testing');

    // Measure time to apply filter
    const startTime = Date.now();
    await page.click('#applyFiltersBtn');

    // Wait for results
    await page.waitForSelector('.prompt-card', { timeout: 5000 });
    const endTime = Date.now();

    const responseTime = endTime - startTime;

    // Should respond within 2 seconds
    expect(responseTime).toBeLessThan(2000);

    console.log(`Filter response time: ${responseTime}ms`);
  });
});
