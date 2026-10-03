import test from 'node:test';
import assert from 'node:assert/strict';
import { registerLocalImages, imageActionKey } from '../local-images.js';
const context = { agentId: 'main', runId: 'synthetic-run', sessionKey: 'agent:main:household:direct:11111111-1111-1111-1111-111111111111' };
test('native image action identity separates calls and retains retries', () => {
  assert.equal(imageActionKey(context, 'call-1'), imageActionKey(context, 'call-1'));
  assert.notEqual(imageActionKey(context, 'call-1'), imageActionKey(context, 'call-2'));
  assert.notEqual(imageActionKey(context, 'call-1'), imageActionKey({ ...context, runId: 'another-run' }, 'call-1'));
  assert.throws(() => imageActionKey({}, 'call-1'));
});
test('only the private owner receives the image tool; create relays a bounded operation', async () => {
  let factory, options;
  const api = { config: {}, pluginConfig: { agentxUrl: 'http://127.0.0.1:3180' },
    registerTool(f, o) { factory = f; options = o; } };
  let captured;
  registerLocalImages(api, { fetchImpl: async (url, request) => {
    captured = { url: String(url), body: JSON.parse(request.body) };
    return { ok: true, json: async () => ({ ok: true, operation: { id: 'image-1', state: 'accepted' } }) };
  } });
  assert.equal(options.name, 'local_image');
  assert.equal(factory({ ...context, agentId: 'kidx' }), null);
  assert.equal(factory({ ...context, sandboxed: true }), null);
  const tool = factory(context);
  const result = await tool.execute('call-1', { action: 'create', prompt: 'A lake', width: 1024 });
  assert.equal(captured.url, 'http://127.0.0.1:3180/api/images/operations');
  assert.equal(captured.body.actionKey, imageActionKey(context, 'call-1'));
  assert.equal(result.details.operation.state, 'accepted');
  assert.equal(result.details.studioPath, '/images?operation=image-1');
  assert.match(tool.description, /end this agent turn/);
});

test('SDK tool context without runId uses the native before-tool hook and preserves session identity', async () => {
  let factory; const hooks = {}; const identities = [];
  const api = { config: {}, pluginConfig: { agentxUrl: 'http://127.0.0.1:3180' },
    registerTool(f) { factory = f; }, on(name, handler) { hooks[name] = handler; } };
  registerLocalImages(api, { fetchImpl: async (_url, request) => {
    identities.push(JSON.parse(request.body).actionKey);
    return { ok: true, json: async () => ({ ok: true, operation: { id: 'image-1', state: 'accepted' } }) };
  } });
  const native = { ...context, sessionId: 'session-1' }; delete native.runId;
  const tool = factory(native);
  await assert.rejects(tool.execute('call-1', { action: 'create', prompt: 'A lake' }), /identities/);
  for (const runId of ['run-first', 'run-next']) {
    hooks.before_tool_call({ toolName: 'local_image', toolCallId: 'call-1', runId }, { sessionKey: native.sessionKey });
    await tool.execute('call-1', { action: 'create', prompt: 'A lake' });
    assert.equal(identities.at(-1), imageActionKey({ ...native, runId }, 'call-1'));
    hooks.after_tool_call({ toolName: 'local_image', toolCallId: 'call-1' }, { sessionKey: native.sessionKey });
  }
  assert.notEqual(identities[0], identities[1]);
});
