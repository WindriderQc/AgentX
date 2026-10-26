import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClientPlugin, normalizePipelineUrl } from '../src/client.mjs';
import { buildPackage, pipelineUrlForCore } from '../scripts/package.mjs';

const url = 'https://agentx.example/pipeline#pipelineWorkerMonitor';
const React = { createElement: (type, props, ...children) => ({ type, props, children }) };

test('opens only the configured HTTPS worker monitor, without embedded credentials', () => {
  assert.equal(pipelineUrlForCore('https://agentx.example:3443/'),
    'https://agentx.example:3443/pipeline#pipelineWorkerMonitor');
  for (const invalid of ['http://agentx.example', 'https://user:secret@agentx.example',
    'https://agentx.example?token=secret', 'https://agentx.example/#token',
    'https://agentx.example/other', ' https://agentx.example', 'https://agentx.example\n']) {
    assert.throws(() => pipelineUrlForCore(invalid));
  }
  for (const invalid of ['javascript:alert(1)', url + '?token=secret',
    'https://agentx.example/pipeline#other', 'https://agentx.example/other#pipelineWorkerMonitor']) {
    assert.throws(() => normalizePipelineUrl(invalid));
  }
});

function register(plugin, selectedSlot = 'sidebar.footer.action') {
  let definition;
  let component;
  let attach;
  let removed = false;
  const cleanup = () => { removed = true; };
  plugin.apply({ effect() {}, slots: {
    inject(slot, callback) {
      if (slot === selectedSlot) attach = callback;
    },
    register(specification, render) {
      definition = specification;
      component = render;
      return cleanup;
    },
  } });
  assert.equal(component, undefined, 'registration waits for the native sidebar slot');
  const dispose = attach();
  return { definition, component, dispose, removed: () => removed };
}

test('built artifact is a lazy native client factory with native transport and no embedded task board', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentx-dsh-link-test-'));
  try {
    const output = await buildPackage({ coreUrl: 'https://agentx.example', output: join(root, 'package') });
    const manifest = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'));
    assert.equal(manifest.dsh.client.platform, 'web');
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(manifest.dependencies, undefined, 'the runtime supplies all peers');
    assert.equal(manifest.private, true, 'instance artifacts cannot be published to npm');
    let registration;
    const sandbox = { URL, window: { __ModuleLoader__: { load: (value) => { registration = value; } } } };
    vm.runInNewContext(await readFile(join(output, 'lib/client.js'), 'utf8'), sandbox);
    assert.equal(registration.id, manifest.name);
    let requests = [];
    const plugin = registration.factory((name) => {
      requests.push(name);
      assert.equal(name, 'react');
      return React;
    });
    assert.deepEqual(requests, ['react']);
    assert.equal(register(plugin).definition.id, 'agentx-coding-team');
    assert.ok((await readFile(join(output, 'lib/index.js'), 'utf8')).includes("./bridge.js"));
    assert.ok((await readFile(join(output, 'lib/bridge.js'), 'utf8')).includes('buildForkSeed'));
    assert.ok(!(await readFile(join(output, 'lib/client.js'), 'utf8')).includes('iframe'));
    await assert.rejects(buildPackage({ coreUrl: 'https://agentx.example', output }), /EEXIST/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generated instance URL cannot enter the repository through a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentx-dsh-link-symlink-'));
  try {
    const source = new URL('../', import.meta.url).pathname;
    await symlink(source, join(root, 'inside'));
    await assert.rejects(buildPackage({ coreUrl: 'https://agentx.example', output: join(root, 'inside', 'generated') }), /outside/);
    const repository = new URL('../../../', new URL('../', import.meta.url)).pathname;
    await assert.rejects(buildPackage({ coreUrl: 'https://agentx.example', output: join(repository, '..private-package') }), /outside/);
    await assert.rejects(buildPackage({ coreUrl: 'https://agentx.example', output: 'relative-package' }), /absolute/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
