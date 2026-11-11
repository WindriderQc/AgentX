'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const req = createRequire(root + '/core/package.json');
const express = req('express'), mongoose = req('mongoose');
const { MongoMemoryServer } = req('mongodb-memory-server');
const { chromium } = require('playwright');
const { archive } = require('../fixtures/historySourceArchive');
const reportDir = process.env.PERSONAL_HISTORY_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(root + path.sep)) throw Error('Choose a private report directory outside Git');
fs.mkdirSync(reportDir, { recursive: true });
process.env.NODE_ENV = 'test'; process.env.MONGOMS_VERSION ||= '7.0.24';
const history = req('./src/services/personalHistoryService');
const Entry = req('./models/PersonalHistoryEntry');
const Suppression = req('./models/PersonalHistorySuppression');
const { registerSecretaryHistoryRoutes } = req('./surfaces/household/secretary-history');
let mongo, server, browser, fixture;
let holdDecision = false, releaseDecision, originalDecisionEntered, releaseNativeRead;
let holdNativeRead = false, nativeReadEntered;
let nativeOutage = false;
const errors = [], external = [];

(async () => {
  fixture = await archive({ body: 'Synthetic browser source 🦉 <img src=x onerror=alert(1)> '.repeat(400),
    subject: 'Synthetic <img src=x onerror=alert(1)> subject' });
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'history_source_review_browser_fixture' } });
  await mongoose.connect(mongo.getUri());
  await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection();
  const saved = await history.record({ kind: 'action', text: 'Synthetic historical source review', sourceDate: '2020-01-01T00:00:00Z', source: fixture.source });
  const app = express(); app.use(express.json());
  app.use((request, _response, next) => {
    if (holdDecision && request.method === 'POST' && request.path.endsWith('/decision')) {
      holdDecision = false; releaseDecision = next; originalDecisionEntered();
    } else next();
  });
  app.use('/assets/household', express.static(root + '/core/surfaces/household/public'));
  const router = express.Router();
  const nativeReadGate = new Promise(resolve => { releaseNativeRead = resolve; });
  const nativeEntered = new Promise(resolve => { nativeReadEntered = resolve; });
  const mail = { archived: async args => {
    if (holdNativeRead) { holdNativeRead = false; nativeReadEntered(); await nativeReadGate; }
    if (nativeOutage) throw Object.assign(Error('Synthetic native outage'), { code: 'SECRETARY_ARCHIVE_UNAVAILABLE' });
    return fixture.mail.archived(args);
  } };
  registerSecretaryHistoryRoutes({ router, sourceReviewDeps: { audience: 'owner', mail },
    envelope: (res, data) => res.json({ status: 'success', data }),
    fail: (res, code, message) => res.status(code).json({ status: 'error', message }) });
  app.use('/api/secretary', router);
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
  const preparations = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/source-review')) preparations.push(request.postDataJSON());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : (external.push(route.request().url()), route.abort()));
  await page.goto(base + '/dad/history');
  const card = page.locator(`[data-entry="${saved.entry.id}"]`);
  await card.locator('[data-history-source-review] > summary').click();
  await page.evaluate(() => {
    window.storageFixture = { get: Storage.prototype.getItem, set: Storage.prototype.setItem };
    Storage.prototype.setItem = function () { throw Error('Synthetic unavailable transport storage'); };
  });
  await card.locator('[data-source-review-start]').click();
  await page.waitForFunction(() => document.querySelector('[data-source-review-status]')?.textContent.includes('stockage de reprise'));
  assert.equal(preparations.length, 0);
  assert.equal((await Entry.findById(saved.entry.id).lean()).sourceReviews.length, 0);
  await page.evaluate(() => { Storage.prototype.setItem = window.storageFixture.set; });
  let losePreparationReply = true;
  await page.route('**/api/secretary/history/*/source-review', async route => {
    if (route.request().method() === 'POST' && losePreparationReply) {
      losePreparationReply = false; await route.fetch(); return route.abort('failed');
    }
    return route.continue();
  });
  await card.locator('[data-source-review-start]').click();
  await page.waitForFunction(() => document.querySelector('[data-source-review-status]')?.textContent.includes('même revue'));
  assert.equal((await Entry.findById(saved.entry.id).lean()).sourceReviews.length, 1);
  await page.evaluate(() => {
    Storage.prototype.getItem = function () { throw Error('Synthetic storage read failure'); };
    Storage.prototype.setItem = function () { throw Error('Synthetic storage write failure'); };
  });
  await card.locator('[data-source-review-start]').click();
  const ready = card.locator('[data-source-review-decision] button[value=reviewed_scope]');
  await ready.waitFor(); assert.equal(await ready.isDisabled(), true);
  const headers = card.locator('[data-source-review-headers]');
  assert.match(await headers.innerText(), /Synthetic <source@example.invalid>/);
  assert.match(await headers.innerText(), /Synthetic <img src=x onerror=alert\(1\)> subject/);
  assert.match(await headers.innerText(), /Date déclarée du message\s+Non renseigné/);
  assert.equal(await headers.locator('img').count(), 0);
  assert.equal(preparations.length, 2);
  assert.equal(new Set(preparations.map(input => input.requestId)).size, 1);
  assert.equal((await Entry.findById(saved.entry.id).lean()).sourceReviews.length, 1);
  await page.evaluate(() => { Storage.prototype.getItem = window.storageFixture.get; Storage.prototype.setItem = window.storageFixture.set; });
  await card.locator('[data-source-review-read]').first().click();
  await page.waitForFunction(() => document.querySelector('[data-source-review-body]')?.textContent.includes('Synthetic browser source'));
  assert.equal(await card.locator('[data-source-review-body] img').count(), 0);
  // Reconnect resumes the same server snapshot and its served-page coverage.
  const requestId = (await Entry.findById(saved.entry.id).lean()).sourceReviews[0].requestId;
  await page.reload();
  await card.locator('[data-history-source-review] > summary').click();
  await card.locator('[data-source-review-start]').click();
  await ready.waitFor();
  assert.equal((await Entry.findById(saved.entry.id).lean()).sourceReviews.length, 1);
  assert.equal((await Entry.findById(saved.entry.id).lean()).sourceReviews[0].requestId, requestId);
  for (let attempt = 0; attempt < 12 && await ready.isDisabled(); attempt++) {
    const row = await Entry.findById(saved.entry.id).lean(), review = row.sourceReviews[0];
    const progress = review.coverage.find(p => {
      const part = review.snapshot.sources[p.source].parts.find(part => part.partIndex === p.part);
      return !p.served || p.nextOffset < part.totalChars;
    });
    assert.ok(progress);
    await card.locator(`[data-source-review-read="${progress.source}:${progress.part}"]`).click();
    await page.waitForFunction(() => !document.querySelector('[data-source-review-start]').disabled);
  }
  assert.equal(await ready.isEnabled(), true);
  assert.match(await card.innerText(), /Pièces jointes non examinées/);
  const decisionBodies = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/decision')) decisionBodies.push(request.postDataJSON());
  });
  let loseDecisionReply = true, originalDecisionResponse;
  const originalEntered = new Promise(resolve => { originalDecisionEntered = resolve; });
  holdDecision = true;
  await page.route('**/source-review/*/decision', async route => {
    if (loseDecisionReply) {
      loseDecisionReply = false;
      // Keep the original real HTTP write pending while the browser loses its
      // response. A GET without a receipt is explicitly NOT its completion.
      originalDecisionResponse = fetch(route.request().url(), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: route.request().postData() }).then(response => response.json());
      await originalEntered; return route.abort('failed');
    }
    return route.continue();
  });
  await card.locator('[data-source-review-decision] textarea').fill('Textes lus; pièces jointes et liens restent à examiner.');
  await ready.click();
  await page.waitForFunction(() => document.querySelector('[data-source-review-status]')?.textContent.includes('même revue'));
  assert.equal((await Entry.findById(saved.entry.id).lean()).sourceReviews[0].decision, null);
  await card.locator('[data-source-review-start]').click();
  await card.locator('[data-source-review-pending]').waitFor();
  assert.equal(await card.locator('[data-source-review-decision] textarea').count(), 0);
  assert.equal(await card.locator('[data-source-review-new]').count(), 0);
  // Refresh retains only transport metadata. Until Core has received the first
  // request, losing RAM cannot justify reconstructing or replacing its reason.
  await page.reload();
  await card.locator('[data-history-source-review] > summary').click();
  await card.locator('[data-source-review-start]').click();
  await card.locator('[data-source-review-pending]').waitFor();
  assert.match(await card.locator('[data-source-review-pending]').innerText(), /contenu n’est pas encore retrouvable/);
  const transport = await page.evaluate(id => JSON.parse(localStorage.getItem(`history-source-review-decision:${id}`)), saved.entry.id);
  assert.deepEqual(Object.keys(transport).sort(), ['intentHash', 'requestId']);
  assert.equal(transport.requestId, requestId);
  assert.equal(decisionBodies.length, 1);
  await card.locator('[data-source-review-retry-decision]').click();
  await page.waitForFunction(() => document.querySelector('[data-source-review-content]')?.textContent.includes('aucun autre constat n’est envoyé'));
  assert.equal(decisionBodies.length, 1);
  assert.equal((await Entry.findById(saved.entry.id).lean()).sourceReviews[0].decisionIntent, null);
  // The original HTTP request now reserves its contents in Core, then pauses
  // during native rechecking. A new browser recovers those exact Core contents.
  holdNativeRead = true;
  releaseDecision();
  await nativeEntered;
  const reserved = (await Entry.findById(saved.entry.id).lean()).sourceReviews[0];
  assert.equal(reserved.decisionIntent.intentHash, transport.intentHash);
  assert.equal(reserved.decision, null);
  // Even a browser with no local transport metadata discovers the Core intent.
  nativeOutage = true;
  await page.evaluate(id => localStorage.removeItem(`history-source-review-decision:${id}`), saved.entry.id);
  await page.reload();
  await card.locator('[data-history-source-review] > summary').click();
  await card.locator('[data-source-review-start]').click();
  await card.locator('[data-source-review-pending]').waitFor();
  assert.match(await card.locator('[data-source-review-pending]').innerText(), /Textes revus sur ce périmètre/);
  assert.match(await card.locator('[data-source-review-pending]').innerText(), /Textes lus; pièces jointes et liens restent à examiner/);
  assert.equal(await card.locator('[data-source-review-decision] textarea').count(), 0);
  assert.equal(await card.locator('[data-source-review-new]').count(), 0);
  assert.match(await card.innerText(), /disponibilité actuelle des sources reste inconnue/);
  assert.equal((await Entry.findById(saved.entry.id).lean()).sourceReviews[0].decision, null);
  nativeOutage = false;
  await card.locator('[data-source-review-retry-decision]').click();
  await page.waitForFunction(() => document.querySelector('[data-source-review-status]')?.textContent.includes('enregistrée'));
  releaseNativeRead();
  const late = await originalDecisionResponse;
  assert.equal(late.data.replayed, true);
  assert.equal(decisionBodies.length, 2);
  assert.deepEqual(decisionBodies[1], { intentHash: transport.intentHash });
  const row = await Entry.findById(saved.entry.id).lean();
  assert.equal(row.sourceReviews[0].decision.decision, 'reviewed_scope');
  assert.equal(row.sourceReviews[0].decision.executionAllowed, false);
  assert.equal(row.reviewState, 'candidate'); assert.equal(row.assertionState, 'unknown');
  const receipt = card.locator('[data-source-review-receipt] dd');
  assert.equal(await receipt.nth(0).textContent(), 'Textes revus sur ce périmètre');
  assert.equal(await receipt.nth(1).textContent(), row.sourceReviews[0].decision.reason);
  const displayedDate = await page.evaluate(value => new Date(value).toLocaleString('fr-CA'), row.sourceReviews[0].decision.at.toISOString());
  assert.equal(await receipt.nth(2).textContent(), displayedDate);
  assert.equal(await page.evaluate(id => localStorage.getItem(`history-source-review-decision:${id}`), saved.entry.id), null);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: reportDir + '/mobile.png', fullPage: true });
  await card.locator('[data-source-review-new]').click();
  await card.locator('[data-source-review-decision] textarea').waitFor();
  assert.equal((await Entry.findById(saved.entry.id).lean()).sourceReviews.length, 2);
  assert.equal(await card.locator('[data-source-review-history] option').count(), 2);
  const current = await Entry.findById(saved.entry.id).lean();
  await history.review(saved.entry.id, { revision: current.revision, state: 'forgotten' });
  await card.locator('[data-source-review-start]').click();
  await card.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(id => localStorage.getItem(`history-source-review:${id}`), saved.entry.id), null);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  fs.writeFileSync(reportDir + '/result.json', JSON.stringify({ passed: true, errors, external, requestId,
    checks: ['real-native-reader', 'storage-failure-no-dispatch', 'lost-preparation-reply-same-identity', 'all-text-parts', 'inert-html', 'reconnect-same-identity', 'late-decision-same-intent', 'no-empty-get-assumption', 'metadata-only-browser-storage', 'missing-ram-no-reconstruction', 'core-intent-recovery', 'native-unknown-retains-pending', 'reference-only-retry', 'exact-receipt-choice-reason-date', 'erasure-clears-journal', 'explicit-scope-review', 'attachment-gaps', 'no-fact-confirmation', 'no-cleanup-grant', 'mobile-width'] }, null, 2));
  console.log('Historical source review browser journey passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  releaseDecision?.(); releaseNativeRead?.();
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect(); if (mongo) await mongo.stop(); if (fixture) await fixture.cleanup();
});
