'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { materialize } = require('../materialize-openclaw-catalog');

async function installation(t, extension) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-openclaw-catalog-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('benchmark-openclaw-catalog-'));
    return rm(root, { recursive: true, force: true });
  });
  const dist = path.join(root, 'dist');
  await mkdir(dist);
  const openclaw = path.join(root, 'openclaw.mjs');
  await writeFile(openclaw, '// fixture entry\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version: '2026.9.4' }));
  await writeFile(path.join(dist, `agent-exec-fixture.${extension}`), '// fixture agent exec\n');
  await writeFile(path.join(dist, `core-coding-tools-fixture.${extension}`),
    'export function t() { return ["read", "write", "edit"].map(name => ({ name, parameters: { type: "object", properties: { path: { type: "string" } } } })); }\n');
  const profilePath = path.join(root, 'instance-profile.json');
  await writeFile(profilePath, await readFile(path.join(__dirname, '../profiles/openclaw-native-v1.example.json')));
  return { root, dist, openclaw, profilePath, output: path.join(root, 'targets.json') };
}

test('requires an explicit instance profile before inspecting any native installation', async () => {
  await assert.rejects(materialize({ openclaw: '/not-inspected', output: '/not-written' }), /Explicit absolute/);
});

for (const extension of ['js', 'mjs']) {
  test(`materializes and pins installed OpenClaw ${extension} modules`, async (t) => {
    const fixture = await installation(t, extension);
    await materialize(fixture);
    const catalog = JSON.parse(await readFile(fixture.output, 'utf8'));
    const { target, executor } = catalog.targets[0];
    assert.equal(target.harness.version, '2026.9.4');
    assert.deepEqual(target.nativePolicy.tools.map(tool => tool.name).sort(), ['edit', 'read', 'write']);
    for (const name of ['openclaw-agent-exec', 'openclaw-coding-tools']) {
      const pin = executor.pins.runtime.find(entry => entry.name === name);
      assert.ok(pin.path.endsWith(`.${extension}`));
      assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    }
  });
}

test('rejects ambiguous installations with both js and mjs coding modules', async (t) => {
  const fixture = await installation(t, 'js');
  await writeFile(path.join(fixture.dist, 'core-coding-tools-other.mjs'), 'export function t() {}\n');
  await assert.rejects(materialize(fixture), /exactly one core-coding-tools-/);
});

test('adds a named subscription agent without replacing the local target or copying auth', async (t) => {
  const fixture = await installation(t, 'mjs');
  const profilePath = path.join(fixture.root, 'cloudx.json');
  const profile = {
    models: { providers: { openai: { api: 'openai-completions', models: [
      { id: 'sol', name: 'Sol', api: 'openai-chatgpt-responses', contextWindow: 100000 }
    ] } } },
    agents: { defaults: { systemAgent: { agentId: 'cloudx' } }, entries: {
      cloudx: { agentDir: '/private/cloudx/agent', model: { primary: 'openai/sol', fallbacks: [] } }
    } },
    tools: { allow: ['read', 'write', 'edit'] }
  };
  await writeFile(profilePath, JSON.stringify(profile));
  await materialize({ ...fixture, additionalProfilePaths: [profilePath] });
  const catalog = JSON.parse(await readFile(fixture.output, 'utf8'));
  assert.deepEqual(catalog.targets.map(entry => entry.target.id), ['openclaw-local', 'openclaw-cloudx']);
  const { target, executor } = catalog.targets[1];
  assert.equal(target.provider, 'openai');
  assert.equal(target.model, 'sol');
  assert.equal(target.tier, 'free_cloud');
  assert.match(target.pricing.source, /subscription-included-usage/);
  assert.equal(target.profile.id, 'openclaw-cloudx');
  assert.deepEqual(target.nativePolicy.networkDestinations, ['openai']);
  assert.equal(executor.args.at(-1), profilePath);
  assert.ok(Date.parse(catalog.catalog.expiresAt) > Date.parse(catalog.catalog.observedAt));
  assert.ok(!JSON.stringify(catalog).includes('/private/cloudx/agent'));
  profile.models.providers.openai.models[0].api = 'openai-responses';
  await writeFile(profilePath, JSON.stringify(profile));
  await assert.rejects(materialize({ ...fixture, additionalProfilePaths: [profilePath], nativeCatalogue: { runtimeVersion: '2026.9.4', models: [] } }), /billing evidence/);
});


test('native catalogue supports general cloud agents and keeps unbounded paid agents unavailable', async t => {
  const fixture = await installation(t, 'mjs');
  const profilePath = path.join(fixture.root, 'cloud.json');
  const profile = { models: { providers: { openrouter: { api: 'openai-completions', models: [
    { id: 'vendor/model', name: 'Cloud', contextWindow: 8192 }
  ] } } }, agents: { defaults: { systemAgent: { agentId: 'cloud' } }, entries: {
    cloud: { model: { primary: 'openrouter/vendor/model', fallbacks: [] } }
  } }, tools: { allow: ['read'] } };
  await writeFile(profilePath, JSON.stringify(profile));
  for (const kind of ['free', 'paid']) {
    const nativeCatalogue = { runtimeVersion: '2026.9.4', observedAt: new Date().toISOString(), models: [
      { model: 'openrouter/vendor/model', billing: { kind, source: 'native-catalog',
        rates: { input: kind === 'paid' ? 1 : 0, output: kind === 'paid' ? 2 : 0, cacheRead: 0, cacheWrite: 0 } } }
    ] };
    await materialize({ ...fixture, additionalProfilePaths: [profilePath], nativeCatalogue });
    const target = JSON.parse(await readFile(fixture.output)).targets[1].target;
    assert.equal(target.provider, 'openrouter'); assert.equal(target.billing, kind);
    assert.equal(target.mode, 'native_agent'); assert.equal(target.modelVersion, 'unknown');
    assert.equal(target.capabilities.judge, false); assert.equal(target.available, kind !== 'paid');
  }
});
