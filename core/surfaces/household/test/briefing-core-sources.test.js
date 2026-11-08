'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBriefingCoreSources } = require('../briefing-core-sources');
const { cachedProjection, cachedProjectedJson, projectionCache, projectionInFlight } = require('../panel-sources');

const report = { ok: true, status: 'success', data: { report: 'morning-brief', period: '24h', alerts: { active: 2 } } };
const budget = { period: '24h', total_requests: 4, budget_health: 'yellow' };
const startReads = () => new Promise(setImmediate);

function setup(t, coreBriefingReads, configuredUrl, fetchImpl) {
  projectionCache.clear(); projectionInFlight.clear();
  const previous = process.env.CORE_INTERNAL_URL;
  if (configuredUrl === undefined) delete process.env.CORE_INTERNAL_URL;
  else process.env.CORE_INTERNAL_URL = configuredUrl;
  t.after(() => {
    if (previous === undefined) delete process.env.CORE_INTERNAL_URL;
    else process.env.CORE_INTERNAL_URL = previous;
    projectionCache.clear(); projectionInFlight.clear();
  });
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push(String(url));
    if (fetchImpl) return fetchImpl(url, options);
    throw new Error('transport unavailable');
  });
  return { calls, sources: createBriefingCoreSources({ coreBriefingReads,
    CORE_SELF_URL: () => String(process.env.CORE_INTERNAL_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '') }) };
}

test('native briefing and budget use canonical bodies when self transport is unavailable', async t => {
  const { sources, calls } = setup(t, { morningBrief: async () => report, budget: async () => budget });
  const [brief, usage] = await Promise.all([sources.morningBrief(), sources.budget()]);
  assert.deepEqual(brief, { ...report, latencyMs: brief.latencyMs, cache: 'refreshed' });
  assert.deepEqual(usage, { ...budget, latencyMs: usage.latencyMs, cache: 'refreshed' });
  assert.deepEqual(calls, []);
});

for (const url of ['http://remote-core.example.test:9000/base/', 'http://127.0.0.1:3080']) {
  test(`explicit ${url} keeps HTTP without invoking native producers`, async t => {
    const { sources, calls } = setup(t, { morningBrief: () => assert.fail(), budget: () => assert.fail() }, url,
      async value => new Response(JSON.stringify(String(value).endsWith('/status') ? { data: budget } : report)));
    const [brief, usage] = await Promise.all([sources.morningBrief(), sources.budget()]);
    assert.equal(brief.data.report, 'morning-brief'); assert.equal(usage.total_requests, 4);
    assert.deepEqual(calls, [`${url.replace(/\/+$/, '')}/api/reports/morning-brief`, `${url.replace(/\/+$/, '')}/api/budget/status`]);
  });
}

test('invalid explicit URL keeps the factual parse error instead of using a native producer', async t => {
  const actualFetch = global.fetch;
  const { sources } = setup(t, { morningBrief: () => assert.fail(), budget: () => assert.fail() }, 'invalid-url', actualFetch);
  for (const value of await Promise.all([sources.morningBrief(), sources.budget()])) {
    assert.equal(value.cache, 'unavailable'); assert.equal(value.unavailable, true);
    assert.match(value.error, /Failed to parse URL/);
  }
});

for (const missing of ['morningBrief', 'budget', 'both']) {
  test(`missing ${missing} capability retains HTTP only for the missing read`, async t => {
    const readers = { morningBrief: async () => report, budget: async () => budget };
    if (missing === 'both') { delete readers.morningBrief; delete readers.budget; }
    else delete readers[missing];
    const { sources, calls } = setup(t, readers);
    const [brief, usage] = await Promise.all([sources.morningBrief(), sources.budget()]);
    assert.equal(brief.cache, missing !== 'budget' ? 'unavailable' : 'refreshed');
    assert.equal(usage.cache, missing !== 'morningBrief' ? 'unavailable' : 'refreshed');
    assert.equal(calls.length, missing === 'both' ? 2 : 1);
  });
}

test('briefing and desk share one in-flight native report and retain the 60s cache', async t => {
  let finish;
  const read = t.mock.fn(() => new Promise(resolve => { finish = resolve; }));
  const { sources, calls } = setup(t, { morningBrief: read });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const first = sources.morningBrief(), second = sources.morningBrief();
  await startReads(); assert.equal(read.mock.callCount(), 1);
  finish(report);
  assert.deepEqual(await first, await second);
  t.mock.timers.tick(59_999);
  assert.equal((await sources.morningBrief()).cache, 'fresh');
  assert.equal(read.mock.callCount(), 1);
  t.mock.timers.tick(1);
  const refreshed = sources.morningBrief();
  await startReads(); assert.equal(read.mock.callCount(), 2);
  finish(report); assert.equal((await refreshed).cache, 'refreshed');
  assert.deepEqual(calls, []);
});

test('native failure retains stale evidence with an error and refreshes only after a successful read', async t => {
  let failure = false;
  const { sources, calls } = setup(t, { morningBrief: async () => {
    if (failure) throw new Error('PRIVATE_COLLECTOR_ERROR');
    return report;
  } });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  await sources.morningBrief(); t.mock.timers.tick(60_000); failure = true;
  const stale = await sources.morningBrief();
  assert.equal(stale.cache, 'stale'); assert.deepEqual(stale.data, report.data);
  assert.equal(stale.error, 'Morning brief is unavailable.');
  assert.doesNotMatch(JSON.stringify(stale), /PRIVATE_COLLECTOR_ERROR/);
  failure = false; assert.equal((await sources.morningBrief()).cache, 'refreshed');
  assert.deepEqual(calls, []);
});

test('cold native failures stay unavailable and sanitized without an HTTP retry', async t => {
  const fail = async () => { throw new Error('PRIVATE_COLLECTOR_ERROR'); };
  const { sources, calls } = setup(t, { morningBrief: fail, budget: fail });
  const [brief, usage] = await Promise.all([sources.morningBrief(), sources.budget()]);
  assert.equal(brief.cache, 'unavailable'); assert.equal(usage.cache, 'unavailable');
  assert.equal(brief.unavailable, true); assert.equal(usage.unavailable, true);
  assert.equal(brief.error, 'Morning brief is unavailable.'); assert.equal(usage.error, 'Budget status unavailable');
  assert.equal(projectionCache.size, 0); assert.deepEqual(calls, []);
});

test('native cache separates domains, reader identities, mounts and HTTP destinations', async t => {
  const shared = t.mock.fn(async () => shared.mock.callCount() === 1 ? report : budget);
  const readers = { morningBrief: shared, budget: shared };
  const { sources, calls } = setup(t, readers);
  await sources.morningBrief(); await sources.budget(); assert.equal(shared.mock.callCount(), 2);
  readers.morningBrief = async () => ({ ...report, revision: 2 });
  assert.equal((await sources.morningBrief()).revision, 2);
  const anotherMount = createBriefingCoreSources({ coreBriefingReads: { budget: shared } });
  await anotherMount.budget(); assert.equal(shared.mock.callCount(), 3);
  process.env.CORE_INTERNAL_URL = 'http://127.0.0.1:3080';
  assert.equal((await sources.budget()).cache, 'unavailable');
  assert.equal(calls.length, 1);
});

test('missing or incompatible native bodies remain unavailable and never become reusable cache evidence', async t => {
  const readers = { morningBrief: async () => null, budget: async () => null };
  const { sources, calls } = setup(t, readers);
  for (const body of [null, {}, { period: '7d' }]) {
    readers.morningBrief = async () => body; readers.budget = async () => body;
    for (const value of await Promise.all([sources.morningBrief(), sources.budget()])) {
      assert.equal(value.cache, 'unavailable'); assert.equal(value.unavailable, true);
    }
  }
  assert.equal(projectionCache.size, 0); assert.deepEqual(calls, []);
});

test('native 8s deadlines ignore late settlements and do not populate the cache', async t => {
  let resolveReport, rejectBudget;
  const { sources, calls } = setup(t, {
    morningBrief: () => new Promise(resolve => { resolveReport = resolve; }),
    budget: () => new Promise((_, reject) => { rejectBudget = reject; })
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pending = Promise.all([sources.morningBrief(), sources.budget()]);
  await startReads(); t.mock.timers.tick(8000);
  for (const value of await pending) {
    assert.equal(value.cache, 'unavailable'); assert.equal(value.latencyMs, 8000);
    assert.match(value.error, /timed out after 8000ms/);
  }
  resolveReport(report); rejectBudget(new Error('PRIVATE_LATE_ERROR')); await startReads();
  assert.equal(projectionCache.size, 0); assert.equal(projectionInFlight.size, 0); assert.deepEqual(calls, []);
});

test('HTTP cache still coalesces in-flight reads and preserves fresh, stale and unavailable metadata', async t => {
  let finish, failure = false;
  const { calls } = setup(t, undefined, undefined, () => {
    if (failure) throw new Error('observed transport failure');
    return new Promise(resolve => { finish = resolve; });
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const read = () => cachedProjectedJson('http://core.example.test/report', body => body, { unavailable: true });
  const first = read(), second = read();
  await startReads();
  finish(new Response(JSON.stringify(report)));
  assert.deepEqual(await first, await second); assert.equal(calls.length, 1);
  assert.equal((await read()).cache, 'fresh');
  t.mock.timers.tick(60_000); failure = true;
  const stale = await read(); assert.equal(stale.cache, 'stale'); assert.equal(stale.error, 'observed transport failure');
  assert.deepEqual(stale.data, report.data);
  projectionCache.clear();
  assert.equal((await read()).cache, 'unavailable');
});

test('a synchronous callback failure releases in-flight state and a healthy retry coalesces normally', async t => {
  setup(t);
  const key = {};
  const fallback = { unavailable: true };
  const failed = await cachedProjection(key, () => { throw new Error('temporary failure'); }, body => body, fallback);
  assert.equal(failed.unavailable, true); assert.equal(failed.cache, 'unavailable');
  assert.equal(projectionInFlight.has(key), false); assert.equal(projectionCache.has(key), false);
  const recovery = t.mock.fn(() => ({ healthy: true }));
  const first = cachedProjection(key, recovery, body => body, fallback);
  const second = cachedProjection(key, () => assert.fail('concurrent read must coalesce'), body => body, fallback);
  const healthy = await first;
  assert.equal(healthy.healthy, true); assert.equal(healthy.cache, 'refreshed');
  assert.deepEqual(healthy, await second); assert.equal(recovery.mock.callCount(), 1);
  assert.equal(projectionInFlight.has(key), false); assert.equal(projectionCache.has(key), true);
});
