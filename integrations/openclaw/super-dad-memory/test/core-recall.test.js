import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreRecallClient, registerMailRecall } from '../core-recall.js';

const config = { channels: { telegram: { allowFrom: ['12345'] } } };
const result = { kind: 'souvenir', occurredAt: '2016-07-30', people: ['Synthetic Friend'], excerpt: 'Synthetic canoe trip' };

test('mail_recall forwards only the query and checks the Core receipt', async () => {
  let captured;
  const client = createCoreRecallClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, json: async () => ({ status: 'success', data: { authority: 'agentx.core', query: 'lac', results: [result] } }) };
  } });
  assert.deepEqual((await client({ query: 'lac', limit: 3 })).results, [result]);
  assert.equal(captured.url, 'http://127.0.0.1:3180/api/consumers/nestor/v1/memory/recall');
  assert.deepEqual(JSON.parse(captured.options.body), { query: 'lac', limit: 3 });
  assert.equal(captured.options.redirect, 'error');
  const broken = createCoreRecallClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async () => ({ ok: true,
    json: async () => ({ status: 'success', data: { authority: 'openclaw', results: [] } }) }) });
  await assert.rejects(broken({ query: 'lac' }), /receipt is invalid/);
  await assert.rejects(createCoreRecallClient({ baseUrl: 'http://127.0.0.1:3180',
    fetchImpl: async () => ({ ok: false, status: 503 }) })({ query: 'lac' }), /unavailable \(503\)/);
});

test('only the private owner context receives mail_recall', async () => {
  let factory, options;
  registerMailRecall({ config, pluginConfig: { agentxUrl: 'http://core.test' }, registerTool(value, opts) { factory = value; options = opts; } },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'success', data: { authority: 'agentx.core', results: [result] } }) }) });
  assert.deepEqual(options, { name: 'mail_recall', optional: true });
  assert.equal(factory({ agentId: 'family', sessionKey: 'agent:family:telegram:direct:1' }), null);
  assert.equal(factory({ agentId: 'main', sandboxed: true, sessionKey: 'agent:main:telegram:direct:1' }), null);
  const tool = factory({ agentId: 'main', sessionKey: 'agent:main:telegram:direct:12345' });
  assert.equal(tool.name, 'mail_recall');
  assert.deepEqual((await tool.execute('call', { query: 'canoe' })).details.results, [result]);
});
