'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const express = require('express');
const request = require('supertest');
const { configuration, readPlug } = require('../../../src/services/homeAssistantPlug');
const { allowedForFamilyDevice } = require('../family-device');
const { registerHomeAssistantRoutes } = require('../home-assistant-routes');
const { contract, createReplyChannels } = require('../reply-channels');
const { createScreenServices, screenPolicy } = require('../screen-services');
const { createConversationExecutor } = require('../conversation-executor');

const REPORT = '2026-10-12T12:34:56.789123+00:00';
const SWITCH = 'switch.test_plug';
const POWER = 'sensor.test_plug_power';
const PANEL = 'home-assistant-panel';

function instance(t, baseUrl = 'http://example.invalid') {
  const root = mkdtempSync(join(tmpdir(), 'agentx-home-assistant-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'credentials'));
  const save = plug => writeFileSync(join(root, 'config/home-assistant.json'), JSON.stringify({
    baseUrl, plug: { label: 'Prise de l’atelier', switchEntity: SWITCH, powerEntity: POWER, ...plug }
  }));
  save({});
  const env = { AGENTX_INSTANCE_ROOT: root, PLANNING_TIME_ZONE: 'America/Toronto' };
  return { env, save, config: configuration(env) };
}

test('a completed native receipt without a streamed page retains Maison on the same Hermes turn', async t => {
  const { env } = instance(t);
  env.HOUSEHOLD_CONVERSATION_RELAY_ENABLED = 'true';
  const screenPages = createScreenServices({ env });
  const inputText = 'combien de watts tire la prise de l’atelier?';
  const sessionId = 'synthetic-owner-session', traceId = 'synthetic-browser-turn', runId = 'run_synthetic';
  const session = { sessionId, packId: 'personal_operator', scopeId: 'personal', backend: 'hermes',
    hermesRuntime: { turnId: traceId, runId, requestText: inputText, sessionKey: 'agentx:personal:' + sessionId,
      state: 'completed', receipt: { run_id: runId, status: 'completed', output: 'La prise tire 17 W.' } } };
  const turn = { traceId, inputText, outcome: 'pending' };
  let stored;
  const run = createConversationExecutor({ env, screenPages, conversations: {
    getTurn: async () => turn,
    settleTurn: async record => { stored = record; },
    recordTurn: async () => assert.fail('Recovery must settle the original turn')
  } });
  assert.deepEqual(await run.reconcile(session), { state: 'completed' });
  assert.equal(stored.traceId, traceId);
  assert.equal(stored.replyText, 'La prise tire 17 W.');
  assert.deepEqual(stored.display.map(block => block.body), [PANEL]);
  assert.equal(stored.written.segments.at(-1).blockId, stored.display[0].id);
  assert.equal(stored.toolEvidence.runId, runId);
});

test('closing the browser stream after Hermes starts still saves Maison on the original turn', async t => {
  const { env } = instance(t);
  Object.assign(env, { HOUSEHOLD_HERMES_URL: 'http://hermes.example.invalid', HOUSEHOLD_HERMES_TOKEN: 'fixture-only' });
  const screenPages = createScreenServices({ env });
  const { harness } = require('./fixtures/persona-journey.cjs');
  const res = new EventEmitter();
  Object.assign(res, { writableEnded: false, status: () => res, set: () => res,
    write: () => { if (res.closed) assert.fail('Cannot write to the disconnected response'); },
    end: () => assert.fail('No final response can be sent over the closed connection') });
  let calls = 0;
  const journey = harness({ packId: 'personal_operator', backend: 'hermes', screenPages, conversationEnv: env,
    validClientTurnId: () => true, hermesClient: async request => {
      calls++;
      res.closed = true;
      res.emit('close');
      assert.equal(request.signal.aborted, false);
      request.onDelta('La prise tire 17 W.');
      return { text: 'La prise tire 17 W.', metadata: {}, tools: { status: 'observed', receipts: [] } };
    } });
  await journey.handle({ params: { sessionId: journey.session.sessionId },
    body: { text: 'combien de watts tire la prise de l’atelier?', stream: true, channel: 'text', turnId: 'synthetic-browser-turn' } }, res, 'private');
  assert.equal(calls, 1);
  assert.equal(journey.turns.length, 1);
  assert.equal(journey.turns[0].clientTurnId, 'synthetic-browser-turn');
  assert.deepEqual(journey.turns[0].display.map(block => block.body), [PANEL]);
});

test('Core only performs the two configured state GETs and keeps both report times', async t => {
  const calls = [];
  let unavailable = false;
  const upstream = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    const entity_id = req.url.split('/').at(-1);
    if (unavailable && entity_id === POWER) {
      res.writeHead(302, { Location: '/unconfigured' }).end();
      return;
    }
    const outlet = entity_id === SWITCH;
    res.end(JSON.stringify({ entity_id, state: outlet ? 'off' : '0',
      ...(outlet ? { last_reported: REPORT } : { last_updated: '2026-10-12T12:33:00Z' }),
      attributes: { unit_of_measurement: 'W', private: 'not returned' } }));
  });
  upstream.listen(0, '127.0.0.1');
  t.after(() => upstream.close());
  await once(upstream, 'listening');
  const { config } = instance(t, 'http://127.0.0.1:' + upstream.address().port);
  assert.equal((await readPlug({ config })).status, 'credentials_unavailable');
  assert.equal(calls.length, 0);
  writeFileSync(config.tokenFile, 'fixture-token\n', { mode: 0o600 });
  const checkedAt = '2026-10-12T12:35:00.000Z';
  const now = () => Date.parse(checkedAt);
  const state = { value: 'off', reportedAt: '2026-10-12T12:34:56.789Z' };
  assert.deepEqual(await readPlug({ config, now }), { source: 'home-assistant', label: 'Prise de l’atelier',
    status: 'available', checkedAt, state, power: { watts: 0, reportedAt: '2026-10-12T12:33:00.000Z' } });
  unavailable = true;
  assert.deepEqual(await readPlug({ config, now }), { source: 'home-assistant', label: 'Prise de l’atelier',
    status: 'partial', checkedAt, state, power: null });
  assert.deepEqual(calls.map(c => c.url).sort(), [SWITCH, POWER, SWITCH, POWER].map(id => '/api/states/' + id).sort());
  assert.ok(calls.every(c => c.method === 'GET' && c.authorization === 'Bearer fixture-token'));
});

test('unknown state, mismatched identity, and an unsafe device mapping yield no measurements', async t => {
  const { config, env, save } = instance(t);
  writeFileSync(config.tokenFile, 'fixture-token');
  const fetchImpl = async url => ({ ok: true, json: async () => url.pathname.endsWith(SWITCH)
    ? { entity_id: SWITCH, state: 'unavailable', last_reported: REPORT }
    : { entity_id: 'sensor.other_power', state: '22', last_reported: REPORT, attributes: { unit_of_measurement: 'W' } } });
  const result = await readPlug({ config, fetchImpl });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.state, null);
  assert.equal(result.power, null);
  save({ powerEntity: 'sensor.test/plugs' });
  assert.equal(configuration(env), null);
});

test('personal replies show the current home panel and the page preserves private camera navigation', async t => {
  const { env } = instance(t);
  const app = express();
  const cameraHref = 'http://example.invalid/cameras/direct';
  const catalog = createScreenServices({ app, env, services: [
    { id: 'home-assistant', label: 'Home Assistant', href: 'http://example.invalid', mode: 'link' },
    { id: 'garage-camera', label: 'Caméra du garage', href: cameraHref, mode: 'link' }
  ] });
  for (const text of ['Parle-moi de HomeAssitant', 'La prise de l’atelier tire combien?', 'Show me the garage camera']) {
    assert.equal(catalog.homeAssistantPageFor(text), PANEL, text);
  }
  for (const text of ['Offre-moi un café', 'Quel GPU est allumé?', 'N’ouvre pas Home Assistant', 'Don’t show Home Assistant']) {
    assert.equal(catalog.homeAssistantPageFor(text), undefined, text);
  }
  assert.equal(catalog.family.parse(PANEL), null);
  assert.equal(catalog.family.parse('garage-camera'), null);
  assert.doesNotMatch(contract({ family: true, pages: true, pageCatalog: catalog }), /home_assistant_plug/);
  assert.match(contract({ pages: true, pageCatalog: catalog }), /home_assistant_plug/);
  for (const modelPage of ['', '<show kind="page">home-assistant-panel</show>']) {
    const events = [];
    const channels = createReplyChannels({ allowPages: true, pageCatalog: catalog, onShow: block => events.push(block) });
    channels.push('La prise est allumée.' + modelPage);
    const answer = channels.end({ fallbackPage: catalog.homeAssistantPageFor('Home Assistant') });
    assert.equal(answer.say, 'La prise est allumée.');
    assert.deepEqual(events.map(block => block.body), [PANEL]);
    assert.deepEqual(answer.display, events);
  }
  const url = catalog.url(catalog.parse(PANEL));
  assert.equal(url, '/dad/home-assistant?view=screen&from=nestor');
  assert.equal(allowedForFamilyDevice({ method: 'GET', path: '/dad/home-assistant' }), false);
  app.use(screenPolicy(catalog));
  let readCount = 0;
  registerHomeAssistantRoutes({ app, screenPages: catalog, env, read: async ({ config }) => {
    readCount++;
    assert.equal(config.switchEntity, SWITCH);
    return { label: 'Prise de l’atelier', state: { value: 'on', reportedAt: REPORT },
      power: readCount === 1 ? { watts: 12.5, reportedAt: REPORT } : null, checkedAt: REPORT };
  } });
  const shown = await request(app).get(url).expect(200).expect('Cache-Control', 'private, no-store').expect('X-Frame-Options', 'SAMEORIGIN');
  assert.match(shown.text, /Allumée/);
  assert.match(shown.text, /12,5 W/);
  assert.match(shown.text, /<time datetime="2026-10-12T12:34:56/);
  assert.ok(shown.text.includes('href="' + cameraHref + '" target="_blank" rel="noopener noreferrer"'));
  assert.doesNotMatch(shown.text, /switch\.test_plug|sensor\.test_plug|fixture-token/);
  const refreshed = await request(app).get(url).expect(200);
  assert.match(refreshed.text, /Indisponible/);
  assert.doesNotMatch(refreshed.text, /12,5 W/);
});
