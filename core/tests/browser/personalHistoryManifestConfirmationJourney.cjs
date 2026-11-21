'use strict';
// Real browser and production UI modules, synthetic HTTP evidence only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../..');
const publicDir = path.join(root, 'core/surfaces/household/public');
const reportDir = process.env.PERSONAL_HISTORY_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(root + path.sep)) throw Error('Choose a private report directory outside Git');
fs.mkdirSync(reportDir, { recursive: true });
const KEY = 'history-manifest-confirmation:v1';
const BASE = '/api/secretary/history/manifest-confirmations';
const source = { system: 'gmail', messageId: 'a000000000000001', threadId: 'a000000000000002', sourceSha256: 'a'.repeat(64) };
const entries = [{ id: 'a'.repeat(24), text: 'Suivi synthétique <img src=x onerror=alert(1)>', source, kind: 'action', revision: 1, reviewState: 'retained', assertionState: 'reported' },
  { id: 'b'.repeat(24), text: 'Information synthétique sans reçu v3', source: { ...source, messageId: 'b000000000000001' }, kind: 'fact', revision: 1, reviewState: 'candidate', assertionState: 'reported' }];
const check = { requestId: '11111111-1111-4111-8111-111111111111', sourceIndex: 0, verification: 'review-restoration',
  preparedAt: '2026-01-01T00:00:00.000Z', entryCurrent: true, nativeState: 'current', snapshotHash: 'b'.repeat(64),
  snapshot: { contract: 'agentx.history-preservation/v3', reference: source, status: 'verified_scope' } };
const gaps = ['native_semantic_acceptance_unavailable', 'native_decision_reconciliation_unavailable',
  'native_preservation_acceptance_unavailable', 'native_manifest_approval_binding_unavailable'];
const preview = { manifest: { coverage: { counts: { messages: 1, entries: 1, observedNotes: 0, livePresent: 1, evidenceHeldMessages: 1 },
  blockers: [...gaps, 'selected_evidence_needs_review'], messages: [{ reference: source, blockers: ['retained_action_still_open'] }] },
  decisions: { snapshot: { findings: [{ snapshot: { coverage: { counts: { recordedFindings: 1, observedDecision: 0, needsReview: 1 } } } }] } },
  downstream: { snapshot: { members: [{ snapshot: { coverage: { counts: { currentLinks: 0 } } } }] } },
  mailbox: [{ snapshot: { mailbox: { status: 'present', current: { labelIds: ['INBOX'] } } } }],
  restoration: { snapshot: { members: [{ snapshot: { copies: [1, 2].map(() => ({ status: 'available', content: { reviewPacket: { counts: { files: 7, pages: 2, attachments: 0 } } } })) } }] } } },
  coreRestoration: { restoration: { collections: { history: { documents: 1, indexes: 2 }, souvenirs: { documents: 0, indexes: 2 } }, temporaryCopyRemoved: true } } };
let server, browser, originalId, originalInput, nativeState = 'prepared', loseConfirmation = true;
const writes = [], errors = [], external = [];
const envelope = data => ({ status: 'success', data });
const result = (id, includePreview = false) => ({ contract: 'agentx.history-manifest-confirmation/v1', requestId: id,
  state: nativeState, preparedAt: '2026-01-01T00:00:00.000Z', confirmedAt: nativeState === 'confirmed' ? '2026-01-02T00:00:00.000Z' : null,
  bindingSha256: 'c'.repeat(64), manifestSha256: 'd'.repeat(64), coreRestorationSha256: 'e'.repeat(64), inputSha256: 'f'.repeat(64),
  authenticatedPerson: null, recordedVia: 'private_lan_surface', reviewOnly: true, semanticAcceptance: false, approvalBound: false,
  executionAllowed: false, cleanupStatus: 'blocked', mailboxEffects: 0, nativeValidationGaps: gaps,
  nativeState: includePreview ? 'observed' : 'not_rechecked', replayed: true, ...(includePreview && { preview }) });
(async () => {
  server = http.createServer((req, res) => {
    const asset = req.url.match(/^\/assets\/([a-z-]+\.(?:js|css))$/);
    if (asset) { res.setHeader('content-type', asset[1].endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'); return res.end(fs.readFileSync(path.join(publicDir, asset[1]))); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/assets/personal-history.css"><body><main id="app"></main>
      <script src="/assets/history-manifest-confirmation.js"></script><script src="/assets/personal-history.js"></script><script>
      const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const api=async(url,options={})=>{const r=await fetch(url,{...options,headers:{'content-type':'application/json'}});const b=await r.json();if(!r.ok)throw Error(b.message);return b.data;};
      window.mountPersonalHistory({app:document.querySelector('#app'),api,esc});</script></html>`);
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
    const fulfill = data => route.fulfill({ json: envelope(data) });
    if (pathname === '/api/secretary/history') return fulfill({ entries, total: entries.length, nextOffset: null });
    if (/\/preservation$/.test(pathname)) return fulfill({ receipts: pathname.includes(entries[0].id) ? [check] : [] });
    if (/\/preservation\//.test(pathname)) return fulfill({ receipt: check });
    if (pathname.startsWith(BASE)) {
      if (request.method() === 'GET') { assert.equal(pathname, `${BASE}/${originalId}`); return fulfill(result(originalId)); }
      const body = request.postDataJSON();
      const journal = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
      assert.deepEqual(journal.input, { checks: body.checks, before: body.before });
      writes.push({ pathname, body });
      if (pathname === BASE) {
        assert.equal(journal.phase, 'preparing'); originalId = body.requestId; originalInput = { checks: body.checks, before: body.before };
        return fulfill(result(originalId, true));
      }
      assert.equal(journal.requestId, originalId);
      if (pathname.endsWith('/reopen')) { assert.equal(journal.phase, 'reopening'); return fulfill(result(originalId, true)); }
      assert.equal(pathname, `${BASE}/${originalId}/confirm`); assert.equal(journal.phase, 'confirming');
      assert.equal(body.bindingSha256, 'c'.repeat(64)); assert.equal(body.confirmation, 'reviewed_selected_manifest');
      if (loseConfirmation) return route.abort('failed');
      nativeState = 'confirmed'; return fulfill(result(originalId));
    }
    if (pathname.startsWith('/api/')) throw Error(`Unexpected API ${pathname}`);
    return route.continue();
  });
  await page.goto(base + '/dad/history');
  await page.locator('[data-history-pick]').first().waitFor();
  assert.equal(await page.locator('img').count(), 0);
  await page.locator('[data-history-pick]').first().check();
  assert.equal(await page.locator('[data-history-keep-selected]').isDisabled(), true, 'actions cannot become souvenirs');
  await page.locator('[data-manifest-before]').fill('2026-02-03');
  await page.locator('[data-manifest-prepare]').click();
  await page.locator('[data-manifest-preview]').waitFor();
  assert.equal(originalInput.before, '2026-02-03T00:00:00.000Z'); assert.equal(writes.length, 1);
  assert.equal(await page.locator('[data-manifest-confirm]').isDisabled(), true);
  assert.match(await page.locator('[data-history-manifest]').textContent(), /suivi conservé reste ouvert/);
  assert.equal(await page.locator('[data-manifest-before]').isDisabled(), true);
  await page.screenshot({ path: path.join(reportDir, 'prepared-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(reportDir, 'prepared-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.reload(); await page.locator('[data-manifest-reconcile]').waitFor();
  assert.equal(await page.locator('[data-manifest-preview]').count(), 0);
  assert.equal(await page.locator('[data-manifest-reopen]').isDisabled(), true);
  await page.locator('[data-manifest-reconcile]').click();
  await page.waitForFunction(() => !document.querySelector('[data-manifest-reopen]').disabled);
  assert.equal(await page.locator('[data-manifest-confirm]').count(), 0);
  await page.locator('[data-manifest-reopen]').click(); await page.locator('[data-manifest-preview]').waitFor();
  assert.equal(writes.length, 2);
  await page.locator('[data-manifest-reviewed]').check();
  assert.equal(await page.locator('[data-manifest-confirm]').isEnabled(), true);
  await page.locator('[data-manifest-confirm]').click();
  await page.waitForFunction(() => document.querySelector('[data-manifest-status]').textContent.includes('incertaine'));
  assert.equal(writes.length, 3);
  assert.equal(await page.locator('[data-manifest-confirm]').count(), 0);
  assert.equal(await page.locator('[data-manifest-reopen]').count(), 0);
  await page.reload(); await page.locator('[data-manifest-reconcile]').click();
  await page.waitForFunction(() => document.querySelector('[data-manifest-status]').textContent.includes('Confirmation en attente'));
  assert.equal(writes.length, 3); assert.equal(await page.locator('[data-manifest-prepare]').isDisabled(), true);
  nativeState = 'confirmed'; loseConfirmation = false;
  await page.locator('[data-manifest-reconcile]').click();
  await page.locator('[data-manifest-acknowledge]').waitFor();
  assert.match(await page.locator('[data-history-manifest]').textContent(), /historique/);
  assert.match(await page.locator('[data-history-manifest]').textContent(), /2026-01-02/);
  assert.equal(writes.length, 3);
  await page.locator('[data-manifest-acknowledge]').click();
  await page.locator('[data-history-pick]').nth(1).check();
  await page.locator('[data-manifest-before]').fill('2026-02-03'); await page.locator('[data-manifest-prepare]').click();
  await page.waitForFunction(() => document.querySelector('[data-manifest-status]').textContent.includes('n’a pas de reçu'));
  assert.equal(writes.length, 3, 'missing selected source never silently omitted');
  await page.locator('[data-history-pick]').nth(1).uncheck(); await page.locator('[data-history-pick]').first().check();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw Error('Unavailable storage'); }; });
  await page.locator('[data-manifest-prepare]').click();
  await page.waitForFunction(() => document.querySelector('[data-manifest-status]').textContent.includes('journal de reprise'));
  assert.equal(writes.length, 3, 'storage failure blocks write');
  await page.screenshot({ path: path.join(reportDir, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(reportDir, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify({ passed: true, writes: writes.length,
    checks: ['existing-action-selection', 'souvenir-fence', 'exact-v3', 'explicit-utc-cutoff', 'review-only-label', 'no-html-execution',
      'journal-before-every-write', 'reload-requires-explicit-reopen', 'replayed-reopen-preview', 'uncertain-confirm-prepared-read-fence',
      'same-request-only', 'historical-confirmation', 'missing-selected-source-refuses', 'storage-failure-refuses', 'mobile-width'] }, null, 2));
  console.log('Manifest confirmation browser journey passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
