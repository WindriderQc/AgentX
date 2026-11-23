'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID, webcrypto, createHash } = require('node:crypto');
const code = fs.readFileSync(require.resolve('../public/history-semantic-review'), 'utf8');
const BASE = '/api/secretary/history/semantic-reviews';
const hash = value => createHash('sha256').update(value).digest('hex');
const source = { system: 'gmail', messageId: 'a000000000000001', threadId: 'a000000000000002', sourceSha256: 'a'.repeat(64) };
const manifest = () => ({ requestId: '11111111-1111-4111-8111-111111111111', state: 'confirmed', input: {
  checks: [{ entryId: 'a'.repeat(24), requestId: '22222222-2222-4222-8222-222222222222', snapshotHash: 'b'.repeat(64), source }],
  before: '2026-01-01T00:00:00.000Z' } });
const KEY = `history-human-semantic-review:v1:${manifest().requestId}`;
const content = [Buffer.from('Synthetic original source bytes'), Buffer.from('{"analysis":"<img src=x onerror=alert(1)>","link":"https://external.invalid/never-fetch"}')];
const descriptors = content.map((bytes, i) => ({ kind: i ? 'analysis' : 'original', key: i ? 'selected-analysis' : 'original', sha256: hash(bytes), bytes: bytes.length, nextOffset: 0, served: false }));
const clone = value => JSON.parse(JSON.stringify(value));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function harness({ storage = new Map(), handler, failStorage = false, failRead = false, sourcePreview, savedReceipt } = {}) {
  const listeners = {}, requests = [], downloads = [];
  let badStorage = failStorage, latest = savedReceipt || null;
  const progress = [0, 0];
  const container = { innerHTML: '', isConnected: true, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const localStorage = { getItem: key => { if (failRead) throw Error('Read unavailable'); return storage.get(key) ?? null; },
    setItem: (key, value) => { if (badStorage) throw Error('Quota'); storage.set(key, value); } };
  function receipt(state, withPreview = false) {
    const journal = JSON.parse(storage.get(KEY));
    return { contract: 'agentx.history-human-semantic-review/v1', requestId: journal.requestId, state,
      inputSha256: 'c'.repeat(64), bindingSha256: 'd'.repeat(64), preparedAt: '2026-01-01T00:00:00.000Z',
      decidedAt: ['accepted', 'held'].includes(state) ? '2026-01-02T00:00:00.000Z' : null,
      coverage: { resources: 2, totalBytes: content.reduce((n, b) => n + b.length, 0), servedResources: progress.filter((n, i) => n === content[i].length).length,
        servedBytes: progress.reduce((n, m) => n + m, 0), complete: progress.every((n, i) => n === content[i].length) },
      authenticatedPerson: null, semanticAcceptance: false, approvalBound: false, executionAllowed: false, cleanupStatus: 'blocked', mailboxEffects: 0,
      nativeState: withPreview ? 'observed' : 'not_rechecked', replayed: false,
      ...(withPreview ? { preview: sourcePreview || { sources: [{ reference: source, resources: descriptors }], blockers: [] } } : {}) };
  }
  const api = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, method: options.method || 'GET', body });
    const row = requests.at(-1);
    if (options.method === 'POST') {
      const journal = JSON.parse(storage.get(KEY));
      assert.ok(journal.requestId, 'every write has an original journal first');
      assert.deepEqual(journal.input.checks, body.checks);
      assert.equal(journal.input.before, body.before);
      if (url.endsWith('/decide')) { assert.equal(journal.phase, 'deciding'); assert.equal(journal.decision, body.decision); }
      if (url.endsWith('/read')) assert.deepEqual(journal.pendingRead, { source: body.source, resource: body.resource, offset: body.offset });
    }
    const custom = handler ? await handler(row, { receipt, progress, setLatest: value => { latest = value; } }) : undefined;
    if (custom !== undefined) return clone(custom);
    if (options.method !== 'POST') return clone(latest || receipt('prepared'));
    if (url.endsWith('/read')) {
      const bytes = content[body.resource].subarray(body.offset, body.offset + 13);
      progress[body.resource] = Math.max(progress[body.resource], body.offset + bytes.length);
      latest = receipt('prepared');
      return { receipt: clone(latest), page: { source: body.source, resource: body.resource, offset: body.offset,
        nextOffset: body.offset + bytes.length === content[body.resource].length ? null : body.offset + bytes.length,
        contentBase64: bytes.toString('base64'), chunkSha256: hash(bytes) } };
    }
    if (url.endsWith('/decide')) { latest = receipt(body.decision === 'held_ambiguous' ? 'held' : 'accepted'); return clone(latest); }
    latest = receipt('prepared'); return receipt('prepared', true);
  };
  const document = { createElement: () => ({ click() { downloads.push({ href: this.href, name: this.download }); } }) };
  const view = manifest();
  const window = { crypto: { randomUUID, subtle: webcrypto.subtle } };
  vm.runInNewContext(code, { window, localStorage, TextDecoder, Uint8Array, Date, Map, Set, JSON, Error, Object,
    Number, Array, atob, encodeURIComponent, Blob, URL, document, setTimeout });
  const mounted = window.mountHistorySemanticReview({ container, api, esc, getManifest: () => view });
  const enabled = selector => new RegExp(`<button[^>]*${selector}(?![\\w-])[^>]*>`).test(container.innerHTML)
    && !new RegExp(`<button[^>]*${selector}(?![\\w-])[^>]*disabled`).test(container.innerHTML);
  return { container, requests, storage, progress, downloads, manifest: view,
    get journal() { return storage.has(KEY) ? JSON.parse(storage.get(KEY)) : null; },
    get latest() { return latest; }, receipt, enabled,
    setStorageFailure(value) { badStorage = value; }, refresh: mounted.refresh,
    async click(selector, dataset = {}) {
      listeners.click({ target: { disabled: false, dataset, matches: name => name === `[${selector}]` } });
      for (let n = 0; n < 300; n++) {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (!/<button[^>]*data-semantic-reconcile[^>]*disabled/.test(container.innerHTML)) return;
      }
      throw Error('UI action did not settle');
    },
    change(checked) { listeners.change({ target: { checked, matches: name => name === '[data-semantic-reviewed]' } }); }
  };
}
const writes = view => view.requests.filter(row => row.method === 'POST');
async function prepare(view) { await view.click('data-semantic-prepare'); }
async function readAll(view) { for (let i = 0; i < 2; i++) await view.click('data-semantic-read', { semanticRead: `0:${i}` }); }

test('complete exact bytes are verified, hostile analysis is inert, and human acceptance stays separate from cleanup', async () => {
  const view = harness(); await prepare(view);
  assert.equal(view.enabled('data-semantic-accept'), false);
  assert.match(view.container.innerHTML, /distincte de la revue du manifeste/);
  view.change(true); assert.equal(view.enabled('data-semantic-accept'), false);
  await readAll(view);
  assert.match(view.container.innerHTML, /&lt;img/); assert.doesNotMatch(view.container.innerHTML, /<img/);
  assert.equal(view.requests.some(row => row.url.startsWith('http')), false);
  await view.click('data-semantic-download', { semanticDownload: '0:0' });
  assert.equal(view.downloads.length, 1); assert.match(view.downloads[0].href, /^blob:/); assert.match(view.downloads[0].name, /\.eml$/);
  view.change(true); assert.equal(view.enabled('data-semantic-accept'), true);
  await view.click('data-semantic-accept');
  assert.equal(view.journal.phase, 'accepted'); assert.equal(view.journal.decision, 'accepted_selected_semantics');
  assert.equal(writes(view).filter(row => row.url.endsWith('/decide')).length, 1);
  assert.equal(view.latest.semanticAcceptance, false); assert.equal(view.latest.executionAllowed, false);
  assert.match(view.container.innerHTML, /jugement historique/);
});

test('ambiguous or unreadable sources can be held without inventing coverage or acceptance', async () => {
  const view = harness(); await prepare(view); await view.click('data-semantic-hold');
  assert.equal(view.journal.phase, 'held'); assert.equal(view.journal.decision, 'held_ambiguous');
  assert.equal(view.progress.reduce((a, b) => a + b, 0), 0);
  assert.match(view.container.innerHTML, /ambiguïté/);
});

test('lost prepare response reconciles original identity and requires explicit native reopen', async () => {
  const view = harness({ handler: row => { if (row.url.endsWith('/semantic-reviews') && row.method === 'POST') throw Error('Lost prepare ACK'); } });
  await prepare(view); const id = view.journal.requestId;
  assert.equal(view.journal.phase, 'prepared'); assert.equal(writes(view).length, 1);
  assert.equal(view.requests.at(-1).url, `${BASE}/${id}`); assert.equal(view.enabled('data-semantic-accept'), false);
  await view.click('data-semantic-reopen'); assert.match(view.container.innerHTML, /data-semantic-preview/);
  assert.equal(view.journal.requestId, id); assert.equal(writes(view).length, 2);
});

test('404 after uncertain preparation does not prove completion or permit a replacement identity', async () => {
  const view = harness({ handler: () => { throw Error('404 unknown'); } });
  await prepare(view); const id = view.journal.requestId;
  await prepare(view); await view.click('data-semantic-reconcile');
  assert.equal(writes(view).length, 1); assert.equal(view.journal.requestId, id); assert.equal(view.journal.phase, 'preparing');
  assert.equal(view.enabled('data-semantic-reopen'), false);
});

test('lost decision acknowledgement preserves the original intent across reload and never repeats it', async () => {
  const handler = (row, helpers) => { if (row.url.endsWith('/decide')) { helpers.setLatest(helpers.receipt('prepared')); throw Error('Pending decide ACK'); } };
  const first = harness({ handler }); await prepare(first); await first.click('data-semantic-hold');
  assert.equal(first.journal.phase, 'deciding'); const id = first.journal.requestId;
  const resumed = harness({ storage: first.storage, savedReceipt: first.latest }); await resumed.click('data-semantic-reconcile');
  await resumed.click('data-semantic-reopen'); await resumed.click('data-semantic-hold'); await prepare(resumed);
  assert.equal(resumed.journal.phase, 'deciding'); assert.equal(resumed.journal.requestId, id);
  assert.equal(resumed.journal.decision, 'held_ambiguous'); assert.equal(writes(resumed).length, 0);
});

test('reload does not treat previously served bytes as reading in this session', async () => {
  const first = harness(); await prepare(first); await readAll(first);
  const resumed = harness({ storage: first.storage, savedReceipt: first.latest }); await resumed.click('data-semantic-reconcile');
  assert.equal(resumed.enabled('data-semantic-accept'), false); await resumed.click('data-semantic-reopen'); resumed.change(true);
  assert.equal(resumed.enabled('data-semantic-accept'), false);
  assert.equal(resumed.requests.some(row => row.url.endsWith('/read')), false);
});

for (const fault of ['chunk', 'offset', 'resource', 'total', 'scope', 'binding']) test(`rejects ${fault} evidence without enabling validation`, async () => {
  const view = harness({ handler: (row, helpers) => {
    if (!row.url.endsWith('/read')) return;
    const page = { source: 0, resource: 0, offset: 0, nextOffset: null, contentBase64: content[0].toString('base64'), chunkSha256: hash(content[0]) };
    const receipt = helpers.receipt('prepared');
    if (fault === 'chunk') page.chunkSha256 = 'f'.repeat(64);
    if (fault === 'offset') page.offset = 1;
    if (fault === 'resource') page.resource = 1;
    if (fault === 'total') { page.contentBase64 = Buffer.from('short').toString('base64'); page.chunkSha256 = hash('short'); }
    if (fault === 'scope') receipt.requestId = randomUUID();
    if (fault === 'binding') receipt.bindingSha256 = 'e'.repeat(64);
    return { receipt, page };
  } });
  await prepare(view); await view.click('data-semantic-read', { semanticRead: '0:0' }); view.change(true);
  assert.equal(view.enabled('data-semantic-accept'), false); assert.equal(view.downloads.length, 0);
  assert.match(view.container.innerHTML, /réponse ne correspond/);
});

test('changed source membership or reserved native blockers cannot become acceptance', async () => {
  const wrong = harness({ sourcePreview: { sources: [{ reference: { ...source, messageId: 'b000000000000001' }, resources: descriptors }], blockers: [] } });
  await prepare(wrong); assert.equal(wrong.enabled('data-semantic-accept'), false); assert.doesNotMatch(wrong.container.innerHTML, /data-semantic-preview/);
  const held = harness({ sourcePreview: { sources: [{ reference: source, resources: descriptors }], blockers: ['thread_questions_unresolved'] } });
  await prepare(held); await readAll(held); held.change(true); assert.equal(held.enabled('data-semantic-accept'), false);
});

test('local storage failures or cross-tab journal replacement prevent writes', async () => {
  for (const options of [{ failStorage: true }, { failRead: true }]) { const view = harness(options); await prepare(view); assert.equal(writes(view).length, 0); }
  const view = harness(); await prepare(view); view.setStorageFailure(true); await view.click('data-semantic-hold');
  assert.equal(writes(view).length, 1);
  const crossed = harness(); await prepare(crossed); crossed.storage.set(KEY, '{}'); await crossed.click('data-semantic-hold');
  assert.equal(writes(crossed).length, 1);
});

test('terminal receipt must be acknowledged before explicit new review and retains its original identity', async () => {
  const view = harness(); await prepare(view); await view.click('data-semantic-hold'); const original = view.journal.requestId;
  await prepare(view); assert.equal(writes(view).length, 2);
  await view.click('data-semantic-acknowledge'); await prepare(view);
  assert.notEqual(view.journal.requestId, original);
  assert.equal(JSON.parse(view.storage.get(`${KEY}:${original}`)).requestId, original);
});

test('production loads semantics before manifest composition and keeps inspection purpose unchanged', () => {
  const index = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.ok(index.indexOf('/history-semantic-review.js') < index.indexOf('/history-manifest-confirmation.js'));
  const manifestCode = fs.readFileSync(require.resolve('../public/history-manifest-confirmation'), 'utf8');
  assert.match(manifestCode, /mountHistorySemanticReview/); assert.match(manifestCode, /confirmation: 'reviewed_selected_manifest'/);
});
