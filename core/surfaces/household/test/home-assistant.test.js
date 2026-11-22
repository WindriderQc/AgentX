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
const { readHouseEcosystem, ecosystemScene } = require('../housex-ecosystem');
const { contract, createReplyChannels } = require('../reply-channels');
const { createScreenServices, screenPolicy, requestsScreenVisit } = require('../screen-services');
const { createConversationExecutor } = require('../conversation-executor');

const REPORT = '2026-10-12T12:34:56.789123+00:00';
const SWITCH = 'switch.test_plug';
const POWER = 'sensor.test_plug_power';
const PANEL = 'home-assistant-panel';
const SECOND = { id: 'plug-two', label: 'Prise 2 de l’atelier', aliases: ['deuxième prise', 'kasa 2'],
  switchEntity: 'switch.test_second', powerEntity: 'sensor.test_second_power', energyEntity: 'sensor.test_second_energy' };
const SECOND_PAGE = 'home-assistant-device-' + SECOND.id;

function instance(t, baseUrl = 'http://example.invalid') {
  const root = mkdtempSync(join(tmpdir(), 'agentx-home-assistant-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'credentials'));
  const save = (plug, additionalPlugs) => writeFileSync(join(root, 'config/home-assistant.json'), JSON.stringify({
    baseUrl, plug: { label: 'Prise de l’atelier', switchEntity: SWITCH, powerEntity: POWER, ...plug }, additionalPlugs
  }));
  save({});
  const env = { AGENTX_INSTANCE_ROOT: root, PLANNING_TIME_ZONE: 'America/Toronto' };
  return { env, save, config: configuration(env) };
}

test('HouseX renders a private ecosystem layer bound to configured Core observations', async t => {
  const { env } = instance(t);
  const config = name => join(env.AGENTX_INSTANCE_ROOT, 'config', name + '.json');
  const save = (name, data) => writeFileSync(config(name), JSON.stringify(data));
  save('housex-layout', { version:1, boxes:[{ position:[0,0,0], size:[2,1,2], color:'#112233', layer:1 }], rooms:[], pins:[] });
  save('ecosystem-live', { version:1, nodes:[{ id:'service', services:['local-service'] },
    { id:'work-one', hosts:['host-one'] }, { id:'work-two', hosts:['host-two'] }] });
  const definition = { version:1, hub:{ id:'service', label:'Service' }, towers:[
    { id:'work-one', label:'Work 1', color:'#77eecc', gpus:1 },
    { id:'work-two', label:'Work 2', color:'#aa77ee', gpus:2 }
  ] };
  save('housex-ecosystem', definition);
  const app = express();
  const catalog = createScreenServices({ app, env, services:[] });
  const page = 'housex-ecosystem';
  assert.deepEqual(catalog.automaticPage('Montre-moi HouseX Écosystème'), { page, force: true });
  assert.equal(catalog.automaticPage('N’affiche pas HouseX Écosystème'), undefined);
  assert.equal(catalog.family.parse(page), null);
  const scene = ecosystemScene(readHouseEcosystem(env));
  assert.deepEqual(scene.pins.map(pin => pin.id), ['service','work-one','work-two']);
  assert.equal(scene.paths.length,2);
  assert.deepEqual(scene.boxes.map(shape => shape.statusFor).filter(Boolean), ['service','work-one','work-two']);
  let reads = 0;
  app.use(screenPolicy(catalog));
  registerHomeAssistantRoutes({ app, screenPages:catalog, env, read:async () => {
    reads++;
    return { label:'Prise', checkedAt:REPORT };
  } });
  await request(app).get('/dad/home-assistant?layer=bogus').expect(404);
  assert.equal(reads,0);
  const shown = await request(app).get(catalog.url(catalog.parse(page))).expect(200).expect('X-Frame-Options','SAMEORIGIN');
  assert.match(shown.text, /data-home hidden/);
  assert.match(shown.text, /data-infrastructure data-timezone/);
  assert.match(shown.text, /data-pin="work-two"/);
  assert.doesNotMatch(shown.text, /local-service|host-two/);
  save('housex-ecosystem', { ...definition, hub:{ id:'unknown', label:'Service' } });
  assert.equal(readHouseEcosystem(env),null);
  await request(app).get(catalog.url(catalog.parse(page))).expect(404);
});

test('personal screen shortcuts select separate destinations and remain foreground requests', t => {
  const { env } = instance(t);
  const catalog = createScreenServices({ env, services: [] });
  const ecosystemOnly = createScreenServices({ env: {}, services: [] });
  for (const [text, page, pathname] of [
    ['montre-moi l’écosystème', 'ecosystem', '/diskx'],
    ['montre-moi la maison', PANEL, '/dad/home-assistant']
  ]) {
    assert.deepEqual(catalog.automaticPage(text), { page, force: true });
    assert.equal(requestsScreenVisit(text, catalog), true);
    const url = new URL(catalog.url(catalog.parse(page)), 'https://fixture.test');
    assert.equal(url.pathname, pathname);
    assert.equal(url.searchParams.get('app'), page === 'ecosystem' ? 'ecosystem' : null);
    assert.equal(url.searchParams.has('layer'), false);
  }
  assert.equal(ecosystemOnly.automaticPage("Montre-moi l'écosystème")?.page, 'ecosystem');
  assert.equal(ecosystemOnly.automaticPage('Montre-moi la maison'), undefined);
  assert.equal(catalog.automaticPage('Ne me montre pas l’écosystème'), undefined);
  assert.equal(catalog.automaticPage('Montre-moi l’écosystème et guide-moi dans la mémoire'), undefined);
});

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

for (const [input, page, wrongPage, optionalHome] of [
  ['combien de watts tire la prise 2 de l’atelier?', SECOND_PAGE, PANEL, true],
  ['montre-moi la maison', PANEL, 'ecosystem', true],
  ['montre-moi l’écosystème', 'ecosystem', PANEL, false]
]) test('a cut Hermes stream preserves the exact display for: ' + input, async t => {
  const { env, save } = optionalHome ? instance(t) : { env: {} };
  if (optionalHome) save({}, [SECOND]);
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
      const reply = 'Voici la page.<show kind="page">' + wrongPage + '</show>';
      request.onDelta(reply);
      return { text: reply, metadata: {}, tools: { status: 'observed', receipts: [] } };
    } });
  await journey.handle({ params: { sessionId: journey.session.sessionId },
    body: { text: input, stream: true, channel: 'text', turnId: 'synthetic-browser-turn' } }, res, 'private');
  assert.equal(calls, 1);
  assert.equal(journey.turns.length, 1);
  assert.equal(journey.turns[0].clientTurnId, 'synthetic-browser-turn');
  assert.deepEqual(journey.turns[0].display.map(block => block.body), [page]);
});

test('a named plug uses only its own configured sensor paths and opening Maison selects the same plug', async t => {
  const { env, config, save } = instance(t);
  save({ aliases: ['prise 1'] }, [SECOND]);
  writeFileSync(config.tokenFile, 'fixture-token');
  const reads = [];
  const fetchImpl = async (url, options) => {
    reads.push([url.pathname, options.method]);
    const entity_id = url.pathname.split('/').at(-1);
    const isSwitch = entity_id === SECOND.switchEntity;
    const isEnergy = entity_id === SECOND.energyEntity;
    return { ok: true, json: async () => ({ entity_id, state:isSwitch ? 'on' : isEnergy ? '3.4' : '48',
      last_reported: REPORT, attributes:{ unit_of_measurement:isEnergy ? 'kWh' : 'W' } }) };
  };
  assert.equal((await readPlug({ config: configuration(env), device: 'sensor.other', fetchImpl })).status, 'not_configured');
  assert.deepEqual(reads, []);
  const result = await readPlug({ config: configuration(env), device: SECOND.id, fetchImpl });
  assert.equal(result.power.watts, 48);
  assert.equal(result.energy.kilowattHours, 3.4);
  assert.deepEqual(reads.sort(), [SECOND.switchEntity, SECOND.powerEntity, SECOND.energyEntity].map(key => ['/api/states/' + key, 'GET']).sort());

  const app = express();
  const catalog = createScreenServices({ app, env, services:[] });
  assert.equal(catalog.automaticPage('Est-ce que la deuxième prise est allumée?')?.page, SECOND_PAGE);
  assert.equal(catalog.automaticPage('Combien tire la prise 1?')?.page, PANEL);
  assert.equal(catalog.automaticPage('N’ouvre pas la vue, lis-moi la Kasa 2')?.page, undefined);
  assert.equal(catalog.homeAssistantDeviceForText('N’ouvre pas la vue, lis-moi la Kasa 2'), SECOND.id);
  assert.equal(catalog.family.parse(SECOND_PAGE), null);
  const url = catalog.url(catalog.parse(SECOND_PAGE));
  assert.match(url, /^\/dad\/home-assistant\?device=plug-two/);
  let readsFromPage = 0;
  app.use(screenPolicy(catalog));
  registerHomeAssistantRoutes({ app, screenPages:catalog, env,
    read: async ({ config }) => {
      readsFromPage++;
      assert.equal(config.switchEntity, SECOND.switchEntity);
      return result;
    } });
  await request(app).get(url + '&device=unknown').expect(404);
  const page = await request(app).get(url).expect(200).expect('X-Frame-Options','SAMEORIGIN');
  assert.equal(readsFromPage, 1);
  assert.match(page.text, /name="device" value="plug-two"/);
  assert.match(page.text, /aria-current="page">Prise 2 de l’atelier/);
  assert.match(page.text, /48 W/);
  assert.doesNotMatch(page.text, /sensor\.test_second_power|fixture-token/);
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
    assert.equal(catalog.automaticPage(text)?.page, PANEL, text);
  }
  for (const text of ['Offre-moi un café', 'Quel GPU est allumé?', 'N’ouvre pas Home Assistant', 'Don’t show Home Assistant']) {
    assert.equal(catalog.automaticPage(text)?.page, undefined, text);
  }
  assert.equal(catalog.family.parse(PANEL), null);
  assert.equal(catalog.family.parse('garage-camera'), null);
  assert.doesNotMatch(contract({ family: true, pages: true, pageCatalog: catalog }), /home_assistant_plug/);
  assert.match(contract({ pages: true, pageCatalog: catalog }), /home_assistant_plug/);
  for (const modelPage of ['', '<show kind="page">home-assistant-panel</show>']) {
    const events = [];
    const channels = createReplyChannels({ allowPages: true, pageCatalog: catalog, onShow: block => events.push(block) });
    channels.push('La prise est allumée.' + modelPage);
    const answer = channels.end({ fallbackPage: catalog.automaticPage('Home Assistant')?.page });
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
