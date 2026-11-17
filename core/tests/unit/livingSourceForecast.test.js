'use strict';
const assert = require('node:assert/strict');
const { forAudience } = require('../../src/services/livingSourceService');
const { projectForecast } = require('../../src/services/livingSourceForecast');
const now = new Date('2026-11-17T12:00:00Z');
function fixture() { return {
  fetchedAt: '2026-11-17T11:59:00Z', forecastIssuedAt: '2026-11-17T10:00:00Z',
  lastUpdated: '2026-11-17T10:00:00Z', identifier: 'synthetic-station', name: 'Fixture',
  lat: 45, lon: -70, distanceKm: 5, url: 'https://private.invalid/coordinates',
  current: { station: 'Observation fixture', observedAt: '2026-11-17T11:00:00Z', private: 'PRIVATE_MARKER' },
  forecasts: [{ period: 'Tonight', summary: 'Synthetic rain', temperatures: [{ class: 'low', valueC: 0 }] }],
  hourly: [{ time: '2026-11-17T13:00:00Z', temperatureC: 0, condition: 'Rain' }],
  warnings: [{ description: 'Synthetic warning', issuedAt: '2026-11-17T10:00:00Z', expiresAt: '2026-11-17T14:00:00Z', url: 'https://private.invalid/' }]
}; }
function service(value, audience = 'owner') {
  const calls = [];
  return { calls, api: forAudience(audience, { now: () => now,
    ambient: { weather: async () => ({ fetchedAt: value.fetchedAt, temperatureC: 0 }) },
    fetchData: async (...args) => { calls.push(args); return { response: { ok: true }, body: { status: 'success', data: value } }; } }) };
}
test('explicit sections reuse only the existing fixed Data endpoint and exclude unlisted fields', async () => {
  for (const section of ['forecasts', 'hourly', 'warnings']) {
    const { api, calls } = service(fixture());
    const result = await api.read({ source: 'weather', section });
    assert.equal(result.status, 'available');
    assert.equal(result.data.section, section);
    assert.equal(result.data.station.identifier, 'synthetic-station');
    assert.equal(result.producerEvidence.forecastIssuedAt, '2026-11-17T10:00:00.000Z');
    assert.deepEqual(calls, [['/api/v1/livedata/ec-weather', { query: 'lang=fr', timeoutMs: 8000 }]]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MARKER|private.invalid|distanceKm|"lat"|"lon"/);
  }
});
test('household/default retain the current-only projection and do not call forecast producer', async () => {
  const owner = service(fixture()), family = service(fixture(), 'household');
  assert.deepEqual((await owner.api.read({ source: 'weather' })).data, (await family.api.read({ source: 'weather' })).data);
  assert.equal(owner.calls.length + family.calls.length, 0);
  assert.equal(family.api.catalogue().sources[0].sections, undefined);
  assert.deepEqual(owner.api.catalogue().sources[0].sections, ['forecasts', 'hourly', 'warnings']);
  assert.equal(owner.api.catalogue({ ownerSections: false }).sources[0].sections, undefined);
  for (const section of ['forecasts', 'hourly', 'warnings'])
    await assert.rejects(family.api.read({ source: 'weather', section }), { code: 'SOURCE_ARGUMENT_INVALID' });
  assert.equal(family.calls.length, 0);
});
test('strict weather arguments refuse before I/O', async () => {
  const { api, calls } = service(fixture());
  for (const input of [{ section: 'all' }, { section: ['hourly'] }, { section: null },
    { section: 'hourly', days: 1 }, { section: 'hourly', limit: 1 },
    { section: 'hourly', recordOffset: 0 }, { section: 'hourly', asOf: now.toISOString() },
    { section: 'hourly', url: 'https://example.invalid' }, { section: 'hourly', lat: 1 }])
    await assert.rejects(api.read({ source: 'weather', ...input }), { code: 'SOURCE_ARGUMENT_INVALID' });
  assert.equal(calls.length, 0);
});
test('missing, future and old retrievals do not claim fresh forecasts', () => {
  for (const [date, status] of [[null, 'unavailable'], ['invalid', 'unavailable'],
    ['2026-11-18T00:00:00Z', 'unavailable'], ['2026-11-16T00:00:00Z', 'stale']])
    assert.equal(projectForecast({ ...fixture(), fetchedAt: date }, 'forecasts', now).status, status);
  for (const date of [null, 'invalid', '2026-11-18T00:00:00Z']) {
    const result = projectForecast({ ...fixture(), forecastIssuedAt: date }, 'forecasts', now);
    assert.equal(result.status, 'partial');
    assert.equal(result.data.forecastIssuedAt, null);
  }
  assert.equal(projectForecast(fixture(), 'forecasts', now).freshness.forecastFreshness, 'unknown');
  assert.equal(projectForecast(fixture(), 'forecasts', now).data.records[0].validUntil, null);
});
test('future forecast valid times survive; warning issue and expiry are independent', () => {
  assert.equal(projectForecast(fixture(), 'hourly', now).data.records[0].validity, 'upcoming');
  for (const [time, validity] of [[null, 'unknown'], ['bad', 'unknown'], ['2026-11-17T11:00:00Z', 'past']])
    assert.equal(projectForecast({ ...fixture(), hourly: [{ time, condition: 'rain' }] }, 'hourly', now).data.records[0].validity, validity);
  for (const [expiresAt, issuedAt, validity] of [
    ['2026-11-17T11:00:00Z', '2026-11-17T10:00:00Z', 'expired'],
    ['2026-11-18T00:00:00Z', '2026-11-17T13:00:00Z', 'unknown'],
    [null, null, 'unknown'], ['2026-11-17T09:00:00Z', '2026-11-17T10:00:00Z', 'unknown']])
    assert.equal(projectForecast({ ...fixture(), warnings: [{ description: 'fixture', expiresAt, issuedAt }] }, 'warnings', now).data.records[0].validity, validity);
});
test('missing arrays differ from empty warnings and bounds/malformed records are explicit', () => {
  for (const section of ['forecasts', 'hourly', 'warnings'])
    assert.equal(projectForecast({ ...fixture(), [section]: null }, section, now).status, 'unavailable');
  const empty = projectForecast({ ...fixture(), warnings: [] }, 'warnings', now);
  assert.equal(empty.status, 'available');
  assert.match(empty.data.coverage.emptyMeaning, /not a global all-clear/);
  for (const [section, limit] of [['forecasts', 16], ['hourly', 48], ['warnings', 20]]) {
    const result = projectForecast({ ...fixture(), [section]: Array(100).fill(fixture()[section][0]) }, section, now);
    assert.equal(result.status, 'partial'); assert.equal(result.data.records.length, limit);
    assert.equal(result.data.coverage.truncated, true);
  }
  const malformed = projectForecast({ ...fixture(), warnings: [null, {}] }, 'warnings', now);
  assert.equal(malformed.status, 'partial');
  assert.equal(malformed.data.coverage.malformedRecords, 2);
});
test('transport paging reconstructs bounded data and detects producer changes', async () => {
  const value = fixture(); value.forecasts[0].summary = 'Synthetic 😀'.repeat(180);
  const { api } = service(value);
  let page = await api.read({ source: 'weather', section: 'forecasts', pageChars: 257 });
  const first = page; let text = page.text;
  while (page.nextOffset !== null) {
    page = await api.read({ ...page.nextReadArgs, offset: page.nextOffset, expectedHash: first.contentHash });
    text += page.text;
  }
  assert.equal(JSON.parse(text).section, 'forecasts');
  assert.equal(JSON.parse(text).records[0].summary, value.forecasts[0].summary.slice(0, 2000));
  value.forecasts[0].summary = 'Changed';
  await assert.rejects(api.read({ ...first.nextReadArgs, offset: first.nextOffset, expectedHash: first.contentHash }), { code: 'SOURCE_CHANGED' });
});
test('failed Data reads expose neither error detail nor fake success', async () => {
  const api = forAudience('owner', { now: () => now, fetchData: async () => { throw Error('PRIVATE_MARKER'); } });
  const result = await api.read({ source: 'weather', section: 'hourly' });
  assert.equal(result.status, 'unavailable'); assert.equal(result.lastSuccessfulReadAt, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MARKER/);
});

test('bounded text and nested temperatures explicitly report partial coverage', () => {
  for (const [section, key, max] of [['forecasts', 'summary', 2000], ['warnings', 'description', 2000], ['hourly', 'condition', 300]]) {
    const value = fixture(); value[section][0][key] = 'x'.repeat(max + 1);
    const result = projectForecast(value, section, now);
    assert.equal(result.data.records[0][key].length, max);
    assert.equal(result.data.coverage.contentTruncated, true);
    assert.equal(result.status, 'partial');
  }
  const value = fixture(); value.forecasts[0].temperatures = Array(5).fill({ class: 'low', valueC: 1 });
  assert.equal(projectForecast(value, 'forecasts', now).data.coverage.contentTruncated, true);
});
