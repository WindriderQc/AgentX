'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectTomorrowHours } = require('../family-forecast');

const timeZone = 'America/Toronto';
const at = (iso) => new Date(iso);
const now = at('2026-11-23T13:00:00Z');
const fixture = { current: null, forecastIssuedAt: '2026-11-23T10:00:00Z', fetchedAt: now.toISOString(),
  forecasts: [{ period: 'Demain', summary: 'do not expose or date this relative label' }],
  hourly: [{ time: '2026-11-23T14:00:00Z', condition: 'Aujourd’hui' },
    { time: '2026-11-24T12:00:00Z', temperatureC: 0, precipitationChancePct: 0, privateField: 'sentinel' },
    { time: '2026-11-24T13:00:00Z', condition: 'Nuageux' }] };

test('a forecast with no current observations returns only the hours actually covered', () => {
  const output = projectTomorrowHours(fixture, { now, timeZone, requestAt: now });
  assert.equal(output.targetDate, '2026-11-24');
  assert.deepEqual(output.hourly.map(h => h.localTime), ['07:00', '08:00']);
  assert.equal(output.hourly[0].precipitationChancePct, 0);
  assert.equal(output.hourly[1].precipitationChancePct, undefined);
  assert.equal(output.forecastIssuedAt, '2026-11-23T10:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(output), /sentinel|relative label|Aujourd’hui/);
});

test('the request calendar day is pinned before the data fetch even if it crosses local midnight', () => {
  const before = at('2026-11-24T04:59:59Z');
  const after = at('2026-11-24T05:00:01Z');
  const day = { ...fixture, forecastIssuedAt: '2026-11-24T01:00:00Z', fetchedAt: after.toISOString() };
  assert.equal(projectTomorrowHours(day, { now: after, requestAt: before, timeZone }).targetDate, '2026-11-24');
  assert.equal(projectTomorrowHours(day, { now: after, requestAt: after, timeZone }), null);
});

test('offset distinguishes repeated fall-back hours and missing spring hour is not synthesized', () => {
  for (const [day, previous, timestamps, expected] of [
    ['2026-11-01', '2026-10-31T22:00:00Z', ['05:00', '06:00'], ['01:00 GMT-4', '01:00 GMT-5']],
    ['2026-03-08', '2026-03-07T22:00:00Z', ['06:00', '07:00'], ['01:00 GMT-5', '03:00 GMT-4']]
  ]) {
    const data = { forecastIssuedAt: previous, fetchedAt: previous,
      hourly: timestamps.map(t => ({ time: day + 'T' + t + ':00Z', condition: 'Clair' })) };
    const output = projectTomorrowHours(data, { requestAt: at(previous), timeZone });
    assert.deepEqual(output.hourly.map(h => h.localTime + ' ' + h.offset), expected);
  }
});

test('ambiguous timestamps, stale forecasts, missing forecasts and conflicting duplicate hours fail closed', () => {
  for (const data of [
    null, { ...fixture, forecastIssuedAt: '2026-11-23T10:00:00' },
    { ...fixture, forecastIssuedAt: '2026-11-22T10:00:00Z' },
    { ...fixture, fetchedAt: '2026-11-23T11:59:59Z' },
    { ...fixture, hourly: [{ time: '2026-11-24T12:00:00', condition: 'x' }] },
    { ...fixture, hourly: [fixture.hourly[1], { ...fixture.hourly[1], temperatureC: 9 }] },
    { ...fixture, hourly: [] }
  ]) assert.equal(projectTomorrowHours(data, { now, timeZone, requestAt: now }), null);
});

test('forecast and public ambient share one fetch without exposing the forecast in the public view', async () => {
  const { createFamilyAmbient } = require('../family-ambient');
  let calls = 0;
  const ambient = createFamilyAmbient({
    now: () => now, nodeHints: [], observer: async () => null, issPasses: async () => null,
    fetchData: async (path) => {
      calls++;
      assert.equal(path, '/api/v1/livedata/ec-weather');
      return { response: { ok: true }, body: { status: 'success', data: fixture } };
    }
  });
  const [snapshot, forecast, weather] = await Promise.all([
    ambient.snapshot(), ambient.forecastTomorrow({ timeZone }), ambient.weather()
  ]);
  assert.equal(calls, 1);
  assert.equal(weather, null);
  assert.equal(snapshot.weather, null);
  assert.equal(forecast.targetDate, '2026-11-24');
  assert.doesNotMatch(JSON.stringify(snapshot), /forecast|hourly|targetDate/);
});

test('a current-only bundle and a failed source preserve the existing weather contract', async () => {
  const { createFamilyAmbient } = require('../family-ambient');
  const stub = body => createFamilyAmbient({
    now: () => now, nodeHints: [],
    fetchData: async () => ({ response: { ok: Boolean(body) }, body })
  });
  const current = stub({ status: 'success', data: { fetchedAt: now.toISOString(),
    current: { temperatureC: 0, condition: 'Nuageux', private: 'sentinel' } } });
  assert.equal((await current.weather()).temperatureC, 0);
  assert.equal(await current.forecastTomorrow({ timeZone }), null);
  assert.doesNotMatch(JSON.stringify(await current.weather()), /sentinel|forecast|hourly/);
  const failed = stub(null);
  assert.equal(await failed.weather(), null);
  assert.equal(await failed.forecastTomorrow({ timeZone }), null);
});

test('only explicit single-intent utterances select tomorrow’s forecast', () => {
  const { isExplicitTomorrowWeather: matches } = require('../family-forecast');
  for (const s of ['Météo demain?', 'Nestor, quelle est la météo pour demain?', 'Il va faire quel temps demain?',
    'Quel temps fera-t-il demain?', 'C’est quoi la météo demain?', 'Donne-moi la météo de demain',
    'What’s the weather tomorrow?', 'Tomorrow’s weather?']) assert.equal(matches(s), true, s);
  for (const s of ['Bonjour', 'Ne me donne pas la météo demain', 'Quelle est la météo demain à Montréal?',
    'Météo demain et ouvre la fenêtre', 'Répète météo demain']) assert.equal(matches(s), false, s);
});

test('a narrow local Family voice lookup does not change other audience or backend paths', async () => {
  const { livingSourceContext } = require('../living-source-context');
  const reads = { current: 0, forecast: 0 };
  const setup = {
    pack: { id: 'family', childSafe: true }, session: {}, familyPackId: 'family',
    backend: 'agentx', channel: 'voice', userText: 'Quelle météo demain?', requestAt: now, timeZone,
    sources: { forAudience: () => ({ catalogue: () => ({ sources: [] }) }) },
    ambient: {
      weather: async () => { reads.current++; return null; },
      forecastTomorrow: async options => {
        reads.forecast++;
        assert.deepEqual(options, { timeZone, requestAt: now });
        return projectTomorrowHours(fixture, { timeZone, requestAt: now });
      }
    }
  };
  const text = await livingSourceContext(setup);
  assert.match(text, /covers only the hours listed, not the full day/);
  assert.match(text, /"targetDate":"2026-11-24"/);
  assert.doesNotMatch(text, /relative label|current conditions|sentinel/);
  for (const other of [{ channel: 'text' }, { backend: 'openclaw' }, { guardian: true }, { userText: 'Bonjour' },
    { pack: { id: 'personal_operator' }, session: { scopeId: 'personal' } }]) {
    assert.doesNotMatch(await livingSourceContext({ ...setup, ...other }), /hourly forecast/);
  }
  for (const other of [{ member: {} }, { consult: true }, { isLlmX: true }]) {
    assert.equal(await livingSourceContext({ ...setup, ...other }), '');
  }
  assert.deepEqual(reads, { current: 4, forecast: 1 });
  assert.match(await livingSourceContext({ ...setup, ambient: { weather: setup.ambient.weather } }),
    /no verified daytime forecast coverage/);
  assert.equal(reads.current, 4);
});


test('unqualified tomorrow declines night-only evidence without discarding a verified partial daytime', async () => {
  const { livingSourceContext } = require('../living-source-context');
  const contextFor = hourly => livingSourceContext({
    pack: { id: 'family', childSafe: true }, familyPackId: 'family',
    backend: 'agentx', channel: 'voice', userText: 'Météo demain?', requestAt: now, timeZone,
    sources: { forAudience: () => ({ catalogue: () => ({ sources: [] }) }) },
    ambient: { forecastTomorrow: async () => projectTomorrowHours({ ...fixture, hourly }, { timeZone, requestAt: now }) }
  });
  const night = { time: '2026-11-24T10:59:00Z', condition: 'night-sentinel' };
  const day = { time: '2026-11-24T11:00:00Z', condition: 'day-sentinel' };
  const onlyNight = await contextFor([night]);
  assert.match(onlyNight, /no verified daytime forecast coverage/);
  assert.doesNotMatch(onlyNight, /night-sentinel/);
  const partiallyDay = await contextFor([night, day]);
  assert.match(partiallyDay, /day-sentinel/);
  assert.match(partiallyDay, /covers only the hours listed, not the full day/);
});

test('combined precedence keeps a failed tomorrow request separate from a fresh current reading', async () => {
  const { livingSourceContext } = require('../living-source-context');
  const ambient = {
    forecastTomorrow: async () => { throw Error('simulated forecast failure'); },
    weather: async () => ({ fetchedAt: new Date().toISOString(), temperatureC: 99 }),
    peekWeather: () => { throw Error('must not peek for explicit question'); }
  };
  const options = { pack: { id: 'family', childSafe: true }, familyPackId: 'family',
    backend: 'agentx', channel: 'voice', timeZone, requestAt: now, ambient,
    sources: { forAudience: () => ({ catalogue: () => ({ sources: [] }) }) } };
  const forecast = await livingSourceContext({ ...options, userText: 'Quelle météo demain?' });
  assert.match(forecast, /no verified daytime forecast coverage/);
  assert.doesNotMatch(forecast, /99|simulated forecast failure|current conditions/);
  const current = await livingSourceContext({ ...options, userText: 'Quelle météo?' });
  assert.match(current, /"temperatureC":99/);
  const unrelated = await livingSourceContext({ ...options, userText: 'Quelle heure est-il?' });
  assert.doesNotMatch(unrelated, /"temperatureC"|Household forecast|Household weather/);
});

test('invalid calendar stamps and future issue cannot normalize into a trusted forecast', () => {
  const before = at('2026-12-01T04:15:00Z');
  const data = { forecastIssuedAt: '2026-12-01T04:00:00Z', fetchedAt: before.toISOString(),
    hourly: [{ time: '2026-12-01T12:00:00Z', condition: 'Clair' }] };
  const options = { timeZone, now: before, requestAt: before };
  assert.equal(projectTomorrowHours(data, options).targetDate, '2026-12-01');
  for (const issue of ['2026-11-31T04:00:00Z', '2026-11-30T24:00:00Z', '2026-12-01T04:15:30Z']) {
    assert.equal(projectTomorrowHours({ ...data, forecastIssuedAt: issue,
      fetchedAt: '2026-12-01T04:15:45Z' }, options), null);
  }
  for (const time of ['2026-11-31T12:00:00Z', '2026-11-30T24:00:00-05:00']) {
    assert.equal(projectTomorrowHours({ ...data, hourly: [{ time, condition: 'Clair' }] }, options), null);
  }
});

test('bounded relay compact projection carries all supported rows without catalogue, provider prose or current data', async () => {
  const { prepareLivingSourceContext } = require('../living-source-context');
  const { compactRelayForecast } = require('../family-forecast');
  const forecast = { targetDate: '2026-11-24', timeZone, hourly: Array.from({ length: 25 }, (_, index) => ({
    localTime: String(index === 24 ? 1 : index).padStart(2, '0') + ':00', offset: index === 24 ? 'GMT-4' : 'GMT-5',
    temperatureC: 0, precipitationChancePct: 10, condition: 'raw-condition ' + 'x'.repeat(65)
  })) };
  const options = { pack: { id: 'family', childSafe: true }, familyPackId: 'family', backend: 'agentx', channel: 'voice',
    userText: 'Quelle météo demain?', requestAt: now, timeZone,
    ambient: { forecastTomorrow: async () => forecast },
    sources: { forAudience: () => ({ catalogue: () => ({ label: 'catalogue-sentinel' }) }) } };
  const prepared = await prepareLivingSourceContext(options);
  assert.match(prepared.text, /catalogue-sentinel|raw-condition/);
  assert.doesNotMatch(prepared.relayForecastContext, /catalogue-sentinel|raw-condition/);
  assert.ok(prepared.relayForecastContext.length <= 1600);
  assert.match(prepared.relayForecastContext, /\["01:00","GMT-4",0,10\]/);
  assert.match(prepared.relayForecastContext, /\["23:00","GMT-5",0,10\]/);
  const tooLarge = compactRelayForecast({ ...forecast, hourly: [...forecast.hourly, ...forecast.hourly, ...forecast.hourly] },
    { timeZone, requestAt: now });
  assert.match(tooLarge, /coverage could not be delivered/);
  assert.doesNotMatch(tooLarge, /01:00/);
});
