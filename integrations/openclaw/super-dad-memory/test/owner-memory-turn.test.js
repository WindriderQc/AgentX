import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerOwnerMemoryTurn } from '../owner-memory-turn.js';

const context = { agentId: 'main', sessionKey: 'agent:main:household:direct:11111111-1111-4111-8111-111111111111', runId: 'r1' };
const history = { toolName: 'tool_call', params: { args: { id: 'openclaw:core:sessions_history' } }, runId: 'r1' };

function setup() {
  const hooks = {};
  const requests = [];
  let data;
  registerOwnerMemoryTurn({ pluginConfig: { agentxUrl: 'http://core.test' }, config: {}, on(name, handler) { hooks[name] = handler; } }, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      if (!data) return { ok: false };
      return { ok: true, json: async () => ({ data: { authority: 'agentx.core', schema: 'agentx.owner-memory-turn/v1', operation: 'turn-context', policy: 'Core owns current memory.', ...data } }) };
    }, now: () => 0,
  });
  return { hooks, requests, use(value) { data = value; } };
}

test('fresh Core evidence reaches continued turns and fences native and wrapped history for the same run', async () => {
  const { hooks, requests, use } = setup();
  const input = { prompt: 'Which telescope do I use on the astronomy trip?' };
  use({ protectRecall: true, context: 'Current note: new refractor.' });
  assert.match((await hooks.before_prompt_build(input, context)).prependContext, /new refractor/);
  assert.deepEqual(requests[0], { url: 'http://core.test/api/consumers/nestor/v1/memory/notes', body: { action: 'turn-context', query: input.prompt } });
  assert.equal(hooks.before_tool_call(history, context).block, true);
  assert.equal(hooks.before_tool_call({ toolName: 'personal_memory', params: { includeHistory: true } }, context).block, true);
  assert.equal(hooks.before_tool_call({ toolName: 'personal_memory', params: { action: 'search' } }, context), undefined);
  assert.equal(hooks.before_tool_call({ ...history, runId: 'other' }, context), undefined);
  hooks.agent_end({}, context);
  assert.equal(hooks.before_tool_call(history, context), undefined);
  use({ protectRecall: true, context: 'Current notes: []' });
  assert.match((await hooks.before_prompt_build(input, { ...context, runId: 'r2' })).prependContext, /\[\]/);
  assert.equal(requests.length, 2);
});

test('only verified owner sessions read this policy and unrelated history tools keep their authority', async () => {
  const { hooks, requests, use } = setup();
  const input = { prompt: 'Show the earlier conversation.' };
  use({ protectRecall: false, context: '' });
  for (const rejected of [{ ...context, agentId: 'family' }, { ...context, sandboxed: true }, { ...context, requester: { senderIsOwner: false } }]) {
    assert.equal(await hooks.before_prompt_build(input, rejected), undefined);
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(await hooks.before_prompt_build(input, context), { appendSystemContext: 'Core owns current memory.' });
  assert.equal(hooks.before_tool_call(history, context), undefined);
  use(undefined);
  assert.match((await hooks.before_prompt_build(input, context)).appendSystemContext, /cannot verify/);
});

test('the adapter is part of the native plugin distribution', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.ok(manifest.files.includes('owner-memory-turn.js'));
});
