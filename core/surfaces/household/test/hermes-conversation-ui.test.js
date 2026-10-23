'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createModel } = require('../public/workflow-panel');
const page = fs.readFileSync(path.join(__dirname, '../public/conversation-page.js'), 'utf8');
function engines() {
  const context = { window: {} };
  vm.runInNewContext(page, context);
  return context.window.ConversationEngines;
}

test('a configured personal Hermes engine respects saved choice and safely handles stale preferences', () => {
  const policy = engines(), runtime = { defaultBackend: 'hermes', hermesConfigured: true };
  assert.equal(policy.choose(runtime, false), 'hermes');
  assert.equal(policy.choose(runtime, false, 'agentx'), 'agentx');
  assert.equal(policy.choose(runtime, false, 'openclaw'), 'openclaw');
  assert.equal(policy.choose(runtime, false, 'removed-engine'), 'hermes');
  assert.equal(policy.choose({ ...runtime, hermesConfigured: false }, false, 'hermes'), 'openclaw');
  assert.equal(policy.choose({ ...runtime, hermesConfigured: false, openclawConfigured: false }, false, 'hermes'), 'agentx');
});

test('family never offers or selects Hermes, including a shared personal default or saved selection', () => {
  const policy = engines(), runtime = { defaultBackend: 'hermes', hermesConfigured: true };
  assert.equal(policy.available(runtime, true).includes('hermes'), false);
  assert.equal(policy.choose(runtime, true, 'hermes'), 'openclaw');
  assert.equal(policy.choose({ ...runtime, openclawConfigured: false }, true, 'hermes'), 'agentx');
  assert.equal(policy.available({ hermesConfigured: 'true' }, false).includes('hermes'), false);
});

test('the rendered engine picker omits Hermes for family and unconfigured instances', async () => {
  for (const family of [false, true]) for (const configured of [false, true]) {
    const app = { innerHTML: '' }, stop = new Error('markup rendered');
    const context = { window: { ConversationComposer: { mount() { throw stop; } } },
      PersonaPresentation: {}, document: { getElementById() {} } };
    vm.runInNewContext(page, context);
    await assert.rejects(context.window.mountConversation({ app, esc: String, autoStart: false,
      space: family ? 'family' : 'personal', api: async () => ({ personas: [{ id: 'nestor', name: 'Nestor' }],
        runtime: { hermesConfigured: configured }, agents: [] }) }), error => error === stop);
    assert.equal(app.innerHTML.includes('<option value="hermes">Hermes</option>'), configured && !family);
    assert.ok(app.innerHTML.includes('id="conversationPresence"'), 'the existing reactive avatar stays mounted');
    assert.ok(app.innerHTML.includes('id="conversationWorkshop"'), 'the existing voice workshop stays mounted');
  }
});

test('actual result attribution uses the returned engine and model, including a local fallback', () => {
  const policy = engines();
  assert.equal(policy.observed({ routing: { backend: 'hermes' }, model: { model: 'synthetic-cloud' } }), 'Hermes · synthetic-cloud');
  assert.equal(policy.observed({ routing: { backend: 'agentx', fallbackUsed: true }, model: { model: 'synthetic-local' } }), 'AgentX / Ollama · synthetic-local');
  assert.equal(policy.observed({ routingSource: 'hermes/nestor', model: 'synthetic-history' }), 'Hermes · synthetic-history');
  assert.equal(policy.observed({}), '', 'selection alone is not evidence of execution');
});

test('workflow retains observed execution from the stream and from canonical history', () => {
  const model = createModel(); model.begin('session-a', 'turn-a', 'voice');
  assert.equal(model.snapshot().turns[0].execution, undefined);
  model.stream('turn-a', { type: 'done', data: { routing: { backend: 'hermes' }, model: { model: 'actual-cloud' } } });
  assert.deepEqual(model.snapshot().turns[0].execution, { backend: 'hermes', model: 'actual-cloud' });
  model.restore('session-b', [{ clientTurnId: 'turn-b', replyText: 'Saved answer', routingSource: 'hermes/nestor', model: 'saved-cloud' }]);
  assert.deepEqual(model.snapshot().turns[0].execution, { backend: 'hermes', model: 'saved-cloud' });
  model.restore('session-c', [{ clientTurnId: 'turn-c', replyText: 'Legacy answer' }]);
  assert.equal(model.snapshot().turns[0].execution, undefined, 'legacy history does not invent a model');
});
