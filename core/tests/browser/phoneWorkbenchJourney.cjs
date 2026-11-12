'use strict';
const assert = require('node:assert/strict'),
  path = require('node:path'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  crypto = require('node:crypto');
const express = require('express'),
  sharp = require('sharp');
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const { registerPhone } = require('../../surfaces/diskx/phone');
const uuid = () => crypto.randomUUID();
(async () => {
  const app = express(),
    runId = uuid(),
    calls = [],
    plans = new Map(),
    operations = new Map(),
    reviews = new Map(),
    deleted = new Set();
  let latest = null,
    loseReply = true,
    effects = 0;
  const sources = Array.from({ length: 6 }, (_, i) => ({
    requestId: uuid(),
    name: i === 5 ? '<img onerror=alert(1)>.jpg' : `Souvenir-${i + 1}.jpg`,
    relativePath: `Storage/${i < 3 ? 'DCIM/Camera' : 'Pictures/Screenshots'}/Souvenir-${i + 1}.jpg`,
    key: 'source-' + i,
    size: 1200000 + i * 27000,
    format: '.jpg',
    modified: '64:133500000000000000',
    backup: {
      disposition: i === 2 ? 'duplicate' : 'copied',
      verifiedAt: '2026-01-01T12:00:00Z',
      sha256: String(i).repeat(64),
    },
  }));
  const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#adc38e' } })
    .jpeg()
    .toBuffer();
  const bridge = {
    call: async (input) => {
      calls.push(input);
      switch (input.op) {
        case 'status':
          return { available: true, cleanupEnabled: true, jobs: latest ? [latest] : [] };
        case 'devices':
          return { devices: [{ id: 'synthetic-phone', name: 'Android de démonstration' }] };
        case 'runs':
          return {
            runs: [
              {
                runId,
                at: '2026-01-01T12:00:00Z',
                selected: sources.length,
                coverage: { enumerationComplete: true },
              },
            ],
          };
        case 'page':
          return {
            runId,
            total: sources.length,
            offset: 0,
            limit: 24,
            coverage: { enumerationComplete: true, signatureAuditComplete: true },
            items: sources.map((x) => ({
              ...x,
              review: reviews.get(x.requestId) || { choice: 'review', revision: 0 },
              phone: deleted.has(x.requestId) ? 'deleted' : 'not-requested',
            })),
          };
        case 'preview':
          return { bytes: jpeg.toString('base64') };
        case 'review': {
          const value = { choice: input.choice, revision: input.expectedRevision + 1 };
          reviews.set(input.requestId, value);
          return value;
        }
        case 'prepare': {
          const items = input.items.map((id) => sources.find((x) => x.requestId === id));
          const plan = {
            planId: input.planId,
            runId,
            items,
            bytes: items.reduce((n, x) => n + x.size, 0),
            digest: 'a'.repeat(64),
            confirmation: `SUPPRIMER ${items.length}`,
          };
          plans.set(plan.planId, plan);
          return plan;
        }
        case 'start': {
          if (input.kind === 'import') {
            latest = {
              requestId: input.requestId,
              kind: 'import',
              runId,
              state: 'completed',
              progress: { selected: 6, verified: 6 },
            };
            return latest;
          }
          if (operations.has(input.requestId)) return operations.get(input.requestId);
          const plan = plans.get(input.planId);
          assert.equal(input.digest, plan.digest);
          assert.equal(input.confirmation, plan.confirmation);
          effects++;
          plan.items.forEach((x) => deleted.add(x.requestId));
          latest = {
            requestId: input.requestId,
            kind: 'cleanup',
            state: 'completed',
            result: { deleted: plan.items.length, confirmedBytes: plan.bytes },
          };
          operations.set(input.requestId, latest);
          if (loseReply) {
            loseReply = false;
            throw Object.assign(
              new Error('Réponse perdue après réception native : réconcilier la même opération.'),
              { code: 'SIMULATED_ACK_LOSS' },
            );
          }
          return latest;
        }
        default:
          throw Error('Unexpected operation ' + input.op);
      }
    },
  };
  app.use('/assets/diskx', express.static(path.join(__dirname, '../../surfaces/diskx/public')));
  registerPhone({ app, express, bridge });
  const server = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.AGENTX_BROWSER_EXECUTABLE
      ? { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }
      : {}),
  });
  const dir = process.env.AGENTX_BROWSER_REPORT_DIR || path.join(os.tmpdir(), 'agentx-phone-workbench');
  await fs.mkdir(dir, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1050 }, reducedMotion: 'reduce' }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/diskx/phone`);
    await page.locator('.card').first().waitFor();
    assert.equal(await page.locator('.card').count(), 6);
    assert.equal(effects, 0);
    await page.getByRole('button', { name: 'Détecter le téléphone' }).click();
    await page.locator('#device-state').filter({ hasText: 'Android de démonstration' }).waitFor();
    await page.getByRole('button', { name: 'Importer les nouveaux médias' }).click();
    await page.getByText('Opération terminée', { exact: true }).waitFor();
    assert.equal(effects, 0);
    await page.locator('.card select').first().selectOption('archive');
    await page.waitForFunction(() => document.querySelector('.card select').disabled === false);
    await page.getByRole('button', { name: 'Actualiser', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.card select').first().inputValue(), 'archive');
    await page.getByRole('button', { name: 'Sélectionner les copies de cette page' }).click();
    assert.equal(await page.locator('.card input:checked').count(), 6);
    assert.equal(effects, 0);
    await page.getByRole('button', { name: 'Vider la sélection' }).click();
    await page.locator('.card input[type=checkbox]').nth(0).check();
    await page.locator('.card input[type=checkbox]').nth(1).check();
    assert.equal(effects, 0);
    await page.getByRole('button', { name: 'Vérifier ma sélection' }).click();
    await page.locator('dialog[open]').waitFor();
    assert.equal(effects, 0);
    await page.locator('#confirmation-text').fill('SUPPRIMER 999');
    assert.equal(await page.locator('#confirm-delete').isDisabled(), true);
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    assert.equal(effects, 0);
    assert.equal(await page.locator('.card h3 img').count(), 0, 'source names are escaped as text');
    sources[5].name = 'Souvenir-6.jpg';
    await page.getByRole('button', { name: 'Actualiser', exact: true }).click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(dir, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(dir, 'mobile.png'), fullPage: true });
    await page.getByRole('button', { name: 'Vérifier ma sélection' }).click();
    await page.locator('#confirmation-text').fill('SUPPRIMER 2');
    await page.getByRole('button', { name: 'Supprimer du téléphone', exact: true }).click();
    await page.getByText(/Réponse perdue/).waitFor();
    assert.equal(effects, 1);
    await page.getByRole('button', { name: 'Supprimer du téléphone', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('dialog').open);
    assert.equal(effects, 1, 'lost acknowledgments retain the same native operation identity');
    const starts = calls.filter((x) => x.op === 'start' && x.kind === 'cleanup');
    assert.equal(starts.length, 2);
    assert.equal(starts[0].requestId, starts[1].requestId);
    await page.getByRole('button', { name: 'Actualiser', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.getByText('Supprimé du téléphone', { exact: true }).count(), 2);
    assert.equal(await page.locator('.card input:disabled').count(), 2);
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(dir, 'result.json'),
      JSON.stringify({
        passed: true,
        effects,
        selected: 2,
        duplicateDispatchPrevented: true,
        pageErrors: errors,
      }),
    );
    console.log('PHONE_BROWSER_PASS ' + dir);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
