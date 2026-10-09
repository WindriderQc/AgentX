'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const toolbox = require('../index');

const publicRoot = path.resolve(__dirname, '..', 'public');
const NOW = Date.parse('2026-10-08T22:35:33.000Z');

// Shapes trimmed from a Data instance; names and identifiers are synthetic.
const gpuSample = (overrides = {}) => ({
  index: 0, name: 'Example RTX 3090', uuid: 'GPU-00000000-aaaa', busId: '00000000:02:00.0',
  throttleReasonsActive: '0x0000000000000001', throttleReasons: ['idle'],
  utilizationPct: 0, memoryUtilizationPct: 2, memoryUsedMiB: 19512, memoryTotalMiB: 24576,
  temperatureC: 58, powerDrawW: 25.05, powerLimitW: 300, ...overrides
});
const freshHost = (overrides = {}) => ({
  hostId: 'alpha', collectorId: 'example-gpu-agent', name: 'Alpha', consecutiveFailures: 0, gpuCount: 2,
  gpus: [gpuSample(), gpuSample({ index: 1, uuid: 'GPU-00000000-bbbb', utilizationPct: 97, temperatureC: 71,
    powerDrawW: 299.4, throttleReasonsActive: '0x0000000000000004', throttleReasons: ['sw_power_cap'] })],
  intervalMs: 30000, lastError: null, lastErrorAt: '2026-10-07T02:59:48.540Z', lastSampleAt: '2026-10-08T22:35:14.373Z',
  status: 'ok', ageMs: 18690, staleAfterMs: 90000, stale: false, freshness: 'fresh', ...overrides
});
const staleHost = () => freshHost({
  hostId: 'beta', name: 'Beta', gpuCount: 1, gpus: [gpuSample({ name: 'Example RTX 3080 Ti', utilizationPct: 64 })],
  status: 'error', lastError: 'ssh: connect to host beta port 22: timed out', consecutiveFailures: 412,
  lastSampleAt: '2026-10-08T19:05:00.000Z', ageMs: 12633000, stale: true, freshness: 'stale'
});
const latestBody = (hosts) => ({ hosts, total: hosts.length, fresh: hosts.filter((host) => host.freshness === 'fresh').length, observedAt: '2026-10-08T22:35:33.064Z' });
const collectorsBody = { collectors: [{
  collectorId: 'example-gpu-agent', agentVersion: 'gpu-1.1.0', hostname: 'Alpha', platform: 'linux', intervalMs: 30000,
  hosts: [{ hostId: 'alpha', name: 'Alpha' }, { hostId: 'beta', name: 'Beta' }], lastSeen: '2026-10-08T22:35:14.375Z', active: true
}], active: 1 };
const occupancyGpu = (overrides = {}) => ({
  index: 0, name: 'Example RTX 3090', uuid: 'GPU-00000000-aaaa', samples: 2877, observedMs: 86350673, missingMs: 49327, coverage: 0.999,
  busy: { ms: 17369508, share: 0.201 }, utilizationPct: { mean: 16.4, p50: 0, p95: 100 },
  memoryUsedMiB: { p50: 19512, p95: 21108, max: 23280 }, memoryTotalMiB: 24576,
  powerW: { mean: 105.1, p95: 293.2, max: 300.7, limit: 300 },
  throttled: { observedMs: 86350673, ms: 16526986, share: 0.191, powerCapMs: 16526986, thermalMs: 0, hardwareMs: 0 }, ...overrides
});
const occupancyBody = { from: '2026-10-07T22:35:33.624Z', to: '2026-10-08T22:35:33.624Z', windowMs: 86400000, busyAtPct: 10, hosts: [
  { hostId: 'alpha', name: 'Alpha', intervalMs: 30000, gpus: [
    occupancyGpu(),
    occupancyGpu({ index: 1, uuid: 'GPU-00000000-bbbb', samples: 620, observedMs: 18600000, missingMs: 67800000, coverage: 0.215,
      busy: { ms: 0, share: 0 }, utilizationPct: { mean: 0, p50: 0, p95: 0 } })
  ] },
  // A GPU the host last reported with no sample in the window.
  { hostId: 'beta', name: 'Beta', intervalMs: 30000, gpus: [occupancyGpu({ name: 'Example RTX 3080 Ti', samples: 0, observedMs: 0,
    missingMs: 86400000, coverage: 0, busy: { ms: 0, share: null }, utilizationPct: { mean: null, p50: null, p95: null },
    memoryUsedMiB: { p50: null, p95: null, max: null }, memoryTotalMiB: null,
    throttled: { observedMs: 0, ms: 0, share: null, powerCapMs: 0, thermalMs: 0, hardwareMs: 0 } })] }
] };
// Newest first, like Data: two GPUs, one sample every five minutes with a hole.
const historyBody = { hostId: 'alpha', limit: 2000, samples: [0, 1, 2, 3, 8, 9].flatMap((step) => [
  { hostId: 'alpha', sampledAt: new Date(NOW - step * 300000 - 20000).toISOString(), ...gpuSample({ utilizationPct: step === 0 ? 5 : step * 10 }) },
  { hostId: 'alpha', sampledAt: new Date(NOW - step * 300000 - 20000).toISOString(), ...gpuSample({ index: 1, uuid: 'GPU-00000000-bbbb', utilizationPct: null }) }
]) };

function gpuBrowser(respond) {
  const elements = {};
  const element = (selector) => (elements[selector] ||= { innerHTML: '', textContent: '' });
  const listeners = {};
  const requests = [];
  const timers = [];
  const cleared = [];
  class FixedDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(NOW); }
    static now() { return NOW; }
  }
  const document = {
    hidden: false,
    querySelector: element,
    querySelectorAll() { return []; },
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); }
  };
  const context = {
    document, window: { addEventListener() {} }, location: { hash: '#gpu' }, console, URLSearchParams,
    Date: FixedDate,
    setInterval(callback, ms) { timers.push({ callback, ms }); return timers.length; },
    clearInterval(id) { cleared.push(id); },
    fetch: async (url) => {
      const parsed = new URL(url, 'http://localhost');
      requests.push(parsed);
      const answer = await respond(parsed.pathname.replace('/api/data-toolbox', ''), parsed.searchParams);
      if (answer instanceof Error) return { ok: false, status: 502, json: async () => ({ ok: false, status: 'error', code: 'DATA_UNAVAILABLE', message: answer.message }) };
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: answer }) };
    }
  };
  const source = ['refresh.js', 'gpu.js', 'app.js'].map((file) => fs.readFileSync(path.join(publicRoot, file), 'utf8')).join('\n')
    .replace(/\nrender\(\);\s*$/, '\nglobalThis.page = { state, gpuState, gpuRefresher, render, renderers, gpu, refreshGpuNow, setGpuWindow, pct, mib, withUnit, span };');
  vm.runInNewContext(source, context);
  return { ...context.page, document, location: context.location, elements, listeners, requests, timers, cleared, content: element('#content') };
}

const liveLike = (overrides = {}) => (route) => {
  const routes = {
    '/hardware/latest': latestBody([freshHost(), staleHost()]),
    '/hardware/collectors': collectorsBody,
    '/hardware/occupancy': occupancyBody,
    '/hardware/history': historyBody,
    ...overrides
  };
  return routes[route] ?? new Error(`unexpected ${route}`);
};

async function openGpu(respond = liveLike()) {
  const browser = gpuBrowser(respond);
  await browser.render();
  return browser;
}

test('the GPU tab follows Network and loads its script before the page script', () => {
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  assert.match(html, /data-tab="network">Network<\/a>\s*<a href="#gpu" data-tab="gpu">GPU<\/a>\s*<a href="#databases"/);
  assert.ok(html.indexOf('/assets/data-toolbox/gpu.js') < html.indexOf('/assets/data-toolbox/app.js'));
  assert.ok(html.indexOf('/assets/data-toolbox/gpu.js') > 0);
  // The tab sends nothing but reads.
  assert.doesNotMatch(fs.readFileSync(path.join(publicRoot, 'gpu.js'), 'utf8'), /method:|payload/);
});

test('missing GPU measurements stay unknown and an observed zero stays zero', () => {
  const browser = gpuBrowser(liveLike());
  for (const value of [null, undefined, '', ' ', NaN]) {
    assert.equal(browser.pct(value), '—');
    assert.equal(browser.mib(value), '—');
    assert.equal(browser.withUnit(value, 'W'), '—');
    assert.equal(browser.span(value), '—');
  }
  assert.equal(browser.pct(0), '0%');
  assert.equal(browser.mib(0), '0 B');
  assert.equal(browser.mib(24576), '24.0 GiB');
  assert.equal(browser.withUnit(0, 'W'), '0 W');
  assert.equal(browser.span(18690), '19 s');
  assert.equal(browser.span(12633000), '3.5 h');
});

test('a fresh host shows its sample age, collector and one row per GPU', async () => {
  const browser = await openGpu();
  assert.equal(browser.state.tab, 'gpu');
  const now = browser.content.innerHTML.match(/<section id="gpuNow" aria-live="off">(.*?)<\/section>/s)[1];
  const alpha = now.split('<article')[1];
  assert.match(alpha, /<h3>Alpha<\/h3><span class="pill good">fresh<\/span>/);
  assert.match(alpha, /Sample 19 s old · expected every 30 s/);
  assert.match(alpha, /Reported by<\/span><strong class="mono">example-gpu-agent/);
  // An old error time without a current error is not an error.
  assert.doesNotMatch(alpha, /Last error|Consecutive failures/);
  assert.match(alpha, /<caption>GPUs on Alpha, sample 19 s old<\/caption>/);
  assert.equal(alpha.match(/<tr><th scope="row"/g).length, 2);
  const [first, second] = alpha.split('<tr><th scope="row"').slice(1);
  assert.match(first, /#0 Example RTX 3090/);
  assert.match(first, /<td>0%<\/td>/);
  assert.match(first, /19\.1 GiB \/ 24\.0 GiB <span class="muted">\(79\.4%\)<\/span><span class="gpu-bar" aria-hidden="true"><span style="width:79\.4%">/);
  assert.match(first, /<td>58 °C<\/td>/);
  assert.match(first, /<td>25\.1 W \/ 300 W<\/td>/);
  // Idle clocks are reported, and are not shown as throttling.
  assert.match(first, /<span class="muted">idle<\/span>/);
  assert.doesNotMatch(first, /throttled/);
  assert.match(second, /<td>97%<\/td>/);
  assert.match(second, /<span class="pill warn">throttled: power cap<\/span>/);
  assert.match(now, /1 of 2 hosts fresh/);
});

test('a stale host says so with the age of its values and its error', async () => {
  const browser = await openGpu();
  const beta = browser.content.innerHTML.split('<article')[2];
  assert.match(beta, /class="card gpu-host stale"/);
  assert.match(beta, /<h3>Beta<\/h3><span class="pill warn">stale<\/span>/);
  assert.match(beta, /<strong>Stale\.<\/strong> The last sample is 3\.5 h old/);
  assert.match(beta, /not the current state/);
  assert.match(beta, /<caption>GPUs on Beta: last values received, 3\.5 h old, not current<\/caption>/);
  assert.match(beta, /Last error[^<]*<\/span><strong class="bad">ssh: connect to host beta port 22: timed out/);
  assert.match(beta, /Consecutive failures<\/span><strong class="bad">412/);
});

test('a host without data and a GPU without readings show no invented zero', async () => {
  const noData = freshHost({ hostId: 'gamma', name: 'Gamma', gpus: [], gpuCount: 0, lastSampleAt: null, ageMs: null, stale: true,
    freshness: 'no_data', status: 'error', lastError: 'nvidia-smi not found', consecutiveFailures: 3 });
  const blind = freshHost({ hostId: 'delta', name: 'Delta', gpus: [{ index: 0, name: '', uuid: '', throttleReasonsActive: null, throttleReasons: [],
    utilizationPct: null, memoryUsedMiB: null, memoryTotalMiB: null, temperatureC: null, powerDrawW: null, powerLimitW: null }] });
  const browser = await openGpu(liveLike({ '/hardware/latest': latestBody([noData, blind]) }));
  const [, gamma, delta] = browser.content.innerHTML.match(/<section id="gpuNow".*?<\/section>/s)[0].split('<article');
  assert.match(gamma, /<span class="pill ">no data<\/span>/);
  assert.match(gamma, /No sample has been received from this host/);
  assert.match(gamma, /No GPU reported for this host/);
  assert.doesNotMatch(gamma, /<table/);
  const row = delta.match(/<tr><th scope="row".*?<\/tr>/s)[0];
  assert.match(row, /#0 GPU/);
  assert.equal(row.match(/<td>—<\/td>/g).length, 3, 'utilisation, temperature and throttle are unknown');
  assert.match(row, /<td>— \/ —<\/td>\s*<td>—<\/td>\s*<td>— \/ —<\/td>/);
  assert.doesNotMatch(row, /gpu-bar|>0%|0 B|0 W/);
});

test('occupancy states coverage for every GPU and never reads missing data as idle', async () => {
  const browser = await openGpu();
  const section = browser.content.innerHTML.match(/<section id="gpuOccupancy">(.*?)<\/section>/s)[1];
  assert.match(section, /time without data is unknown, not idle/);
  assert.match(section, /busy means utilisation at or above 10%/);
  const [full, partial, unseen] = section.split('<tr><th scope="row"').slice(1);
  assert.match(full, /99\.9% observed<br><span class="muted">2,877 samples · 49 s without data/);
  assert.match(full, /<td>20\.1%<br><span class="muted">4\.8 h<\/span><\/td>\s*<td>16\.4%<\/td>\s*<td>100%<\/td>/);
  assert.match(full, /20\.6 GiB \/ 22\.7 GiB<br><span class="muted">of 24\.0 GiB/);
  assert.match(full, /19\.1%<br><span class="muted">4\.6 h · power cap 4\.6 h<\/span>/);
  assert.doesNotMatch(full, /partial data/);
  // 0% busy over a fifth of the window carries its coverage warning in words.
  assert.match(partial, /21\.5% observed <span class="pill warn">partial data<\/span><br><span class="muted">620 samples · 18\.8 h without data/);
  assert.match(partial, /<td>0\.00%<br>/);
  assert.match(unseen, /<strong>not observed<\/strong><br><span class="muted">0 samples · 24\.0 h without data/);
  assert.equal(unseen.match(/<td>—<\/td>/g).length, 4, 'busy, mean, p95 and throttled are unknown');
  assert.match(unseen, /<td>— \/ —<br><span class="muted">of —<\/span><\/td>/);

  const occupancy = browser.requests.find((request) => request.pathname.endsWith('/hardware/occupancy'));
  assert.equal(Date.parse(occupancy.searchParams.get('to')) - Date.parse(occupancy.searchParams.get('from')), 24 * 3600000);
});

test('the window selector reloads occupancy only and keeps the choice', async () => {
  const browser = await openGpu();
  assert.match(browser.content.innerHTML, /<label class="gpu-window">Window <select id="gpuWindow"><option value="24" selected>Last 24 hours<\/option><option value="168">Last 7 days<\/option><option value="720">Last 30 days<\/option>/);
  const before = browser.requests.length;
  const whole = browser.content.innerHTML;
  await browser.setGpuWindow('99');
  assert.equal(browser.requests.length, before, 'an unknown window is ignored');
  browser.listeners.change[0]({ target: { id: 'gpuWindow', value: '168' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.requests.length, before + 1);
  const request = browser.requests.at(-1);
  assert.match(request.pathname, /\/hardware\/occupancy$/);
  assert.equal(Date.parse(request.searchParams.get('to')) - Date.parse(request.searchParams.get('from')), 7 * 24 * 3600000);
  assert.deepEqual([...request.searchParams.keys()], ['from', 'to']);
  assert.match(browser.elements['#gpuOccupancy'].innerHTML, /GPU occupancy table/);
  assert.equal(browser.content.innerHTML, whole, 'the rest of the tab is not redrawn');
  assert.equal(browser.gpuState.windowHours, 168);
});

test('the trend draws a bounded sparkline with a text summary per GPU', async () => {
  const browser = await openGpu();
  const histories = browser.requests.filter((request) => request.pathname.endsWith('/hardware/history'));
  assert.deepEqual(histories.map((request) => request.searchParams.get('hostId')), ['alpha', 'beta']);
  for (const request of histories) {
    assert.equal(request.searchParams.get('limit'), '2000');
    assert.equal(NOW - Date.parse(request.searchParams.get('from')), 6 * 3600000);
  }
  const trend = browser.elements['#gpuTrend'].innerHTML;
  const [read, unread] = trend.split('<tr><th scope="row"').slice(1);
  assert.match(read, /Alpha<br><span class="muted">#0 Example RTX 3090/);
  const summary = /mean 39\.2% · min 5% · max 90% · latest 5% at /;
  assert.match(read, summary, 'the summary is visible text');
  assert.match(read, /<svg class="sparkline" viewBox="0 0 240 36" width="240" height="36" role="img" aria-label="Utilisation of Alpha #0 Example RTX 3090 over the last 6\.0 h: mean 39\.2% · min 5% · max 90% · latest 5% at [^"]+"><title>/);
  // Samples 4 to 7 are missing: two separate lines, not one drawn across the hole.
  assert.equal(read.match(/<polyline/g).length, 2);
  assert.match(read, /6 samples over 45 min/);
  assert.match(unread, /#1 Example RTX 3090/);
  assert.match(unread, /<td>—<\/td>\s*<td>utilisation was not read/);
  assert.doesNotMatch(unread, /<svg/);
});

test('one failed read leaves a notice in its section and the others on screen', async () => {
  const browser = await openGpu(liveLike({ '/hardware/occupancy': new Error('Data service request timed out') }));
  const html = browser.content.innerHTML;
  assert.doesNotMatch(html, /Data projection unavailable/);
  assert.match(html, /<section id="gpuOccupancy"><div class="notice warning">GPU occupancy could not be read from Data: Data service request timed out\./);
  assert.match(html, /<h3>Alpha<\/h3><span class="pill good">fresh/);
  assert.match(html, /<h3>example-gpu-agent<\/h3><span class="pill good">active/);
  assert.match(browser.elements['#gpuTrend'].innerHTML, /<svg class="sparkline"/);

  // Without the latest snapshot, the hosts for the trend come from the collector.
  const blind = await openGpu(liveLike({ '/hardware/latest': new Error('fetch failed') }));
  assert.match(blind.content.innerHTML, /<section id="gpuNow" aria-live="off"><div class="notice warning">The current GPU state could not be read from Data: fetch failed\./);
  assert.doesNotMatch(blind.content.innerHTML, /pill good">fresh/);
  assert.match(blind.content.innerHTML, /99\.9% observed/);
  assert.match(blind.elements['#gpuTrend'].innerHTML, /<svg class="sparkline"/);

  // One host's history failing keeps the other host's row.
  const partial = await openGpu((route, query) => route === '/hardware/history' && query.get('hostId') === 'beta'
    ? new Error('history unavailable') : liveLike()(route));
  assert.match(partial.elements['#gpuTrend'].innerHTML, /Beta<\/th><td colspan="2" class="warn">History could not be read: history unavailable/);
  assert.match(partial.elements['#gpuTrend'].innerHTML, /<svg class="sparkline"/);
});

test('no collector and no host are empty states, not errors', async () => {
  const browser = await openGpu(liveLike({
    '/hardware/latest': latestBody([]), '/hardware/collectors': { collectors: [], active: 0 },
    '/hardware/occupancy': { ...occupancyBody, hosts: [] }
  }));
  const html = browser.content.innerHTML;
  assert.match(html, /No GPU host has reported to Data yet/);
  assert.match(html, /No GPU collector registered/);
  assert.match(html, /No GPU is known to Data for this window/);
  assert.match(browser.elements['#gpuTrend'].innerHTML, /No GPU host is known, so there is no history to read/);
  assert.equal(browser.requests.filter((request) => request.pathname.endsWith('/hardware/history')).length, 0);
});

test('the collector card lists id, version, interval, last heartbeat and activity', async () => {
  const browser = await openGpu();
  const card = browser.content.innerHTML.match(/<section id="gpuCollector">(.*?)<\/section>/s)[1];
  assert.match(card, /class="card collector-card"/);
  assert.match(card, /<h3>example-gpu-agent<\/h3><span class="pill good">active<\/span>/);
  assert.match(card, /Runs on<\/span><strong>Alpha · linux/);
  assert.match(card, /Interval<\/span><strong>30 s/);
  assert.match(card, /Last seen<\/span><strong>[^<]+<span class="muted">19s ago/);
  assert.match(card, /Hosts read<\/span><strong>Alpha, Beta/);
  assert.match(card, /Collector version<\/span><strong class="mono">gpu-1\.1\.0/);
});

test('the 30 s refresh replaces only "Now", and only on a visible GPU tab', async () => {
  let hosts = [freshHost()];
  const browser = await openGpu((route) => route === '/hardware/latest' ? latestBody(hosts) : liveLike()(route));
  assert.equal(browser.timers.length, 1);
  assert.equal(browser.timers[0].ms, 30000);
  const whole = browser.content.innerHTML;
  const count = () => browser.requests.length;

  hosts = [staleHost()];
  let before = count();
  await browser.timers[0].callback();
  assert.equal(count(), before + 1);
  assert.match(browser.requests.at(-1).pathname, /\/hardware\/latest$/);
  assert.match(browser.elements['#gpuNow'].innerHTML, /<h3>Beta<\/h3><span class="pill warn">stale/);
  assert.equal(browser.content.innerHTML, whole, 'occupancy, trend and collector are not redrawn');

  // Data going away replaces the numbers with a notice instead of keeping them.
  hosts = null;
  await browser.refreshGpuNow();
  assert.match(browser.elements['#gpuNow'].innerHTML, /The current GPU state could not be read from Data/);
  assert.doesNotMatch(browser.elements['#gpuNow'].innerHTML, /<table/);

  hosts = [freshHost()];
  browser.document.hidden = true;
  before = count();
  await browser.timers[0].callback();
  assert.equal(count(), before, 'a hidden page asks nothing');
  browser.document.hidden = false;
  browser.listeners.visibilitychange[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count(), before + 1, 'becoming visible refreshes at once');
  assert.match(browser.elements['#gpuNow'].innerHTML, /pill good">fresh/);

  // On another tab the timer stops without asking.
  browser.state.tab = 'storage';
  before = count();
  await browser.timers[0].callback();
  assert.equal(count(), before);
  assert.deepEqual(browser.cleared, [1]);
  assert.equal(browser.gpuRefresher.timer, null);
});

test('a slow GPU answer never writes into another tab', async () => {
  let release;
  let slow = false;
  const browser = await openGpu(async (route) => {
    if (slow && route === '/hardware/latest') await new Promise((resolve) => { release = resolve; });
    return liveLike()(route);
  });
  slow = true;
  const settledNow = browser.document.querySelector('#gpuNow').innerHTML = 'storage tab content';
  const pending = browser.refreshGpuNow();
  browser.state.tab = 'storage';
  release();
  await pending;
  assert.equal(browser.elements['#gpuNow'].innerHTML, settledNow);

  // Same tab, but a newer render owns the page: the old answer is dropped too.
  browser.state.tab = 'gpu';
  const second = browser.refreshGpuNow();
  browser.state.renderSeq += 1;
  release();
  await second;
  assert.equal(browser.elements['#gpuNow'].innerHTML, settledNow);

  // A whole GPU render that resolves after the tab changed paints nothing.
  const late = gpuBrowser(async (route) => {
    if (route === '/hardware/latest') await new Promise((resolve) => { release = resolve; });
    return liveLike()(route);
  });
  const rendering = late.render();
  late.state.tab = 'storage';
  late.content.innerHTML = 'storage tab content';
  release();
  await rendering;
  assert.equal(late.content.innerHTML, 'storage tab content');
  assert.equal(late.timers.length, 0);
});

test('a stale render no longer reports its failure over the current tab', async () => {
  let fail;
  const browser = gpuBrowser(async (route) => {
    if (route === '/status') return new Promise((_resolve, reject) => { fail = () => reject(new Error('late failure')); });
    return liveLike()(route);
  });
  browser.location.hash = '#overview';
  const overview = browser.render();
  browser.location.hash = '#gpu';
  await browser.render();
  fail();
  await overview;
  assert.match(browser.content.innerHTML, /GPU telemetry/);
  assert.doesNotMatch(browser.content.innerHTML, /Data projection unavailable|late failure/);
});

async function relayed(query) {
  const express = require('express');
  const request = require('supertest');
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(new URL(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', data: {} }) };
  };
  try {
    const app = express();
    toolbox.register({ contractVersion: 2, app, express });
    await request(app).get(`/api/data-toolbox/hardware/${query}`).expect(200);
  } finally { global.fetch = original; }
  assert.equal(calls.length, 1);
  return calls[0];
}

test('the history relay keeps Data\'s parameters within Data\'s bounds and drops the rest', async () => {
  const from = '2026-10-08T16:35:33.000Z';
  let url = await relayed(`history?hostId=alpha&gpuIndex=1&from=${from}&to=2026-10-08T22:35:33.000Z&limit=720&collectorId=x&sort=asc&projection=secret`);
  assert.equal(url.pathname, '/api/v1/hardware/history');
  assert.deepEqual(Object.fromEntries(url.searchParams), { hostId: 'alpha', gpuIndex: '1', from, to: '2026-10-08T22:35:33.000Z', limit: '720' });

  url = await relayed(`history?hostId=${'h'.repeat(300)}&gpuIndex=-3&limit=999999&from=${'9'.repeat(200)}`);
  assert.equal(url.searchParams.get('hostId').length, 128);
  assert.equal(url.searchParams.get('gpuIndex'), '0');
  assert.equal(url.searchParams.get('limit'), '2000');
  assert.equal(url.searchParams.get('from').length, 80);

  url = await relayed('history?hostId=alpha&limit=0&gpuIndex=4096');
  assert.equal(url.searchParams.get('limit'), '1');
  assert.equal(url.searchParams.get('gpuIndex'), '255');
  url = await relayed('history?hostId=alpha&limit=many&hostId=beta');
  assert.equal(url.searchParams.get('limit'), '500');
  assert.equal(url.searchParams.get('hostId'), 'alpha');
  assert.equal((await relayed('history')).search, '');
});

test('the occupancy relay keeps the window, host and busy threshold only', async () => {
  let url = await relayed('occupancy?from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z&hostId=alpha&busyAtPct=25&limit=5&gpuIndex=1&$where=1');
  assert.equal(url.pathname, '/api/v1/hardware/occupancy');
  assert.deepEqual(Object.fromEntries(url.searchParams), { hostId: 'alpha', from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', busyAtPct: '25' });
  assert.equal((await relayed('occupancy?busyAtPct=0')).searchParams.get('busyAtPct'), '1');
  assert.equal((await relayed('occupancy?busyAtPct=250')).searchParams.get('busyAtPct'), '100');
  assert.equal((await relayed('occupancy?busyAtPct=high')).searchParams.get('busyAtPct'), '10');
  assert.equal((await relayed('occupancy')).search, '');
});

test('a Data refusal or outage reaches the page as an error envelope', async (t) => {
  const express = require('express');
  const request = require('supertest');
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const app = express();
  toolbox.register({ contractVersion: 2, app, express });
  global.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ status: 'error', message: 'from must precede to by at most 90 days' }) });
  const refused = await request(app).get('/api/data-toolbox/hardware/occupancy?from=2020-01-01').expect(400);
  assert.equal(refused.body.message, 'from must precede to by at most 90 days');
  global.fetch = async () => { throw new Error('fetch failed'); };
  const down = await request(app).get('/api/data-toolbox/hardware/history?hostId=alpha').expect(502);
  assert.equal(down.body.code, 'DATA_UNAVAILABLE');
  await request(app).post('/api/data-toolbox/hardware/samples').send({}).expect(404);
  await request(app).post('/api/data-toolbox/hardware/collector/heartbeat').send({}).expect(404);
});
