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
function fixture() {
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
  const images = createConversationImages({ conversations, service });
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
