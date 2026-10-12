import test from 'node:test';
import assert from 'node:assert/strict';
import { registerLocalImages, imageActionKey } from '../local-images.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const original = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const native = { agentId: 'main', sessionId: 'native-transcript', sessionKey: `agent:main:household:direct:${sessionId}` };
const runId = 'resp_44444444-4444-4444-8444-444444444444';
function harness({ name = 'local_image', status = 200, shared = false, invalid = false } = {}) {
  let factory; const hooks = {}, requests = [];
  const planImage = async request => { requests.push({ expert: true }); return { request }; };
  const config = { conversationWorkToken: 'synthetic-private-token' };
  registerLocalImages({ pluginConfig: { agentxUrl: 'http://core.test', ...(!shared && config) },
    config: shared ? { plugins: { entries: { 'super-dad-memory': { config } } } } : {},
    registerTool(f) { factory = f; }, on(event, hook) { hooks[event] = hook; } }, {
    name, planImage, fetchImpl: async (url, options) => {
      const body = options?.body && JSON.parse(options.body);
      requests.push({ path: new URL(url).pathname, body, headers: options?.headers });
      if (body?.operation === 'native_owner') return { ok: status === 200, status, json: async () => status === 200
        ? { ok: true, data: { authority: 'core.conversation-works', sessionId: invalid ? 'invalid' : original } }
        : { ok: false, message: 'Owner unavailable' } };
      return { ok: true, json: async () => ({ ok: true, operation: { id: operationId, state: 'accepted' } }) };
    }
  });
  const tool = factory(native);
  const execute = async (id, params) => {
    const event = { toolName: 'tool_call', params: { id: `openclaw:image-tools:${name}` }, toolCallId: id, runId };
    hooks.before_tool_call(event, native);
    try { return await tool.execute(id, params); }
    finally { hooks.after_tool_call(event, native); }
  };
  return { tool, execute, requests };
}

for (const name of ['local_image', 'imagex']) test(`${name} resolves the exact background Main owner before image work`, async () => {
  const h = harness({ name, shared: name === 'imagex' });
  await h.execute('create', { action: 'create', prompt: 'A lake', sessionId: 'model-forgery', runId: 'model-forgery' });
  await h.execute('status', { action: 'status', operationId });
  await h.execute('cancel', { action: 'cancel', operationId });
  const owners = h.requests.filter(r => r.body?.operation === 'native_owner');
  assert.equal(owners.length, 3);
  assert.deepEqual(owners[0].body.context, { agentId: 'main', sessionKey: native.sessionKey, runId });
  assert.equal(owners[0].headers.Authorization, 'Bearer synthetic-private-token');
  const base = `/api/voice-personas/private/sessions/${original}/images`;
  assert.deepEqual(h.requests.filter(r => r.path?.startsWith(base)).map(r => r.path), [base, `${base}/${operationId}`, `${base}/${operationId}/cancel`]);
  const creation = h.requests.find(r => r.path === base);
  assert.equal(creation.body.actionKey, imageActionKey({ ...native, runId }, 'create'));
  assert.equal(creation.body.sessionId, undefined);
  assert.equal(h.requests[0].body.operation, 'native_owner');
  assert.equal(h.tool.parameters.properties.sessionId, undefined);
});

test('ordinary owner turns keep their image route when Core finds no native work binding', async () => {
  const h = harness({ status: 404 });
  await h.execute('create', { action: 'create', prompt: 'A lake' });
  assert.ok(h.requests.some(r => r.path === `/api/voice-personas/private/sessions/${sessionId}/images`));
});

test('unavailable or invalid Core owner stops before image planning or submission', async () => {
  for (const options of [{ status: 503 }, { invalid: true }]) {
    const h = harness(options);
    await assert.rejects(h.execute('create', { action: 'create', prompt: 'A lake' }), /Owner unavailable|Invalid native image owner/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.operation, 'native_owner');
  }
});
