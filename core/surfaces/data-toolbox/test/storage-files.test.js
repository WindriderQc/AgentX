'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const toolbox = require('../index');

const publicRoot = path.resolve(__dirname, '..', 'public');
const HOSTILE = '<img src=x onerror="alert(1)">.txt';
const HOSTILE_ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;.txt';

// Shapes of Data's /api/v1/storage answers; names, paths and values are synthetic.
const agentsBody = (overrides = {}) => ({
  scanners: [{ scannerId: 'nas-storage', hostname: 'nas', platform: 'linux', agentVersion: 'storage-1.4.1', sources: ['photos', 'archive'], lastSeen: '2026-10-08T22:00:00.000Z', active: true }],
  active: 1,
  sources: { photos: { canonicalRoot: '/mnt/photos', executionCapable: false }, archive: { canonicalRoot: '/mnt/archive', executionCapable: false }, cold: { canonicalRoot: '/mnt/cold', executionCapable: false } },
  ...overrides
});
const scanDoc = (id, overrides = {}) => ({
  _id: id, type: 'external-storage-agent', status: 'complete',
  requested_at: '2026-10-08T07:00:00.905Z', started_at: '2026-10-08T07:01:22.437Z', finished_at: '2026-10-08T07:03:09.280Z',
  counts: { files_processed: 2210, inserted: 1, updated: 2209, files_seen: 2210, hashed: 12, hash_bytes: 1814709507, errors: 0, skipped: 1, stale_removed: 3, directories: 240, candidate_groups: 18 },
  config: { external: true, source: 'archive', roots: ['/mnt/archive'], execution_capable: false, hash_mode: 'candidates', hash_max_files: 5000, hash_max_bytes: 53687091200 },
  claimed_by: 'nas-storage', last_heartbeat_at: '2026-10-08T07:01:22.437Z', last_batch_at: '2026-10-08T07:03:07.574Z', live: false, duration: 107, ...overrides
});
const scansBody = (scans) => ({ scans, pagination: { total: scans.length, page: 1, limit: 12, pages: 1 } });
// What GET /status/:scan_id keeps of a scan.
const statusBody = (scan) => ({ _id: scan._id, status: scan.status, live: scan.status === 'running', counts: scan.counts, config: scan.config, started_at: scan.started_at, finished_at: scan.finished_at, last_error: scan.last_error });
const queuedAnswer = (overrides = {}) => ({ scan_id: 'aaaaaaaaaaaaaaaaaaaaaa01', source: 'photos', root: '/mnt/photos', hash_mode: 'candidates', coalesced: false, ...overrides });
const fileDoc = (overrides = {}) => ({
  _id: 'f1', path: '/mnt/photos/2024/holiday.jpg', category: 'media', dirname: '/mnt/photos/2024', ext: 'jpg', filename: 'holiday.jpg',
  mtime: 1791439979, size: 150271, sha256: 'ab'.repeat(32), sizeFormatted: '146.75 KB', mtimeFormatted: '2026-10-08T06:12:59.000Z', ...overrides
});
const filesBody = (files, pagination = {}) => ({ files, pagination: { total: files.length, page: 1, limit: 50, pages: 1, ...pagination } });
const statsBody = (extensions = 3) => ({
  root: null, total: { _id: null, count: 2718, totalSize: 25224388748, avgSize: 9279472, hashedCount: 2232, hashedBytes: 4651421947 },
  byExtension: Array.from({ length: extensions }, (_, index) => ({ extension: index ? `e${index}` : 'jpg', count: 10, size: 1000, sizeFormatted: '1000 B' })),
  byCategory: [], sizeCategories: {}
});
const treeRow = (folder, fileCount, totalSize) => ({ path: folder, fileCount, totalSize, totalSizeFormatted: 'n/a', largestFile: `${folder}/largest.bin` });
const duplicateGroup = (index, overrides = {}) => ({
  sha256: `${String(index).padStart(2, '0')}${'c'.repeat(62)}`, size: 5000000 - index, sizeFormatted: '4.77 MB', count: 2, wastedSpace: 5000000 - index, wastedSpaceFormatted: '4.77 MB',
  locations: [
    { path: `/mnt/archive/a/copy-${index}.iso`, dirname: '/mnt/archive/a', filename: `copy-${index}.iso`, mtime: 1732825496 },
    { path: `/mnt/archive/b/copy-${index}.iso`, dirname: '/mnt/archive/b', filename: `copy-${index}.iso`, mtime: 1754528963 }
  ], ...overrides
});
const duplicatesBody = (duplicates, overrides = {}) => ({
  root: null, method: 'sha256', verified: true,
  coverage: { files: 2718, bytes: 25224388748, hashedFiles: 2232, hashedBytes: 4651421947, fileRatio: 0.8213, byteRatio: 0.1844 },
  duplicates, summary: { totalDuplicateGroups: duplicates.length, totalWastedSpace: 1, totalWastedSpaceFormatted: '1 B' }, ...overrides
});
const summaryBody = () => ({ totalFiles: 2718, duplicates: { evidence: 'sha256-current-metadata', completeness: 'lower-bound', groups: 481, potentialSavings: 2002143275 } });
const cleanupBody = () => ({ root: null, recommendations: [
  { type: 'large_files_review', priority: 'review', message: 'Sampled 2 files over 100MB for retention review; their size is not reclaimable-space evidence', reviewBytes: 3020855098, potentialSavings: null,
    files: [{ path: '/mnt/archive/vm/disk.vdi', size: 2020855098, sizeFormatted: '1.88 GB' }, { path: `/mnt/archive/${HOSTILE}`, size: 1000000000, sizeFormatted: '953.67 MB' }] },
  { type: 'old_files_review', priority: 'review', message: 'Sampled 1 files older than 2 years; age alone is not a deletion reason', files: [{ path: '/mnt/archive/old/readme.txt', age: '17114 days', size: '19.11 KB' }] },
  { type: 'verified_duplicates', priority: 'high', message: 'Found 481 current SHA256-verified duplicate groups', potentialSavings: 2002143275, evidence: 'sha256-current-metadata' },
  { type: 'zero_byte_files', priority: 'review', message: 'Sampled 0 zero-byte files', potentialSavings: 0, files: [] },
  { type: 'root_clutter', priority: 'review', message: 'Root clutter requires a scoped root query', potentialSavings: null, files: [] }
] });

// A page whose fetch is answered by `respond(request)`: an Error is a refusal.
function page(respond, hash = '#storage') {
  const elements = {};
  const element = (selector) => (elements[selector] ||= { innerHTML: '', textContent: '', value: '', elements: {} });
  const listeners = {};
  const requests = [];
  const timers = [];
  const cleared = [];
  const document = {
    hidden: false, querySelector: element, querySelectorAll() { return []; },
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); }
  };
  const context = {
    document, location: { hash }, console, URLSearchParams,
    // Every outcome is reported inline: a dialog would fail the test.
    window: { addEventListener() {}, alert(text) { throw new Error(`unexpected alert: ${text}`); }, prompt() { throw new Error('unexpected prompt'); } },
    setInterval(callback, ms) { timers.push({ callback, ms }); return timers.length; },
    clearInterval(id) { cleared.push(id); },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url, 'http://localhost');
      const request = { path: parsed.pathname.replace('/api/data-toolbox', ''), query: parsed.searchParams, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(request);
      const answer = await respond(request);
      if (answer instanceof Error) return { ok: false, status: answer.status || 502, json: async () => ({ ok: false, status: 'error', message: answer.message }) };
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: answer }) };
    }
  };
  const source = ['storage-tools.js', 'files-tools.js', 'app.js'].map((file) => fs.readFileSync(path.join(publicRoot, file), 'utf8')).join('\n')
    .replace(/\nrender\(\);\s*$/, '\nglobalThis.page = { state, scanState, filesTools, render, scanPoll, scanRequest, files, filesFolderModel, fileQuery, number, bytes };');
  vm.runInNewContext(source, context);
  const click = async (dataset) => {
    const target = { closest: (selector) => {
      const key = selector.match(/^\[data-([a-z-]+)\]$/)?.[1].replace(/-(.)/g, (_, letter) => letter.toUpperCase());
      return key && key in dataset ? { dataset } : null;
    } };
    for (const listener of listeners.click) await listener({ target });
    await settle();
  };
  return { ...context.page, document, location: context.location, elements, listeners, requests, timers, cleared, click, content: element('#content') };
}
const settle = async () => { for (let turn = 0; turn < 12; turn++) await new Promise((resolve) => setImmediate(resolve)); };
const sent = (browser, method, route) => browser.requests.filter((request) => request.method === method && request.path === route);

// A Data whose storage answers come from `store`.
function storageData(store = {}) {
  store.agents ||= agentsBody();
  store.scans ||= [scanDoc('bbbbbbbbbbbbbbbbbbbbbb01')];
  return (request) => {
    if (request.method === 'POST') return request.path === '/storage/scans' && store.post ? store.post(request) : new Error('unexpected write');
    if (request.path === '/storage/summary') return { totalFiles: 2718, totalSize: 25224388748, hashCoverageFiles: 0.82 };
    if (request.path === '/storage/agents') return store.agents;
    if (request.path === '/storage/scans') return store.listError || scansBody(store.scans);
    if (request.path.startsWith('/storage/scans/')) return store.byId ? store.byId(request.path.split('/').pop()) : new Error('Scan not found');
    return new Error(`unexpected ${request.path}`);
  };
}
async function openStorage(store = {}) {
  const browser = page(storageData(store));
  await browser.render();
  return browser;
}
const section = (browser, selector) => browser.elements[selector]?.innerHTML || '';

async function relayApp(t, respond) {
  const express = require('express');
  const original = global.fetch;
  const calls = [];
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, options = {}) => {
    calls.push({ url: new URL(url), options });
    const answer = respond ? await respond(new URL(url), options) : null;
    return answer || { ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', data: {} }) };
  };
  const app = express();
  app.use(express.json());
  toolbox.register({ contractVersion: 2, app, express });
  return { app, calls, request: require('supertest') };
}
const dataAnswer = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

// ------------------------------------------------------------------ relays

test('the storage read relays keep bounded, allowlisted parameters only', async (t) => {
  const { app, calls, request } = await relayApp(t);
  await request(app).get('/api/data-toolbox/storage/scans/6ac73f708a09c61ea12b0e2e?verbose=1').expect(200);
  assert.equal(calls[0].url.pathname, '/api/v1/storage/status/6ac73f708a09c61ea12b0e2e');
  assert.equal(calls[0].url.search, '');
  await request(app).get('/api/data-toolbox/storage/scans/..%2F..%2Fadmin').expect(400);
  await request(app).get(`/api/data-toolbox/storage/scans/${'a'.repeat(121)}`).expect(400);
  assert.equal(calls.length, 1, 'a malformed scan id never reaches Data');

  await request(app).get(`/api/data-toolbox/storage/cleanup?root=${encodeURIComponent(`/mnt/${'x'.repeat(600)}`)}&limit=9&$where=1`).expect(200);
  assert.equal(calls[1].url.pathname, '/api/v1/storage/files/cleanup-recommendations');
  assert.deepEqual([...calls[1].url.searchParams.keys()], ['root']);
  assert.equal(calls[1].url.searchParams.get('root').length, 500);

  await request(app).get('/api/data-toolbox/storage/directory-count?root=/mnt').expect(200);
  assert.equal(calls[2].url.pathname, '/api/v1/storage/directory-count');
  assert.equal(calls[2].url.search, '');

  await request(app).get('/api/data-toolbox/storage/tree?root=/mnt/photos&limit=999999&depth=3').expect(200);
  assert.deepEqual(Object.fromEntries(calls[3].url.searchParams), { root: '/mnt/photos', limit: '2000' });

  await request(app).get('/api/data-toolbox/storage/files?sortBy=size&sortOrder=asc&ext=iso&minSize=1024&maxSize=-5&hasHash=true&limit=5000&page=0&includeDirname=true&sortBy2=x').expect(200);
  assert.deepEqual(Object.fromEntries(calls[4].url.searchParams), { ext: 'iso', hasHash: 'true', minSize: '1024', maxSize: '0', sortBy: 'size', sortOrder: 'asc', page: '1', limit: '100' });
  await request(app).get('/api/data-toolbox/storage/files?sortBy=path&sortOrder=sideways&hasHash=maybe').expect(200);
  assert.equal(calls[5].url.search, '', 'values outside the allowlists are dropped');

  await request(app).get('/api/data-toolbox/storage/duplicates?root=/mnt/archive&limit=5000&method=delete').expect(200);
  assert.deepEqual(Object.fromEntries(calls[6].url.searchParams), { root: '/mnt/archive', limit: '100' });
});

test('the scan relay forwards one known source name and nothing else', async (t) => {
  const { app, calls, request } = await relayApp(t, async (url, options) => options.method === 'POST'
    ? dataAnswer(202, { status: 'success', message: 'Storage scan queued to native agent', data: queuedAnswer() })
    : dataAnswer(200, { status: 'success', data: agentsBody() }));
  const answer = await request(app).post('/api/data-toolbox/storage/scans').send({ source: 'photos' }).expect(202);
  assert.equal(answer.body.data.scan_id, 'aaaaaaaaaaaaaaaaaaaaaa01');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, '/api/v1/storage/agents');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].url.pathname, '/api/v1/storage/agent-scans');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { source: 'photos' });

  const refused = [
    [{}, 'INVALID_STORAGE_SCAN', /source must be the name/],
    [[{ source: 'photos' }], 'INVALID_STORAGE_SCAN', /Expected a JSON object/],
    [{ source: 'photos', hash_mode: 'all' }, 'INVALID_STORAGE_SCAN', /Unknown field: hash_mode/],
    [{ source: 'photos', hash_max_files: 20000, roots: ['/'] }, 'INVALID_STORAGE_SCAN', /Unknown field: hash_max_files, roots/],
    [{ roots: ['/mnt/photos'] }, 'INVALID_STORAGE_SCAN', /Unknown field: roots/],
    [{ source: ['photos'] }, 'INVALID_STORAGE_SCAN', /source must be the name/],
    [{ source: 7 }, 'INVALID_STORAGE_SCAN', /source must be the name/],
    [{ source: '' }, 'INVALID_STORAGE_SCAN', /source must be the name/],
    [{ source: '/mnt/photos' }, 'INVALID_STORAGE_SCAN', /source must be the name/],
    [{ source: 'photos; rm -rf' }, 'INVALID_STORAGE_SCAN', /source must be the name/],
    [{ source: 'p'.repeat(61) }, 'INVALID_STORAGE_SCAN', /source must be the name/]
  ];
  for (const [body, code, message] of refused) {
    const response = await request(app).post('/api/data-toolbox/storage/scans').send(body).expect(400);
    assert.equal(response.body.code, code);
    assert.match(response.body.message, message);
  }
  assert.equal(calls.length, 2, 'a malformed body asks Data nothing');

  // A well-formed name Data does not list, including inherited object keys.
  for (const source of ['backups', 'constructor', 'toString', 'hasOwnProperty']) {
    const response = await request(app).post('/api/data-toolbox/storage/scans').send({ source }).expect(400);
    assert.equal(response.body.code, 'UNKNOWN_STORAGE_SOURCE');
  }
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1, 'an unknown source is never posted to Data');

  // No stop, no in-container scan, no other storage write.
  await request(app).post('/api/data-toolbox/storage/stop/aaaaaaaaaaaaaaaaaaaaaa01').send({}).expect(404);
  await request(app).post('/api/data-toolbox/storage/scan').send({ roots: ['/mnt/photos'] }).expect(404);
  await request(app).patch('/api/data-toolbox/storage/scans/aaaaaaaaaaaaaaaaaaaaaa01').send({ status: 'complete' }).expect(404);
});

test('Data\'s refusals, an unreadable source list and a timeout reach the page as distinct errors', async (t) => {
  let mode = 'no-agent';
  const { app, calls, request } = await relayApp(t, async (url, options) => {
    if (options.method !== 'POST') {
      if (mode === 'no-registry') return dataAnswer(500, { status: 'error', message: 'database unavailable' });
      if (mode === 'registry-timeout') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      return dataAnswer(200, { status: 'success', data: agentsBody() });
    }
    if (mode === 'no-agent') return dataAnswer(503, { status: 'error', message: 'no active storage agent for source: cold' });
    if (mode === 'conflict') return dataAnswer(409, { status: 'error', message: 'scan x is already running on an overlapping root' });
    if (mode === 'joined') return dataAnswer(202, { status: 'success', data: queuedAnswer({ coalesced: true }) });
    throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  });
  const post = (source = 'cold') => request(app).post('/api/data-toolbox/storage/scans').send({ source });
  assert.match((await post().expect(503)).body.message, /no active storage agent/);
  mode = 'conflict';
  assert.match((await post().expect(409)).body.message, /overlapping root/);
  mode = 'joined';
  assert.equal((await post('photos').expect(202)).body.data.coalesced, true);
  mode = 'post-timeout';
  const late = await post().expect(502);
  assert.equal(late.body.code, 'DATA_TIMEOUT');
  assert.match(late.body.message, /may or may not have been queued/);
  const before = calls.filter((call) => call.options.method === 'POST').length;
  mode = 'registry-timeout';
  assert.match((await post().expect(502)).body.message, /no scan was requested/);
  mode = 'no-registry';
  const blind = await post().expect(502);
  assert.equal(blind.body.code, 'DATA_UNAVAILABLE');
  assert.match(blind.body.message, /did not list its storage sources: no scan was requested/);
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, before, 'without the source list nothing is posted');
});

test('the manifest and the status projection name the storage scan request among the five write families', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', data: {} }) });
  const status = await toolbox.buildStatus();
  assert.deepEqual(status.writes, ['network-device-update', 'network-scan-request', 'mqtt-publish', 'storage-scan-request', 'janitor-review-decision']);
  assert.equal(status.filesystemMutationsExposed, false);
  assert.ok(toolbox.capabilities.includes('storage-scan-request'));
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  for (const file of ['storage-tools.js', 'files-tools.js']) {
    assert.ok(html.indexOf(`/assets/data-toolbox/${file}`) > 0);
    assert.ok(html.indexOf(`/assets/data-toolbox/${file}`) < html.indexOf('/assets/data-toolbox/app.js'));
    const source = fs.readFileSync(path.join(publicRoot, file), 'utf8');
    assert.doesNotMatch(source, /alert\(|confirm\(|prompt\(|insertAdjacentHTML|document\.write|eval\(/);
    assert.doesNotMatch(source, /storage\/stop|method:\s*'(DELETE|PATCH|PUT)'/);
  }
});

// -------------------------------------------------------------- Storage tab

test('each source has a Scan now button, disabled with its reason when nothing can run it', async () => {
  const running = scanDoc('cccccccccccccccccccccc01', { status: 'running', finished_at: null, config: { external: true, source: 'archive', roots: ['/mnt/archive'] }, counts: { files_processed: 900 } });
  const browser = await openStorage({ scans: [running, scanDoc('bbbbbbbbbbbbbbbbbbbbbb01', { config: { external: true, source: 'photos', roots: ['/mnt/photos'] } })] });
  const cards = browser.content.innerHTML.match(/<article class="card scan-source">.*?<\/article>/gs);
  assert.equal(cards.length, 3);
  const [photos, archive, cold] = cards;
  assert.match(photos, /data-scan-source="photos" aria-describedby="scanReason0">Scan now/);
  assert.match(photos, /collector active/);
  assert.match(photos, /\/mnt\/photos/);
  assert.match(photos, /Last finished scan.*pill good">complete/s);
  assert.match(archive, /data-scan-source="archive" aria-describedby="scanReason1" disabled>/);
  assert.match(archive, /id="scanReason1"[^>]*>A scan of this source is already running: it is followed below\./);
  assert.match(cold, /data-scan-source="cold" aria-describedby="scanReason2" disabled>/);
  assert.match(cold, /no active collector/);
  assert.match(cold, /No active collector announces this source, so nothing would pick the scan up\./);
  // The running scan is followed at once, every three seconds.
  assert.match(browser.content.innerHTML, /Scan in progress/);
  assert.deepEqual(browser.timers.map((timer) => timer.ms), [3000]);
  // A collector-run scan cannot be stopped: no such control is offered.
  assert.doesNotMatch(browser.content.innerHTML, /<button[^>]*>\s*Stop/i);
  assert.match(browser.content.innerHTML, /cannot be stopped from here/);
});

test('no source, no collector and no scan are said, not shown as blanks', async () => {
  const browser = await openStorage({ agents: { scanners: [], active: 0, sources: {} }, scans: [] });
  assert.match(browser.content.innerHTML, /Data lists no storage source, so no scan can be asked for here\./);
  assert.match(browser.content.innerHTML, /Data has no scan on record\./);
  assert.match(browser.content.innerHTML, /No storage collectors registered\./);
  assert.equal(browser.timers.length, 0, 'nothing to follow: no timer');
});

test('Scan now posts the source, then follows the scan from queued to complete', async () => {
  const scan = scanDoc('aaaaaaaaaaaaaaaaaaaaaa01', { status: 'queued', started_at: null, finished_at: null, counts: {}, claimed_by: undefined, last_batch_at: undefined, config: { external: true, source: 'photos', roots: ['/mnt/photos'], hash_mode: 'candidates' } });
  const store = { post: () => queuedAnswer(), byId: () => statusBody(scan) };
  const browser = await openStorage(store);
  assert.equal(browser.timers.length, 0);

  await browser.click({ scanSource: 'photos' });
  assert.deepEqual(JSON.parse(JSON.stringify(sent(browser, 'POST', '/storage/scans').map((request) => request.body))), [{ source: 'photos' }]);
  assert.match(section(browser, '#scanOutcome'), /notice success">Scan aaaaaaaaaaaaaaaaaaaaaa01 queued for photos \(\/mnt\/photos\)/);
  assert.deepEqual(browser.timers.map((timer) => timer.ms), [3000]);
  // A queued scan is not in Data's list: it is read by its id.
  assert.equal(sent(browser, 'GET', '/storage/scans/aaaaaaaaaaaaaaaaaaaaaa01').length, 1);
  let card = section(browser, '#scanProgress');
  assert.match(card, /Scan in progress/);
  assert.match(card, /pill ">queued/);
  assert.match(card, /Waiting for the collector/);
  assert.match(card, /<span>Files seen<\/span><strong>—<\/strong>/, 'a count Data has not sent is a dash, not a zero');
  assert.match(section(browser, '#scanSources'), /data-scan-source="photos"[^>]* disabled>.*already queued/s);

  // Claimed: the list now carries it, with the counts the batches add.
  Object.assign(scan, { status: 'running', started_at: new Date(Date.now() - 65000).toISOString(), claimed_by: 'nas-storage', last_batch_at: new Date(Date.now() - 2000).toISOString(), counts: { files_processed: 18000, inserted: 3, updated: 17997 } });
  store.scans = [scan, ...store.scans];
  await browser.timers[0].callback();
  card = section(browser, '#scanProgress');
  assert.match(card, /pill ">running/);
  assert.match(card, new RegExp(`<span>Files processed</span><strong>${browser.number(18000)}</strong>`));
  assert.match(card, /<span>Elapsed<\/span><strong>1 min 0[5-9] s<\/strong>/);
  assert.match(card, /<span>Last batch received<\/span><strong>[2-5] s ago<\/strong>/);
  assert.match(card, /run by nas-storage/);
  assert.equal(sent(browser, 'GET', '/storage/scans/aaaaaaaaaaaaaaaaaaaaaa01').length, 1, 'a listed scan is not read a second time by id');

  Object.assign(scan, { status: 'complete', finished_at: new Date().toISOString(), counts: { files_processed: 50531, files_seen: 50531, hashed: 862, errors: 0, stale_removed: 4 } });
  await browser.timers[0].callback();
  card = section(browser, '#scanProgress');
  assert.match(card, /Scan followed from this page/);
  assert.match(card, /pill good">complete/);
  assert.match(card, /Finished\. The index matches what this scan saw\./);
  assert.match(card, new RegExp(`<span>Files hashed</span><strong>${browser.number(862)}</strong>`));
  assert.equal(section(browser, '#scanOutcome'), '', 'the queued line goes once the scan has ended');
  assert.match(section(browser, '#scanSources'), /data-scan-source="photos" aria-describedby="scanReason0">Scan now/, 'the source can be scanned again');
  // Nothing left to follow: the next tick stops the timer and asks nothing.
  const reads = browser.requests.length;
  await browser.timers[0].callback();
  assert.equal(browser.requests.length, reads);
  assert.deepEqual(browser.cleared, [1]);
});

test('a joined scan says so, and no second scan is announced', async () => {
  const running = scanDoc('cccccccccccccccccccccc01', { status: 'running', finished_at: null, config: { external: true, source: 'photos', roots: ['/mnt/photos'] }, counts: { files_processed: 900 } });
  // The page read the list before the nightly job queued its scan.
  const store = { post: () => queuedAnswer({ scan_id: running._id, coalesced: true }) };
  const browser = await openStorage(store);
  store.scans = [running, ...store.scans];
  await browser.click({ scanSource: 'photos' });
  assert.match(section(browser, '#scanOutcome'), /A scan of photos was already queued or running: joined it \(scan cccccccccccccccccccccc01\)\. No second scan was started\./);
  const card = section(browser, '#scanProgress');
  assert.match(card, /Joined: this scan was already there when you asked, no second one was started\./);
  assert.match(card, /pill ">running/);
  assert.equal(card.match(/<article class="card scan-progress/g).length, 1);
});

test('partial and failed scans are explained in plain words with Data\'s reason', async () => {
  const partial = scanDoc('dddddddddddddddddddddd01', { status: 'partial', last_error: 'Root /mnt/archive: no file indexed by this scan, existing index rows were kept <b>' });
  const failed = scanDoc('dddddddddddddddddddddd02', { status: 'failed', counts: { files_processed: 40 }, last_error: 'No heartbeat or batch from the storage agent for 10 minutes; scan marked failed, index rows kept' });
  const stopped = scanDoc('dddddddddddddddddddddd03', { status: 'stopped', type: undefined, claimed_by: undefined, config: { roots: ['/mnt/archive'] } });
  const browser = await openStorage({ scans: [partial, failed, stopped] });
  const details = browser.content.innerHTML.match(/<details class="scan-detail".*?<\/details>/gs);
  assert.equal(details.length, 3);
  assert.match(details[0], /pill warn">partial/);
  assert.match(details[0], /<strong>Partial\.<\/strong> The scan ended without confirming every root, so the index was kept: the rows already recorded there were not removed\./);
  assert.match(details[0], /Data's reason: <span class="mono">Root \/mnt\/archive: no file indexed by this scan, existing index rows were kept &lt;b&gt;<\/span>/);
  assert.match(details[1], /<strong>Failed\.<\/strong> The scan did not finish and removed nothing from the index\./);
  assert.match(details[1], /No heartbeat or batch from the storage agent for 10 minutes/);
  assert.match(details[1], /<span>Files seen<\/span><strong>—<\/strong>/);
  assert.match(details[2], /<strong>Stopped<\/strong> before the end\. Nothing was removed from the index\./);
  assert.match(details[2], /Run by<\/span><strong><span class="mono">Data itself/);

  // The same words while a followed scan ends partial under the page's eyes.
  const scan = scanDoc('aaaaaaaaaaaaaaaaaaaaaa01', { status: 'running', finished_at: null, config: { external: true, source: 'photos', roots: ['/mnt/photos'] } });
  const live = await openStorage({ scans: [scan] });
  Object.assign(scan, { status: 'partial', finished_at: '2026-10-08T07:05:00.000Z', last_error: 'Root /mnt/photos: no file indexed by this scan, existing index rows were kept' });
  await live.timers[0].callback();
  assert.match(section(live, '#scanProgress'), /pill warn">partial.*<strong>Partial\.<\/strong>.*the index was kept.*Root \/mnt\/photos: no file indexed/s);
});

test('a past scan opens on its timing, counts and settings', async () => {
  const browser = await openStorage({ scans: [scanDoc('bbbbbbbbbbbbbbbbbbbbbb01', { last_path: '/mnt/archive/last/file.bin' })] });
  const detail = browser.content.innerHTML.match(/<details class="scan-detail" data-scan-detail="bbbbbbbbbbbbbbbbbbbbbb01">.*?<\/details>/s)[0];
  assert.match(detail, /<summary>.*archive · \/mnt\/archive.*1 min 47 s<\/span><\/summary>/s);
  assert.match(detail, /<span>Waited in the queue<\/span><strong>1 min 22 s<\/strong>/);
  assert.match(detail, /<span>Duration<\/span><strong>1 min 47 s<\/strong>/);
  assert.match(detail, /<span>Run by<\/span><strong><span class="mono">nas-storage/);
  assert.match(detail, new RegExp(`<span>Hashing</span><strong>candidates · at most ${browser.number(5000)} files, 50\\.0 GiB</strong>`));
  assert.match(detail, new RegExp(`<span>Files seen</span><strong>${browser.number(2210)}</strong>`));
  assert.match(detail, /<span>Index rows removed \(files no longer there\)<\/span><strong>3<\/strong>/);
  assert.match(detail, /<span>Bytes hashed<\/span><strong>1\.7 GiB<\/strong>/);
  assert.match(detail, /<span>Errors<\/span><strong>0<\/strong>/);
  // Opening one is remembered, so a poll redrawing the history keeps it open.
  const toggle = browser.listeners.toggle[0];
  toggle({ target: { dataset: { scanDetail: 'bbbbbbbbbbbbbbbbbbbbbb01' }, open: true } });
  assert.ok(browser.scanState.open.has('bbbbbbbbbbbbbbbbbbbbbb01'));
});

test('a refused request is reported under the buttons and leaves them usable', async () => {
  const store = { post: () => Object.assign(new Error('no active storage agent for source: photos'), { status: 503 }) };
  const browser = await openStorage(store);
  await browser.click({ scanSource: 'photos' });
  assert.match(section(browser, '#scanOutcome'), /notice warning">Not started: no active storage agent for source: photos/);
  assert.match(section(browser, '#scanSources'), /data-scan-source="photos" aria-describedby="scanReason0">Scan now/);
  assert.equal(browser.timers.length, 0);
  // A source the page shows as unavailable is not posted, whatever is clicked.
  await browser.click({ scanSource: 'cold' });
  await browser.click({ scanSource: 'not-a-source' });
  assert.equal(sent(browser, 'POST', '/storage/scans').length, 1);
});

test('the scan poll runs only on a visible Storage tab and never writes into another tab', async () => {
  const scan = scanDoc('aaaaaaaaaaaaaaaaaaaaaa01', { status: 'running', finished_at: null, config: { external: true, source: 'photos', roots: ['/mnt/photos'] } });
  const store = { scans: [scan] };
  const browser = await openStorage(store);
  const reads = () => sent(browser, 'GET', '/storage/scans').length;
  const before = reads();
  browser.document.hidden = true;
  await browser.timers[0].callback();
  assert.equal(reads(), before, 'a hidden page asks nothing');
  browser.document.hidden = false;
  await browser.timers[0].callback();
  assert.equal(reads(), before + 1);

  // A list that cannot be read says so and keeps the last state.
  store.listError = new Error('Data service request timed out');
  await browser.timers[0].callback();
  assert.match(section(browser, '#scanProgress'), /The scan list could not be read from Data: Data service request timed out\. What is shown is the last state read\./);
  assert.match(section(browser, '#scanProgress'), /pill ">running/);
  delete store.listError;

  // An answer that arrives after a tab change is dropped.
  let release;
  store.listError = new Promise((resolve) => { release = resolve; });
  const pending = browser.timers[0].callback();
  browser.state.tab = 'files';
  const shown = section(browser, '#scanProgress');
  release(scansBody([{ ...scan, status: 'complete' }]));
  await pending;
  assert.equal(section(browser, '#scanProgress'), shown);
  // The first tick on another tab stops the timer.
  await browser.timers[0].callback();
  assert.deepEqual(browser.cleared, [1]);
});

test('a hostile source name or path in the scan data is escaped, never markup', async () => {
  const browser = await openStorage({
    agents: agentsBody({ sources: { photos: { canonicalRoot: `/mnt/${HOSTILE}` }, '"><script>alert(1)</script>': { canonicalRoot: '/mnt/x' } } }),
    scans: [scanDoc('bbbbbbbbbbbbbbbbbbbbbb01', { claimed_by: '<svg onload=alert(1)>', config: { external: true, source: '<i>src</i>', roots: [`/mnt/${HOSTILE}`] } })]
  });
  const html = browser.content.innerHTML;
  assert.doesNotMatch(html, /<img|<script|<svg|<i>src/);
  assert.match(html, new RegExp(HOSTILE_ESCAPED.replace(/[()]/g, '\\$&')));
  assert.match(html, /This source name is not one this page can send\./);
});

// ---------------------------------------------------------------- Files tab

function filesData(store = {}) {
  return (request) => {
    if (request.method !== 'GET') return new Error('unexpected write');
    const answer = {
      '/storage/files': () => store.files ?? filesBody([fileDoc()]),
      '/storage/stats': () => store.stats ?? statsBody(),
      '/storage/directory-count': () => store.directories ?? { count: 265 },
      '/storage/tree': () => store.tree ?? { limit: 2000, truncated: false, tree: [] },
      '/storage/duplicates': () => store.duplicates ?? duplicatesBody([]),
      '/storage/summary': () => store.summary ?? summaryBody(),
      '/storage/cleanup': () => store.cleanup ?? cleanupBody()
    }[request.path];
    if (!answer) return new Error(`unexpected ${request.path}`);
    const value = answer();
    return typeof value === 'function' ? value(request) : value;
  };
}
async function openFiles(store = {}) {
  const browser = page(filesData(store), '#files');
  await browser.render();
  await settle();
  return browser;
}
const submit = async (browser, id, fields) => {
  const event = { target: { id, elements: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])) }, preventDefault() {} };
  // app.js reads the filter form through FormData; the scope form is read directly.
  if (id === 'fileFilters') { browser.state.filesPage = 1; await browser.files(new URLSearchParams(fields)); }
  else for (const listener of browser.listeners.submit) await listener(event);
  await settle();
};

test('the Files tab opens on the list with the index totals above it', async () => {
  const browser = await openFiles();
  const html = browser.content.innerHTML;
  assert.match(html, /<strong>Read-only\.<\/strong> Nothing is deleted, moved or renamed from this page\./);
  for (const view of ['list', 'folders', 'duplicates', 'cleanup']) assert.match(html, new RegExp(`data-files-view="${view}" aria-pressed="${view === 'list'}"`));
  assert.match(html, /<td>holiday\.jpg<\/td>/);
  assert.match(html, /<td>146\.7 KiB<\/td>/);
  const stats = section(browser, '#filesStats');
  assert.match(stats, new RegExp(`<strong class="metric">${browser.number(2718)}</strong><span class="metric-label">files in the index`));
  assert.match(stats, /<strong class="metric">23\.5 GiB<\/strong><span class="metric-label">total size/);
  assert.match(stats, /<strong class="metric">3<\/strong><span class="metric-label">extensions</);
  assert.match(stats, /<strong class="metric">265<\/strong><span class="metric-label">folders holding files/);
  assert.match(stats, /<datalist id="fileExtensions"><option value="jpg">/);
  // The totals are cached: paging does not read them again.
  browser.state.filesPage = 2;
  await browser.files();
  assert.equal(sent(browser, 'GET', '/storage/stats').length, 1);
});

test('Data\'s 25-extension ceiling is shown as such, and missing totals as a dash', async () => {
  const capped = await openFiles({ stats: statsBody(25), directories: new Error('Data service request timed out') });
  assert.match(section(capped, '#filesStats'), /<strong class="metric">25\+<\/strong><span class="metric-label">extensions \(Data lists the 25 largest\)/);
  assert.match(section(capped, '#filesStats'), /<strong class="metric">—<\/strong><span class="metric-label">folders holding files/);
  // Totals that cannot be read do not take the list down.
  const broken = await openFiles({ stats: new Error('Data service request timed out') });
  assert.match(section(broken, '#filesStats'), /The index totals could not be read from Data: Data service request timed out\. The views below do not depend on them\./);
  assert.match(broken.content.innerHTML, /<td>holiday\.jpg<\/td>/);
});

test('sort, extension, size range, hash and page size reach Data as bounded parameters', async () => {
  const browser = await openFiles();
  assert.deepEqual(Object.fromEntries(sent(browser, 'GET', '/storage/files')[0].query), { limit: '50', page: '1' });
  const form = browser.content.innerHTML.match(/<form id="fileFilters".*?<\/form>/s)[0];
  for (const name of ['search', 'root', 'category', 'ext', 'minSize', 'maxSize', 'sizeUnit', 'hasHash', 'sortBy', 'sortOrder', 'limit']) assert.match(form, new RegExp(`<label>[^<]+<(input|select) name="${name}"`), `${name} has a visible label`);
  assert.match(form, /<option value="filename">Name<\/option><option value="size">Size<\/option>/);
  assert.match(form, /<option value="true">Has a hash<\/option><option value="false">No hash<\/option>/);

  await submit(browser, 'fileFilters', { search: 'report', ext: 'iso', minSize: '1.5', maxSize: '4', sizeUnit: 'GiB', hasHash: 'true', sortBy: 'size', sortOrder: 'asc', limit: '25' });
  assert.deepEqual(Object.fromEntries(sent(browser, 'GET', '/storage/files').at(-1).query),
    { search: 'report', ext: 'iso', hasHash: 'true', sortBy: 'size', sortOrder: 'asc', minSize: '1610612736', maxSize: '4294967296', limit: '25', page: '1' });
  // What was chosen is put back in the form.
  assert.equal(browser.elements['#fileFilters'].elements.sizeUnit, undefined);
  browser.elements['#fileFilters'].elements = { ext: {}, sizeUnit: {}, limit: {}, minSize: {} };
  await browser.files();
  assert.deepEqual(JSON.parse(JSON.stringify(browser.elements['#fileFilters'].elements)), { ext: { value: 'iso' }, sizeUnit: { value: 'GiB' }, limit: { value: '25' }, minSize: { value: '1.5' } });

  // A page size outside the offered ones falls back; MiB is the default unit.
  await submit(browser, 'fileFilters', { minSize: '2', limit: '100000' });
  assert.deepEqual(Object.fromEntries(sent(browser, 'GET', '/storage/files').at(-1).query), { minSize: '2097152', limit: '50', page: '1' });

  // An impossible range is refused in the page, without a request.
  const asked = sent(browser, 'GET', '/storage/files').length;
  await submit(browser, 'fileFilters', { minSize: '10', maxSize: '2', sizeUnit: 'MiB' });
  assert.match(browser.content.innerHTML, /These filters could not be applied: Min size is larger than max size\./);
  assert.match(browser.content.innerHTML, /id="fileFilters"/);
  await submit(browser, 'fileFilters', { maxSize: '-3' });
  assert.match(browser.content.innerHTML, /Max size must be a number, zero or more\./);
  assert.equal(sent(browser, 'GET', '/storage/files').length, asked);
});

test('an empty list, a refused filter and missing values each have their own words', async () => {
  const empty = await openFiles({ files: filesBody([]) });
  assert.match(empty.content.innerHTML, /<td colspan="6" class="muted">No file matches these filters\.<\/td>/);
  const bare = await openFiles({ files: filesBody([{ _id: 'f2' }]) });
  const row = bare.content.innerHTML.match(/<tbody>\s*(<tr>.*?<\/tr>)/s)[1];
  assert.match(row, /<td>—<\/td>\s*<td class="mono muted">—<\/td>\s*<td>—<\/td>/);
  assert.match(row, /<td>—<\/td>\s*<td class="mono"><span class="warn">missing<\/span>/);
  const refused = await openFiles({ files: Object.assign(new Error('Unknown file category: image'), { status: 400 }) });
  assert.match(refused.content.innerHTML, /These filters could not be applied: Unknown file category: image/);
});

test('folders are grouped by name from Data\'s rows, with a breadcrumb and a way down', async () => {
  const store = { tree: { limit: 2000, truncated: false, tree: [
    treeRow('/mnt/photos/2024/summer', 120, 5000000000), treeRow('/mnt/photos/2024', 4, 1000),
    treeRow('/mnt/photos/2023', 60, 2000000000), treeRow('/mnt/archive/vm', 3, 60000000000), treeRow('/mnt/archive', 2, 10)
  ] } };
  const browser = await openFiles(store);
  await browser.click({ filesView: 'folders' });
  assert.deepEqual(Object.fromEntries(sent(browser, 'GET', '/storage/tree')[0].query), { root: '/', limit: '2000' });
  let html = browser.content.innerHTML;
  // No folder chosen: the view starts at the common parent of what is recorded.
  assert.match(html, /<nav class="crumbs" aria-label="Folder path"><button type="button" class="link-button" data-files-folder="">All folders<\/button><span aria-hidden="true">\/<\/span><span class="mono" aria-current="location">mnt<\/span>/);
  const rows = html.match(/<tbody>(.*?)<\/tbody>/s)[1].split('<tr>').slice(1);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /data-files-folder="\/mnt\/archive">archive<\/button>.*<td>5<\/td><td>55\.9 GiB<\/td><td>2<\/td>/s, 'largest first, own files included');
  assert.match(rows[1], /data-files-folder="\/mnt\/photos">photos<\/button>.*<td>184<\/td><td>6\.5 GiB<\/td><td>3<\/td>/s);
  assert.match(rows[1], /data-files-show="\/mnt\/photos">Show files/);
  assert.match(html, new RegExp(`This folder and everything below</span><strong>${browser.number(2718)} files · 23\\.5 GiB`), 'the top totals are the index totals');

  // Down one level: the exact totals of that folder come from the stats relay.
  store.tree = { limit: 2000, truncated: false, tree: [treeRow('/mnt/photos/2024/summer', 120, 5000000000), treeRow('/mnt/photos/2024', 4, 1000), treeRow('/mnt/photos/2023', 60, 2000000000), treeRow('/mnt/photos2/x', 9, 9)] };
  store.stats = (request) => request.query.get('root') === '/mnt/photos' ? { root: '/mnt/photos', total: { count: 184, totalSize: 7000001000 } } : statsBody();
  await browser.click({ filesFolder: '/mnt/photos' });
  assert.equal(sent(browser, 'GET', '/storage/tree').at(-1).query.get('root'), '/mnt/photos');
  html = browser.content.innerHTML;
  assert.match(html, /data-files-folder="\/mnt">mnt<\/button><span aria-hidden="true">\/<\/span><span class="mono" aria-current="location">photos<\/span>/);
  assert.match(html, /This folder and everything below<\/span><strong>184 files · 6\.5 GiB/);
  assert.match(html, /Files directly in this folder<\/span><strong>none/);
  assert.doesNotMatch(html, /photos2|data-files-folder="\/mnt\/photos\/x"/, 'a sibling whose name starts the same is not a child');
  assert.match(html, /data-files-folder="\/mnt\/photos\/2024">2024<\/button>.*<td>124<\/td>/s);

  // "Show files here" applies the folder as the list's filter.
  await browser.click({ filesShow: '/mnt/photos/2024' });
  assert.equal(browser.filesTools.view, 'list');
  assert.deepEqual(Object.fromEntries(sent(browser, 'GET', '/storage/files').at(-1).query), { root: '/mnt/photos/2024', limit: '50', page: '1' });
});

test('a folder read Data cut short marks its figures as lower bounds', async () => {
  const browser = await openFiles({ tree: { limit: 2000, truncated: true, tree: [treeRow('/mnt/photos/2024', 40, 1048576), treeRow('/mnt/photos/2023', 2, 1024)] } });
  await browser.click({ filesFolder: '/mnt/photos' });
  const html = browser.content.innerHTML;
  assert.match(html, new RegExp(`Data returned the ${browser.number(2000)} largest folders under this one, not all of them\\.`));
  assert.match(html, /<td>≥ 40<\/td><td>≥ 1\.0 MiB<\/td><td>≥ 1<\/td>/);
  assert.match(html, /Files directly in this folder<\/span><strong>not in the rows Data returned/);
  // Nothing recorded, and a failed read, are two different messages.
  const empty = await openFiles();
  await empty.click({ filesFolder: '/mnt/empty' });
  assert.match(empty.content.innerHTML, /No folder below this one holds recorded files\./);
  const broken = await openFiles({ tree: new Error('Data service request timed out') });
  await broken.click({ filesView: 'folders' });
  assert.match(broken.content.innerHTML, /The folders could not be read from Data: Data service request timed out\./);
  assert.match(broken.content.innerHTML, /data-files-view="folders" aria-pressed="true"/, 'the view switch stays');
});

test('duplicate groups show size, copies, paths and reclaimable space, ten at a time', async () => {
  const groups = Array.from({ length: 23 }, (_, index) => duplicateGroup(index + 1));
  const browser = await openFiles({ duplicates: duplicatesBody(groups) });
  await browser.click({ filesView: 'duplicates' });
  assert.deepEqual(Object.fromEntries(sent(browser, 'GET', '/storage/duplicates')[0].query), { limit: '100' });
  let html = browser.content.innerHTML;
  assert.match(html, /<strong class="metric">481<\/strong><span class="metric-label">verified duplicate groups in the index/);
  assert.match(html, /<strong class="metric">1\.9 GiB<\/strong><span class="metric-label">reclaimable if one copy of each is kept/);
  assert.match(html, /<strong class="metric">18\.4%<\/strong><span class="metric-label">of the bytes are hashed/);
  assert.match(html, /these figures are a lower bound\.\s+Nothing is deleted from this page/);
  assert.match(html, /Groups 1–10 of the 23 largest\. Data returns the largest groups only, at most 100 here\./);
  assert.equal(html.match(/<article class="card dup-group">/g).length, 10);
  const first = html.match(/<article class="card dup-group">.*?<\/article>/s)[0];
  assert.match(first, /<h3>2 copies · 4\.8 MiB each<\/h3><span class="pill warn">4\.8 MiB reclaimable/);
  assert.match(first, /sha256 01cccccccccccccc…/);
  assert.match(first, /<span class="mono">\/mnt\/archive\/a\/copy-1\.iso<\/span> <span class="muted">modified /);
  assert.match(first, /\/mnt\/archive\/b\/copy-1\.iso/);
  assert.match(html, /data-files-action="duplicates-previous" disabled/);

  await browser.click({ filesAction: 'duplicates-next' });
  await browser.click({ filesAction: 'duplicates-next' });
  html = browser.content.innerHTML;
  assert.match(html, /Groups 21–23 of the 23 largest/);
  assert.equal(html.match(/<article class="card dup-group">/g).length, 3);
  assert.match(html, /data-files-action="duplicates-next" disabled/);
  assert.equal(sent(browser, 'GET', '/storage/duplicates').length, 1, 'paging uses what was read, without a new request');

  // A folder scope goes to Data for both the groups and the totals.
  await submit(browser, 'filesScope', { root: '/mnt/archive/' });
  assert.equal(sent(browser, 'GET', '/storage/duplicates').at(-1).query.get('root'), '/mnt/archive');
  assert.equal(sent(browser, 'GET', '/storage/summary').at(-1).query.get('root'), '/mnt/archive');
  assert.match(browser.content.innerHTML, /Limited to \/mnt\/archive and below\./);
});

test('unverified candidates, no group and a failed read are told apart', async () => {
  const fuzzy = duplicatesBody([{ filename: 'notes.txt', size: 2048, count: 3, wastedSpace: 4096, locations: [{ dirname: '/mnt/archive/a', mtime: 1732825496 }, { dirname: '/mnt/archive/b', mtime: 1732825496 }] }],
    { method: 'same-name-size-candidates', verified: false, note: 'These are unverified candidates. Run a candidates hash-mode scan for exact SHA256 evidence.' });
  const unverified = await openFiles({ duplicates: fuzzy });
  await unverified.click({ filesView: 'duplicates' });
  assert.match(unverified.content.innerHTML, /notice warning"><strong>Not verified\.<\/strong> These are unverified candidates\./);
  assert.match(unverified.content.innerHTML, /same name and size, not verified: notes\.txt/);
  assert.match(unverified.content.innerHTML, /<span class="mono">\/mnt\/archive\/a\/notes\.txt<\/span>/);

  const none = await openFiles({ summary: new Error('Data service request timed out') });
  await none.click({ filesView: 'duplicates' });
  assert.match(none.content.innerHTML, /No duplicate group found here\./);
  assert.match(none.content.innerHTML, /The index totals could not be read from Data: Data service request timed out\. The groups below do not depend on them\./);
  assert.match(none.content.innerHTML, /<strong class="metric">—<\/strong><span class="metric-label">verified duplicate groups in the index/);

  const broken = await openFiles({ duplicates: new Error('Data service request timed out') });
  await broken.click({ filesView: 'duplicates' });
  assert.match(broken.content.innerHTML, /The duplicate groups could not be read from Data: Data service request timed out\./);
  assert.match(broken.content.innerHTML, /<form id="filesScope"/);
});

test('cleanup suggestions are read-only leads, with what is and is not measured', async () => {
  const browser = await openFiles();
  await browser.click({ filesView: 'cleanup' });
  assert.equal(sent(browser, 'GET', '/storage/cleanup')[0].query.toString(), '');
  const html = browser.content.innerHTML;
  assert.match(html, /Nothing is deleted from this page, and a file's size or age alone is not a reason to delete it\./);
  const cards = html.match(/<article class="card cleanup-card">.*?<\/article>/gs);
  assert.equal(cards.length, 5);
  assert.match(cards[0], /<h3>Large files<\/h3><span class="pill ">review/);
  assert.match(cards[0], /<span>Possible saving<\/span><strong>not measured<\/strong>/);
  assert.match(cards[0], /<span>Size of the sampled files<\/span><strong>2\.8 GiB<\/strong>/);
  assert.match(cards[0], /<summary>2 sampled files<\/summary>.*\/mnt\/archive\/vm\/disk\.vdi<\/span> <span class="muted">1\.9 GiB/s);
  assert.match(cards[1], /<h3>Old files<\/h3>.*readme\.txt<\/span> <span class="muted">19\.11 KB · 17114 days old/s);
  assert.match(cards[2], /<h3>Verified duplicates<\/h3><span class="pill warn">high.*<span>Possible saving<\/span><strong>1\.9 GiB<\/strong>.*sha256-current-metadata/s);
  assert.match(cards[3], /<h3>Empty files<\/h3>.*<span>Possible saving<\/span><strong>0 B<\/strong>/s);
  assert.doesNotMatch(cards[3], /<details>/);
  assert.match(cards[4], /Root clutter requires a scoped root query/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(Delete|Remove|Move|Apply cleanup)/i);

  const empty = await openFiles({ cleanup: { root: null, recommendations: [] } });
  await empty.click({ filesView: 'cleanup' });
  assert.match(empty.content.innerHTML, /Data returned no suggestion\./);
  const broken = await openFiles({ cleanup: new Error('Data service request timed out') });
  await broken.click({ filesView: 'cleanup' });
  assert.match(broken.content.innerHTML, /The cleanup suggestions could not be read from Data: Data service request timed out\./);
});

test('a hostile file or folder name is escaped in every Files view', async () => {
  const store = {
    files: filesBody([fileDoc({ filename: HOSTILE, dirname: `/mnt/photos/${HOSTILE}`, category: '<b>cat</b>', sha256: '<script>alert(1)</script>' })]),
    tree: { limit: 2000, truncated: false, tree: [treeRow(`/mnt/photos/${HOSTILE}/in"side`, 1, 1), treeRow('/mnt/photos/"onmouseover="alert(1)', 1, 1)] },
    duplicates: duplicatesBody([duplicateGroup(1, { sha256: '"><img src=x>', locations: [{ path: `/mnt/archive/${HOSTILE}`, mtime: 1 }, { path: '/mnt/archive/<script>alert(2)</script>', mtime: 1 }] })])
  };
  const browser = await openFiles(store);
  const clean = (html) => {
    assert.doesNotMatch(html, /<img|<script|<b>cat|"onmouseover="|in"side/);
    assert.ok(html.includes(HOSTILE_ESCAPED));
  };
  clean(browser.content.innerHTML);
  await browser.click({ filesFolder: '/mnt/photos' });
  clean(browser.content.innerHTML);
  assert.match(browser.content.innerHTML, /data-files-folder="\/mnt\/photos\/&quot;onmouseover=&quot;alert\(1\)"/);
  await browser.click({ filesFolder: `/mnt/photos/${HOSTILE}` });
  clean(browser.content.innerHTML);
  await browser.click({ filesView: 'duplicates' });
  clean(browser.content.innerHTML);
  await submit(browser, 'filesScope', { root: `/mnt/${HOSTILE}` });
  clean(browser.content.innerHTML);
  assert.match(browser.content.innerHTML, new RegExp(`value="/mnt/${HOSTILE_ESCAPED.replace(/[()]/g, '\\$&')}"`));
  await browser.click({ filesView: 'cleanup' });
  clean(browser.content.innerHTML);
  assert.equal(browser.requests.filter((request) => request.method !== 'GET').length, 0, 'the Files tab only reads');
});

test('an answer that arrives after the view or the tab changed is dropped', async () => {
  let release;
  const store = { duplicates: () => new Promise((resolve) => { release = resolve; }) };
  const browser = await openFiles(store);
  const opening = browser.click({ filesView: 'duplicates' });
  await settle();
  assert.match(browser.content.innerHTML, /Comparing hashes…/);
  await browser.click({ filesView: 'cleanup' });
  const shown = browser.content.innerHTML;
  release(duplicatesBody([duplicateGroup(1)]));
  await opening;
  await settle();
  assert.equal(browser.content.innerHTML, shown, 'the slow duplicate read does not replace the Cleanup view');
  assert.match(shown, /data-files-view="cleanup" aria-pressed="true"/);
});
