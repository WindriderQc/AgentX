'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPinDrift, createPinDriftWatch, intervalMs, projectOpenClawConfig, readInstalledOpenClawConfig } = require('../pin-drift');

const PIN = { model: 'model-a', contextSize: 32768, keepAlive: -1 };
function services(tasks) {
  const snapshot = { generatedAt: '2026-10-16T00:00:00.000Z', catalog: [], tasks };
  return { routing: { getEffectiveSnapshot: async () => snapshot } };
}
function task(taskType, model, pinAligned = true) {
  return { taskType, model, configuredModel: model, hostKey: 'primary', hostUrl: 'http://model-host.test:11434',
    contextSize: pinAligned ? 32768 : null, pinAligned, hostPreference: { pinnedModels: [PIN] } };
}
const aligned = () => services({ daily_operator: task('daily_operator', 'model-a'),
  code_generation: task('code_generation', 'model-a'), master_brain: task('master_brain', 'model-a') });
const installed = (id = 'agentx-primary') => ({
  models: { providers: { ollama: { baseUrl: 'http://core.test/api/openclaw-ollama', models: [{ id, contextWindow: 32768, params: { num_ctx: 32768 } }] } } },
  agents: { defaults: { model: { primary: `ollama/${id}`, fallbacks: [] } }, list: [{ id: 'main', model: { primary: `ollama/${id}` } }] }
});

test('aligned routes, export and installed alias config report no drift', async () => {
  process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL = 'http://core.test/api/openclaw-ollama';
  const result = await checkPinDrift({ runtimeServices: aligned(), readConfig: async () => installed() });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.unpinnedRoutes, []);
  assert.equal(result.openclaw.status, 'ok');
});

test('a route naming an unpinned model and a physical OpenClaw id are drift', async () => {
  process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL = 'http://core.test/api/openclaw-ollama';
  const runtimeServices = services({ daily_operator: task('daily_operator', 'model-a'),
    nestor_answer_light: task('nestor_answer_light', 'model-old', false) });
  const result = await checkPinDrift({ runtimeServices, readConfig: async () => installed('model-a') });
  assert.equal(result.status, 'drift');
  assert.deepEqual(result.unpinnedRoutes.map(route => route.taskType), ['nestor_answer_light']);
  assert.ok(result.openclaw.drift.some(row => row.path.includes('agentx-primary')));
});

test('an unreadable installed config is reported, not hidden', async () => {
  const result = await checkPinDrift({ runtimeServices: aligned(), readConfig: async () => { throw new Error('ssh refused'); } });
  assert.equal(result.status, 'partial');
  assert.match(result.openclaw.reason, /ssh refused/);
});

test('the projection keeps endpoints, model ids and agent references, never credentials', async () => {
  const raw = { models: { providers: { ollama: { baseUrl: 'http://core', apiKey: 'secret-key', models: [{ id: 'agentx-primary', contextWindow: 1, params: { num_ctx: 1, temperature: 0 } }] } } },
    agents: { entries: { main: { model: { primary: 'ollama/agentx-primary' }, tools: { exec: {} } } } }, gateway: { auth: { token: 'secret-token' } } };
  const projected = projectOpenClawConfig(raw);
  assert.doesNotMatch(JSON.stringify(projected), /secret/);
  assert.deepEqual(projected.models.providers.ollama.models[0], { id: 'agentx-primary', contextWindow: 1, params: { num_ctx: 1 } });
  assert.deepEqual(projected.agents.list, [{ id: 'main', model: { primary: 'ollama/agentx-primary', fallbacks: undefined } }]);
  const local = await readInstalledOpenClawConfig({ OPENCLAW_HOME: '/data/openclaw' }, { readFile: async () => JSON.stringify(raw) });
  assert.deepEqual(local, projected);
  assert.equal(await readInstalledOpenClawConfig({}), null);
});

test('the watch alerts on drift and the interval is bounded', async () => {
  const events = [];
  const watch = createPinDriftWatch({ alertService: { evaluateEvent: async event => events.push(event) },
    check: async () => ({ status: 'drift', unpinnedRoutes: [{ taskType: 'x', model: 'm', hostKey: 'primary' }], unpinnedExportLanes: [], openclaw: { drift: [] } }) });
  await watch.run();
  assert.equal(events[0].metric, 'pin_drift');
  assert.match(events[0].additionalData.summary, /route x names m on primary/);
  assert.equal(watch.last().status, 'drift');
  assert.equal(intervalMs({}), 15 * 60 * 1000);
  assert.equal(intervalMs({ PIN_DRIFT_CHECK_MS: '0' }), 0);
  assert.equal(intervalMs({ PIN_DRIFT_CHECK_MS: '1000' }), 60 * 1000);
});
