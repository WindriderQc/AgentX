import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCoreSourcesClient, registerSources } from '../core-sources.js';

const owner = { agentId: 'main', sessionKey: 'agent:main:household:direct:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const data = (reading = false) => ({ authority: 'agentx.core', kind: reading ? 'living_source' : 'living_source_catalogue',
  audience: 'owner', ...(reading ? { source: 'secretary', content: 'page', nextOffset: 256, contentHash: 'a'.repeat(64) } : { sources: [] }) });
const reply = value => ({ ok: true, json: async () => ({ status: 'success', data: value }) });

test('fixed endpoints preserve Core receipts and pagination with no redirects', async () => {
  const seen = [];
  const client = createCoreSourcesClient({ baseUrl: 'http://core.invalid/ignored', fetchImpl: async (url, options) => {
    seen.push([String(url), options]);
    return reply(data(options.method === 'POST'));
  } });
  assert.deepEqual(await client.catalogue(), data());
  const input = { source: 'secretary', section: 'mail', days: 5, limit: 3, recordOffset: 6,
    asOf: '2026-11-10T00:00:00Z', offset: 256, pageChars: 512, expectedHash: 'a'.repeat(64) };
  assert.deepEqual(await client.read({ ...input, url: 'https://evil.invalid', audience: 'household' }), data(true));
  assert.equal(seen[0][0], 'http://core.invalid/api/consumers/nestor/v1/sources');
  assert.equal(seen[0][1].method, 'GET');
  assert.equal(seen[0][1].body, undefined);
  assert.equal(seen[1][0], 'http://core.invalid/api/consumers/nestor/v1/sources/read');
  assert.deepEqual(JSON.parse(seen[1][1].body), input);
  for (const [, options] of seen) {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('wrong authority, audience, kind, source or success envelope is rejected', async () => {
  for (const patch of [{ authority: 'other' }, { audience: 'household' }, { kind: 'team_brief' }, { source: 'comptable' }]) {
    const client = createCoreSourcesClient({ baseUrl: 'http://core.invalid', fetchImpl: async () => reply({ ...data(true), ...patch }) });
    await assert.rejects(client.read({ source: 'secretary' }), /receipt is invalid/);
  }
  for (const value of [undefined, { ...data(), audience: 'household' }, { ...data(), kind: 'living_source' }]) {
    const client = createCoreSourcesClient({ baseUrl: 'http://core.invalid', fetchImpl: async () => reply(value) });
    await assert.rejects(client.catalogue(), /receipt is invalid/);
  }
  const client = createCoreSourcesClient({ baseUrl: 'http://core.invalid', fetchImpl: async () => ({
    ok: true, json: async () => ({ status: 'error', data: data() }) }) });
  await assert.rejects(client.catalogue(), /receipt is invalid/);
});

test('read refusal retains SOURCE_CHANGED and never retries or falls back', async () => {
  let calls = 0;
  const client = createCoreSourcesClient({ baseUrl: 'http://core.invalid', fetchImpl: async () => {
    calls++;
    return { ok: false, status: 409, json: async () => ({ code: 'SOURCE_CHANGED', message: 'Restart the source read' }) };
  } });
  await assert.rejects(client.read({ source: 'secretary' }), { code: 'SOURCE_CHANGED' });
  assert.equal(calls, 1);
  assert.throws(() => createCoreSourcesClient(), /Configure/);
  assert.throws(() => createCoreSourcesClient({ baseUrl: 'file:///tmp/core' }), /HTTP URL/);
});

test('both optional tools are discoverable only in private owner sessions and registered in the manifest', async () => {
  const factories = [];
  registerSources({ config: {}, pluginConfig: { agentxUrl: 'http://core.invalid' },
    registerTool(factory, declaration) { factories.push([factory, declaration]); }
  }, { fetchImpl: async (_url, options) => reply(data(options.method === 'POST')) });
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url)));
  const pack = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  for (const [factory, declaration] of factories) {
    for (const context of [
      { ...owner, agentId: 'family' }, { ...owner, agentId: 'secretary' }, { ...owner, sandboxed: true },
      { ...owner, sessionKey: 'agent:main:cron:briefing' }, { ...owner, sessionKey: 'agent:main:telegram:group:123' },
      { ...owner, sessionKey: owner.sessionKey + ':subagent' }
    ]) assert.equal(factory(context), null);
    const tool = factory(owner);
    assert.deepEqual(declaration, { name: tool.name, optional: true });
    assert.ok(manifest.contracts.tools.includes(tool.name));
    assert.deepEqual(manifest.toolMetadata[tool.name], { optional: true });
    const reading = tool.name === 'source_read';
    assert.deepEqual((await tool.execute('test', reading ? { source: 'secretary' } : {})).details, data(reading));
  }
  assert.ok(pack.files.includes('core-sources.js'));
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /registerSources\(api\)/);
});
