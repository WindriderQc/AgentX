'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../family-tool-registry');
const { familyToolset } = require('../family-tools');
test('family source registry rejects private sources and audience injection before any provider I/O', async () => {
  let reads = 0;
  const deps = { livingSources: { ambient: { weather: async () => { reads++; } }, brief: async () => { reads++; },
    reportsClient: { fetchBenchmarkAnalyticsSummary: async () => { reads++; }, fetchRagStatus: async () => { reads++; } } } };
  for (const arguments_ of [{ source: 'secretary' }, { source: 'comptable' }, { source: 'weather', audience: 'owner' },
    { source: 'agentx', section: 'balances' }, { source: 'weather', expectedHash: 'invalid' }]) {
    const result = await registry.callTool({ name: 'source_read', arguments: arguments_ }, deps);
    assert.equal(result.isError, true);
  }
  assert.equal(reads, 0);
  const catalogue = await registry.callTool({ name: 'source_catalogue', arguments: {} }, deps);
  assert.deepEqual(catalogue.structuredContent.sources.map(row => row.source), ['weather', 'agentx']);
  assert.equal(reads, 0);
});
test('family source tools are explicit opt-ins and share the injected safe weather provider', async () => {
  assert.equal(familyToolset({}), null);
  let reads = 0;
  const tools = familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'source_catalogue,source_read,consult_team' }, {
    toolDeps: { ambient: { weather: async () => { reads++; return { fetchedAt: new Date().toISOString(), temperatureC: 0, private: 'sentinel' }; } } }
  });
  assert.deepEqual(tools.names, ['source_catalogue', 'source_read']);
  const result = await tools.execute({ function: { name: 'source_read', arguments: { source: 'weather' } } });
  const data = JSON.parse(result.message.content);
  assert.equal(data.audience, 'household'); assert.equal(data.source, 'weather');
  assert.equal(data.status, 'available'); assert.equal(reads, 1);
  assert.doesNotMatch(result.message.content, /sentinel/);
  const denied = await tools.execute({ function: { name: 'source_read', arguments: { source: 'secretary' } } });
  assert.equal(denied.receipt.status, 'failed'); assert.equal(reads, 1);
});

test('normal source continuation errors return failed tool receipts instead of rejecting the turn', async () => {
  const tools = familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'source_read' }, {
    toolDeps: { ambient: { weather: async () => ({ fetchedAt: new Date().toISOString(), temperatureC: 0 }) } }
  });
  for (const [args, code] of [
    [{ source: 'weather', offset: 1 }, 'SOURCE_ARGUMENT_INVALID'],
    [{ source: 'weather', expectedHash: '0'.repeat(64) }, 'SOURCE_CHANGED']
  ]) {
    const result = await tools.execute({ function: { name: 'source_read', arguments: args } });
    assert.equal(result.receipt.status, 'failed');
    const data = JSON.parse(result.message.content);
    assert.equal(data.error, code);
    if (code === 'SOURCE_CHANGED') {
      assert.equal(data.retry.offset, 0);
      assert.equal(Object.hasOwn(data.retry, 'expectedHash'), false);
    }
  }
});
test('oversized pages preserve the undelivered offset and revision in a bounded retry envelope', async () => {
  const service = require('../../../src/services/livingSourceService');
  const original = service.forAudience;
  const hash = 'a'.repeat(64);
  service.forAudience = () => ({ read: async () => ({ text: 'x'.repeat(9000), contentHash: hash, nextOffset: 24500 }) });
  try {
    const tools = familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'source_read' });
    const result = await tools.execute({ function: { name: 'source_read',
      arguments: { source: 'weather', pageChars: 24000, offset: 500, expectedHash: hash } } });
    const data = JSON.parse(result.message.content);
    assert.equal(result.receipt.status, 'failed');
    assert.equal(data.error, 'SOURCE_RESULT_TOO_LARGE');
    assert.deepEqual(data.retry, { source: 'weather', offset: 500, pageChars: 1000, expectedHash: hash });
    assert.ok(result.message.content.length < 8000);
    assert.equal(Object.hasOwn(data, 'nextOffset'), false);
    service.forAudience = () => { throw Error('private-provider-sentinel'); };
    const failed = await tools.execute({ function: { name: 'source_read', arguments: { source: 'weather' } } });
    assert.equal(JSON.parse(failed.message.content).error, 'SOURCE_READ_UNAVAILABLE');
    assert.doesNotMatch(failed.message.content, /private-provider-sentinel/);
  } finally { service.forAudience = original; }
});

test('household and owner read the same prepared bulletin with scoped sections and a shared cold read', async () => {
  const { createFamilyAmbient } = require('../family-ambient');
  const { forAudience } = require('../../../src/services/livingSourceService');
  const now = () => new Date('2026-11-21T00:03:00Z');
  const raw = { preparedStatus: 'fresh', fetchedAt: '2026-11-21T00:02:00Z', forecastIssuedAt: '2026-11-21T00:01:00Z',
    current: { temperatureC: 0, observedAt: '2026-11-20T23:45:00Z', station: 'PRIVATE' },
    forecasts: [{ period: 'Ce soir et cette nuit', short: 'Neige', temperatures: [{ class: 'low', valueC: -2, secret: 'PRIVATE' }] }],
    hourly: [{ time: '2026-11-21T01:00:00Z', temperatureC: 0, precipitationChancePct: 0, station: 'PRIVATE' },
      { time: '2026-11-20T23:00:00Z', temperatureC: 11 }, { time: '2026-11-21T02:00:00', temperatureC: 9 }],
    warnings: [{ description: 'Fog advisory', issuedAt: '2026-11-20T23:00:00Z', expiresAt: '2026-11-21T03:00:00Z', url: 'PRIVATE' },
      { description: 'Expired', issuedAt: '2026-11-20T00:00:00Z', expiresAt: '2026-11-20T01:00:00Z' }],
    lat: 'PRIVATE', location: { name: 'PRIVATE' } };
  let calls = 0;
  const ambient = createFamilyAmbient({ now, fetchData: async (path, args) => {
    calls++;
    assert.equal(path, '/api/v1/livedata/ec-weather');
    assert.equal(args.query, 'lang=fr&prepared=1');
    assert.ok(args.timeoutMs > 0 && args.timeoutMs <= 500);
    return { response: { ok: true }, body: { status: 'success', data: raw } };
  } });
  const [family, owner, prepared] = await Promise.all([
    registry.callTool({ name: 'source_read', arguments: { source: 'weather', section: 'forecast' } }, { livingSources: { ambient, now } }),
    forAudience('owner', { ambient, now }).read({ source: 'weather', section: 'alerts' }), ambient.preparedWeather()
  ]);
  assert.equal(calls, 1);
  const forecast = family.structuredContent;
  assert.equal(forecast.audience, 'household');
  assert.equal(forecast.status, 'available');
  assert.equal(forecast.data.periods[0].temperatures[0].valueC, -2);
  assert.deepEqual(forecast.data.hourly.map(row => [row.time, row.precipitationChancePct]), [['2026-11-21T01:00:00.000Z', 0]]);
  assert.equal(forecast.data.issueDate, require('../../../src/domains/household/family').calendarDayKey(raw.forecastIssuedAt));
  assert.equal(owner.status, 'available'); assert.equal(owner.data.incomplete, false);
  assert.deepEqual(owner.data.warnings.map(row => row.description), ['Fog advisory']);
  const current = await forAudience('household', { ambient, now }).read({ source: 'weather' });
  assert.equal(current.data.temperatureC, 0);
  assert.equal(current.data.periods, undefined);
  assert.equal(current.data.observedAt, '2026-11-20T23:45:00.000Z');
  assert.equal(current.producerEvidence.mode, 'prepared_read');
  assert.doesNotMatch(JSON.stringify([prepared, family, owner, current]), /PRIVATE/);
});

test('missing or old Data responses are negative-cached without a second on-demand request', async () => {
  const { createFamilyAmbient } = require('../family-ambient');
  let at = Date.parse('2026-11-20T12:00:00Z');
  const states = [{}, { preparedStatus: 'missing' }, { preparedStatus: 'fresh', fetchedAt: '2026-11-20T12:01:00Z' }];
  let calls = 0;
  const ambient = createFamilyAmbient({ now: () => new Date(at), fetchData: async (path, args) => {
    assert.equal(args.query, 'lang=fr&prepared=1');
    const extra = states[calls++];
    return { response: { ok: true }, body: { status: 'success', data: { current: { temperatureC: 12 }, ...extra } } };
  } });
  for (let i = 0; i < 2; i++) {
    assert.equal(await ambient.preparedWeather(), null);
    assert.equal(await ambient.preparedWeather(), null);
    assert.equal(calls, i + 1);
    at += 31000;
  }
  assert.equal((await ambient.preparedWeather()).current.status, 'available');
});

test('a cached forecast becomes available on its local issue date without a new retrieval', () => {
  const { preparedBulletin, projectBulletin } = require('../../../src/services/livingSourceWeather');
  const issue = new Date('2026-11-21T05:00:00Z'); // Midnight in Toronto.
  const cached = preparedBulletin({ preparedStatus: 'fresh', fetchedAt: '2026-11-21T04:59:00Z',
    forecastIssuedAt: issue.toISOString(), forecasts: [{ period: 'Aujourd’hui', short: 'Neige' }] });
  const forecastAt = now => projectBulletin(cached, now, 'America/Toronto').forecast;
  assert.equal(forecastAt(new Date(issue.getTime() - 1)).status, 'unavailable');
  const forecast = forecastAt(issue);
  assert.equal(forecast.status, 'available');
  assert.equal(forecast.data.issueDate, '2026-11-21');
  assert.equal(forecast.data.fetchedAt, '2026-11-21T04:59:00.000Z');
  assert.equal(forecast.data.periods[0].period, 'Aujourd’hui');
  assert.equal(forecastAt(new Date('2026-11-21T05:09:00Z')).status, 'stale');
});

test('stale retrieval, invalid hours and warnings of uncertain scope stay explicit', () => {
  const { preparedBulletin, projectBulletin } = require('../../../src/services/livingSourceWeather');
  const now = new Date('2026-11-21T12:00:00Z'), timeZone = 'America/Toronto';
  const weather = { fetchedAt: '2026-11-21T11:58:00Z', preparedStatus: 'fresh', forecastIssuedAt: '2026-11-21T11:00:00Z',
    hourly: [{ time: '2026-11-21T13:00:00Z', temperatureC: 2 }, { time: '2026-11-21T13:00:00Z', temperatureC: 5 }],
    forecasts: [{ period: 'Demain', short: 'Pluie' }], warnings: [{ issuedAt: '2026-02-30T01:00:00Z', description: 'Invalid' }] };
  const projection = (patch = {}) => projectBulletin(preparedBulletin({ ...weather, ...patch }), now, timeZone);
  assert.deepEqual(projection().forecast.data.hourly, []);
  assert.equal(projection().alerts.status, 'partial');
  assert.equal(projection().alerts.data.incomplete, true);
  assert.equal(projection({warnings: []}).alerts.status, 'available');
  assert.equal(projection({warnings: undefined}).alerts.status, 'unavailable');
  assert.equal(projection({preparedStatus: 'stale', warnings: []}).alerts.status, 'stale');
  assert.equal(projection({forecastIssuedAt: '2026-11-21T12:00:01Z'}).forecast.status, 'unavailable');
  assert.equal(projection({forecastIssuedAt: '2026-11-20T12:00:00Z'}).forecast.status, 'stale');
  assert.equal(projection({fetchedAt: '2027-11-20T12:00:00Z'}), null);
});
