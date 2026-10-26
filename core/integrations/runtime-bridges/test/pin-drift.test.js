'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPinDrift, createPinDriftWatch, intervalMs, projectOpenClawConfig, readInstalledOpenClawConfig } = require('../pin-drift');
const { buildRuntimeConfigExport, compareOpenClawConfig } = require('../runtime-config');

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

function splitServices() {
  const principalTopology = { ...task('daily_operator', 'lane-pin'),
    hostKey: 'lane-a', hostUrl: 'http://model-host.test:11437',
    hostPreference: { pinnedModels: [{ ...PIN, model: 'lane-pin' }] } };
  const tasks = { daily_operator: principalTopology,
    code_generation: task('code_generation', 'model-a'), master_brain: task('master_brain', 'model-a') };
  return { routing: { getEffectiveSnapshot: async () => ({ tasks, principalTopology }) } };
}

test('switching the principal alias does not require unused specialist catalog suggestions', async () => {
  process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL = 'http://core.test/api/openclaw-ollama';
  const result = await checkPinDrift({ runtimeServices: splitServices(), readConfig: async () => installed() });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.openclaw.drift, []);
});

for (const reference of ['default', 'string-default', 'primary', 'string-primary', 'fallback', 'inherited-fallback']) {
  test(`a missing specialist catalog entry remains drift when used by an installed ${reference}`, async () => {
    const config = installed();
    const ref = 'ollama/model-a';
    if (reference === 'default') config.agents.defaults.model.primary = ref;
    if (reference === 'string-default') config.agents.defaults.model = ref;
    if (reference === 'primary') config.agents.list[0].model.primary = ref;
    if (reference === 'string-primary') config.agents.list[0].model = ref;
    if (reference === 'fallback') config.agents.list[0].model.fallbacks = [ref];
    if (reference === 'inherited-fallback') config.agents.defaults.model.fallbacks = [ref];
    const result = await checkPinDrift({ runtimeServices: splitServices(), readConfig: async () => config });
    assert.equal(result.status, 'drift');
    assert.ok(result.openclaw.drift.some(row => row.path.endsWith('models[model-a]')));
  });
}

test('an installed unused specialist entry is still checked against its pin context', async () => {
  const config = installed();
  config.models.providers.ollama.models.push({ id: 'model-a', contextWindow: 65536, params: { num_ctx: 65536 } });
  const result = await checkPinDrift({ runtimeServices: splitServices(), readConfig: async () => config });
  assert.equal(result.status, 'drift');
  assert.equal(result.openclaw.drift.filter(row => row.path.includes('models[model-a]')).length, 2);
});

test('a guarded dispatcher still requires its specialist entry, including namespaced model ids', async () => {
  const exported = await buildRuntimeConfigExport(splitServices());
  const specialist = exported.openclaw.provider.models.find(row => row.id === 'model-a');
  specialist.id = 'owner/model-a';
  exported.openclaw.agentModelPolicy.guardedExecution = { agents: { worker: {
    targets: [{ model: 'ollama/owner/model-a', path: 'executionProfiles.worker.model' }]
  } } };
  const result = compareOpenClawConfig(installed(), exported.openclaw);
  assert.equal(result.status, 'drift');
  assert.ok(result.drift.some(row => row.path.endsWith('models[owner/model-a]')));
});

test('references in an additional Core provider and entries-format agents still require the specialist', async () => {
  const config = installed();
  config.models.providers['agentx-conversation'] = { baseUrl: 'http://core.test/api/openclaw-ollama', models: [] };
  config.agents.entries = { specialist: { model: 'agentx-conversation/model-a' } };
  const result = await checkPinDrift({ runtimeServices: splitServices(), readConfig: async () => config });
  assert.equal(result.status, 'drift');
  assert.ok(result.openclaw.drift.some(row => row.path.endsWith('models[model-a]')));
});

test('the principal alias remains required when only an unused specialist is installed', async () => {
  const result = await checkPinDrift({ runtimeServices: splitServices(), readConfig: async () => installed('model-a') });
  assert.equal(result.status, 'drift');
  assert.ok(result.openclaw.drift.some(row => row.path.endsWith('models[agentx-primary]')));
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
