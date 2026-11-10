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

for (const backend of ['agentx', 'openclaw']) test('dated family weather reaches the ' + backend + ' turn, never a personal/reader turn', async () => {
  let reads = 0;
  const ambient = { weather: async () => { reads++; return { fetchedAt: new Date().toISOString(), temperatureC: 4.5, condition: 'Nuageux' }; } };
  const family = harness({ packId: 'kidx_nestor', backend, ambient });
  await family.turn('Quelle est la météo?', 'voice');
  assert.match(family.sent[0].request, /"temperatureC":4.5/);
  assert.doesNotMatch(family.sent[0].prefix, /"temperatureC"/);
  for (const packId of ['personal_operator', 'kidx_reader']) {
    const other = harness({ packId, backend, ambient }); await other.turn('Bonjour', 'voice');
    assert.doesNotMatch(other.sent[0].request, /Household weather/);
  }
  assert.equal(reads, 1);
});

test('local guardian keeps the supplied weather and reports actual execution before reply parsing', async () => {
  let evidence;
  const request = { backend: 'agentx', session: { packId: 'kidx_nestor', modeId: 'chat' },
    pack: { childSafe: true, id: 'kidx_nestor', taskType: 'test' }, text: 'La météo?', history: [],
    agentxInstructions: 'Family instructions', familyWeatherContext: 'Dated weather: 4.5 C', onExecution: value => { evidence = value; } };
  const result = await runLocalConversation({ request, prepared: [], env: { HOUSEHOLD_CONVERSATION_RELAY_ENABLED: 'true' },
    inference: { conversation: async (_body, options) => {
      assert.match(options.familyInstructions, /Dated weather: 4.5 C/);
      return { ok: true, body: { response: 'Il fait 4,5 degrés.' }, metadata: { model: 'synthetic-guardian',
        conversationContinuity: { state: 'backup', reason: 'primary_busy', model: 'synthetic-guardian' } } };
    } } });
  assert.equal(evidence.model, 'synthetic-guardian'); assert.equal(evidence.continuity.reason, 'primary_busy');
  assert.equal(result.tools.conversationRelay.role, 'relay');
});
