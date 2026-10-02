'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { placementMatches, expectedStatus } = require('./gpuResidency');
const {
  createOllamaHostConfig,
  parseHostVramMap,
  lookupHostVramMb,
  normalizeRegisteredHost
} = require('./ollamaHostConfig');

const HOST_ENV_KEYS = [
  'OLLAMA_HOST', 'OLLAMA_HOST_1', 'OLLAMA_HOST_PRIMARY', 'OLLAMA_HOST_NAME',
  'OLLAMA_HOST_2', 'OLLAMA_HOST_HEAVY', 'OLLAMA_HOST_SECONDARY',
  'OLLAMA_HOST_3', 'OLLAMA_HOST_TERTIARY', 'OLLAMA_HOST_VRAM_MAP'
];

function withEnv(values, fn) {
  const saved = {};
  for (const key of HOST_ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  Object.assign(process.env, values);
  try { return fn(); } finally {
    for (const key of HOST_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

test('placementMatches truth table', () => {
  const full = { size: 100, size_vram: 100 };
  const cpu = { size: 100, size_vram: 0 };
  const partial = { size: 100, size_vram: 40 };
  const unknown = { size: 100 };
  assert.equal(placementMatches(full, 'gpu'), true);
  assert.equal(placementMatches(cpu, 'gpu'), false);
  assert.equal(placementMatches(partial, 'gpu'), false);
  assert.equal(placementMatches(unknown, 'gpu'), false);
  assert.equal(placementMatches(cpu, 'cpu'), true);
  assert.equal(placementMatches(full, 'cpu'), false, 'a CPU host whose model sits in VRAM still sees a GPU');
  assert.equal(placementMatches(partial, 'cpu'), false);
  assert.equal(placementMatches(unknown, 'cpu'), false);
  assert.equal(placementMatches(full), true, 'residency defaults to gpu');
  assert.equal(expectedStatus('cpu'), 'cpu');
  assert.equal(expectedStatus(undefined), 'full');
});

test('VRAM map keeps two instances of one machine apart by port', () => {
  const map = parseHostVramMap('192.0.2.99=12288,192.0.2.99:11435=1');
  assert.equal(lookupHostVramMb(map, 'http://192.0.2.99:11434'), 12288);
  assert.equal(lookupHostVramMb(map, 'http://192.0.2.99:11435'), 1);
  assert.equal(lookupHostVramMb(map, 'http://192.0.2.99'), 12288);
  assert.equal(lookupHostVramMb(map, 'http://192.0.2.10:11434'), 0);
});

test('registered hosts extend the env bootstrap without a slot limit', () => {
  withEnv({ OLLAMA_HOST: 'http://192.0.2.99:11434', OLLAMA_HOST_2: 'http://192.0.2.199:11434' }, () => {
    const config = createOllamaHostConfig();
    config.setRegisteredHosts([
      { id: 'frank-cpu', name: 'Frank CPU', url: 'http://192.0.2.99:11435', residency: 'cpu', maxInflight: 1 },
      { id: 'alien-cpu', url: '192.0.2.199:11435', residency: 'cpu' },
      { id: 'brutal', url: 'http://192.0.2.12:11434' },
      { id: 'primary', residency: 'gpu', url: 'http://192.0.2.99:11434', name: 'Frank GPU' },
      { id: 'Bad Id', url: 'http://192.0.2.5:11434' }
    ]);
    const hosts = config.getConfiguredHosts();
    assert.deepEqual(hosts.map(h => h.id), ['primary', 'secondary', 'frank-cpu', 'alien-cpu', 'brutal']);
    assert.equal(hosts[0].name, 'Frank GPU', 'a registry entry names an env host');
    assert.equal(hosts[0].source, 'env');
    assert.equal(hosts[2].source, 'registry');
    assert.equal(hosts[2].maxInflight, 1);
    assert.equal(hosts[3].name, 'alien-cpu');
    assert.equal(hosts[3].url, 'http://192.0.2.199:11435');
    assert.equal(config.getHostResidency('http://192.0.2.99:11435'), 'cpu');
    assert.equal(config.getHostResidency('http://192.0.2.99:11434'), 'gpu');
    assert.equal(config.getHostResidency('http://192.0.2.1:11434'), 'gpu');
    assert.equal(config.validateHostUrl('frank-cpu').host, 'http://192.0.2.99:11435');
    assert.equal(config.validateHostUrl('http://192.0.2.199:11435').valid, true);
  });
});

test('registry alone configures the first host when no env slot is set', () => {
  withEnv({}, () => {
    const config = createOllamaHostConfig();
    assert.equal(config.isConfigured(), false);
    config.setRegisteredHosts([{ id: 'home', url: 'http://192.0.2.7:11434' }]);
    assert.deepEqual(config.getConfiguredHosts().map(h => [h.id, h.priority, h.residency]), [['home', 1, 'gpu']]);
  });
});

test('normalizeRegisteredHost rejects unusable entries', () => {
  assert.equal(normalizeRegisteredHost({ id: 'x', url: '' }), null);
  assert.equal(normalizeRegisteredHost({ id: '-x', url: 'http://h:1' }), null);
  assert.equal(normalizeRegisteredHost({ id: 'x', url: 'http://h:1', residency: 'tpu' }).residency, 'gpu');
  assert.equal(normalizeRegisteredHost({ id: 'x', url: 'http://h:1', maxInflight: 0 }).maxInflight, null);
});
