'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { familyWeatherContext } = require('../family-weather');
const { createFamilyAmbient } = require('../family-ambient');
const { harness } = require('./fixtures/persona-journey.cjs');
const { runLocalConversation } = require('../conversation-inference');

test('screen and conversation share one cached weather read, never the operations snapshot', async () => {
  let calls = 0;
  const now = new Date();
  const ambient = createFamilyAmbient({ now: () => now, fetchData: async path => {
    calls++; assert.equal(path, '/api/v1/livedata/ec-weather');
    return { response: { ok: true }, body: { status: 'success', data: { fetchedAt: now.toISOString(),
      current: { condition: 'Nuageux', temperatureC: 0, windKmh: 12, privateField: 'private-sentinel' } } } };
  } });
  assert.equal((await ambient.weather()).temperatureC, 0);
  const context = await familyWeatherContext(ambient, { now });
  assert.match(context, /Environnement Canada/); assert.match(context, /"temperatureC":0/);
  assert.match(context, /not a forecast/); assert.doesNotMatch(context, /private-sentinel/);
  assert.equal(calls, 1);
});

test('stale, missing, future and failed weather never become current conditions', async () => {
  for (const fetchedAt of [null, 'invalid', '2000-01-01', '2099-01-01']) {
    const context = await familyWeatherContext({ weather: async () => ({ fetchedAt, temperatureC: 99 }) });
    assert.match(context, /unavailable or outdated/); assert.doesNotMatch(context, /99/);
  }
  assert.match(await familyWeatherContext({ weather: async () => { throw Error('offline'); } }), /unavailable/);
  assert.match(await familyWeatherContext(null), /unavailable/);
});

for (const backend of ['agentx', 'openclaw']) test('dated family weather reaches the ' + backend + ' turn and personal principal, never a reader turn', async () => {
  let reads = 0;
  const ambient = { weather: async () => { reads++; return { fetchedAt: new Date().toISOString(), temperatureC: 4.5, condition: 'Nuageux' }; } };
  const family = harness({ packId: 'kidx_nestor', backend, ambient });
  await family.turn('Quelle est la météo?', 'voice');
  assert.match(family.sent[0].request, /"temperatureC":4.5/);
  assert.doesNotMatch(family.sent[0].prefix, /"temperatureC"/);
  for (const packId of ['personal_operator', 'kidx_reader']) {
    const other = harness({ packId, backend, ambient }); await other.turn('Bonjour', 'voice');
    if (packId === 'personal_operator') assert.match(other.sent[0].request, /Household weather/);
    else assert.doesNotMatch(other.sent[0].request, /Household weather/);
  }
  assert.equal(reads, 2);
});

test('local guardian keeps the supplied weather and reports actual execution before reply parsing', async () => {
  let evidence;
  const request = { backend: 'agentx', session: { packId: 'kidx_nestor', modeId: 'chat' },
    pack: { childSafe: true, id: 'kidx_nestor', taskType: 'test' }, text: 'La météo?', history: [],
    agentxInstructions: 'Family instructions', familyWeatherContext: 'Dated weather: 4.5 C', onExecution: value => { evidence = value; } };
  const result = await runLocalConversation({ request, prepared: [], env: { HOUSEHOLD_CONVERSATION_RELAY_ENABLED: 'true' },
    inference: { conversation: async (_body, options) => {
      assert.match(options.familyInstructions, /Dated weather: 4.5 C/);
      assert.match(options.familyInstructions, /Household clock observed/);
      return { ok: true, body: { response: 'Il fait 4,5 degrés.' }, metadata: { model: 'synthetic-guardian',
        conversationContinuity: { state: 'backup', reason: 'primary_busy', model: 'synthetic-guardian' } } };
    } } });
  assert.equal(evidence.model, 'synthetic-guardian'); assert.equal(evidence.continuity.reason, 'primary_busy');
  assert.equal(result.tools.conversationRelay.role, 'relay');
});

test('weather observation and retrieval get separate local times across a date boundary', async () => {
  const now = new Date('2026-02-04T03:15:00Z');
  const ambient = { weather: async () => ({ fetchedAt: now.toISOString(), observedAt: '2026-02-04T02:00:00Z', temperatureC: -2 }) };
  const context = await familyWeatherContext(ambient, { now, timeZone: 'America/New_York' });
  assert.match(context, /"timeZone":"America\/New_York"/);
  assert.match(context, /"observedAtLocal":"2026-02-03 21:00"/);
  assert.match(context, /"fetchedAtLocal":"2026-02-03 22:15"/);
  assert.match(context, /"observationAgeMinutes":75/);
  assert.match(context, /Never read a raw UTC Z timestamp as local time/);
  assert.match(context, /D’après le relevé de 21 h/);
  assert.doesNotMatch(context, /D’après le relevé de 22 h/);
});

test('a previous-day weather introduction preserves its date and local minutes', async () => {
  const now = new Date('2026-02-04T03:15:00Z');
  const context = await familyWeatherContext({ weather: async () => ({
    fetchedAt: now.toISOString(), observedAt: '2026-02-03T02:30:00Z', temperatureC: -2
  }) }, { now, timeZone: 'America/New_York' });
  assert.match(context, /D’après le relevé du 2 février à 21 h 30/);
  assert.match(context, /reading from 21:30 on February 2/);
});

test('unknown observation time never borrows the fresh retrieval time for the spoken introduction', async () => {
  const now = new Date('2026-02-04T03:15:00Z');
  const context = await familyWeatherContext({ weather: async () => ({
    fetchedAt: now.toISOString(), temperatureC: 2
  }) }, { now, timeZone: 'America/New_York' });
  assert.match(context, /"observationIntroductions":null/);
  assert.doesNotMatch(context, /D’après le relevé de 22 h/);
});

test('the spoken observation hour uses the timezone offset at observation, including a DST transition', async () => {
  const now = new Date('2026-03-08T07:30:00Z');
  const context = await familyWeatherContext({ weather: async () => ({
    fetchedAt: now.toISOString(), observedAt: '2026-03-08T06:30:00Z', temperatureC: 2
  }) }, { now, timeZone: 'America/New_York' });
  assert.match(context, /D’après le relevé de 1 h 30/);
  assert.match(context, /"observationAgeMinutes":60/);
});

test('fresh but empty or direction-only readings disclose missing conditions', async () => {
  const now = new Date();
  for (const current of [{}, { condition: '   ' }, { windDirection: 'N' },
    { temperatureC: null, windKmh: NaN, gustKmh: Infinity }]) {
    const ambient = createFamilyAmbient({ now: () => now, fetchData: async () => ({
      response: { ok: true }, body: { status: 'success', data: { fetchedAt: now.toISOString(), current } }
    }) });
    const context = await familyWeatherContext(ambient, { now });
    assert.match(context, /no usable current conditions/);
    assert.doesNotMatch(context, /supplied conditions/);
  }
});

test('zero and partial measurements remain usable and timestamps mean retrieval only', async () => {
  const now = new Date();
  for (const current of [{ temperatureC: 0 }, { windKmh: 0 }, { gustKmh: 0 }, { condition: 'Nuageux' }]) {
    const context = await familyWeatherContext({ weather: async () => ({ fetchedAt: now.toISOString(), ...current }) }, { now });
    assert.match(context, /supplied conditions/);
    assert.match(context, /retrieval timestamp/);
    assert.match(context, /not an observation time/);
    assert.doesNotMatch(context, /no usable/);
  }
});

test('automatic context uses the exact source_read observation projection', async () => {
  const { forAudience } = require('../../../src/services/livingSourceService');
  const now = new Date('2026-03-15T12:00:00Z');
  for (const observedAt of ['2026-03-14T12:00:00Z', '2099-01-01T00:00:00Z', 'invalid', null]) {
    const ambient = { weather: async () => ({ fetchedAt: now.toISOString(), observedAt, temperatureC: 4 }) };
    const context = await familyWeatherContext(ambient, { now });
    const explicit = await forAudience('household', { ambient, now: () => now }).read({ source: 'weather' });
    assert.ok(context.includes(JSON.stringify({ ...explicit.data, freshness: explicit.freshness })));
    assert.match(context, /Do not present an old or undated observation as current/);
    assert.match(context, /current observation freshness is not established/);
    assert.doesNotMatch(context, /These are current conditions/);
    if (observedAt === '2026-03-14T12:00:00Z') assert.match(context, /"observationAgeMs":86400000/);
    else {
      assert.match(context, /"observedAt":null/);
      assert.match(context, /"observationAgeMs":null/);
    }
  }
});

for (const packId of ['personal_operator', 'kidx_nestor']) {
  for (const backend of ['agentx', 'openclaw']) {
    test(packId + ' ' + backend + ' receives old or unknown observation evidence without current-weather claims', async () => {
      for (const observedAt of ['2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 'invalid']) {
        const ambient = { weather: async () => ({ fetchedAt: new Date().toISOString(), observedAt, temperatureC: 4 }) };
        const journey = harness({ packId, backend, ambient });
        await journey.turn('Quelle est la meteo?', 'voice');
        const request = journey.sent[0].request;
        assert.match(request, /"observationFreshness":"unknown"/);
        assert.match(request, /Do not present an old or undated observation as current/);
        assert.match(request, /current observation freshness is not established/);
        assert.doesNotMatch(request, /These are current conditions/);
        if (observedAt === '2000-01-01T00:00:00Z') {
          assert.match(request, /"observedAt":"2000-01-01T00:00:00.000Z"/);
          assert.match(request, /"observationAgeMs":[1-9][0-9]+/);
        } else assert.match(request, /"observedAt":null/);
      }
    });
  }
}
