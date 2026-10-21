'use strict';

// Real Core people routes and disposable Mongo; no mailbox, model or LAN host.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const req = createRequire(root + '/core/package.json');
const express = req('express'), mongoose = req('mongoose');
const { MongoMemoryServer } = req('mongodb-memory-server');
const { chromium } = require('playwright');
const reportDir = process.env.PEOPLE_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(root + path.sep)) throw Error('Choose a private report directory outside Git');
fs.mkdirSync(reportDir, { recursive: true });
process.env.NODE_ENV = 'test'; process.env.MONGOMS_VERSION ||= '7.0.24';
const people = req('./src/services/peopleRegistryService');
const models = ['PersonContact', 'PersonObservation', 'PersonMergeProposal', 'MemoryNote'].map(name => req(`./models/${name}`));
const { personal } = req('./src/services/memoryNoteService');
const { registerSecretaryPeopleRoutes } = req('./surfaces/household/secretary-people');
let mongo, server, browser;
const errors = [], external = [];
const sha = n => String(n).repeat(64);
const header = (n, name, mail) => ({ source: 'gmail-header', role: 'from', direction: 'received', name, email: mail,
  occurredAt: `2019-0${n}-01T12:00:00Z`, ref: { threadId: `thread0${n}`, messageId: `message0${n}`, sourceSha256: sha(n) } });
const page = `<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/assets/household/app.css"><link rel="stylesheet" href="/assets/household/personal-history.css">
  <body class="household-product"><main id="app"></main><script src="/assets/household/people.js"></script><script>
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (url, options = {}) => { const r = await fetch(url, { ...options, headers: { 'content-type': 'application/json' } });
    const b = await r.json(); if (!r.ok) throw Error(b.message); return b.data; };
  window.mountPeople({ app: document.querySelector('#app'), api, esc });</script></html>`;

(async () => {
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'people_browser_fixture' } });
  await mongoose.connect(mongo.getUri());
  for (const model of models) { await model.createCollection(); await model.createIndexes(); }
  await people.observe([header(1, 'Amie Fictive', 'amie@example.test'), header(2, 'Amie Fictive', 'amie.travail@example.test'),
    header(3, 'Voisin <img src=x onerror=alert(1)>', 'voisin@example.test')]);
  await personal().keepSouvenir({ text: 'Souvenir fictif au lac', people: ['Amie Fictive'], sourceRefs: [{ system: 'gmail', id: sha(1) }] });
  const app = express(); app.use(express.json());
  app.use('/assets/household', express.static(root + '/core/surfaces/household/public'));
  const router = express.Router();
  registerSecretaryPeopleRoutes({ router, envelope: (res, data) => res.json({ status: 'success', data }),
    fail: (res, code, message) => res.status(code).json({ status: 'error', message }) });
  app.use('/api/secretary', router);
  app.get('/dad/people', (_request, response) => response.type('html').send(page));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const tab = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  tab.on('pageerror', error => errors.push(error.message));
  await tab.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await tab.goto(base + '/dad/people');
  await tab.waitForFunction(() => document.querySelectorAll('[data-people-list] .history-entry').length === 3);
  assert.equal(await tab.locator('img').count(), 0);
  const proposal = tab.locator('[data-people-merges] [data-merge]');
  assert.equal(await proposal.count(), 1);
  assert.match(await proposal.textContent(), /Même nom complet — à vérifier/);
  // The owner merges after a confirmation, reads the merged person, then undoes it.
  let question = '';
  tab.once('dialog', dialog => { question = dialog.message(); return dialog.accept(); });
  await proposal.getByRole('button', { name: 'Fusionner' }).click();
  await tab.waitForFunction(() => document.querySelector('[data-people-merge-status]').textContent === 'Fusion faite.');
  assert.match(question, /Fusionner « Amie Fictive » et « Amie Fictive »/);
  await tab.waitForFunction(() => document.querySelectorAll('[data-people-list] .history-entry').length === 2);
  const amie = tab.locator('[data-people-list] .history-entry', { hasText: 'Amie Fictive' });
  await amie.locator('summary').click();
  await tab.waitForFunction(() => document.querySelector('[data-person-body]')?.textContent.includes('Souvenir fictif au lac'));
  assert.match(await amie.textContent(), /amie\.travail@example\.test/);
  await tab.locator('[data-people-done] > summary').click();
  await tab.locator('[data-people-accepted]').getByRole('button', { name: 'Défaire cette fusion' }).click();
  await tab.waitForFunction(() => document.querySelector('[data-people-merge-status]').textContent === 'Fusion défaite.');
  await tab.waitForFunction(() => document.querySelectorAll('[data-people-list] .history-entry').length === 3);
  await tab.locator('[data-people-merges]').getByRole('button', { name: 'Ce sont deux personnes' }).click();
  await tab.waitForFunction(() => document.querySelector('[data-people-merges]').textContent.includes('Aucune fusion à décider'));
  await tab.locator('[name=query]').fill('voisin');
  await tab.locator('[data-people-search] button').click();
  await tab.waitForFunction(() => document.querySelectorAll('[data-people-list] .history-entry').length === 1);
  await tab.screenshot({ path: reportDir + '/desktop.png', fullPage: true });
  await tab.setViewportSize({ width: 390, height: 1000 });
  assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await tab.screenshot({ path: reportDir + '/mobile.png', fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  fs.writeFileSync(reportDir + '/result.json', JSON.stringify({ passed: true, errors, external,
    checks: ['proposal-shown', 'inert-names', 'merge-confirmed', 'person-detail-souvenir', 'undo', 'dismiss', 'search', 'mobile-width'] }, null, 2));
  console.log('People browser journey passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
