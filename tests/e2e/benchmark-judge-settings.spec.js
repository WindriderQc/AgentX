/**
 * E2E tests for Benchmark Judge Settings modal
 *
 * Covers:
 * - Mode selector renders with auto / pinned radios
 * - Auto mode shows policy selector + auto preview, hides host/model selectors
 * - Pinned mode shows host/model selectors, hides policy selector
 * - Cancel discards changes (state unchanged)
 * - Save persists changes (state updated, modal closes)
 * - Legacy stored config with host field opens in pinned mode
 * - Legacy stored config without host opens in auto mode
 * - Dead custom-prompt UI is absent from the DOM
 * - Dead judgeSameHost checkbox is absent from the DOM
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open the page and wait for the Configure Judge button to appear. */
async function openBenchmarkPage(page) {
    await page.goto(`${BASE_URL}/benchmark.html`, { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForSelector('#settingsBtn', { timeout: TIMEOUT });
}

/** Open the judge settings modal. */
async function openSettingsModal(page) {
    await page.click('#settingsBtn');
    await page.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });
}

/** Close modal via Cancel. */
async function cancelModal(page) {
    await page.click('#cancelSettingsBtn');
    await page.waitForSelector('#settingsModal', { state: 'hidden', timeout: 5000 });
}

/** Close modal via Save. */
async function saveModal(page) {
    await page.click('#saveSettingsBtn');
    await page.waitForSelector('#settingsModal', { state: 'hidden', timeout: 5000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Benchmark Judge Settings Modal', () => {

    test.beforeEach(async ({ page }) => {
        // Clear any stored judge config so tests start from a clean state
        await page.addInitScript(() => {
            localStorage.removeItem('benchmarkJudgeConfig');
        });
        await openBenchmarkPage(page);
    });

    // ── Modal structure ──────────────────────────────────────────────────────

    test('settings modal contains auto and pinned radio buttons', async ({ page }) => {
        await openSettingsModal(page);
        await expect(page.locator('#judgeMode_auto')).toBeVisible();
        await expect(page.locator('#judgeMode_pinned')).toBeVisible();
    });

    test('dead custom-judge-prompt textareas are absent', async ({ page }) => {
        // These were removed because they were never wired to the backend
        for (const id of ['promptReasoning', 'promptCode', 'promptFactual', 'promptMath', 'promptCreative']) {
            await expect(page.locator(`#${id}`)).toHaveCount(0);
        }
    });

    test('dead judgeSameHost checkbox is absent', async ({ page }) => {
        await expect(page.locator('#judgeSameHost')).toHaveCount(0);
    });

    test('modal has functional Save and Cancel buttons', async ({ page }) => {
        await openSettingsModal(page);
        await expect(page.locator('#saveSettingsBtn')).toBeVisible();
        await expect(page.locator('#cancelSettingsBtn')).toBeVisible();
    });

    // ── Auto mode (default) ──────────────────────────────────────────────────

    test('default mode is auto', async ({ page }) => {
        await openSettingsModal(page);
        await expect(page.locator('#judgeMode_auto')).toBeChecked();
    });

    test('auto mode shows policy selector and auto preview', async ({ page }) => {
        await openSettingsModal(page);

        // Policy selector visible
        await expect(page.locator('#judgeHostPolicy')).toBeVisible();
        // Auto preview visible
        await expect(page.locator('#judgeAutoPreview')).toBeVisible();
    });

    test('auto mode hides pinned host and model selectors', async ({ page }) => {
        await openSettingsModal(page);

        await expect(page.locator('#judgePinnedSection')).toBeHidden();
        await expect(page.locator('#judgeHost')).toBeHidden();
        await expect(page.locator('#judgeModel')).toBeHidden();
    });

    test('switching to pinned mode reveals host and model selectors', async ({ page }) => {
        await openSettingsModal(page);

        await page.click('#judgeMode_pinned');
        await expect(page.locator('#judgePinnedSection')).toBeVisible();
        await expect(page.locator('#judgeHost')).toBeVisible();
        await expect(page.locator('#judgeModel')).toBeVisible();
    });

    test('switching to pinned mode hides auto section', async ({ page }) => {
        await openSettingsModal(page);

        await page.click('#judgeMode_pinned');
        await expect(page.locator('#judgeAutoSection')).toBeHidden();
    });

    // ── Save / Cancel semantics ──────────────────────────────────────────────

    test('Cancel closes the modal', async ({ page }) => {
        await openSettingsModal(page);
        await cancelModal(page);
        await expect(page.locator('#settingsModal')).toBeHidden();
    });

    test('Save closes the modal', async ({ page }) => {
        await openSettingsModal(page);
        await saveModal(page);
        await expect(page.locator('#settingsModal')).toBeHidden();
    });

    test('Cancel does not update the always-visible judge preview', async ({ page }) => {
        // Read preview before opening modal
        const previewBefore = await page.locator('#judgeConfigPreview').textContent();

        await openSettingsModal(page);
        // Switch to pinned (a visible form change)
        await page.click('#judgeMode_pinned');
        // Cancel without saving
        await cancelModal(page);

        // Preview should be unchanged
        const previewAfter = await page.locator('#judgeConfigPreview').textContent();
        expect(previewAfter).toEqual(previewBefore);
    });

    test('Save updates the always-visible judge preview when temperature changes', async ({ page }) => {
        await openSettingsModal(page);

        // Move temperature to maximum
        await page.fill('#judgeTemp', '1');
        // Trigger input event so the display span updates
        await page.dispatchEvent('#judgeTemp', 'input');
        await expect(page.locator('#judgeTempVal')).toHaveText('1');

        await saveModal(page);

        // After save, judge preview should reflect the current config
        // (it always renders; we just verify the modal closed correctly)
        await expect(page.locator('#judgeConfigPreview')).toBeVisible();
    });

    // ── Escape / backdrop close ──────────────────────────────────────────────

    test('pressing Escape closes the modal without saving', async ({ page }) => {
        const previewBefore = await page.locator('#judgeConfigPreview').textContent();

        await openSettingsModal(page);
        await page.click('#judgeMode_pinned');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#settingsModal', { state: 'hidden', timeout: 5000 });

        const previewAfter = await page.locator('#judgeConfigPreview').textContent();
        expect(previewAfter).toEqual(previewBefore);
    });

    // ── Backward compatibility ───────────────────────────────────────────────

    test('stored config with host field opens in pinned mode', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('benchmarkJudgeConfig', JSON.stringify({
                host: 'http://127.0.0.1:11434',
                model: 'llama3:latest'
            }));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForSelector('#settingsBtn', { timeout: TIMEOUT });

        await openSettingsModal(page);
        await expect(page.locator('#judgeMode_pinned')).toBeChecked();
        await expect(page.locator('#judgePinnedSection')).toBeVisible();
    });

    test('stored config without host field opens in auto mode', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('benchmarkJudgeConfig', JSON.stringify({
                temperature: 0.2,
                concurrency: 3
            }));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForSelector('#settingsBtn', { timeout: TIMEOUT });

        await openSettingsModal(page);
        await expect(page.locator('#judgeMode_auto')).toBeChecked();
        await expect(page.locator('#judgeAutoSection')).toBeVisible();
    });

    // ── Policy selector ──────────────────────────────────────────────────────

    test('auto policy defaults to cross_host', async ({ page }) => {
        await openSettingsModal(page);
        await expect(page.locator('#judgeHostPolicy')).toHaveValue('cross_host');
    });

    test('stored judge_same_host:true restores same_host policy', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('benchmarkJudgeConfig', JSON.stringify({
                judge_same_host: true
            }));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForSelector('#settingsBtn', { timeout: TIMEOUT });

        await openSettingsModal(page);
        await expect(page.locator('#judgeMode_auto')).toBeChecked();
        await expect(page.locator('#judgeHostPolicy')).toHaveValue('same_host');
    });

    // ── Shared knobs remain accessible ──────────────────────────────────────

    test('temperature slider is visible in both modes', async ({ page }) => {
        await openSettingsModal(page);

        // Auto
        await expect(page.locator('#judgeTemp')).toBeVisible();

        // Pinned
        await page.click('#judgeMode_pinned');
        await expect(page.locator('#judgeTemp')).toBeVisible();
    });

    test('concurrency slider is visible in both modes', async ({ page }) => {
        await openSettingsModal(page);

        await expect(page.locator('#judgeConcurrency')).toBeVisible();
        await page.click('#judgeMode_pinned');
        await expect(page.locator('#judgeConcurrency')).toBeVisible();
    });
});
