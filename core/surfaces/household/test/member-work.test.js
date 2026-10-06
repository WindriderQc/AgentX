'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemberWork } = require('../member-work');
const { createBrowserSessionControls } = require('../browser-session-controls');

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '33333333-3333-4333-8333-333333333333';
const session = { sessionId, packId: 'personal_operator', scopeId: 'personal' };
const reply = { traceId: 'trace-1', text: 'Trois courriels attendent une réponse.', language: 'fr', speaker: { agentId: 'secretary', name: 'Secrétaire' } };

function work(clock = { now: 1000 }) {
  return { clock, store: createMemberWork({ conversations: { getSession: async () => session }, now: () => clock.now }) };
}

test('a detached member is reported to the conversation agent until it answers', async () => {
  const { store } = work();
  assert.equal(store.contextFor(sessionId), '');
  store.start(sessionId, turnId, { agentId: 'secretary', name: 'Secrétaire', question: 'Quels   courriels\nattendent ?' });
  assert.deepEqual(store.active(sessionId).map(job => job.agentId), ['secretary']);
  assert.match(store.contextFor(sessionId), /Secrétaire is still working in the background .*«Quels courriels attendent \?»/);
  assert.match(store.contextFor(sessionId), /Do not answer that question yourself/);
  assert.equal(store.contextFor('another-session'), '');
  store.finish(sessionId, turnId, reply);
  assert.deepEqual(store.active(sessionId), []);
  assert.equal(store.contextFor(sessionId), '');
});

test('the page waits for the reply and gets it whole, once ready', async () => {
  const { store } = work();
  store.start(sessionId, turnId, { agentId: 'secretary', name: 'Secrétaire', question: 'Question' });
  const waiting = store.wait(sessionId, turnId, { timeoutMs: 5000 });
  store.finish(sessionId, turnId, reply);
  assert.deepEqual(store.publicJob(await waiting), { turnId, pending: false, status: 'answered',
    speaker: { agentId: 'secretary', name: 'Secrétaire' }, reply });
  // Already settled: answered at once, and a later failure does not replace the answer.
  store.fail(sessionId, turnId, 'late');
  assert.equal(store.publicJob(await store.wait(sessionId, turnId)).status, 'answered');
});

test('a wait that times out says the member is still working; an unknown turn is nothing', async () => {
  const { store } = work();
  store.start(sessionId, turnId, { agentId: 'secretary', name: 'Secrétaire', question: 'Question' });
  assert.deepEqual(store.publicJob(await store.wait(sessionId, turnId, { timeoutMs: 10 })),
    { turnId, pending: true, speaker: { agentId: 'secretary', name: 'Secrétaire' } });
  assert.equal(store.publicJob(await store.wait(sessionId, 'unknown-turn')), null);
});

test('a failed member is reported, and settled work is dropped after its keep time', async () => {
  const { store, clock } = work();
  store.start(sessionId, turnId, { agentId: 'secretary', name: 'Secrétaire', question: 'Question' });
  store.fail(sessionId, turnId, 'gateway unavailable');
  assert.deepEqual(store.publicJob(await store.wait(sessionId, turnId)),
    { turnId, pending: false, status: 'failed', speaker: { agentId: 'secretary', name: 'Secrétaire' }, error: 'gateway unavailable' });
  clock.now += 601000;
  store.start(sessionId, 'another-turn-id', { agentId: 'comptable', name: 'Comptable', question: 'Autre' });
  assert.equal(await store.wait(sessionId, turnId), null);
});

test('an explicit stop cancels the members working in the background', () => {
  const { store } = work();
  let cancelled = 0;
  store.start(sessionId, turnId, { agentId: 'secretary', name: 'Secrétaire', question: 'Question', cancel: () => { cancelled += 1; } });
  assert.equal(store.cancel('another-session'), 0);
  assert.equal(store.cancel(sessionId), 1);
  assert.equal(cancelled, 1);
});

test('the member-reply route answers only for the personal conversation it belongs to', async () => {
  const routes = {};
  const store = createMemberWork({ conversations: { getSession: async ({ sessionId: id }) => (id === sessionId ? session : { ...session, packId: 'kidx_nestor', scopeId: 'family' }) } });
  store.register({ get(path, handler) { routes[path] = handler; } });
  const call = (id, turn) => new Promise(resolve => routes['/private/sessions/:sessionId/member-reply'](
    { params: { sessionId: id }, query: { turn } },
    { on() {}, status(code) { return { json: body => resolve({ code, body }) }; }, json: body => resolve({ code: 200, body }) }));
  store.start(sessionId, turnId, { agentId: 'secretary', name: 'Secrétaire', question: 'Question' });
  store.finish(sessionId, turnId, reply);
  assert.deepEqual((await call(sessionId, turnId)).body.data.work.reply, reply);
  assert.equal((await call('family-session', turnId)).code, 404);
});

// The /interrupt route: speaking over a member detaches it; only a stop cancels.
function interruptRoute(entry, memberWork) {
  const routes = {}, activePersonaTurns = new Map([[sessionId, entry]]);
  createBrowserSessionControls({ personas: { get() {}, post(path, handler) { routes[path] = handler; } }, activePersonaTurns, memberWork,
    conversations: { async updateTurn(filter) { return { _id: 'audit-1', sessionId, clientTurnId: filter.clientTurnId, interruptionState: 'confirmed' }; } },
    envelope: (res, data, status = 200) => res.reply(status, { ok: true, ...data }),
    fail: (res, status, message, code) => res.reply(status, { ok: false, message, code }),
    cleanText: value => String(value || ''), validClientTurnId: value => typeof value === 'string' && value.length > 8,
    nestorClient: async () => ({}) })('/private', 'personal_operator');
  return body => new Promise(resolve => routes['/private/sessions/:sessionId/interrupt'](
    { params: { sessionId }, body: { turnId, ...body } }, { reply: (status, data) => resolve({ status, body: data }) }));
}

function memberEntry() {
  const entry = { abort: new AbortController(), clientTurnId: turnId, detachCalls: 0,
    snapshot: { sessionId, packId: 'personal_operator', modeId: 'personal', scopeId: 'personal' } };
  entry.finished = new Promise(resolve => { entry.finish = resolve; });
  entry.abort.signal.addEventListener('abort', () => entry.finish());
  entry.detach = () => { entry.detachCalls += 1; return true; };
  return entry;
}

test('speaking over a team member detaches its turn instead of cancelling it', async () => {
  const entry = memberEntry();
  const result = await interruptRoute(entry)({});
  assert.deepEqual(result, { status: 200, body: { ok: true, interrupted: false, detached: true, turnId } });
  assert.equal(entry.abort.signal.aborted, false);
  assert.equal(entry.interrupted, undefined);
});

test('a stop cancels the member turn in flight and the members in the background', async () => {
  const entry = memberEntry();
  let stopped = 0;
  const result = await interruptRoute(entry, { cancel: id => { assert.equal(id, sessionId); stopped += 1; return 1; } })({ stop: true });
  assert.equal(result.body.interrupted, true);
  assert.equal(entry.detachCalls, 0);
  assert.equal(entry.abort.signal.aborted, true);
  assert.equal(stopped, 1);
});

test('a turn that can no longer detach is interrupted as before', async () => {
  const entry = memberEntry();
  entry.detach = () => false;
  const result = await interruptRoute(entry)({});
  assert.equal(result.body.interrupted, true);
  assert.equal(entry.abort.signal.aborted, true);
});
