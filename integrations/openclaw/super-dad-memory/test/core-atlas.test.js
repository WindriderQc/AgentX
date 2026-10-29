import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreAtlasClient, registerLifeAtlas } from '../core-atlas.js';

const config = { channels: { telegram: { allowFrom: ['12345'] } } };
const ok = data => ({ ok: true, json: async () => ({ status: 'success', data: { authority: 'agentx.core', ...data } }) });

test('life_atlas sends only known fields to the Nestor history route and checks the Core receipt', async () => {
  let captured;
  const client = createCoreAtlasClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (url, options) => {
    captured = { url: String(url), options }; return ok({ created: true, proposal: { id: 'p1', state: 'pending' } });
  } });
  const answer = await client({ operation: 'propose', entryId: 'a'.repeat(24), changes: { place: 'Synthetic town' },
    rationale: 'Said in conversation', evidence: [{ quote: 'we lived in Synthetic town' }], role: 'admin' });
  assert.equal(answer.proposal.state, 'pending');
  assert.equal(captured.url, 'http://127.0.0.1:3180/api/consumers/nestor/v1/memory/history');
  assert.equal(captured.options.redirect, 'error');
  assert.deepEqual(Object.keys(JSON.parse(captured.options.body)).sort(), ['changes', 'entryId', 'evidence', 'operation', 'rationale']);
  await assert.rejects(client({ operation: 'accept' }), /Choose search, get, propose, status/);
  const refused = createCoreAtlasClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async () => ({ ok: false, status: 409,
    json: async () => ({ status: 'error', message: 'The proposal changes nothing' }) }) });
  await assert.rejects(refused({ operation: 'propose' }), /changes nothing/);
  const foreign = createCoreAtlasClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async () => ({ ok: true,
    json: async () => ({ status: 'success', data: { authority: 'openclaw' } }) }) });
  await assert.rejects(foreign({ operation: 'status' }), /receipt is invalid/);
});

test('only the private owner context receives life_atlas, and a proposal carries its conversation', async () => {
  let factory, options, sent;
  registerLifeAtlas({ config, pluginConfig: { agentxUrl: 'http://core.test' }, registerTool(value, opts) { factory = value; options = opts; } },
    { fetchImpl: async (_url, request) => { sent = JSON.parse(request.body); return ok({ moments: [] }); } });
  assert.deepEqual(options, { name: 'life_atlas', optional: true });
  assert.equal(factory({ agentId: 'family', sessionKey: 'agent:family:telegram:direct:1' }), null);
  assert.equal(factory({ agentId: 'main', sandboxed: true, sessionKey: 'agent:main:telegram:direct:1' }), null);
  const tool = factory({ agentId: 'main', sessionKey: 'agent:main:telegram:direct:12345' });
  assert.equal(tool.name, 'life_atlas');
  assert.match(tool.description, /never changes the memory by itself/);
  await tool.execute('call', { operation: 'search', query: 'move' });
  assert.deepEqual(sent, { operation: 'search', query: 'move' });
  await tool.execute('call', { operation: 'propose', entryId: 'a'.repeat(24), changes: { place: 'x' }, rationale: 'r' });
  assert.equal(sent.conversationRef, 'agent:main:telegram:direct:12345');
});
