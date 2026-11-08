'use strict';

// Real host/live controllers against isolated HTTP fixtures; no model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const core = path.resolve(__dirname, '../..');
const report = process.env.OPERATIONS_REPORT_DIR;
if (!report || path.resolve(report).startsWith(path.resolve(core, '..') + path.sep)) {
  throw new Error('Set OPERATIONS_REPORT_DIR outside Git.');
}
fs.mkdirSync(report, { recursive: true });

const hosts = [
  { id: 'gpu-a', name: 'Test machine A', url: 'http://machine-a.test:11434', source: 'env', residency: 'gpu', available: true },
  { id: 'cpu-a', name: 'Test machine A CPU', url: 'http://machine-a.test:11435', source: 'env', residency: 'cpu', available: true },
  { id: 'gpu-b', name: 'Test machine B', url: 'http://machine-b.test:11434', source: 'env', residency: 'gpu', available: true }
];
let state = 'playing', revision = 0, busy = true;
const writes = [];
function control(host) {
  return host.id === 'gpu-b' ? { state: 'playing', revision: 0, blockers: [] }
    : { state, revision, blockers: state === 'draining' ? [{ type: 'inference' }] : [] };
}
let server, browser;
(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.static(core + '/public'));
  app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/css/nerve-center.css"><link rel="stylesheet" href="/css/nerve-center-controls.css">
    <link rel="stylesheet" href="/css/nerve-center-live.css"><style>body{margin:20px;background:#111827;color:#eee}button{cursor:pointer}</style>
    </head><body><main><h1>Host control</h1><section id="sectionLiveBody" class="nc-section-body"></section>
    <section><h2>Inference endpoints</h2><span id="nc-hosts-summary"></span><div id="sectionHostsBody" class="nc-section-body"></div></section></main>
    <script>
      window.NerveCenterShared = {
        fetchJson: async (url, options) => { const response = await fetch(url, options); const json = await response.json();
          if (!response.ok) throw Error(json.message); return json; },
        escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
        normalizeHostUrl: value => String(value).replace(/\\/+$/, ''), shortModel: value => value, timeAgo: () => 'now',
        renderSectionLoading() {}, finishSectionLoad() {}, renderSectionError: (body, message) => { body.textContent = message; }
      };
    </script><script src="/js/nerve-center-hosts.js"></script><script src="/js/nerve-center-live.js"></script>
    <script>window.NerveCenterLive.loadLive();</script></body></html>`));
  app.get('/api/nerve-center/inference-hosts', (_req, res) => res.json({ status: 'success', data: { hosts: hosts.map(host => ({ ...host, control: control(host) })) } }));
  app.post('/api/nerve-center/inference-hosts/:hostId/control', (req, res) => {
    writes.push(req.body);
    if (req.body.expectedRevision !== revision) return res.status(409).json({ message: 'Host control changed.' });
    revision++;
    state = req.body.action === 'play' ? 'playing' : busy ? 'draining' : 'paused';
    return res.json({ status: 'success', data: { control: control(hosts[0]) } });
  });
  app.get('/api/ollama-hosts', (_req, res) => res.json({ data: { hosts } }));
  app.get('/api/nerve-center/host-preferences', (_req, res) => res.json({ data: hosts.map(host => ({ hostUrl: host.url, pinnedModels: [], live: { online: true, runningModels: [] } })) }));
  app.get('/api/nerve-center/inference/gpu-status', (_req, res) => res.json({ data: [] }));
  app.get('/api/nerve-center/runtime-topology', (_req, res) => res.json({ status: 'success', data: { configured: false, valid: true } }));
  app.get('/api/cluster/schedule/heavy-queue', (_req, res) => res.json({ data: { jobs: [] } }));
  app.get('/api/nerve-center/inference-health', (_req, res) => res.json({ data: { benchmarkClaims: [] } }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.goto(base);
  const card = page.locator('.nc-live-host-control[data-host-id="gpu-a"]');
  await card.getByRole('button', { name: 'Pause AgentX on Test machine A', exact: true }).click();
  await card.getByRole('status').filter({ hasText: 'Draining' }).waitFor();
  assert.equal(writes[0].action, 'pause');
  assert.equal(writes[0].expectedRevision, 0);
  assert.match(writes[0].requestId, /^[a-f0-9-]{36}$/);
  busy = false; state = 'paused';
  await card.getByRole('status').filter({ hasText: 'Paused — manual use' }).waitFor();
  assert.equal(await page.locator('tr[data-host-id="cpu-a"] [role="status"]').innerText(), 'Paused — manual use');
  assert.equal(await page.locator('.nc-live-host-control[data-host-id="gpu-b"] [role="status"]').innerText(), 'AgentX in control');
  await page.screenshot({ path: path.join(report, 'desktop-paused.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(report, 'mobile-paused.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile must fit the viewport');
  await card.getByRole('button', { name: 'Play AgentX on Test machine A', exact: true }).click();
  await card.getByRole('status').filter({ hasText: 'AgentX in control' }).waitFor();
  assert.equal(writes[1].expectedRevision, 1);
  assert.equal(writes[1].action, 'play');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(report, 'result.json'), JSON.stringify({ passed: true, writes: writes.length,
    checks: ['live-card Pause', 'draining poll', 'all-lane state', 'other machine', 'mobile fit', 'live-card Play', 'no page errors'] }, null, 2));
  console.log('Host control browser journey passed; evidence: ' + report);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
