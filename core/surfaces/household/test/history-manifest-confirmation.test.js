'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const code = fs.readFileSync(require.resolve('../public/history-manifest-confirmation'), 'utf8');
const KEY = 'history-manifest-confirmation:v1';
const BASE = '/api/secretary/history/manifest-confirmations';
const hash = letter => letter.repeat(64);
const source = { system: 'gmail', messageId: 'a000000000000001', threadId: 'a000000000000002', sourceSha256: hash('a') };
const checkId = '11111111-1111-4111-8111-111111111111';
const entry = { id: 'a'.repeat(24), text: 'Suivi fictif <img src=x onerror=alert(1)>', kind: 'action', source };
const receipt = () => ({ requestId: checkId, sourceIndex: 0, preparedAt: '2026-01-01T00:00:00.000Z',
  verification: 'review-restoration', entryCurrent: true, nativeState: 'current', snapshotHash: hash('b'),
  snapshot: { contract: 'agentx.history-preservation/v3', reference: source, status: 'verified_scope' } });
const gaps = ['native_semantic_acceptance_unavailable', 'native_decision_reconciliation_unavailable',
  'native_preservation_acceptance_unavailable', 'native_manifest_approval_binding_unavailable'];
const response = (requestId, state = 'prepared', extra = {}) => ({ contract: 'agentx.history-manifest-confirmation/v1',
  requestId, state, bindingSha256: hash('c'), manifestSha256: hash('d'), coreRestorationSha256: hash('e'),
  inputSha256: hash('f'), preparedAt: '2026-01-01T00:00:00.000Z', confirmedAt: null,
  authenticatedPerson: null, recordedVia: 'private_lan_surface', reviewOnly: true, semanticAcceptance: false,
  approvalBound: false, executionAllowed: false, cleanupStatus: 'blocked', mailboxEffects: 0,
  nativeValidationGaps: gaps, nativeState: 'not_rechecked', replayed: true, ...extra });
const preview = () => ({ manifest: { coverage: { counts: { messages: 1, entries: 1, observedNotes: 0, livePresent: 1, evidenceHeldMessages: 1 },
  messages: [{ reference: source, blockers: ['live_message_is_draft'] }], blockers: gaps },
  restoration: { snapshot: { members: [{ snapshot: { copies: [{ status: 'available', content: { reviewPacket: { counts: { files: 7, pages: 1, attachments: 0 } } } }] } }] } } },
  coreRestoration: { restoration: { collections: { history: { documents: 1, indexes: 2 }, souvenirs: { documents: 0, indexes: 2 } }, temporaryCopyRemoved: true } } });
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve)); };

function harness({ storage = new Map(), entries = [clone(entry)], handler, failStorage = false, failRead = false } = {}) {
  const listeners = {}, requests = [];
  let failed = failStorage;
  const container = { innerHTML: '', isConnected: true, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const localStorage = { getItem: key => { if (failRead) throw Error('Unavailable'); return storage.get(key) ?? null; },
    setItem: (key, value) => { if (failed) throw Error('Quota'); storage.set(key, value); } };
  const api = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, method: options.method || 'GET', body });
    if (options.method === 'POST') {
      const saved = JSON.parse(storage.get(KEY));
      assert.ok(saved.requestId, 'journal must exist before writes');
      assert.deepEqual(saved.input.checks, body.checks);
      assert.equal(saved.input.before, body.before);
      if (url.endsWith('/confirm')) { assert.equal(saved.phase, 'confirming'); assert.equal(saved.bindingSha256, body.bindingSha256); }
      else if (url.endsWith('/reopen')) assert.equal(saved.phase, 'reopening');
      else { assert.equal(saved.phase, 'preparing'); assert.equal(saved.requestId, body.requestId); }
    }
    const custom = handler ? await handler(url, options, body, requests) : undefined;
    if (custom !== undefined) return clone(custom);
    if (/\/preservation$/.test(url)) return { receipts: [receipt()] };
    if (/\/preservation\//.test(url)) return { receipt: receipt() };
    const requestId = body?.requestId || JSON.parse(storage.get(KEY)).requestId;
    if (url.endsWith('/confirm')) return response(requestId, 'confirmed', { confirmedAt: '2026-01-02T00:00:00.000Z' });
    if (options.method === 'POST') return response(requestId, 'prepared', { nativeState: 'observed', replayed: url.endsWith('/reopen'), preview: preview() });
    return response(requestId);
  };
  const window = { crypto: { randomUUID } };
  vm.runInNewContext(code, { window, localStorage, Date, Map, Set, JSON, Error, Object, Number, Array, encodeURIComponent });
  const mounted = window.mountHistoryManifestConfirmation({ container, api, esc, getSelection: () => entries });
  const event = (selector, extra = {}) => ({ target: { matches: name => selector === name, ...extra } });
  return { storage, requests, container, entries,
    get journal() { return storage.has(KEY) ? JSON.parse(storage.get(KEY)) : null; },
    enabled: selector => new RegExp(`<button[^>]*${selector}(?![\\w-])[^>]*>`).test(container.innerHTML)
      && !new RegExp(`<button[^>]*${selector}(?![\\w-])[^>]*disabled`).test(container.innerHTML),
    async click(selector) { listeners.click(event(`[${selector}]`)); await flush(); },
    change(selector, extra) { listeners.change(event(`[${selector}]`, extra)); },
    setStorageFailure(value) { failed = value; }, refresh: mounted.refresh };
}
async function prepare(view) { view.change('data-manifest-before', { value: '2026-02-03' }); await view.click('data-manifest-prepare'); }
const writes = view => view.requests.filter(row => row.method === 'POST');

test('selected action sources use exact retained v3 receipts, a frozen UTC cutoff and an explicit review-only confirmation', async () => {
  const view = harness();
  assert.match(view.container.innerHTML, /sans personne authentifiée/);
  assert.match(view.container.innerHTML, /&lt;img/); assert.doesNotMatch(view.container.innerHTML, /<img/);
  await prepare(view);
  assert.equal(view.journal.input.before, '2026-02-03T00:00:00.000Z');
  assert.equal(writes(view).length, 1); assert.equal(view.journal.phase, 'prepared');
  assert.match(view.container.innerHTML, /Restauration Core temporaire : 1 relevé/);
  assert.match(view.container.innerHTML, /est un brouillon/);
  assert.equal(view.enabled('data-manifest-confirm'), false);
  const original = clone(view.journal);
  view.entries.splice(0); view.change('data-manifest-before', { value: '2030-01-01' }); view.refresh();
  view.change('data-manifest-reviewed', { checked: true });
  assert.equal(view.enabled('data-manifest-confirm'), true);
  await view.click('data-manifest-confirm');
  assert.equal(view.journal.phase, 'confirmed'); assert.deepEqual(view.journal.input, original.input);
  assert.equal(view.journal.requestId, original.requestId); assert.equal(writes(view)[1].body.confirmation, 'reviewed_selected_manifest');
  assert.equal(writes(view)[1].body.bindingSha256, hash('c'));
  assert.match(view.container.innerHTML, /historique/); assert.match(view.container.innerHTML, /2026-01-02/);
});

test('every selected entry and related source must match; deduplication never hides an unmatched selected entry', async () => {
  const duplicate = { ...clone(entry), id: 'b'.repeat(24) };
  const view = harness({ entries: [clone(entry), duplicate] });
  await prepare(view);
  assert.equal(view.journal.input.checks.length, 1);
  assert.equal(view.requests.filter(row => /\/preservation\//.test(row.url)).length, 2);
  const missing = harness({ entries: [clone(entry), duplicate], handler: url => url.includes(duplicate.id) ? { receipts: [] } : undefined });
  await prepare(missing); assert.equal(writes(missing).length, 0); assert.equal(missing.journal, null);
  assert.match(missing.container.innerHTML, /n’a pas de reçu/);
  const related = harness({ entries: [{ ...clone(entry), relatedSources: [{ ...source, messageId: 'b000000000000001' }] }] });
  await prepare(related); assert.equal(writes(related).length, 0); assert.match(related.container.innerHTML, /source 2/);
});

for (const [label, update] of [
  ['stale native state', value => { value.nativeState = 'stale'; }],
  ['unverified scope', value => { value.snapshot.status = 'blocked'; }],
  ['old contract', value => { value.snapshot.contract = 'agentx.history-preservation/v2'; }],
  ['changed reference', value => { value.snapshot.reference.sourceSha256 = hash('f'); }],
  ['noncurrent entry', value => { value.entryCurrent = false; }]
]) test(`preparation refuses ${label} without a manifest write`, async () => {
  const value = clone(receipt()); update(value);
  const view = harness({ handler: url => /\/preservation\//.test(url) ? { receipt: value } : undefined });
  await prepare(view); assert.equal(writes(view).length, 0);
});

test('latest current v3 is chosen instead of a newer v2; more than 20 exact messages refuse', async () => {
  const view = harness({ handler: url => /\/preservation$/.test(url) ? { receipts: [receipt(),
    { ...receipt(), verification: 'restoration', requestId: randomUUID(), preparedAt: '2030-01-01T00:00:00.000Z' }] } : undefined });
  await prepare(view); assert.equal(view.journal.input.checks[0].requestId, checkId);
  const entries = Array.from({ length: 21 }, (_, i) => ({ ...clone(entry), source: { ...source, messageId: i.toString(16).padStart(16, '0') } }));
  const many = harness({ entries, handler: url => /\/preservation\//.test(url) ? { receipt: { ...receipt(), snapshot: {
    ...receipt().snapshot, reference: entries.filter((_entry, i) => i === Math.floor((many.requests.length - 1) / 2))[0].source } } } : undefined });
  await prepare(many); assert.equal(writes(many).length, 0); assert.match(many.container.innerHTML, /dépasse 20/);
});

test('local journal write/read failures prevent every manifest write', async () => {
  const view = harness({ failStorage: true }); await prepare(view);
  assert.equal(writes(view).length, 0); assert.match(view.container.innerHTML, /journal de reprise/);
  const unreadable = harness({ failRead: true }); await prepare(unreadable); assert.equal(unreadable.requests.length, 0);
  const pending = harness(); await prepare(pending); pending.setStorageFailure(true);
  pending.change('data-manifest-reviewed', { checked: true }); await pending.click('data-manifest-confirm');
  assert.equal(writes(pending).length, 1);
});

test('lost preparation response reads only the original identity and requires an explicit reopen', async () => {
  const view = harness({ handler: (url, options) => { if (url === BASE && options.method === 'POST') throw Error('Lost ACK'); } });
  await prepare(view); const original = view.journal.requestId;
  assert.equal(writes(view).length, 1); assert.equal(view.journal.phase, 'prepared');
  assert.equal(view.enabled('data-manifest-confirm'), false);
  assert.equal(view.requests.at(-1).url, `${BASE}/${original}`);
  await view.click('data-manifest-reopen');
  assert.match(view.container.innerHTML, /data-manifest-preview/); // replayed=true still carries freshly rechecked preview.
  assert.equal(view.journal.requestId, original); assert.equal(writes(view).length, 2);
});

test('404 after a lost write stays unknown and cannot launch a new identity', async () => {
  const view = harness({ handler: (url, options) => { if (url.startsWith(BASE)) throw Error(options.method === 'POST' ? 'Lost ACK' : '404'); } });
  await prepare(view); const original = view.journal.requestId;
  assert.equal(view.journal.phase, 'preparing'); assert.match(view.container.innerHTML, /404/);
  await view.click('data-manifest-prepare'); await view.click('data-manifest-reconcile');
  assert.equal(writes(view).length, 1); assert.equal(view.journal.requestId, original);
  assert.equal(view.enabled('data-manifest-reopen'), false);
});

test('reload prepared state needs GET and explicit reopen; GET alone never enables confirmation', async () => {
  const first = harness(); await prepare(first);
  const view = harness({ storage: first.storage });
  assert.equal(view.requests.length, 0); assert.equal(view.enabled('data-manifest-reopen'), false);
  await view.click('data-manifest-reconcile');
  assert.equal(view.enabled('data-manifest-reopen'), true); assert.equal(view.enabled('data-manifest-confirm'), false);
  await view.click('data-manifest-reopen'); view.change('data-manifest-reviewed', { checked: true });
  assert.equal(view.enabled('data-manifest-confirm'), true);
});

test('uncertain confirmation stays fenced even when GET returns prepared, including across reload', async () => {
  const handler = (url, options) => { if (url.endsWith('/confirm') && options.method === 'POST') throw Error('Delayed write'); };
  const first = harness({ handler }); await prepare(first); first.change('data-manifest-reviewed', { checked: true });
  await first.click('data-manifest-confirm');
  assert.equal(first.journal.phase, 'confirming'); assert.equal(first.enabled('data-manifest-reopen'), false);
  const view = harness({ storage: first.storage, handler }); await view.click('data-manifest-reconcile');
  assert.equal(view.journal.phase, 'confirming'); await view.click('data-manifest-prepare'); await view.click('data-manifest-confirm');
  assert.equal(writes(view).length, 0); assert.equal(view.enabled('data-manifest-acknowledge'), false);
});

test('changed binding on reopen does not replace the original binding or enable confirmation', async () => {
  const first = harness(); await prepare(first);
  const view = harness({ storage: first.storage, handler: (url, options) => url.endsWith('/reopen') && options.method === 'POST'
    ? response(first.journal.requestId, 'prepared', { bindingSha256: hash('a'), preview: preview(), nativeState: 'observed' }) : undefined });
  await view.click('data-manifest-reconcile'); await view.click('data-manifest-reopen');
  assert.equal(view.journal.bindingSha256, hash('c')); assert.equal(view.enabled('data-manifest-confirm'), false);
});

test('a known blocked receipt requires acknowledgment before explicit fresh preparation; old identity stays archived', async () => {
  const view = harness({ handler: (url, options, body) => url === BASE && options.method === 'POST'
    ? response(body.requestId, 'blocked', { blockedCode: 'HISTORY_MANIFEST_CONFIRMATION_CHANGED' }) : undefined });
  await prepare(view); const original = view.journal.requestId;
  await view.click('data-manifest-prepare'); assert.equal(writes(view).length, 1);
  await view.click('data-manifest-acknowledge'); await view.click('data-manifest-prepare');
  assert.equal(writes(view).length, 2); assert.notEqual(view.journal.requestId, original);
  assert.equal(JSON.parse(view.storage.get(`${KEY}:${original}`)).requestId, original);
});

test('production loads the confirmation module before history, and souvenir eligibility stays separate', () => {
  const index = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.ok(index.indexOf('/history-manifest-confirmation.js') < index.indexOf('/personal-history.js'));
  const history = fs.readFileSync(require.resolve('../public/personal-history.js'), 'utf8');
  assert.match(history, /rows\.filter\(row => selected\.has\(row\.id\) && canKeep\(row\)\)/);
  assert.match(history, /canKeep = entry => entry\.kind !== 'action' && !entry\.souvenirNoteId/);
});
