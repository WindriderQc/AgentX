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
