'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const toolbox = require('../index');

function browserEvidence(fetchImpl) {
  const content = { innerHTML: '' };
  const listeners = {};
  const form = { elements: { search: {}, root: {} } };
  const context = {
    document: {
      querySelector(selector) { return selector === '#content' ? content : selector === '#fileFilters' ? form : {}; },
      // The page's own click handler (app.js) is the last one registered.
      addEventListener(name, callback) { listeners[name] = callback; }
    },
    setInterval() { return 1; }, clearInterval() {},
    window: { addEventListener() {}, alert(message) { throw new Error(message); } },
    fetch: fetchImpl, URLSearchParams, console
  };
  // The Storage scan sections and the Files tab live in their own files.
  const source = ['storage-tools.js', 'files-tools.js', 'app.js'].map((file) => fs.readFileSync(path.join(__dirname, '../public', file), 'utf8')).join('\n')
    .replace(/\nrender\(\);\s*$/, '\nglobalThis.evidence = { api, overview, storage, files(...args) { state.tab = "files"; return files(...args); }, number, bytes, percent, signedNumber, signedBytes, trend };');
  vm.runInNewContext(source, context);
  return { ...context.evidence, content, listeners, form };
}

test('unavailable measurements remain unknown while observed zero stays zero', () => {
  const browser = browserEvidence();
  for (const value of [null, undefined, '', ' ', NaN, Infinity]) {
    for (const name of ['number', 'bytes', 'percent', 'signedNumber', 'signedBytes']) {
      assert.equal(browser[name](value), '—', `${name} must preserve missing ${String(value)}`);
    }
    assert.doesNotMatch(browser.trend(value, 'Change'), /trend positive/);
  }
  assert.equal(browser.number(0), '0');
  assert.equal(browser.bytes(0), '0 B');
  assert.equal(browser.percent(0), '0.00%');
});

test('unreadable successful upstream responses cannot count as healthy capabilities', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>wrong destination</html>' });
  const status = await toolbox.buildStatus();
  assert.equal(status.dataService.healthy, 0);
  assert.ok(Object.values(status.sources).every(source => source.ok === false));
});

test('valid error envelopes are unavailable and obsolete Data keys are not transmitted', async (t) => {
  const original = global.fetch;
  const previous = process.env.DATAAPI_API_KEY;
  t.after(() => {
    global.fetch = original;
    if (previous === undefined) delete process.env.DATAAPI_API_KEY;
    else process.env.DATAAPI_API_KEY = previous;
  });
  process.env.DATAAPI_API_KEY = 'obsolete-setting';
  global.fetch = async (_url, options) => {
    assert.equal(options.headers['X-API-Key'], undefined);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, status: 'error', message: 'Unavailable' }) };
  };
  assert.equal((await toolbox.buildStatus()).dataService.healthy, 0);
});

test('browser rejects invalid JSON and failed envelopes even with HTTP 200', async () => {
  for (const body of [{ ok: false, message: 'Storage unavailable' }, { status: 'error', message: 'Storage unavailable' }, null, 'html']) {
    const browser = browserEvidence(async () => ({ ok: true, status: 200, json: async () => body }));
    await assert.rejects(browser.api('/storage/summary'));
  }
  const browser = browserEvidence(async () => ({ ok: true, status: 200, json: async () => { throw new Error('parse'); } }));
  await assert.rejects(browser.api('/storage/summary'));
});

test('failed overview sources are not rendered as zero devices, feeds or profiles', async () => {
  const browser = browserEvidence(async () => ({ ok: true, status: 200, json: async () => ({ data: {
    dataService: { healthy: 0, total: 7 }, sources: {
      health: { ok: false }, resources: { ok: false }, storage: { ok: false },
      network: { ok: false }, liveData: { ok: false }, databases: { ok: false },
      janitor: { ok: false }
    }
  } }) }));
  await browser.overview();
  assert.match(browser.content.innerHTML, /—<\/strong><span class="metric-label">known network devices/);
  assert.doesNotMatch(browser.content.innerHTML, /0\/0 enabled/);
  assert.match(browser.content.innerHTML, /Janitor profiles<\/span><strong>—/);
});

test('a partial status projection cannot claim zero of seven healthy capabilities', async () => {
  const browser = browserEvidence(async () => ({ ok: true, status: 200, json: async () => ({ data: {
    dataService: { healthy: 0, total: 7 }, sources: { network: { ok: false } }
  } }) }));
  await assert.rejects(browser.overview(), /unexpected response/);
  assert.doesNotMatch(browser.content.innerHTML, /0\/7/);
});

test('file pagination reaches later rows and keeps the selected filters', async () => {
  const requests = [];
  const browser = browserEvidence(async (url) => {
    const query = new URL(url, 'http://localhost').searchParams;
    requests.push(query);
    const page = Number(query.get('page'));
    return { ok: true, status: 200, json: async () => ({ data: {
      files: [{ filename: `source-page-${page}` }], pagination: { page, pages: 2, total: 51 }
    } }) };
  });
  await browser.files(new URLSearchParams({ search: 'notes', root: '/mnt/media' }));
  assert.match(browser.content.innerHTML, /data-action="files-next"/);
  await browser.listeners.click({ target: { closest(selector) {
    return selector === '[data-action]' ? { dataset: { action: 'files-next' } } : null;
  } } });
  assert.equal(requests.at(-1).get('page'), '2');
  assert.equal(requests.at(-1).get('search'), 'notes');
  assert.equal(requests.at(-1).get('root'), '/mnt/media');
  assert.match(browser.content.innerHTML, /source-page-2/);
  assert.match(browser.content.innerHTML, /data-action="files-next" disabled/);
});

test('scan receipts read the source, file count and status Data actually returns', async () => {
  const browser = browserEvidence(async (url) => {
    const route = new URL(url, 'http://localhost').pathname;
    const data = route.endsWith('/storage/scans') ? { scans: [{
      _id: 'scan-1', type: 'external-storage-agent', status: 'complete', started_at: '2026-10-08T07:01:22.437Z',
      config: { external: true, source: 'datalake', roots: ['/mnt/datalake'] }, counts: { files_seen: 221299 }
    }] } : route.endsWith('/storage/agents') ? { scanners: [] } : {};
    return { ok: true, status: 200, json: async () => ({ data }) };
  });
  await browser.storage();
  const row = browser.content.innerHTML.match(/<details class="scan-detail" data-scan-detail="scan-1">.*?<\/summary>/s)[0];
  assert.match(row, /datalake · \/mnt\/datalake/);
  assert.match(row, new RegExp(browser.number(221299)));
  assert.match(row, /pill good">complete/);
});

test('a refused file filter keeps the form on screen and offers only Data categories', async () => {
  const form = { elements: { search: {}, root: {}, category: {} } };
  const browser = browserEvidence(async () => ({
    ok: false, status: 400, json: async () => ({ status: 'error', message: 'Unknown file category: image' })
  }));
  Object.assign(browser.form.elements, form.elements);
  await browser.files(new URLSearchParams({ category: 'image' }));
  assert.match(browser.content.innerHTML, /id="fileFilters"/);
  assert.match(browser.content.innerHTML, /Unknown file category: image/);
  assert.match(browser.content.innerHTML, /<option>media<\/option>/);
  assert.doesNotMatch(browser.content.innerHTML, /<option>(image|video|audio)<\/option>/);
  assert.equal(browser.form.elements.category.value, 'image');
});

test('a missing strategy report is an empty Janitor state, not a failed tab', async (t) => {
  const express = require('express');
  const request = require('supertest');
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ status: 'error', message: 'strategy report not found' }) });
  const app = express();
  toolbox.register({ contractVersion: 2, app, express });
  const res = await request(app).get('/api/data-toolbox/janitor/strategy/latest').expect(200);
  assert.equal(res.body.data.available, false);
  assert.equal(res.body.data.status, 'unavailable');
});

function registeredSurface() {
  const mounts = [];
  const routers = [];
  const express = {
    static(root, options) { return { kind: 'static', root, options }; },
    Router() {
      const routes = [];
      const router = {
        routes,
        get(routePath, handler) { routes.push({ method: 'get', path: routePath, handler }); },
        patch(routePath, handler) { routes.push({ method: 'patch', path: routePath, handler }); },
        post(routePath, handler) { routes.push({ method: 'post', path: routePath, handler }); },
        put(routePath, handler) { routes.push({ method: 'put', path: routePath, handler }); },
        delete(routePath, handler) { routes.push({ method: 'delete', path: routePath, handler }); }
      };
      routers.push(router);
      return router;
    }
  };
  const app = {
    use(routePath, handler) { mounts.push({ method: 'use', path: routePath, handler }); },
    get(routePath, handler) { mounts.push({ method: 'get', path: routePath, handler }); }
  };
  toolbox.register({ contractVersion: 2, app, express });
  return { mounts, routers };
}

test('manifest identifies the AIOps Data Toolbox contract and its five write families', () => {
  assert.equal(toolbox.id, 'aio-ops-data-toolbox');
  assert.equal(toolbox.version, '1.8.0');
  assert.deepEqual(toolbox.capabilities, ['data-toolbox-ui', 'data-readonly-projection', 'network-device-update', 'network-scan-request', 'mqtt-publish', 'storage-scan-request', 'janitor-review-decision']);
  assert.throws(() => toolbox.register({ contractVersion: 1 }), /contract v2/);
});

test('query projection keeps only allowlisted, bounded values', () => {
  const query = toolbox.pickQuery({ limit: '999', page: '-4', sort: 'sideways', q: 'x'.repeat(30), ignored: 'secret' }, {
    limit: { type: 'int', fallback: 10, min: 1, max: 100 },
    page: { type: 'int', fallback: 1, min: 1, max: 1000 },
    sort: { values: ['asc', 'desc'] },
    q: { maxLength: 20 }
  });
  assert.equal(query, `limit=100&page=1&q=${'x'.repeat(20)}`);
  assert.equal(toolbox.boundedInt('nope', 7, 1, 10), 7);
  assert.equal(toolbox.safeName('nas_files', 'collection'), 'nas_files');
  assert.throws(() => toolbox.safeName('../private', 'collection'), /Invalid collection/);
});

test('registration mounts the cockpit, GET proxy families and exactly five write families', () => {
  const { mounts, routers } = registeredSurface();
  const appPaths = mounts.map((entry) => entry.path);
  assert.ok(appPaths.includes('/assets/data-toolbox'));
  assert.ok(appPaths.includes('/data-toolbox'));
  assert.ok(appPaths.includes('/api/data-toolbox'));
  assert.deepEqual(mounts.filter((entry) => entry.method === 'get').map((entry) => entry.path), ['/data-toolbox']);

  const routes = routers.flatMap((router) => router.routes);
  assert.ok(routes.length >= 20);
  assert.deepEqual(routes.filter((route) => route.method !== 'get').map((route) => `${route.method} ${route.path}`),
    ['post /storage/scans', 'post /network/scan', 'patch /network/devices/:mac', 'post /mqtt/publish',
      'put /janitor/review-decisions/:sha256', 'post /janitor/review-decisions/batch', 'delete /janitor/review-decisions/:sha256'],
    'the only mutations are a storage scan request, a network scan request, the edit of a network device record, publishing an MQTT message, and the three writes of a Janitor review decision (store, import, remove)');
  // No approval, preview or execution route of the janitor is relayed, under any method.
  assert.deepEqual(routes.filter((route) => /approve|reject|preview|apply|execute|\/run$/.test(route.path)), []);
  for (const route of [
    '/status', '/storage/summary', '/storage/files', '/storage/scans/:scanId', '/storage/cleanup', '/storage/directory-count', '/network/devices', '/network/scan-requests/:id',
    '/hardware/collectors', '/hardware/latest', '/hardware/history', '/hardware/occupancy',
    '/databases/collections', '/live-data/feeds', '/mqtt/status', '/mqtt/messages', '/janitor/profiles', '/janitor/dedup-report',
    '/janitor/profiles/:id/runs', '/janitor/runs/:id', '/janitor/strategy/latest', '/janitor/strategy/latest/raw',
    '/janitor/strategy/latest/groups', '/janitor/review-decisions'
  ]) assert.ok(routes.some((entry) => entry.path === route), `missing GET ${route}`);
});

test('shared-drive strategy projection is bounded and keeps decision evidence', () => {
  const report = {
    generatedAt: '2026-08-24T06:03:31.246Z',
    status: 'ready_for_review',
    policy: { duplicateSurvivor: 'canonical_active', maintenanceAuthorization: 'explicit_per_action' },
    decisions_required: [],
    evidence: {
      verifiedDuplicateGroups: 5084,
      verifiedDuplicateFiles: 18753,
      provenSavingsBytes: 144167193354,
      duplicateCandidates: { groups: 23127, files: 202758, candidateBytes: 170000000000, filesToHash: 198918, bytesToHash: 118335822850 },
      verifiedDuplicateEvidence: Array.from({ length: 35 }, (_, group) => ({
        sha256: `hash-${group}`,
        proof: 'sha256-current-metadata',
        size: 1000,
        count: 10,
        provenSavingsBytes: 9000,
        files: Array.from({ length: 10 }, (_, file) => ({ path: `/mnt/media/${group}/${file}`, storageRole: 'canonical' }))
      })),
      perRoot: [{ root: '/mnt/media', totalFiles: 10, totalBytes: 1000 }],
      verificationOutlook: { status: 'measured', filesToHash: 198918, bytesToHash: 118335822850 }
    },
    organizationStrategy: {
      workItems: Array.from({ length: 15 }, (_, index) => ({
        id: `work-${index}`, title: `Work ${index}`, evidence: { files: 10, bytes: 100 }, filesystemMutationAllowed: false
      }))
    },
    maintenance: { proposals: Array.from({ length: 5084 }, (_, index) => ({ id: index })), executableActions: [] },
    safety: { sharedDriveMutations: 0, approvalEndpointsCalled: false, deleteMoveArchiveExecuted: false }
  };
  const projection = toolbox.projectJanitorStrategy({ data: { report } });
  assert.equal(projection.summary.proposals, 5084);
  assert.equal(projection.summary.provenSavingsBytes, 144167193354);
  assert.equal(projection.duplicates.length, 30);
  assert.ok(projection.duplicates.every(group => group.files.length === 8 && group.filesOmitted === 2));
  assert.equal(projection.organization.workItems.length, 12);
  assert.ok(projection.organization.workItems.every(item => item.filesystemMutationAllowed === false));
  assert.equal(projection.maintenance.executableActions, 0);
  assert.equal(projection.safety.sharedDriveMutations, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(projection.maintenance, 'proposals'), false);
});

test('recorded per-root hash limits preserve configured values and unknown measurements', () => {
  const report = { evidence: { perRoot: [
    { root: '/mnt/media', latestHashingScan: { hashMaxBytes: 10 * 1024 ** 3 } },
    { root: '/mnt/datalake', latestHashingScan: { hashMaxBytes: 50 * 1024 ** 3 } },
    { root: '/unknown', latestHashingScan: {} }
  ] } };
  const projection = toolbox.projectJanitorStrategy({ data: { report } });
  assert.deepEqual(projection.metadata.perRoot.map(root => root.latestHashingScan.hashMaxBytes), [10 * 1024 ** 3, 50 * 1024 ** 3, null]);
});

test('browser bundle keeps all operator domains and explicit guardrails', () => {
  const root = path.resolve(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'app.css'), 'utf8');
  for (const tab of ['overview', 'storage', 'files', 'network', 'gpu', 'databases', 'live-data', 'mqtt', 'janitor']) {
    assert.match(html, new RegExp(`data-tab=["']${tab}["']`));
  }
  assert.match(html, /Filesystem-safe review console/);
  assert.match(html, /Survivor choices and accept\/reject decisions are saved to Data as a record of intent for a later, separately confirmed cleanup; a local draft takes over when Data cannot be reached/);
  assert.match(html, /<!-- product-navigation -->/);
  const { buildProductNavigation } = require('../../../../shared/productNavigation');
  const destinations = buildProductNavigation({ activePage: 'data-toolbox' }).navItems.flatMap(group => group.children);
  assert.equal(destinations.find(item => item.id === 'playground').href, '/playground');
  assert.match(app, /Shared-drive Janitor/);
  assert.match(app, /Download full JSON/);
  assert.match(app, /proven duplicate savings/i);
  assert.match(app, /This is not an executable deletion plan/);
  assert.match(app, /Historical sets must be regenerated before preview/);
  assert.match(app, /historical · rerun required/);
  assert.match(app, /Open exact run JSON/);
  // The duplicate review lives in janitor-review.js, loaded before app.js.
  const review = fs.readFileSync(path.join(root, 'janitor-review.js'), 'utf8');
  assert.ok(html.indexOf('/assets/data-toolbox/janitor-review.js') > 0);
  assert.ok(html.indexOf('/assets/data-toolbox/janitor-review.js') < html.indexOf('/assets/data-toolbox/app.js'));
  assert.match(app, /typeof janitorReviewSection === 'function'/);
  assert.match(review, /Accept for preview/);
  assert.match(review, /Reject deletion/);
  assert.match(app, /authorizesFilesystemMutation:\s*false/);
  assert.match(review, /Choose the path to keep before accepting this group for preview/);
  assert.match(app, /Pinned near the top/);
  assert.match(app, /individual unhashed file above its root's recorded byte budget remains unverified/);
  assert.match(app, /\/janitor\/strategy\/latest/);
  assert.match(app, /Historical registration only/);
  assert.match(app, /not an AgentX Product or LLM agent/);
  assert.match(app, /agentx\.data-toolbox\.janitor-review-draft\.v1/);
  assert.match(app, /localStorage\.setItem\(JANITOR_REVIEW_STORAGE_KEY/);
  // The draft is content-addressed (SHA-256): it must survive portfolio
  // regeneration, a still-loading report, and internal tab changes.
  assert.doesNotMatch(app, /draft\.portfolioGeneratedAt === portfolioGeneratedAt/);
  assert.match(app, /state\.janitorReview = \{ \.\.\.restored, \.\.\.state\.janitorReview \}/);
  assert.match(review, /content hashes do not change between reports/);
  assert.match(app, /draft\.authorizesFilesystemMutation === false/);
  assert.match(app, /clearJanitorReviewDraft\(\)/);
  assert.match(review, /saved in this browser across refreshes, tab changes, and portfolio regenerations/);
  assert.match(review, /This draft authorizes no filesystem mutation/);
  assert.match(review, /<strong>Nothing here deletes files\.<\/strong> A stored decision records your intent for a later, separately confirmed cleanup/);
  // The bundle sends five kinds of mutation: a network scan request and the
  // edit of a device record (network-tools.js), an MQTT message (mqtt.js), a
  // storage scan request (storage-tools.js) and the Janitor review decisions
  // (janitor-review.js: store one, import a batch, remove one). The page says
  // so in both places.
  assert.equal(app.match(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/gi), null);
  assert.deepEqual(review.match(/method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/gi).sort(), ["method: 'DELETE'", "method: 'POST'", "method: 'PUT'"]);
  assert.match(review, /api\(`\/janitor\/review-decisions\/\$\{encodeURIComponent\(sha\)\}`, \{ method: 'PUT', payload \}\)/);
  assert.match(review, /api\('\/janitor\/review-decisions\/batch', \{ method: 'POST', payload: \{ mode: 'insert_missing', decisions \} \}\)/);
  assert.match(review, /api\(`\/janitor\/review-decisions\/\$\{encodeURIComponent\(sha\)\}`, \{ method: 'DELETE' \}\)/);
  // Every request of the review goes to the review-decision or group routes: none to a run, a preview or an approval.
  assert.deepEqual([...new Set([...review.matchAll(/api\([`'](\/[a-z-]+\/[a-z-]+)/g)].map((match) => match[1]))].sort(), ['/janitor/review-decisions', '/janitor/strategy']);
  assert.doesNotMatch(review, /alert\(|confirm\(|prompt\(|insertAdjacentHTML|document\.write|eval\(/);
  const networkTools = fs.readFileSync(path.join(root, 'network-tools.js'), 'utf8');
  assert.equal(networkTools.match(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/gi)?.length, 2);
  assert.match(networkTools, /api\('\/network\/scan', \{ method: 'POST'/);
  assert.match(networkTools, /network\/devices\/\$\{encodeURIComponent\(key\)\}`, \{ method: 'PATCH'/);
  const mqtt = fs.readFileSync(path.join(root, 'mqtt.js'), 'utf8');
  assert.equal(mqtt.match(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/gi)?.length, 1);
  assert.match(mqtt, /api\('\/mqtt\/publish', \{ method: 'POST'/);
  assert.equal(fs.readFileSync(path.join(root, 'gpu.js'), 'utf8').match(/method:/g), null);
  const scans = fs.readFileSync(path.join(root, 'storage-tools.js'), 'utf8');
  assert.equal(scans.match(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/gi)?.length, 1);
  assert.match(scans, /api\('\/storage\/scans', \{ method: 'POST', payload: \{ source \} \}\)/);
  assert.equal(fs.readFileSync(path.join(root, 'files-tools.js'), 'utf8').match(/method:/g), null);
  assert.match(html, /<strong>No filesystem actions\.<\/strong>/);
  assert.match(html, /This page sends five kinds of change to Data: a network device's record \(name, known flag, type, location, notes\), a network scan request for the active collector, an MQTT message published by hand from the MQTT tab, which reaches the devices on the broker, a storage scan request from the Storage tab, which only reads the disks and refreshes the index, and the duplicate-review decisions of the Janitor tab \(saved, imported from this browser's draft, or removed\), which delete no file\./);
  assert.match(html, /Preview, apply, move and delete endpoints are not exposed here/);
  assert.doesNotMatch(html, /Storage scan, preview/);
  assert.doesNotMatch(html, /The only change this page sends/);
  assert.match(app, /Write routes<\/span><strong>7 in 5 families · network device record, network scan request, MQTT publish, storage scan request, Janitor review decisions \(save, import, remove\)/);
  assert.match(css, /@media \(max-width: 620px\)/);
});

test('Janitor preserves unavailable portfolio totals and renders the remaining root evidence', async () => {
  const appPath = path.resolve(__dirname, '..', 'public', 'app.js');
  const source = fs.readFileSync(appPath, 'utf8').replace(
    /\nrender\(\);\s*$/,
    '\nglobalThis.renderJanitor = janitor;'
  );
  for (const unavailable of [null, undefined, '', 'invalid']) {
    const report = toolbox.projectJanitorStrategy({ evidence: {
      metadataFirst: { status: 'unavailable', indexedFiles: unavailable, indexedBytes: unavailable },
      perRoot: [{ root: '/archive', totalFiles: 42, totalBytes: 2048, latestScan: { status: 'failed' } }]
    } });
    assert.equal(report.metadata.indexedFiles, null);
    assert.equal(report.metadata.indexedBytes, null);
    const content = { innerHTML: '' };
    const context = {
      document: { querySelector() { return content; }, addEventListener() {} },
      window: { addEventListener() {}, location: { hash: '' } },
      localStorage: { getItem() { return null; }, removeItem() {} },
      fetch: async (url) => ({ ok: true, json: async () => ({ data: url.endsWith('/profiles') ? { profiles: [] } : report }) }),
      console, Date, setTimeout, clearTimeout
    };
    vm.runInNewContext(source, context, { filename: appPath });
    await context.renderJanitor();
    assert.match(content.innerHTML, /Current portfolio total unavailable/);
    assert.doesNotMatch(content.innerHTML, /0 indexed files/);
    assert.match(content.innerHTML, /42 files/);
    assert.match(content.innerHTML, /2\.0 KiB/);

    report.metadata.indexedFiles = 0;
    report.metadata.indexedBytes = 0;
    await context.renderJanitor();
    assert.match(content.innerHTML, /0 indexed files · 0 B total, counted once/);
  }
});

test('Janitor review decisions survive report changes, tab changes, and page reloads', () => {
  const appPath = path.resolve(__dirname, '..', 'public', 'app.js');
  const source = fs.readFileSync(appPath, 'utf8').replace(
    /\nrender\(\);\s*$/,
    '\nglobalThis.__janitorDraftTest = { state, persistJanitorReviewDraft, restoreJanitorReviewDraft };'
  );
  const values = new Map();
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const loadBrowserBundle = () => {
    const context = {
      document: {
        querySelector() { return {}; },
        addEventListener() {}
      },
      window: { addEventListener() {}, location: { hash: '' } },
      localStorage,
      console,
      Date,
      setTimeout,
      clearTimeout
    };
    vm.runInNewContext(source, context, { filename: appPath });
    return context.__janitorDraftTest;
  };
  const first = loadBrowserBundle();
  first.state.janitorReportGeneratedAt = '2026-09-01T10:00:00.000Z';
  first.state.janitorReview['hash-still-visible'] = {
    sha256: 'hash-still-visible',
    decision: 'accept_for_preview',
    keepPath: '/keep/a',
    removePaths: ['/remove/a'],
    reason: 'operator-selected survivor; complete SHA-256 preview required'
  };
  first.state.janitorReview['hash-outside-next-report'] = {
    sha256: 'hash-outside-next-report',
    decision: 'reject_keep_all',
    keepPath: null,
    removePaths: [],
    reason: 'operator rejected deletion proposal; keep every member'
  };
  assert.equal(first.persistJanitorReviewDraft(), true);

  // Internal tab navigation does not reload or clear the in-memory draft.
  first.state.tab = 'storage';
  first.state.tab = 'janitor';
  assert.equal(Object.keys(first.state.janitorReview).length, 2);

  // A regenerated portfolio restores both the still-visible group and the
  // content-addressed decision that is outside the new report's bounded rows.
  first.restoreJanitorReviewDraft('2026-09-02T10:00:00.000Z');
  assert.deepEqual(Object.keys(first.state.janitorReview).sort(), [
    'hash-outside-next-report',
    'hash-still-visible'
  ]);

  // A full page reload reads the same durable, non-authorizing envelope.
  const reloaded = loadBrowserBundle();
  reloaded.restoreJanitorReviewDraft('2026-09-03T10:00:00.000Z');
  assert.equal(reloaded.state.janitorReview['hash-still-visible'].keepPath, '/keep/a');
  assert.equal(reloaded.state.janitorReview['hash-outside-next-report'].decision, 'reject_keep_all');
});

test('a missing stored Janitor draft never erases newer in-memory decisions', () => {
  const appPath = path.resolve(__dirname, '..', 'public', 'app.js');
  const source = fs.readFileSync(appPath, 'utf8').replace(
    /\nrender\(\);\s*$/,
    '\nglobalThis.__janitorDraftTest = { state, restoreJanitorReviewDraft };'
  );
  const context = {
    document: { querySelector() { return {}; }, addEventListener() {} },
    window: { addEventListener() {}, location: { hash: '' } },
    localStorage: { getItem() { return null; }, removeItem() {} },
    console,
    Date,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(source, context, { filename: appPath });
  context.__janitorDraftTest.state.janitorReview['hash-new'] = {
    sha256: 'hash-new', decision: 'reject_keep_all', keepPath: null, removePaths: []
  };
  context.__janitorDraftTest.restoreJanitorReviewDraft('2026-09-04T10:00:00.000Z');
  assert.equal(context.__janitorDraftTest.state.janitorReview['hash-new'].decision, 'reject_keep_all');
});

test('the built-in Toolbox serves its page and rejects mutation methods', async () => {
  const express = require('express');
  const request = require('supertest');
  const app = express();
  toolbox.register({ contractVersion: 2, app, express });
  assert.match((await request(app).get('/data-toolbox').expect(200)).text, /assets\/data-toolbox\/app.js/);
  // A scan request needs a body naming a source; no other storage write exists.
  await request(app).post('/api/data-toolbox/storage/scans').send({}).expect(400);
  await request(app).post('/api/data-toolbox/storage/scan').send({}).expect(404);
  await request(app).post('/api/data-toolbox/storage/stop/scan-1').send({}).expect(404);
  await request(app).patch('/api/data-toolbox/storage/files/file-1').send({}).expect(404);
  await request(app).delete('/api/data-toolbox/storage/scans/scan-1').expect(404);
  await request(app).delete('/api/data-toolbox/databases/collections/example').expect(404);
});

test('collector placement comes only from bounded external display metadata', (t) => {
  const previous = process.env.DATA_COLLECTOR_PLACEMENT_JSON;
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_COLLECTOR_PLACEMENT_JSON;
    else process.env.DATA_COLLECTOR_PLACEMENT_JSON = previous;
  });
  delete process.env.DATA_COLLECTOR_PLACEMENT_JSON;
  assert.deepEqual(toolbox.collectorPlacement(), {});
  process.env.DATA_COLLECTOR_PLACEMENT_JSON = JSON.stringify({ network: {
    example: { host: 'Example node', runtime: 'example.service', token: 'must not appear', cadence: 'x'.repeat(300) }
  } });
  const row = toolbox.collectorPlacement().network.example;
  assert.equal(row.host, 'Example node');
  assert.equal(row.token, undefined);
  assert.equal(row.cadence.length, 200);
  process.env.DATA_COLLECTOR_PLACEMENT_JSON = 'invalid';
  assert.throws(() => toolbox.collectorPlacement());
});

test('device acknowledgement relays a bounded PATCH to Data and rejects anything else', async (t) => {
  const express = require('express');
  const request = require('supertest');
  const original = global.fetch;
  const calls = [];
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', data: { device: { mac: 'AA:BB:CC:00:00:01' } } }) };
  };
  const app = express();
  app.use(express.json());
  toolbox.register({ contractVersion: 2, app, express });

  await request(app).patch('/api/data-toolbox/network/devices/aa:bb:cc:00:00:01')
    .send({ alias: `  ${'x'.repeat(80)}  `, known: true }).expect(200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/v1\/network\/devices\/AA%3ABB%3ACC%3A00%3A00%3A01$/);
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body), { alias: 'x'.repeat(80), known: true });

  await request(app).patch('/api/data-toolbox/network/devices/not-a-mac').send({ known: true }).expect(400);
  await request(app).patch('/api/data-toolbox/network/devices/AA:BB:CC:00:00:01').send({ known: 'yes' }).expect(400);
  await request(app).patch('/api/data-toolbox/network/devices/AA:BB:CC:00:00:01').send({ alias: 'x'.repeat(81) }).expect(400);
  await request(app).patch('/api/data-toolbox/network/devices/AA:BB:CC:00:00:01').send({ alias: 'x', hostname: 'y' }).expect(400);
  assert.equal(calls.length, 1);
});
