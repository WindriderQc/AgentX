import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { clientSdkFingerprint } from '../client-sdk-fingerprint.mjs';

async function pkg(root, path, name, extra = {}) {
  const base = join(root, path);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, 'package.json'), JSON.stringify({ name, version: '1.0.0', exports: { '.': './index.mjs' }, ...extra }));
  await writeFile(join(base, 'index.mjs'), 'export const attempts = 1;');
  return base;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentx-client-code-'));
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'node_modules/@openclaw/ai/dist'), { recursive: true });
  await pkg(root, 'node_modules/client', 'client', { dependencies: { dependency: '1.0.0' }, peerDependencies: { optional: '*' } });
  await pkg(root, 'node_modules/dependency', 'dependency');
  return root;
}

test('client identity binds dependency bytes, layout, optional peers and the base SDK digest', async () => {
  const root = await fixture();
  try {
    const before = await clientSdkFingerprint(root, 'sdk-code', 'client');
    assert.notEqual(await clientSdkFingerprint(root, 'different-sdk-code', 'client'), before);
    await writeFile(join(root, 'node_modules/dependency/index.mjs'), 'export const attempts = 5;');
    const changed = await clientSdkFingerprint(root, 'sdk-code', 'client'); assert.notEqual(changed, before);
    await pkg(root, 'node_modules/client/node_modules/dependency', 'dependency');
    const nested = await clientSdkFingerprint(root, 'sdk-code', 'client'); assert.notEqual(nested, changed);
    await pkg(root, 'node_modules/optional', 'optional');
    const after = await clientSdkFingerprint(root, 'sdk-code', 'client').catch(error => error);
    if (typeof after === 'string') assert.notEqual(after, nested);
    else assert.equal(after.message, 'OPENCLAW_CLIENT_DEPENDENCY_TOPOLOGY_UNQUALIFIED');
    assert.equal(await clientSdkFingerprint(root, null, 'client'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('client identity refuses a shadow selected by the AI importer', async () => {
  const root = await fixture();
  try {
    await pkg(root, 'node_modules/@openclaw/ai/node_modules/client', 'client');
    assert.match(createRequire(join(root, 'node_modules/@openclaw/ai/dist/importer.mjs')).resolve('client'), /ai\/node_modules\/client/);
    await assert.rejects(clientSdkFingerprint(root, 'sdk-code', 'client'), { message: 'OPENCLAW_CLIENT_DEPENDENCY_TOPOLOGY_UNQUALIFIED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a shadow main-export symlink cannot hide a different Mistral subpath', async () => {
  const root = await fixture();
  try {
    const name = '@mistralai/mistralai';
    const original = await pkg(root, `node_modules/${name}`, name, { exports: { '.': './index.mjs', './lib/http': './http.mjs', './sdk/chat': './chat.mjs' } });
    await writeFile(join(original, 'http.mjs'), 'export const transport = 1;'); await writeFile(join(original, 'chat.mjs'), 'export const transport = 1;');
    const shadow = await pkg(root, `node_modules/@openclaw/ai/node_modules/${name}`, name, { exports: { '.': './main.mjs', './lib/http': './http.mjs', './sdk/chat': './chat.mjs' } });
    await symlink(join(original, 'index.mjs'), join(shadow, 'main.mjs'));
    await writeFile(join(shadow, 'http.mjs'), 'export const transport = 5;'); await writeFile(join(shadow, 'chat.mjs'), 'export const transport = 5;');
    const require = createRequire(join(root, 'node_modules/@openclaw/ai/dist/importer.mjs'));
    assert.equal(require.resolve(name), join(original, 'index.mjs'));
    assert.equal(require.resolve(`${name}/lib/http`), join(shadow, 'http.mjs'));
    await assert.rejects(clientSdkFingerprint(root, 'sdk-code', name), { message: 'OPENCLAW_CLIENT_DEPENDENCY_TOPOLOGY_UNQUALIFIED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
