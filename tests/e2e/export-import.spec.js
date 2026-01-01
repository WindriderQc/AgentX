/**
 * E2E Tests for Prompt Export/Import Functionality
 *
 * Tests the complete export/import workflow including:
 * - File download with correct naming
 * - JSON file structure validation
 * - File upload and validation
 * - Duplicate detection and conflict resolution
 * - Import success/error notifications
 *
 * @requires @playwright/test
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs').promises;
const {
  mockPromptsForExport,
  validExportData,
  createMockApiResponse
} = require('./fixtures/export-import-data.js');

// Test configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const PROMPTS_PAGE = `${BASE_URL}/prompts.html`;
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/**
 * Setup mock API responses for auth and prompts
 */
async function setupMockAPI(page, promptsData = mockPromptsForExport) {
  // Mock authentication to bypass login
  await page.route('**/api/auth/me', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: 'test-user-123',
        username: 'testuser',
        email: 'test@example.com'
      })
    });
  });

  // Mock prompts API GET to return test data
  await page.route('**/api/prompts', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(createMockApiResponse(promptsData))
      });
    } else {
      route.continue();
    }
  });

  // Bypass onboarding modal
  await page.addInitScript(() => {
    localStorage.setItem('agentx_onboarding_completed', 'true');
  });
}

// Test Suite
test.describe('Prompt Export/Import E2E Tests', () => {

  test.beforeEach(async ({ page }) => {
    // Setup API mocks for auth and prompts data
    await setupMockAPI(page);

    // Navigate to prompts page
    await page.goto(PROMPTS_PAGE);
    await page.waitForLoadState('networkidle');

    // Wait for page to load
    await page.waitForSelector('.prompts-header', { timeout: 5000 });
  });

  /**
   * Test 1: Export downloads JSON file with correct filename format
   */
  test('should export prompts with correct filename format', async ({ page }) => {
    // Mock data already loaded via setupMockAPI

    // Setup download listener before clicking export
    const downloadPromise = page.waitForEvent('download');

    // Click export button
    await page.click('#exportPromptsBtn');

    // Wait for download to complete
    const download = await downloadPromise;

    // Verify filename format: agentx-prompts-YYYY-MM-DD.json
    const filename = download.suggestedFilename();
    const filenamePattern = /^agentx-prompts-\d{4}-\d{2}-\d{2}\.json$/;
    expect(filename).toMatch(filenamePattern);

    // Verify it's today's date
    const today = new Date().toISOString().split('T')[0];
    expect(filename).toBe(`agentx-prompts-${today}.json`);

    // Save file for inspection
    const downloadPath = path.join(__dirname, 'downloads', filename);
    await download.saveAs(downloadPath);

    // Verify file exists
    const fileExists = await fs.access(downloadPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    // Verify success toast notification
    const toast = page.locator('.toast.success');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/Exported \d+ prompt/);

    // Cleanup
    await fs.unlink(downloadPath).catch(() => {});
  });

  /**
   * Test 2: JSON file contains all prompts with correct structure
   */
  test('should export JSON file with all prompts and correct structure', async ({ page }) => {
    // Mock data already loaded via setupMockAPI

    // Setup download listener
    const downloadPromise = page.waitForEvent('download');

    // Click export button
    await page.click('#exportPromptsBtn');

    // Wait for download and save
    const download = await downloadPromise;
    const downloadPath = path.join(__dirname, 'downloads', download.suggestedFilename());
    await download.saveAs(downloadPath);

    // Read and parse JSON file
    const fileContent = await fs.readFile(downloadPath, 'utf-8');
    const exportData = JSON.parse(fileContent);

    // Verify it's an array
    expect(Array.isArray(exportData)).toBe(true);

    // Verify count
    expect(exportData.length).toBe(3);

    // Verify each prompt has required fields
    exportData.forEach((prompt, index) => {
      expect(prompt).toHaveProperty('name');
      expect(prompt).toHaveProperty('version');
      expect(prompt).toHaveProperty('description');
      expect(prompt).toHaveProperty('author');
      expect(prompt).toHaveProperty('tags');
      expect(prompt).toHaveProperty('systemPrompt');
      expect(prompt).toHaveProperty('isActive');
      expect(prompt).toHaveProperty('trafficWeight');
      expect(prompt).toHaveProperty('createdAt');

      // Verify data types
      expect(typeof prompt.name).toBe('string');
      expect(typeof prompt.version).toBe('number');
      expect(typeof prompt.systemPrompt).toBe('string');
      expect(typeof prompt.isActive).toBe('boolean');
      expect(Array.isArray(prompt.tags)).toBe(true);
    });

    // Verify specific prompt names
    const promptNames = exportData.map(p => p.name);
    expect(promptNames).toContain('test_prompt_1');
    expect(promptNames).toContain('test_prompt_2');
    expect(promptNames).toContain('test_prompt_3');

    // Cleanup
    await fs.unlink(downloadPath).catch(() => {});
  });

  /**
   * Test 3: Import opens file picker
   */
  test('should open file picker when import button is clicked', async ({ page }) => {
    // Setup file chooser listener before clicking
    const fileChooserPromise = page.waitForEvent('filechooser');

    // Click import button
    await page.click('#importPromptsBtn');

    // Wait for file chooser to open
    const fileChooser = await fileChooserPromise;

    // Verify file chooser accepts JSON files
    expect(fileChooser.isMultiple()).toBe(false);

    // Cancel file chooser (by setting empty files array)
    await fileChooser.setFiles([]);
  });

  /**
   * Test 4: Import validates JSON format
   */
  test('should validate JSON format and show error for invalid JSON', async ({ page }) => {
    // Create invalid JSON file (not an array)
    const invalidJson = { invalid: 'format' };
    const invalidJsonPath = path.join(__dirname, 'fixtures', 'invalid.json');
    await fs.mkdir(path.dirname(invalidJsonPath), { recursive: true });
    await fs.writeFile(invalidJsonPath, JSON.stringify(invalidJson));

    // Setup file chooser
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser = await fileChooserPromise;

    // Select invalid file
    await fileChooser.setFiles(invalidJsonPath);

    // Wait for error toast
    const errorToast = page.locator('.toast.error');
    await expect(errorToast).toBeVisible({ timeout: 3000 });
    await expect(errorToast).toContainText(/Invalid format.*Expected array/i);

    // Cleanup
    await fs.unlink(invalidJsonPath).catch(() => {});
  });

  /**
   * Test 5: Import validates prompt data structure
   */
  test('should validate prompt data and skip invalid prompts', async ({ page }) => {
    // Create JSON with valid and invalid prompts
    const mixedData = [
      {
        name: 'valid_prompt',
        version: 1,
        systemPrompt: 'Valid prompt',
        description: 'Valid',
        author: 'test',
        tags: ['test'],
        isActive: false,
        trafficWeight: 100
      },
      {
        // Invalid: missing systemPrompt
        name: 'invalid_prompt_1',
        version: 1,
        description: 'Invalid - no systemPrompt'
      },
      {
        // Invalid: invalid name format (uppercase not allowed)
        name: 'Invalid_Prompt',
        version: 1,
        systemPrompt: 'Invalid name format'
      },
      {
        // Invalid: missing name
        version: 1,
        systemPrompt: 'Missing name'
      }
    ];

    const mixedJsonPath = path.join(__dirname, 'fixtures', 'mixed.json');
    await fs.mkdir(path.dirname(mixedJsonPath), { recursive: true });
    await fs.writeFile(mixedJsonPath, JSON.stringify(mixedData));

    // Setup file chooser and select file
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(mixedJsonPath);

    // Wait for import modal
    const importModal = page.locator('#importModal');
    await expect(importModal).toBeVisible({ timeout: 3000 });

    // Verify modal shows correct counts
    await expect(importModal).toContainText(/1.*valid prompt/i);
    await expect(importModal).toContainText(/3.*invalid.*will be skipped/i);

    // Confirm import
    await page.click('#confirmImportBtn');

    // Wait for success toast
    const successToast = page.locator('.toast.success');
    await expect(successToast).toBeVisible({ timeout: 5000 });
    await expect(successToast).toContainText(/Imported 1 prompt/i);

    // Verify the valid prompt was imported
    await page.waitForSelector('.prompts-header');

    const promptList = page.locator('.prompt-list-container');
    await expect(promptList).toContainText('valid_prompt');

    // Cleanup
    await fs.unlink(mixedJsonPath).catch(() => {});
  });

  /**
   * Test 6: Import detects duplicate prompts
   */
  test('should detect duplicate prompts and show conflict options', async ({ page }) => {
    // Create existing prompts
    await page.waitForSelector('.prompts-header');

    // Export to get exact format
    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportPromptsBtn');
    const download = await downloadPromise;
    const exportPath = path.join(__dirname, 'downloads', 'export.json');
    await download.saveAs(exportPath);

    // Try to import the same file (all duplicates)
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(exportPath);

    // Wait for import modal
    const importModal = page.locator('#importModal');
    await expect(importModal).toBeVisible({ timeout: 3000 });

    // Verify duplicate warning
    await expect(importModal).toContainText(/\d+ prompt.*already exist/i);

    // Verify duplicate strategy selector is present
    const duplicateStrategy = page.locator('#duplicateStrategy');
    await expect(duplicateStrategy).toBeVisible();

    // Verify all three options are available
    const options = await duplicateStrategy.locator('option').allTextContents();
    expect(options).toContain('Skip duplicates (keep existing)');
    expect(options).toContain('Overwrite existing versions');
    expect(options).toContain('Create new versions');

    // Close modal
    await page.click('.modal-overlay .modal-close');

    // Cleanup
    await fs.unlink(exportPath).catch(() => {});
  });

  /**
   * Test 7: Import with "Skip duplicates" strategy
   */
  test('should skip duplicate prompts when strategy is "skip"', async ({ page }) => {
    // Create existing prompts
    await page.waitForSelector('.prompts-header');

    // Export to get exact format
    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportPromptsBtn');
    const download = await downloadPromise;
    const exportPath = path.join(__dirname, 'downloads', 'export-skip.json');
    await download.saveAs(exportPath);

    // Import with skip strategy
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(exportPath);

    // Wait for import modal
    const importModal = page.locator('#importModal');
    await expect(importModal).toBeVisible({ timeout: 3000 });

    // Select "skip" strategy (it's the default)
    await page.selectOption('#duplicateStrategy', 'skip');

    // Confirm import
    await page.click('#confirmImportBtn');

    // Wait for info toast about skipped duplicates
    const infoToast = page.locator('.toast.info');
    await expect(infoToast).toBeVisible({ timeout: 5000 });
    await expect(infoToast).toContainText(/Skipped \d+ duplicate/i);

    // Cleanup
    await fs.unlink(exportPath).catch(() => {});
  });

  /**
   * Test 8: Imported prompts are inactive by default
   */
  test('should import prompts as inactive by default', async ({ page }) => {
    // Create export data with active prompts
    const activePromptsData = [
      {
        name: 'active_test_prompt',
        version: 1,
        description: 'Should be imported as inactive',
        author: 'test',
        tags: ['test'],
        systemPrompt: 'This was active in export',
        isActive: true, // This should be ignored during import
        trafficWeight: 100
      }
    ];

    const activePath = path.join(__dirname, 'fixtures', 'active.json');
    await fs.mkdir(path.dirname(activePath), { recursive: true });
    await fs.writeFile(activePath, JSON.stringify(activePromptsData));

    // Import file
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(activePath);

    // Wait for import modal and confirm
    const importModal = page.locator('#importModal');
    await expect(importModal).toBeVisible({ timeout: 3000 });
    await page.click('#confirmImportBtn');

    // Wait for success
    const successToast = page.locator('.toast.success');
    await expect(successToast).toBeVisible({ timeout: 5000 });

    // Reload and verify prompt is inactive
    await page.waitForSelector('.prompts-header');

    // Find the imported prompt card
    const promptCard = page.locator('.prompt-card').filter({ hasText: 'active_test_prompt' });
    await expect(promptCard).toBeVisible();

    // Verify it has inactive badge
    const inactiveBadge = promptCard.locator('.badge').filter({ hasText: /inactive/i });
    await expect(inactiveBadge).toBeVisible();

    // Cleanup
    await fs.unlink(activePath).catch(() => {});
  });

  /**
   * Test 9: Import success notification shows correct count
   */
  test('should show correct success notification with import count', async ({ page }) => {
    // Create import data with 3 new prompts
    const newPromptsData = [];
    for (let i = 1; i <= 3; i++) {
      newPromptsData.push({
        name: `new_import_${i}`,
        version: 1,
        description: `New import ${i}`,
        author: 'import-test',
        tags: ['import'],
        systemPrompt: `New prompt ${i}`,
        isActive: false,
        trafficWeight: 100
      });
    }

    const newPath = path.join(__dirname, 'fixtures', 'new.json');
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await fs.writeFile(newPath, JSON.stringify(newPromptsData));

    // Import file
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(newPath);

    // Wait for import modal and confirm
    const importModal = page.locator('#importModal');
    await expect(importModal).toBeVisible({ timeout: 3000 });
    await page.click('#confirmImportBtn');

    // Verify success toast with correct count
    const successToast = page.locator('.toast.success');
    await expect(successToast).toBeVisible({ timeout: 5000 });
    await expect(successToast).toContainText(/Imported 3 prompts successfully/i);

    // Verify prompts appear in list
    await page.waitForSelector('.prompts-header');

    const promptList = page.locator('.prompt-list-container');
    await expect(promptList).toContainText('new_import_1');
    await expect(promptList).toContainText('new_import_2');
    await expect(promptList).toContainText('new_import_3');

    // Cleanup
    await fs.unlink(newPath).catch(() => {});
  });

  /**
   * Test 10: Import error notification for file read errors
   */
  test('should show error notification for file read errors', async ({ page }) => {
    // Create malformed JSON file (not valid JSON)
    const malformedPath = path.join(__dirname, 'fixtures', 'malformed.json');
    await fs.mkdir(path.dirname(malformedPath), { recursive: true });
    await fs.writeFile(malformedPath, '{ invalid json content }}}');

    // Import file
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(malformedPath);

    // Verify error toast appears
    const errorToast = page.locator('.toast.error');
    await expect(errorToast).toBeVisible({ timeout: 3000 });
    await expect(errorToast).toContainText(/Import failed/i);

    // Cleanup
    await fs.unlink(malformedPath).catch(() => {});
  });

  /**
   * Test 11: Complete export-import workflow
   */
  test('should complete full export-import workflow successfully', async ({ page }) => {
    // Step 1: Create initial prompts
    await page.waitForSelector('.prompts-header');

    // Verify initial count
    const totalPrompts = await page.locator('#totalPrompts').textContent();
    expect(totalPrompts).toBe('2');

    // Step 2: Export prompts
    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportPromptsBtn');
    const download = await downloadPromise;
    const exportPath = path.join(__dirname, 'downloads', 'workflow.json');
    await download.saveAs(exportPath);

    // Verify export success
    const exportToast = page.locator('.toast.success');
    await expect(exportToast).toBeVisible();

    // Step 3: Delete all prompts
    await cleanupTestPrompts(page);
    await page.waitForSelector('.prompts-header');

    // Verify empty state
    const emptyState = page.locator('#emptyState');
    await expect(emptyState).toBeVisible();

    // Step 4: Re-import the prompts
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(exportPath);

    // Confirm import
    const importModal = page.locator('#importModal');
    await expect(importModal).toBeVisible({ timeout: 3000 });
    await page.click('#confirmImportBtn');

    // Wait for success
    const importToast = page.locator('.toast.success');
    await expect(importToast).toBeVisible({ timeout: 5000 });

    // Step 5: Verify prompts are restored
    await page.waitForSelector('.prompts-header');

    const restoredCount = await page.locator('#totalPrompts').textContent();
    expect(restoredCount).toBe('2');

    // Verify prompt names are present
    const promptList = page.locator('.prompt-list-container');
    await expect(promptList).toContainText('test_prompt_1');
    await expect(promptList).toContainText('test_prompt_2');

    // Cleanup
    await fs.unlink(exportPath).catch(() => {});
  });

  /**
   * Test 12: Import with empty file
   */
  test('should handle empty JSON array gracefully', async ({ page }) => {
    // Create empty array file
    const emptyPath = path.join(__dirname, 'fixtures', 'empty.json');
    await fs.mkdir(path.dirname(emptyPath), { recursive: true });
    await fs.writeFile(emptyPath, '[]');

    // Import file
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(emptyPath);

    // Verify error toast
    const errorToast = page.locator('.toast.error');
    await expect(errorToast).toBeVisible({ timeout: 3000 });
    await expect(errorToast).toContainText(/No valid prompts found/i);

    // Cleanup
    await fs.unlink(emptyPath).catch(() => {});
  });

  /**
   * Test 13: Export button shows correct count in toast
   */
  test('should show correct prompt count in export toast', async ({ page }) => {
    // Create 5 prompts
    await page.waitForSelector('.prompts-header');

    // Export
    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportPromptsBtn');
    await downloadPromise;

    // Verify toast shows correct count
    const toast = page.locator('.toast.success');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/Exported 5 prompts/i);
  });

  /**
   * Test 14: File input resets after import
   */
  test('should reset file input after import to allow re-importing', async ({ page }) => {
    // Create test data
    const testData = [{
      name: 'reset_test',
      version: 1,
      systemPrompt: 'Test',
      description: 'Test',
      author: 'test',
      tags: [],
      isActive: false,
      trafficWeight: 100
    }];

    const testPath = path.join(__dirname, 'fixtures', 'reset.json');
    await fs.mkdir(path.dirname(testPath), { recursive: true });
    await fs.writeFile(testPath, JSON.stringify(testData));

    // First import
    const fileChooser1Promise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser1 = await fileChooser1Promise;
    await fileChooser1.setFiles(testPath);

    const importModal1 = page.locator('#importModal');
    await expect(importModal1).toBeVisible({ timeout: 3000 });
    await page.click('#confirmImportBtn');

    await page.waitForTimeout(2000); // Wait for import to complete

    // Delete the imported prompt
    await cleanupTestPrompts(page);

    // Second import - should work (file input was reset)
    const fileChooser2Promise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser2 = await fileChooser2Promise;
    await fileChooser2.setFiles(testPath);

    const importModal2 = page.locator('#importModal');
    await expect(importModal2).toBeVisible({ timeout: 3000 });

    // If file input wasn't reset, this wouldn't trigger
    await expect(importModal2).toContainText(/1.*valid prompt/i);

    // Cleanup
    await page.click('.modal-close');
    await fs.unlink(testPath).catch(() => {});
  });
});

/**
 * Additional test suite for edge cases and error handling
 */
test.describe('Export/Import Edge Cases', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
    await cleanupTestPrompts(page);
    await page.goto(`${BASE_URL}/prompts.html`);
    await page.waitForSelector('.prompts-header');
  });

  test.afterEach(async ({ page }) => {
    await cleanupTestPrompts(page);
  });

  test('should export empty prompt library with correct message', async ({ page }) => {
    // Ensure no prompts exist
    await cleanupTestPrompts(page);
    await page.waitForSelector('.prompts-header');

    // Try to export
    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportPromptsBtn');
    const download = await downloadPromise;

    const downloadPath = path.join(__dirname, 'downloads', 'empty-export.json');
    await download.saveAs(downloadPath);

    // Read file content
    const content = await fs.readFile(downloadPath, 'utf-8');
    const data = JSON.parse(content);

    // Should be empty array
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);

    // Toast should reflect 0 prompts
    const toast = page.locator('.toast.success');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/Exported 0 prompt/i);

    // Cleanup
    await fs.unlink(downloadPath).catch(() => {});
  });

  test('should handle import of prompts with special characters in content', async ({ page }) => {
    const specialData = [{
      name: 'special_chars_test',
      version: 1,
      systemPrompt: 'Special chars: <>&"\'\n\t\r{{var}} [[data]] /* comment */',
      description: 'Test with special characters',
      author: 'test-<special>',
      tags: ['test', 'special-chars'],
      isActive: false,
      trafficWeight: 100
    }];

    const specialPath = path.join(__dirname, 'fixtures', 'special.json');
    await fs.mkdir(path.dirname(specialPath), { recursive: true });
    await fs.writeFile(specialPath, JSON.stringify(specialData));

    // Import
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('#importPromptsBtn');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(specialPath);

    const importModal = page.locator('#importModal');
    await expect(importModal).toBeVisible({ timeout: 3000 });
    await page.click('#confirmImportBtn');

    // Should succeed
    const successToast = page.locator('.toast.success');
    await expect(successToast).toBeVisible({ timeout: 5000 });

    // Cleanup
    await fs.unlink(specialPath).catch(() => {});
  });

  test('should preserve prompt metadata during export-import cycle', async ({ page }) => {
    // Create prompt with specific metadata
    const originalData = {
      name: 'metadata_test',
      version: 1,
      description: 'Metadata preservation test',
      author: 'metadata-author',
      tags: ['tag1', 'tag2', 'tag3'],
      systemPrompt: 'Test system prompt for metadata',
      isActive: false,
      trafficWeight: 75
    };

    await page.evaluate(async (data) => {
      await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    }, originalData);

    await page.waitForSelector('.prompts-header');

    // Export
    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportPromptsBtn');
    const download = await downloadPromise;
    const exportPath = path.join(__dirname, 'downloads', 'metadata.json');
    await download.saveAs(exportPath);

    // Read export
    const exportContent = await fs.readFile(exportPath, 'utf-8');
    const exportData = JSON.parse(exportContent);
    const exportedPrompt = exportData.find(p => p.name === 'metadata_test');

    // Verify all metadata is present
    expect(exportedPrompt.description).toBe(originalData.description);
    expect(exportedPrompt.author).toBe(originalData.author);
    expect(exportedPrompt.tags).toEqual(originalData.tags);
    expect(exportedPrompt.systemPrompt).toBe(originalData.systemPrompt);
    expect(exportedPrompt.trafficWeight).toBe(originalData.trafficWeight);

    // Cleanup
    await fs.unlink(exportPath).catch(() => {});
  });
});
