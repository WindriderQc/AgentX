/**
 * E2E tests for the pinned-only Benchmark Judge Settings modal.
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const TIMEOUT = 30_000;

async function openBenchmarkPage(page) {
    await page.goto(`${BASE_URL}/benchmark.html`, { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForSelector('#settingsBtn', { timeout: TIMEOUT });
}

async function openSettingsModal(page) {
    await page.click('#settingsBtn');
    await page.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });
}

async function cancelModal(page) {
    await page.click('#cancelSettingsBtn');
    await page.waitForSelector('#settingsModal', { state: 'hidden', timeout: 5000 });
}

async function saveModal(page) {
    await page.click('#saveSettingsBtn');
    await page.waitForSelector('#settingsModal', { state: 'hidden', timeout: 5000 });
}

test.describe('Benchmark Judge Settings Modal', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.removeItem('benchmarkJudgeConfig');
        });
        await openBenchmarkPage(page);
    });

    test('shows pinned host and model controls', async ({ page }) => {
        await openSettingsModal(page);
        await expect(page.locator('#judgeHost')).toBeVisible();
        await expect(page.locator('#judgeModel')).toBeVisible();
        await expect(page.locator('#judgeNumCtx')).toBeVisible();
        await expect(page.locator('#judgeCapacityPanel')).toBeVisible();
    });

    test('removes auto-mode controls', async ({ page }) => {
        await openSettingsModal(page);
        await expect(page.locator('#judgeMode_auto')).toHaveCount(0);
        await expect(page.locator('#judgeMode_pinned')).toHaveCount(0);
        await expect(page.locator('#judgeHostPolicy')).toHaveCount(0);
        await expect(page.locator('#judgeAutoSection')).toHaveCount(0);
        await expect(page.locator('#judgeTierAutoUpgrade')).toHaveCount(0);
    });

    test('dead custom-judge-prompt textareas are absent', async ({ page }) => {
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

    test('cancel closes the modal without updating the preview', async ({ page }) => {
        const previewBefore = await page.locator('#judgeConfigPreview').textContent();
        await openSettingsModal(page);
        await page.fill('#judgeTimeout', '99999');
        await cancelModal(page);
        const previewAfter = await page.locator('#judgeConfigPreview').textContent();
        expect(previewAfter).toEqual(previewBefore);
    });

    test('save closes the modal and keeps the preview visible', async ({ page }) => {
        await openSettingsModal(page);
        await page.$eval('#judgeTemp', (input) => {
            input.value = '1';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await saveModal(page);
        await expect(page.locator('#judgeConfigPreview')).toBeVisible();
    });

    test('escape closes the modal without saving', async ({ page }) => {
        const previewBefore = await page.locator('#judgeConfigPreview').textContent();
        await openSettingsModal(page);
        await page.fill('#judgeTimeout', '99999');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#settingsModal', { state: 'hidden', timeout: 5000 });
        const previewAfter = await page.locator('#judgeConfigPreview').textContent();
        expect(previewAfter).toEqual(previewBefore);
    });

    test('stored config with host and model restores pinned judge fields', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('benchmarkJudgeConfig', JSON.stringify({
                host: 'http://127.0.0.1:11434',
                model: 'llama3:latest',
                temperature: 0.2,
                num_ctx: 16384,
                concurrency: 3
            }));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForSelector('#settingsBtn', { timeout: TIMEOUT });

        await openSettingsModal(page);
        await expect(page.locator('#judgeHost')).toBeVisible();
        await expect(page.locator('#judgeModel')).toBeVisible();
        await expect(page.locator('#judgeTemp')).toHaveValue('0.2');
        await expect(page.locator('#judgeNumCtx')).toHaveValue('16384');
        await expect(page.locator('#judgeConcurrency')).toHaveValue('3');
    });

    test('temperature and concurrency sliders remain visible', async ({ page }) => {
        await openSettingsModal(page);
        await expect(page.locator('#judgeTemp')).toBeVisible();
        await expect(page.locator('#judgeConcurrency')).toBeVisible();
    });
});
