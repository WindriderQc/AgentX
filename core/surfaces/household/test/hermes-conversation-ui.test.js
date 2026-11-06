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

test('Hermes diagnostics keep the same drawing and mark the unused review path in place', () => {
  const { create, stageState } = require('../public/workflow-panel');
  const prior = global.document;
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll() { return []; }
  }
  global.document = { createElement: () => new Element() };
  try {
    const host = new Element(), panel = create({ host });
    const flatten = node => [node, ...node.children.flatMap(flatten)];
    const keyOf = node => node.dataset.key || node.attributes['data-key'];
    const keys = () => flatten(host).map(keyOf).filter(Boolean).sort();
    panel.begin('session-hermes', 'turn-hermes', 'voice');
    const before = keys();
    panel.timings('turn-hermes', { sttDone: 125, firstAudio: 800, playbackOutcome: 'completed' });
    panel.stream('turn-hermes', { type: 'done', data: { routing: { backend: 'hermes' }, model: { model: 'actual-sol' } } });
    assert.deepEqual(keys(), before, 'learning the engine at the end of the turn changes no part of the drawing');
    const nodes = flatten(host), text = nodes.map(node => node.textContent).join(' ');
    const find = key => nodes.find(node => keyOf(node) === key);
    assert.match(text, /Hermes · actual-sol/);
    for (const key of ['meter:stt', 'meter:guardian', 'meter:review', 'meter:tts', 'stage:review', 'stage:agents', 'graph:review', 'graph:agents']) assert.ok(find(key), key);
    assert.equal(find('graph:review').attributes['data-tone'], 'unused');
    assert.equal(find('graph:agents').attributes['data-tone'], 'unused');
    assert.equal(find('route:background').attributes['data-unused'], 'true');
    assert.match(flatten(find('meter:review')).map(node => node.textContent).join(' '), /Not used/);
    assert.equal(find('graph:tools').attributes['data-skipped'], 'true', 'the train passed Tools without a tool receipt');
    const row = panel.model.snapshot().turns[0];
    assert.deepEqual(stageState('guardian', row), ['Done', 'Hermes · actual-sol']);
    assert.equal(stageState('stt', row)[0], 'Done');
    assert.equal(stageState('tts', row)[0], 'Done');
    assert.equal(stageState('review', row)[0], 'Not used');
  } finally { global.document = prior; }
});
