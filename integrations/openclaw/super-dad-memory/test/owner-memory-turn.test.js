import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerOwnerMemoryTurn } from '../owner-memory-turn.js';

const config = {
  agents: { entries: { main: { model: { primary: 'fixture/agentx-primary', fallbacks: [] } } } },
  models: { providers: { fixture: { api: 'ollama', baseUrl: 'http://127.0.0.1:3180/api/openclaw-ollama' } } },
};
const context = { modelProviderId: 'fixture', modelId: 'agentx-primary', agentId: 'main', sessionKey: 'agent:main:household:direct:11111111-1111-4111-8111-111111111111', runId: 'r1' };
const history = { toolName: 'tool_call', params: { args: { id: 'openclaw:core:sessions_history' } }, runId: 'r1' };

function setup(settings = config, agentxUrl = 'http://127.0.0.1:3180') {
  const hooks = {};
  const requests = [];
  let data;
  registerOwnerMemoryTurn({ pluginConfig: { agentxUrl }, config: settings, on(name, handler) { hooks[name] = handler; } }, {
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
  assert.match((await hooks.before_prompt_build(input, context)).appendSystemContext, /new refractor/);
  assert.deepEqual(requests[0], { url: 'http://127.0.0.1:3180/api/consumers/nestor/v1/memory/notes', body: { action: 'turn-context', query: input.prompt } });
  assert.equal(hooks.before_tool_call(history, context).block, true);
  assert.equal(hooks.before_tool_call({ toolName: 'personal_memory', params: { includeHistory: true } }, context).block, true);
  assert.equal(hooks.before_tool_call({ toolName: 'personal_memory', params: { action: 'search' } }, context), undefined);
  assert.match(hooks.before_tool_call({ ...history, runId: 'other' }, context).blockReason, /local-only/);
  hooks.agent_end({}, context);
  assert.match(hooks.before_tool_call(history, context).blockReason, /local-only/);
  use({ protectRecall: true, context: 'Current notes: []' });
  assert.match((await hooks.before_prompt_build(input, { ...context, runId: 'r2' })).appendSystemContext, /\[\]/);
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

test('cloud, unknown, overridden and mixed routes never fetch private evidence or permit the linked tool reads', async () => {
  const input = { prompt: 'A synthetic telescope question' };
  for (const [settings, attempt] of [
    [{}, context],
    [config, { ...context, modelId: undefined }],
    [config, { ...context, modelProviderId: 'cloud' }],
    [{ ...config, models: { providers: { fixture: { api: 'ollama', baseUrl: 'https://external.invalid/api/openclaw-ollama' } } } }, context],
    [{ ...config, agents: { entries: { main: { model: { primary: 'fixture/agentx-primary', fallbacks: ['external/remote'] } } } } }, context],
  ]) {
    const { hooks, requests } = setup(settings);
    assert.equal(await hooks.before_prompt_build(input, attempt), undefined);
    for (const name of ['personal_memory', 'source_read', 'memory_search', 'sessions_history']) {
      assert.match(hooks.before_tool_call({ toolName: 'tool_call', params: { id: 'mcp:owner:' + name } }, context).blockReason, /local-only/);
    }
    assert.equal(hooks.before_tool_call({ toolName: 'weather' }, context), undefined);
    assert.equal(requests.length, 0);
  }
});

test('route change on the same run clears the earlier permission and private evidence stays outside the user prompt', async () => {
  const { hooks, requests, use } = setup();
  use({ protectRecall: true, context: 'Synthetic note' });
  const event = { prompt: 'Question' };
  const projection = await hooks.before_prompt_build(event, context);
  assert.equal(projection.prependContext, undefined);
  assert.match(projection.appendSystemContext, /Synthetic note/);
  assert.equal(hooks.before_tool_call({ toolName: 'source_read' }, context), undefined);
  assert.equal(hooks.before_tool_call({ toolName: 'source_read' }, { ...context, requester: { senderIsOwner: false } }).block, true);
  assert.equal(await hooks.before_prompt_build(event, { ...context, modelProviderId: 'external' }), undefined);
  assert.match(hooks.before_tool_call({ toolName: 'source_read' }, context).blockReason, /local-only/);
  assert.equal(requests.length, 1);
});

test('a public or unconfigured Core destination keeps private tools closed', async () => {
  for (const url of ['', 'invalid', 'https://public.invalid', 'https://203.0.113.1', 'http://127.0.0.1@external.invalid']) {
    const { hooks, requests } = setup(config, url);
    assert.equal(await hooks.before_prompt_build({ prompt: 'Which telescope?' }, context), undefined);
    assert.match(hooks.before_tool_call({ toolName: 'personal_memory' }, context).blockReason, /local-only/);
    assert.equal(requests.length, 0);
  }
});

test('the adapter is part of the native plugin distribution', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.ok(manifest.files.includes('owner-memory-turn.js'));
});
