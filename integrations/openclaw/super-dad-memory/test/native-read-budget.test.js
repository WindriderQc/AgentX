import test from 'node:test';
import assert from 'node:assert/strict';
import { registerNativeReadBudget } from '../native-read-budget.js';
import { readFile } from 'node:fs/promises';
const native = { agentId: 'main', sessionKey: 'agent:main:household:direct:11111111-1111-4111-8111-111111111111' };
const event = { toolName: 'tool_call', params: { id: 'openclaw:core:web_fetch' }, toolCallId: 'real-call',
  runId: 'resp_22222222-2222-4222-8222-222222222222' };
function setup(answers) {
  let hook; const bodies = [];
  registerNativeReadBudget({ pluginConfig: { agentxUrl: 'http://core.test', conversationWorkAgentId: 'worker',
    conversationWorkToken: 'private-synthetic-token' }, on(name, fn) { assert.equal(name, 'before_tool_call'); hook = fn; } },
  { fetchImpl: async (_, options) => {
    bodies.push(JSON.parse(options.body)); const answer = answers.shift();
    return { ok: answer.status === 200, status: answer.status, json: async () => answer.status === 200
      ? { ok: true, data: { authority: 'core.conversation-works', admitted: answer.admitted } } : { ok: false } };
  } });
  return { hook, bodies };
}
test('native wrapper identity admits and blocks through Core without exposing a new model tool', async () => {
  const h = setup([{ status: 200, admitted: true }, { status: 200, admitted: false }]);
  assert.equal(await h.hook(event, native), undefined);
  assert.deepEqual(h.bodies[0], { operation: 'native_budget', context: { ...native, runId: event.runId }, input: { tool: 'web_fetch' }, callId: 'real-call' });
  const blocked = await h.hook({ ...event, toolName: 'web_search', toolCallId: 'second' }, native);
  assert.equal(blocked.block, true); assert.match(blocked.blockReason, /Finish now/);
  assert.equal(h.bodies[1].input.tool, 'web_search');
});
test('ordinary guardian runs cache the absence of a budget and preserve native tools', async () => {
  const h = setup([{ status: 404 }]);
  assert.equal(await h.hook(event, native), undefined);
  assert.equal(await h.hook({ ...event, toolCallId: 'next' }, native), undefined);
  assert.equal(h.bodies.length, 1);
  assert.equal(await h.hook(event, { ...native, agentId: 'secretary' }), undefined);
  assert.equal(await h.hook(event, { ...native, sessionKey: 'agent:main:telegram:direct:owner' }), undefined);
  assert.equal(h.bodies.length, 1);
});
test('a known bounded run fails closed when its Core admission disappears', async () => {
  const h = setup([{ status: 200, admitted: true }, { status: 404 }]);
  await h.hook(event, native);
  assert.equal((await h.hook({ ...event, toolCallId: 'next' }, native)).block, true);
});
test('the budget hook is packaged and remains absent without the private work binding', async () => {
  const pack = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.ok(pack.files.includes('native-read-budget.js'));
  registerNativeReadBudget({ pluginConfig: {}, on() { assert.fail('Inactive hook'); } });
});
