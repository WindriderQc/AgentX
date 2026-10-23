'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresentationReader, presentationReader, analyticsSnapshot, TTL_MS } = require('../../../src/services/presentationReadService');
const { screenContext, presentationEvidence } = require('../screen-context');
const pages = require('../../../public/js/screen-pages').createCatalog([
  { id: 'analytics', label: 'Activity', href: '/analytics', mode: 'frame' },
  { id: 'service', label: 'Service', href: 'https://service.test', mode: 'link' }
]);
function summary(window = '7d') {
  return { source: 'inferencelogs', window: { key: window, from: new Date(Date.now() - 86400000), to: new Date() },
    totals: { calls: 42, errors: 2, tokensOut: 1200, avgLatencyMs: null },
    byModel: [{ model: 'local/example', host: 'PRIVATE_HOST', calls: 42, tokensOut: 1200 }],
    byBucket: [{ date: '2026-01-01T00:00:00Z', calls: 42 }], byConsumerContract: [], topErrors: [],
    cloud: { estimatedCostUsd: null, unpricedModels: ['example'] }, coverage: { modelCount: 1, retentionDays: 30 } };
}
const row = (extra = {}) => ({ contract: 'agentx.presentation/v1', id: 'content-1', revision: 'content-1',
  kind: 'page', page: 'analytics', status: 'visible', title: 'Activity', filters: { window: '7d' }, ...extra });

test('read receipt retains exact values, nulls, units and scope without source internals', () => {
  const reader = createPresentationReader(), data = summary(), ref = reader.publishAnalytics(data);
  const read = reader.read(ref);
  assert.equal(read.totals.calls, 42); assert.equal(read.totals.avgLatencyMs, null);
  assert.equal(read.units.tokensOut, 'tokens'); assert.equal(read.units.avgLatencyMs, 'ms');
  assert.equal(read.filters.window, '7d'); assert.equal(read.cloud.estimatedCostUsd, null);
  assert.equal(read.period.to, data.window.to.toISOString());
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE_HOST/);
  data.totals.calls = 999; read.totals.calls = 999;
  assert.equal(reader.read(ref).totals.calls, 42, 'receipt is immutable across callers');
});

test('expired, evicted, restarted and mismatched reads never re-query a source', () => {
  let at = Date.now(); const reader = createPresentationReader({ now: () => at, capacity: 1 });
  const ref = reader.publishAnalytics(summary());
  assert.equal(reader.read({ ...ref, revision: 'a'.repeat(64) }).reason, 'revision_mismatch');
  at += TTL_MS + 1;
  assert.equal(reader.read(ref).reason, 'expired');
  const next = reader.publishAnalytics(summary('24h'));
  assert.equal(reader.read(ref).status, 'unavailable');
  assert.equal(createPresentationReader().read(next).status, 'unavailable');
  assert.equal(reader.read({ id: 'https://service.test/private' }).status, 'unavailable');
});

test('largest supported view remains bounded with explicit dimension coverage', () => {
  const data = summary('90d');
  data.byModel = Array.from({ length: 50 }, (_, n) => ({ model: 'model-' + n + 'x'.repeat(150), calls: n }));
  data.byBucket = Array.from({ length: 120 }, (_, n) => ({ date: '2026-01-01T00:00:00Z', calls: n }));
  const projected = analyticsSnapshot(data);
  assert.equal(projected.byModel.length, 40); assert.equal(projected.byBucket.length, 96);
  assert.equal(projected.coverage.bucketCount, 120);
  assert.ok(createPresentationReader().publishAnalytics(data), 'normal bounded views receive a usable reference');
  assert.ok(JSON.stringify(projected).length < 32768);
});

test('only the active, loaded view receives matching Core data; browser numbers are ignored', () => {
  const ref = presentationReader.publishAnalytics(summary());
  const input = row({ read: { ...ref, totals: { calls: 999 } }, password: 'PRIVATE_PASSWORD', body: 'PRIVATE_FORM',
    url: 'https://bad.test', selection: { groupBy: 'byConsumerContract', overlay: 'latency' } });
  const evidence = presentationEvidence([input, row({ title: 'OLD_PAGE' })], pages);
  assert.equal(evidence.read.totals.calls, 42); assert.equal(evidence.comparison, 'byConsumerContract');
  assert.equal(evidence.trend, 'latency');
  assert.doesNotMatch(screenContext([input], pages), /PRIVATE_PASSWORD|PRIVATE_FORM|bad.test|999/);
  assert.equal(presentationEvidence([row({ read: ref, filters: { window: '24h' } })], pages).read.status, 'unavailable');
  for (const status of ['loading', 'unavailable', 'external']) {
    const data = presentationEvidence([row({ status, read: ref })], pages);
    assert.equal(data.read, undefined); assert.equal(data.status, status);
  }
  assert.equal(presentationEvidence([], pages).status, 'none');
  assert.equal(presentationEvidence([row({ page: 'not-configured' })], pages), null);
});

test('selected notes are bounded; secrets and image pixels are never inferred', () => {
  const note = presentationEvidence([row({ kind: 'list', text: 'x'.repeat(9000), truncated: true, partial: true })], pages);
  assert.equal(note.text.length, 8000); assert.equal(note.partial, true); assert.equal(note.truncated, true);
  const secret = presentationEvidence([row({ kind: 'secret', text: 'PRIVATE_VALUE' })], pages);
  assert.equal(secret.status, 'unavailable'); assert.equal(secret.text, undefined);
  const image = presentationEvidence([row({ kind: 'image', text: 'imagined pixels' })], pages);
  assert.equal(image.observation, 'pixels_not_supplied'); assert.equal(image.text, undefined);
});

test('live reads use the displayed runtime/GPU sources with independent freshness and no host payloads', () => {
  let at = Date.now();
  const reader = createPresentationReader({ now: () => at });
  const runtime = reader.publishRuntime({ inferences: [
    { active: true, model: 'example', expiresAt: new Date(at + 60000).toISOString(), prompt: 'PRIVATE_PROMPT', host: 'PRIVATE_HOST' },
    { active: true, quarantined: true }
  ], workloads: [{ body: 'PRIVATE_WORKLOAD' }], maintenance: { owner: 'PRIVATE_OWNER' } });
  const gpu = { hostId: 'PRIVATE_ID', hostname: 'PRIVATE_HOST', telemetry: { status: 'fresh', collectorHostId: 'a', ageMs: 1000, staleAfterMs: 11000 },
    gpus: [{ index: 0, busId: 'PRIVATE_BUS', name: 'Example card', utilization: 42, vramUsed: 4000, vramTotal: 12000, powerDraw: 120 }] };
  const gpus = reader.publishGpus([gpu, { ...gpu, hostId: 'alias' }, { ...gpu, residency: 'cpu' },
    { hostId: 'stale', telemetry: { status: 'stale' }, gpus: [{ utilization: 99 }] }]);
  const read = reader.read(runtime), cards = reader.read(gpus);
  assert.equal(read.active, 1); assert.equal(read.uncertain, 1); assert.equal(read.workloads, 1);
  assert.equal(read.maintenance, true); assert.equal(read.filters, undefined);
  assert.equal(cards.count, 2); assert.equal(cards.gpus[0].utilization, 42);
  assert.equal(cards.gpus[1].fresh, false); assert.equal(cards.gpus[1].utilization, undefined);
  assert.equal(cards.units.vramUsed, 'MiB');
  assert.doesNotMatch(JSON.stringify({ read, cards }), /PRIVATE_/);
  at += 10001;
  assert.equal(reader.read(gpus).reason, 'expired', 'API read must not extend collector freshness');
  assert.equal(reader.read(runtime).status, 'available');
  at += 20000;
  assert.equal(reader.read(runtime).reason, 'expired');
});

test('selected live references resolve through Core and cannot be swapped with historical or browser data', () => {
  const ref = presentationReader.publishAnalytics(summary());
  const runtime = presentationReader.publishRuntime({ inferences: [], workloads: [] });
  const gpus = presentationReader.publishGpus([]);
  const input = row({ read: ref, live: { runtime: { status: 'visible', read: runtime, active: 999 }, gpus: { status: 'visible', read: gpus } } });
  const evidence = presentationEvidence([input], pages);
  assert.equal(evidence.liveRead.runtime.active, 0);
  assert.equal(evidence.liveRead.gpus.count, 0);
  input.live.runtime.read = ref;
  assert.equal(presentationEvidence([input], pages).liveRead.runtime.status, 'unavailable');
  input.live.runtime = { status: 'loading', read: runtime };
  assert.equal(presentationEvidence([input], pages).liveRead.runtime.reason, 'loading');
  input.live.gpus.status = 'unavailable';
  assert.equal(presentationEvidence([input], pages).liveRead.gpus.status, 'unavailable');
  assert.equal(presentationEvidence([row({ kind: 'image', live: input.live })], pages).liveRead, undefined);
});
