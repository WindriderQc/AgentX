'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const { conversationBackend, familyConversationBackend, voiceTask, createConversationExecutor } = require('../conversation-executor');

const configured = { OPENCLAW_GATEWAY_URL: 'http://test.invalid', OPENCLAW_GATEWAY_TOKEN: 'fixture' };

test('confirmed Core recaps reach both personal transports without crossing into family', async () => {
  let corePayload, nativePayload, reads = 0;
  const personalRecaps = { read: async () => { reads++; return { recap: { summary: 'Synthetic confirmed point', nextStep: '', takeaway: '' } }; }, latest: async () => null };
  const execute = createConversationExecutor({ personalRecaps,
    inference: { execute: async value => { corePayload = value; return { ok: true, body: { message: { content: 'Synthetic reply' } } }; } },
    agentClient: async value => { nativePayload = value; return { text: 'Synthetic native reply' }; }
  });
  const personal = { ...request(), session: { sessionId: 'synthetic-personal', packId: 'personal_operator', modeId: 'personal' }, turnContext: 'Existing selected context' };
  await execute(personal);
  assert.ok(corePayload.messages.at(-1).content.includes('Synthetic confirmed point'));
  assert.ok(corePayload.messages.at(-1).content.includes('Existing selected context'));
  await execute({ ...personal, backend: 'openclaw' });
  assert.ok(nativePayload.turnContext.includes('Synthetic confirmed point'));
  await execute(request());
  assert.equal(reads, 2);
  assert.ok(!corePayload.messages.at(-1).content.includes('Synthetic confirmed point'));
});
test('disabled confirmed recap performs no read on either personal transport', async () => {
  const payloads = [];
  const execute = createConversationExecutor({ personalRecaps: { read: () => assert.fail('Disabled context must not be read'), latest: () => assert.fail('Disabled continuation must not be read') },
    inference: { execute: async value => { payloads.push(value); return { ok: true, body: { response: 'Synthetic' } }; } },
    agentClient: async value => { payloads.push(value); return { text: 'Synthetic native' }; } });
  const input = { ...request(), session: { sessionId: 'synthetic-personal', packId: 'personal_operator', modeId: 'personal' },
    conversationFeatures: { recapContext: false }, turnContext: 'Selected context' };
  await execute(input); await execute({ ...input, backend: 'openclaw' });
  assert.ok(payloads[0].messages.at(-1).content.includes('Selected context'));
  assert.equal(payloads[1].turnContext, 'Selected context');
});
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

// Famille tool loop (HOUSEHOLD_FAMILY_TOOLS): synthetic tool set, no Core service.
const issCall = { function: { name: 'iss_passes', arguments: { visible_only: true } } };
function syntheticToolset(results = []) {
  const executed = [];
  return { executed, toolset: { names: ['iss_passes'], maxRounds: 2, maxCallsPerRound: 3,
    definitions: [{ type: 'function', function: { name: 'iss_passes', description: 'Synthetic', parameters: { type: 'object', properties: {} } } }],
    instructions: 'Synthetic tool instructions',
    execute: async call => { executed.push(call); const content = results.shift() || '{"status":"ok"}';
      return { message: { role: 'tool', tool_name: call.function.name, content }, receipt: { tool: call.function.name, status: 'completed', at: 'synthetic' } }; } } };
}

test('Famille tools: a tool call runs through Core, then the model answers from its result', async () => {
  const bodies = [];
  const replies = [{ message: { content: '', tool_calls: [issCall] } }, { message: { content: 'Lundi à 06 h 03, si le ciel est dégagé.' } }];
  const execute = createConversationExecutor({ agentClient: () => assert.fail('No native dependency'),
    inference: { execute: async body => { bodies.push(structuredClone(body)); return { ok: true, body: replies.shift(), metadata: { model: 'local' } }; } } });
  const { executed, toolset } = syntheticToolset(['{"status":"ok","nextVisible":{"startLocal":"lun. 26 oct., 06 h 03"}}']);
  const reply = await execute({ ...request(), familyTools: toolset });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].tools, toolset.definitions);
  assert.deepEqual(bodies[1].tools, toolset.definitions); // a second round may still call a tool
  assert.deepEqual(executed, [issCall]);
  const second = bodies[1].messages;
  assert.deepEqual(second.at(-2), { role: 'assistant', content: '', tool_calls: [issCall] });
  assert.deepEqual(second.at(-1), { role: 'tool', tool_name: 'iss_passes', content: '{"status":"ok","nextVisible":{"startLocal":"lun. 26 oct., 06 h 03"}}' });
  assert.equal(reply.text, 'Lundi à 06 h 03, si le ciel est dégagé.');
  assert.deepEqual(reply.tools, { status: 'observed', authority: 'agentx/core', offered: ['iss_passes'],
    receipts: [{ tool: 'iss_passes', status: 'completed', at: 'synthetic' }] });
  assert.equal(reply.metadata.toolRounds, 1);
});

test('Famille tools: a streamed reply without a tool call streams once, unchanged', async () => {
  const deltas = [];
  let calls = 0;
  const execute = createConversationExecutor({ agentClient: () => assert.fail('No native dependency'),
    inference: { execute: async body => { calls += 1; assert.ok(body.tools); return { ok: true, completion: Promise.resolve(),
      stream: Readable.from(['{"message":{"content":"Bon"}}\n', '{"message":{"content":"jour"},"done":true}\n']) }; } } });
  const reply = await execute({ ...request(), streaming: true, onDelta: d => deltas.push(d), familyTools: syntheticToolset().toolset });
  assert.equal(calls, 1);
  assert.deepEqual(deltas, ['Bon', 'jour']);
  assert.equal(reply.text, 'Bonjour');
  assert.deepEqual(reply.tools.receipts, []);
  assert.equal(reply.tools.status, 'observed');
});

test('Famille tools: a streamed tool call is executed and only the answer is spoken', async () => {
  const deltas = [];
  const streams = [
    ['{"message":{"content":"","tool_calls":[{"function":{"name":"iss_passes","arguments":{"visible_only":true}}}]}}\n', '{"message":{"content":""},"done":true}\n'],
    ['{"message":{"content":"Demain à 06 h 03."},"done":true}\n'],
  ];
  const execute = createConversationExecutor({ agentClient: () => assert.fail('No native dependency'),
    inference: { execute: async () => ({ ok: true, completion: Promise.resolve(), stream: Readable.from(streams.shift()) }) } });
  const { executed, toolset } = syntheticToolset();
  const reply = await execute({ ...request(), streaming: true, onDelta: d => deltas.push(d), familyTools: toolset });
  assert.deepEqual(executed, [issCall]);
  assert.deepEqual(deltas, ['Demain à 06 h 03.']);
  assert.equal(reply.text, 'Demain à 06 h 03.');
});

test('Famille tools: rounds are bounded, and the last request offers no tool', async () => {
  const bodies = [];
  const execute = createConversationExecutor({ agentClient: () => assert.fail('No native dependency'),
    inference: { execute: async body => { bodies.push(body); return { ok: true, body: { message: bodies.length <= 2
      ? { content: '', tool_calls: [issCall] } : { content: 'Réponse finale.' } } }; } } });
  const { executed, toolset } = syntheticToolset();
  const reply = await execute({ ...request(), familyTools: toolset });
  assert.equal(bodies.length, 3);
  assert.ok(bodies[0].tools && bodies[1].tools);
  assert.equal(bodies[2].tools, undefined);
  assert.equal(executed.length, 2);
  assert.equal(reply.text, 'Réponse finale.');
  assert.equal(reply.metadata.toolRounds, 2);
});

test('Famille tools: a runtime that refuses tools answers the turn without them and says so', async () => {
  const bodies = [];
  const execute = createConversationExecutor({ agentClient: () => assert.fail('No native dependency'),
    inference: { execute: async body => { bodies.push(body); return bodies.length === 1
      ? { ok: false, status: 400, body: { error: 'registry.ollama.ai/library/x does not support tools' } }
      : { ok: true, body: { message: { content: 'Sans outil.' } } }; } } });
  const reply = await execute({ ...request(), familyTools: syntheticToolset().toolset });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].tools, undefined);
  assert.equal(reply.text, 'Sans outil.');
  assert.equal(reply.tools.status, 'not_supported');
  assert.match(reply.tools.reason, /does not accept tools/);
});

test('without Famille tools the AgentX request carries no tools field', async () => {
  let body;
  const execute = createConversationExecutor({ agentClient: () => assert.fail('No native dependency'),
    inference: { execute: async value => { body = value; return { ok: true, body: { message: { content: 'Ok' } } }; } } });
  const reply = await execute(request());
  assert.equal('tools' in body, false);
  assert.equal(reply.tools.status, 'not_supported');
});
