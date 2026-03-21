const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const TIMEOUT = 30_000;

function buildRosterResponse(defaultJudgeModel = 'judge-alpha:14b') {
  return {
    status: 'success',
    data: {
      hostPanels: [
        {
          hostUrl: 'http://judge-host:11434',
          hostName: 'Judge Host',
          defaultJudgeModel,
          judges: [
            {
              modelName: 'judge-alpha:14b',
              reliability: 0.91,
              avgLatencyMs: 1840,
              evalCount: 124,
              calibratedAt: '2026-03-13T12:00:00.000Z',
              source: 'registry',
              contextWindow: {
                effectiveNumCtx: 8192,
                overrideNumCtx: null,
                probedNumCtx: 8192,
                defaultNumCtx: 8192,
                legacyNumCtx: 8192,
                source: 'context_test'
              },
              tierMeta: {
                effectiveTier: 'advanced',
                curatedTier: 'advanced',
                calibratedTier: 'advanced',
                recommendedTier: 'advanced',
                inferredTier: 'advanced',
                source: 'curated'
              },
              availableOn: [{ url: 'http://judge-host:11434', name: 'Judge Host' }]
            },
            {
              modelName: 'judge-beta:7b',
              reliability: 0.84,
              avgLatencyMs: 980,
              evalCount: 42,
              calibratedAt: null,
              source: 'registry',
              contextWindow: {
                effectiveNumCtx: 4096,
                overrideNumCtx: null,
                probedNumCtx: null,
                defaultNumCtx: 4096,
                legacyNumCtx: 4096,
                source: 'execution_default'
              },
              tierMeta: {
                effectiveTier: 'standard',
                curatedTier: 'standard',
                calibratedTier: 'advanced',
                recommendedTier: 'advanced',
                inferredTier: 'standard',
                source: 'curated'
              },
              availableOn: [{ url: 'http://judge-host:11434', name: 'Judge Host' }]
            }
          ],
          levelRequirements: [
            { level: 1, requiredTier: 'basic' },
            { level: 2, requiredTier: 'standard' },
            { level: 3, requiredTier: 'standard' },
            { level: 4, requiredTier: 'advanced' },
            { level: 5, requiredTier: 'advanced' }
          ]
        }
      ],
      judgeTiers: {
        basic: { label: 'Basic', shortLabel: 'BASIC', modelRange: '2-3B', rank: 1 },
        standard: { label: 'Standard', shortLabel: 'STD', modelRange: '7-9B', rank: 2 },
        advanced: { label: 'Advanced', shortLabel: 'ADV', modelRange: '14-32B', rank: 3 },
        premium: { label: 'Premium', shortLabel: 'PRO', modelRange: '70B+', rank: 4 }
      },
      levelRequirements: [
        { level: 1, requiredTier: 'basic' },
        { level: 2, requiredTier: 'standard' },
        { level: 3, requiredTier: 'standard' },
        { level: 4, requiredTier: 'advanced' },
        { level: 5, requiredTier: 'advanced' }
      ],
      tierRank: { basic: 1, standard: 2, advanced: 3, premium: 4 }
    }
  };
}

async function mockCourthouseApis(page) {
  let currentDefault = 'judge-alpha:14b';
  let currentCuratedTier = 'standard';

  await page.route('**/api/benchmark/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/benchmark/judge-roster' && request.method() === 'GET') {
      const roster = buildRosterResponse(currentDefault);
      roster.data.hostPanels[0].judges[1].tierMeta.curatedTier = currentCuratedTier;
      roster.data.hostPanels[0].judges[1].tierMeta.effectiveTier = currentCuratedTier;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(roster) });
    }

    if (url.pathname === '/api/benchmark/judge-defaults' && request.method() === 'PUT') {
      const body = JSON.parse(request.postData() || '{}');
      currentDefault = body.judgeModel;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', data: body }) });
    }

    if (url.pathname.includes('/api/benchmark/judge-roster/') && url.pathname.endsWith('/tier') && request.method() === 'PATCH') {
      const body = JSON.parse(request.postData() || '{}');
      currentCuratedTier = body.tier;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', data: body }) });
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', data: {} }) });
  });
}

async function openCourthouse(page) {
  await mockCourthouseApis(page);
  await page.goto(`${BASE_URL}/courthouse.html`, { waitUntil: 'networkidle', timeout: TIMEOUT });
  await page.waitForSelector('#judgeRosterPanels .roster-host-panel', { timeout: TIMEOUT });
}

test.describe('Courthouse governance roster', () => {
  test('renders effective, curated, and recommended tier metadata', async ({ page }) => {
    await openCourthouse(page);

    await expect(page.locator('#judgeRosterPanels')).toContainText('DEFAULT ON HOST');
    await expect(page.locator('#judgeRosterPanels')).toContainText('judge-alpha:14b');
    await expect(page.locator('#judgeRosterPanels')).toContainText('judge-beta:7b');
    await expect(page.locator('#judgeRosterPanels')).toContainText('ADV');
    await expect(page.locator('#judgeRosterPanels')).toContainText('STD');
    await expect(page.locator('#judgeRosterPanels')).toContainText('8,192 ctx');
  });

  test('sets a host default and refreshes the default badge', async ({ page }) => {
    await openCourthouse(page);

    await page.locator('tr[data-model="judge-beta:7b"] .roster-set-default-btn').click();

    await expect(page.locator('tr[data-model="judge-beta:7b"]')).toContainText('DEFAULT ON HOST');
  });

  test('updates curated tier through the governance selector', async ({ page }) => {
    await openCourthouse(page);

    const select = page.locator('tr[data-model="judge-beta:7b"] .roster-tier-select');
    await select.selectOption('advanced');

    await expect(select).toHaveValue('advanced');
    await expect(page.locator('tr[data-model="judge-beta:7b"]')).toContainText('ADV');
  });
});
