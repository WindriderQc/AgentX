'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { conversationBackend, browserSpeechFallback } = require('../conversation-executor');
const { createAgentClient } = require('../conversation-agent');
const { createHermesTransport } = require('../../../src/services/conversations/hermesTransport');
const { createVoiceWarmup } = require('../voice-warmup');
const { harness } = require('./fixtures/persona-journey.cjs');

const env = { HOUSEHOLD_PROTECTED_SOURCES_LOCAL_ONLY: 'true', HOUSEHOLD_CONVERSATION_BACKEND: 'openclaw',
  HOUSEHOLD_PERSONAL_CONVERSATION_BACKEND: 'hermes', HOUSEHOLD_BROWSER_STT_FALLBACK: 'true',
  HOUSEHOLD_HERMES_URL: 'http://127.0.0.1:19000', HOUSEHOLD_HERMES_TOKEN: 'fixture',
  OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:19001', OPENCLAW_GATEWAY_TOKEN: 'fixture' };
const code = 'HOUSEHOLD_PROTECTED_SOURCES_LOCAL_ONLY';
const packs = ['personal_operator', 'kidx_nestor'];

test('automatic household selection is local and an explicit unavailable engine retains its identity', () => {
  for (const automatic of [undefined, 'auto', 'agentx']) assert.equal(conversationBackend(automatic, env), 'agentx');
  for (const native of ['hermes', 'openclaw']) assert.throws(() => conversationBackend(native, env), { code });
  assert.deepEqual(browserSpeechFallback(env), { family: false, personal: false });
});

for (const packId of packs) {
  test(packId + ' continues an ordinary turn through the local inference contract', async () => {
    const journey = harness({ packId, backend: 'agentx', conversationEnv: env, response: 'Réponse fictive.' });
    await journey.turn('Question de fixture ordinaire', 'text');
    assert.equal(journey.sent.length, 1);
    assert.equal(journey.turns.length, 1);
  });

  for (const backend of packId === 'personal_operator' ? ['hermes', 'openclaw'] : ['openclaw']) {
    test(packId + ' holds a retained ' + backend + ' turn before source preparation and persistence', async () => {
      const reads = [];
      const j = harness({ packId, backend, conversationEnv: env, failContext: name => reads.push(name) });
      const res = { on() {}, removeListener() {}, writableEnded: false, headersSent: false };
      const params = { sessionId: j.session.sessionId }, body = { text: 'synthetic input', channel: 'text' };
      await j.handle({ params, body }, res, j.pack.childSafe ? 'child' : 'private');
      assert.equal(res.failure?.code, code);
      assert.deepEqual(reads, []);
      assert.deepEqual(j.sent, []);
      assert.deepEqual(j.turns, []);
      assert.equal(j.session.backend, backend);
    });
  }
}

test('a legacy retained native identity cannot be adopted silently by a local turn', async () => {
  for (const prior of [{ agentSessionKey: 'agent:main:household:direct:fixture' }, { hermesRuntime: { state: 'dispatching' } }]) {
    const j = harness({ packId: 'personal_operator', backend: undefined, conversationEnv: env });
    Object.assign(j.session, prior);
    const res = { on() {}, removeListener() {}, writableEnded: false, headersSent: false };
    await j.handle({ params: { sessionId: j.session.sessionId }, body: { text: 'fixture' } }, res, 'private');
    assert.equal(res.failure.code, code);
    assert.deepEqual(j.sent, []);
  }
});

test('native worker, warmup and lost Hermes admission cannot transmit a protected payload', async () => {
  const calls = [];
  const fetchImpl = async url => { calls.push(url); throw new Error('Unexpected transport'); };
  const agent = createAgentClient({ env, fetchImpl });
  await assert.rejects(agent({ session: {}, text: 'fixture' }), { code });
  const warm = createVoiceWarmup({ conversationEnv: { ...env, HOUSEHOLD_VOICE_WARMUP: 'true' } });
  assert.deepEqual(warm.start({}, 'fixture'), { started: false, reason: 'protected_sources_local_only' });
  const hermes = createHermesTransport({ env, fetchImpl, persist: async () => assert.fail('Unexpected journal update') });
  const previous = { key: 'synthetic-run-key', startedAt: new Date().toISOString(), state: 'dispatching',
    sessionKey: 'agentx:personal:fixture', body: { input: 'fixture' } };
  const session = { sessionId: 'fixture', packId: 'personal_operator', scopeId: 'personal', hermesRuntime: previous };
  await assert.rejects(hermes({ session, text: 'fixture' }), { code });
  assert.equal(session.hermesRuntime, previous);
  assert.deepEqual(calls, []);
});
