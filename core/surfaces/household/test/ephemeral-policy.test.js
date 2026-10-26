'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/conversation-privacy');
const { privacyForNew } = require('../ephemeral-policy');
const { withEphemeralSessions } = require('../../../src/services/conversations/ephemeralSessions');
const { redact } = require('../../../src/services/conversations/ephemeralTelemetry');
const input = { packId: 'personal_operator', modeId: 'operator', scopeId: 'personal', backend: 'agentx', ephemeral: true };

test('Open defaults on, is sticky on return to Standard, and manual choices survive every rerender/model selection', () => {
  const state = create();
  assert.deepEqual(state.snapshot(), { ephemeral: false, ephemeralExplicit: false });
  assert.equal(state.select(true).ephemeral, true);
  assert.equal(state.select(false).ephemeral, true);
  assert.deepEqual(state.choose(false), { ephemeral: false, ephemeralExplicit: true });
  const submitted = state.snapshot();
  for (const open of [true, false, true]) assert.deepEqual(state.select(open), submitted);
  assert.equal(state.choose(true).ephemeral, true);
  assert.equal(submitted.ephemeral, false, 'an in-flight submission is immutable');
  assert.deepEqual(state.reset(false), { ephemeral: false, ephemeralExplicit: false });
  assert.equal(state.reset(true).ephemeral, true);
  assert.equal(create().snapshot().ephemeral, false, 'another tab/conversation has no inherited choice');
  assert.deepEqual(state.restore({ ephemeral: false, ephemeralExplicit: true }), submitted);
  assert.deepEqual(state.select(true), submitted);
});

test('server defaults recognize the real Open selector and an explicit OFF overrides it', () => {
  assert.equal(privacyForNew({}, true).ephemeral, true);
  assert.equal(privacyForNew({}, false).ephemeral, false);
  assert.equal(privacyForNew({ ephemeral: false, ephemeralExplicit: false }, true).ephemeral, true);
  assert.deepEqual(privacyForNew({ ephemeral: false }, true), { ephemeral: false, ephemeralExplicit: true });
  for (const value of ['false', null, 1]) assert.throws(() => privacyForNew({ ephemeral: value }), /boolean/);
});

test('transient contents and attachment decoding never touch the durable adapter and cannot cross scopes', async t => {
  const calls = [];
  const durable = Object.fromEntries(['createSession', 'getSession', 'recordTurn', 'exportSession', 'updateTurns', 'ensureSession']
    .map(name => [name, async (...args) => { calls.push([name, ...args]); return {}; }]));
  const store = withEphemeralSessions(durable); t.after(() => store.disposeEphemeral());
  const session = await store.createSession(input), other = await store.createSession(input);
  const query = { sessionId: session.sessionId, packId: input.packId, scopeId: input.scopeId };
  assert.equal(await store.getSession({ ...query, scopeId: 'family' }), null);
  await store.recordTurn({ ...query, traceId: 'trace-1', clientTurnId: 'turn-1', inputText: 'SYNTHETIC_EPHEMERAL', replyText: 'reply' });
  await store.recordTurn({ ...query, traceId: 'trace-2', clientTurnId: 'turn-2', inputText: 'SECOND_TURN', replyText: 'reply' });
  assert.equal((await store.listTurns(query, { sort: { createdAt: -1, _id: -1 } }))[0].inputText, 'SECOND_TURN');
  assert.equal((await store.listTurns(query))[0].memoryState, 'not_applicable');
  assert.equal((await store.listTurns({ ...query, sessionId: other.sessionId })).length, 0);
  const files = store.ephemeralAttachments(session.sessionId);
  const ref = await files.upload({ name: 'sample.txt', dataUrl: 'data:text/plain;base64,' + Buffer.from('SYNTHETIC_FILE').toString('base64') });
  const prepared = await files.prepare([{ role: 'user', content: 'read', attachments: [ref] }], 'agentx');
  assert.match(prepared[0].content, /SYNTHETIC_FILE/);
  await assert.rejects(store.ephemeralAttachments(other.sessionId).references([ref.id]), /not found/);
  await assert.rejects(store.exportSession(query), /cannot be exported/);
  await assert.rejects(store.ensureSession(query), /retained history/);
  await assert.rejects(store.recordTurn({ ...query, traceId: 'trace-2', clientTurnId: 'turn-1' }), /already submitted/);
  await store.deleteSession(query);
  await assert.rejects(store.recordTurn({ ...query, traceId: 'late' }), /expired/);
  assert.deepEqual(calls, []);
});

test('expiry and restart refuse the reserved identity instead of falling through to Mongo', async t => {
  let durableCalls = 0;
  const durable = { getSession() { durableCalls++; } };
  const store = withEphemeralSessions(durable, { idleMs: 10 }); t.after(() => store.disposeEphemeral());
  const session = await store.createSession(input);
  await new Promise(resolve => setTimeout(resolve, 25));
  await assert.rejects(store.getSession({ sessionId: session.sessionId }), { code: 'CONVERSATION_EPHEMERAL_EXPIRED' });
  const restarted = withEphemeralSessions(durable);
  await assert.rejects(restarted.getSession({ sessionId: session.sessionId }), { code: 'CONVERSATION_EPHEMERAL_EXPIRED' });
  assert.equal(durableCalls, 0);
});

test('unsupported native engines fail before allocation; ordinary persistence keeps its complete options', async () => {
  const calls = [], store = withEphemeralSessions({
    createSession: async row => row, recordTurn: async (...args) => { calls.push(args); }
  });
  for (const backend of ['hermes', 'openclaw']) await assert.rejects(store.createSession({ ...input, backend }), { code: 'CONVERSATION_EPHEMERAL_UNSUPPORTED' });
  const row = { sessionId: 'retained', traceId: 'synthetic' }, options = { sessionPatch: { 'llmx.opening.status': 'completed' } };
  await store.recordTurn(row, options);
  assert.deepEqual(calls, [[row, options]]);
  const entry = { error: 'SYNTHETIC_PRIVATE_ERROR', tokensIn: 20, tokensOut: 2, status: 'error' };
  assert.equal(redact(entry, {}).error, entry.error);
  assert.equal(redact(entry, { contentRetention: 'ephemeral' }).error, 'ephemeral_inference_failed');
});
