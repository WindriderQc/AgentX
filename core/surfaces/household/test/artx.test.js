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
  assert.equal(view.panorama.centerAzimuthDeg, 145);
  assert.equal(view.planets[0].screen.x, 0.409);
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

for (const backend of ['agentx', 'openclaw']) test(`the actual ${backend} family turn receives and records Saturn’s display evidence`, async () => {
  const f = fixture(), snapshot = await f.service.snapshot(displayId);
  const h = harness({ packId: 'kidx_nestor', backend, artx: f.service });
  await h.turn('Où est Saturne dans ton ciel ?', 'voice', { artx: f.observation(snapshot) });
  assert.match(h.sent[0].request, /Saturne/);
  assert.match(h.sent[0].request, /"side":"gauche"/);
  assert.equal(h.turns[0].presentationContext.artx.current.planets[0].rendered, true);
  if (backend === 'agentx') assert.ok(h.sent[0].tools.some(tool => tool.function.name === 'artx_read'));
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
