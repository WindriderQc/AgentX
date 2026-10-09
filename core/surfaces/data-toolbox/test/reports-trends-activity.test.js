'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const toolbox = require('../index');
const relays = require('../reports-trends-activity');
const fx = require('./fixtures/reports-trends-activity');
const storageTrends = require('../../../../data/services/storageTrends');

// Data's own modules, loaded without Data's dependencies (its logger is not
// installed with Core): only their local requires are replaced by stand-ins.
function dataModule(file) {
  const filename = path.resolve(__dirname, '../../../../data/services', file);
  const loaded = { exports: {} };
  const stand = (name) => /^(path|fs|fs\/promises|crypto)$/.test(name) ? require(name) : { log() {}, emit() {}, formatFileSize: String };
  new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(filename, 'utf8'))(stand, loaded, loaded.exports, path.dirname(filename));
  return loaded.exports;
}
const exportStore = dataModule('exportStore.js');
const activityLog = dataModule('activityLog.js');

const publicRoot = path.resolve(__dirname, '..', 'public');
const SCRIPTS = ['storage-tools.js', 'files-tools.js', 'storage-trends.js', 'storage-views.js', 'activity.js', 'app.js'];
const NAME = fx.reportName('summary', 'csv');

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
  const fail = (what) => () => { throw new Error(`unexpected ${what}`); };
  const context = {
    document, location: { hash }, console, URLSearchParams,
    // Every outcome is reported inline: a dialog would fail the test.
    window: { addEventListener() {}, alert: fail('alert'), confirm: fail('confirm'), prompt: fail('prompt') },
    alert: fail('alert'), confirm: fail('confirm'), prompt: fail('prompt'),
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
  const source = SCRIPTS.map((file) => fs.readFileSync(path.join(publicRoot, file), 'utf8')).join('\n')
    .replace(/\nrender\(\);\s*$/, '\nglobalThis.page = { state, render, storageViews, trendState, reportState, activityState, reportPoll, activityPoll, trendAxis, trendTimeTicks, trendFigure, activityMetaRows };');
  vm.runInNewContext(source, context);
  const fire = async (name, event) => { for (const listener of listeners[name] || []) await listener(event); await settle(); };
  const click = (dataset) => fire('click', { target: { closest: (selector) => {
    const key = selector.match(/^\[data-([a-z-]+)\]$/)?.[1].replace(/-(.)/g, (_, letter) => letter.toUpperCase());
    return key && key in dataset ? { dataset } : null;
  } } });
  const change = (target) => fire('change', { target });
  const submit = (id, fields) => fire('submit', { preventDefault() {}, target: { id, elements: fields } });
  return { ...context.page, document, location: context.location, elements, requests, timers, cleared, click, change, submit, content: element('#content') };
}
const settle = async () => { for (let turn = 0; turn < 14; turn++) await new Promise((resolve) => setImmediate(resolve)); };
const sent = (browser, method, route) => browser.requests.filter((request) => request.method === method && request.path === route);
const writes = (browser) => browser.requests.filter((request) => request.method !== 'GET');
const html = (browser, selector = '#content') => browser.elements[selector]?.innerHTML || '';
const count = (text, pattern) => (text.match(pattern) || []).length;

async function openView(view, respond) {
  const browser = page(respond);
  browser.storageViews.view = view;
  await browser.render();
  return browser;
}

// A Data whose trend answers come from `roots`: { '/mnt/x': options for fx.trendsData }.
function trendData(roots, overrides = {}) {
  return (request) => {
    if (request.method !== 'GET') return new Error('unexpected write');
    if (request.path === '/storage/agents') return overrides.agents || fx.sourcesBody(Object.fromEntries(Object.keys(roots).map((root) => [root.split('/').pop(), root])));
    if (request.path !== '/storage/trends') return new Error(`unexpected ${request.path}`);
    const root = request.query.get('root');
    const index = Object.entries(roots).filter(([, options]) => (options.total ?? options.count) > 0)
      .map(([name, options]) => ({ ...fx.trendsData({ root: name, ...options, count: options.total ?? options.count }).roots[0] }));
    if (!root) return overrides.index || fx.trendsIndex(index);
    if (roots[root]?.error) return new Error(roots[root].error);
    return fx.trendsData({ root, ...roots[root], folder: request.query.get('folder'), roots: index });
  };
}

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
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

// ------------------------------------------------------------------ relays

test('the relay constants are those of the Data service', () => {
  assert.deepEqual([...relays.REPORT_TYPES], [...exportStore.REPORT_TYPES]);
  assert.deepEqual([...relays.REPORT_FORMATS], [...exportStore.REPORT_FORMATS]);
  assert.deepEqual({ ...relays.REPORT_CONTENT_TYPES }, { ...exportStore.CONTENT_TYPES });
  assert.deepEqual([...relays.EVENT_SEVERITIES], [...activityLog.SEVERITIES]);
  assert.equal(relays.EVENT_MAX_PAGE, activityLog.MAX_PAGE);
  assert.equal(relays.EVENT_MAX_LIMIT, activityLog.MAX_PAGE_SIZE);
  assert.equal(relays.TREND_MAX_FOLDER_SERIES, storageTrends.MAX_FOLDER_SERIES);
  const names = [
    exportStore.newReportName('full', 'json'), exportStore.newReportName('stats', 'csv'), NAME,
    'export_full_2026-10-08_21-17-19_a1b2c3.json.part', 'export_other_2026-10-08_21-17-19_a1b2c3.json', 'export_full_2026-10-08_21-17-19_A1B2C3.json',
    '../export_full_2026-10-08_21-17-19_a1b2c3.json', 'export_full_2026-10-08_21-17-19_a1b2c3.json/', `${'x'.repeat(90)}.json`, '', 'notes.txt'
  ];
  for (const name of names) {
    assert.deepEqual(relays.parseReportName(name) && { type: relays.parseReportName(name).type, format: relays.parseReportName(name).format }, exportStore.parseReportName(name), name);
  }
  assert.equal(relays.parseReportName(42), null);
  // The page applies the same pattern before it offers a download or a delete.
  const views = fs.readFileSync(path.join(publicRoot, 'storage-views.js'), 'utf8');
  assert.ok(views.includes(`const REPORT_NAME = ${relays.REPORT_NAME};`));
});

test('the trends relay keeps bounded, allowlisted parameters only', async (t) => {
  const { app, calls, request } = await relayApp(t);
  await request(app).get(`/api/data-toolbox/storage/trends?root=/mnt/archive&folder=${encodeURIComponent('Videos/2024')}&from=2026-07-10&to=2026-10-08&limit=9999&$where=1&scan_id=x`).expect(200);
  assert.equal(calls[0].url.pathname, '/api/v1/storage/trends');
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { root: '/mnt/archive', folder: 'Videos/2024', from: '2026-07-10', to: '2026-10-08', limit: '42' });
  await request(app).get(`/api/data-toolbox/storage/trends?root=${encodeURIComponent(`/${'r'.repeat(2000)}`)}&folder=${'f'.repeat(900)}&from=${'1'.repeat(80)}&limit=-3`).expect(200);
  const bounded = calls[1].url.searchParams;
  assert.deepEqual([bounded.get('root').length, bounded.get('folder').length, bounded.get('from').length, bounded.get('limit')], [1024, 600, 40, '1']);
  await request(app).get('/api/data-toolbox/storage/trends').expect(200);
  assert.equal(calls[2].url.search, '');
  await request(app).post('/api/data-toolbox/storage/trends').send({}).expect(404);
});

test('the activity relay forwards only checked filters and never a write', async (t) => {
  const { app, calls, request } = await relayApp(t);
  await request(app).get('/api/data-toolbox/events?type=storage.&severity=warning&since=2026-10-01T00:00:00.000Z&until=1791500000000&page=3&limit=100&sort=asc&meta[$ne]=1').expect(200);
  assert.equal(calls[0].url.pathname, '/api/v1/events');
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { type: 'storage.', severity: 'warning', since: '2026-10-01T00:00:00.000Z', until: '1791500000000', page: '3', limit: '100' });
  await request(app).get('/api/data-toolbox/events?page=99999&limit=5000').expect(200);
  assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), { page: '500', limit: '200' });
  await request(app).get('/api/data-toolbox/events').expect(200);
  assert.equal(calls[2].url.search, '');
  for (const query of ['type=Storage', 'type=.*', 'type=storage%24', `type=${'a'.repeat(65)}`, 'severity=fatal', 'since=yesterday', `since=${'2'.repeat(41)}`, 'until=nope', 'page=-1', 'page=1e3', 'limit=abc']) {
    const refused = await request(app).get(`/api/data-toolbox/events?${query}`).expect(400);
    assert.equal(refused.body.code, 'INVALID_EVENT_QUERY', query);
  }
  assert.equal(calls.length, 3, 'a refused filter never reaches Data');
  // Recording an event and the event stream are not relayed.
  await request(app).post('/api/data-toolbox/events').send({ message: 'x' }).expect(404);
  await request(app).get('/api/data-toolbox/events/stream').expect(404);
  await request(app).delete('/api/data-toolbox/events').expect(404);
  assert.equal(calls.length, 3);
});

test('the report generation relay takes exactly a type and a format', async (t) => {
  let mode = 'ok';
  const started = fx.report({ type: 'stats', format: 'json', status: 'running' });
  const { app, calls, request } = await relayApp(t, async (_url, options) => {
    if (options.method !== 'POST') return null;
    if (mode === 'busy') return dataAnswer(429, { status: 'error', message: 'Two reports are already being generated; retry when one has finished' });
    if (mode === 'timeout') throw timeout();
    return dataAnswer(202, { status: 'success', message: 'Report generation started', data: started });
  });
  const post = (body) => request(app).post('/api/data-toolbox/reports').send(body);
  const answer = await post({ type: 'stats', format: 'json' }).expect(202);
  assert.equal(answer.body.data.status, 'running');
  assert.equal(calls[0].url.pathname, '/api/v1/exports/generate');
  assert.equal(calls[0].url.search, '');
  assert.deepEqual(JSON.parse(calls[0].options.body), { type: 'stats', format: 'json' });
  for (const [type, format] of [['full', 'json'], ['summary', 'csv'], ['media', 'json'], ['large', 'csv']]) await post({ type, format }).expect(202);
  const before = calls.length;
  const refused = [
    {}, { type: 'stats' }, { format: 'json' }, { type: 'full', format: 'csv' }, { type: 'everything', format: 'json' }, { type: 'stats', format: 'xlsx' },
    { type: ['stats'], format: 'json' }, { type: 'stats', format: 'json', path: '/etc' }, { type: 'stats', format: 'json', filename: NAME }, [{ type: 'stats', format: 'json' }]
  ];
  for (const body of refused) {
    const response = await post(body).expect(400);
    assert.equal(response.body.code, 'INVALID_REPORT_REQUEST', JSON.stringify(body));
  }
  assert.match((await post({ type: 'full', format: 'csv' })).body.message, /full report is available in JSON only/);
  assert.equal(calls.length, before, 'a refused request never reaches Data');
  mode = 'busy';
  assert.match((await post({ type: 'stats', format: 'json' }).expect(429)).body.message, /Two reports are already being generated/);
  mode = 'timeout';
  const late = await post({ type: 'stats', format: 'json' }).expect(502);
  assert.equal(late.body.code, 'DATA_TIMEOUT');
  assert.match(late.body.message, /may or may not have been started/);
  // Data's other spellings of the same write are not relayed.
  await request(app).post('/api/data-toolbox/reports/generate').send({ type: 'stats', format: 'json' }).expect(404);
  await request(app).post('/api/data-toolbox/exports/generate').send({}).expect(404);
  await request(app).patch(`/api/data-toolbox/reports/${NAME}`).send({}).expect(404);
});

test('delete and download accept only a report name and refuse every traversal', async (t) => {
  const { app, calls, request } = await relayApp(t, async (_url, options) => options.method === 'DELETE' ? dataAnswer(200, { status: 'success', message: 'Deleted' }) : null);
  const attempts = [
    '..%2F..%2Fetc%2Fpasswd', '%2e%2e%2fsecret.json', '..%5C..%5Cwindows', `..%2F${NAME}`, `${NAME}%2F..%2F..%2Fx`, `${NAME}%00.txt`, `${NAME}.part`,
    'export_full_2026-10-08_21-17-19_a1b2c3.exe', 'export_full_2026-10-08_21-17-19_zzzzzz.json', 'EXPORT_full_2026-10-08_21-17-19_a1b2c3.json', `${'a'.repeat(200)}.json`, 'nas_files'
  ];
  for (const name of attempts) {
    for (const response of [await request(app).delete(`/api/data-toolbox/reports/${name}`), await request(app).get(`/api/data-toolbox/reports/${name}/download`)]) {
      assert.equal(response.status, 400, name);
      assert.equal(response.body.code, 'INVALID_REPORT_NAME', name);
    }
  }
  await request(app).delete(`/api/data-toolbox/reports/${NAME}/../../x`).expect(404);
  assert.equal(calls.length, 0, 'no malformed name reaches Data');
  const deleted = await request(app).delete(`/api/data-toolbox/reports/${NAME}?force=1`).send({ all: true }).expect(200);
  assert.equal(deleted.body.message, 'Deleted');
  assert.equal(calls[0].url.pathname, `/api/v1/exports/${NAME}`);
  assert.equal(calls[0].url.search, '');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].options.body, undefined);
  await request(app).delete('/api/data-toolbox/reports').expect(404);
});

test('a delete Data refuses or does not answer is reported as such', async (t) => {
  let mode = 'running';
  const { app, request } = await relayApp(t, async () => {
    if (mode === 'timeout') throw timeout();
    return mode === 'running' ? dataAnswer(409, { status: 'error', message: 'This report is still being generated' }) : dataAnswer(404, { status: 'error', message: 'File not found' });
  });
  assert.match((await request(app).delete(`/api/data-toolbox/reports/${NAME}`).expect(409)).body.message, /still being generated/);
  mode = 'gone';
  await request(app).delete(`/api/data-toolbox/reports/${NAME}`).expect(404);
  mode = 'timeout';
  assert.match((await request(app).delete(`/api/data-toolbox/reports/${NAME}`).expect(502)).body.message, /may or may not have been deleted/);
});

// A real listener: supertest would hide whether the body is streamed.
async function listening(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the download is streamed from Data with its headers, not held in memory', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = Buffer.alloc(64 * 1024, 'a');
  const rest = Buffer.alloc(200 * 1024, 'b');
  let step = 0;
  const { app, calls } = await relayApp(t, async (url) => {
    assert.equal(url.pathname, `/api/v1/exports/${NAME}/download`);
    const body = new ReadableStream({
      async pull(controller) {
        step += 1;
        if (step === 1) return controller.enqueue(first);
        await held;
        controller.enqueue(rest);
        return controller.close();
      }
    });
    return new Response(body, { status: 200, headers: {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': String(first.length + rest.length),
      'Content-Disposition': `attachment; filename="${NAME}"`, 'Set-Cookie': 'session=1', 'X-Internal': 'data'
    } });
  });
  const base = await listening(t, app);
  const received = await new Promise((resolve, reject) => {
    http.get(`${base}/api/data-toolbox/reports/${NAME}/download`, (response) => {
      const seen = { status: response.statusCode, headers: response.headers, bytes: 0, bytesBeforeRelease: null };
      response.on('data', (chunk) => {
        seen.bytes += chunk.length;
        // The first part reaches the browser while Data still holds the rest.
        if (seen.bytesBeforeRelease === null) { seen.bytesBeforeRelease = seen.bytes; release(); }
      });
      response.on('end', () => resolve(seen));
      response.on('error', reject);
    }).on('error', reject);
  });
  assert.equal(received.status, 200);
  assert.ok(received.bytesBeforeRelease > 0 && received.bytesBeforeRelease <= first.length);
  assert.equal(received.bytes, first.length + rest.length);
  assert.equal(received.headers['content-type'], 'text/csv; charset=utf-8');
  assert.equal(received.headers['content-length'], String(first.length + rest.length));
  assert.equal(received.headers['content-disposition'], `attachment; filename="${NAME}"`);
  assert.equal(received.headers['x-content-type-options'], 'nosniff');
  assert.equal(received.headers['cache-control'], 'no-store');
  assert.equal(received.headers['set-cookie'], undefined, 'only the file headers pass through');
  assert.equal(received.headers['x-internal'], undefined);
  assert.equal(calls[0].options.method, undefined);
  assert.ok(calls[0].options.signal, 'the read from Data can be ended');
  // The streaming path is its own: the JSON helper reads a whole body as text.
  const relaySource = fs.readFileSync(path.resolve(__dirname, '..', 'reports-trends-activity.js'), 'utf8');
  assert.match(relaySource, /pipeline\(Readable\.fromWeb\(response\.body\), res\)/);
  assert.doesNotMatch(relaySource, /arrayBuffer\(|\.text\(\)|\.blob\(/);
  assert.equal(relays.DOWNLOAD_TIMEOUT_MS, 15 * 60 * 1000);
});

test('a browser that leaves a download ends the read from Data', async (t) => {
  let cancelled;
  const done = new Promise((resolve) => { cancelled = resolve; });
  const { app } = await relayApp(t, async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(Buffer.alloc(64 * 1024, 'c')); return new Promise((resolve) => setTimeout(resolve, 5)); },
    cancel() { cancelled(true); }
  }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  const base = await listening(t, app);
  await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/data-toolbox/reports/${fx.reportName('full', 'json')}/download`, (response) => {
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(response.headers['content-length'], undefined);
      response.once('data', () => { request.destroy(); resolve(); });
    });
    request.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  assert.equal(await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve(false), 3000))]), true);
});

test('a download Data refuses, or cannot serve, answers a small JSON error', async (t) => {
  let mode = 'missing';
  const { app, request } = await relayApp(t, async () => {
    if (mode === 'timeout') throw timeout();
    if (mode === 'down') throw new Error('connect ECONNREFUSED');
    if (mode === 'html') return new Response('<html>oops</html>', { status: 500, headers: { 'Content-Type': 'text/html' } });
    return new Response(JSON.stringify({ status: 'error', message: 'File not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
  const route = `/api/data-toolbox/reports/${NAME}/download`;
  const missing = await request(app).get(route).expect(404);
  assert.deepEqual([missing.body.code, missing.body.message], ['REPORT_UNAVAILABLE', 'File not found']);
  assert.equal(missing.headers['content-disposition'], undefined);
  mode = 'html';
  assert.equal((await request(app).get(route).expect(500)).body.message, 'Data answered 500 for this report');
  mode = 'timeout';
  assert.equal((await request(app).get(route).expect(502)).body.code, 'DATA_TIMEOUT');
  mode = 'down';
  assert.equal((await request(app).get(route).expect(502)).body.code, 'DATA_UNAVAILABLE');
});

// ------------------------------------------------------------------ page wiring

test('the page loads the three scripts before app.js and names the Activity tab after Overview', () => {
  const index = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  for (const file of ['storage-trends.js', 'storage-views.js', 'activity.js']) {
    assert.ok(index.indexOf(`/assets/data-toolbox/${file}`) > 0, file);
    assert.ok(index.indexOf(`/assets/data-toolbox/${file}`) < index.indexOf('/assets/data-toolbox/app.js'), file);
    const source = fs.readFileSync(path.join(publicRoot, file), 'utf8');
    assert.doesNotMatch(source, /alert\(|confirm\(|prompt\(|insertAdjacentHTML|document\.write|eval\(/, file);
    assert.ok(source.split('\n').length < 1200, `${file} stays under the frontend file limit`);
  }
  assert.match(index, /reports-trends-activity\.css/);
  assert.match(index, /<a href="#overview" data-tab="overview">Overview<\/a>\s*<a href="#activity" data-tab="activity">Activity<\/a>\s*<a href="#storage"/);
  assert.ok(fs.readFileSync(path.resolve(__dirname, '..', 'reports-trends-activity.js'), 'utf8').split('\n').length < 700);
  assert.ok(fs.readFileSync(path.resolve(__dirname, '..', 'index.js'), 'utf8').split('\n').length <= 701);
});

test('the Storage tab opens on the inventory and switches to Growth and Reports', async () => {
  const browser = page((request) => {
    if (request.path === '/storage/summary') return { totalFiles: 2718, totalSize: 25224388748 };
    if (request.path === '/storage/agents') return fx.sourcesBody();
    if (request.path === '/storage/scans') return { scans: [] };
    if (request.path === '/storage/trends') return fx.trendsIndex([]);
    if (request.path === '/reports') return fx.reportsBody([]);
    return new Error(`unexpected ${request.path}`);
  });
  await browser.render();
  assert.match(html(browser), /data-storage-view="scans" aria-pressed="true">Inventory and scans/);
  assert.match(html(browser), /files inventoried/);
  assert.equal(sent(browser, 'GET', '/reports').length + sent(browser, 'GET', '/storage/trends').length, 0, 'the other views are read only when opened');
  await browser.click({ storageView: 'reports' });
  assert.match(html(browser), /data-storage-view="reports" aria-pressed="true">Reports/);
  assert.match(html(browser), /No report yet\. Generate one above\./);
  assert.doesNotMatch(html(browser), /files inventoried/);
  await browser.click({ storageView: 'growth' });
  assert.match(html(browser), /data-storage-view="growth" aria-pressed="true">Growth/);
  assert.match(html(browser), /id="trendWindow"/);
  await browser.click({ storageView: 'nonsense' });
  assert.equal(browser.storageViews.view, 'growth');
  assert.equal(writes(browser).length, 0);
});

// ------------------------------------------------------------------ growth

test('a long series draws one labelled chart per measure, with its table, growth and folders', async () => {
  const browser = await openView('growth', trendData({ '/mnt/archive': { count: 365 } }));
  const view = html(browser);
  assert.match(view, /<h3 class="mono">\/mnt\/archive<\/h3>/);
  // Two measures, two charts, each drawn for a wide and for a narrow screen.
  assert.equal(count(view, /<svg class="trend-svg wide size"/g), 1);
  assert.equal(count(view, /<svg class="trend-svg narrow size"/g), 1);
  assert.equal(count(view, /<svg class="trend-svg wide files"/g), 1);
  assert.match(view, /role="img" aria-label="Total size: 365 points from 2025-10-09 to 2026-10-08\. First 4\.00 TiB, last 4\.5\d TiB, lowest 4\.00 TiB, highest 4\.5\d TiB\."/);
  assert.match(view, /aria-label="Number of files: 365 points from 2025-10-09 to 2026-10-08\. First 220,000 files, last 233,7\d\d files/);
  assert.match(view, /<strong>Total size<\/strong><span class="muted">First 4\.00 TiB on 2025-10-09 → last 4\.5\d TiB on 2026-10-08 · 365 points<\/span>/);
  // Axes: values with their unit, months with their year over a year.
  assert.match(view, /text-anchor="end">4\.0 TiB<\/text>/);
  assert.match(view, /text-anchor="end">4\.6 TiB<\/text>/);
  assert.match(view, /text-anchor="start">Oct 2025<\/text>/);
  assert.match(view, /text-anchor="end">Oct 2026<\/text>/);
  assert.match(view, /text-anchor="end">220,000<\/text>/);
  assert.match(view, /The vertical axis starts at 4\.0 TiB, not at zero, so that the change stays visible\. Days are UTC days\./);
  assert.match(view, /The vertical axis starts at 220,000 files, not at zero/);
  assert.match(view, /<rect [^>]*><title>2026-10-08: 4\.5\d TiB<\/title><\/rect>/);
  // The same figures as text.
  assert.match(view, /<summary>The two charts as a table \(365 snapshots\)<\/summary>/);
  assert.match(view, /<tr><td>2026-10-08<\/td><td>4\.5\d TiB<\/td><td>233,7\d\d<\/td>/);
  assert.match(view, /Growth of the root, 2025-10-09 to 2026-10-08 \(364 days\)/);
  assert.match(view, /<span>Size added<\/span><strong>\+5\d\d\.\d\d GiB<\/strong>/);
  assert.match(view, /<span>Files added<\/span><strong>\+13,7\d\d<\/strong>/);
  assert.match(view, /<span>Per day, on average<\/span><strong>\+1\.5\d GiB · \+37\.\d files<\/strong>/);
  assert.match(view, /<ol class="trend-grown"><li><strong>Videos<\/strong> <span>\+3\d\d\.\d\d GiB<\/span>/);
  // The newest snapshot by folder, with the summed entries named in plain words.
  assert.match(view, /<h4>Size by folder on 2026-10-08<\/h4>/);
  assert.match(view, /<th scope="row" class="row-head ">Videos<\/th>\s*<td>2\.5\d TiB<span class="trend-bar" aria-hidden="true"><span style="width:100\.0%">/);
  assert.match(view, /<td>56\.0%<\/td>/);
  assert.match(view, /<th scope="row" class="row-head muted">Files directly in the root<\/th>/);
  assert.equal(count(view, /data-trend-folder="[A-Za-z]+">Open<\/button>/g), 4);
  // The collector's own counter is a separate, labelled chart.
  assert.match(view, /<h4>Another measure: files walked by the collector<\/h4>/);
  assert.match(view, /It is not the number of files in the index and it has no size, so it is drawn apart/);
  assert.equal(count(view, /<svg class="trend-svg wide walked"/g), 1);
  assert.ok(view.indexOf('trend-svg wide walked') > view.indexOf('Size by folder on'), 'never among the totals');
  assert.equal(writes(browser).length, 0);
});

test('one snapshot shows the current state and says when the next point comes; none says why', async () => {
  const browser = await openView('growth', trendData({ '/mnt/archive': { count: 1 }, '/mnt/photos': { count: 0, walked: 1 }, '/mnt/cold': { count: 0, total: 30, walked: 0 } }));
  const view = html(browser);
  const [archive, cold, photos] = [view.indexOf('/mnt/archive</h3>'), view.indexOf('/mnt/cold</h3>'), view.indexOf('/mnt/photos</h3>')];
  assert.ok(archive > 0 && archive < cold && cold < photos, 'one block per root, in a stable order');
  const one = view.slice(archive, cold);
  assert.match(one, /<strong>One snapshot so far\.<\/strong> A trend needs two points: the next one is recorded when the next scan of this root ends complete, at most one per day/);
  assert.match(one, /4\.00 TiB<\/strong><span class="metric-label">size on 2026-10-08/);
  assert.match(one, /1<\/strong><span class="metric-label">snapshot in this window/);
  assert.match(one, /Size by folder on 2026-10-08/);
  assert.doesNotMatch(one, /trend-svg wide size|Growth of the root|as a table \(1 snapshots/);
  const outside = view.slice(cold, photos);
  assert.match(outside, /No snapshot between 2026-07-10 and 2026-10-08\. Data holds 30 for this root, from 2026-09-09 to 2026-10-08: choose a longer window\./);
  const none = view.slice(photos);
  assert.match(none, /No snapshot yet\. Data records the first one when the next scan of this root ends complete; a scan that ends partial, failed or stopped records nothing\./);
  assert.match(none, /One scan in this window: 219,500 files walked on 2026-10-08\./);
  assert.doesNotMatch(none, /<svg/);
});

test('two snapshots a day apart keep a readable scale', async () => {
  const browser = await openView('growth', trendData({ '/mnt/archive': { count: 2 } }));
  const view = html(browser);
  assert.match(view, /aria-label="Total size: 2 points from 2026-10-07 to 2026-10-08\./);
  assert.match(view, /text-anchor="start">7 Oct<\/text>/);
  assert.match(view, /text-anchor="end">8 Oct<\/text>/);
  assert.equal(count(view.slice(view.indexOf('trend-svg wide size'), view.indexOf('trend-svg narrow size')), /<text [^>]*text-anchor="(start|middle|end)">\d+ Oct<\/text>/g), 2, 'no repeated day label');
  assert.match(view, /Growth of the root, 2026-10-07 to 2026-10-08 \(1 days\)/);
  // Scales: a flat series, a tiny one and one from zero all get distinct round ticks.
  for (const [values, kind] of [[[5, 5, 5], 'count'], [[4398046511104, 4398046511104], 'bytes'], [[0, 3], 'count'], [[10, 4000000], 'count'], [[1, 2 ** 50], 'bytes'], [[47830, 47830, 50531], 'count']]) {
    const axis = browser.trendAxis(values, kind);
    const texts = axis.ticks.map((tick) => tick.text);
    assert.ok(axis.ticks.length >= 2 && axis.ticks.length <= 8, `${values}: ${texts}`);
    assert.equal(new Set(texts).size, texts.length, `distinct labels for ${values}: ${texts}`);
    assert.ok(axis.lo <= Math.min(...values) && axis.hi >= Math.max(...values) && axis.hi > axis.lo && axis.lo >= 0, `${values} within ${axis.lo}..${axis.hi}`);
  }
  assert.equal(browser.trendAxis([10, 4000000], 'count').fromZero, true);
  assert.equal(browser.trendFigure('Only one', [{ day: '2026-10-08', value: 3 }], 'count'), '');
  assert.equal(browser.trendFigure('Same day', [{ day: '2026-10-08', value: 3 }, { day: '2026-10-08', value: 4 }], 'count'), '');
});

test('the window selector reads each root again with its dates, and a failed root keeps to itself', async () => {
  const browser = await openView('growth', trendData({ '/mnt/archive': { count: 30 }, '/mnt/photos': { error: 'Data service request timed out' } }));
  assert.match(html(browser), /The trend of this root could not be read from Data: Data service request timed out\. The other roots do not depend on it\./);
  assert.match(html(browser), /trend-svg wide size/);
  assert.match(html(browser), /<option value="90" selected>Last 90 days<\/option>/);
  const day = (offset) => new Date(Date.parse(new Date().toISOString().slice(0, 10)) - offset * fx.DAY_MS).toISOString().slice(0, 10);
  const first = sent(browser, 'GET', '/storage/trends').filter((request) => request.query.get('root') === '/mnt/archive').at(-1);
  assert.deepEqual(Object.fromEntries(first.query), { root: '/mnt/archive', from: day(90), to: day(0), limit: '42' });
  for (const [key, offset] of [['30', 30], ['365', 365], ['all', 799]]) {
    await browser.change({ id: 'trendWindow', value: key });
    const read = sent(browser, 'GET', '/storage/trends').filter((request) => request.query.get('root') === '/mnt/archive').at(-1);
    assert.deepEqual([read.query.get('from'), read.query.get('to')], [day(offset), day(0)], key);
    assert.match(html(browser, '#trendBlocks'), /trend-svg wide size/);
  }
  const before = browser.requests.length;
  await browser.change({ id: 'trendWindow', value: '7' });
  assert.equal(browser.requests.length, before, 'an unknown window asks nothing');
});

test('a folder opens on its own series and its subfolders, when Data has them', async () => {
  const browser = await openView('growth', trendData({ '/mnt/archive': { count: 40 }, '/mnt/photos': { count: 40, withOther: true, tops: [...fx.TOP_FOLDERS, ['Scans', 0.01], ['Exports', 0.005]] } }));
  await browser.click({ trendRoot: '0', trendFolder: 'Videos' });
  const read = sent(browser, 'GET', '/storage/trends').at(-1);
  assert.deepEqual([read.query.get('root'), read.query.get('folder'), read.query.get('limit')], ['/mnt/archive', 'Videos', '42']);
  const view = html(browser, '#trendBlocks');
  assert.match(view, /<h4>Inside a folder<\/h4>/);
  assert.match(view, /data-trend-root="0" data-trend-folder="">All folders of this root<\/button><span class="muted">\/<\/span><strong>Videos<\/strong>/);
  assert.match(view, /aria-label="Size of Videos: 40 points/);
  assert.match(view, /Growth of Videos, /);
  assert.match(view, /<th scope="row" class="row-head ">2024<\/th>/);
  assert.match(view, /<th scope="row" class="row-head muted">Other folders of Videos, together<\/th>/);
  assert.match(view, /<th scope="row" class="row-head muted">Files directly in Videos<\/th>/);
  assert.match(view, /title="Share of this folder">Share<\/th>/);
  assert.doesNotMatch(view.slice(view.indexOf('Inside a folder'), view.indexOf('/mnt/photos</h3>')), /data-trend-folder="Videos\//, 'a second level cannot be opened further');
  await browser.click({ trendRoot: '0', trendFolder: '' });
  assert.match(html(browser, '#trendBlocks'), /<h4>Size by folder on 2026-10-08<\/h4>/);
  // More than five top-level folders: Data keeps no second level, so none is offered.
  const photos = html(browser, '#trendBlocks').slice(html(browser, '#trendBlocks').indexOf('/mnt/photos</h3>'));
  assert.doesNotMatch(photos, /data-trend-folder="[A-Z]/);
  assert.match(photos, /This root has more than 5 top-level folders: Data keeps their totals only, so a folder cannot be opened here\./);
  assert.match(photos, /<th scope="row" class="row-head muted">Other folders, together<\/th>/);
});

test('a folder Data cannot read, or has no subfolders for, says so', async () => {
  let mode = 'error';
  const base = trendData({ '/mnt/archive': { count: 10 } });
  const browser = await openView('growth', (request) => {
    if (!request.query.get('folder')) return base(request);
    if (mode === 'error') return Object.assign(new Error('folder must be a folder key of at most 600 characters'), { status: 400 });
    const answer = fx.trendsData({ root: '/mnt/archive', count: 10, folder: 'Music' });
    return mode === 'leaf' ? { ...answer, folders: answer.folders.slice(0, 1) } : { ...answer, folders: [] };
  });
  await browser.click({ trendRoot: '0', trendFolder: 'Music' });
  assert.match(html(browser, '#trendBlocks'), /This folder could not be read from Data: folder must be a folder key/);
  mode = 'leaf';
  await browser.click({ trendRoot: '0', trendFolder: 'Music' });
  assert.match(html(browser, '#trendBlocks'), /Data has no figures for the subfolders of this folder/);
  mode = 'gone';
  await browser.click({ trendRoot: '0', trendFolder: 'Music' });
  assert.match(html(browser, '#trendBlocks'), /This folder is not in the snapshots of this window\./);
});

test('hostile folder and root names are shown as text everywhere', async () => {
  const roots = { [`/mnt/${fx.HOSTILE}`]: { count: 20, tops: [[fx.HOSTILE, 0.6], ['Photos', 0.2]] } };
  const browser = await openView('growth', trendData(roots, { agents: fx.sourcesBody({ evil: `/mnt/${fx.HOSTILE}` }) }));
  await browser.click({ trendRoot: '0', trendFolder: fx.HOSTILE });
  const view = html(browser, '#trendBlocks');
  assert.doesNotMatch(html(browser) + view, /<script>alert/);
  assert.match(view, new RegExp(`<h3 class="mono">/mnt/${fx.HOSTILE_ESCAPED.replace(/[()/]/g, '\\$&')}</h3>`));
  assert.ok(view.includes(`<strong>${fx.HOSTILE_ESCAPED}</strong>`), 'in the breadcrumb');
  assert.ok(view.includes(`aria-label="Size of ${fx.HOSTILE_ESCAPED}: 20 points`), 'in the chart description');
  assert.ok(view.includes(`Growth of ${fx.HOSTILE_ESCAPED},`));
  assert.ok(view.includes(`Other folders of ${fx.HOSTILE_ESCAPED}, together`));
  await browser.click({ trendRoot: '0', trendFolder: '' });
  const top = html(browser, '#trendBlocks');
  assert.ok(top.includes(`<th scope="row" class="row-head ">${fx.HOSTILE_ESCAPED}</th>`));
  assert.ok(top.includes(`data-trend-folder="${fx.HOSTILE_ESCAPED}">Open</button>`));
  assert.ok(top.includes(`<li><strong>${fx.HOSTILE_ESCAPED}</strong>`), 'among the folders that grew');
  assert.doesNotMatch(top, /<script>alert/);
});

test('without any root, or without Data, the Growth view says so', async () => {
  const empty = await openView('growth', trendData({}, { agents: { scanners: [], sources: {} } }));
  assert.match(html(empty), /Data knows no storage root yet: no source is configured and no snapshot was recorded\./);
  const down = await openView('growth', (request) => request.path === '/storage/agents' ? fx.sourcesBody() : new Error('connect ECONNREFUSED'));
  assert.match(html(down), /The storage trends could not be read from Data: connect ECONNREFUSED\./);
  assert.equal(sent(down, 'GET', '/storage/trends').length, 1, 'no per-root read after a failed first read');
});

// ------------------------------------------------------------------ reports

// A Data whose report store is `store.reports`; writes follow Data's contract.
function reportData(store) {
  return (request) => {
    if (request.path === '/reports' && request.method === 'GET') return store.listError || fx.reportsBody(store.reports);
    if (request.path === '/reports' && request.method === 'POST') return store.post(request.body);
    if (request.method === 'DELETE' && request.path.startsWith('/reports/')) return store.remove(decodeURIComponent(request.path.split('/').pop()));
    return new Error(`unexpected ${request.method} ${request.path}`);
  };
}
const form = (type, format) => ({ type: { value: type }, format: { value: format, options: [{ value: 'csv', disabled: false }, { value: 'json', disabled: false }] } });

test('the Reports view lists every report with its state, the limits and the usage', async () => {
  const reports = [
    fx.report({ type: 'full', format: 'json', status: 'running' }),
    fx.report({ filename: fx.reportName('summary', 'csv', 'bbbbbb') }),
    fx.report({ type: 'stats', format: 'json', size: 73400320, recordCount: null, skippedCount: 3, filename: fx.reportName('stats', 'json', 'cccccc') }),
    fx.report({ type: 'media', format: 'csv', status: 'failed', error: `ENOSPC ${fx.HOSTILE}`, filename: fx.reportName('media', 'csv', 'dddddd') }),
    fx.report({ filename: `../${fx.HOSTILE}.csv`, type: null })
  ];
  const browser = await openView('reports', reportData({ reports }));
  const view = html(browser);
  assert.match(view, /<h3>Reports kept<\/h3><strong class="metric">3 <span class="muted">of 20<\/span>/);
  assert.match(view, /<h3>Space used<\/h3><strong class="metric">74\.9 MiB <span class="muted">of 1\.0 GiB<\/span>/);
  assert.match(view, /<span class="usage-bar" aria-hidden="true"><span style="width:15\.0%">/);
  assert.match(view, /Data removes the oldest ones, never the new one\./);
  assert.match(view, /<th scope="row" class="row-head">Full inventory<br><span class="muted mono">export_full_2026-10-08_21-17-19_a1b2c3\.json<\/span>/);
  assert.match(view, /<span class="pill warn">running<\/span>/);
  assert.match(view, /Being generated: it cannot be deleted until it ends\./);
  assert.match(view, /<span class="pill good">ready<\/span><\/td>\s*<td data-label="Size">2\.4 MiB<\/td>\s*<td data-label="Records">271,830<\/td>/);
  assert.match(view, /<td data-label="Records">—<span class="warn">· 3 skipped<\/span>|<td data-label="Records">— <span class="warn">· 3 skipped<\/span>/);
  assert.match(view, new RegExp(`<a class="button" href="/api/data-toolbox/reports/${fx.reportName('summary', 'csv', 'bbbbbb').replace(/\./g, '\\.')}/download" download=`));
  assert.equal(count(view, />Download<\/a>/g), 2, 'only ready reports with a valid name can be downloaded');
  assert.match(view, /<span class="pill bad">failed<\/span><br><span class="bad">ENOSPC &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/);
  assert.match(view, />Remove from list<\/button>/);
  // A name the exporter would not create gets no action and no link.
  assert.doesNotMatch(view, /<script>alert/);
  assert.doesNotMatch(view, /href="[^"]*\.\.%2F/);
  assert.ok(view.includes(`<span class="muted mono">../${fx.HOSTILE_ESCAPED}.csv</span>`));
  assert.equal(count(view, /data-report-ask=/g), 3);
  assert.equal(browser.timers.filter((timer) => timer.ms === 3000).length, 1, 'a running generation is followed');
  assert.equal(writes(browser).length, 0, 'opening the view writes nothing');
});

test('the Reports view has an empty state and an error state', async () => {
  const empty = await openView('reports', reportData({ reports: [] }));
  assert.match(html(empty), /No report yet\. Generate one above\./);
  assert.match(html(empty), /<strong class="metric">0 <span class="muted">of 20<\/span>/);
  assert.equal(empty.timers.length, 0, 'nothing to follow');
  const down = await openView('reports', reportData({ listError: new Error('Data service request timed out') }));
  assert.match(html(down), /The reports could not be read from Data: Data service request timed out\./);
  assert.match(html(down), /id="reportForm"/);
});

test('generating follows the report from running to ready', async () => {
  const name = fx.reportName('stats', 'json', 'eeeeee');
  const store = { reports: [fx.report({ filename: fx.reportName('summary', 'csv', 'bbbbbb') })] };
  store.post = (body) => {
    const started = fx.report({ ...body, status: 'running', filename: name });
    store.reports.unshift(started);
    return started;
  };
  const browser = await openView('reports', reportData(store));
  // A full report in CSV is refused on the page, in words, without a request.
  await browser.submit('reportForm', form('full', 'csv'));
  assert.match(html(browser, '#reportOutcome'), /Not started: a full report exists in JSON only\./);
  await browser.submit('reportForm', form('everything', 'json'));
  assert.match(html(browser, '#reportOutcome'), /Not started: choose a report and a format from the lists\./);
  assert.equal(writes(browser).length, 0);
  // Choosing the full report moves the format to JSON and closes CSV.
  const fields = form('full', 'csv');
  await browser.change({ form: { id: 'reportForm', elements: fields } });
  assert.deepEqual([fields.format.value, fields.format.options[0].disabled, { ...browser.reportState.draft }], ['json', true, { type: 'full', format: 'json' }]);
  assert.match(html(browser, '#reportTypeHelp'), /Full inventory: every indexed file .* JSON only\./);

  await browser.submit('reportForm', form('stats', 'json'));
  assert.deepEqual(JSON.parse(JSON.stringify(writes(browser))), [{ path: '/reports', query: {}, method: 'POST', body: { type: 'stats', format: 'json' } }]);
  assert.ok(html(browser, '#reportOutcome').includes(`Generation of ${name} started. The list is read again every 3 s until it is ready or has failed.`));
  assert.match(html(browser, '#reportList'), /<span class="pill warn">running<\/span>/);
  assert.equal(browser.timers.length, 1);
  await browser.timers[0].callback();
  assert.match(html(browser, '#reportOutcome'), /started/);
  Object.assign(store.reports[0], { status: 'ready', size: 1048576, recordCount: 2718, skippedCount: 0, createdAt: '2026-10-08T21:20:00.000Z' });
  await browser.timers[0].callback();
  assert.ok(html(browser, '#reportOutcome').includes(`${name} is ready: 1.0 MiB, 2,718 records. It can be downloaded below.`));
  assert.match(html(browser, '#reportOutcome'), /class="notice success"/);
  assert.equal(count(html(browser, '#reportList'), />Download<\/a>/g), 2);
  // Nothing is left to follow: the next tick stops the timer.
  const reads = sent(browser, 'GET', '/reports').length;
  await browser.timers[0].callback();
  assert.deepEqual([browser.cleared.length, browser.reportState.timer, sent(browser, 'GET', '/reports').length], [1, null, reads]);
  assert.equal(writes(browser).length, 1);
});

test('generating reports a failure, a refusal, and a generation Data forgot', async () => {
  const name = fx.reportName('full', 'json', 'ffffff');
  const store = { reports: [] };
  store.post = () => { const started = fx.report({ type: 'full', format: 'json', status: 'running', filename: name }); store.reports = [started]; return started; };
  const browser = await openView('reports', reportData(store));
  await browser.submit('reportForm', form('full', 'json'));
  store.reports = [{ ...store.reports[0], status: 'failed', error: `ENOSPC: no space left ${fx.HOSTILE}` }];
  await browser.timers[0].callback();
  assert.ok(html(browser, '#reportOutcome').includes(`${name} failed: ENOSPC: no space left ${fx.HOSTILE_ESCAPED} No file was kept.`));
  assert.match(html(browser, '#reportOutcome'), /class="notice warning"/);
  assert.match(html(browser, '#reportList'), /<span class="pill bad">failed<\/span>/);

  await browser.submit('reportForm', form('full', 'json'));
  store.reports = [];
  await browser.timers.at(-1).callback();
  assert.ok(html(browser, '#reportOutcome').includes(`${name} is no longer listed by Data. A restart of Data ends a running generation and forgets it: generate it again.`));

  store.post = () => Object.assign(new Error('Two reports are already being generated; retry when one has finished'), { status: 429 });
  await browser.submit('reportForm', form('stats', 'csv'));
  assert.match(html(browser, '#reportOutcome'), /Not started: Two reports are already being generated; retry when one has finished/);
  store.post = () => ({ status: 'running' });
  await browser.submit('reportForm', form('stats', 'csv'));
  assert.match(html(browser, '#reportOutcome'), /Not started: Data accepted the request without naming a report\./);
  assert.equal(browser.reportState.started.size, 0);
});

test('deleting asks on the row first, and Keep sends nothing', async () => {
  const kept = fx.reportName('summary', 'csv', 'bbbbbb');
  const failed = fx.reportName('media', 'csv', 'dddddd');
  const store = { reports: [fx.report({ filename: kept }), fx.report({ type: 'media', status: 'failed', error: 'cursor closed', filename: failed })] };
  store.remove = (name) => {
    if (store.removeError) return store.removeError;
    store.reports = store.reports.filter((report) => report.filename !== name);
    return { status: 'success', message: 'Deleted' };
  };
  const browser = await openView('reports', reportData(store));
  // A delete that was not asked for on the row is ignored.
  await browser.click({ reportDelete: kept });
  assert.equal(writes(browser).length, 0);
  await browser.click({ reportAsk: kept });
  assert.match(html(browser, '#reportList'), /Delete this report from Data\? It cannot be recovered\.<\/span>\s*<button type="button" class="button danger" data-report-delete="[^"]+">Delete<\/button>\s*<button type="button" class="button" data-report-keep="[^"]+">Keep<\/button>/);
  await browser.click({ reportKeep: kept });
  assert.doesNotMatch(html(browser, '#reportList'), /It cannot be recovered/);
  await browser.click({ reportDelete: kept });
  assert.equal(writes(browser).length, 0, 'Keep withdrew the question');

  await browser.click({ reportAsk: kept });
  await browser.click({ reportDelete: kept });
  assert.deepEqual(JSON.parse(JSON.stringify(writes(browser).map(({ path: route, method, body }) => ({ route, method, body })))), [{ route: `/reports/${kept}`, method: 'DELETE' }]);
  assert.ok(html(browser, '#reportOutcome').includes(`${kept} was deleted.`));
  assert.ok(!html(browser, '#reportList').includes(kept));

  await browser.click({ reportAsk: failed });
  assert.match(html(browser, '#reportList'), /Remove this failed generation from the list\?<\/span>\s*<button type="button" class="button danger" data-report-delete="[^"]+">Remove<\/button>/);
  store.removeError = Object.assign(new Error('This report is still being generated'), { status: 409 });
  await browser.click({ reportDelete: failed });
  assert.match(html(browser, '#reportOutcome'), /Not deleted: This report is still being generated/);
  assert.ok(html(browser, '#reportList').includes(failed), 'the list is read again and still shows it');
  // A name outside the exporter's pattern is never sent.
  browser.reportState.confirm = '../secret.json';
  await browser.click({ reportDelete: '../secret.json' });
  assert.equal(writes(browser).length, 2);
});

test('the report poll runs only on a visible Reports view and never writes into another tab', async () => {
  const store = { reports: [fx.report({ type: 'full', format: 'json', status: 'running' })] };
  const browser = await openView('reports', reportData(store));
  const reads = () => sent(browser, 'GET', '/reports').length;
  const tick = browser.timers[0].callback;
  browser.document.hidden = true;
  await tick();
  assert.equal(reads(), 1, 'a hidden page asks nothing');
  browser.document.hidden = false;
  store.listError = new Error('Data service request timed out');
  await tick();
  assert.match(html(browser, '#reportOutcome'), /The reports could not be read from Data: Data service request timed out\. The list below is the last one read\./);
  assert.match(html(browser, '#reportList'), /running/, 'the last list stays');
  delete store.listError;
  // Leaving for another view: the answer in flight is dropped, the timer stops.
  const before = html(browser, '#reportList');
  const pending = tick();
  browser.storageViews.view = 'scans';
  browser.state.renderSeq += 1;
  store.reports = [];
  await pending;
  assert.equal(html(browser, '#reportList'), before);
  await tick();
  assert.deepEqual([browser.cleared.length, browser.reportState.timer], [1, null]);
});

// ------------------------------------------------------------------ activity

// A Data whose activity log is `store.events`.
function activityData(store) {
  return (request) => {
    if (request.method !== 'GET') return new Error('unexpected write');
    if (request.path === '/events') return store.error || fx.eventsAnswer(store.events, request.query);
    if (request.path === '/status') return { dataService: { healthy: 7, total: 7 }, sources: Object.fromEntries(['health', 'resources', 'storage', 'network', 'liveData', 'databases', 'janitor'].map((key) => [key, { ok: true, status: 200, data: {} }])) };
    return new Error(`unexpected ${request.path}`);
  };
}
const filters = (family = '', severity = '', windowKey = 'all') => ({ form: { id: 'activityFilters', elements: { family: { value: family }, severity: { value: severity }, windowKey: { value: windowKey } } } });
const listRead = (browser) => sent(browser, 'GET', '/events').filter((request) => request.query.get('limit') === '50').at(-1);
async function openActivity(store) {
  const browser = page(activityData(store), '#activity');
  await browser.render();
  return browser;
}

test('the Activity tab lists events newest first under a summary of the last 24 hours', async () => {
  const store = { events: [...fx.eventLog(8, Date.now() - 60000), ...fx.eventLog(8, Date.now() - 3 * fx.DAY_MS)] };
  const browser = await openActivity(store);
  const view = html(browser);
  // Last 24 hours: one count per severity, read apart from the list filters.
  const summary = sent(browser, 'GET', '/events').filter((request) => request.query.get('limit') === '1');
  assert.deepEqual(summary.map((request) => request.query.get('severity')).sort(), ['error', 'info', 'warning']);
  for (const request of summary) assert.ok(Math.abs(Date.now() - 24 * 3600000 - new Date(request.query.get('since')).getTime()) < 5000);
  assert.match(view, /<strong class="metric">1<\/strong><span class="metric-label"><span class="pill bad">error<\/span> in the last 24 hours/);
  assert.match(view, /<strong class="metric">3<\/strong><span class="metric-label"><span class="pill warn">warning<\/span> in the last 24 hours/);
  assert.match(view, /<strong class="metric">4<\/strong><span class="metric-label"><span class="pill ">info<\/span> in the last 24 hours/);
  assert.match(view, /Most recent warning or error: <span class="pill warn">warning<\/span> .* — Collector nas-storage has not reported for 5 minutes\. <span class="muted mono">collector\.silent<\/span>/);
  // The list: time, severity in words, type, sentence, details.
  assert.deepEqual(Object.fromEntries(listRead(browser).query), { page: '1', limit: '50' });
  assert.equal(count(view, /<tr class="">/g), 16);
  const list = view.slice(view.indexOf('id="activityList"'));
  assert.ok(list.indexOf('Storage scan of archive finished: complete.') < list.indexOf('Collector nas-storage has not reported'), 'newest first');
  assert.match(view, /<td><span class="pill bad">error<\/span><\/td>\s*<td class="mono">storage\.scan_expired<\/td>\s*<td>Storage scan of photos expired: no collector heartbeat for 10 minutes\.<\/td>/);
  assert.match(view, /<summary>5 details<\/summary>\s*<dl class="activity-meta"><dt class="mono">outcome<\/dt><dd>complete<\/dd><dt class="mono">source<\/dt><dd>archive<\/dd><dt class="mono">counts\.files_seen<\/dt><dd>221299<\/dd><dt class="mono">counts\.errors<\/dt><dd>0<\/dd><dt class="mono">roots<\/dt><dd>\/mnt\/archive<\/dd><\/dl>/);
  assert.match(view, /<td>MQTT monitor connected again\.<\/td>\s*<td><span class="muted">—<\/span><\/td>/, 'an event without details shows a dash');
  assert.match(view, /16 events match · new events are read every 15 s while this tab is open and visible/);
  assert.match(view, /<div id="activityPager" class="pager"><\/div>/, 'one page needs no pager');
  assert.equal(browser.timers.filter((timer) => timer.ms === 15000).length, 1);
  assert.equal(writes(browser).length, 0);
});

test('an empty log and an unreachable Data each have their own words', async () => {
  const empty = await openActivity({ events: [] });
  assert.match(html(empty), /Data has recorded no event yet\./);
  assert.match(html(empty), /No warning and no error in the last 24 hours\./);
  assert.match(html(empty), /<strong class="metric">0<\/strong>/);
  const down = await openActivity({ events: [], error: new Error('connect ECONNREFUSED') });
  assert.match(html(down), /The summary of the last 24 hours could not be read from Data: connect ECONNREFUSED\./);
  assert.match(html(down), /The activity log could not be read from Data: connect ECONNREFUSED\./);
  assert.match(html(down), /Nothing could be read\./);
});

test('hostile text in an event message, type and details is shown as text', async () => {
  const hostile = fx.event(`external.${fx.HOSTILE}`, 'warning', `New device ${fx.HOSTILE} at /mnt/"quoted"/<b>x</b>`, {
    hostname: fx.HOSTILE, path: '/mnt/archive/<img src=x onerror=alert(1)>.mkv', nested: { '<i>key</i>': '<u>v</u>' }, list: ['<a>', { deep: '<b>' }], empty: null
  }, new Date(Date.now() - 60000).toISOString());
  hostile.id = `"><script>alert(2)</script>`;
  const odd = fx.event('storage.scan_finished', '<svg onload=alert(3)>', 'Odd severity', {}, new Date(Date.now() - 120000).toISOString());
  const browser = await openActivity({ events: [hostile, odd] });
  const view = html(browser);
  assert.doesNotMatch(view, /<script>|<img |<b>x|<i>key|<u>v|<a>|<svg onload/);
  assert.ok(view.includes(`<td>New device ${fx.HOSTILE_ESCAPED} at /mnt/&quot;quoted&quot;/&lt;b&gt;x&lt;/b&gt;</td>`));
  assert.ok(view.includes(`<td class="mono">external.${fx.HOSTILE_ESCAPED}</td>`));
  assert.ok(view.includes(`<dt class="mono">hostname</dt><dd>${fx.HOSTILE_ESCAPED}</dd>`));
  assert.ok(view.includes('<dd>/mnt/archive/&lt;img src=x onerror=alert(1)&gt;.mkv</dd>'));
  assert.ok(view.includes('<dt class="mono">nested.&lt;i&gt;key&lt;/i&gt;</dt><dd>&lt;u&gt;v&lt;/u&gt;</dd>'));
  assert.ok(view.includes('<dt class="mono">list</dt><dd>&lt;a&gt;, {&quot;deep&quot;:&quot;&lt;b&gt;&quot;}</dd>'));
  assert.ok(view.includes('<dt class="mono">empty</dt><dd>—</dd>'));
  assert.ok(view.includes('data-activity-id="&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;"'));
  assert.ok(view.includes('<span class="pill ">&lt;svg onload=alert(3)&gt;</span>'));
  // The summary line and the Overview card carry the same message.
  assert.ok(view.includes(`— New device ${fx.HOSTILE_ESCAPED} at`));
  browser.location.hash = '#overview';
  await browser.render();
  await settle();
  const card = html(browser, '#overviewActivity');
  assert.ok(card.includes(`<span>New device ${fx.HOSTILE_ESCAPED} at /mnt/&quot;quoted&quot;/&lt;b&gt;x&lt;/b&gt;</span>`));
  assert.doesNotMatch(card, /<script>|<b>x/);
  // Details are bounded, whatever an event carries.
  const many = browser.activityMetaRows(Object.fromEntries(Array.from({ length: 90 }, (_, index) => [`k${index}`, index])));
  assert.equal(many.length, 40);
  assert.deepEqual(JSON.parse(JSON.stringify(browser.activityMetaRows({ a: { b: { c: { d: { e: 1 } } } } }))), [['a.b.c.d', '{"e":1}']]);
  assert.equal(browser.activityMetaRows('text').length, 0);
});

test('family, severity and period filters are sent to Data, and paging walks the result', async () => {
  const store = { events: fx.eventLog(160, Date.now() - 60000) };
  const browser = await openActivity(store);
  assert.match(html(browser), /<option value="storage">Storage<\/option>.*<option value="external">External \(recorded by another service\)<\/option>/s);
  for (const family of ['storage', 'collector', 'gpu', 'network', 'janitor', 'livedata', 'mqtt', 'external']) assert.match(html(browser), new RegExp(`<option value="${family}"`));
  assert.match(html(browser), /data-activity-page="0" disabled>Newer<\/button>\s*<span class="muted">Page 1 of 4<\/span>\s*<button type="button" class="button" data-activity-page="2">Older/);
  await browser.click({ activityPage: '2' });
  assert.deepEqual(Object.fromEntries(listRead(browser).query), { page: '2', limit: '50' });
  assert.match(html(browser, '#activityPager'), /Page 2 of 4/);
  assert.equal(count(html(browser, '#activityList'), /<tr class="">/g), 50);
  await browser.click({ activityPage: '4' });
  assert.equal(count(html(browser, '#activityList'), /<tr class="">/g), 10);
  assert.match(html(browser, '#activityPager'), /data-activity-page="5" disabled>Older/);

  await browser.change(filters('storage', 'error', '24'));
  const read = listRead(browser);
  assert.deepEqual([read.query.get('type'), read.query.get('severity'), read.query.get('page')], ['storage.', 'error', '1']);
  assert.ok(Math.abs(Date.now() - 24 * 3600000 - new Date(read.query.get('since')).getTime()) < 5000);
  const rows = html(browser, '#activityList');
  assert.equal(count(rows, /storage\.scan_expired/g), count(rows, /<tr class="">/g));
  assert.match(html(browser, '#activityControls'), /\d+ events? match/);
  await browser.change(filters('janitor', 'error', '168'));
  assert.match(html(browser, '#activityList'), /No event matches these filters\./);
  // A value outside the lists falls back to "all", it is not sent as given.
  await browser.change(filters('storage.$where', 'fatal', '9999'));
  assert.deepEqual(Object.fromEntries(listRead(browser).query), { page: '1', limit: '50' });
  assert.equal(writes(browser).length, 0);
});

test('new events are prepended with a count every 15 s, and Pause stops the reads', async () => {
  const store = { events: fx.eventLog(3, Date.now() - 600000) };
  const browser = await openActivity(store);
  const tick = browser.timers.find((timer) => timer.ms === 15000).callback;
  const lists = () => sent(browser, 'GET', '/events').filter((request) => request.query.get('limit') === '50').length;
  await tick();
  assert.equal(lists(), 2);
  assert.ok(new Date(listRead(browser).query.get('since')).getTime() === new Date(store.events[0].at).getTime(), 'asks from the newest event known');
  assert.doesNotMatch(html(browser, '#activityControls'), /new<\/strong>/);
  assert.equal(count(html(browser, '#activityList'), /<tr class="/g), 3, 'the same events are not listed twice');

  store.events.unshift(fx.event('gpu.host_stale', 'warning', 'GPU host bench-b has had no sample for 5 minutes.', { hostId: 'bench-b' }, new Date(Date.now() - 1000).toISOString()));
  store.events.unshift(fx.event('storage.scan_queued', 'info', 'Storage scan of photos queued.', {}, new Date().toISOString()));
  await tick();
  const rows = html(browser, '#activityList');
  assert.equal(count(rows, /<tr class="activity-new">/g), 2);
  assert.equal(count(rows, /<tr class="/g), 5);
  assert.ok(rows.indexOf('Storage scan of photos queued.') < rows.indexOf('GPU host bench-b') && rows.indexOf('GPU host bench-b') < rows.indexOf('Storage scan of archive finished'));
  assert.match(rows, /Storage scan of photos queued\. <span class="pill">new<\/span>/);
  assert.match(html(browser, '#activityControls'), /5 events match · .* · <strong>2 new<\/strong> since this list was opened/);
  assert.match(html(browser, '#activitySummary'), /Most recent warning or error: <span class="pill warn">warning<\/span> .* — GPU host bench-b/);

  // Paused, hidden: nothing is asked.
  await browser.click({ activityAction: 'pause' });
  assert.match(html(browser, '#activityControls'), /aria-pressed="true">Resume<\/button>\s*<span class="muted">.*<strong class="warn">paused<\/strong>: nothing is read until Resume/);
  const before = lists();
  await tick();
  assert.equal(lists(), before);
  await browser.click({ activityAction: 'pause' });
  assert.equal(lists(), before + 1, 'Resume reads at once');
  browser.document.hidden = true;
  await tick();
  assert.equal(lists(), before + 1);
  browser.document.hidden = false;

  // On another page of the list, new events are announced, not inserted.
  browser.activityState.page = 2;
  store.events.unshift(fx.event('collector.back', 'info', 'Collector nas-storage reports again.', {}, new Date(Date.now() + 1000).toISOString()));
  await tick();
  assert.doesNotMatch(html(browser, '#activityList'), /reports again/);
  assert.match(html(browser, '#activityNotice'), /1 new event arrived while you were on another page\. <button type="button" class="link-button" data-activity-page="1">Show the newest<\/button>/);
  await browser.click({ activityPage: '1' });
  assert.match(html(browser, '#activityList'), /Collector nas-storage reports again\./);
  assert.equal(html(browser, '#activityNotice').trim(), '');
  assert.equal(writes(browser).length, 0);
});

test('the activity poll stops on another tab, drops a late answer and reports a failed read', async () => {
  const store = { events: fx.eventLog(2, Date.now() - 600000) };
  const browser = await openActivity(store);
  const tick = browser.timers.find((timer) => timer.ms === 15000).callback;
  store.error = new Error('Data service request timed out');
  await tick();
  assert.match(html(browser, '#activityNotice'), /The activity log could not be read from Data: Data service request timed out\. The rows below are the last ones read\./);
  assert.equal(count(html(browser, '#activityList'), /<tr class="/g), 2);
  delete store.error;
  await tick();
  assert.equal(html(browser, '#activityNotice').trim(), '');

  const before = html(browser, '#activityList');
  store.events.unshift(fx.event('mqtt.monitor_disconnected', 'warning', 'MQTT monitor disconnected.', {}, new Date().toISOString()));
  const pending = tick();
  browser.state.tab = 'overview';
  browser.state.renderSeq += 1;
  await pending;
  assert.equal(html(browser, '#activityList'), before, 'an answer for a tab that was left is dropped');
  const reads = browser.requests.length;
  await tick();
  assert.deepEqual([browser.cleared.length, browser.activityState.timer, browser.requests.length], [1, null, reads]);
});

test('the Overview shows the last warnings and errors and links to the Activity tab', async () => {
  const store = { events: fx.eventLog(24, Date.now() - 60000) };
  const browser = page(activityData(store), '#overview');
  await browser.render();
  await settle();
  assert.match(html(browser), /<section id="overviewActivity"><\/section>/);
  const card = html(browser, '#overviewActivity');
  assert.match(card, /<h3>Recent activity: warnings and errors<\/h3><a class="link-button" href="#activity">Open the activity log<\/a>/);
  assert.equal(count(card, /<li>/g), 4);
  assert.doesNotMatch(card, /pill ">info/);
  assert.ok(card.indexOf('Collector nas-storage has not reported') < card.indexOf('Storage scan of photos expired'), 'newest first across both severities');
  const reads = sent(browser, 'GET', '/events');
  assert.deepEqual(reads.map((request) => Object.fromEntries(request.query)), [{ severity: 'error', limit: '4' }, { severity: 'warning', limit: '4' }]);
  assert.match(html(browser), /Write routes<\/span><strong>6 · network device record, network scan request, MQTT publish, storage scan request, report generation, report deletion</);

  const quiet = page(activityData({ events: fx.eventLog(1, Date.now()) }), '#overview');
  await quiet.render();
  await settle();
  assert.match(html(quiet, '#overviewActivity'), /No warning and no error in the 30 days Data keeps\./);
  const down = page(activityData({ events: [], error: new Error('connect ECONNREFUSED') }), '#overview');
  await down.render();
  await settle();
  assert.match(html(down, '#overviewActivity'), /The activity log could not be read from Data: connect ECONNREFUSED\./);
  assert.match(html(down), /Operational overview/, 'the Overview itself still renders');
});
