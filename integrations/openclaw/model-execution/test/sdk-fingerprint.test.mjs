import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { googleSdkFingerprint } from '../sdk-fingerprint.mjs';
import { qualifiedModelApi } from '../native.mjs';

test('native transport fingerprint changes with dependency code at the same version and fails closed on missing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentx-google-sdk-'));
  try {
    for (const path of ['', 'node_modules/@openclaw/ai', 'node_modules/@google/genai']) {
      await mkdir(join(root, path, 'dist', 'node'), { recursive: true });
      await writeFile(join(root, path, 'package.json'), JSON.stringify({ version: '2026.9.4' }));
      await writeFile(join(root, path, 'dist', 'node', 'index.mjs'), 'export const attempts = 1;');
    }
    const before = await googleSdkFingerprint(root);
    await writeFile(join(root, 'node_modules/@google/genai/dist/node/index.mjs'), 'export const attempts = 5;');
    const changedDependency = await googleSdkFingerprint(root);
    assert.notEqual(changedDependency, before);
    assert.equal(qualifiedModelApi('2026.9.4', 'google-generative-ai', changedDependency), null);
    await writeFile(join(root, 'dist/node/index.mjs'), 'export const context = "added";');
    assert.notEqual(await googleSdkFingerprint(root), changedDependency);
    await rm(join(root, 'node_modules/@openclaw/ai/dist'), { recursive: true });
    await assert.rejects(googleSdkFingerprint(root), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
