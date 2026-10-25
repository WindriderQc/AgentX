import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerIss } from '../iss.js';

const SESSION = '11111111-1111-1111-1111-111111111111';
const owner = { agentId: 'main', sessionKey: `agent:main:household:direct:${SESSION}` };
const family = { agentId: 'family', sessionKey: `agent:family:household:direct:${SESSION}` };
const config = { agents: { list: [{ id: 'main' }, { id: 'family' }] } };

function setup(respond = () => assert.fail('must not call AgentX')) {
  let factory; let options; const calls = [];
  const api = { config, pluginConfig: { agentxUrl: 'http://core.test:3180' }, registerTool(f, o) { factory = f; options = o; } };
  registerIss(api, { fetchImpl: async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return respond(); } });
  return { factory, options, calls };
}

const result = { status: 'ok', tle: { epoch: '2026-10-24T05:01:11.149Z', stale: false }, nextVisible: { startLocal: 'dim. 25 oct., 05 h 16' }, passes: [] };
const mcp = (structuredContent, isError = false) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'nestor-read',
  result: { isError, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] } }), { status: 200 });

test('nestor_iss is an optional tool declared in the manifest and package', async () => {
  const { options } = setup();
  assert.deepEqual(options, { name: 'nestor_iss', optional: true });
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  const pack = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contracts.tools.includes('nestor_iss'));
  assert.deepEqual(manifest.toolMetadata.nestor_iss, { optional: true });
  assert.ok(pack.files.includes('iss.js'));
});

test('offered to the owner and household family sessions only', () => {
  const { factory } = setup();
  assert.ok(factory(owner));
  assert.ok(factory(family));
  assert.equal(factory({ ...family, sandboxed: true }), null);
  assert.equal(factory({ agentId: 'stranger', sessionKey: `agent:stranger:household:direct:${SESSION}` }), null);
  assert.equal(factory({ agentId: 'main', sessionKey: 'agent:main:cron:briefing' }), null);
  assert.equal(factory({ agentId: 'main', sessionKey: `agent:main:subagent:${SESSION}` }), null);
  assert.equal(factory({ ...owner, sandboxed: true }), null);
  assert.equal(factory({ agentId: 'main', sessionKey: 'agent:main:telegram:group:-100000000' }), null);
  assert.equal(factory({ agentId: 'main', sessionKey: family.sessionKey }), null);
});

test('relays only the bounded arguments to Core iss_passes and returns its dated result', async () => {
  const { factory, calls } = setup(() => mcp(result));
  const out = await factory(family).execute('call-1', { hours: 24, visible_only: true, lat: 1 });
  assert.equal(calls[0].url, 'http://core.test:3180/mcp');
  assert.deepEqual(calls[0].body.params, { name: 'iss_passes', arguments: { hours: 24, visible_only: true } });
  assert.equal(out.details.nextVisible.startLocal, 'dim. 25 oct., 05 h 16');
});

test('a Core refusal is reported as unavailable, not as passes', async () => {
  const { factory } = setup(() => mcp({ error: 'ISS_DATA_UNAVAILABLE', message: 'Data holds no ISS orbital elements' }, true));
  await assert.rejects(factory(owner).execute('call-2', {}), /AgentX source unavailable/);
});
