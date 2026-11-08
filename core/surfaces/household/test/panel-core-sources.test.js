'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPanelCoreSources } = require('../panel-core-sources');
const { fleetSummary } = require('../panel-sources');

const snapshot = {
  health: { status: 'ok', configuredHosts: 1, onlineHosts: 1, observedModels: 1 },
  cluster: [{ hostKey: 'primary', status: 'online', models: ['synthetic'], hostUrl: 'PRIVATE_HOST' }],
  operationalAttention: { issues: [] }, recentRouting: [{ prompt: 'PRIVATE_PROMPT' }]
};

function setup(t, corePanelReads, configuredUrl) {
  const previous = process.env.CORE_INTERNAL_URL;
  if (configuredUrl === undefined) delete process.env.CORE_INTERNAL_URL;
  else process.env.CORE_INTERNAL_URL = configuredUrl;
  t.after(() => {
    if (previous === undefined) delete process.env.CORE_INTERNAL_URL;
    else process.env.CORE_INTERNAL_URL = previous;
  });
  const calls = [];
  t.mock.method(global, 'fetch', async url => {
    calls.push(String(url));
    throw new Error('synthetic transport unavailable');
  });
  return { calls, sources: createPanelCoreSources({ corePanelReads,
    CORE_SELF_URL: () => String(process.env.CORE_INTERNAL_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '') }) };
}

test('native readers retain the fleet projection when self transport is unavailable', async t => {
  const { sources, calls } = setup(t, { health: async () => ({ ok: true }), ecosystem: async () => snapshot });
  const [core, fleet] = await Promise.all([sources.health(), sources.ecosystem()]);
  assert.equal(core.status, 'ok');
  assert.deepEqual(fleet, { ...fleetSummary(snapshot), latencyMs: fleet.latencyMs });
  assert.doesNotMatch(JSON.stringify(fleet), /PRIVATE_HOST|PRIVATE_PROMPT/);
  assert.deepEqual(calls, []);
});

for (const configuredUrl of ['http://remote-core.example.test:9080/base/', 'http://127.0.0.1:3080']) {
  test(`explicit destination ${configuredUrl} keeps HTTP even with native readers`, async t => {
    const { sources, calls } = setup(t, {
      health: () => assert.fail('native health must not replace a configured destination'),
      ecosystem: () => assert.fail('native ecosystem must not replace a configured destination')
    }, configuredUrl);
    t.mock.method(global, 'fetch', async url => {
      calls.push(String(url));
      return new Response(JSON.stringify(String(url).endsWith('/health') ? { ok: false } : { data: snapshot }),
        { status: String(url).endsWith('/health') ? 503 : 200 });
    });
    const [core, fleet] = await Promise.all([sources.health(), sources.ecosystem()]);
    assert.equal(core.status, 'down');
    assert.deepEqual(fleet, { ...fleetSummary(snapshot), latencyMs: fleet.latencyMs });
    assert.deepEqual(calls, [`${configuredUrl.replace(/\/+$/, '')}/health`,
      `${configuredUrl.replace(/\/+$/, '')}/api/nerve-center/ecosystem`]);
  });
}

test('an unavailable explicit destination is not replaced by local evidence', async t => {
  const { sources, calls } = setup(t, { health: () => assert.fail(), ecosystem: () => assert.fail() },
    'http://remote-core.example.test');
  const [core, fleet] = await Promise.all([sources.health(), sources.ecosystem()]);
  assert.equal(core.status, 'down');
  assert.equal(fleet.status, 'degraded');
  assert.equal(calls.length, 2);
});

test('mounts without native readers retain both HTTP reads', async t => {
  const { sources, calls } = setup(t);
  const [core, fleet] = await Promise.all([sources.health(), sources.ecosystem()]);
  assert.equal(core.status, 'down');
  assert.equal(fleet.status, 'degraded');
  assert.equal(calls.length, 2);
});

for (const missing of ['health', 'ecosystem']) {
  test(`only the missing ${missing} reader falls back to HTTP`, async t => {
    const readers = { health: async () => ({ ok: true }), ecosystem: async () => snapshot };
    delete readers[missing];
    const { sources, calls } = setup(t, readers);
    const [core, fleet] = await Promise.all([sources.health(), sources.ecosystem()]);
    assert.equal(core.status, missing === 'health' ? 'down' : 'ok');
    assert.equal(fleet.status, missing === 'ecosystem' ? 'degraded' : 'ok');
    assert.deepEqual(calls, [missing === 'health' ? 'http://127.0.0.1:3080/health'
      : 'http://127.0.0.1:3080/api/nerve-center/ecosystem']);
  });
}

for (const health of [null, {}, { ok: false }, { ok: 'true' }]) {
  test(`missing or nonhealthy Core evidence stays down: ${JSON.stringify(health)}`, async t => {
    const { sources, calls } = setup(t, { health: async () => health, ecosystem: async () => ({}) });
    assert.equal((await sources.health()).status, 'down');
    const fleet = await sources.ecosystem();
    assert.equal(fleet.status, 'degraded');
    assert.equal(fleet.configuredHosts, 0);
    assert.deepEqual(calls, []);
  });
}

for (const failed of ['health', 'ecosystem']) {
  test(`native ${failed} failure is partial, sanitized, and never retried over HTTP`, async t => {
    const readers = { health: async () => ({ ok: true }), ecosystem: async () => snapshot };
    readers[failed] = () => { throw new Error('PRIVATE_COLLECTOR_ERROR'); };
    const { sources, calls } = setup(t, readers);
    const [core, fleet] = await Promise.all([sources.health(), sources.ecosystem()]);
    assert.equal(core.status, failed === 'health' ? 'down' : 'ok');
    assert.equal(fleet.status, failed === 'ecosystem' ? 'degraded' : 'ok');
    assert.equal((failed === 'health' ? core : fleet).error,
      failed === 'health' ? 'Core health is unavailable.' : 'Ecosystem snapshot is unavailable.');
    assert.doesNotMatch(JSON.stringify({ core, fleet }), /PRIVATE_COLLECTOR_ERROR/);
    assert.deepEqual(calls, []);
  });
}

test('each native read keeps its own deadline and late settlements cannot change the result', async t => {
  let finishHealth, failEcosystem;
  const { sources, calls } = setup(t, {
    health: () => new Promise(resolve => { finishHealth = resolve; }),
    ecosystem: () => new Promise((_, reject) => { failEcosystem = reject; })
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const corePending = sources.health();
  const fleetPending = sources.ecosystem();
  let fleetSettled = false;
  fleetPending.then(() => { fleetSettled = true; });
  await Promise.resolve();
  t.mock.timers.tick(5000);
  const core = await corePending;
  assert.equal(core.status, 'down');
  assert.equal(core.latencyMs, 5000);
  assert.match(core.error, /timed out after 5000ms/);
  assert.equal(fleetSettled, false);
  t.mock.timers.tick(3000);
  const fleet = await fleetPending;
  assert.equal(fleet.status, 'degraded');
  assert.equal(fleet.latencyMs, 8000);
  assert.match(fleet.error, /timed out after 8000ms/);
  finishHealth({ ok: true });
  failEcosystem(new Error('PRIVATE_LATE_ERROR'));
  await Promise.resolve();
  assert.equal(core.status, 'down');
  assert.equal(fleet.status, 'degraded');
  assert.deepEqual(calls, []);
});
