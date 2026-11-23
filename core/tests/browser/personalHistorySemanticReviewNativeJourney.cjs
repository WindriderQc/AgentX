'use strict';

// Real production browser/HTTP/Core/Mongo/native archive paths. Corpus and
// machine identities are synthetic; no provider write, model or instance call.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const req = createRequire(root + '/core/package.json');
const express = req('express'), mongoose = req('mongoose');
const { MongoMemoryServer } = req('mongodb-memory-server');
const { chromium } = require('playwright');
const { semanticReviewArchive } = require('../fixtures/historySemanticReviewArchive');
const reportDir = process.env.PERSONAL_HISTORY_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(root + path.sep)) throw Error('Choose a private report directory outside Git');
fs.mkdirSync(reportDir, { recursive: true });
process.env.NODE_ENV = 'test'; process.env.MONGOMS_VERSION ||= '7.0.24';
const Entry = req('./models/PersonalHistoryEntry'), MemoryNote = req('./models/MemoryNote');
const Suppression = req('./models/PersonalHistorySuppression'), Confirmation = req('./models/PersonalHistoryManifestConfirmation');
const Review = req('./models/PersonalHistorySemanticReview');
const history = req('./src/services/personalHistoryService'), preservation = req('./src/services/personalHistoryPreservation');
const privacy = req('./src/services/personalHistoryPrivacy');
const { SECTIONS } = req('./src/services/personalHistoryFindingContract');
const { registerSecretaryHistoryRoutes } = req('./surfaces/household/secretary-history');
const BASE = '/api/secretary/history', MANIFEST_KEY = 'history-manifest-confirmation:v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let mongo, server, browser, fixture, loseDecision = false;
const writes = [], errors = [], external = [];

(async () => {
  fixture = await semanticReviewArchive();
  // Untrusted content is retained in the native page receipt and rendered only
  // as text by the actual production reader.
  for (const archive of Object.values(fixture.roots)) {
    const directory = path.join(archive, 'page-reviews');
    const name = fs.readdirSync(directory).find(file => file.endsWith('.json'));
    const file = path.join(directory, name), row = JSON.parse(fs.readFileSync(file));
    row.summary = 'Synthetic <img src=x onerror=alert(1)> https://external.invalid/never-fetch';
    fs.writeFileSync(file, JSON.stringify(row));
  }
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'history_human_semantic_browser_fixture' } });
  await mongoose.connect(mongo.getUri());
  for (const model of [Entry, MemoryNote, Suppression, Confirmation, Review]) { await model.createCollection(); await model.createIndexes(); }
  const entries = {};
  for (const finding of fixture.inventory.findings) {
    const kind = SECTIONS[finding.section];
    const entry = (await history.record({ kind, text: `Synthetic browser ${kind}`, sourceDate: null, source: { ...fixture.source, findingId: finding.findingId } })).entry;
    entries[kind] = entry.id;
    await history.review(entry.id, { revision: 0, state: kind === 'fact' ? 'retained' : 'resolved', reason: 'Synthetic resolved browser decision' });
  }
  const anchor = await Entry.findById(entries.fact).lean();
  const retained = (await preservation.prepare(entries.fact, { requestId: randomUUID(), revision: anchor.revision, source: 0, verification: 'review-restoration' }, { audience: 'owner', control: fixture.control })).receipt;
  const selected = { checks: [{ entryId: entries.fact, requestId: retained.requestId, snapshotHash: retained.snapshotHash,
    source: Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, fixture.source[key]])) }], before: '2026-01-01T00:00:00.000Z' };
  const app = express(); app.use(express.json());
  app.use((request, response, next) => {
    if (request.method === 'POST' && request.path.startsWith(BASE)) {
      writes.push({ path: request.path, body: request.body });
      if (loseDecision && request.path.endsWith('/decide')) {
        loseDecision = false; response.json = () => { response.socket.destroy(); return response; };
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
    <script src="/assets/household/history-semantic-review.js"></script><script src="/assets/household/history-manifest-confirmation.js"></script><script>
    const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    window.semanticClientSubmissions=0;
    const api=async(url,options={})=>{if(options.method==='POST'&&url.endsWith('/decide'))window.semanticClientSubmissions++;const r=await fetch(url,{...options,headers:{'content-type':'application/json'}});const b=await r.json();if(!r.ok)throw Error(b.message);return b.data;};
    window.mountHistoryManifestConfirmation({container:document.querySelector('#app'),api,esc,getSelection:()=>[]});</script></html>`));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value.data;
  };
  const manifestId = randomUUID();
  const prepared = await post(`${BASE}/manifest-confirmations`, { requestId: manifestId, ...selected });
  assert.equal(prepared.state, 'prepared');
  const confirmed = await post(`${BASE}/manifest-confirmations/${manifestId}/confirm`, { ...selected, bindingSha256: prepared.bindingSha256, confirmation: 'reviewed_selected_manifest' });
  assert.equal(confirmed.state, 'confirmed');
  const unchanged = await Entry.find({}).lean(), originalReceipt = await Confirmation.find({}).lean();
  const semanticKey = `history-human-semantic-review:v1:${manifestId}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
  page.setDefaultTimeout(120000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : (external.push(route.request().url()), route.abort()));
  await page.addInitScript(({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value)); }, {
    key: MANIFEST_KEY, value: { requestId: manifestId, input: selected, bindingSha256: prepared.bindingSha256, phase: 'confirmed' } });
  await page.goto(base + '/dad/history');
  await page.locator('[data-manifest-reconcile]').click();
  await page.locator('[data-semantic-prepare]:enabled').waitFor();
  await page.locator('[data-semantic-prepare]').click();
  await page.locator('[data-semantic-preview]').waitFor();
  const journal = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), semanticKey);
  const semanticId = journal.requestId;
  assert.equal(journal.phase, 'prepared'); assert.equal(journal.input.manifestRequestId, manifestId);
  assert.equal(await page.locator('[data-semantic-accept]').isDisabled(), true);
  const resources = await page.locator('[data-semantic-read]').evaluateAll(buttons => buttons.map(button => button.dataset.semanticRead));
  assert(resources.length >= 3, 'original, original attachments and selected native analysis must all be accessible');
  for (const id of resources) {
    await page.locator(`[data-semantic-read="${id}"]`).click();
    await page.locator(`[data-semantic-download="${id}"]:enabled`).waitFor();
  }
  assert.match(await page.locator('[data-semantic-analysis]').innerText(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('[data-semantic-analysis] img').count(), 0);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('[data-semantic-download="0:0"]').click();
  const download = await downloadEvent, downloadedFile = await download.path();
  const original = JSON.parse(fs.readFileSync(path.join(fixture.roots.primary, 'raw-receipts', fixture.source.messageId + '.json')));
  assert.equal(sha(fs.readFileSync(downloadedFile)), fixture.source.sourceSha256);
  assert.equal(fs.statSync(downloadedFile).size, original.bytes);
  await page.screenshot({ path: path.join(reportDir, 'semantic-reviewed-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(reportDir, 'semantic-reviewed-mobile.png'), fullPage: true });
  await page.locator('[data-semantic-reviewed]').check();
  assert.equal(await page.locator('[data-semantic-accept]').isEnabled(), true);
  loseDecision = true;
  await page.locator('[data-semantic-accept]').click();
  await page.locator('[data-semantic-status]').filter({ hasText: 'Validation sémantique humaine enregistrée' }).waitFor();
  assert.equal(await page.evaluate(() => window.semanticClientSubmissions), 1);
  const terminal = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), semanticKey);
  assert.equal(terminal.phase, 'accepted'); assert.equal(terminal.requestId, semanticId); assert.equal(terminal.decision, 'accepted_selected_semantics');
  const decisionWrites = writes.filter(row => row.path.endsWith('/decide'));
  assert(decisionWrites.length >= 1);
  for (const retry of decisionWrites) assert.deepEqual(retry, decisionWrites[0]);
  const historical = (await (await page.request.get(base + BASE + '/semantic-reviews/' + semanticId)).json()).data;
  assert.equal(historical.state, 'accepted'); assert.equal(historical.preview, undefined); assert.equal(historical.semanticAcceptance, false);
  assert.equal(historical.approvalBound, false); assert.equal(historical.executionAllowed, false); assert.equal(historical.authenticatedPerson, null);
  await page.reload(); await page.locator('[data-manifest-reconcile]').click();
  await page.locator('[data-semantic-reconcile]').click();
  await page.locator('[data-semantic-status]').filter({ hasText: 'Validation sémantique humaine enregistrée' }).waitFor();
  assert.equal(await page.evaluate(() => window.semanticClientSubmissions), 0);
  assert.equal((await page.evaluate(key => JSON.parse(localStorage.getItem(key)), semanticKey)).requestId, semanticId);
  assert.deepEqual(await Entry.find({}).lean(), unchanged); assert.deepEqual(await Confirmation.find({}).lean(), originalReceipt);
  await privacy.suppress({ _id: entries.fact });
  const opaque = (await (await page.request.get(base + BASE + '/semantic-reviews/' + semanticId)).json()).data;
  assert.equal(opaque.state, 'accepted'); assert.equal(opaque.preview, undefined); assert.equal(opaque.bindingSha256, journal.bindingSha256);
  assert.deepEqual(await fs.promises.readdir(fixture.temporaryRoot), []);
  assert.deepEqual((await Entry.db.db.listCollections().toArray()).filter(row => row.name.startsWith('__agentx_core_restore_')), []);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const result = { passed: true, nativeHttpMongoArchive: true, resources: resources.length, exactOriginalDownloadVerified: true,
    hostileAnalysisInert: true, originalManifestRequestId: manifestId, semanticRequestId: semanticId, bindingSha256: journal.bindingSha256,
    decisionClientSubmissions: 1, decisionHttpRequests: decisionWrites.length, lostDecisionAckReconciled: true,
    reloadNoSubmission: true, historicalAfterForgetting: true, canonicalRecordsUnchangedByReview: true,
    temporaryCopiesRemoved: true, mobileWidth: 390, errors, external };
  fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write('NATIVE_HUMAN_SEMANTIC_BROWSER_OK\n');
})().catch(error => { fs.writeFileSync(path.join(reportDir, 'failure.txt'), error.stack); process.stderr.write(error.stack + '\n'); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
    await mongoose.disconnect(); await mongo?.stop(); await fixture?.cleanup(); });
