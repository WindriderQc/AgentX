'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { livingSourceContext } = require('../living-source-context');
const { createFamilyAmbient } = require('../family-ambient');

const initial = {
  pack: { id: 'family', childSafe: true }, familyPackId: 'family',
  backend: 'agentx', channel: 'voice',
  sources: { forAudience: () => ({ catalogue: () => ({ sources: [] }) }) }
};

test('unrelated local Famille turns finish context while one expired weather refresh is held', async () => {
  let now = new Date(Date.now() - 600001), started = 0, callback;
  const ambient = createFamilyAmbient({
    now: () => now,
    nodeHints: [], observer: async () => null, issPasses: async () => null,
    fetchData: async (path, opts) => {
      assert.equal(path, '/api/v1/livedata/ec-weather');
      assert.equal(opts.timeoutMs, 8000);
      started++;
      if (started === 2) await new Promise(resolve => { callback = resolve; });
      return { response: { ok: true }, body: { status: 'success', data: {
        fetchedAt: now.toISOString(), observedAt: now.toISOString(),
        current: { temperatureC: started === 1 ? 9 : 13, observedAt: now.toISOString() }
      } } };
    }
  });
  assert.equal((await ambient.weather()).temperatureC, 9);
  now = new Date(now.getTime() + 600001);
  const ordinary = ['Quelle heure est-il?', 'Raconte-moi une histoire.', 'Présente ma prévision de budget.', 'Et là?',
    'Raconte-moi une histoire sur la météo.', 'Explique la science de la météo.',
    'Météo à Montréal?', 'What causes the weather to change?', 'Can you tell me the weather in Montreal?',
    'Ne lance pas la météo.', 'Météo de la journée du mariage?'];
  for (const userText of ordinary) {
    // Exact assertion before any refresh: unrelated speech cannot initiate one.
    const result = await Promise.race([
      livingSourceContext({ ...initial, ambient, userText }),
      new Promise(resolve => setImmediate(() => resolve(null)))
    ]);
    assert.ok(result, 'ordinary turn must resolve without requiring weather I/O');
    assert.doesNotMatch(result, /Household weather|"temperatureC":9/);
  }
  assert.equal(started, 1);
  let explicitComplete = false;
  const explicit = livingSourceContext({ ...initial, ambient, userText: 'Quelle est la météo?' })
    .then(result => { explicitComplete = true; return result; });
  const publicAmbient = ambient.snapshot();
  assert.equal(started, 2);
  // Give both calls one event-loop turn; neither may join the deferred refresh.
  for (const userText of ordinary) {
    const result = await Promise.race([
      livingSourceContext({ ...initial, ambient, userText }),
      new Promise(resolve => setImmediate(() => resolve(null)))
    ]);
    assert.ok(result);
    assert.doesNotMatch(result, /Household weather|"temperatureC":9/);
  }
  assert.equal(explicitComplete, false);
  assert.equal(started, 2);
  callback();
  assert.match(await explicit, /"temperatureC":13/);
  assert.equal((await publicAmbient).weather.temperatureC, 13);
  assert.equal(started, 2);
});

test('explicit weather still uses current source freshness, including French and English', async () => {
  let reads = 0;
  const ambient = { weather: async () => {
    reads++;
    return { fetchedAt: '2000-01-01T00:00:00.000Z', temperatureC: 99 };
  } };
  const questions = ['La météo?', 'Quel temps fait-il?', 'Est-ce qu’il pleut?', 'Il fait combien dehors?',
    'Il fait quel temps?', 'Quelle température dehors?', 'Is it snowing?', 'What’s the temperature?', 'How cold is it?', 'What is the weather?', 'Nestor, peux-tu me dire il fait combien dehors?',
    'Y fait combien dehors?', 'Il pleut-tu dehors?', 'Il neige-tu présentement?', 'Quelle est la météo aujourd’hui?'];
  for (const userText of questions) {
    const result = await livingSourceContext({ ...initial, ambient, userText });
    assert.match(result, /current conditions are unavailable or outdated/);
    assert.doesNotMatch(result, /"temperatureC":99/);
  }
  assert.equal(reads, questions.length);
});

test('a polite request for outdoor weather reads current conditions on a cold cache', async () => {
  let reads = 0, forecasts = 0;
  const observedAt = new Date().toISOString();
  const ambient = {
    peekWeather: () => null,
    weather: async () => { reads++; return { observedAt, fetchedAt: observedAt, temperatureC: 14 }; },
    forecastTomorrow: async () => { forecasts++; return null; }
  };
  const context = userText => livingSourceContext({ ...initial, ambient, userText });
  for (const unrelated of ['Est-ce que tu peux me dire la météo extérieure à Paris?',
    'Est-ce que tu peux me dire comment on prévoit la météo?', 'Est-ce que tu peux me dire une blague?']) {
    assert.doesNotMatch(await context(unrelated), /Household weather/);
  }
  assert.match(await context('La météo demain?'), /Household forecast/);
  assert.equal(forecasts, 1);
  assert.equal(reads, 0);
  for (const current of ['Quelle est la météo?', 'Est-ce que tu peux me dire la météo extérieure?']) {
    assert.match(await context(current), /"temperatureC":14/);
  }
  assert.equal(reads, 2);
  assert.equal(forecasts, 1);
});

test('scope remains limited to the local Famille voice principal', async () => {
  let reads = 0;
  const ambient = { weather: async () => { reads++; return null; } };
  const common = { ...initial, ambient, userText: 'Bonjour' };
  for (const options of [{ channel: 'text' }, { backend: 'openclaw' }, { guardian: true },
    { pack: { id: 'personal_operator' }, session: { scopeId: 'personal' } }]) {
    assert.match(await livingSourceContext({ ...common, ...options }), /Household weather/);
  }
  assert.equal(reads, 4);
  for (const options of [{ member: {} }, { consult: true }, { isLlmX: true }]) {
    assert.equal(await livingSourceContext({ ...common, ...options }), '');
  }
  assert.equal(reads, 4);
});

test('short follow-up uses only hot, independently fresh and dated observations without I/O', async () => {
  const now = new Date();
  const iso = (delta = 0) => new Date(now.getTime() + delta).toISOString();
  const values = [
    [iso(-60000), true], [iso(-30 * 60000 - 2000), false], [iso(60000), false], [null, false]
  ];
  for (const [observedAt, accepted] of values) {
    let reads = 0;
    const ambient = createFamilyAmbient({
      now: () => now, nodeHints: [],
      fetchData: async () => {
        reads++;
        return { response: { ok: true }, body: { status: 'success', data: {
          fetchedAt: iso(), current: { temperatureC: 7, observedAt }
        } } };
      }
    });
    const common = { ...initial, ambient, userText: 'Et là?' };
    assert.doesNotMatch(await livingSourceContext(common), /Household weather/);
    assert.equal(reads, 0);
    await ambient.weather();
    const followup = await livingSourceContext(common);
    if (accepted) {
      assert.match(followup, /"temperatureC":7/);
      assert.match(followup, /never substitute it for observedAt/);
    } else assert.doesNotMatch(followup, /Household weather/);
    assert.doesNotMatch(await livingSourceContext({ ...common, userText: 'Raconte-moi une histoire.' }), /Household weather/);
    assert.equal(reads, 1);
  }
});
