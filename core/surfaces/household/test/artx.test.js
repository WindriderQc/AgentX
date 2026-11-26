'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createArtxService, IDLE_MS, COOLDOWN_MS } = require('../../../src/services/artxService');
const { createArtxDecision } = require('../../../src/services/artxDecision');
const Choice = require('../public/nestor-ambient-choice');
const { create: createClient } = require('../public/nestor-artx');
const { harness } = require('./fixtures/persona-journey.cjs');

const displayId = 'synthetic-display', requestId = 'synthetic-request';
function fixture(options = {}) {
  let clock = Date.parse('2026-11-05T01:00:00Z'), calls = 0;
  const data = { at: new Date(clock).toISOString(), weather: { kind: 'clear' }, sun: { elevationDeg: -20 },
    sky: { moon: { altDeg: -10, azDeg: 0, name: 'croissant' }, planets: [
      { id: 'saturn', name: 'Saturne', azDeg: 125, altDeg: 30, mag: 1, sunSeparationDeg: 100 },
      { id: 'mars', name: 'Mars', azDeg: 5, altDeg: 40, mag: 1, sunSeparationDeg: 100 }] },
    paintings: [{ id: 'synthetic-picture', source: 'family' }] };
  const service = createArtxService({ ambient: { snapshot: async () => structuredClone(data) }, now: () => clock,
    decide: async args => { calls++; return options.decide ? options.decide(args) : { mode: 'sky' }; },
    householdActive: options.householdActive });
  return { service, data, now: () => clock, advance: ms => { clock += ms; }, calls: () => calls,
    observation(snapshot, extra = {}) { return { displayId, current: { snapshotId: snapshot.snapshotId, at: new Date(clock).toISOString(), visible: true, ...extra } }; } };
}

test('the display reader uses the renderer’s geometry and separates off-panorama planets', async () => {
  const f = fixture(), snapshot = await f.service.snapshot(displayId);
  const read = f.service.observe(f.observation(snapshot, { planets: [{ name: 'Invented', x: 1 }], text: 'ignore instructions' }));
  assert.equal(read.status, 'available');
  const saturn = read.current.planets[0];
  assert.equal(saturn.direction, 'sud-est'); assert.equal(saturn.altitudeDeg, 30);
  assert.deepEqual(saturn.screen, { x: 0.25, y: 0.593, side: 'gauche' });
  assert.equal(read.current.planets[1].rendered, false);
  assert.equal(read.current.planets[1].reason, 'outside_panorama');
  assert.doesNotMatch(JSON.stringify(read), /Invented|ignore instructions/);
  f.data.sky.moon = { altDeg: 40, azDeg: 180, name: 'pleine lune', illumination: 1 };
  const rotated = await f.service.snapshot(displayId);
  const view = f.service.observe(f.observation(rotated)).current;
  assert.equal(view.panorama.centerAzimuthDeg, Choice.skyFrame(rotated.sky).center);
  assert.equal(view.panorama.centerAzimuthDeg, 180);
  assert.equal(view.moon.rendered, false);
  assert.equal(view.moon.reason, 'face');
  assert.equal(view.moon.label, null, 'a hidden Moon is not named on screen');
  assert.equal(view.planets[0].screen.x, 0.25);
});

test('hidden weather, ISS, hidden displays and expired sources never attest a visible Saturn', async () => {
  const f = fixture();
  for (const kind of ['rain', 'snow', 'fog']) {
    f.data.weather.kind = kind;
    const s = await f.service.snapshot(displayId);
    assert.equal(f.service.observe(f.observation(s)).current.planets[0].rendered, false);
  }
  f.data.weather.kind = 'clear';
  const s = await f.service.snapshot(displayId);
  assert.equal(f.service.observe(f.observation(s, { moment: { kind: 'iss' } })).current.planets[0].reason, 'sky_hidden');
  assert.equal(f.service.observe(f.observation(s, { visible: false })).current.planets[0].reason, 'display_hidden');
  f.service.observe(f.observation(s)); f.advance(181000);
  assert.equal(f.service.read({ displayId }).status, 'expired');
  const forged = f.observation(s); forged.current.snapshotId = 'unissued-snapshot';
  assert.equal(f.service.observe(forged).current, null);
});

test('an idle task starts after silence, reconciles duplicates and respects the shared cooldown', async () => {
  const f = fixture(), s = await f.service.snapshot(displayId);
  const args = { displayId, requestId, snapshotId: s.snapshotId };
  assert.equal((await f.service.idle(args)).status, 'deferred'); assert.equal(f.calls(), 0);
  f.advance(IDLE_MS);
  const [first, duplicate] = await Promise.all([f.service.idle(args), f.service.idle(args)]);
  assert.equal(first.status, 'selected'); assert.deepEqual(first, duplicate); assert.equal(f.calls(), 1);
  assert.equal((await f.service.snapshot(displayId)).artx.task.id, requestId);
  await assert.rejects(f.service.idle({ ...args, snapshotId: 'changed-snapshot' }), { code: 'ARTX_REQUEST_CONFLICT' });
  assert.equal((await f.service.idle({ ...args, requestId: 'another-request' })).status, 'deferred');
  const observed = f.observation(s, { taskId: requestId });
  assert.equal(f.service.observe(observed).current.task.state, 'selected');
  f.advance(COOLDOWN_MS);
  assert.equal((await f.service.idle({ ...args, requestId: 'another-request' })).status, 'selected');
  assert.equal(f.calls(), 2);
});

test('a hidden or weather-masked display retains independent outdoor positions', async () => {
  const f = fixture();
  const below = { id: 'saturn', name: 'Saturne', azDeg: 300, altDeg: -25, sunSeparationDeg: 100 };
  f.data.sky.planetPositions = [below, ...f.data.sky.planets.filter(p => p.id !== 'saturn')];
  f.data.sky.planets = f.data.sky.planets.filter(p => p.id !== 'saturn');
  for (const [kind, visible] of [['clear', true], ['clear', false], ['fog', true]]) {
    f.data.weather.kind = kind;
    const snapshot = await f.service.snapshot(displayId);
    const read = f.service.observe(f.observation(snapshot, { visible })).current;
    const saturn = read.planets.find(planet => planet.id === 'saturn');
    assert.equal(saturn.direction, 'nord-ouest');
    assert.equal(saturn.altitudeDeg, -25);
    assert.equal(saturn.aboveHorizon, false);
    assert.equal(saturn.rendered, false);
    assert.equal(saturn.screen, undefined);
    if (visible && kind === 'clear') assert.equal(saturn.reason, 'below_horizon');
  }
});

test('activity discards an in-flight choice and keeps its original result identity', async () => {
  let finish;
  const f = fixture({ decide: () => new Promise(resolve => { finish = resolve; }) });
  const s = await f.service.snapshot(displayId); f.advance(IDLE_MS);
  const args = { displayId, requestId, snapshotId: s.snapshotId };
  const running = f.service.idle(args);
  f.service.activity(displayId); finish({ mode: 'sky' });
  assert.equal((await running).status, 'interrupted');
  assert.equal((await f.service.idle(args)).status, 'interrupted'); assert.equal(f.calls(), 1);
  assert.equal((await f.service.snapshot(displayId)).artx.task, null);
});

test('scene selections reject unknown pictures and distinguish selection from rendering', async () => {
  const f = fixture(), s = await f.service.snapshot(displayId);
  assert.throws(() => f.service.present({ displayId, requestId, snapshotId: s.snapshotId, mode: 'paint', paintingId: 'unknown-picture' }), /cannot be painted/);
  f.data.sun.elevationDeg = 30;
  const day = await f.service.snapshot(displayId);
  const task = f.service.present({ displayId, requestId, snapshotId: day.snapshotId, mode: 'paint', paintingId: 'synthetic-picture' });
  assert.equal(f.service.read({ displayId }).current, null, 'selection did not create a display receipt');
  const read = f.service.observe(f.observation(day, { taskId: task.id, moment: { kind: 'paint', id: task.paintingId } }));
  assert.equal(read.current.moment.description, 'dessin de la famille');
  const scene = Choice.chooseScreen(day, { at: f.now(), hour: 12, idleMs: IDLE_MS });
  assert.equal(Choice.artxScene(scene, day, null, true).moment, null);
  assert.equal(Choice.artxScene(scene, day, task, true).moment.id, task.paintingId);
  assert.equal(Choice.artxScene(scene, day, task, false).moment, null);
  const urgent = { background: { sky: 'full' }, moment: { kind: 'iss' }, chips: [{ id: 'iss' }, { id: 'sky' }, { id: 'alert' }] };
  const rest = Choice.artxScene(urgent, day, { mode: 'rest' }, true);
  assert.equal(rest.moment.kind, 'iss', 'a calm choice preserves the scheduled ISS and alert priority');
  assert.deepEqual(rest.chips.map(chip => chip.id), ['iss', 'alert']);
});

test('the silent task loads the ArtX skill and uses routed tools without aborting admitted work', async () => {
  let submitted, controls;
  const decide = createArtxDecision({ consumerContract: { id: 'synthetic' }, inference: { execute: async (body, options) => {
    submitted = body; controls = options;
    return { ok: true, body: { message: { content: '', tool_calls: [{ function: { name: 'artx_present', arguments: { mode: 'sky' } } }] } } };
  } } });
  const f = fixture(); const signal = new AbortController().signal;
  assert.deepEqual(await decide({ snapshot: f.data, signal }), { mode: 'sky' });
  assert.match(submitted.messages[0].content, /silent idle task/);
  assert.equal(submitted.model, undefined); assert.equal(submitted.tools[0].function.name, 'artx_present');
  assert.equal(controls.signal, undefined);
  const invalid = createArtxDecision({ inference: { execute: async () => ({ ok: true, body: { message: { content: 'Je peins.' } } }) } });
  await assert.rejects(invalid({ snapshot: f.data, signal }), /explicit scene choice/);
});

test('the browser waits, remembers rendered moments, and reconciles a lost idle response', async () => {
  let now = 1000000, seq = 0, lost = true;
  const calls = [];
  const client = createClient({ now: () => now, uuid: () => `synthetic-${++seq}`, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    if (lost) { lost = false; throw new Error('lost result'); }
    return Response.json({ data: { status: 'selected', task: { id: body.requestId, mode: 'sky' } } });
  } });
  const snapshot = { snapshotId: 'snapshot-reference', artx: { idleMs: IDLE_MS, cooldownMs: COOLDOWN_MS } };
  await client.tick({ snapshot, quiet: true, visible: true }); assert.equal(calls.length, 0);
  now += IDLE_MS; await client.tick({ snapshot, quiet: true, visible: true });
  snapshot.snapshotId = 'newer-source-snapshot';
  now += 15000; await client.tick({ snapshot, quiet: true, visible: true });
  assert.equal(calls[0].body.requestId, calls[1].body.requestId);
  assert.deepEqual(calls[0].body, calls[1].body, 'a lost response preserves the exact source and observation');
  client.rendered(snapshot, { artxTaskId: 'paint-request', moment: { kind: 'paint', id: 'synthetic-picture' } });
  now += 1000; client.rendered(snapshot, { artxTaskId: 'paint-request', moment: null });
  assert.equal(client.context().previous.moment.id, 'synthetic-picture');
  assert.equal(client.context({ visible: false }).current.visible, false);
  await client.tick({ snapshot, quiet: false, visible: true });
  assert.match(calls.at(-1).url, /activity$/);
  client.dispose();
});

for (const [backend, channel] of [['agentx', 'voice'], ['agentx', 'text'], ['openclaw', 'voice']]) {
  test(`${backend} family ${channel} uses its observed sky with a hidden display`, async () => {
    const f = fixture(), snapshot = await f.service.snapshot(displayId);
    const deferred = backend === 'agentx' && channel === 'voice';
    const h = harness({ packId: 'kidx_nestor', backend, artx: f.service,
      response: deferred ? body => body.messages.at(-1).role === 'tool' ? 'Sa hauteur est de 30 degrés.'
        : { message: { content: '', tool_calls: [{ function: { name: 'artx_read', arguments: { view: 'current' } } }] } } : 'Réponse synthétique.' });
    await h.turn('Où est Saturne dans le ciel ?', channel, { artx: f.observation(snapshot, { visible: false }) });
    const planet = h.turns[0].presentationContext.artx.current.planets[0];
    assert.deepEqual([planet.rendered, planet.direction, planet.aboveHorizon, planet.altitudeDeg], [false, 'sud-est', true, 30]);
    if (deferred) {
      assert.match(h.sent[0].request, /Use artx_read/);
      assert.match(h.sent[0].request, /"altitudeDeg":30/);
      assert.doesNotMatch(h.sent[0].request, /"occlusionZones"|"snapshotId"|"paintings"/);
      assert.ok(h.sent[0].tools.some(tool => tool.function.name === 'artx_read'));
      assert.equal(h.sent.length, 2);
      const result = JSON.parse(h.sent[1].messages.at(-1).content);
      assert.equal(result.current.planets[0].altitudeDeg, 30);
      assert.equal(result.current.planets[0].rendered, false);
      assert.equal(result.previous, undefined);
    } else {
      assert.match(h.sent[0].request, /"altitudeDeg":30/);
      assert.match(h.sent[0].request, /a hidden display.*does NOT prevent using a supplied direction and altitude/);
    }
  });
}

test('one ordinary voice turn includes compact truth about the sky now and the drawing before', async () => {
  const f = fixture(), snapshot = await f.service.snapshot(displayId);
  const previous = f.observation(snapshot, { moment: { kind: 'paint', id: 'synthetic-picture' } }).current;
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx', artx: f.service });
  await h.turn('Bonjour !', 'voice', { artx: { ...f.observation(snapshot), previous } });
  const facts = h.sent[0].request;
  assert.match(facts, /"altitudeDeg":30,"direction":"sud-est","aboveHorizon":true,"rendered":true,"side":"gauche"/);
  assert.match(facts, /"previous":\{[^\n]+?"moment":\{"kind":"paint","source":"family"\}/);
  assert.match(facts, /receipt contains no image subject or theme/);
  assert.doesNotMatch(facts, /"paintings"|"occlusionZones"|synthetic-picture|dessin de la famille/);
  assert.equal(h.sent.length, 1);
});

test('the reader can request one observation and reports that view’s own availability', async () => {
  const f = fixture(), before = await f.service.snapshot(displayId);
  const first = f.observation(before).current;
  assert.equal(f.service.read({ displayId, view: 'previous' }).status, 'unavailable');
  f.advance(2000);
  const after = await f.service.snapshot(displayId);
  const full = f.service.observe({ ...f.observation(after, { visible: false }), previous: first });
  assert.equal(full.previous.planets[0].rendered, true);
  assert.equal(full.current.planets[0].rendered, false);
  for (const view of ['current', 'previous']) {
    assert.deepEqual(f.service.read({ displayId, view }), { displayId, [view]: full[view], status: 'available' });
  }
  assert.throws(() => f.service.read({ displayId, view: 'other' }), { code: 'ARTX_VIEW_INVALID' });
  f.advance(181000);
  assert.equal(f.service.read({ displayId, view: 'previous' }).status, 'expired');
});

test('family ArtX tools bind the active display while MCP reuses the same reader', async () => {
  const { familyToolset } = require('../family-tools');
  const { handleMcpMessage } = require('../../../src/services/mcpSkillBus');
  const f = fixture(), s = await f.service.snapshot(displayId);
  f.service.observe(f.observation(s));
  const tools = familyToolset({}, { artxDisplayId: displayId, artxRequestId: requestId, toolDeps: { artx: f.service } });
  assert.ok(!tools.definitions[0].function.parameters.properties.displayId);
  const read = await tools.execute({ function: { name: 'artx_read', arguments: { displayId: 'another-display' } } });
  assert.equal(JSON.parse(read.message.content).displayId, displayId);
  const selected = await tools.execute({ function: { name: 'artx_present', arguments: { mode: 'weather', displayId: 'another-display' } } });
  assert.equal(selected.receipt.status, 'completed');
  assert.equal((await f.service.snapshot(displayId)).artx.task.mode, 'weather');
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'artx_read', arguments: { displayId } } };
  const mcp = await handleMcpMessage(message, { artx: f.service });
  assert.equal(mcp.result.structuredContent.current.planets[0].name, 'Saturne');
  await assert.rejects(handleMcpMessage(message, { artx: f.service }, { profile: 'memory' }), { code: 'UNKNOWN_TOOL' });
  assert.equal(familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'artx_read,artx_present' }), null, 'no family tool can choose a foreign display');
});

for (const backend of ['agentx', 'openclaw']) test(`personal ${backend} receives visible, masked and below-horizon sky facts`, async () => {
  const f = fixture();
  f.data.sky.moon = { altDeg: 40, azDeg: 180, name: 'croissant', illumination: 0.1 };
  f.data.sky.planetPositions = [...f.data.sky.planets,
    { id: 'jupiter', name: 'Jupiter', altDeg: -25, azDeg: 70 }];
  const snapshot = await f.service.snapshot(displayId);
  const h = harness({ packId: 'personal_operator', backend, artx: f.service });
  await h.turn('Quels astres sont visibles, masqués ou sous l’horizon ?', 'text', { artx: f.observation(snapshot) });
  const read = h.turns[0].presentationContext.artx.current;
  assert.equal(read.planets.find(p => p.id === 'saturn').rendered, true);
  assert.equal(read.moon.reason, 'face');
  assert.equal(read.planets.find(p => p.id === 'jupiter').aboveHorizon, false);
  assert.equal(read.planets.find(p => p.id === 'jupiter').reason, 'below_horizon');
  assert.match(h.sent[0].request, /"altitudeDeg":-25/);
  assert.match(h.sent[0].request, /A screen side is not a compass direction/);
});

test('the HTTP idle endpoint executes the same task and preserves its identity', async () => {
  const express = require('express');
  const { registerFamilyRoutes } = require('../family-routes');
  const f = fixture(), app = express();
  registerFamilyRoutes({ app, express, familyTasks: {}, standardJsonParser: express.json(), artx: f.service });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/family/ambient`;
  try {
    const s = (await (await fetch(base + '?displayId=' + displayId)).json()).data;
    f.advance(IDLE_MS);
    const request = { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayId, requestId, snapshotId: s.snapshotId }) };
    const response = await fetch(base + '/idle', request);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).data.status, 'selected');
    assert.equal((await (await fetch(base + '/idle', request)).json()).data.task.id, requestId);
    assert.equal(f.calls(), 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('a fox picture takes the existing approved image source without model or ArtX at night', async () => {
  const f = fixture(), s = await f.service.snapshot(displayId);
  const observation = f.observation(s);
  const { createVisuals } = require('../visuals');
  for (const found of [true, false]) {
    const calls = [];
    const visuals = createVisuals({ env: { SEARXNG_URL: 'http://image-provider.example.test', HOUSEHOLD_IMAGE_FAMILY_SOURCES: 'web' },
      fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        return Response.json({ results: found ? [{ img_src: 'https://images.example.test/fox.png' }] : [] });
      } });
    const h = harness({ packId: 'kidx_nestor', backend: 'agentx', artx: f.service, visuals,
      response: () => assert.fail('No model prose supplies picture status') });
    h.turns.push({ inputText: 'Synthetic nonpublic antecedent', replyText: 'Synthetic reply' });
    const out = await h.turn('Montre-moi une image de Renard.', 'voice', { artx: observation });
    assert.equal(calls.length,1);
    assert.equal(calls[0].url.searchParams.get('q'), 'animal un renard');
    assert.equal(calls[0].url.searchParams.get('safesearch'), '2');
    assert.doesNotMatch(calls[0].url.href,/Synthetic|Montre-moi|display/i);
    assert.equal(f.service.read({ displayId }).current?.task || null, null);
    assert.match(out.reply.text,found ? /J’ai trouvé une image/ : /pas trouvé d’image/);
    assert.doesNotMatch(out.reply.text,/est affichée/i);
    assert.equal(out.display?.[0]?.status,found ? 'found' : undefined);
    assert.equal(h.sent.length,0);
  }
});

test('generic no-source and private requests are truthful without search; explicit draw, albums and ArtX stay distinct', async () => {
  const { genericPicture } = require('../family-picture-lookup');
  assert.equal(genericPicture('Dessine un renard.'), null);
  assert.equal(genericPicture('Montre-moi une photo de renard dans mes albums.'), null);
  assert.equal(genericPicture('Montre-moi une image de renard dans ma galerie.'), null);
  assert.equal(genericPicture('Montre-moi le tableau.'), null);
  assert.equal(genericPicture('Montre-moi le ciel.'), null);
  assert.equal(genericPicture('Show me a picture of a fox please.').animal.id, 'fox');
  assert.equal(genericPicture('Montre-moi une image de renard près de chez moi.').animal, null);
  for (const [allowed, text, expected, language = 'fr'] of [
    [[], 'Montre-moi une image de renard.', /pas de source publique d’images approuvée/],
    [['photos'], 'Montre-moi une image de renard.', /pas de source publique d’images approuvée/],
    [['web'], 'Montre-moi une image de la Lune.', /catalogue d’images publiques/],
    [['web'], 'Montre-moi une image de mon amie Camille.', /catalogue d’images publiques/],
    [['web'], 'Show me a picture of the moon.', /public picture catalogue/, 'en'],
    [['web'], 'Montre-moi une image de renard près de chez moi.', /catalogue d’images publiques/],
  ]) {
    const h = harness({ packId: 'kidx_nestor', backend: 'agentx',
      response: () => assert.fail('No source or verified subject, no speculative inference'),
      visuals: { sources: ({ family }) => (assert.equal(family,true), allowed), present: () => assert.fail('No speculative lookup') } });
    const out = await h.turn(text, 'voice', { language });
    assert.match(out.reply.text, expected);
    assert.deepEqual(out.display || [],[]);
    assert.equal(h.sent.length,0);
  }
});

test('Family leaves ordinary and combined photo requests to the model and resolves only its approved subject', async () => {
  const { createVisuals } = require('../visuals');
  const photo = { names: ['Lune', 'Moon', 'catalogue-only fixture alias'], url: 'https://public.example.test/lunar-photo.jpg',
    origin: 'https://science.example.test/catalogue/lunar', credit: 'Observatoire de test' };
  const f = fixture(), snapshot = await f.service.snapshot(displayId);
  const cases = [
    ['Montre-moi une image de la Lune.', 'Lune', 'Je te propose une photo.'],
    ['What does our natural satellite look like up close?', 'Moon', 'Here is my selection.'],
    ['Explique-moi les phases et accompagne ta réponse d’une photo de la Lune.', 'Lune', 'On voit différentes parties de sa moitié éclairée.'],
    ['Montre-moi une image de mon amie Camille.', 'mon amie Camille', 'Je peux vérifier ce sujet.'],
    ['Aurais-tu une photo du renard de Camille ?', 'renard de Camille', 'Je vérifie ce sujet.']
  ];
  for (const searxng of ['', 'http://search.example.test']) {
    let calls = 0;
    const visuals = createVisuals({ env: { HOUSEHOLD_IMAGE_FAMILY_SOURCES: 'web',
      HOUSEHOLD_FAMILY_PUBLIC_PICTURES_JSON: JSON.stringify([photo]), SEARXNG_URL: searxng },
      fetchImpl: async () => { calls++; throw Error('provider offline'); } });
    let next = 0;
    const h = harness({ packId: 'kidx_nestor', backend: 'agentx', visuals, artx: f.service,
      response: body => {
        const [question, label, answer] = cases[next++];
        assert.ok(body.messages.at(-1).content.includes(question));
        assert.doesNotMatch(body.messages[0].content, /public\.example|Observatoire de test|catalogue-only fixture alias/);
        return answer + ' <show kind="image" source="web" title="Photo">' + label + '</show>';
      } });
    h.turns.push({ inputText: 'Private fixture from a previous turn', replyText: 'Réponse de test.' });
    for (const [text, label, answer] of cases) {
      const out = await h.turn(text, 'voice', { language: label === 'Moon' ? 'en' : 'fr', artx: f.observation(snapshot) });
      assert.equal(out.reply.text, answer);
      const [block] = out.display;
      assert.equal(block.source, 'web');
      assert.equal(block.body, label);
      if (photo.names.includes(label)) {
        assert.equal(block.status, 'found');
        assert.deepEqual(block.image, { url: photo.url, origin: photo.origin, originTitle: photo.credit, sourceLabel: 'Internet' });
      } else {
        assert.equal(block.status, 'missing');
        assert.equal(block.image, null);
      }
    }
    assert.equal(calls, 0);
    assert.equal(h.sent.length, cases.length);
    assert.equal(next, cases.length);
    assert.equal(f.service.read({ displayId }).current?.task || null, null);
  }
});

test('a failed ArtX selection at night is not retried and a tool-only terminal reply gets a real voiced fallback', async () => {
  const f = fixture(), s = await f.service.snapshot(displayId);
  f.service.observe(f.observation(s));
  let attempted = 0, posted = 0;
  const { familyToolset } = require('../family-tools');
  const toolset = familyToolset({}, { artxDisplayId: displayId, artxRequestId: requestId, requestText: 'Montre-moi le tableau.',
    toolDeps: { artx: { read: (...a) => f.service.read(...a), present: (...a) => { attempted++; return f.service.present(...a); } } } });
  const { runLocalConversation } = require('../conversation-inference');
  const { createReplyChannels } = require('../reply-channels');
  const projected = createReplyChannels();
  const toolCalls = [{ function: { name: 'artx_present', arguments: { mode: 'paint', paintingId: 'synthetic-picture' } } }];
  const result = await runLocalConversation({ request: { backend:'agentx', session:{packId:'kidx_nestor',modeId:'family'}, pack:{taskType:'voice_persona_chat',childSafe:true},
    signal: new AbortController().signal, speechLanguage: 'fr', channel: 'voice', streaming: true, agentxInstructions:'Synthetic', familyTools: toolset,
    onDelta: value => projected.push(value) }, prepared:[{role:'user',content:'Montre-moi le tableau.'}], env:{},
    inference: { execute: async () => {
      posted++;
      return { ok:true, stream:(async function* () {
        yield JSON.stringify({message:{content:'',tool_calls:toolCalls},done:false})+'\n';
        yield JSON.stringify({done:true})+'\n';
      })(), completion:Promise.resolve({completed:true,terminalComplete:true}),metadata:{model:'synthetic-main'} };
    } } });
  assert.equal(attempted,1);
  assert.equal(posted,3,'two existing tool rounds and no fourth model invocation');
  assert.equal(result.tools.receipts.length,1);
  assert.deepEqual(result.tools.receipts.map(x => [x.tool,x.status,x.error]),[['artx_present','failed','ARTX_PAINTING_UNAVAILABLE']]);
  assert.match(result.text,/pas pu terminer/);
  const channels = projected.end();
  assert.match(channels.say,/pas pu terminer/);
  assert.match(JSON.stringify(channels.written),/pas pu terminer/);
  assert.deepEqual(channels.display,[]);
});
