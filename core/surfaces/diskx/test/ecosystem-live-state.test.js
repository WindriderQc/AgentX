'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { validateConfig, projectSnapshot, createLiveState, LIVE_MS, RETAIN_MS } = require('../../../src/services/ecosystemLiveState');
const { createPresentationReader, PRESENTATION_TOOL_HANDLERS } = require('../../../src/services/presentationReadService');
const createRouter = require('../../../routes/nerve-center-ecosystem-live');
const { allowedForFamilyDevice } = require('../../household/family-device');

const NOW = Date.parse('2030-01-02T12:00:00.000Z');
const iso = time => new Date(time).toISOString();
const config = () => ({ version: 1, nodes: [
  { id: 'compute', hosts: ['endpoint-a', 'endpoint-b'] },
  { id: 'service', services: ['service-a'] },
  { id: 'unobserved', hosts: ['endpoint-missing'] }
] });
function snapshot(at = NOW) {
  return { authority: 'agentx-product', readOnly: true, schemaVersion: 2, generatedAt: iso(at),
    cluster: ['endpoint-a', 'endpoint-b'].map(hostKey => ({ hostKey, status: 'online', checkedAt: iso(at - 1000),
      url: 'https://private-fixture.invalid', model: 'private-fixture-model', error: 'private-fixture-log' })),
    services: [{ id: 'service-a', status: 'ok', identity: { ts: iso(at - 2000) }, secret: 'private-fixture-secret' }],
    hostPreferences: [], evidenceTrust: { status: 'consistent' }, privateInventory: 'private-fixture-inventory' };
}
function display(at, read, changes = {}) {
  return { application: 'ecosystem', presentationId: 'fixture-display',
    instance: '11111111-1111-4111-8111-111111111111', sequence: 1, version: 'a'.repeat(64),
    documentRevision: 1, snapshot: '2030-01-02', mountedAt: iso(NOW - 1000), observedAt: iso(at),
    tour: { script: 'memory', index: 0, count: 1, kind: 'node', label: 'Compute', title: 'Compute', playing: false, adhoc: 'node-compute' },
    focus: [{ id: 'compute', label: 'Compute' }],
    selection: { id: 'compute', label: 'Compute', description: 'Synthetic compute node.' },
    narration: 'Synthetic description.', narrationComplete: true,
    live: { status: 'available', read }, ...changes };
}

test('projection returns every configured node with independently dated, bounded evidence', () => {
  const value = projectSnapshot(snapshot(), config(), NOW);
  assert.deepEqual(value.nodes.map(node => node.id), ['compute', 'service', 'unobserved']);
  assert.deepEqual(value.nodes.map(node => node.state), ['online', 'online', 'unknown']);
  assert.deepEqual(value.nodes.map(node => node.freshness), ['current', 'current', 'unknown']);
  assert.equal(value.nodes[0].observedAt, iso(NOW - 1000));
  assert.equal(value.nodes[1].observedAt, iso(NOW - 2000));
  assert.equal(value.nodes[2].observedAt, null);
  assert.equal(value.nodes[2].expiresAt, null);
  assert.equal(value.expiresAt, iso(NOW + LIVE_MS));
  assert.doesNotMatch(JSON.stringify(value), /private-fixture|"(?:url|hostKey|hostPreferences|secret|model|error)":/);
  assert.deepEqual(Object.keys(value.nodes[0]).sort(), ['expiresAt', 'freshness', 'id', 'observedAt', 'source', 'state']);
});

test('a fresh aggregation never renews stale, missing, future or partial collector observations', () => {
  const old = snapshot();
  old.cluster[0].checkedAt = iso(NOW - 121000);
  const value = projectSnapshot(old, config(), NOW);
  assert.equal(value.nodes[0].freshness, 'stale');
  assert.equal(value.nodes[0].observedAt, iso(NOW - 121000));
  assert.ok(Date.parse(value.nodes[0].expiresAt) < NOW);
  for (const checkedAt of [undefined, 'invalid', '2030-02-30T12:00:00.000Z', iso(NOW + 6000)]) {
    const incomplete = snapshot(); incomplete.cluster[1].checkedAt = checkedAt;
    const node = projectSnapshot(incomplete, config(), NOW).nodes[0];
    assert.equal(node.freshness, 'unknown'); assert.equal(node.observedAt, null);
  }
  const missingServiceTime = snapshot(); delete missingServiceTime.services[0].identity;
  assert.equal(projectSnapshot(missingServiceTime, config(), NOW).nodes[1].freshness, 'unknown');
});

test('native occupation and endpoint state remain distinct from guessed load or task execution', () => {
  for (const status of ['restoring', 'swapping', 'benchmarking']) {
    const busy = snapshot(); busy.hostPreferences = [{ hostKey: 'endpoint-a', status, task: 'private-fixture-task' }];
    assert.equal(projectSnapshot(busy, config(), NOW).nodes[0].state, 'busy');
  }
  const speculative = snapshot();
  speculative.cluster[0].gpuLoad = 100;
  speculative.hostPreferences = [{ hostKey: 'endpoint-a', status: 'planned' }];
  assert.equal(projectSnapshot(speculative, config(), NOW).nodes[0].state, 'online');
  speculative.cluster[0].status = 'offline';
  assert.equal(projectSnapshot(speculative, config(), NOW).nodes[0].state, 'degraded');
  speculative.cluster[1].status = 'offline';
  assert.equal(projectSnapshot(speculative, config(), NOW).nodes[0].state, 'offline');
  speculative.cluster.forEach(row => { row.status = 'parked'; });
  assert.equal(projectSnapshot(speculative, config(), NOW).nodes[0].state, 'parked');
  speculative.services[0].status = 'down';
  assert.equal(projectSnapshot(speculative, config(), NOW).nodes[1].state, 'offline');
});

test('a failed native service probe uses its own dated source even when no service identity was received', () => {
  const failed = snapshot();
  failed.services[0] = { id: 'service-a', status: 'down', identity: null };
  failed.evidence = { servicesObservedAt: iso(NOW - 2000) };
  const node = projectSnapshot(failed, config(), NOW).nodes[1];
  assert.equal(node.state, 'offline'); assert.equal(node.freshness, 'current');
  assert.equal(node.observedAt, iso(NOW - 2000));
  failed.evidence.servicesObservedAt = iso(NOW - 121000);
  assert.equal(projectSnapshot(failed, config(), NOW).nodes[1].freshness, 'stale');
  delete failed.evidence;
  const undated = projectSnapshot(failed, config(), NOW).nodes[1];
  assert.equal(undated.freshness, 'unknown'); assert.equal(undated.observedAt, null);
  failed.evidence = { servicesObservedAt: iso(NOW - 1000) };
  failed.services[0].identity = { ts: 'invalid' };
  assert.equal(projectSnapshot(failed, config(), NOW).nodes[1].freshness, 'unknown', 'invalid native dates are not replaced by a newer source date');
});

test('contradictory observations cannot establish current operational state', () => {
  for (const status of ['contradictory', 'inconsistent']) {
    const input = snapshot(); input.evidenceTrust.status = status;
    for (const node of projectSnapshot(input, config(), NOW).nodes) {
      assert.equal(node.state, 'unknown'); assert.equal(node.freshness, 'unknown');
    }
  }
});

test('source identity, completeness and aggregation freshness are required before publication', () => {
  for (const changes of [{ authority: 'browser' }, { readOnly: false }, { schemaVersion: 1 },
    { generatedAt: 'invalid' }, { generatedAt: '2030-02-30T12:00:00.000Z' }, { cluster: null }, { services: null }]) {
    assert.throws(() => projectSnapshot({ ...snapshot(), ...changes }, config(), NOW), { code: 'ECOSYSTEM_LIVE_SOURCE_INVALID' });
  }
  for (const at of [NOW - LIVE_MS - 1, NOW + 5001]) {
    assert.throws(() => projectSnapshot(snapshot(at), config(), NOW), { code: 'ECOSYSTEM_LIVE_SOURCE_STALE' });
  }
});

test('configuration refuses ambiguous mappings, duplicates, unbounded or private-shaped input', () => {
  const invalid = [null, {}, { version: 2, nodes: [] }, { version: 1, nodes: [], outside: true },
    { version: 1, nodes: Array.from({ length: 33 }, (_, i) => ({ id: 'node-' + i, hosts: ['endpoint-' + i] })) },
    ...[
      [{ id: 'node-a', hosts: [] }], [{ id: 'node-a', hosts: ['endpoint-a', 'endpoint-a'] }],
      [{ id: 123, hosts: ['endpoint-a'] }], [{ id: true, hosts: ['endpoint-a'] }],
      [{ id: 'node-a', hosts: [456] }], [{ id: 'node-a', services: [true] }],
      [{ id: 'node-a', hosts: ['endpoint-a'], services: ['service-a'] }],
      [{ id: 'node-a', hosts: null, services: ['service-a'] }],
      [{ id: 'node-a', hosts: ['endpoint-a'], services: null }],
      [{ id: 'node-a', hosts: ['https://private-fixture.invalid'] }],
      [{ id: 'node-a', hosts: ['endpoint-a'], url: 'https://private-fixture.invalid' }],
      [{ id: 'node-a', services: 'service-a' }], [{ id: 'node-a' }],
      [{ id: 'node-a', hosts: ['endpoint-a'] }, { id: 'node-a', services: ['service-a'] }],
      [{ id: 'node-a', hosts: ['endpoint-a'] }, { id: 'node-b', hosts: ['endpoint-a'] }],
      [{ id: 'node-a', hosts: Array.from({ length: 9 }, (_, i) => 'endpoint-' + i) }]
    ].map(nodes => ({ version: 1, nodes }))];
  for (const input of invalid) assert.throws(() => validateConfig(input), { code: 'ECOSYSTEM_LIVE_CONFIG_INVALID' }, JSON.stringify(input));
  const input = config(), copied = validateConfig(input);
  copied.nodes[0].hosts.push('endpoint-c');
  assert.equal(input.nodes[0].hosts.length, 2);
});

test('parallel reads share one build and short cache hits do not move evidence time', async () => {
  let now = NOW, builds = 0, finish;
  const reader = createPresentationReader({ now: () => now });
  const read = createLiveState({ config, now: () => now, reader,
    buildSnapshot: () => { builds++; return new Promise(resolve => { finish = resolve; }); } });
  const first = read(), second = read();
  assert.equal(builds, 1); finish(snapshot());
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.read.id, two.read.id);
  now += 4000;
  const cached = await read();
  assert.equal(builds, 1); assert.equal(cached.generatedAt, iso(NOW));
  assert.equal(cached.nodes[0].observedAt, iso(NOW - 1000));
  now += 1001;
  const refreshed = read(); assert.equal(builds, 2); finish(snapshot(now));
  assert.equal((await refreshed).generatedAt, iso(now));
});

test('a changed config invalidates shared work and an older completion cannot replace its cache', async () => {
  let mapping = config(), builds = 0;
  const pending = [];
  const read = createLiveState({ config: () => mapping, now: () => NOW, reader: createPresentationReader({ now: () => NOW }),
    buildSnapshot: () => { builds++; return new Promise(resolve => pending.push(resolve)); } });
  const old = read();
  mapping = { version: 1, nodes: [{ id: 'service', services: ['service-a'] }] };
  const current = read(); assert.equal(builds, 2);
  pending[1](snapshot()); const wanted = await current;
  pending[0](snapshot()); await old;
  assert.equal((await read()).read.id, wanted.read.id);
  assert.equal(builds, 2);
});

test('a failed build does not retain a poisoned pending request or invent a stale success', async () => {
  let attempts = 0;
  const read = createLiveState({ config, now: () => NOW, reader: createPresentationReader({ now: () => NOW }),
    buildSnapshot: async () => { if (++attempts === 1) throw new Error('private-fixture-log'); return snapshot(); } });
  await assert.rejects(read(), /private-fixture-log/);
  assert.equal((await read()).nodes.length, 3); assert.equal(attempts, 2);
  const notRetained = createLiveState({ config, now: () => NOW, buildSnapshot: async () => snapshot(),
    reader: { publishEcosystemLive: () => null } });
  await assert.rejects(notRetained(), { code: 'ECOSYSTEM_LIVE_NOT_RETAINED' });
});

test('Nestor reads the Core observation separately from the rendered selection and rejects forged references', () => {
  let now = NOW;
  const reader = createPresentationReader({ now: () => now });
  const reference = reader.publishEcosystemLive(projectSnapshot(snapshot(), config(), now));
  const observed = reader.observeEcosystem(display(now, reference), 'fixture-display');
  assert.equal(observed.status, 'available');
  const value = PRESENTATION_TOOL_HANDLERS.read_presentation(observed, { presentationReader: reader });
  assert.equal(value.source, 'graphysx.ecosystem'); assert.equal(value.selection.id, 'compute');
  assert.equal(value.observationOwner, 'browser_after_render');
  assert.equal(value.live.status, 'available'); assert.equal(value.live.data.source, 'core.ecosystem.live');
  assert.equal(value.live.data.nodes.length, 3);
  assert.doesNotMatch(JSON.stringify(value), /private-fixture/);
  const forged = { ...reference, id: 'view_' + 'b'.repeat(64), revision: 'b'.repeat(64) };
  const refused = reader.observeEcosystem(display(now, forged, { sequence: 2 }), 'fixture-display');
  assert.equal(refused.live.status, 'unavailable'); assert.equal(refused.live.reason, 'no_matching_core_live_read');
  const alteredTime = { ...reference, observedAt: iso(now + 1) };
  assert.equal(reader.observeEcosystem(display(now, alteredTime, { sequence: 3 }), 'fixture-display').live.status, 'unavailable');
  assert.equal(reader.read(observed).reason, 'superseded_display_observation');
  now += LIVE_MS + 1;
  const stale = reader.observeEcosystem(display(now, reference, { sequence: 4 }), 'fixture-display');
  assert.equal(stale.live.status, 'stale'); assert.equal(stale.live.data.freshness, 'stale');
  assert.equal(stale.live.data.nodes[0].effectiveFreshness, 'stale');
  assert.equal(stale.live.data.observedAt, iso(NOW));
  now += RETAIN_MS;
  assert.equal(reader.read(reference).status, 'unavailable');
  const expired = reader.observeEcosystem(display(now, reference, { sequence: 5 }), 'fixture-display');
  assert.equal(expired.live.status, 'unavailable');
});

test('the HTTP route is bounded, private and read-only; pinned family requests remain blocked', async () => {
  const app = express(); let builds = 0;
  app.use('/api/nerve-center', createRouter({ config, now: () => NOW,
    reader: createPresentationReader({ now: () => NOW }), buildSnapshot: async () => { builds++; return snapshot(); } }));
  const route = '/api/nerve-center/ecosystem/live';
  const answer = await request(app).get(route).expect(200);
  assert.equal(answer.headers['cache-control'], 'private, no-store');
  assert.equal(answer.body.status, 'success'); assert.equal(answer.body.data.nodes.length, 3);
  assert.doesNotMatch(answer.text, /private-fixture/);
  await request(app).get(route + '?url=https://private-fixture.invalid').expect(400);
  await request(app).post(route).expect(404);
  assert.equal(builds, 1);
  for (const method of ['GET', 'POST']) assert.equal(allowedForFamilyDevice({ method, path: route, query: {} }), false);
  const failing = express();
  failing.use('/api/nerve-center', createRouter({ config, now: () => NOW,
    reader: createPresentationReader(), buildSnapshot: async () => { throw new Error('private-fixture-log'); } }));
  const unavailable = await request(failing).get(route).expect(503);
  assert.equal(unavailable.headers['cache-control'], 'private, no-store');
  assert.doesNotMatch(unavailable.text, /private-fixture/);
});

test('an unconfigured instance fails before collecting or exposing any source data', async () => {
  const app = express();
  app.use('/api/nerve-center', createRouter({
    config: () => { throw Object.assign(new Error('not configured'), { code: 'ECOSYSTEM_LIVE_NOT_CONFIGURED' }); },
    buildSnapshot: async () => assert.fail('No instance mapping means no collector call'),
    reader: createPresentationReader({ now: () => NOW })
  }));
  const answer = await request(app).get('/api/nerve-center/ecosystem/live').expect(503);
  assert.equal(answer.body.code, 'ECOSYSTEM_LIVE_NOT_CONFIGURED');
  assert.equal(answer.headers['cache-control'], 'private, no-store');
  assert.equal(answer.body.data, undefined);
});
