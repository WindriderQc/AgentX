'use strict';

// Context follows what the lane holds and what the Profiler verified (#360).
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareOpenClawConfig, laneFromTask } = require('../runtime-config');

const API = 'http://core:3180/api/openclaw-ollama';
function expected(contextWindow) {
  return { providerId: 'ollama', provider: { apiBase: API,
    models: [{ id: 'agentx-primary', contextWindow, params: { num_ctx: contextWindow } }] } };
}
function installed(entries) {
  const providers = {};
  for (const [id, contextWindow] of Object.entries(entries)) {
    providers[id] = { baseUrl: API, models: [{ id: 'agentx-primary',
      ...(contextWindow === null ? {} : { contextWindow, params: { num_ctx: contextWindow } }) }] };
  }
  return { models: { providers } };
}

test('a narrower OpenClaw context is safe in every mode and is reported, not drift', () => {
  const result = compareOpenClawConfig(installed({ ollama: 112640, 'agentx-conversation': 112640 }), expected(196608));
  assert.equal(result.drift.length, 0);
  assert.equal(result.narrower.length, 4);
  assert.deepEqual(result.narrower[0], { path: 'models.providers.ollama.models[agentx-primary].contextWindow',
    actual: 112640, available: 196608 });
});

test('a wider OpenClaw context is drift, in every Core-routed provider', () => {
  const result = compareOpenClawConfig(installed({ ollama: 112640, 'agentx-voice': 196608 }), expected(112640));
  assert.equal(result.status, 'drift');
  assert.deepEqual(result.drift.map((row) => row.path).sort(), [
    'models.providers.agentx-voice.models[agentx-primary].contextWindow',
    'models.providers.agentx-voice.models[agentx-primary].params.num_ctx'
  ]);
});

test('a missing OpenClaw context is drift: OpenClaw would use its own default', () => {
  const result = compareOpenClawConfig(installed({ ollama: null }), expected(112640));
  assert.equal(result.status, 'drift');
  assert.equal(result.drift.length, 2);
});

test('the export never advertises more than the pin or the verified context', () => {
  const lane = (contextSize, validated, pinAligned = false) => laneFromTask('daily', 'daily_operator', { tasks: {
    daily_operator: { model: 'm', hostUrl: 'http://h:11434', contextSize, pinAligned,
      inferenceContract: { contextBudget: { validatedWindowTokens: validated } } } } });
  assert.equal(lane(196608, 262144).contextSize, 196608);
  assert.equal(lane(196608, 262144, true).contextSize, 196608);
  const above = lane(131072, 112640);
  assert.equal(above.contextSize, 112640);
  assert.equal(above.contextSource, 'profiler_verified');
  assert.match(above.warnings.join(' '), /exceeds the verified context/);
  assert.equal(lane(null, 98304).contextSize, 98304);
});
