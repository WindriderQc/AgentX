import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCoreSourcesClient, registerSources, familySourceContext } from '../core-sources.js';

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

test('owner tools preserve their private context gates and manifest registration', async () => {
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

test('native family and Reader use only the fixed household transport and reduced schema', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { agentIdFor, sessionKeyFor } = require('../../../../core/surfaces/household/conversation-agent');
  const factories = [], seen = [];
  registerSources({ config: {}, pluginConfig: { agentxUrl: 'http://core.invalid' },
    registerTool(factory) { factories.push(factory); }
  }, { fetchImpl: async (url, options) => {
    seen.push([String(url), options]);
    return reply({ ...data(options.method === 'POST'), audience: 'household',
      ...(options.method === 'POST' ? { source: 'weather' } : {}) });
  } });
  for (const packId of ['kidx_nestor', 'kidx_reader']) {
    const session = { packId, sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
    const context = { agentId: agentIdFor(session), sessionKey: sessionKeyFor(session) };
    assert.equal(familySourceContext(context), true);
    for (const factory of factories) {
      const tool = factory(context), reading = tool.name === 'source_read';
      if (reading) assert.deepEqual(tool.parameters.properties.source.enum, ['weather', 'agentx']);
      const result = await tool.execute('fixture', reading ? { source: 'weather' } : {});
      assert.equal(result.details.audience, 'household');
    }
  }
  assert.deepEqual(seen.map(row => row[0]), [
    'http://core.invalid/api/family/sources', 'http://core.invalid/api/family/sources/read',
    'http://core.invalid/api/family/sources', 'http://core.invalid/api/family/sources/read'
  ]);
  for (const [, options] of seen) assert.equal(options.redirect, 'error');
  for (const context of [
    { agentId: 'family', sessionKey: owner.sessionKey },
    { agentId: 'main', sessionKey: owner.sessionKey.replace('main', 'family') },
    { agentId: 'family', sessionKey: owner.sessionKey.replace('main', 'family'), sandboxed: true },
    { agentId: 'family', sessionKey: 'agent:family:cron:brief' },
    { agentId: 'family', sessionKey: owner.sessionKey.replace('main', 'family') + ':subagent' }
  ]) for (const factory of factories) assert.equal(factory(context), null);
});
test('family client refuses private source, injected fields and owner receipts without fallback', async () => {
  let calls = 0;
  const client = createCoreSourcesClient({ baseUrl: 'http://core.invalid', family: true,
    fetchImpl: async () => { calls++; return reply(data(true)); } });
  for (const input of [{ source: null }, { source: '__proto__' }, { source: 'secretary' }, { source: 'comptable' },
    { source: 'weather', audience: 'owner' }, JSON.parse('{"source":"weather","__proto__":{}}')]) {
    await assert.rejects(client.read(input), /Invalid family source/);
  }
  assert.equal(calls, 0);
  await assert.rejects(client.read({ source: 'weather' }), /receipt is invalid/);
  assert.equal(calls, 1);
  const invalidCatalogue = createCoreSourcesClient({ baseUrl: 'http://core.invalid', family: true,
    fetchImpl: async () => reply({ ...data(), audience: 'household', sources: [{ source: 'secretary' }] }) });
  await assert.rejects(invalidCatalogue.catalogue(), /receipt is invalid/);
});

test('family SOURCE_CHANGED is recoverable and never falls back to an owner route', async () => {
  const seen = [];
  const client = createCoreSourcesClient({ baseUrl: 'http://core.invalid', family: true,
    fetchImpl: async (url, options) => {
      seen.push(String(url));
      const input = JSON.parse(options.body);
      if (input.expectedHash) return { ok: false, status: 409,
        json: async () => ({ code: 'SOURCE_CHANGED', message: 'Restart at offset zero without expectedHash' }) };
      return reply({ ...data(true), audience: 'household', source: 'weather' });
    } });
  await assert.rejects(client.read({ source: 'weather', offset: 256, expectedHash: 'b'.repeat(64) }), { code: 'SOURCE_CHANGED' });
  assert.equal((await client.read({ source: 'weather', offset: 0 })).audience, 'household');
  assert.deepEqual(seen, Array(2).fill('http://core.invalid/api/family/sources/read'));
});
