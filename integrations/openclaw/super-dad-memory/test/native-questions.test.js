import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeQuestions } from '../native-questions.js';
const workId = 'a'.repeat(64), intentId = '174c1870-6f09-4b77-a83b-e493238b928a';
const config = { agentxUrl: 'http://127.0.0.1:3180', conversationWorkToken: 'synthetic-core-service-credential-664',
  questionGatewayUrl: 'ws://127.0.0.1:18789', questionDeviceStateDir: '/tmp/synthetic-question-device-664',
  questionDeviceToken: 'synthetic-device-questions-only-credential-664' };
const question = { id: 'ask_fixture', incarnation: 'original-incarnation', agentId: 'main',
  sessionKey: 'agent:main:household:direct:synthetic', runId: 'resp_synthetic',
  questions: [{ questionId: 'day', question: 'Which day?', options: [{ label: 'Tuesday' }], isSecret: false }] };
const answers = { answers: { day: ['Tuesday'] } };
const effect = { operation: 'question_effect', workId, intentId, lookupOnly: false };
function fixture({ capability = true, packet = {}, rpcError, nativeQuestions, emptyConfig = false } = {}) {
  const calls = [], coreCalls = []; let sdkLoads = 0, claimed = false;
  class GatewayClient {
    constructor(options) { this.options = options; }
    start() { queueMicrotask(() => this.options.onHelloOk({ auth: { method: 'device-token', role: 'operator', scopes: ['operator.questions'] },
      features: { methods: ['question.list', 'question.resolve', 'question.waitAnswer'], capabilities: capability ? ['question-conditional-resolve-v1'] : [] } })); }
    async stopAndWait() {}
    async request(method, params) {
      calls.push({ method, params }); if (rpcError) throw rpcError;
      if (method === 'question.list') return { questions: nativeQuestions || [] };
      return { status: 'answered', incarnation: question.incarnation, resolutionId: intentId, answers };
    }
  }
  const operate = createNativeQuestions({ config: emptyConfig ? {} : config,
    loadSdk: async () => { sdkLoads++; return { GatewayClient }; },
    fetchImpl: async (_url, options) => {
      const input = JSON.parse(options.body); coreCalls.push(input);
      const action = claimed || input.input.lookupOnly ? 'lookup' : 'resolve'; claimed = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { authority: 'core.conversation-works',
        workId, intentId, action, question, resolutionId: intentId, ...(action === 'resolve' && { answers }),
        ...(input.operation === 'question_context' && { action: 'observe', attempt: { agentId: question.agentId, sessionKey: question.sessionKey, runId: question.runId } }), ...packet } }) };
    } });
  return { operate, calls, coreCalls, sdkLoads: () => sdkLoads };
}

test('caller cannot nominate answers, session, credential or an unbound operation', async () => {
  const f = fixture();
  for (const extra of [{ answers }, { sessionKey: question.sessionKey }, { token: 'borrowed' }, { mode: 'resolve' }]) {
    await assert.rejects(f.operate({ ...effect, ...extra }), { statusCode: 400 });
  }
  assert.equal(f.sdkLoads(), 0); assert.equal(f.coreCalls.length, 0);
});

test('absent configuration and old capability never claim a Core effect or borrow another credential', async () => {
  const absent = fixture({ emptyConfig: true });
  assert.deepEqual(await absent.operate(effect), { contract: 0 });
  assert.equal(absent.sdkLoads(), 0);
  const old = fixture({ capability: false });
  await assert.rejects(old.operate(effect), { code: 'NATIVE_QUESTIONS_UNAVAILABLE' });
  assert.equal(old.coreCalls.length, 0); assert.equal(old.calls.length, 0);
});

test('only the retained Core packet selects the one resolution; subsequent triggers and read-only requests lookup the original incarnation', async () => {
  const f = fixture();
  assert.deepEqual(await f.operate(effect), { contract: 1, status: 'answered', incarnation: question.incarnation, resolutionId: intentId, answers });
  assert.deepEqual(f.coreCalls[0].input, { workId, intentId, lookupOnly: false });
  assert.deepEqual(f.calls[0], { method: 'question.resolve', params: {
    id: question.id, expectedIncarnation: question.incarnation, resolutionId: intentId, answers } });
  await f.operate(effect);
  await f.operate({ ...effect, lookupOnly: true });
  assert.deepEqual(f.calls.slice(1), Array.from({ length: 2 }, () => ({ method: 'question.waitAnswer', params: {
    id: question.id, expectedIncarnation: question.incarnation, timeoutMs: 1, includeResolutionId: true } })));
});

test('a lookup can never be promoted to a resolution by a malformed Core response', async () => {
  const f = fixture({ packet: { action: 'resolve' } });
  await assert.rejects(f.operate({ ...effect, lookupOnly: true }), { statusCode: 400 });
  assert.equal(f.calls.length, 0);
});

test('incarnation mismatch is an explicit non-effect with no retry or successor lookup', async () => {
  const f = fixture({ rpcError: { details: { reason: 'QUESTION_INCARNATION_MISMATCH' } } });
  assert.deepEqual(await f.operate(effect), { contract: 1, status: 'mismatch' });
  assert.equal(f.calls.length, 1);
});

test('secret and store-bound packets never reach native resolution', async () => {
  for (const input of [{ isSecret: true }, { secretStore: { name: 'SYNTHETIC_SECRET' } }]) {
    const f = fixture({ packet: { question: { ...question, questions: [{ ...question.questions[0], ...input }] } } });
    await assert.rejects(f.operate(effect), { statusCode: 400 });
    assert.equal(f.calls.length, 0);
  }
});


test('observation binds the Core attempt and withholds secret payloads while reporting unavailability', async () => {
  const secret = { ...question, id: 'secret', questions: [{ ...question.questions[0], isSecret: true, question: 'Private synthetic secret prompt' }] };
  const foreign = { ...secret, sessionKey: 'foreign' };
  const f = fixture({ nativeQuestions: [question, secret, foreign] });
  const observed = await f.operate({ operation: 'questions', workId });
  assert.equal(observed.contract, 1); assert.equal(observed.blocked, true);
  assert.deepEqual(observed.questions, [question]);
  assert.equal(JSON.stringify(observed).includes('Private synthetic secret prompt'), false);
  assert.deepEqual(f.coreCalls[0].input, { workId });
});
