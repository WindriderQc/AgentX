'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createConversationImages, scopeFor } = require('../conversation-images');
const { storedDisplay, historyText } = require('../reply-channels');
const packs = require('../packs');
const id = '33333333-3333-4333-8333-333333333333';
const family = { sessionId: 'family-session', packId: 'kidx_nestor', scopeId: 'family', status: 'active', agentId: 'family' };
const privateSession = { sessionId: 'private-session', packId: 'personal_operator', scopeId: 'personal', status: 'active', agentId: 'main' };
const draw = body => ({ id: 'b1', kind: 'image', source: 'draw', title: 'Robots', body });
function fixture(options = {}) {
  const calls = [], events = [], operations = new Map();
  const service = {
    status: () => ({ configured: true, conversationProfile: { id: 'quick', width: 1024, height: 1024 } }),
    async accept(body, options) { calls.push({ body, options }); const op = { id, state: 'accepted', runtimeRestored: false }; operations.set(id, { op, scope: options.conversation }); return op; },
    async getForConversation(operationId, scope) {
      const row = operations.get(operationId);
      if (!row || JSON.stringify(scope) !== JSON.stringify(row.scope)) throw Object.assign(new Error('Unknown'), { statusCode: 404 });
      return row.op;
    },
    async listForConversation(scope) { return [...operations.values()].filter(row => JSON.stringify(scope) === JSON.stringify(row.scope)).map(row => row.op); },
    image: async () => ({ bytes: Buffer.from('verified bytes'), mimeType: 'image/png' })
  };
  const conversations = { getSession: async ({ sessionId }) => [family, privateSession].find(session => session.sessionId === sessionId) };
  const images = createConversationImages({ conversations, service, logger: { info() {} }, ...options });
  const complete = (display, overrides = {}) => images.complete({ session: family, pack: packs.packById(family.packId), backend: 'openclaw',
    display, turnId: 'synthetic-turn', signal: new AbortController().signal, onShow: block => events.push(block), ...overrides });
  const app = express(); app.use(express.json()); images.register(app);
  return { service, calls, events, operations, images, complete, app };
}
test('family drawing selects bounded quick parameters once and stores a durable screen receipt', async () => {
  const { calls, events, complete, images } = fixture(), display = [draw('Two robots in a cardboard car'), draw('Another dragon')];
  await complete(display);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.conversation, scopeFor(family));
  assert.equal(calls[0].body.profile, 'quick'); assert.equal(calls[0].body.width, 1024);
  assert.equal(calls[0].body.references, undefined);
  assert.match(calls[0].body.actionKey, /^household:[a-f0-9]{64}$/);
  assert.equal(display[0].operation.statusUrl, `/api/voice-personas/family/sessions/family-session/images/${id}`);
  assert.equal(display[1].status, 'failed'); assert.equal(events.length, 2);
  const stored = storedDisplay(display);
  assert.deepEqual(stored[0].operation, display[0].operation);
  assert.match(historyText('Je demande ton dessin.', stored), /never a new creation instruction/);
  assert.doesNotMatch(historyText('', stored), /source="draw"/);
  assert.match(images.contract(family, 'openclaw'), /not a native tool/);
});

test('ephemeral Ollama keeps bounded image actions and their refusal rules without native-tool permissions', async () => {
  const session = { ...privateSession, sessionId: 'ephemeral-synthetic', ephemeral: true };
  const f = fixture(), display = [draw('Two robots in a cardboard car')];
  await f.complete(display, { session, backend: 'agentx', pack: packs.packById(session.packId) });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].options.conversation, scopeFor(session));
  assert.equal(display[0].operation.id, id);
  assert.match(f.images.contract(session, 'agentx'), /bounded application request/);
  const refused = fixture(); refused.service.status = () => ({ configured: false });
  await refused.complete([draw('A lake')], { session, backend: 'agentx', pack: packs.packById(session.packId) });
  assert.equal(refused.calls.length, 0);
  assert.equal(refused.events[0].status, 'failed');
});
test('unavailable service, unsuitable drawing, team member and interrupted turns never generate', async () => {
  for (const body of ['A nude person', 'An email with my password', 'Graphic gore and dismemberment']) {
    const f = fixture(); await f.complete([draw(body)]); assert.equal(f.calls.length, 0); assert.equal(f.events[0].status, 'failed');
  }
  for (const overrides of [{ member: true }, { session: { ...family, llmx: {} } }]) {
    const f = fixture(); await f.complete([draw('A dragon')], overrides); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.service.status = () => ({ configured: true, conversationProfile: null });
  await f.complete([draw('A dragon')]); assert.equal(f.calls.length, 0); assert.match(f.images.contract(family, 'openclaw'), /unavailable/);
  const stopped = fixture(), abort = new AbortController(); abort.abort();
  await stopped.complete([draw('A dragon')], { signal: abort.signal }); assert.equal(stopped.calls.length, 0); assert.equal(stopped.events.length, 0);
});
test('a failed observation retains uncertainty and never retries creation', async () => {
  const f = fixture(); f.service.accept = async () => { f.calls.push('attempt'); throw new Error('Lost database acknowledgement'); };
  await f.complete([draw('A dragon')]);
  assert.equal(f.calls.length, 1); assert.equal(f.events[0].status, 'unknown'); assert.equal(f.events[0].operation, undefined);
});
test('the next conversation turn receives current scoped image state, never a completion claim from stale history', async () => {
  const f = fixture(); await f.complete([draw('Two robots')]);
  assert.match(await f.images.contextFor(family), /accepted; ready=false/);
  const op = f.operations.get(id).op;
  Object.assign(op, { state: 'completed', runtimeRestored: false, artifact: { sha256: 'a'.repeat(64) } });
  assert.match(await f.images.contextFor(family), /completed; ready=false/);
  op.runtimeRestored = true;
  assert.match(await f.images.contextFor(family), /completed; ready=true/);
  assert.equal(await f.images.contextFor(privateSession), '');
  assert.equal(f.calls.length, 1, 'supplying current state never dispatches');
});
test('family routes only read its own conversation; no arbitrary generation endpoint is granted', async () => {
  const f = fixture(); await f.complete([draw('A dragon')]);
  const base = '/family/sessions/family-session/images';
  const list = await request(f.app).get(base).expect(200);
  assert.equal(list.body.blocks[0].operation.id, id);
  await request(f.app).post(base).send({ prompt: 'A dragon', profile: 'quality', references: ['private'] }).expect(404);
  await request(f.app).get(`/family/sessions/private-session/images/${id}`).expect(404);
  await request(f.app).get(`/private/sessions/private-session/images/${id}`).expect(404);
  await request(f.app).get(base + '/' + id + '/image').expect(409);
  const op = f.operations.get(id).op;
  Object.assign(op, { state: 'completed', runtimeRestored: true, artifact: { sha256: 'a'.repeat(64), url: '/api/images/operations/' + id + '/image' } });
  const status = await request(f.app).get(base + '/' + id).expect(200);
  assert.equal(status.body.operation.artifact.url, '/api/voice-personas' + base + '/' + id + '/image');
  assert.equal(status.body.operation.studioPath, '/images?operation=' + id);
  await request(f.app).get(base + '/' + id + '/image').expect(200).expect('Content-Type', /image\/png/);
  assert.equal(f.calls.length, 1, 'poll, history and artifact reads never dispatch');
});
test('private native creation is bound by Core session, defaults to quick, and delivers only a verified scoped card', async () => {
  const f = fixture(), base = '/private/sessions/private-session/images';
  await request(f.app).post(base).send({ actionKey: 'native-action', prompt: 'A lake', conversation: scopeFor(family) }).expect(202);
  assert.deepEqual(f.calls[0].options.conversation, scopeFor(privateSession));
  assert.equal(f.calls[0].body.profile, 'quick');
  const display = [];
  await f.complete(display, { session: privateSession, pack: packs.packById(privateSession.packId), evidence: { imageDelivery: { operations: [{ id }] } } });
  assert.equal(display[0].source, 'local'); assert.match(display[0].operation.statusUrl, /private-session/);
  await f.complete([draw('A lake')], { session: privateSession });
  assert.equal(f.calls.length, 1, 'native tools own personal creation; a model draw block cannot create a second image');
});

// Family's illustrated mode (#1304).
const scene = body => ({ id: 's1', kind: 'image', source: 'scene', title: '', body });
const plan = { worker: 'desk', profile: 'quick', width: 768, height: 768, intervalSeconds: 60 };
function illustrated(options = {}) {
  let clock = 1000000;
  const f = fixture({ now: () => clock, ...options }), immediate = [];
  f.service.status = () => ({ configured: true, conversationProfile: { id: 'quick', width: 1024, height: 1024 }, illustrated: plan });
  f.service.acceptOpportunistic = async (body, opts) => {
    immediate.push({ body, opts });
    if (f.refuse) throw Object.assign(new Error('The image PC is unavailable'), { statusCode: 503 });
    const op = { id, state: 'accepted', runtimeRestored: false, admissionPolicy: 'opportunistic' };
    f.operations.set(id, { op, scope: opts.conversation }); return op;
  };
  return Object.assign(f, { immediate, advance: seconds => { clock += seconds * 1000; } });
}
test('a family scene block becomes one immediate picture on the illustrated worker, never a card or stored block', async () => {
  const f = illustrated(), note = { id: 'b2', kind: 'text', title: '', body: 'A note' };
  const display = [scene('A cat climbing a snowy fir tree, picture book style'), note];
  await f.complete(display, { backend: 'agentx' });
  assert.deepEqual(display, [note]);
  assert.equal(f.calls.length, 0, 'ordinary drawing admission is not used');
  assert.equal(f.immediate.length, 1);
  const [{ body, opts }] = f.immediate;
  assert.equal(opts.workerId, 'desk'); assert.deepEqual(opts.conversation, scopeFor(family));
  assert.equal(body.profile, 'quick'); assert.equal(body.width, 768); assert.equal(body.height, 768);
  assert.match(body.actionKey, /^household-scene:[a-f0-9]{64}$/);
  assert.match(body.prompt, /^Age-appropriate illustration for children\. No text/);
  assert.match(body.prompt, /snowy fir tree/);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].presentation, 'illustration');
  assert.equal(f.events[0].operation.statusUrl, `/api/voice-personas/family/sessions/family-session/images/${id}`);
  assert.match(f.images.contract(family, 'agentx'), /source="scene"/);
  assert.doesNotMatch(storedDisplay(display).map(block => block.source).join(' '), /scene|local/);
});
test('illustrations keep their interval, and a refused attempt waits like a success', async () => {
  const f = illustrated();
  await f.complete([scene('A red kite over the river')], { turnId: 't1' });
  f.advance(30); await f.complete([scene('A blue whale')], { turnId: 't2' });
  assert.equal(f.immediate.length, 1, 'a second subject inside the interval is dropped, not queued');
  f.advance(31); await f.complete([scene('A blue whale')], { turnId: 't3' });
  assert.equal(f.immediate.length, 2);
  const refused = illustrated(); refused.refuse = true;
  await refused.complete([scene('A volcano')], { turnId: 'r1' });
  assert.equal(refused.events.length, 0, 'a busy worker leaves the previous picture');
  refused.advance(10); await refused.complete([scene('A volcano')], { turnId: 'r2' });
  assert.equal(refused.immediate.length, 1, 'no retry before the interval');
});
test('no illustration with a drawing, an unsuitable scene, another space, a team member or the mode off', async () => {
  const withDraw = illustrated(), display = [draw('Two robots'), scene('Two robots in a park')];
  await withDraw.complete(display);
  assert.equal(withDraw.calls.length, 1); assert.equal(withDraw.immediate.length, 0);
  assert.equal(display.length, 1);
  for (const body of ['A nude person', 'Graphic gore and dismemberment']) {
    const f = illustrated(); await f.complete([scene(body)]); assert.equal(f.immediate.length, 0); assert.equal(f.events.length, 0);
  }
  const personal = illustrated(), shown = [scene('A lake at dawn')];
  await personal.complete(shown, { session: privateSession, pack: packs.packById(privateSession.packId), backend: 'agentx' });
  assert.equal(personal.immediate.length, 0); assert.equal(shown.length, 0, 'a stray scene block is still removed');
  assert.doesNotMatch(personal.images.contract(privateSession, 'agentx'), /source="scene"/);
  const member = illustrated(); await member.complete([scene('A lake')], { member: true }); assert.equal(member.immediate.length, 0);
  const off = illustrated(); off.service.status = () => ({ configured: true, conversationProfile: { id: 'quick', width: 1024, height: 1024 }, illustrated: null });
  await off.complete([scene('A lake')]); assert.equal(off.immediate.length, 0);
  assert.doesNotMatch(off.images.contract(family, 'agentx'), /source="scene"/);
  const stopped = illustrated(), abort = new AbortController(); abort.abort();
  await stopped.complete([scene('A lake')], { signal: abort.signal }); assert.equal(stopped.immediate.length, 0);
});
test('illustrations stay out of the reply context and are marked for the frame when listed', async () => {
  const f = illustrated(); await f.complete([scene('A lighthouse in a storm')]);
  assert.doesNotMatch(await f.images.contextFor(family), /receipts/);
  const list = await request(f.app).get('/family/sessions/family-session/images').expect(200);
  assert.equal(list.body.blocks[0].presentation, 'illustration');
  assert.equal(f.immediate.length, 1, 'reads never dispatch');
});
test('an unreachable illustrated worker never holds the end of the turn', async () => {
  const f = illustrated({ illustrationBudgetMs: 20 });
  let seen;
  f.service.acceptOpportunistic = (body, opts) => { seen = opts.signal; f.immediate.push(body); return new Promise(() => {}); };
  const started = Date.now();
  await f.complete([scene('A dragon kite')]);
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.immediate.length, 1); assert.equal(f.events.length, 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(seen.aborted, true, 'admission is told to stop before creating anything');
});

test('each family turn logs where its illustration stopped, without the description', async () => {
  const lines = [], logger = { info: (message, fields) => lines.push({ message, ...fields }) };
  const f = illustrated({ logger });
  await f.complete([{ id: 'b1', kind: 'text', title: '', body: 'Hello' }]);
  await f.complete([scene('A secret purple dragon')]);
  await f.complete([scene('A lake at dawn')]);
  f.advance(61); f.refuse = true;
  await f.complete([scene('A red kite')]);
  assert.deepEqual(lines.map(line => line.outcome), ['no_scene', 'accepted', 'interval', 'refused']);
  assert.ok(lines.every(line => line.message === 'Family illustration'));
  assert.equal(lines[1].worker, 'desk'); assert.equal(lines[1].shown, true); assert.ok(lines[2].waitSeconds > 0);
  assert.equal(lines[3].status, 503); assert.match(lines[3].reason, /unavailable/);
  assert.doesNotMatch(JSON.stringify(lines), /dragon|lake|kite/);
  const off = illustrated({ logger }); lines.length = 0;
  off.service.status = () => ({ configured: true, conversationProfile: { id: 'quick', width: 1024, height: 1024 }, illustrated: null });
  await off.complete([{ id: 'b1', kind: 'text', title: '', body: 'Hello' }]);
  assert.equal(lines.length, 0, 'nothing is logged while the mode is off');
});

test('an illustration past its admission budget is logged as such', async () => {
  const lines = [], logger = { info: (message, fields) => lines.push(fields) };
  const f = illustrated({ illustrationBudgetMs: 20, logger });
  f.service.acceptOpportunistic = (body, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
  await f.complete([scene('A dragon kite')]);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(lines.map(line => line.outcome), ['budget']);
});
