import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerPresentation } from '../presentation.js';

const owner = { agentId: 'main', sessionKey: 'agent:main:household:direct:11111111-1111-1111-1111-111111111111' };
function setup(fetchImpl) {
  let factory, options;
  registerPresentation({ config: {}, pluginConfig: { agentxUrl: 'http://127.0.0.1:3180' },
    registerTool(fn, opts) { factory = fn; options = opts; } }, { fetchImpl });
  return { factory, options };
}
test('presentation transport is optional, owner-only and packaged', async () => {
  const { factory, options } = setup(async () => assert.fail('no calls'));
  assert.equal(options.optional, true); assert.ok(factory(owner));
  for (const context of [{ ...owner, agentId: 'family' }, { ...owner, sandboxed: true },
    { agentId: 'main', sessionKey: 'agent:main:cron:briefing' }, { agentId: 'main', sessionKey: 'agent:main:telegram:group:-123' }]) assert.equal(factory(context), null);
  const pack = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url)));
  assert.ok(pack.files.includes('presentation.js')); assert.ok(manifest.contracts.tools.includes(options.name));
  assert.deepEqual(manifest.toolMetadata[options.name], { optional: true });
});
test('adapter forwards only the selected reference to Core, returning its exact receipt once', async () => {
  const calls = [], value = { status: 'unavailable', reason: 'expired' };
  const { factory } = setup(async (url, request) => {
    calls.push({ url, body: JSON.parse(request.body) });
    return { ok: true, json: async () => ({ result: { isError: false, structuredContent: value } }) };
  });
  const args = { id: 'view_' + 'a'.repeat(64), revision: 'a'.repeat(64) };
  const result = await factory(owner).execute('call-1', { ...args, url: 'https://bad.test', totals: { calls: 999 } });
  assert.equal(calls.length, 1); assert.match(String(calls[0].url), /\/mcp$/);
  assert.equal(calls[0].body.params.name, 'read_presentation'); assert.deepEqual(calls[0].body.params.arguments, args);
  assert.deepEqual(result.details, value);
});
