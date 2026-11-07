'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { modelCatalog, resolveGatewayTarget } = require('../llm-gateway/model-catalog');

const task = (model, key, overrides = {}) => ({ model, hostKey: key, hostUrl: `http://${key}.test:11434`,
  contextSize: 32768, pinAligned: true, hostPreference: { displayName: key.toUpperCase() }, ...overrides });

test('catalog keeps legacy IDs but offers a principal and distinct pinned chat hosts only', () => {
  const tasks = { daily_operator: task('chat-a', 'gpu'), code: task('chat-a', 'gpu'),
    utility: task('chat-b', 'cpu-a'), ops: task('chat-b', 'cpu-b'),
    embeddings: task('org/bge-m3:test', 'gpu'), stale: task('old-chat', 'old', { pinAligned: false }) };
  const rows = modelCatalog({ generatedAt: '2026-01-01T00:00:00Z', tasks });
  assert.deepEqual(rows.filter(row => row.agentx.selectable).map(row => row.id),
    ['agentx-primary', 'agentx-host/cpu-a', 'agentx-host/cpu-b']);
  for (const id of ['chat-a', 'chat-b', 'org/bge-m3:test', 'old-chat']) {
    assert.equal(rows.find(row => row.id === id).agentx.selectable, false);
  }
  const principal = rows.find(row => row.id === 'agentx-primary').agentx;
  assert.equal(principal.resolved_model, 'chat-a');
  assert.deepEqual(principal.host, { key: 'gpu', name: 'GPU' });
  assert.equal(principal.context_window, 32768);
  assert.equal(principal.capabilities.tools, null);
});

test('topology principal wins; unavailable, conflicting and embedding targets cannot be selected', () => {
  const state = { tasks: { daily_operator: task('old', 'legacy'),
    first: task('chat-a', 'mixed'), second: task('chat-b', 'mixed'),
    embeddings: task('org/bge-m3:test', 'embed') }, principalTopology: task('pooled', 'pool') };
  assert.equal(resolveGatewayTarget(state, 'agentx-primary').model, 'pooled');
  for (const id of ['agentx-host/mixed', 'agentx-host/embed', 'agentx-host/unknown']) {
    assert.throws(() => resolveGatewayTarget(state, id), { code: 'HOST_MODEL_UNAVAILABLE' });
  }
  state.principalTopology.pinAligned = false;
  assert.equal(modelCatalog(state).find(row => row.id === 'agentx-primary').agentx.selectable, false);
  assert.throws(() => resolveGatewayTarget(state, 'agentx-primary'), { code: 'PRINCIPAL_MODEL_UNAVAILABLE' });
});

test('host choices disappear when pin context is absent and expose qualified capabilities without guessing', () => {
  const state = { tasks: { utility: task('chat-a', 'cpu', { contextSize: null }) } };
  assert.equal(modelCatalog(state).some(row => row.id.startsWith('agentx-host/')), false);
  state.tasks.utility.contextSize = 8192;
  state.tasks.utility.inferenceContract = { capabilities: { tools: { supported: false }, thinking: { supported: true } } };
  const row = modelCatalog(state).find(row => row.id === 'agentx-host/cpu');
  assert.deepEqual(row.agentx.capabilities, { tools: false, reasoning: true });
  assert.equal(resolveGatewayTarget(state, row.id).numCtx, 8192);
});
