import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { googleSdkFingerprint } from '../sdk-fingerprint.mjs';
import { qualifiedModelApi } from '../native.mjs';

async function packageAt(root, path, name) {
  await mkdir(join(root, path, 'dist', 'node'), { recursive: true });
  await writeFile(join(root, path, 'package.json'), JSON.stringify({ name, version: '2026.9.4',
    exports: { '.': './dist/node/index.mjs', './node': './dist/node/index.mjs' } }));
  await writeFile(join(root, path, 'dist', 'node', 'index.mjs'), 'export const attempts = 1;');
}

async function fixture(root) {
  await packageAt(root, '', 'openclaw');
  await packageAt(root, 'node_modules/@openclaw/ai', '@openclaw/ai');
  await packageAt(root, 'node_modules/@google/genai', '@google/genai');
}

test('native transport fingerprint changes with dependency code at the same version and fails closed on missing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentx-google-sdk-'));
  try {
    await fixture(root);
    const before = await googleSdkFingerprint(root);
    await writeFile(join(root, 'node_modules/@google/genai/dist/node/index.mjs'), 'export const attempts = 5;');
    const changedDependency = await googleSdkFingerprint(root);
    assert.notEqual(changedDependency, before);
    assert.equal(qualifiedModelApi('2026.9.4', 'google-generative-ai', changedDependency), null);
    await writeFile(join(root, 'dist/node/index.mjs'), 'export const context = "added";');
    assert.notEqual(await googleSdkFingerprint(root), changedDependency);
    await rm(join(root, 'node_modules/@openclaw/ai/dist'), { recursive: true });
    await assert.rejects(googleSdkFingerprint(root), { code: 'MODULE_NOT_FOUND' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const context of ['node_modules/@openclaw/ai', 'dist']) {
  test(`native qualification refuses a Google dependency shadow resolved from ${context}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentx-google-shadow-'));
    try {
      await fixture(root);
      const before = await googleSdkFingerprint(root);
      assert.match(before, /^[a-f0-9]{64}$/);
      const shadow = `${context}/node_modules/@google/genai`;
      await packageAt(root, shadow, '@google/genai');
      const importer = context === 'dist' ? join(root, 'dist', 'google.mjs') : join(root, context, 'dist', 'google.mjs');
      assert.equal(createRequire(importer).resolve('@google/genai'), join(root, shadow, 'dist', 'node', 'index.mjs'));
      await assert.rejects(googleSdkFingerprint(root), { message: 'OPENCLAW_GOOGLE_DEPENDENCY_TOPOLOGY_UNQUALIFIED' });
      await writeFile(join(root, shadow, 'dist', 'node', 'index.mjs'), 'export const attempts = 5;');
      await assert.rejects(googleSdkFingerprint(root), { message: 'OPENCLAW_GOOGLE_DEPENDENCY_TOPOLOGY_UNQUALIFIED' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
