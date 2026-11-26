'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequire } = require('node:module');
const { setImmediate: tick } = require('node:timers/promises');
const { listenLoopback } = require('../shared/testing/listenLoopback');

test('one background EC retrieval serves a cold Family follow-up and its dated alert tool call', async t => {
  process.env.NODE_ENV = 'test';
  process.env.PLANNING_TIME_ZONE = 'America/Toronto';
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-26T16:00:00Z') });
  const observed = '2026-11-26T15:45:00Z', issued = '2026-11-26T14:00:00Z', expiry = '2026-11-26T20:00:00Z';
  const page = { features: [{ geometry: { coordinates: [-70, 47] }, properties: {
    currentConditions: { timestamp: observed, temperature: { value: 6 } },
    forecastGroup: { timestamp: issued, forecasts: [{
      period: { textForecastName: 'Demain' }, abbreviatedForecast: { textSummary: 'Neige de fixture' },
      temperatures: { temperature: [{ class: 'high', value: -3 }] }
    }] }, warnings: [{ description: 'Brouillard de fixture', eventIssue: issued, expiryTime: expiry }]
  } }] };
  const express = createRequire(require.resolve('../data/package.json'))('express');
  const city = require('../data/services/livedata/ecCityPage');
  const { createFamilyAmbient } = require('../core/surfaces/household/family-ambient');
  const { harness } = require('../core/surfaces/household/test/fixtures/persona-journey.cjs');
  const app = express(), localReads = [];
  const position = { lat: 47, lon: -70, name: 'Private fixture station' };
  app.locals.db = { collection: () => ({ findOne: async () => position }) };
  app.use('/api/v1/livedata', require('../data/routes/livedata.routes'));
  const server = http.createServer(app);
  const address = await listenLoopback(server);
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = 'http://127.0.0.1:' + address.port;
  process.env.DATAAPI_BASE_URL = origin;
  let upstream = 0;
  const fetchLoopback = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    if (target.origin === 'https://api.weather.gc.ca' && target.pathname === '/collections/citypageweather-realtime/items') {
      upstream++;
      return Response.json(page);
    }
    assert.equal(target.origin, origin);
    assert.equal(target.pathname, '/api/v1/livedata/ec-weather');
    assert.equal(target.searchParams.get('prepared'), '1');
    localReads.push(target.search);
    return fetchLoopback(url, options);
  });
  const stopPreparing = city.startPreparation(app.locals.db);
  t.after(stopPreparing);
  await tick();
  assert.equal(upstream, 1);
  await city.getCityWeather(position); // Join the producer's existing fetch before opening Core.
  assert.equal(city.peekCityWeather(position).preparedStatus, 'fresh');
  assert.deepEqual(localReads, []);

  // The simulated model uses only what the turn supplies; the alert tool runs
  // through the real household handler and the tool result feeds the next round.
  let stage = 0;
  const ambient = createFamilyAmbient();
  const agent = harness({ packId: 'kidx_nestor', backend: 'agentx', ambient,
    conversationEnv: { HOUSEHOLD_FAMILY_TOOLS: 'source_read', HOUSEHOLD_FAMILY_PREPARED_WEATHER_CONTEXT: 'true', HOUSEHOLD_CONVERSATION_RELAY_ENABLED: 'true' },
    continuityExecute: async body => {
      const question = body.messages.at(-1).content;
      const evidenceLine = question.split('\n').find(line => line.includes('{"observation":'));
      const facts = JSON.parse(evidenceLine.slice(evidenceLine.indexOf('{"observation":'), evidenceLine.lastIndexOf('}') + 1));
      stage++;
      if (stage === 1) return { ok: true, body: { response: `Il fait ${facts.observation.temperatureC} degrés.` } };
      if (stage === 2) {
        assert.match(question, /Et demain/);
        const tomorrow = facts.forecastExcerpt.periods.find(period => period.period === 'Demain');
        return { ok: true, body: { response: `${tomorrow.short}, maximum ${tomorrow.temperatures[0].valueC} degrés.` } };
      }
      assert.ok(body.tools.some(tool => tool.function.name === 'source_read'));
      return { ok: true, body: { message: { tool_calls: [
        { function: { name: 'source_read', arguments: { source: 'weather', section: 'alerts' } } }
      ] } } };
    },
    response: body => {
      const tool = body.messages.at(-1);
      assert.equal(tool.role, 'tool');
      const receipt = JSON.parse(tool.content);
      assert.equal(receipt.status, 'available');
      assert.equal(receipt.audience, 'household');
      const alert = receipt.data.warnings[0];
      assert.equal(alert.issuedAt, new Date(issued).toISOString());
      assert.equal(alert.expiresAt, new Date(expiry).toISOString());
      return `${alert.description}, échéance ${alert.expiresAt}.`;
    } });
  await agent.turn('Quel temps fait-il ?', 'voice');
  assert.match(agent.turns[0].replyText, /6 degrés/);
  await agent.turn('Et demain ?', 'voice');
  assert.match(agent.turns[0].replyText, /Neige de fixture, maximum -3 degrés/);
  await agent.turn('Y a-t-il une alerte météo ?', 'voice');
  assert.match(agent.turns[0].replyText, /Brouillard de fixture/);
  assert.ok(agent.turns[0].toolEvidence.receipts.some(row => row.tool === 'source_read' && row.status === 'completed'));
  assert.equal(stage, 3);
  assert.equal(upstream, 1);
  assert.deepEqual(localReads, ['?lang=fr&prepared=1']);
});
