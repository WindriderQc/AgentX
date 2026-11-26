'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { harness } = require('./fixtures/persona-journey.cjs');
const { createFamilyAmbient } = require('../family-ambient');

test('Family turns can use a single prepared bulletin without synchronous collection', async t => {
  const now = new Date();
  const localReads = [];
  const ambient = createFamilyAmbient({
    now: () => now,
    fetchData: async (path, { query }) => {
      localReads.push({ path, query });
      return { response: { ok: true }, body: { status: 'success', data: {
        preparedStatus: 'fresh', fetchedAt: now.toISOString(), forecastIssuedAt: now.toISOString(),
        current: { temperatureC: 6, condition: 'Fixture-observation', observedAt: now.toISOString() },
        forecasts: [{ period: 'Demain', short: 'Fixture-prévision', temperatures: [{ class: 'high', valueC: 14 }] }],
        warnings: []
      } } };
    }
  });
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx', ambient,
    conversationEnv: { HOUSEHOLD_FAMILY_TOOLS: 'source_read', PLANNING_TIME_ZONE: 'America/Toronto' } });
  for (const [id, text] of [
    ['moon', 'Pourquoi la Lune change-t-elle de forme ?'],
    ['greeting', 'Bonjour !'],
    ['conditions', 'Quel temps fait-il dehors ?'],
    ['follow-up', 'Et demain ?']
  ]) {
    const started = performance.now();
    await h.turn(text, 'voice');
    const duration = performance.now() - started;
    const turn = h.turns[0];
    assert.equal(turn.inputText, text);
    assert.ok(turn.replyText.length > 0);
    assert.ok(h.sent.at(-1).tools.some(tool => tool.function.name === 'source_read'));
    assert.doesNotMatch(h.sent.at(-1).request, /Core living-source catalogue/);
    assert.match(h.sent.at(-1).request, /Fixture-observation/);
    assert.match(h.sent.at(-1).request, /Fixture-prévision/);
    assert.equal(h.state.recordedNotes.length, 0);
    t.diagnostic(JSON.stringify({ id, simulatedHandlerMs: Math.round(duration),
      localReadsSoFar: localReads.length, modelToolReceipts: turn.toolEvidence?.receipts?.length ?? null }));
  }
  assert.deepEqual(localReads, [{ path: '/api/v1/livedata/ec-weather', query: 'lang=fr&prepared=1' }]);
});

test('an optional weather excerpt stays silent for missing, future and expired observations', async () => {
  const { forTurn } = require('../prepared-weather-context');
  const requestAt = new Date('2026-11-26T18:00:00Z');
  const options = { requestAt, timeZone: 'America/Toronto' };
  const quiet = { text: '', relay: '' };
  assert.deepEqual(await forTurn({ preparedWeather: async () => { throw Error('offline'); } }, options), quiet);
  for (const [observedAt, observationAgeMs] of [
    ['2026-11-26T18:00:05Z', 0], ['2026-11-26T14:00:00Z', 4 * 3600000]
  ]) {
    const current = { status: 'available', data: { temperatureC: 21, observedAt }, freshness: { observationAgeMs } };
    assert.deepEqual(await forTurn({ preparedWeather: async () => ({ current }) }, options), quiet);
  }
});

test('the local relay gets only the dated hours with measured numbers from the prepared forecast', async () => {
  const { forTurn } = require('../prepared-weather-context');
  const requestAt = new Date('2026-11-26T18:00:00Z');
  const forecast = { status: 'available', data: { periods: [], issueDate: '2026-11-26',
    fetchedAt: requestAt.toISOString(), forecastIssuedAt: requestAt.toISOString(),
    hourly: [{ time: '2026-11-27T12:00:00Z', temperatureC: 0, condition: 'EXCLUDED_TEXT' },
      { time: '2026-11-27T15:00:00Z', condition: 'EXCLUDED_TEXT' }] } };
  const { relay } = await forTurn({ preparedWeather: async () => ({ forecast }) }, { requestAt, timeZone: 'America/Toronto' });
  assert.match(relay, /2026-11-27/);
  assert.match(relay, /07:00/);
  assert.doesNotMatch(relay, /10:00|EXCLUDED_TEXT|Say that/);
  assert.ok(relay.length <= 1600);
});
