'use strict';

// Production browser modules and HTTP services; disposable Mongo and synthetic
// native archive/provider fixtures only. No live instance, model or mailbox.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const req = createRequire(root + '/core/package.json');
const express = req('express'), mongoose = req('mongoose');
const { MongoMemoryServer } = req('mongodb-memory-server');
const { chromium } = require('playwright');
const { manifestArchive } = require('../fixtures/historyReviewManifestArchive');
const reportDir = process.env.PERSONAL_HISTORY_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(root + path.sep)) throw Error('Choose a private report directory outside Git');
fs.mkdirSync(reportDir, { recursive: true });
process.env.NODE_ENV = 'test'; process.env.MONGOMS_VERSION ||= '7.0.24';
const Entry = req('./models/PersonalHistoryEntry');
const MemoryNote = req('./models/MemoryNote');
const Suppression = req('./models/PersonalHistorySuppression');
const Confirmation = req('./models/PersonalHistoryManifestConfirmation');
const history = req('./src/services/personalHistoryService');
const preservation = req('./src/services/personalHistoryPreservation');
const privacy = req('./src/services/personalHistoryPrivacy');
const engine = req('./src/services/coreTemporaryRestoration');
const { registerSecretaryHistoryRoutes } = req('./surfaces/household/secretary-history');
const BASE = '/api/secretary/history/manifest-confirmations', KEY = 'history-manifest-confirmation:v1';
let mongo, server, browser, fixture, loseNextConfirmation = false;
const writes = [], errors = [], external = [];
let nativeCoreRestorations = 0;
const originalRestore = engine.restore;
engine.restore = (...args) => { nativeCoreRestorations++; return originalRestore(...args); };

(async () => {
  fixture = await manifestArchive();
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'history_manifest_confirmation_browser_fixture' } });
  await mongoose.connect(mongo.getUri());
  for (const model of [Entry, MemoryNote, Suppression, Confirmation]) { await model.createCollection(); await model.createIndexes(); }
  const saved = (await history.record({ kind: 'fact', text: 'Synthetic exact native manifest reading', sourceDate: '2020-01-01T00:00:00Z', source: fixture.source })).entry;
  await preservation.prepare(saved.id, { requestId: randomUUID(), revision: saved.revision, source: 0, verification: 'review-restoration' },
    { audience: 'owner', control: fixture.control });
  const before = await Entry.findById(saved.id).lean();
  const app = express(); app.use(express.json());
  app.use((request, response, next) => {
    if (request.method === 'POST' && request.path.startsWith(BASE)) {
      writes.push({ path: request.path, input: request.body });
      if (loseNextConfirmation && request.path.endsWith('/confirm')) {
        loseNextConfirmation = false;
        response.json = () => { response.socket.destroy(); return response; };
      }
    }
    next();
  });
  app.use('/assets/household', express.static(root + '/core/surfaces/household/public'));
  const router = express.Router();
  registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience: 'owner', control: fixture.findings },
    preservationDeps: { audience: 'owner', control: fixture.control }, mailboxScopeDeps: { audience: 'owner', control: fixture.mailbox },
    envelope: (res, data) => res.json({ ok: true, data }),
    fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
  app.use('/api/secretary', router);
  app.get('/dad/history', (_request, response) => response.type('html').send(`<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/assets/household/app.css"><link rel="stylesheet" href="/assets/household/personal-history.css"><body class="household-product"><main id="app"></main>
    <script src="/assets/household/history-manifest-confirmation.js"></script><script src="/assets/household/personal-history.js"></script><script>
    const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    window.confirmationClientSubmissions=0;
    const api=async(url,options={})=>{if(options.method==='POST'&&url.endsWith('/confirm'))window.confirmationClientSubmissions++;const r=await fetch(url,{...options,headers:{'content-type':'application/json'}});const b=await r.json();if(!r.ok)throw Error(b.message);return b.data;};
    window.mountPersonalHistory({app:document.querySelector('#app'),api,esc});</script></html>`));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : (external.push(route.request().url()), route.abort()));
  await page.goto(base + '/dad/history');
  await page.locator(`[data-history-pick="${saved.id}"]`).check();
  await page.locator('[data-manifest-before]').fill('2026-01-01');
  await page.locator('[data-manifest-prepare]').click();
  await page.locator('[data-manifest-preview]').waitFor();
  const original = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
  assert.equal(original.phase, 'prepared');
  assert.match(original.bindingSha256, /^[a-f0-9]{64}$/);
  assert.equal(original.input.checks.length, 1);
  assert.equal(writes.filter(row => row.path === BASE).length, 1);
  assert.match(await page.locator('[data-manifest-preview]').innerText(), /Restauration Core temporaire : 1 relevé\(s\), 0 souvenir\(s\)/);
  await page.screenshot({ path: path.join(reportDir, 'prepared-native-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(reportDir, 'prepared-native-mobile.png'), fullPage: true });
  await page.reload();
  assert.equal(await page.locator('[data-manifest-confirm]').count(), 0);
  await page.locator('[data-manifest-reconcile]').click();
  await page.locator('[data-manifest-reopen]:enabled').waitFor();
  await page.locator('[data-manifest-reopen]').click();
  await page.locator('[data-manifest-preview]').waitFor();
  const reopened = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
  assert.equal(reopened.requestId, original.requestId); assert.equal(reopened.bindingSha256, original.bindingSha256);
  assert.deepEqual(reopened.input, original.input);
  loseNextConfirmation = true;
  await page.locator('[data-manifest-reviewed]').check();
  await page.locator('[data-manifest-confirm]').click();
  await page.locator('[data-manifest-status]').filter({ hasText: 'Revue du manifeste exact confirmée' }).waitFor();
  const journal = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
  assert.equal(journal.phase, 'confirmed'); assert.equal(journal.requestId, original.requestId);
  const submissions = await page.evaluate(() => window.confirmationClientSubmissions);
  const confirmationRequests = writes.filter(row => row.path.endsWith('/confirm'));
  assert.equal(submissions, 1);
  assert.equal(nativeCoreRestorations, 3); // prepare, explicit reopen, confirmation.
  assert(confirmationRequests.length >= 1);
  // Chromium may transparently retransmit a reused HTTP connection after an
  // empty reply. Native identity reservation still prevents a second restore.
  for (const retry of confirmationRequests) assert.deepEqual(retry, confirmationRequests[0]);
  const receipt = (await (await page.request.get(base + BASE + '/' + original.requestId)).json()).data;
  assert.equal(receipt.state, 'confirmed'); assert.equal(receipt.preview, undefined);
  assert.equal(receipt.authenticatedPerson, null); assert.equal(receipt.approvalBound, false); assert.equal(receipt.executionAllowed, false);
  assert.deepEqual(await Entry.findById(saved.id).lean(), before);
  await privacy.suppress({ _id: saved.id });
  const historical = (await (await page.request.get(base + BASE + '/' + original.requestId)).json()).data;
  assert.equal(historical.state, 'confirmed'); assert.equal(historical.nativeState, 'not_rechecked');
  assert.equal(historical.preview, undefined);
  assert.deepEqual(await fs.promises.readdir(fixture.temporaryRoot), []);
  assert.deepEqual((await Entry.db.db.listCollections().toArray()).filter(row => row.name.startsWith('__agentx_core_restore_')), []);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const result = { passed: true, nativeHttpMongoArchive: true, lostConfirmationAckReconciled: true,
    originalRequestId: original.requestId, bindingSha256: original.bindingSha256, preparationWrites: 1,
    confirmationClientSubmissions: submissions, confirmationHttpRequests: confirmationRequests.length, nativeCoreRestorations,
    historicalAfterForgetting: true, canonicalEntryUnchangedByConfirmation: true, temporaryCopiesRemoved: true,
    mobileWidth: 390, errors, external };
  fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write('NATIVE_MANIFEST_CONFIRMATION_BROWSER_OK\n');
})().catch(error => { fs.writeFileSync(path.join(reportDir, 'failure.txt'), error.stack); process.stderr.write(error.stack + '\n'); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
    await mongoose.disconnect(); await mongo?.stop(); await fixture?.cleanup(); });
