'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const { conversationBackend, familyConversationBackend, voiceTask, createConversationExecutor } = require('../conversation-executor');

const configured = { OPENCLAW_GATEWAY_URL: 'http://test.invalid', OPENCLAW_GATEWAY_TOKEN: 'fixture' };
const request = () => ({ backend: 'agentx', session: { sessionId: 'conversation', modeId: 'family' },
  pack: { id: 'kidx_nestor', taskType: 'nestor_answer_light', temperature: 0.5, maxTokens: 800 },
  text: 'Et ensuite?', history: [{ role: 'user', content: 'Je construis un rover.' }, { role: 'assistant', content: 'Commençons par les roues.' }],
  instructions: 'Native scoped context', agentxInstructions: 'Family base identity and approved context',
  signal: new AbortController().signal, streaming: false, onDelta: () => {} });

test('all conversations resolve an optional backend once, without depending on native configuration', () => {
  assert.equal(conversationBackend(null, {}), 'agentx');
  assert.equal(conversationBackend(null, { OPENCLAW_GATEWAY_URL: 'http://test.invalid' }), 'agentx');
  assert.equal(conversationBackend(null, configured), 'openclaw');
  assert.equal(conversationBackend('agentx', configured), 'agentx');
  assert.equal(conversationBackend(null, { ...configured, HOUSEHOLD_CONVERSATION_BACKEND: 'agentx' }), 'agentx');
  assert.equal(conversationBackend('openclaw', {}), 'openclaw');
  assert.throws(() => conversationBackend('unknown', {}), { statusCode: 400 });
});

test('AgentX preserves server history, persona context, routing and explicit Open on the existing inference contract', async () => {
  let submitted, options;
  const execute = createConversationExecutor({ agentClient: () => assert.fail('No native dependency'), consumerContract: 'household-runtime-v1',
    inference: { execute: async (body, context) => { submitted = body; options = context;
      return { ok: true, body: { message: { content: 'Les roues!' } }, metadata: { model: 'local-model', hostKey: 'local' } }; } } });
  const input = { ...request(), model: 'ollama/local-open', openTarget: { hostUrl: 'http://reserved-host:11434', numCtx: 32768 } };
  const reply = await execute(input);
  assert.deepEqual(submitted.messages, [{ role: 'system', content: input.agentxInstructions }, ...input.history, { role: 'user', content: input.text }]);
  assert.equal(submitted.model, 'local-open');
  assert.equal(submitted.exclusiveHost, true);
  assert.equal(submitted.options.num_ctx, input.openTarget.numCtx);
  assert.equal(options.hostUrl, input.openTarget.hostUrl);
  assert.equal(submitted.taskType, 'nestor_answer_light');
  assert.equal(submitted.think, false);
  assert.equal(submitted.tools, undefined);
  assert.equal(options.consumerContract, 'household-runtime-v1');
  assert.equal(options.signal, input.signal);
  assert.equal(reply.text, 'Les roues!');
  assert.equal(reply.tools.status, 'not_supported');
  assert.equal(reply.metadata.model, 'local-model');
});

test('the family lane names the backend of new family conversations only when the instance sets it (#261)', () => {
  assert.equal(familyConversationBackend({}), null);
  assert.equal(familyConversationBackend({ HOUSEHOLD_FAMILY_CONVERSATION_BACKEND: '' }), null);
  assert.equal(familyConversationBackend({ HOUSEHOLD_FAMILY_CONVERSATION_BACKEND: 'agentx' }), 'agentx');
  assert.equal(familyConversationBackend({ HOUSEHOLD_FAMILY_CONVERSATION_BACKEND: ' OpenClaw ' }), 'openclaw');
  for (const value of ['auto', 'unknown', 'true']) assert.equal(familyConversationBackend({ HOUSEHOLD_FAMILY_CONVERSATION_BACKEND: value }), null);
  // Unset, the general choice stands; set, it wins over that choice and over what a page requested.
  const choose = (requested, env) => conversationBackend(familyConversationBackend(env) || requested, env);
  assert.equal(choose(null, configured), 'openclaw');
  assert.equal(choose('openclaw', { ...configured, HOUSEHOLD_FAMILY_CONVERSATION_BACKEND: 'agentx' }), 'agentx');
  assert.equal(choose('agentx', { HOUSEHOLD_CONVERSATION_BACKEND: 'agentx', HOUSEHOLD_FAMILY_CONVERSATION_BACKEND: 'openclaw' }), 'openclaw');
});

test('a spoken turn on Core inference uses the voice task in any pack; typed turns keep the pack task (#261)', async () => {
  assert.equal(voiceTask({}), 'voice_persona_chat');
  assert.equal(voiceTask({ HOUSEHOLD_VOICE_TASK: ' quick_chat ' }), 'quick_chat');
  assert.equal(voiceTask({ HOUSEHOLD_VOICE_TASK: 'Not a task!' }), 'voice_persona_chat');
  const submitted = [];
  const executor = env => createConversationExecutor({ env, agentClient: () => assert.fail('No native dependency'),
    inference: { execute: async body => { submitted.push(body); return { ok: true, body: { response: 'ok' }, metadata: {} }; } } });
  const personal = { id: 'personal_operator', taskType: 'general_chat', temperature: 0.35, maxTokens: 800 };
  await executor({})({ ...request(), channel: 'voice', streaming: true });
  await executor({})({ ...request(), channel: 'text' });
  await executor({})({ ...request(), pack: personal, channel: 'voice' });
  await executor({ HOUSEHOLD_VOICE_TASK: 'quick_chat' })({ ...request(), channel: 'voice' });
  await executor({})({ ...request(), channel: 'voice', session: { ...request().session, llmx: { schemaVersion: 1 } } });
  assert.deepEqual(submitted.map(body => body.taskType),
    ['voice_persona_chat', 'nestor_answer_light', 'voice_persona_chat', 'quick_chat', 'nestor_answer_light']);
  assert.deepEqual(submitted.map(body => body.think), [false, false, false, false, false]);
  assert.equal(submitted[0].stream, true);
  assert.equal(submitted[0].max_tokens, 800);
  assert.equal(submitted[0].callerDetail, 'agentx-household/kidx_nestor/family');
});

test('native errors never replay an action through AgentX', async () => {
  let attempts = 0;
  const execute = createConversationExecutor({ agentClient: async () => { attempts++; throw new Error('Connection lost after dispatch'); },
    inference: { execute: () => assert.fail('Must not replay') } });
  await assert.rejects(execute({ ...request(), backend: 'openclaw' }), /Connection lost/);
  assert.equal(attempts, 1);
});

test('AgentX streamed replies wait for Core completion, including cancellation and malformed output', async () => {
  for (const cancel of [false, true, 'malformed']) {
    const controller = new AbortController(), deltas = [];
    let complete, settled = false;
    const completion = new Promise(resolve => { complete = resolve; });
    const execute = createConversationExecutor({ inference: { execute: async () => ({ ok: true, completion,
      stream: Readable.from((async function* () {
        yield '{"message":{"content":"Bonjour"},"done":false}\n';
        await new Promise(resolve => setImmediate(resolve));
        if (cancel === true) controller.abort();
        yield cancel === 'malformed' ? 'broken\n' : '{"message":{"content":"!"},"done":true}\n';
      })()) }) } });
    const running = execute({ ...request(), streaming: true, signal: controller.signal, onDelta: d => deltas.push(d) })
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'The host admission must remain owned until completion');
    complete();
    const result = await running;
    if (cancel === 'malformed') assert.ok(result.error);
    else assert.equal(result.value.text, cancel ? '' : 'Bonjour!');
    assert.deepEqual(deltas, cancel ? ['Bonjour'] : ['Bonjour', '!']);
  }
});

test('a household turn outranks evaluation work and reports a busy host plainly (#62)', async () => {
  const priority = require('../../../src/services/interactivePriorityService');
  let activeDuringRun = false;
  const waitingNotices = [];
  const execute = createConversationExecutor({ consumerContract: 'household-runtime-v1',
    agentClient: async () => {
      activeDuringRun = priority.householdTurnActive();
      priority.noteWaiting('http://host-a:11434');
      throw Object.assign(new Error('Inference host is reserved by an active benchmark workload.'), { code: 'BENCHMARK_CLAIM_ACTIVE' });
    },
    inference: { execute: async () => assert.fail('native backend expected') } });
  await assert.rejects(execute({ ...request(), backend: 'openclaw', onWaiting: info => waitingNotices.push(info) }), error => {
    assert.equal(error.code, 'HOUSEHOLD_NESTOR_BUSY');
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /^Nestor est occupé/);
    return true;
  });
  assert.equal(activeDuringRun, true);
  assert.deepEqual(waitingNotices, [{ host: 'http://host-a:11434', waitMs: 60000 }]);
  priority.noteWaiting('http://host-a:11434');
  assert.equal(waitingNotices.length, 1, 'an ended turn is no longer notified');
  assert.equal(priority._state.activeTurns, 0);
});
