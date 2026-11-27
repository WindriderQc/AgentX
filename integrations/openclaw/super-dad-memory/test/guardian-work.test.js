import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuardianWorkGuard } from '../guardian-work.js';
import { registerConversationWork } from '../conversation-work.js';
const native = { agentId: 'main', sessionKey: 'agent:main:household:direct:11111111-1111-4111-8111-111111111111',
  runId: 'resp_22222222-2222-4222-8222-222222222222' };
test('the exact native guardian cannot duplicate any Main tool work, including deferred actions', async () => {
  let hook; const posted = [];
  registerConversationWork({ pluginConfig: { agentxUrl: 'http://core.test', conversationWorkAgentId: 'worker',
    conversationWorkToken: 'synthetic-private-token' }, on(name, value) { if (name === 'before_tool_call') hook = value; }, registerTool() {} },
  { fetchImpl: async (_url, options) => { posted.push(JSON.parse(options.body)); return { ok: true,
    json: async () => ({ ok: true, data: { authority: 'core.conversation-works', delegated: true, id: 'a'.repeat(64), execution: 'pending' } }) }; } });
  for (const event of [{ toolName: 'web_search' }, { toolName: 'personal_memory' }, { toolName: 'sessions_spawn' },
    { toolName: 'tool_call', params: { id: 'plugin:personal-tasks:add_personal_task' } }]) {
    const blocked = await hook({ ...event, runId: native.runId, toolCallId: 'call' }, native);
    assert.equal(blocked.block, true); assert.match(blocked.blockReason, /complete native Main/);
  }
  assert.equal(posted.length, 4);
  assert.ok(posted.every(p => p.operation === 'guardian_tool' && JSON.stringify(p.context) === JSON.stringify(native)));
});
test('a background Main or legacy turn retains tools, with one absence probe per native run', async () => {
  let calls = 0;
  const guard = createGuardianWorkGuard(async () => { calls++; throw Object.assign(new Error('Not bound'), { statusCode: 404 }); });
  assert.equal(await guard(native), undefined); assert.equal(await guard(native), undefined); assert.equal(calls, 1);
  assert.equal(await guard({ ...native, agentId: 'secretary' }), undefined); assert.equal(calls, 1);
});
test('a known guardian stays fenced through Core failure or erasure without executing replacement work', async () => {
  let error;
  const guard = createGuardianWorkGuard(async () => { if (error) throw error; return { delegated: true, id: 'a'.repeat(64), execution: 'pending' }; });
  assert.equal((await guard(native)).block, true);
  for (const statusCode of [503, 404]) {
    error = Object.assign(new Error('Unavailable'), { statusCode });
    assert.equal((await guard(native)).block, true);
  }
});

test('a dedicated guardian exposes only the optional Core read transport under its real host call', async () => {
  const hooks = {}, posted = []; let factory;
  const guardian = { ...native, agentId: 'guardian', sessionKey: native.sessionKey.replace('agent:main:', 'agent:guardian:') };
  registerConversationWork({ pluginConfig: { agentxUrl: 'http://core.test', conversationWorkAgentId: 'worker',
    conversationGuardianAgentId: 'guardian', conversationWorkToken: 'synthetic-private-token' },
  on(name, hook) { hooks[name] = hook; }, registerTool(value) { factory = value; } }, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); posted.push(body);
    return { ok: true, json: async () => ({ ok: true, data: { authority: 'core.conversation-works',
      ...(body.operation === 'guardian_tool' ? { delegated: true } : { receipt: { callId: body.callId, status: 'completed' } }) } }) };
  } });
  assert.equal(factory(undefined), null);
  assert.equal(factory({}), null);
  const tool = factory(guardian);
  assert.deepEqual(tool.parameters.properties.operation.enum, ['guardian_tools', 'guardian_read']);
  assert.equal(tool.parameters.properties.runId, undefined);
  await assert.rejects(tool.execute('unbound', { operation: 'guardian_read', name: 'math', args: {} }), /binding is unavailable/);
  for (const toolName of ['web_search', 'personal_memory', 'sessions_spawn', 'exec', 'iss_passes', 'weather']) {
    assert.equal((await hooks.before_tool_call({ toolName, toolCallId: toolName }, guardian)).block, true);
  }
  const params = { operation: 'guardian_read', name: 'math', args: { operation: 'count', to: 2 } };
  assert.equal(await hooks.before_tool_call({ toolName: 'conversation_work', params, toolCallId: 'call|item_1' }, guardian), undefined);
  const result = await tool.execute('call|item_1', { ...params, runId: 'model-forgery', callId: 'forged' });
  assert.equal(result.details.receipt.callId, 'call|item_1');
  assert.deepEqual(posted.at(-1), { operation: 'guardian_read', context: guardian,
    input: { name: 'math', args: params.args }, callId: 'call|item_1' });
  for (const operation of ['request', 'tasks', 'publish', 'native_context']) await assert.rejects(tool.execute('call|item_1', { operation }), /role cannot/);
  await hooks.after_tool_call({ toolCallId: 'call|item_1' }, guardian);
  await assert.rejects(tool.execute('call|item_1', params), /binding is unavailable/);
});

test('dedicated guardian wrapper identity and Core observation cannot be forged or inferred from tool names', async () => {
  const guardian = { ...native, agentId: 'guardian' };
  let calls = 0, unavailable = false;
  const guard = createGuardianWorkGuard(async () => { calls++; if (unavailable) throw Error('Core unknown'); return { delegated: true }; }, 'guardian');
  const params = { id: 'openclaw:super-dad-memory:conversation_work', args: { operation: 'guardian_tools' } };
  assert.equal(await guard(guardian, { toolName: 'tool_call', params }), undefined);
  for (const event of [{ toolName: 'tool_call', params: { ...params, id: 'other:conversation_work' } },
    { toolName: 'conversation_work', params: { operation: 'tasks' } }, { toolName: 'conversation_work' }]) {
    assert.equal((await guard(guardian, event)).block, true);
  }
  assert.equal(calls, 1);
  unavailable = true;
  assert.equal((await guard(guardian, { toolName: 'tool_call', params })).block, true);
});

test('a foreground decision applies only to its local isolated consultation call', async () => {
  let missing = false;
  const guard = createGuardianWorkGuard(async (_op, _native, input) => {
    if (missing) throw Object.assign(new Error('Unavailable'), { statusCode: 404 });
    return { foreground: true, delegated: false };
  }, undefined, (_ctx, child) => !child || child === 'reader');
  const spawn = args => ({ toolName: 'tool_call', toolCallId: 'call1', params: {
    id: 'openclaw:core:sessions_spawn', args: { agentId: 'reader', context: 'isolated', task: 'Synthetic question', ...args }
  } });
  assert.equal(await guard(native, spawn()), undefined);
  for (const args of [{context:'fork'},{agentId:'remote'},{model:'other/model'},{runtime:'acp'},{attachments:[{}]}]) {
    assert.equal((await guard(native, spawn(args))).block, true);
  }
  assert.equal((await guard(native,{toolName:'personal_memory'})).block, true);
  missing = true;
  assert.equal((await guard(native, spawn())).block,true);
});

test('a wrapped private spawn accepts an explicit false visibility only with Core foreground admission', async () => {
  const inputs = [];
  let available = true;
  const guard = createGuardianWorkGuard(async (_op, _ctx, input) => {
    inputs.push(input);
    if (!available || !input) throw Object.assign(new Error('No foreground admission'), { statusCode: 409 });
    return { foreground: true, delegated: false };
  }, undefined, (_ctx, child) => child === 'reader');
  const spawn = overrides => ({
    toolName: 'tool_call', toolCallId: 'call2',
    params: { id: 'sessions_spawn', args: { agentId: 'reader', context: 'isolated', task: 'Read the fixture', visible: false, ...overrides } }
  });
  assert.equal(await guard(native, spawn({})), undefined);
  assert.deepEqual(inputs.at(-1), { tool: 'sessions_spawn' });
  for (const overrides of [{ visible: true }, { visible: 'false' }, { visible: null }, { agentId: 'other' }, { context: 'fork' }]) {
    assert.equal((await guard(native, spawn(overrides))).block, true);
    assert.equal(inputs.at(-1), undefined);
  }
  available = false;
  assert.equal((await guard(native, spawn({}))).block, true);
});
