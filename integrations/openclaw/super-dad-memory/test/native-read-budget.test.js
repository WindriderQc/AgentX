import test from 'node:test';
import assert from 'node:assert/strict';
import { registerNativeReadBudget } from '../native-read-budget.js';
import { readFile } from 'node:fs/promises';
const native = { agentId: 'main', sessionKey: 'agent:main:household:direct:11111111-1111-4111-8111-111111111111' };
const event = { toolName: 'web_fetch', params: { url: 'https://synthetic.test/source' }, toolCallId: 'real-call',
  runId: 'resp_22222222-2222-4222-8222-222222222222' };
function setup(answers, policy = { allowConversationAccess: true }) {
  const hooks = new Map();
  const bodies = [];
  const advertised = registerNativeReadBudget({ config: { plugins: { entries: { 'super-dad-memory': { hooks: policy } } } }, pluginConfig: { agentxUrl: 'http://core.test', conversationWorkAgentId: 'worker',
    conversationWorkToken: 'private-synthetic-token' }, on(name, fn) { hooks.set(name, fn); } },
  { fetchImpl: async (_, options) => {
    bodies.push(JSON.parse(options.body)); const answer = answers.shift();
    return { ok: answer.status === 200, status: answer.status, json: async () => answer.status === 200
      ? { ok: true, data: { authority: 'core.conversation-works', admitted: answer.admitted } } : { ok: false } };
  } });
  return { hook: hooks.get('before_tool_call'), prepare: hooks.get('before_prompt_build'), advertised, bodies };
}
test('only an isolated Main translation replaces the native messaging prompt and removes tools', () => {
  const h = setup([]);
  const translation = { ...native, sessionKey: native.sessionKey.replace(':direct:', ':translation:') };
  assert.equal(h.advertised, true);
  const result = h.prepare({}, translation);
  assert.match(result.systemPrompt, /Translate the words inside the quotation/);
  assert.deepEqual(result.toolsAllow, []);
  assert.equal(h.prepare({}, native), undefined);
  assert.equal(h.prepare({}, { ...translation, agentId: 'secretary' }), undefined);
  assert.deepEqual(h.bodies, []);
  for (const policy of [{}, { allowConversationAccess: false }, { allowConversationAccess: true, allowPromptInjection: false }]) {
    const restricted = setup([], policy);
    assert.equal(restricted.advertised, false);
    assert.equal(restricted.prepare, undefined);
    assert.equal(typeof restricted.hook, 'function');
  }
});
test('resolved native tool identity admits and blocks through Core without exposing a new model tool', async () => {
  const h = setup([{ status: 200, admitted: true }, { status: 200, admitted: false }]);
  assert.equal(await h.hook(event, native), undefined);
  assert.deepEqual(h.bodies[0], { operation: 'native_budget', context: { ...native, runId: event.runId }, input: { tool: 'web_fetch' }, callId: 'real-call' });
  const blocked = await h.hook({ ...event, toolName: 'web_search', toolCallId: 'second' }, native);
  assert.equal(blocked.block, true); assert.match(blocked.blockReason, /Finish now/);
  assert.equal(h.bodies[1].input.tool, 'web_search');
});
test('an isolated translation blocks every tool including deferred dispatch before Core or another agent is called', async () => {
  const h = setup([]);
  const context = { ...native, sessionKey: native.sessionKey.replace(':direct:', ':translation:') };
  for (const toolName of ['sessions_spawn', 'conversation_work', 'tool_call', 'personal_memory', 'web_fetch']) {
    assert.equal((await h.hook({ toolName }, context)).block, true);
  }
  assert.deepEqual(h.bodies, []);
});
test('a deferred dispatch and its resolved execution consume one admission, and denial fences the execution', async () => {
  const h = setup([{ status: 200, admitted: true }, { status: 200, admitted: false }]);
  const dispatch = { ...event, toolName: 'tool_call', params: { id: 'openclaw:core:web_fetch', args: event.params }, toolCallId: 'dispatch-call' };
  assert.equal(await h.hook(dispatch, native), undefined);
  assert.equal(h.bodies.length, 0, 'Dispatch alone is not research');
  assert.equal(await h.hook(event, native), undefined);
  assert.equal(h.bodies.length, 1);
  assert.equal(h.bodies[0].callId, 'real-call');
  assert.equal(await h.hook({ ...dispatch, toolCallId: 'next-dispatch' }, native), undefined);
  const blocked = await h.hook({ ...event, toolCallId: 'next-execution' }, native);
  assert.equal(blocked.block, true);
  assert.equal(h.bodies.length, 2, 'The actual next execution still requires Core admission');
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
