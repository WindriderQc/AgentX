'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
// Disposable Mongo and loopback only. Playwright is supplied through NODE_PATH.
const tree = path.resolve(__dirname, '../../..');
const reportDir = process.env.MY_DAY_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(tree + path.sep)) throw Error('Set MY_DAY_REPORT_DIR outside the checkout');
fs.mkdirSync(reportDir, { recursive: true });
const req = createRequire(tree + '/core/package.json');
const express = req('express');
const mongoose = req('mongoose');
const { MongoMemoryServer } = req('mongodb-memory-server');
const { chromium } = require('playwright');
const service = req('./src/services/personalTaskService');
const PipelineTask = req('./models/PipelineTask');
const { registerSecretaryRoutes } = req('./surfaces/household/secretary-routes');
let mongo, server, browser;
const errors = [], checks = [];
(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
  await mongoose.connect(mongo.getUri('personal_review_browser_test'));
  const personal = { list: service.listPersonalTasks, snapshot: service.personalTaskSnapshot, review: service.reviewPersonalTask, edit: service.editPersonalAction, create: service.createPersonalTask, update: service.updatePersonalTask, complete: service.completePersonalTask };
  const app = express();
  app.get('/api/reports/morning-brief', (_q, res) => res.json({ data: { alerts: {}, memoryReview: { pending: 0 } } }));
  app.get('/api/budget/status', (_q, res) => res.json({ data: {} }));
  app.get('/api/secretary/mail', (_q, res) => res.json({ ok: true, data: { count: 0, threads: [] } }));
  app.get('/api/voice-personas/knowledge/status', (_q, res) => res.json({ data: { knowledge: { enabled: false, pathsIncluded: false, contentIncluded: false, legacySourcesEligible: false, documentCount: 0 } } }));
  registerSecretaryRoutes(app, { express, standardJsonParser: express.json(),
    envelope: (res, data, status = 200) => res.status(status).json({ ok: true, data }),
    fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }),
    personalTasks: personal, CORE_SELF_URL: () => `http://127.0.0.1:${server.address().port}`,
    bridgeProjection: async () => ({ data: [] }), secretaryMail: () => ({ backlog: async () => ({ unlabelled: 0 }), catchup: async () => null }),
    familyTasks: { listProfiles: async () => ({ profiles: [] }), list: async () => ({ chores: [] }) },
    models: { DeviceAcceptance: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) } }, knowledgeState: { status: {} }, mongoose });
  app.use('/assets/household', express.static(tree + '/core/surfaces/household/public'));
  app.use('/css', express.static(tree + '/core/public/css'));
  const styles = [...fs.readFileSync(tree + '/core/surfaces/household/public/index.html', 'utf8').matchAll(/<link rel="stylesheet"[^>]+>/g)].map(match => match[0]).join('');
  app.get('/dad/day', (_q, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles}</head><body class="household-product"><main id="app"></main><script src="/assets/household/personal-finding-view.js"></script><script src="/assets/household/personal-task-review.js"></script><script src="/assets/household/personal-actions.js"></script><script src="/assets/household/dad-day.js"></script><script>
    window.HouseholdShopping = { mount() {} };
    window.HouseholdDadDay.load({ app: document.getElementById('app'),
      api: async (url, options) => { const r = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' } }); const b = await r.json(); if(!r.ok) throw Error(b.message); return b.data; },
      esc: x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
      toast: x => { window.lastToast = x; }, setRuntime() {}, speak() {}, clock() {} });
    </script></body></html>`));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  for (const [device, viewport] of [['desktop', { width: 1440, height: 1100 }], ['mobile', { width: 390, height: 844 }]]) {
    await PipelineTask.deleteMany({});
    await PipelineTask.insertMany([
      { pipelineId: '0001', service: 'personal', title: 'Call the garage', source: 'household-dad-desk' },
      ...Array.from({ length: 103 }, (_, i) => ({ pipelineId: String(i + 2).padStart(4, '0'), service: 'personal', title: i === 0 ? 'A correspondent requested a meeting <script>bad()</script>' : `Synthetic request ${i}`, origin: 'email', spec: i < 2 ? 'Quoted meeting request. No agreement recorded. Objet « Planning ». Source: https://mail.google.com/mail/#all/syntheticShared' : i === 102 ? 'Unique phrase on the second API page: étoile' : `Source: https://mail.google.com/mail/#all/synthetic${i}`, dueAt: new Date('2020-01-01') })),
      { pipelineId: '0105', service: 'personal', title: 'Fix a failed CI/CD workflow' },
      { pipelineId: '0106', service: 'personal', title: 'Continuer la lecture du PDF (offset 8000/12000)' },
    ]);
    const page = await browser.newPage({ viewport, timezoneId: 'America/Toronto' });
    page.on('pageerror', e => errors.push(`${device}: ${e.message}`));
    await page.goto(`http://127.0.0.1:${server.address().port}/dad/day`);
    await page.waitForFunction(() => document.querySelector('[data-review-count]')?.textContent === '105');
    assert.equal(await page.locator('#dadActionCount').textContent(), '1');
    assert.equal(await page.locator('#dadReviewCount').textContent(), '101');
    assert.equal(await page.locator('#dadOverdue').textContent(), '0');
    assert.equal(await page.locator('#dad-proposals').isVisible(), false);
    await page.locator('[data-day-view="email"]').click();
    assert.equal(await page.locator('[data-review-thread]').count(), 16);
    assert.match(await page.locator('[data-review-results]').textContent(), /103 relevés · 101 échanges · 1 sans lien vers un courriel/);
    await page.locator('[data-review-page="next"]').click();
    assert.equal(await page.locator('[data-review-page-label]').textContent(), '17–32 sur 102');
    await page.locator('[data-review-search]').fill('etoile');
    assert.match(await page.locator('[data-review-results]').textContent(), /1 relevé · 1 sans lien vers un courriel/);
    await page.locator('[data-review-search]').fill('meeting');
    assert.match(await page.locator('[data-review-results]').textContent(), /2 relevés · 1 échange/);
    await page.locator('[data-review-thread]').first().click();
    await page.locator('[data-review-item]').selectOption('0002');
    assert.match(await page.locator('.finding-title').textContent(), /<script>bad/);
    assert.equal(await page.evaluate(() => typeof window.bad), 'undefined');
    assert.equal(await page.locator('[data-review-detail] a[href^="https://mail.google.com/"]').count(), 1);
    await page.locator('[data-proposal-source] > summary').click();
    assert.match(await page.locator('[data-proposal-source]').textContent(), /No agreement recorded/);
    await page.locator('[data-proposal-edit] > summary').click();
    assert.equal(await page.locator('form[data-proposal] [name="dueAt"]').inputValue(), '');
    assert.equal(await page.locator('form[data-proposal] [name="title"]').inputValue(), '');
    await page.locator('form[data-proposal] button[type="submit"]').click();
    assert.notEqual((await PipelineTask.findOne({ pipelineId: '0002' }).lean()).personalReview?.state, 'accepted');
    await page.locator('form[data-proposal] [name="title"]').fill('Choose a meeting time');
    await page.locator('form[data-proposal] button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#dad-inbox').textContent.includes('Choose a meeting time'));
    const saved = await PipelineTask.findOne({ pipelineId: '0002' }).lean();
    assert.equal(saved.dueAt, null); assert.equal(saved.personalReview.state, 'accepted');
    assert.match(saved.spec, /No agreement recorded/); assert.match(saved.feedback[0].text, /correspondent/);
    await page.locator('[data-day-view="actions"]').click();
    const action = page.locator('#dad-inbox .dad-task').filter({ hasText: 'Choose a meeting time' });
    await action.locator('.dad-task-schedule > summary').click();
    await action.locator('[data-schedule="0"]').click();
    await page.waitForFunction(() => Number(document.querySelector('#dadToday').textContent) === 1);
    const scheduled = await PipelineTask.findOne({ pipelineId: '0002' }).lean();
    assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(scheduled.dueAt), '23:59');
    await page.locator('[data-action-edit="0002"]').click();
    await page.locator('[data-action-editor] [name="title"]').fill('Book the office meeting');
    await page.locator('[data-action-editor] button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#dad-inbox').textContent.includes('Book the office meeting'));
    assert.equal((await PipelineTask.findOne({ pipelineId: '0002' }).lean()).dueAt.toISOString(), scheduled.dueAt.toISOString());
    await page.locator('[data-action-edit="0002"]').click();
    await page.locator('[data-action-editor] [name="title"]').fill('My unsaved edit');
    await personal.update({ ref: '0002', priority: 2 });
    await page.locator('[data-action-editor] button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('[data-action-error]').textContent.includes('changé'));
    assert.equal(await page.locator('[data-action-editor] [name="title"]').inputValue(), 'My unsaved edit');
    assert.equal((await PipelineTask.findOne({ pipelineId: '0002' }).lean()).title, 'Book the office meeting');
    await page.locator('[data-action-editor] footer [data-action-cancel]').click();
    await page.locator('[data-day-view="email"]').click();
    await page.locator('[data-review-search]').fill('');
    await page.locator('[data-review-category="platform"]').click();
    assert.equal(await page.locator('[data-review-category="platform"]').evaluate(el => el === document.activeElement), true);
    await page.locator('[data-review-thread]').first().click();
    assert.equal(await page.locator('[data-proposal-edit]').count(), 0);
    await page.locator('[data-proposal-action="dismiss"]').click();
    await page.waitForFunction(() => document.querySelector('[data-review-count]').textContent === '103');
    await page.locator('[data-review-dismissed]').check();
    await page.waitForFunction(() => document.querySelector('[data-review-count]').textContent === '1');
    await page.locator('[data-review-thread]').first().click();
    await page.locator('[data-proposal-action="restore"]').click();
    await page.waitForFunction(() => document.querySelector('[data-review-status]').textContent.includes('remis'));
    await page.locator('[data-review-dismissed]').uncheck();
    await page.waitForFunction(() => document.querySelector('[data-review-count]').textContent === '104');
    await page.locator('[data-review-category="email"]').click();
    await page.locator('[data-review-search]').fill('meeting');
    await page.locator('[data-review-thread]').first().click();
    await page.locator('[data-proposal-edit] > summary').click();
    await page.locator('form[data-proposal] [name="title"]').fill('Confirm the office meeting');
    await PipelineTask.updateOne({ pipelineId: '0003' }, { $inc: { __v: 1 } });
    await page.locator('form[data-proposal] button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('[data-review-status]').textContent.includes('changed'));
    assert.equal(await page.locator('form[data-proposal] [name="title"]').inputValue(), 'Confirm the office meeting');
    assert.notEqual((await PipelineTask.findOne({ pipelineId: '0003' }).lean()).personalReview?.state, 'accepted');
    if (device === 'mobile') { await page.locator('[data-review-back]').click(); assert.equal(await page.locator('[data-review-list]').isVisible(), true); }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(reportDir, `journey-${device}.png`), fullPage: true });
    checks.push({ device, fullSearchBeyondFirstApiPage: true, groupedSource: true, literalSource: true, acceptance: true, dateNotInferred: true, reversibleDismissal: true, staleRevisionRefused: true, keyboardFocus: true, actionEditor: true, exactDeadlineRetained: true, staleActionEditorRefused: true, noOverflow: true });

    await PipelineTask.insertMany(Array.from({ length: 121 }, (_, i) => ({ pipelineId: String(i + 200).padStart(4, '0'), service: 'personal', title: i === 120 ? 'Complete-list marker étoile' : `Owner action ${i}` })));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-actions-count]')?.textContent === '123');
    await page.locator('[data-actions-search]').fill('etoile');
    assert.match(await page.locator('[data-actions-list]').textContent(), /Complete-list marker étoile/);
    assert.equal(await page.locator('[data-actions-list] .dad-task').count(), 1);
    checks.at(-1).completeActionSearchBeyondFirstApiPage = true;
    await page.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(reportDir, 'browser-result.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if(server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo?.stop();
});
