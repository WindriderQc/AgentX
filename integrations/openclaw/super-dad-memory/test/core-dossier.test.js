import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerDossier } from '../core-dossier.js';

function setup(fetchImpl) {
  let factory;
  registerDossier({ config: {}, pluginConfig: { agentxUrl: 'http://core.invalid' }, registerTool(value) { factory = value; } }, { fetchImpl });
  return factory;
}
const owner = { agentId: 'main', sessionKey: 'agent:main:household:direct:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };

test('the native dossier adapter stays exclusive to the private owner context', () => {
  const factory = setup(() => assert.fail('must not contact Core'));
  assert.equal(factory({ agentId: 'family', sessionKey: owner.sessionKey }), null);
  assert.equal(factory({ ...owner, sandboxed: true }), null);
  assert.equal(factory({ ...owner, sessionKey: 'agent:main:telegram:group:123' }), null);
  assert.equal(factory(owner).name, 'personal_task_dossier');
});

test('the registered owner tool is declared in the native contract, optional metadata and package', async () => {
  let options, factory;
  registerDossier({ config: {}, registerTool(value, declaration) { factory = value; options = declaration; } },
    { fetchImpl: () => assert.fail('Discovery must not invoke Core') });
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  const pack = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(options.name, factory(owner).name);
  assert.equal(options.optional, true);
  assert.ok(manifest.contracts.tools.includes(options.name), 'OpenClaw rejects registered tools absent from contracts.tools');
  assert.deepEqual(manifest.toolMetadata[options.name], { optional: true });
  assert.ok(pack.files.includes('core-dossier.js'));
  assert.equal(manifest.version, pack.version);
});

test('native Local forwards the Core request and preserves the same structured owner receipt as Hermes', async () => {
  const request = { action: 'propose', id: 'a'.repeat(24), proposal: { state: 'uncertain', action: 'keep' } };
  const receipt = { id: request.id, proposal: request.proposal, coverage: { mail: 'unavailable' } };
  const factory = setup(async (url, options) => {
    assert.equal(String(url), 'http://core.invalid/api/consumers/nestor/v1/mcp');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body).params, { name: 'personal_task_dossier', arguments: request });
    return { ok: true, json: async () => ({ result: { structuredContent: receipt } }) };
  });
  assert.deepEqual((await factory(owner).execute('native-call', { request })).details, receipt);
});

test('a Core refusal remains a refusal and never triggers another request', async () => {
  let calls = 0;
  const factory = setup(async () => { calls++; return { ok: true, json: async () => ({ result: { isError: true,
    structuredContent: { error: 'PERSONAL_DOSSIER_EVIDENCE_REQUIRED', message: 'Read a dated source.' } } }) }; });
  await assert.rejects(() => factory(owner).execute('native-call', { request: { action: 'propose' } }), { code: 'PERSONAL_DOSSIER_EVIDENCE_REQUIRED' });
  assert.equal(calls, 1);
});
