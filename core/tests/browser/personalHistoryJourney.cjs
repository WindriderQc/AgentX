'use strict';

// Real Core review routes and disposable Mongo; no mailbox, model or LAN host.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const req = createRequire(root + '/core/package.json');
const express = req('express'), mongoose = req('mongoose');
const { MongoMemoryServer } = req('mongodb-memory-server');
const { chromium } = require('playwright');
const reportDir = process.env.PERSONAL_HISTORY_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(root + path.sep)) throw Error('Choose a private report directory outside Git');
fs.mkdirSync(reportDir, { recursive: true });
process.env.NODE_ENV = 'test'; process.env.MONGOMS_VERSION ||= '7.0.24';
const history = req('./src/services/personalHistoryService');
const Entry = req('./models/PersonalHistoryEntry');
const MemoryNote = req('./models/MemoryNote');
const { registerSecretaryHistoryRoutes } = req('./surfaces/household/secretary-history');
let mongo, server, browser;
const errors = [], external = [];
const id = '1a00000000000001';
const source = { system: 'gmail', threadId: id, messageId: id, sourceSha256: 'a'.repeat(64),
  findingId: '1'.repeat(64), direction: 'received' };

(async () => {
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'personal_history_browser_fixture' } });
  await mongoose.connect(mongo.getUri());
  await Entry.createCollection(); await Entry.createIndexes();
  await MemoryNote.createCollection(); await MemoryNote.createIndexes();
  const first = await history.record({ kind: 'action', text: 'Ancien suivi fictif <img src=x onerror=alert(1)>',
    actor: 'Personne fictive', sourceDate: '2020-01-01T12:00:00Z', source });
  await history.record({ kind: 'fact', text: 'Information fictive à retenir', sourceDate: '2025-03-01T12:00:00Z',
    eventDateAsWritten: 'le vendredi suivant', source: { ...source, findingId: '2'.repeat(64) } });
  await history.record({ kind: 'action', text: 'Suivi récent fictif', sourceDate: '2026-03-01T12:00:00Z',
    source: { ...source, findingId: '3'.repeat(64) } });
  for (const n of [4, 5]) await history.record({ kind: 'fact', text: `Souvenir fictif ${n}`, sourceDate: `2018-0${n}-01T12:00:00Z`,
    source: { ...source, findingId: String(n).repeat(64) } });
  const app = express(); app.use(express.json());
  app.use('/assets/household', express.static(root + '/core/surfaces/household/public'));
  const router = express.Router();
  registerSecretaryHistoryRoutes({ router, envelope: (res, data) => res.json({ status: 'success', data }),
    fail: (res, code, message) => res.status(code).json({ status: 'error', message }) });
  app.use('/api/secretary', router);
  app.get(`/api/secretary/archive/${id}`, (request, response) => response.json({ status: 'success', data: {
    body: request.query.part === '2' ? 'Information uniquement dans la version HTML <img src=x onerror=alert(1)>'
      : request.query.offset === '10000' ? 'Fin de la source fictive sauvegardée.' : 'Source fictive sauvegardée <img src=x onerror=alert(1)>',
    bodyReadable: true, bodyTruncated: request.query.part !== '2' && request.query.offset !== '10000',
    nextOffset: request.query.part === '2' || request.query.offset === '10000' ? null : 10000, attachmentCount: 0,
    selectedPartIndex: request.query.part === '2' ? 2 : 1,
    bodyRepresentations: [{partIndex: 1, mimeType: 'text/plain', readable: true}, {partIndex: 2, mimeType: 'text/html', readable: true}]
  } }));
  app.get('/dad/history', (_request, response) => response.type('html').send(`<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/assets/household/app.css"><link rel="stylesheet" href="/assets/household/personal-history.css"><body class="household-product"><main id="app"></main>
    <script src="/assets/household/personal-history.js"></script><script>
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const api = async (url, options={}) => {const r=await fetch(url,{...options,headers:{'content-type':'application/json'}}); const b=await r.json();if(!r.ok)throw Error(b.message);return b.data;};
    window.mountPersonalHistory({app:document.querySelector('#app'),api,esc});</script></html>`));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto(base + '/dad/history');
  await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 5);
  assert.match(await page.locator('.history-entry').first().textContent(), /Souvenir fictif 4/);
  assert.equal(await page.locator('.history-entry img').count(), 0);
  await page.locator('[name=kind]').selectOption('fact');
  await page.locator('[data-history-filters] button').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 3);
  // One fact kept from its own card, with the event date given there.
  const single = page.locator('.history-entry', { hasText: 'Information fictive' });
  assert.match(await single.textContent(), /Date de l’événement/);
  await single.locator('[name=eventDate]').fill('2025-03-07');
  await single.getByRole('button', { name: 'Garder comme souvenir' }).click();
  await page.waitForFunction(() => document.querySelector('[data-history-status]').textContent.includes('Souvenir gardé'));
  const kept = await MemoryNote.findOne({ text: /Information fictive/ }).lean();
  assert.equal(kept.kind, 'souvenir'); assert.equal(kept.eventDate, '2025-03-07'); assert.equal(kept.expiresAt, null);
  // The two 2018 facts kept together, after a confirmation that previews them.
  await page.locator('[name=year]').fill('2018');
  await page.locator('[name=souvenir]').selectOption('not-kept');
  await page.locator('[data-history-filters] button').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 2);
  let preview = '';
  page.once('dialog', dialog => { preview = dialog.message(); return dialog.accept(); });
  await page.locator('[data-history-select-all]').click();
  await page.locator('[data-history-keep-selected]').click();
  await page.waitForFunction(() => document.querySelector('[data-history-status]').textContent.includes('2 souvenir(s) gardé(s)'));
  assert.match(preview, /Garder 2 information\(s\)/); assert.match(preview, /Souvenir fictif 5/);
  assert.equal(await MemoryNote.countDocuments({ kind: 'souvenir' }), 3);
  assert.equal(await page.locator('.history-entry').count(), 0);
  await page.locator('[name=souvenir]').selectOption('kept');
  await page.locator('[name=state]').selectOption('');
  await page.locator('[data-history-filters] button').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-souvenir').length === 2);
  await page.locator('[name=year]').fill('');
  await page.locator('[name=souvenir]').selectOption('');
  await page.locator('[name=kind]').selectOption('');
  await page.locator('[name=state]').selectOption('pending');
  await page.locator('[data-history-filters] button').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 2);
  assert.equal(await page.locator('.history-entry', { hasText: 'Ancien suivi fictif' }).getByRole('button', { name: 'Garder comme souvenir' }).count(), 0);
  const card = page.locator('.history-entry', { hasText: 'Ancien suivi fictif' });
  await card.locator('[data-history-source] > summary').click();
  await card.locator('[data-source-next]').waitFor({ state: 'visible' });
  assert.equal(await card.locator('[data-source-body] img').count(), 0);
  await card.locator('[data-source-next]').click();
  await page.waitForFunction(() => document.querySelector('[data-source-body]').textContent.includes('Fin de la source'));
  await card.locator('[data-source-version]').selectOption('2');
  await page.waitForFunction(() => document.querySelector('[data-source-body]').textContent.includes('uniquement dans la version HTML'));
  assert.equal(await card.locator('[data-source-next]').isVisible(), false);
  assert.equal(await card.locator('[data-source-body] img').count(), 0);
  await card.locator('[name=reason]').fill('La source fictive confirme que ce suivi a été réalisé.');
  await card.getByRole('button', { name: 'Clore ce suivi' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 1);
  assert.equal((await Entry.findById(first.entry.id).lean()).reviewState, 'resolved');
  assert.equal(await mongoose.connection.db.collection('pipelinetasks').countDocuments({}), 0);
  await page.screenshot({ path: reportDir + '/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: reportDir + '/mobile.png', fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  fs.writeFileSync(reportDir + '/result.json', JSON.stringify({ passed: true, errors, external,
    checks: ['oldest-first', 'filters', 'source-pagination', 'mime-text-versions', 'inert-source-html', 'explicit-resolution', 'souvenir-single', 'souvenir-batch-confirmed', 'souvenir-filters', 'action-not-a-souvenir', 'no-personal-task-created', 'mobile-width'] }, null, 2));
  console.log('Historical review browser journey passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
